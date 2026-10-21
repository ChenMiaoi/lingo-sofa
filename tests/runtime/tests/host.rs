use lingo_sofa_omp_client::{
    client::{Config, Host},
    protocol::{Frame, MAX_FRAME, read_frame, write_frame},
    vault::Vault,
};
use serde_json::{Value, json};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    io::{self, BufRead, Cursor, Read},
    path::PathBuf,
    time::Duration,
};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, WAIT_TIMEOUT},
    System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
};

fn setup(fault: Option<&str>) -> (tempfile::TempDir, Host) {
    setup_options(fault, &[])
}
fn setup_options(fault: Option<&str>, extra: &[&str]) -> (tempfile::TempDir, Host) {
    let dir = tempfile::tempdir().unwrap();
    let program = PathBuf::from(
        std::env::var("W0_WORKER_PROGRAM").expect("Use run-host.ts to set worker paths"),
    );
    let mut args: Vec<String> = serde_json::from_str(
        &std::env::var(if fault.is_some() {
            "W0_FAULT_ARGS"
        } else {
            "W0_WORKER_ARGS"
        })
        .unwrap(),
    )
    .unwrap();
    args.extend(extra.iter().map(|arg| (*arg).to_owned()));
    if let Some(mode) = fault {
        args.push(mode.into());
    }
    let program = if fault.is_some() {
        PathBuf::from(std::env::var("W0_FAULT_PROGRAM").unwrap())
    } else {
        program
    };
    let vault = Vault::open(&dir.path().join("vault.sqlite")).unwrap();
    let config = Config {
        program,
        args,
        directory: dir.path().to_path_buf(),
        accounts: vec!["deepseek".into(), "test-oauth".into()],
    };
    (dir, Host::new(config, vault).unwrap())
}

fn configure(host: &mut Host) {
    host.request(
        "auth.set",
        json!({"credential":{"type":"api_key","key":"W0-synthetic-provider-key"}}),
    )
    .unwrap();
}

#[test]
fn desktop_compaction_budget_uses_long_context_and_keeps_global_admission() {
    use lingo_sofa_runtime_tests::validation::{self, Workload};
    for dual in [false, true] {
        let (_directory, mut host) = setup_options(None, &["--desktop-budget"]);
        configure(&mut host);
        let result = if dual {
            validation::saturated_model_path(&mut host, Workload::Desktop)
        } else {
            validation::queued_model_path(&mut host, Workload::Desktop)
        };
        assert!(
            result.is_ok(),
            "{result:?}; calls={:?}",
            host.usage.records()
        );
        let report = result.unwrap();
        assert_eq!(report["compactionCalls"], 2);
        assert!(host.peak_active_calls() <= 2);
    }
}
fn create(host: &mut Host) -> String {
    let result = host.request("session.create", json!({})).unwrap();
    assert_eq!(result["tools"], json!([]));
    result["sessionId"].as_str().unwrap().into()
}
#[cfg(windows)]
fn running(pid: u32) -> bool {
    let process = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if process.is_null() {
        return false;
    }
    let live = unsafe { WaitForSingleObject(process, 0) == WAIT_TIMEOUT };
    unsafe {
        CloseHandle(process);
    }
    live
}

#[cfg(target_os = "macos")]
fn running(pid: u32) -> bool {
    std::process::Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && output.stdout.iter().any(|c| !c.is_ascii_whitespace())
                && !output.stdout.contains(&b'Z')
        })
}

fn hidden(command: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

#[test]
fn protocol_fragmented_utf8_limits_and_invalid_frames() {
    let frame = Frame {
        v: 1,
        instance: "test-instance".into(),
        kind: "response".into(),
        id: 1,
        method: None,
        ok: Some(true),
        payload: json!({"text":"沙发 🛋️"}),
    };
    let mut bytes = vec![];
    write_frame(&mut bytes, &frame).unwrap();
    struct Fragmented(Cursor<Vec<u8>>);
    impl Read for Fragmented {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            let max = bytes.len().min(1);
            self.0.read(&mut bytes[..max])
        }
    }
    assert_eq!(
        read_frame(&mut Fragmented(Cursor::new(bytes.clone())))
            .unwrap()
            .payload,
        frame.payload
    );
    assert!(read_frame(&mut Cursor::new(bytes[..bytes.len() - 1].to_vec())).is_err());
    for length in [0_u32, MAX_FRAME as u32 + 1] {
        assert!(read_frame(&mut Cursor::new(length.to_le_bytes())).is_err());
    }
    assert!(read_frame(&mut Cursor::new(vec![1, 0, 0, 0, 255])).is_err());
}

