use lingo_sofa_omp_client::{
    Result,
    client::{Config, Host},
    vault::Vault,
};
use serde_json::{Value, json};
use std::{io::Read, path::PathBuf};
use zeroize::Zeroizing;

fn require(condition: bool, code: &'static str) -> Result<()> {
    if condition { Ok(()) } else { Err(code) }
}

fn run() -> Result<Value> {
    let mut key = Zeroizing::new(Vec::new());
    std::io::stdin()
        .take(8193)
        .read_to_end(&mut key)
        .map_err(|_| "key_input_failed")?;
    require(!key.is_empty() && key.len() <= 8192, "key_input_invalid")?;
    let key_text = std::str::from_utf8(&key).map_err(|_| "key_input_invalid")?;
    let directory = tempfile::tempdir().map_err(|_| "temp_directory_failed")?;
    let vault_path = directory.path().join("vault.sqlite");
    {
        let mut vault = Vault::open(&vault_path)?;
        vault.commit("deepseek", 0, &json!({"type":"api_key","key":key_text}))?;
    }
    let bytes = std::fs::read(&vault_path).map_err(|_| "vault_file_read_failed")?;
    require(
        !bytes
            .windows(key.len())
            .any(|slice| slice == key.as_slice()),
        "plaintext_key_on_disk",
    )?;
    drop(key);
    let config = Config {
        program: PathBuf::from(
            std::env::var("W0_WORKER_PROGRAM").map_err(|_| "worker_path_missing")?,
        ),
        args: serde_json::from_str(
            &std::env::var("W0_WORKER_ARGS").map_err(|_| "worker_args_missing")?,
        )
        .map_err(|_| "worker_args_invalid")?,
        directory: directory.path().to_path_buf(),
        accounts: vec!["deepseek".into(), "test-oauth".into()],
    };
    let mut host = Host::new(config, Vault::open(&vault_path)?)?;
    let model = host.request("model.verify", json!({}))?;
    require(
        model["id"] == "deepseek-flash" && model["name"] == "DeepSeek-V4.1-Flash",
        "wrong_model",
    )?;
    require(
        model["credentialSource"] == "rust-vault",
        "wrong_credential_source",
    )?;
    require(
        host.request("stats", json!({}))?["credentialEnvironmentPresent"] == false,
        "credential_in_worker_environment",
    )?;
    let validation = if std::env::args().any(|arg| arg == "--dual") {
        lingo_sofa_runtime_tests::validation::saturated_model_path(
            &mut host,
            lingo_sofa_runtime_tests::validation::Workload::Desktop,
        )
    } else {
        lingo_sofa_runtime_tests::validation::queued_model_path(
            &mut host,
            lingo_sofa_runtime_tests::validation::Workload::Desktop,
        )
    };
    let mut report = match validation {
        Ok(report) => report,
        Err(code) => {
            host.stop();
            json!({"passed":false,"code":code,"peakActiveCalls":host.peak_active_calls(),"calls":host.usage.records(),"checks":{},"pricingKnown":false,"cancelledCallBillingKnown":false})
        }
    };
    let expected = host.usage.records();
    drop(host);
    let ledger =
        lingo_sofa_omp_client::usage::UsageLedger::open(&directory.path().join("usage.sqlite"))?;
    require(
        ledger.records() == expected && ledger.active() == 0,
        "durable_usage_mismatch",
    )?;
    report["model"] = model;
    report["checks"]["credentialPersistedAndReopened"] = json!(true);
    report["checks"]["credentialSourceIsHostVault"] = json!(true);
    report["checks"]["noPlaintextKeyOnDisk"] = json!(true);
    report["checks"]["keyNotInWorkerEnvironment"] = json!(true);
    report["checks"]["usageLedgerReopened"] = json!(true);
    Ok(report)
}

fn main() {
    match run() {
        Ok(report) => {
            println!("{report}");
            if report["passed"] != true {
                std::process::exit(1);
            }
        }
        Err(code) => {
            println!("{}", json!({"passed":false,"code":code}));
            std::process::exit(1);
        }
    }
}
