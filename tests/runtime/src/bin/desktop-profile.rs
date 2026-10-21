//! Prepare an isolated desktop acceptance profile; credentials arrive only on stdin.
use lingo_sofa_omp_client::vault::Vault;
use std::{io::Read, path::PathBuf};
use zeroize::Zeroizing;

fn main() -> Result<(), &'static str> {
    let root = std::fs::canonicalize(".cache").map_err(|_| "cache_missing")?;
    let directory = PathBuf::from(std::env::args().nth(1).ok_or("profile_required")?);
    // The launcher creates the directory first; never create an unchecked path.
    let directory = std::fs::canonicalize(directory).map_err(|_| "profile_invalid")?;
    if !directory.starts_with(root) {
        return Err("acceptance_profile_must_be_inside_cache");
    }
    let mut key = Zeroizing::new(String::new());
    std::io::stdin()
        .take(8193)
        .read_to_string(&mut key)
        .map_err(|_| "stdin_failed")?;
    if key.trim().is_empty() || key.len() > 8192 {
        return Err("invalid_key");
    }
    let mut vault = Vault::open(&directory.join("credentials.sqlite"))?;
    vault.commit(
        "deepseek",
        0,
        &serde_json::json!({"type":"api_key","key":key.as_str()}),
    )?;
    println!("Isolated DPAPI profile initialized");
    Ok(())
}