#[test]
fn lazy_start_handshake_utf8_streaming_and_graceful_recycle() {
    let (_dir, mut host) = setup(None);
    assert!(host.pid().is_none());
    configure(&mut host);
    let pid = host.pid().unwrap();
    let session = create(&mut host);
    assert!(host.recycle().is_err());
    assert_eq!(host.pid(), Some(pid));
    let result = host
        .request("prompt", json!({"sessionId":session,"text":"翻译沙发 🛋️"}))
        .unwrap();
    assert_eq!(result["status"], "stop");
    assert_eq!(
        host.events
            .iter()
            .filter_map(|event| event["text"].as_str())
            .collect::<String>(),
        "沙发译文 🛋️"
    );
    host.request("session.close", json!({"sessionId":session}))
        .unwrap();
    host.recycle().unwrap();
    assert!(host.pid().is_none());
    assert!(!running(pid));
}

#[test]
fn cancel_is_correlated_terminal_and_session_can_be_reused() {
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let session = create(&mut host);
    let prompt = host
        .send("prompt", json!({"sessionId":session,"text":"W0_SLOW"}))
        .unwrap();
    host.wait_event(prompt, "text_delta", Duration::from_secs(3))
        .unwrap();
    let cancel = host.send("cancel", json!({"sessionId":session})).unwrap();
    assert_eq!(
        host.wait(cancel, Duration::from_secs(3)).unwrap()["accepted"],
        true
    );
    assert_eq!(
        host.wait(prompt, Duration::from_secs(3)).unwrap()["status"],
        "aborted"
    );
    assert!(host.wait(prompt, Duration::from_secs(1)).is_err());
    assert!(
        host.usage
            .records()
            .iter()
            .any(|call| call["requestId"].as_u64() == Some(prompt)
                && call["usageState"] == "unknown")
    );
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        1
    );
    host.request(
        "prompt",
        json!({"sessionId":session,"text":"Explicit retry"}),
    )
    .unwrap();
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        2
    );
}

