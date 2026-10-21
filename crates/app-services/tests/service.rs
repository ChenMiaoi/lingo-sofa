use lingo_sofa_app_services::{Service, Settings, View};
use lingo_sofa_omp_client::client::Config;
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn start(directory: &Path) -> Service {
    start_options(directory, &[])
}
fn start_options(directory: &Path, extra: &[&str]) -> Service {
    let mut args: Vec<String> =
        serde_json::from_str(&std::env::var("W0_WORKER_ARGS").expect("Run test:runtime")).unwrap();
    args.push("--api-only".into());
    args.extend(extra.iter().map(|s| (*s).to_owned()));
    Service::with_runtime(Config {
        program: std::env::var("W0_WORKER_PROGRAM").unwrap().into(),
        args,
        directory: directory.to_path_buf(),
        accounts: vec!["deepseek".into()],
    })
    .unwrap()
}
fn wait(service: &Service, predicate: impl Fn(&View) -> bool) -> View {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let view = service.state();
        if predicate(&view) {
            return view;
        }
        assert!(
            Instant::now() < deadline,
            "Timed out: {} / {}",
            view.phase,
            view.message
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_new_input_question_does_not_inherit_the_previous_reading_or_translation_instruction() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_options(directory.path(), &["--record-messages"]);
    service.save_key("synthetic-desktop-secret".into()).unwrap();
    wait(&service, |v| v.key_configured);
    service
        .submit(1, "OLD_READING_SENTINEL".into(), false)
        .unwrap();
    wait(&service, |v| {
        v.revision == 1 && v.phase == "ready" && v.task_id.is_none()
    });
    service
        .submit_new_question(2, "INDEPENDENT_QUESTION_SENTINEL".into())
        .unwrap();
    wait(&service, |v| {
        v.revision == 2 && v.phase == "ready" && v.task_id.is_none()
    });
    let messages =
        std::fs::read_to_string(directory.path().join("synthetic-messages.json")).unwrap();
    assert!(messages.contains("INDEPENDENT_QUESTION_SENTINEL"));
    assert!(!messages.contains("OLD_READING_SENTINEL"));
    assert!(!messages.contains("<source>"));
    service.shutdown();
}
#[test]
fn desktop_service_streams_asks_compacts_cancels_and_recovers_persisted_state() {
    let directory = tempfile::tempdir().unwrap();
    let service = start(directory.path());
    service.save_key("synthetic-desktop-secret".into()).unwrap();
    wait(&service, |v| v.key_configured);
    service
        .settings(Settings {
            target: "English".into(),
            pinned: false,
        })
        .unwrap();
    wait(&service, |v| v.settings.target == "English");
    service
        .submit(1, "Synthetic reading context. ".repeat(150), false)
        .unwrap();
    let done = wait(&service, |v| {
        v.revision == 1 && v.phase == "ready" && v.task_id.is_none()
    });
    assert!(done.output.contains("沙发译文"));
    assert!(done.reported_tokens > 0);
    assert!(done.session_ready);
    service
        .submit(2, "What is the project code?".into(), true)
        .unwrap();
    let answer = wait(&service, |v| v.revision == 2 && v.phase == "ready");
    assert_eq!(answer.output, "W0-ALPHA");
    service.compact().unwrap();
    wait(&service, |v| {
        v.message == "已完成" && v.reported_tokens > answer.reported_tokens
    });
    service.submit(3, "W0_SLOW".into(), false).unwrap();
    wait(&service, |v| v.revision == 3 && !v.output.is_empty());
    service.cancel().unwrap();
    let cancelled = wait(&service, |v| {
        v.revision == 3 && v.phase == "ready" && v.task_id.is_none()
    });
    assert!(cancelled.message.contains("已取消"));
    assert!(cancelled.unknown_calls > 0);
    service.submit(4, "Short text".into(), false).unwrap();
    wait(&service, |v| v.revision == 4 && v.phase == "ready");
    service.compact().unwrap();
    wait(&service, |v| v.message == "当前会话较短，无需压缩");
    service.reset().unwrap();
    let cleared = wait(&service, |v| !v.session_ready && v.output.is_empty());
    assert!(cleared.key_configured);
    assert!(cleared.reported_tokens > 0);
    service
        .submit(5, "A new independent question".into(), true)
        .unwrap();
    wait(&service, |v| v.revision == 5 && v.phase == "ready");
    service.shutdown();
    let saved = std::fs::read(directory.path().join("credentials.sqlite")).unwrap();
    assert!(
        !saved
            .windows(b"synthetic-desktop-secret".len())
            .any(|s| s == b"synthetic-desktop-secret")
    );
    let restored = start(directory.path());
    let state = wait(&restored, |v| v.reported_tokens > 0);
    assert!(state.key_configured);
    assert!(!state.settings.pinned);
    assert_eq!(state.settings.target, "English");
    assert!(state.output.is_empty());
    assert!(!state.session_ready);
    assert!(state.unknown_calls > 0);
    restored.save_key(String::new()).unwrap();
    wait(&restored, |v| !v.key_configured);
    restored.shutdown();
}

#[test]
fn replacing_the_reading_more_than_the_scope_limit_keeps_accepting_translations() {
    let directory = tempfile::tempdir().unwrap();
    let service = start(directory.path());
    service.save_key("synthetic-repeated-key".into()).unwrap();
    wait(&service, |v| v.key_configured);
    for revision in 1..=70 {
        service
            .submit(revision, "Next reading".into(), false)
            .unwrap();
        let view = wait(&service, |v| v.revision == revision && v.phase == "ready");
        assert!(view.output.contains("沙发译文"));
    }
    service.shutdown();
}

#[test]
fn errors_belong_to_the_new_reading_and_cancelling_catalog_preflight_never_calls_the_model() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_options(directory.path(), &["--slow-catalog"]);
    service.submit(1, "No account".into(), false).unwrap();
    let error = wait(&service, |v| v.revision == 1 && v.phase == "error");
    assert!(error.message.contains("API Key"));
    assert!(error.output.is_empty());
    service.save_key("synthetic-preflight-key".into()).unwrap();
    wait(&service, |v| v.key_configured);
    service
        .submit(2, "Cancel during model catalog".into(), false)
        .unwrap();
    wait(&service, |v| v.revision == 2 && v.phase == "preparing");
    service.cancel().unwrap();
    let cancelled = wait(&service, |v| v.revision == 2 && v.phase == "ready");
    assert_eq!(cancelled.message, "已取消");
    std::thread::sleep(Duration::from_millis(200));
    assert!(!directory.path().join("synthetic-http-count").exists());
    assert_eq!(service.state().reported_tokens, 0);
    assert_eq!(service.state().active_calls, 0);
    service.shutdown();
}

