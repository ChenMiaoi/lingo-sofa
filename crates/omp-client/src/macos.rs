use crate::Result;
use ring::{
    aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use security_framework::os::macos::keychain::SecKeychain;
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    process::{Child, Command, Stdio},
    sync::OnceLock,
};
use zeroize::Zeroizing;

fn cached_key<F>(
    cache: &OnceLock<Result<Zeroizing<Vec<u8>>>>,
    load: F,
) -> Result<&Zeroizing<Vec<u8>>>
where
    F: FnOnce() -> Result<Zeroizing<Vec<u8>>>,
{
    match cache.get_or_init(load) {
        Ok(key) => Ok(key),
        Err(error) => Err(*error),
    }
}
fn master_key() -> Result<&'static Zeroizing<Vec<u8>>> {
    // A denial is also remembered: background operations must not repeatedly
    // present authentication dialogs. Restarting the app permits a fresh attempt.
    static KEY: OnceLock<Result<Zeroizing<Vec<u8>>>> = OnceLock::new();
    cached_key(&KEY, load_master_key)
}
fn load_master_key() -> Result<Zeroizing<Vec<u8>>> {
    // Serialize first-use creation across desktop and test processes. Never
    // replace a key when Keychain is locked or access was denied.
    #[cfg(feature = "test-keychain")]
    let test_keychain =
        std::env::var_os("LINGOSOFA_TEST_KEYCHAIN").ok_or("test_keychain_missing")?;
    #[cfg(feature = "test-keychain")]
    let keychain = SecKeychain::open(&test_keychain).map_err(|_| "keychain_open_failed")?;
    #[cfg(not(feature = "test-keychain"))]
    let keychain = SecKeychain::default().map_err(|_| "keychain_open_failed")?;
    let home = std::env::var_os("HOME").ok_or("keychain_home_missing")?;
    #[cfg(not(feature = "test-keychain"))]
    let directory = std::path::PathBuf::from(home).join("Library/Application Support/LingoSofa");
    #[cfg(feature = "test-keychain")]
    let directory = {
        let _ = home;
        std::path::PathBuf::from(test_keychain)
            .parent()
            .ok_or("test_keychain_missing")?
            .to_path_buf()
    };
    std::fs::create_dir_all(&directory).map_err(|_| "keychain_lock_failed")?;
    let lock: File = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(directory.join("keychain-init.lock"))
        .map_err(|_| "keychain_lock_failed")?;
    lock.lock().map_err(|_| "keychain_lock_failed")?;
    let service = "com.lingosofa.desktop.credentials";
    let account = "vault-key-v1";
    let key = match keychain.find_generic_password(service, account) {
        Ok((key, _)) => Zeroizing::new(key.to_vec()),
        Err(error) if error.code() == -25300 => {
            let mut key = Zeroizing::new(vec![0; 32]);
            SystemRandom::new()
                .fill(&mut key)
                .map_err(|_| "credential_random_failed")?;
            keychain
                .set_generic_password(service, account, &key)
                .map_err(|_| "keychain_write_failed")?;
            key
        }
        Err(_) => return Err("keychain_read_failed"),
    };
    if key.len() != 32 {
        return Err("keychain_key_invalid");
    }
    Ok(key)
}

pub fn protect(bytes: &[u8], entropy: &[u8], decrypt: bool) -> Result<Zeroizing<Vec<u8>>> {
    if bytes.len() > 64 * 1024 || entropy.len() > 1024 {
        return Err("credential_too_large");
    }
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, master_key()?).map_err(|_| "keychain_key_invalid")?,
    );
    if decrypt {
        let (nonce, ciphertext) = bytes
            .split_at_checked(12)
            .ok_or("credential_decrypt_failed")?;
        let nonce =
            Nonce::try_assume_unique_for_key(nonce).map_err(|_| "credential_decrypt_failed")?;
        let mut output = Zeroizing::new(ciphertext.to_vec());
        let length = key
            .open_in_place(nonce, Aad::from(entropy), &mut output)
            .map_err(|_| "credential_decrypt_failed")?
            .len();
        output.truncate(length);
        Ok(output)
    } else {
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "credential_random_failed")?;
        let mut ciphertext = Zeroizing::new(bytes.to_vec());
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(entropy),
            &mut *ciphertext,
        )
        .map_err(|_| "credential_encrypt_failed")?;
        let mut output = Zeroizing::new(nonce.to_vec());
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }
}

pub struct Job(Child);
impl Job {
    pub fn attach(child: &Child) -> Result<Self> {
        // The worker must be spawned in its own process group. The guardian
        // owns no copy of the host's pipe writer: EOF also follows SIGKILL or
        // a host crash, so descendants cannot outlive their Rust host.
        let guardian = Command::new("/bin/sh")
            .args([
                "-c",
                "cat >/dev/null; /bin/kill -KILL -- -\"$1\"",
                "lingo-sofa-guardian",
                &child.id().to_string(),
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "job_attach_failed")?;
        Ok(Self(guardian))
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        drop(self.0.stdin.take());
        let _ = self.0.wait();
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[test]
    fn denied_keychain_access_does_not_prompt_again_until_a_new_process_cache() {
        let cache = OnceLock::new();
        let attempts = AtomicUsize::new(0);
        for _ in 0..3 {
            assert_eq!(
                cached_key(&cache, || {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Err("keychain_read_failed")
                })
                .unwrap_err(),
                "keychain_read_failed"
            );
        }
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        let next_launch = OnceLock::new();
        assert!(cached_key(&next_launch, || Ok(Zeroizing::new(vec![7; 32]))).is_ok());
    }
    #[test]
    fn concurrent_first_use_reads_the_keychain_once() {
        let cache = OnceLock::new();
        let attempts = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    assert_eq!(
                        cached_key(&cache, || {
                            attempts.fetch_add(1, Ordering::SeqCst);
                            Ok(Zeroizing::new(vec![7; 32]))
                        })
                        .unwrap()
                        .len(),
                        32
                    );
                });
            }
        });
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }
}