#[test]
fn credentials_commit_refresh_logout_restart_and_failure() {
    let (dir, mut host) = setup(None);
    configure(&mut host);
    let db = rusqlite::Connection::open(dir.path().join("vault.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER fail_update BEFORE UPDATE ON credentials BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    assert!(
        host.request(
            "auth.set",
            json!({"credential":{"type":"api_key","key":"W0-uncommitted-key"}})
        )
        .is_err()
    );
    db.execute_batch("DROP TRIGGER fail_update").unwrap();
    let session = create(&mut host);
    assert_eq!(
        host.request(
            "prompt",
            json!({"sessionId":session,"text":"Use the last committed key"})
        )
        .unwrap()["status"],
        "stop"
    );
    host.request("session.close", json!({"sessionId":session}))
        .unwrap();
    host.request("auth.login", json!({})).unwrap();
    assert_eq!(
        host.vault.read("test-oauth").unwrap()["credential"]["access"],
        "W0-old-access"
    );
    let refreshed = host.request("auth.refresh", json!({})).unwrap();
    assert_eq!(refreshed["resolved"], true);
    assert_eq!(refreshed["refreshes"], 1);
    assert_eq!(
        host.vault.read("test-oauth").unwrap()["credential"]["refresh"],
        "W0-new-refresh"
    );
    host.recycle().unwrap();
    // Recreate the actual Rust vault connection as well as the worker process.
    host.vault = Vault::open(&dir.path().join("vault.sqlite")).unwrap();
    assert_eq!(
        host.request("auth.refresh", json!({})).unwrap()["refreshes"],
        0
    );
    host.request("auth.logout", json!({})).unwrap();
    assert!(host.vault.read("test-oauth").unwrap()["credential"].is_null());
    host.recycle().unwrap();
    assert_eq!(
        host.request("auth.refresh", json!({})).unwrap()["resolved"],
        false
    );
    host.request("auth.login", json!({})).unwrap();
    let previous = host.vault.read("test-oauth").unwrap();
    db.execute_batch("CREATE TRIGGER fail_update BEFORE UPDATE ON credentials BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
    let failed = host.request("auth.refresh", json!({}));
    assert!(failed.is_err() || failed.unwrap()["anyResolved"] == false);
    assert_eq!(host.vault.read("test-oauth").unwrap(), previous);
    let bytes = std::fs::read(dir.path().join("vault.sqlite")).unwrap();
    for secret in [
        "W0-new-refresh",
        "W0-old-refresh",
        "W0-synthetic-provider-key",
    ] {
        assert!(
            !bytes
                .windows(secret.len())
                .any(|slice| slice == secret.as_bytes())
        );
    }
}

#[test]
fn logout_fences_an_inflight_refresh_without_resurrecting_credentials() {
    let (_dir, mut host) = setup(None);
    host.request("auth.login", json!({})).unwrap();
    let refresh = host.send("auth.refresh", json!({})).unwrap();
    assert!(host.recycle().is_err());
    for _ in 0..20 {
        if host.request("stats", json!({})).unwrap()["refreshes"] == 1 {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    host.request("auth.logout", json!({})).unwrap();
    let result = host.wait(refresh, Duration::from_secs(3));
    assert!(result.is_err() || result.unwrap()["anyResolved"] == false);
    assert!(host.vault.read("test-oauth").unwrap()["credential"].is_null());
    host.recycle().unwrap();
    assert_eq!(
        host.request("auth.refresh", json!({})).unwrap()["anyResolved"],
        false
    );
}

#[test]
fn failed_credential_handshake_cleans_up_partial_initialization() {
    let (dir, mut host) = setup(None);
    host.vault
        .commit(
            "deepseek",
            0,
            &json!({"type":"api_key","key":"W0-synthetic"}),
        )
        .unwrap();
    let connection = rusqlite::Connection::open(dir.path().join("vault.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE credentials SET blob=x'01020304' WHERE account='deepseek'",
            [],
        )
        .unwrap();
    assert!(host.start().is_err());
    assert!(host.pid().is_none());
    assert!(host.vault.read("deepseek").is_err());
}

#[test]
fn crash_timeout_and_invalid_messages_terminate_without_replay() {
    let (_dir, mut invalid) = setup(Some("bad-handshake"));
    assert_eq!(invalid.start(), Err("handshake_failed"));
    assert!(invalid.pid().is_none());
    for fault in [
        "exit",
        "hang",
        "wrong-version",
        "wrong-instance",
        "unknown-id",
        "oversize",
        "truncated",
        "bad-json",
    ] {
        let (_dir, mut host) = setup(Some(fault));
        host.start().unwrap();
        let pid = host.pid().unwrap();
        let id = host.send("ping", json!({})).unwrap();
        assert!(
            host.wait(id, Duration::from_millis(250)).is_err(),
            "{fault}"
        );
        assert!(host.pid().is_none(), "{fault}");
        assert!(host.lost_requests.contains(&id));
        assert!(!running(pid), "{fault}");
    }
}

#[test]
fn duplicate_response_stderr_backpressure_and_bounded_admission() {
    let (_dir, mut host) = setup(Some("duplicate"));
    host.request("ping", json!({})).unwrap();
    assert!(host.request("ping", json!({})).is_err());
    assert!(host.pid().is_none());
    let (_dir, mut host) = setup(Some("stderr-flood"));
    host.request("ping", json!({})).unwrap();
    let (_dir, mut host) = setup(Some("hang"));
    for _ in 0..16 {
        host.send("ping", json!({})).unwrap();
    }
    assert!(host.send("ping", json!({})).is_err());
    host.stop();
}

#[test]
fn job_kills_descendant_on_host_drop() {
    let (_dir, mut host) = setup(Some("descendant"));
    let worker = {
        host.start().unwrap();
        host.pid().unwrap()
    };
    let descendant = host.request("ping", json!({})).unwrap()["pid"]
        .as_u64()
        .unwrap() as u32;
    assert!(running(descendant));
    drop(host);
    assert!(!running(worker));
    for _ in 0..50 {
        if !running(descendant) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("descendant survived job close");
}

#[test]
fn operating_system_reaps_worker_and_descendant_when_rust_host_is_killed() {
    let dir = tempfile::tempdir().unwrap();
    struct Parent(std::process::Child);
    impl Drop for Parent {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut parent = Parent(
        hidden(&mut std::process::Command::new(env!(
            "CARGO_BIN_EXE_w0-parent"
        )))
        .arg(dir.path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap(),
    );
    let stdout = parent.0.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let mut line = String::new();
        let _ = io::BufReader::new(stdout).read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let pids: Value = serde_json::from_str(&line).unwrap();
    let worker = pids["worker"].as_u64().unwrap() as u32;
    let descendant = pids["descendant"].as_u64().unwrap() as u32;
    assert!(running(worker) && running(descendant));
    parent.0.kill().unwrap();
    parent.0.wait().unwrap();
    reader.join().unwrap();
    for _ in 0..100 {
        if !running(worker) && !running(descendant) {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("worker survived external host termination");
}

#[test]
fn explicit_restart_loses_sessions_and_does_not_replay_generation() {
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let session = create(&mut host);
    let id = host
        .send("prompt", json!({"sessionId":session,"text":"W0_SLOW"}))
        .unwrap();
    for _ in 0..30 {
        if host.request("stats", json!({})).unwrap()["providerCalls"] == 1 {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    host.stop();
    assert!(host.lost_requests.contains(&id));
    assert!(
        host.usage
            .records()
            .iter()
            .any(|call| call["usageState"] == "unknown" && call["stopReason"] == "worker_lost")
    );
    assert!(host.pid().is_none());
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        0
    );
    assert!(
        host.request(
            "prompt",
            json!({"sessionId":session,"text":"Do not recreate automatically"})
        )
        .is_err()
    );
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        0
    );
    assert_eq!(
        host.vault.read("deepseek").unwrap()["credential"]["type"],
        "api_key"
    );
    let fresh = create(&mut host);
    assert_eq!(
        host.request(
            "prompt",
            json!({"sessionId":fresh,"text":"Explicit new session after restart"})
        )
        .unwrap()["status"],
        "stop"
    );
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        1
    );
}

#[test]
fn compaction_and_generation_usage_reach_rust_before_terminal() {
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let session = create(&mut host);
    host.request(
        "prompt",
        json!({"sessionId":session,"text":"Synthetic reading context. ".repeat(150)}),
    )
    .unwrap();
    host.request(
        "prompt",
        json!({"sessionId":session,"text":"Continue briefly"}),
    )
    .unwrap();
    let id = host
        .send("session.compact", json!({"sessionId":session}))
        .unwrap();
    assert_eq!(
        host.wait(id, Duration::from_secs(10)).unwrap()["summaryCommitted"],
        true
    );
    let calls = host.usage.records();
    let compacted: Vec<&serde_json::Value> = calls
        .iter()
        .filter(|call| call["requestId"].as_u64() == Some(id))
        .collect();
    assert!(compacted.len() >= 2);
    assert!(compacted.iter().all(|call| call["purpose"] == "compaction"
        && call["usageState"] == "reported"
        && call["usage"]["totalTokens"] == 88));
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"].as_u64(),
        Some(calls.len() as u64)
    );
    assert!(calls.iter().all(|call| call["type"] == "call_completed"));
}

#[test]
fn model_admission_rejects_third_call_and_cancel_releases_one_slot() {
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let a = create(&mut host);
    let b = create(&mut host);
    let c = create(&mut host);
    let first = host
        .send("prompt", json!({"sessionId":a,"text":"W0_SLOW"}))
        .unwrap();
    host.wait_event(first, "text_delta", Duration::from_secs(5))
        .unwrap();
    let second = host
        .send("prompt", json!({"sessionId":b,"text":"W0_SLOW"}))
        .unwrap();
    host.wait_event(second, "text_delta", Duration::from_secs(5))
        .unwrap();
    assert_eq!(host.usage.active(), 2);
    let denied = host
        .send(
            "prompt",
            json!({"sessionId":c,"text":"Must not reach HTTP"}),
        )
        .unwrap();
    assert_eq!(
        host.wait(denied, Duration::from_secs(5)).unwrap()["status"],
        "error"
    );
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        2
    );
    assert!(host.usage.records().iter().any(|r| r["requestId"] == denied
        && r["usageState"] == "not_dispatched"
        && r["usage"].is_null()));
    host.request("cancel", json!({"sessionId":a})).unwrap();
    host.wait(first, Duration::from_secs(5)).unwrap();
    assert_eq!(host.usage.active(), 1);
    assert_eq!(
        host.request("prompt", json!({"sessionId":c,"text":"Explicit retry"}))
            .unwrap()["status"],
        "stop"
    );
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        3
    );
    host.request("cancel", json!({"sessionId":b})).unwrap();
    host.wait(second, Duration::from_secs(5)).unwrap();
    assert_eq!(host.usage.active(), 0);
}

#[test]
fn disconnect_and_cancel_preserve_unknown_or_partial_usage_without_replay() {
    let (dir, mut host) = setup(None);
    configure(&mut host);
    let session = create(&mut host);
    let disconnected = host
        .send(
            "prompt",
            json!({"sessionId":session,"text":"W0_DISCONNECT"}),
        )
        .unwrap();
    host.wait(disconnected, Duration::from_secs(10)).unwrap();
    let records = host.usage.records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["usageState"], "unknown");
    assert!(records[0]["usage"].is_null());
    let session = create(&mut host);
    let partial = host
        .send(
            "prompt",
            json!({"sessionId":session,"text":"W0_PARTIAL W0_SLOW"}),
        )
        .unwrap();
    host.wait_event(partial, "text_delta", Duration::from_secs(5))
        .unwrap();
    // The fixture puts usage on the same chunk as text, before text_delta.
    host.request("cancel", json!({"sessionId":session}))
        .unwrap();
    host.wait(partial, Duration::from_secs(5)).unwrap();
    let record = host
        .usage
        .records()
        .into_iter()
        .find(|r| r["requestId"] == partial)
        .unwrap();
    assert_eq!(record["usageState"], "partial");
    assert_eq!(record["usage"]["totalTokens"], 88);
    assert_eq!(host.usage.active(), 0);
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        2
    );
    let stats = host.request("stats", json!({})).unwrap();
    assert_eq!(stats["activeProviderCalls"], 0);
    assert_eq!(stats["activeCallIds"], json!([]));
    assert!(stats["peakProviderCalls"].as_u64().unwrap() <= 2);
    let expected = host.usage.records();
    drop(host);
    let reopened =
        lingo_sofa_omp_client::usage::UsageLedger::open(&dir.path().join("usage.sqlite")).unwrap();
    assert_eq!(reopened.records(), expected);
}

#[test]
fn actual_host_crash_recovers_pending_and_preserves_committed_terminal() {
    for mode in ["pending", "completed"] {
        let dir = tempfile::tempdir().unwrap();
        let mut parent = hidden(&mut std::process::Command::new(env!(
            "CARGO_BIN_EXE_w0-parent"
        )))
        .arg(dir.path())
        .arg(mode)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
        let stdout = parent.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            let mut line = String::new();
            let _ = io::BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send(line);
        });
        let line = rx.recv_timeout(Duration::from_secs(15));
        parent.kill().unwrap();
        parent.wait().unwrap();
        reader.join().unwrap();
        let before: Value = serde_json::from_str(&line.unwrap()).unwrap();
        assert_eq!(before["calls"].as_array().unwrap().len(), 1);
        let mut ledger =
            lingo_sofa_omp_client::usage::UsageLedger::open(&dir.path().join("usage.sqlite"))
                .unwrap();
        let records = ledger.records();
        assert_eq!(records.len(), 1);
        assert_eq!(ledger.active(), 0);
        if mode == "pending" {
            assert_eq!(records[0]["usageState"], "unknown");
            assert_eq!(records[0]["stopReason"], "worker_lost");
            assert!(records[0]["usage"].is_null());
        } else {
            assert_eq!(records[0]["usageState"], "reported");
            assert_eq!(records[0]["usage"]["totalTokens"], 88);
            let request = records[0]["requestId"].as_u64().unwrap();
            ledger
                .complete(
                    records[0]["instance"].as_str().unwrap(),
                    request,
                    &records[0],
                )
                .unwrap();
            assert_eq!(ledger.records(), records);
        }
        drop(ledger);
        let mut host = Host::new(
            Config {
                program: PathBuf::from(std::env::var("W0_WORKER_PROGRAM").unwrap()),
                args: serde_json::from_str(&std::env::var("W0_WORKER_ARGS").unwrap()).unwrap(),
                directory: dir.path().to_path_buf(),
                accounts: vec!["deepseek".into(), "test-oauth".into()],
            },
            Vault::open(&dir.path().join("parent-vault.sqlite")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            host.request("stats", json!({})).unwrap()["providerCalls"],
            0
        );
        assert_eq!(host.usage.records(), records);
    }
}

#[test]
fn cancelled_before_admission_ack_never_dispatches_or_claims_zero_usage() {
    let (dir, mut host) = setup(None);
    configure(&mut host);
    let session = create(&mut host);
    // Both commands precede any admission acknowledgement on the same pipe.
    let prompt = host
        .send("prompt", json!({"sessionId":session,"text":"W0_SLOW"}))
        .unwrap();
    host.wait_event(prompt, "call_requested", Duration::from_secs(5))
        .unwrap();
    let cancel = host.send("cancel", json!({"sessionId":session})).unwrap();
    host.wait(cancel, Duration::from_secs(10)).unwrap();
    host.wait(prompt, Duration::from_secs(10)).unwrap();
    let records = host.usage.records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["usageState"], "not_dispatched");
    assert_eq!(records[0]["stopReason"], "cancelled_before_dispatch");
    assert!(records[0]["usage"].is_null());
    assert_eq!(host.usage.active(), 0);
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        0
    );
    assert!(!dir.path().join("synthetic-http-count").exists());
}

#[test]
fn ledger_io_failure_prevents_dispatch_or_terminal_ack_and_recovery_does_not_replay() {
    for phase in ["INSERT", "UPDATE"] {
        let (dir, host) = setup(None);
        drop(host);
        let path = dir.path().join("usage.sqlite");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch(&format!(
            "CREATE TRIGGER fail BEFORE {phase} ON calls BEGIN SELECT RAISE(ABORT, 'test'); END;"
        ))
        .unwrap();
        drop(db);
        let config = Config {
            program: PathBuf::from(std::env::var("W0_WORKER_PROGRAM").unwrap()),
            args: serde_json::from_str(&std::env::var("W0_WORKER_ARGS").unwrap()).unwrap(),
            directory: dir.path().to_path_buf(),
            accounts: vec!["deepseek".into(), "test-oauth".into()],
        };
        let mut host = Host::new(
            config.clone(),
            Vault::open(&dir.path().join("vault.sqlite")).unwrap(),
        )
        .unwrap();
        configure(&mut host);
        let session = create(&mut host);
        assert_eq!(
            host.request(
                "prompt",
                json!({"sessionId":session,"text":"Synthetic write failure"})
            ),
            Err("ledger_write_failed")
        );
        assert!(host.pid().is_none());
        if phase == "INSERT" {
            assert!(!dir.path().join("synthetic-http-count").exists());
            assert!(host.usage.records().is_empty());
        } else {
            assert_eq!(
                std::fs::read_to_string(dir.path().join("synthetic-http-count")).unwrap(),
                "1"
            );
            assert_eq!(host.usage.active(), 1);
            assert_eq!(host.request("stats", json!({})), Err("ledger_write_failed"));
        }
        drop(host);
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("DROP TRIGGER fail;").unwrap();
        drop(db);
        let mut host = Host::new(
            config,
            Vault::open(&dir.path().join("vault.sqlite")).unwrap(),
        )
        .unwrap();
        assert_eq!(host.usage.active(), 0);
        assert_eq!(
            host.request("stats", json!({})).unwrap()["providerCalls"],
            0
        );
        if phase == "UPDATE" {
            assert_eq!(host.usage.records()[0]["usageState"], "unknown");
        }
    }
}

#[test]
fn repeated_terminal_over_ipc_is_idempotent_and_conflicts_preserve_committed_usage() {
    for mode in ["ledger-duplicate", "ledger-conflict"] {
        let (dir, mut host) = setup(Some(mode));
        let result = host.request("ping", json!({}));
        if mode == "ledger-duplicate" {
            assert!(result.is_ok());
        } else {
            assert_eq!(result, Err("conflicting_call_terminal"));
            assert!(host.pid().is_none());
        }
        assert_eq!(host.usage.active(), 0);
        let records = host.usage.records();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["usageState"], "reported");
        assert_eq!(records[0]["usage"]["output"], 8);
        drop(host);
        let ledger =
            lingo_sofa_omp_client::usage::UsageLedger::open(&dir.path().join("usage.sqlite"))
                .unwrap();
        assert_eq!(ledger.records(), records);
    }
}