#[test]
fn multiple_providers_preserve_legacy_credentials_and_route_the_persisted_default_model() {
    let directory = tempfile::tempdir().unwrap();
    let vault_path = directory.path().join("credentials.sqlite");
    let mut vault = lingo_sofa_omp_client::vault::Vault::open(&vault_path).unwrap();
    vault
        .commit(
            "deepseek",
            0,
            &serde_json::json!({"type":"api_key","key":"legacy-deepseek-key"}),
        )
        .unwrap();
    drop(vault);
    let service = start_options(directory.path(), &["--record-messages"]);
    let legacy = service.state();
    assert_eq!(legacy.default_model.provider, "deepseek");
    assert_eq!(legacy.default_model.model_id, "deepseek-flash");
    assert!(legacy.key_configured);
    assert_eq!(legacy.configured_providers, ["deepseek"]);
    let catalog = service.model_catalog(None, 0).unwrap();
    assert!(
        catalog["providers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == "openai")
    );
    service
        .save_provider("openai".into(), "new-openai-key".into())
        .unwrap();
    assert_eq!(service.state().configured_providers, ["deepseek", "openai"]);
    assert_eq!(service.state().default_model.provider, "deepseek");
    service.submit(1, "W0_SLOW".into(), false).unwrap();
    wait(&service, |v| v.revision == 1 && !v.output.is_empty());
    let selection = lingo_sofa_app_services::ModelSelection {
        provider: "openai".into(),
        model_id: "w0-openai".into(),
    };
    service.select_model(selection.clone()).unwrap();
    assert!(!service.state().session_ready);
    assert!(service.state().output.is_empty());
    service
        .submit(2, "A new translation".into(), false)
        .unwrap();
    let done = wait(&service, |v| v.revision == 2 && v.phase == "ready");
    assert!(done.output.contains("沙发译文"));
    let request: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(directory.path().join("synthetic-messages.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(request["provider"], "openai");
    assert_eq!(request["model"], "w0-openai");
    assert!(
        service
            .save_provider("unknown-provider".into(), "unused-key".into())
            .is_err()
    );
    assert!(
        service
            .select_model(lingo_sofa_app_services::ModelSelection {
                model_id: "missing-model".into(),
                ..selection.clone()
            })
            .is_err()
    );
    assert_eq!(service.state().default_model, selection);
    service.shutdown();
    let service = start(directory.path());
    assert_eq!(service.state().default_model, selection);
    assert_eq!(service.state().configured_providers, ["deepseek", "openai"]);
    service
        .save_provider("deepseek".into(), String::new())
        .unwrap();
    assert!(service.state().key_configured);
    assert_eq!(service.state().configured_providers, ["openai"]);
    service
        .submit(3, "Still using OpenAI".into(), true)
        .unwrap();
    wait(&service, |v| v.revision == 3 && v.phase == "ready");
    service
        .save_provider("openai".into(), String::new())
        .unwrap();
    assert!(!service.state().key_configured);
    service.submit(4, "No credentials".into(), false).unwrap();
    wait(&service, |v| v.revision == 4 && v.phase == "error");
    assert_eq!(service.state().default_model, selection);
    service.shutdown();
    let vault = lingo_sofa_omp_client::vault::Vault::open(&vault_path).unwrap();
    assert!(vault.accounts().unwrap().is_empty());
    let public = serde_json::to_string(&service.state()).unwrap();
    for secret in ["legacy-deepseek-key", "new-openai-key", "unused-key"] {
        assert!(!public.contains(secret));
    }
}

#[test]
fn consecutive_preference_commands_merge_without_overwriting_unrelated_settings() {
    let directory = tempfile::tempdir().unwrap();
    let service = start(directory.path());
    service
        .patch_settings(lingo_sofa_app_services::SettingsPatch {
            target: Some("English".into()),
            pinned: None,
        })
        .unwrap();
    service
        .patch_settings(lingo_sofa_app_services::SettingsPatch {
            target: None,
            pinned: Some(false),
        })
        .unwrap();
    let state = wait(&service, |v| {
        v.settings.target == "English" && !v.settings.pinned
    });
    assert_eq!(state.default_model.provider, "deepseek");
    assert!(
        service
            .patch_settings(lingo_sofa_app_services::SettingsPatch::default())
            .is_err()
    );
    assert!(
        service
            .patch_settings(lingo_sofa_app_services::SettingsPatch {
                target: Some("unsupported".into()),
                pinned: None
            })
            .is_err()
    );
    service.shutdown();
    let service = start(directory.path());
    assert_eq!(service.state().settings.target, "English");
    assert!(!service.state().settings.pinned);
    let db = rusqlite::Connection::open(directory.path().join("settings.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_settings BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
    assert_eq!(
        service.patch_settings(lingo_sofa_app_services::SettingsPatch {
            target: Some("日本語".into()),
            pinned: None
        }),
        Err("settings_write_failed")
    );
    assert_eq!(service.state().settings.target, "English");
    service.shutdown();
}

#[test]
fn reset_stops_streaming_and_the_next_question_has_no_previous_source() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_options(directory.path(), &["--record-messages"]);
    service.save_key("synthetic-desktop-secret".into()).unwrap();
    wait(&service, |v| v.key_configured);
    service
        .submit(1, "W0_SLOW OLD_READING_SENTINEL".into(), false)
        .unwrap();
    let running = wait(&service, |v| v.revision == 1 && !v.output.is_empty());
    service.reset().unwrap();
    let cleared = wait(&service, |v| {
        !v.session_ready && v.output.is_empty() && v.task_id.is_none()
    });
    assert_eq!(cleared.phase, "ready");
    assert_eq!(cleared.default_model, running.default_model);
    assert_eq!(cleared.configured_providers, running.configured_providers);
    assert_eq!(cleared.settings.target, running.settings.target);
    assert_eq!(cleared.settings.pinned, running.settings.pinned);
    service
        .submit_new_question(2, "NEW_SESSION_SENTINEL".into())
        .unwrap();
    wait(&service, |v| {
        v.revision == 2 && v.phase == "ready" && v.task_id.is_none()
    });
    let messages =
        std::fs::read_to_string(directory.path().join("synthetic-messages.json")).unwrap();
    assert!(messages.contains("NEW_SESSION_SENTINEL"));
    assert!(!messages.contains("OLD_READING_SENTINEL"));
    assert!(!messages.contains("<source>"));
    service.shutdown();
}
