use crate::{Result, platform::protect};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::path::Path;
use zeroize::Zeroizing;

pub struct Vault {
    connection: Connection,
}

impl Vault {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(|_| "vault_open_failed")?;
        connection.execute_batch("PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS credentials (account TEXT PRIMARY KEY, revision INTEGER NOT NULL, blob BLOB);").map_err(|_| "vault_schema_failed")?;
        Ok(Self { connection })
    }

    fn entropy(account: &str) -> Vec<u8> {
        format!("LingoSofa/credentials/v1/{account}").into_bytes()
    }

    /// Public account identifiers only; credential bytes never leave the vault.
    pub fn accounts(&self) -> Result<Vec<String>> {
        let mut statement = self
            .connection
            .prepare("SELECT account FROM credentials WHERE blob IS NOT NULL ORDER BY account")
            .map_err(|_| "vault_read_failed")?;
        statement
            .query_map([], |row| row.get(0))
            .map_err(|_| "vault_read_failed")?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| "vault_read_failed")
    }

    pub fn read(&self, account: &str) -> Result<Value> {
        let row: Option<(u64, Option<Vec<u8>>)> = self
            .connection
            .query_row(
                "SELECT revision, blob FROM credentials WHERE account=?1",
                [account],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| "vault_read_failed")?;
        let (revision, blob) = row.unwrap_or((0, None));
        let credential: Value = match blob {
            Some(blob) => serde_json::from_slice(&protect(&blob, &Self::entropy(account), true)?)
                .map_err(|_| "vault_corrupt")?,
            None => Value::Null,
        };
        Ok(json!({"revision": revision, "credential": credential}))
    }

    pub fn commit(&mut self, account: &str, expected: u64, credential: &Value) -> Result<Value> {
        if account.is_empty()
            || account.len() > 64
            || !account
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("account_not_allowed");
        }
        if !credential.is_null() {
            let nonempty = |field: &str| {
                credential[field]
                    .as_str()
                    .is_some_and(|value| !value.is_empty() && value.len() <= 8192)
            };
            let valid = if credential["type"] == "api_key" {
                credential["type"] == "api_key" && nonempty("key")
            } else {
                credential["type"] == "oauth"
                    && nonempty("access")
                    && credential["refresh"]
                        .as_str()
                        .is_some_and(|value| value.len() <= 8192)
                    && credential["expires"]
                        .as_u64()
                        .is_some_and(|expires| expires <= 9_007_199_254_740_991)
            };
            if !valid {
                return Err("credential_invalid");
            }
        }
        let blob = if credential.is_null() {
            None
        } else {
            let bytes =
                Zeroizing::new(serde_json::to_vec(credential).map_err(|_| "credential_invalid")?);
            if bytes.len() > 32 * 1024 {
                return Err("credential_too_large");
            }
            Some(protect(&bytes, &Self::entropy(account), false)?.to_vec())
        };
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "vault_transaction_failed")?;
        let revision: u64 = transaction
            .query_row(
                "SELECT revision FROM credentials WHERE account=?1",
                [account],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "vault_read_failed")?
            .unwrap_or(0);
        if revision != expected {
            return Err("credential_conflict");
        }
        let next = revision.checked_add(1).ok_or("revision_overflow")?;
        transaction.execute("INSERT INTO credentials(account, revision, blob) VALUES (?1,?2,?3) ON CONFLICT(account) DO UPDATE SET revision=excluded.revision, blob=excluded.blob", params![account, next, blob]).map_err(|_| "vault_write_failed")?;
        transaction.commit().map_err(|_| "vault_commit_failed")?;
        Ok(json!({"revision": next}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_protection_roundtrip_tamper_and_account_binding() {
        let plaintext = "W0-密钥-secret".as_bytes();
        let protected = protect(plaintext, b"account-a", false).unwrap();
        assert_ne!(protected.as_slice(), plaintext);
        assert_eq!(
            protect(&protected, b"account-a", true).unwrap().as_slice(),
            plaintext
        );
        assert!(protect(&protected, b"account-b", true).is_err());
        let mut corrupted = protected.to_vec();
        let last = corrupted.len() - 1;
        corrupted[last] ^= 1;
        assert!(protect(&corrupted, b"account-a", true).is_err());
    }

    #[test]
    fn durable_cas_delete_failure_and_no_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.sqlite");
        let secret = "W0-persisted-secret-12345";
        let credential = json!({"type":"api_key", "key":secret});
        let mut vault = Vault::open(&path).unwrap();
        vault.commit("deepseek", 0, &credential).unwrap();
        assert!(
            vault
                .commit("deepseek", 0, &json!({"key":"stale"}))
                .is_err()
        );
        vault.connection.execute_batch("CREATE TRIGGER fail_update BEFORE UPDATE ON credentials BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
        assert!(vault.commit("deepseek", 1, &Value::Null).is_err());
        vault
            .connection
            .execute_batch("DROP TRIGGER fail_update")
            .unwrap();
        drop(vault);
        let mut vault = Vault::open(&path).unwrap();
        assert_eq!(vault.read("deepseek").unwrap()["credential"], credential);
        assert!(
            !std::fs::read(&path)
                .unwrap()
                .windows(secret.len())
                .any(|bytes| bytes == secret.as_bytes())
        );
        vault.commit("deepseek", 1, &Value::Null).unwrap();
        assert_eq!(vault.read("deepseek").unwrap()["revision"], 2);
        assert!(vault.commit("deepseek", 1, &credential).is_err());
        assert!(vault.read("deepseek").unwrap()["credential"].is_null());
    }

    #[test]
    fn non_refreshable_sdk_grants_keep_their_empty_refresh_token() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::open(&dir.path().join("vault.sqlite")).unwrap();
        let credential = json!({"type":"oauth","access":"synthetic-static-access","refresh":"","expires":9_007_199_254_740_991_u64});
        vault.commit("subscription", 0, &credential).unwrap();
        assert_eq!(
            vault.read("subscription").unwrap()["credential"],
            credential
        );
        assert!(
            vault
                .commit(
                    "subscription",
                    1,
                    &json!({"type":"oauth","access":"synthetic-static-access","expires":1})
                )
                .is_err()
        );
    }

    #[test]
    fn actual_sqlite_write_failure_rolls_back_and_invalid_credentials_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::open(&dir.path().join("vault.sqlite")).unwrap();
        let credential = json!({"type":"api_key","key":"W0-original-key"});
        vault.commit("deepseek", 0, &credential).unwrap();
        vault.connection.execute_batch("CREATE TRIGGER fail_update BEFORE UPDATE ON credentials BEGIN SELECT RAISE(ABORT,'W0 injected failure'); END;").unwrap();
        assert_eq!(
            vault.commit(
                "deepseek",
                1,
                &json!({"type":"api_key","key":"W0-replacement-key"})
            ),
            Err("vault_write_failed")
        );
        assert_eq!(
            vault.read("deepseek").unwrap(),
            json!({"revision":1,"credential":credential})
        );
        assert_eq!(
            vault.commit("test-oauth", 0, &json!({"type":"oauth","key":"invalid"})),
            Err("credential_invalid")
        );
        assert_eq!(
            vault.commit(
                "deepseek",
                1,
                &json!({"type":"api_key", "key":"W0", "extra":"x".repeat(32768)})
            ),
            Err("credential_too_large")
        );
    }
}