fn business(
    session: &str,
    priority: lingo_sofa_omp_client::scheduler::Priority,
    text: &str,
) -> lingo_sofa_omp_client::scheduler::Task {
    lingo_sofa_omp_client::scheduler::Task {
        session_id: session.into(),
        scope: session.into(),
        revision: 1,
        priority,
        ttl: Duration::from_secs(30),
        work: lingo_sofa_omp_client::scheduler::Work::Prompt(text.into()),
    }
}
fn blockers(host: &mut Host) -> [(String, u64); 2] {
    let a = create(host);
    let b = create(host);
    let first = host
        .send("prompt", json!({"sessionId":a,"text":"W0_SLOW"}))
        .unwrap();
    host.wait_event(first, "text_delta", Duration::from_secs(5))
        .unwrap();
    let second = host
        .send("prompt", json!({"sessionId":b,"text":"W0_SLOW"}))
        .unwrap();
    host.wait_event(second, "text_delta", Duration::from_secs(5))
        .unwrap();
    [(a, first), (b, second)]
}
fn release(host: &mut Host, blocked: &(String, u64)) {
    host.request("cancel", json!({"sessionId":blocked.0}))
        .unwrap();
    host.wait(blocked.1, Duration::from_secs(5)).unwrap();
}
#[test]
fn business_queue_is_bounded_and_controls_remain_available_when_full() {
    use lingo_sofa_omp_client::scheduler::{Priority, Status};
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let blocked = blockers(&mut host);
    let session = create(&mut host);
    let tasks: Vec<_> = (0..32)
        .map(|_| {
            host.submit_task(business(&session, Priority::Manual, "queued"))
                .unwrap()
        })
        .collect();
    assert_eq!(host.queued_tasks(), 32);
    assert_eq!(
        host.submit_task(business(&session, Priority::Manual, "overflow")),
        Err("task_queue_full")
    );
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        2
    );
    host.cancel_task(tasks[7]).unwrap();
    host.cancel_task(tasks[7]).unwrap();
    assert_eq!(
        host.task_outcome(tasks[7]).unwrap().unwrap().status,
        Status::Cancelled
    );
    assert_eq!(host.queued_tasks(), 31);
    host.submit_task(business(&session, Priority::Manual, "replacement"))
        .unwrap();
    assert_eq!(host.queued_tasks(), 32);
    host.stop();
    assert_eq!(
        host.task_outcome(tasks[0]).unwrap().unwrap().status,
        Status::Lost
    );
    assert_eq!(host.queued_tasks(), 0);
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        0
    );
    assert!(host.lost_requests.contains(&blocked[0].1));
}
#[test]
fn business_priority_runs_manual_before_background_over_real_ipc() {
    use lingo_sofa_omp_client::scheduler::{Priority, Status};
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let blocked = blockers(&mut host);
    let c = create(&mut host);
    let d = create(&mut host);
    let background = host
        .submit_task(business(&c, Priority::Background, "background"))
        .unwrap();
    let manual = host
        .submit_task(business(&d, Priority::Manual, "manual"))
        .unwrap();
    release(&mut host, &blocked[0]);
    let bg = host.wait_task(background, Duration::from_secs(10)).unwrap();
    let high = host.wait_task(manual, Duration::from_secs(10)).unwrap();
    assert_eq!(bg.status, Status::Completed);
    assert_eq!(high.status, Status::Completed);
    assert!(high.request_id.unwrap() < bg.request_id.unwrap());
    release(&mut host, &blocked[1]);
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        4
    );
}
#[test]
fn queued_cancellation_expiry_and_supersession_never_dispatch_http() {
    use lingo_sofa_omp_client::scheduler::{Priority, Status};
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let blocked = blockers(&mut host);
    let session = create(&mut host);
    let cancelled = host
        .submit_task(business(&session, Priority::Manual, "cancel me"))
        .unwrap();
    host.cancel_task(cancelled).unwrap();
    let expiring = host
        .submit_task(lingo_sofa_omp_client::scheduler::Task {
            ttl: Duration::from_millis(50),
            ..business(&session, Priority::Manual, "expire me")
        })
        .unwrap();
    let pid = host.pid();
    assert_eq!(
        host.wait_task(expiring, Duration::from_secs(2))
            .unwrap()
            .status,
        Status::Expired
    );
    assert_eq!(host.pid(), pid);
    let stale = host
        .submit_task(business(&session, Priority::Manual, "stale text"))
        .unwrap();
    let fresh = host
        .submit_task(lingo_sofa_omp_client::scheduler::Task {
            revision: 2,
            ..business(&session, Priority::Manual, "fresh text")
        })
        .unwrap();
    assert_eq!(
        host.task_outcome(stale).unwrap().unwrap().status,
        Status::Stale
    );
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        2
    );
    assert_eq!(host.usage.records().len(), 2);
    release(&mut host, &blocked[0]);
    assert_eq!(
        host.wait_task(fresh, Duration::from_secs(5))
            .unwrap()
            .status,
        Status::Completed
    );
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        3
    );
    release(&mut host, &blocked[1]);
}
#[test]
fn running_business_result_is_fenced_after_revision_changes_and_session_stays_serial() {
    use lingo_sofa_omp_client::scheduler::{Priority, Status, Task};
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let session = create(&mut host);
    let old = host
        .submit_task(business(&session, Priority::Manual, "W0_SLOW"))
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while host.usage.records().is_empty() {
        host.request("stats", json!({})).unwrap();
        assert!(
            std::time::Instant::now() < deadline,
            "scheduled call did not start"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let request = host.usage.records()[0]["requestId"].as_u64().unwrap();
    host.wait_event(request, "text_delta", Duration::from_secs(5))
        .unwrap();
    let fresh = host
        .submit_task(Task {
            revision: 2,
            ..business(&session, Priority::Manual, "current")
        })
        .unwrap();
    assert_eq!(host.running_tasks(), 1);
    assert_eq!(host.queued_tasks(), 1);
    host.cancel_task(old).unwrap();
    let discarded = host.wait_task(old, Duration::from_secs(5)).unwrap();
    assert_eq!(discarded.status, Status::Stale);
    assert!(discarded.response.is_none());
    assert_eq!(
        host.wait_task(fresh, Duration::from_secs(5))
            .unwrap()
            .status,
        Status::Completed
    );
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        2
    );
    assert_eq!(host.usage.records().len(), 2);
}
#[test]
fn queued_compaction_reserves_global_capacity_and_both_branches_are_accounted() {
    use lingo_sofa_omp_client::scheduler::{Priority, Status, Task, Work};
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let compact_session = create(&mut host);
    host.request(
        "prompt",
        json!({"sessionId":compact_session,"text":"Synthetic reading context. ".repeat(150)}),
    )
    .unwrap();
    host.request(
        "prompt",
        json!({"sessionId":compact_session,"text":"Continue briefly"}),
    )
    .unwrap();
    let blocked = blockers(&mut host);
    let generation_session = create(&mut host);
    let compact = host
        .submit_task(Task {
            work: Work::Compact,
            ..business(&compact_session, Priority::Manual, "")
        })
        .unwrap();
    let generation = host
        .submit_task(business(
            &generation_session,
            Priority::Manual,
            "after compaction",
        ))
        .unwrap();
    release(&mut host, &blocked[0]);
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        4
    );
    assert_eq!(host.running_tasks(), 0);
    assert_eq!(host.queued_tasks(), 2);
    release(&mut host, &blocked[1]);
    let compact = host.wait_task(compact, Duration::from_secs(10)).unwrap();
    let generation = host.wait_task(generation, Duration::from_secs(10)).unwrap();
    assert_eq!(compact.status, Status::Completed);
    assert_eq!(generation.status, Status::Completed);
    assert_eq!(compact.response.unwrap()["summaryCommitted"], true);
    assert!(compact.request_id.unwrap() < generation.request_id.unwrap());
    let compact_calls: Vec<_> = host
        .usage
        .records()
        .into_iter()
        .filter(|r| r["requestId"].as_u64() == compact.request_id)
        .collect();
    assert_eq!(compact_calls.len(), 2);
    assert!(
        compact_calls
            .iter()
            .all(|r| r["purpose"] == "compaction" && r["usageState"] == "reported")
    );
    assert_eq!(host.usage.active(), 0);
    assert_eq!(
        host.request("stats", json!({})).unwrap()["providerCalls"],
        7
    );
}
#[test]
fn expired_queued_task_does_not_start_worker() {
    use lingo_sofa_omp_client::scheduler::{Priority, Status, Task};
    let (_dir, mut host) = setup(None);
    let task = host
        .submit_task(Task {
            ttl: Duration::ZERO,
            ..business("unused", Priority::Manual, "private queued content")
        })
        .unwrap();
    assert_eq!(
        host.wait_task(task, Duration::from_secs(1)).unwrap().status,
        Status::Expired
    );
    assert!(host.pid().is_none());
    assert!(host.usage.records().is_empty());
}

