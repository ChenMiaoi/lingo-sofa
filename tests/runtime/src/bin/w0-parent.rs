// W0 crash fixture: the integration test terminates this host externally.
use lingo_sofa_omp_client::{
    client::{Config, Host},
    vault::Vault,
};
use serde_json::json;
use std::{io::Write, path::PathBuf};

fn main() {
    let directory = PathBuf::from(std::env::args().nth(1).expect("fixture directory"));
    let mode = std::env::args().nth(2).unwrap_or_default();
    let model_fixture = matches!(mode.as_str(), "pending" | "completed");
    let mut args: Vec<String> = serde_json::from_str(
        &std::env::var(if model_fixture {
            "W0_WORKER_ARGS"
        } else {
            "W0_FAULT_ARGS"
        })
        .unwrap(),
    )
    .unwrap();
    if !model_fixture {
        args.push("descendant".into());
    }
    let mut host = Host::new(
        Config {
            program: PathBuf::from(
                std::env::var(if model_fixture {
                    "W0_WORKER_PROGRAM"
                } else {
                    "W0_FAULT_PROGRAM"
                })
                .unwrap(),
            ),
            args,
            directory: directory.clone(),
            accounts: vec!["deepseek".into(), "test-oauth".into()],
        },
        Vault::open(&directory.join("parent-vault.sqlite")).unwrap(),
    )
    .unwrap();
    if model_fixture {
        host.request(
            "auth.set",
            json!({"credential":{"type":"api_key","key":"W0-synthetic-provider-key"}}),
        )
        .unwrap();
        let session = host.request("session.create", json!({})).unwrap()["sessionId"].clone();
        let id = host.send("prompt", json!({"sessionId":session,"text":if mode == "pending" { "W0_SLOW" } else { "Complete before host crash" }})).unwrap();
        if mode == "pending" {
            host.wait_event(id, "text_delta", std::time::Duration::from_secs(10))
                .unwrap();
        } else {
            host.wait(id, std::time::Duration::from_secs(10)).unwrap();
        }
        println!(
            "{}",
            json!({"worker":host.pid().unwrap(),"calls":host.usage.records()})
        );
        std::io::stdout().flush().unwrap();
        loop {
            std::thread::park();
        }
    }
    let descendant = host.request("ping", json!({})).unwrap()["pid"]
        .as_u64()
        .unwrap();
    println!(
        "{}",
        json!({"worker":host.pid().unwrap(),"descendant":descendant})
    );
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}