#[test]
fn business_wait_timeout_does_not_cancel_or_lose_running_task() {
    use lingo_sofa_omp_client::scheduler::{Priority, Status};
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let session = create(&mut host);
    let task = host
        .submit_task(business(&session, Priority::Manual, "W0_SLOW"))
        .unwrap();
    let pid = host.pid();
    assert_eq!(
        host.wait_task(task, Duration::from_millis(100))
            .unwrap_err(),
        "task_wait_timeout"
    );
    assert_eq!(host.pid(), pid);
    assert!(host.task_outcome(task).unwrap().is_none());
    host.cancel_task(task).unwrap();
    assert_eq!(
        host.wait_task(task, Duration::from_secs(5)).unwrap().status,
        Status::Cancelled
    );
    assert_eq!(host.usage.active(), 0);
}

#[test]
fn live_entry_uses_queue_for_generation_compaction_and_cancellation_with_durable_usage() {
    let (dir, mut host) = setup(None);
    configure(&mut host);
    let report = lingo_sofa_runtime_tests::validation::queued_model_path(
        &mut host,
        lingo_sofa_runtime_tests::validation::Workload::Fixture,
    )
    .unwrap();
    assert_eq!(report["providerCalls"], 6);
    assert_eq!(report["compactionCalls"], 2);
    assert!(
        report["checks"]
            .as_object()
            .unwrap()
            .values()
            .all(|v| v == true)
    );
    assert_eq!(report["tasks"]["queuedCancelled"]["requestId"], Value::Null);
    let calls = host.usage.records();
    assert_eq!(calls.len(), 6);
    drop(host);
    let ledger =
        lingo_sofa_omp_client::usage::UsageLedger::open(&dir.path().join("usage.sqlite")).unwrap();
    assert_eq!(ledger.records(), calls);
    assert_eq!(ledger.active(), 0);
}
#[test]
fn task_event_wait_terminal_and_timeout_preserve_host_and_cancellation() {
    use lingo_sofa_omp_client::scheduler::{Priority, Status};
    let (_dir, mut host) = setup(None);
    configure(&mut host);
    let session = create(&mut host);
    let task = host
        .submit_task(business(&session, Priority::Manual, "W0_SLOW"))
        .unwrap();
    let pid = host.pid();
    assert_eq!(
        host.wait_task_event(task, "absent", Duration::from_millis(100)),
        Err("task_wait_timeout")
    );
    assert_eq!(host.pid(), pid);
    host.wait_task_event(task, "text_delta", Duration::from_secs(5))
        .unwrap();
    host.cancel_task(task).unwrap();
    assert_eq!(
        host.wait_task(task, Duration::from_secs(5)).unwrap().status,
        Status::Cancelled
    );
    assert_eq!(
        host.wait_task_event(task, "text_delta", Duration::from_secs(1)),
        Err("task_terminal_without_event")
    );
    let queued = host
        .submit_task(business(&session, Priority::Manual, "not sent"))
        .unwrap();
    host.cancel_task(queued).unwrap();
    assert_eq!(
        host.wait_task_event(queued, "text_delta", Duration::from_secs(1)),
        Err("task_terminal_without_event")
    );
    assert_eq!(host.pid(), pid);
    assert!(host.request("stats", json!({})).is_ok());
}

#[test]
fn live_dual_saturation_queue_cancellation_and_compaction_share_the_global_limit() {
    let (dir, mut host) = setup(None);
    configure(&mut host);
    let report = lingo_sofa_runtime_tests::validation::saturated_model_path(
        &mut host,
        lingo_sofa_runtime_tests::validation::Workload::Fixture,
    )
    .unwrap();
    assert_eq!(report["providerCalls"], 7);
    assert_eq!(report["peakProviderCalls"], 2);
    assert_eq!(report["peakActiveCalls"], 2);
    assert!(
        report["checks"]
            .as_object()
            .unwrap()
            .values()
            .all(|value| value == true)
    );
    assert_eq!(report["observations"][0]["activeProviderCalls"], 2);
    assert_eq!(report["observations"][3]["activeProviderCalls"], 1);
    assert_eq!(report["observations"][3]["providerCalls"], 4);
    assert_eq!(report["observations"][4]["activeProviderCalls"], 0);
    let calls = host.usage.records();
    assert_eq!(calls.len(), 7);
    drop(host);
    let ledger =
        lingo_sofa_omp_client::usage::UsageLedger::open(&dir.path().join("usage.sqlite")).unwrap();
    assert_eq!(ledger.records(), calls);
    assert_eq!(ledger.active(), 0);
}

#[test]
fn delayed_durable_admission_ack_does_not_terminate_the_worker() {
    let (directory, mut host) = setup(None);
    configure(&mut host);
    let session = create(&mut host);
    let request = host
        .send(
            "prompt",
            json!({"sessionId":session,"text":"Delayed durable acknowledgement"}),
        )
        .unwrap();
    host.wait_event(request, "call_requested", Duration::from_secs(5))
        .unwrap();
    // A slow host must retain a bounded opportunity to commit before the provider starts.
    std::thread::sleep(Duration::from_secs(4));
    assert!(!directory.path().join("synthetic-http-count").exists());
    let response = host.wait(request, Duration::from_secs(10)).unwrap();
    assert_eq!(response["status"], "stop");
    assert_eq!(host.usage.records().len(), 1);
    assert_eq!(host.usage.records()[0]["usageState"], "reported");
}
