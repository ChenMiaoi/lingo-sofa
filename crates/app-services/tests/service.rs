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
        startup_timeout: Duration::from_secs(30),
    })
    .unwrap()
}
fn wait(service: &Service, predicate: impl Fn(&View) -> bool) -> View {
    // Source fixtures load the SDK before business behavior can be observed.
    let deadline = Instant::now() + Duration::from_secs(45);
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
fn cold_start_keeps_preferences_without_loading_history_and_explicit_resume_remains_available() {
    let directory = tempfile::tempdir().unwrap();
    let service = start_options(directory.path(), &["--record-messages"]);
    service.save_key("synthetic-desktop-secret".into()).unwrap();
    wait(&service, |v| v.key_configured);
    service
        .submit_with_context(
            1,
            "OLD_READING_SENTINEL".into(),
            false,
            true,
            serde_json::json!({"context":{"text":"OLD_SOURCE_SENTINEL","origin":"Fixture","kind":"selection","anchor":null,"anchorValid":false}}),
        )
        .unwrap();
    let previous = wait(&service, |v| {
        v.revision == 1 && v.phase == "ready" && v.task_id.is_none()
    });
    let old_id = previous.session_id.unwrap();
    service
        .patch_settings(lingo_sofa_app_services::SettingsPatch {
            target: Some("English".into()),
            ..Default::default()
        })
        .unwrap();
    service.shutdown();

    let service = start_options(directory.path(), &["--record-messages"]);
    let cold = service.state();
    assert!(cold.key_configured);
    assert_eq!(cold.default_model, previous.default_model);
    assert_eq!(cold.settings.target, "English");
    assert!(cold.session_id.is_none());
    assert!(!cold.session_ready);
    assert!(cold.output.is_empty() && cold.question.is_empty() && cold.messages.is_empty());
    service
        .submit_new_question(1, "INDEPENDENT_QUESTION_SENTINEL".into())
        .unwrap();
    wait(&service, |v| {
        v.revision == 1 && v.phase == "ready" && v.task_id.is_none()
    });
    let messages =
        std::fs::read_to_string(directory.path().join("synthetic-messages.json")).unwrap();
    assert!(messages.contains("INDEPENDENT_QUESTION_SENTINEL"));
    assert!(!messages.contains("OLD_READING_SENTINEL"));
    assert!(!messages.contains("OLD_SOURCE_SENTINEL"));
    assert!(!messages.contains("<source>"));
    let restored = service
        .session_request(lingo_sofa_app_services::SessionRequest::Resume { id: old_id.clone() })
        .unwrap();
    assert_eq!(
        restored["metadata"]["context"]["text"],
        "OLD_SOURCE_SENTINEL"
    );
    assert_eq!(service.state().session_id.as_deref(), Some(old_id.as_str()));
    assert!(!service.state().messages.is_empty());
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
            ..Settings::default()
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
            translation_display: Some(lingo_sofa_app_services::TranslationDisplay::Panel),
            ..Default::default()
        })
        .unwrap();
    service
        .patch_settings(lingo_sofa_app_services::SettingsPatch {
            target: Some("English".into()),
            pinned: None,
            ..Default::default()
        })
        .unwrap();
    service
        .patch_settings(lingo_sofa_app_services::SettingsPatch {
            target: None,
            pinned: Some(false),
            ..Default::default()
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
                pinned: None,
                ..Default::default()
            })
            .is_err()
    );
    service.shutdown();
    let service = start(directory.path());
    assert_eq!(service.state().settings.target, "English");
    assert!(!service.state().settings.pinned);
    assert_eq!(
        service.state().settings.translation_display,
        lingo_sofa_app_services::TranslationDisplay::Panel
    );
    let db = rusqlite::Connection::open(directory.path().join("settings.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_settings BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
    let phase = service.state().phase;
    assert_eq!(
        service.patch_settings(lingo_sofa_app_services::SettingsPatch {
            target: Some("日本語".into()),
            pinned: None,
            ..Default::default()
        }),
        Err("settings_write_failed")
    );
    assert_eq!(service.state().settings.target, "English");
    assert_eq!(service.state().phase, phase);
    assert_eq!(
        service.settings(Settings {
            target: "한국어".into(),
            pinned: true,
            ..Settings::default()
        }),
        Err("settings_write_failed")
    );
    assert_eq!(service.state().settings.target, "English");
    assert!(!service.state().settings.pinned);
    assert_eq!(service.state().phase, phase);
    db.execute_batch("DROP TRIGGER reject_settings").unwrap();
    service
        .settings(Settings {
            target: "日本語".into(),
            pinned: true,
            ..Settings::default()
        })
        .unwrap();
    // Success acknowledges the committed value without another polling cycle.
    assert_eq!(service.state().settings.target, "日本語");
    service.shutdown();
}

#[test]
fn automatic_selection_preference_defaults_off_persists_and_failed_save_keeps_previous_value() {
    let directory = tempfile::tempdir().unwrap();
    let db = rusqlite::Connection::open(directory.path().join("settings.sqlite")).unwrap();
    db.execute_batch(
        r#"CREATE TABLE settings(id INTEGER PRIMARY KEY,body TEXT NOT NULL);
        INSERT INTO settings VALUES(1,'{"target":"English","pinned":false}');"#,
    )
    .unwrap();
    let service = start(directory.path());
    assert!(!service.state().settings.auto_selection_translation);
    service
        .patch_settings(lingo_sofa_app_services::SettingsPatch {
            auto_selection_translation: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert!(service.state().settings.auto_selection_translation);
    service.shutdown();
    let service = start(directory.path());
    assert!(service.state().settings.auto_selection_translation);
    assert_eq!(service.state().settings.target, "English");
    db.execute_batch("CREATE TRIGGER reject_auto BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
    assert_eq!(
        service.patch_settings(lingo_sofa_app_services::SettingsPatch {
            auto_selection_translation: Some(false),
            ..Default::default()
        }),
        Err("settings_write_failed")
    );
    assert!(service.state().settings.auto_selection_translation);
    db.execute_batch("DROP TRIGGER reject_auto").unwrap();
    service
        .patch_settings(lingo_sofa_app_services::SettingsPatch {
            auto_selection_translation: Some(false),
            ..Default::default()
        })
        .unwrap();
    service.shutdown();
    let service = start(directory.path());
    assert!(!service.state().settings.auto_selection_translation);
    service.shutdown();
}

#[test]
fn automatic_requests_never_replace_busy_manual_work_or_dispatch_disabled_and_stale_probes() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let directory = tempfile::tempdir().unwrap();
    let service = start(directory.path());
    service.save_key("synthetic-desktop-secret".into()).unwrap();
    let token = || Arc::new(AtomicBool::new(true));
    assert!(
        !service
            .submit_automatic_translation(1, "disabled".into(), serde_json::json!({}), token())
            .unwrap()
    );
    assert_eq!(service.state().revision, 0);
    service
        .patch_settings(lingo_sofa_app_services::SettingsPatch {
            auto_selection_translation: Some(true),
            ..Default::default()
        })
        .unwrap();
    let stale = token();
    stale.store(false, Ordering::SeqCst);
    assert!(
        !service
            .submit_automatic_translation(
                1,
                "late disabled probe".into(),
                serde_json::json!({}),
                stale
            )
            .unwrap()
    );
    assert_eq!(service.state().revision, 0);
    service
        .submit(1, "W0_SLOW manual request".into(), true)
        .unwrap();
    // Wait for the asynchronous manual admission before checking busy priority;
    // a cold SDK startup can legitimately outlast automatic admission's deadline.
    let view = wait(&service, |v| v.revision == 1 && v.phase == "running");
    assert!(
        !service
            .submit_automatic_translation(
                2,
                "background must not cancel manual".into(),
                serde_json::json!({}),
                token()
            )
            .unwrap()
    );
    let manual_id = view.task_id;
    service.cancel_automatic_translation(0).unwrap();
    // A synchronous settings acknowledgement drains the preceding cancel command.
    service
        .patch_settings(lingo_sofa_app_services::SettingsPatch {
            pinned: Some(false),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(service.state().task_id, manual_id);
    assert_eq!(service.state().revision, 1);
    service.cancel().unwrap();
    wait(&service, |v| v.task_id.is_none() && v.phase != "running");
    assert!(
        service
            .submit_automatic_translation(
                3,
                "new automatic selection".into(),
                serde_json::json!({}),
                token()
            )
            .unwrap()
    );
    wait(&service, |v| {
        v.revision == 3 && v.phase == "ready" && v.task_id.is_none()
    });
    let running_permit = token();
    assert!(
        service
            .submit_automatic_translation(
                4,
                "W0_SLOW automatic accepted".into(),
                serde_json::json!({}),
                running_permit.clone()
            )
            .unwrap()
    );
    let running = wait(&service, |v| v.revision == 4 && v.phase == "running");
    running_permit.store(false, Ordering::SeqCst);
    service
        .patch_settings(lingo_sofa_app_services::SettingsPatch {
            auto_selection_translation: Some(false),
            ..Default::default()
        })
        .unwrap();
    // Disabling detection or beginning another gesture does not cancel paid work already admitted.
    assert_eq!(service.state().task_id, running.task_id);
    assert_eq!(service.state().revision, 4);
    assert!(
        !service
            .submit_automatic_translation(5, "off again".into(), serde_json::json!({}), token())
            .unwrap()
    );
    assert_eq!(service.state().revision, 4);
    service.cancel().unwrap();
    service.shutdown();
}

#[test]
fn chinese_questions_accept_the_shared_budget_and_oversized_input_preserves_the_session() {
    let directory = tempfile::tempdir().unwrap();
    let service = start(directory.path());
    service.save_key("synthetic-desktop-secret".into()).unwrap();
    let question = "问".repeat(1500);
    service.submit_new_question(1, question.clone()).unwrap();
    let done = wait(&service, |v| {
        v.revision == 1 && v.phase == "ready" && v.task_id.is_none()
    });
    assert_eq!(done.question, question);
    let session = done.session_id;
    for (text, error) in [
        ("问".repeat(5001), "text_too_long"),
        (" \n".into(), "invalid_text"),
    ] {
        assert_eq!(service.submit(2, text, true), Err(error));
        assert_eq!(service.state().revision, 1);
        assert_eq!(service.state().session_id, session);
    }
    service.submit(2, "继".repeat(1500), true).unwrap();
    wait(&service, |v| {
        v.revision == 2 && v.phase == "ready" && v.task_id.is_none()
    });
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

#[test]
fn subscription_authorization_preserves_existing_accounts_and_encrypts_completed_grants() {
    use lingo_sofa_app_services::LoginRequest;
    let directory = tempfile::tempdir().unwrap();
    let service = start(directory.path());
    service.save_key("synthetic-desktop-secret".into()).unwrap();
    let original = service.state().default_model;
    let providers = service.subscription_login(LoginRequest::Providers).unwrap();
    assert_eq!(providers["providers"][0]["id"], "test-subscription");
    assert!(
        service
            .subscription_login(LoginRequest::Start {
                provider: "unknown-provider".into()
            })
            .is_err()
    );
    let attempt = service
        .subscription_login(LoginRequest::Start {
            provider: "test-subscription".into(),
        })
        .unwrap();
    let id = attempt["attempt"].as_str().unwrap().to_owned();
    let cancelled = service
        .subscription_login(LoginRequest::Cancel { attempt: id })
        .unwrap();
    assert_eq!(cancelled["phase"], "cancelled");
    assert_eq!(service.state().configured_providers, ["deepseek"]);
    let attempt = service
        .subscription_login(LoginRequest::Start {
            provider: "test-subscription".into(),
        })
        .unwrap();
    let id = attempt["attempt"].as_str().unwrap().to_owned();
    service
        .subscription_login(LoginRequest::Input {
            attempt: id.clone(),
            prompt: 1,
            value: "synthetic-authorization-code".into(),
        })
        .unwrap();
    let completed = service
        .subscription_login(LoginRequest::Status { attempt: id })
        .unwrap();
    assert_eq!(completed["phase"], "complete");
    assert_eq!(service.state().configured_providers, ["deepseek", "openai"]);
    assert_eq!(service.state().default_model, original);
    assert!(
        !serde_json::to_string(&completed)
            .unwrap()
            .contains("synthetic-subscription-access")
    );
    service
        .select_model(lingo_sofa_app_services::ModelSelection {
            provider: "openai".into(),
            model_id: "w0-openai".into(),
        })
        .unwrap();
    service.shutdown();
    let bytes = std::fs::read(directory.path().join("credentials.sqlite")).unwrap();
    for secret in [
        b"synthetic-subscription-access".as_slice(),
        b"synthetic-subscription-refresh".as_slice(),
    ] {
        assert!(!bytes.windows(secret.len()).any(|part| part == secret));
    }
    let restored = start(directory.path());
    assert_eq!(
        restored.state().configured_providers,
        ["deepseek", "openai"]
    );
    assert_eq!(restored.state().default_model.provider, "openai");
    restored.shutdown();
}

#[test]
fn omp_history_survives_new_and_restart_and_restores_complete_followup_context() {
    use lingo_sofa_app_services::SessionRequest;
    let directory = tempfile::tempdir().unwrap();
    let service = start_options(directory.path(), &["--record-messages"]);
    service.save_key("synthetic-desktop-secret".into()).unwrap();
    service.submit_with_context(1, "HISTORY_QUESTION_SENTINEL".into(), true, true,
        serde_json::json!({"context":{"text":"FROZEN_SOURCE","origin":"Fixture","kind":"input","anchor":null,"anchorValid":false}})).unwrap();
    let original = wait(&service, |v| {
        v.revision == 1 && v.phase == "ready" && v.session_ready
    });
    let id = original.session_id.unwrap();
    assert_eq!(original.question, "HISTORY_QUESTION_SENTINEL");
    service.reset().unwrap();
    wait(&service, |v| !v.session_ready && v.output.is_empty());
    let list = service
        .session_request(SessionRequest::List {
            offset: 0,
            query: String::new(),
            snapshot: None,
        })
        .unwrap();
    assert!(
        list["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == id)
    );
    service
        .submit_new_question(2, "UNRELATED_NEW_QUESTION".into())
        .unwrap();
    wait(&service, |v| v.revision == 2 && v.phase == "ready");
    let opened = service
        .session_request(SessionRequest::Resume { id: id.clone() })
        .unwrap();
    assert_eq!(opened["metadata"]["context"]["text"], "FROZEN_SOURCE");
    assert_eq!(service.state().question, "HISTORY_QUESTION_SENTINEL");
    assert!(
        serde_json::to_string(&service.state().messages)
            .unwrap()
            .contains("HISTORY_QUESTION_SENTINEL")
    );
    service
        .submit(3, "FOLLOWUP_AFTER_RESTORE".into(), true)
        .unwrap();
    wait(&service, |v| v.revision == 3 && v.phase == "ready");
    assert_eq!(service.state().question, "FOLLOWUP_AFTER_RESTORE");
    let sent = std::fs::read_to_string(directory.path().join("synthetic-messages.json")).unwrap();
    assert!(sent.contains("HISTORY_QUESTION_SENTINEL"));
    assert!(sent.contains("FOLLOWUP_AFTER_RESTORE"));
    assert!(!sent.contains("UNRELATED_NEW_QUESTION"));
    service.shutdown();
    let restored = start(directory.path());
    restored.session_request(SessionRequest::Restore).unwrap();
    assert_eq!(restored.state().session_id.as_deref(), Some(id.as_str()));
    assert!(restored.state().session_ready);
    assert!(
        restored
            .session_request(SessionRequest::Resume {
                id: "../credentials.sqlite".into()
            })
            .is_err()
    );
    restored.shutdown();
}

#[test]
fn a_failed_resume_does_not_break_the_next_question() {
    use lingo_sofa_app_services::SessionRequest;
    let directory = tempfile::tempdir().unwrap();
    let service = start(directory.path());
    service
        .save_provider("openai".into(), "synthetic-desktop-secret".into())
        .unwrap();
    service
        .select_model(lingo_sofa_app_services::ModelSelection {
            provider: "openai".into(),
            model_id: "w0-openai".into(),
        })
        .unwrap();
    service
        .submit_new_question(1, "First question".into())
        .unwrap();
    let original = wait(&service, |v| v.revision == 1 && v.phase == "ready");
    let id = original.session_id.unwrap();
    assert!(
        service
            .session_request(SessionRequest::Resume {
                id: "missing-session".into(),
            })
            .is_err()
    );
    assert!(!service.state().session_ready);
    service
        .submit(2, "Question after failed resume".into(), true)
        .unwrap();
    let recovered = wait(&service, |v| {
        v.revision == 2 && (v.phase == "ready" || v.phase == "error")
    });
    assert_eq!(recovered.phase, "ready", "{}", recovered.message);
    assert!(recovered.session_ready);
    service
        .session_request(SessionRequest::Resume { id })
        .unwrap();
    assert!(service.state().session_ready);
    service.shutdown();
}

#[test]
fn tool_execution_waits_for_each_decision_and_records_reasoning_and_results() {
    use lingo_sofa_app_services::SessionRequest;
    let directory = tempfile::tempdir().unwrap();
    let service = start_options(directory.path(), &["--tool-fixture"]);
    service.save_key("synthetic-desktop-secret".into()).unwrap();
    service
        .session_request(SessionRequest::Configure {
            thinking: Some("high".into()),
            tools: None,
        })
        .unwrap();
    service
        .session_request(SessionRequest::Configure {
            thinking: None,
            tools: Some(true),
        })
        .unwrap();
    assert_eq!(service.state().thinking, "high");
    for (revision, approved) in [(1, false), (2, true), (3, true)] {
        if directory.path().join("approved-tool.txt").exists() {
            std::fs::remove_file(directory.path().join("approved-tool.txt")).unwrap();
        }
        service
            .submit_new_question(
                revision,
                if revision == 3 {
                    "W0_TOOL_REQUEST W0_TOOL_LONG".into()
                } else {
                    "W0_TOOL_REQUEST".into()
                },
            )
            .unwrap();
        let approval = wait(&service, |v| !v.tool_approvals.is_empty());
        assert!(!directory.path().join("approved-tool.txt").exists());
        if revision == 3 {
            assert!(
                approval.tool_approvals[0]["args"]
                    .as_str()
                    .unwrap()
                    .contains("REVIEW_END")
            );
        }
        let id = approval.tool_approvals[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        service
            .session_request(SessionRequest::Decision {
                id: id.clone(),
                approved,
            })
            .unwrap();
        let done = wait(&service, |v| {
            v.revision == revision && v.phase == "ready" && v.task_id.is_none()
        });
        assert!(done.tool_approvals.is_empty());
        assert!(done.thinking_output.contains("Visible fixture reasoning"));
        if approved {
            assert_eq!(
                std::fs::read_to_string(directory.path().join("approved-tool.txt")).unwrap(),
                if revision == 3 {
                    "x".repeat(4500) + "REVIEW_END"
                } else {
                    "APPROVED_TOOL".into()
                }
            );
            assert!(!done.tool_calls.is_empty());
        } else {
            assert!(!directory.path().join("approved-tool.txt").exists());
        }
        assert!(
            service
                .session_request(SessionRequest::Decision { id, approved: true })
                .is_err()
        );
    }
    let session_id = service.state().session_id.clone().unwrap();
    let read_activity = |service: &lingo_sofa_app_services::Service| {
        let mut offset = 0;
        let mut version = None;
        let mut text = String::new();
        loop {
            let page = service
                .session_request(SessionRequest::Activity {
                    id: session_id.clone(),
                    offset,
                    version: version.clone(),
                })
                .unwrap();
            text.push_str(page["chunk"].as_str().unwrap());
            version = Some(page["version"].as_str().unwrap().to_owned());
            match page["next"].as_u64() {
                Some(next) => offset = next as usize,
                None => break,
            }
        }
        text
    };
    let before = read_activity(&service);
    assert!(before.contains("Visible fixture reasoning"));
    assert!(before.contains("REVIEW_END"));
    service.shutdown();
    std::fs::remove_file(directory.path().join("approved-tool.txt")).unwrap();
    let restored = start_options(directory.path(), &["--tool-fixture"]);
    restored.session_request(SessionRequest::Restore).unwrap();
    assert_eq!(read_activity(&restored), before);
    assert!(!directory.path().join("approved-tool.txt").exists());
    restored
        .session_request(SessionRequest::Resume {
            id: session_id.clone(),
        })
        .unwrap();
    assert_eq!(read_activity(&restored), before);
    assert!(!directory.path().join("approved-tool.txt").exists());
    assert!(
        restored
            .session_request(SessionRequest::Activity {
                id: "wrong-session".into(),
                offset: 0,
                version: None
            })
            .is_err()
    );
    restored.shutdown();
}

#[test]
fn truncated_translation_and_ask_preserve_output_and_end_busy_state() {
    let dir = tempfile::tempdir().unwrap();
    let service = start(dir.path());
    service.save_key("synthetic-secret".into()).unwrap();
    for (revision, ask) in [(1, false), (2, true)] {
        service.submit(revision, "W0_LENGTH".into(), ask).unwrap();
        let view = wait(&service, |v| {
            v.revision == revision && v.phase == "truncated"
        });
        assert!(view.output.contains("沙发译文"));
        assert!(view.message.contains("输出达到上限"));
        assert!(view.task_id.is_none());
        assert!(view.reported_tokens > 0);
    }
    service.shutdown();
}
#[test]
fn failed_model_switch_keeps_running_task_cancellable() {
    let dir = tempfile::tempdir().unwrap();
    let service = start(dir.path());
    service.save_key("synthetic-secret".into()).unwrap();
    service.submit(1, "W0_SLOW".into(), false).unwrap();
    let before = wait(&service, |v| v.phase == "running" && !v.output.is_empty());
    assert_eq!(
        service.select_model(lingo_sofa_app_services::ModelSelection {
            provider: "openai".into(),
            model_id: "missing".into()
        }),
        Err("account_required")
    );
    assert_eq!(
        service.select_model(lingo_sofa_app_services::ModelSelection {
            provider: "deepseek".into(),
            model_id: "missing-model".into()
        }),
        Err("model_not_verified")
    );
    let db = rusqlite::Connection::open(dir.path().join("settings.sqlite")).unwrap();
    db.execute_batch("CREATE TRIGGER reject_model BEFORE INSERT ON default_model BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
    assert_eq!(
        service.select_model(before.default_model.clone()),
        Err("settings_write_failed")
    );
    db.execute_batch("DROP TRIGGER reject_model").unwrap();
    let after = service.state();
    assert_eq!(after.phase, "running");
    assert_eq!(after.task_id, before.task_id);
    service.cancel().unwrap();
    let cancelled = wait(&service, |v| v.task_id.is_none() && v.phase == "ready");
    assert!(cancelled.message.contains("已取消"));
    service.shutdown();
}

#[test]
fn sdk_http_errors_cross_ipc_with_recoverable_safe_messages() {
    let dir = tempfile::tempdir().unwrap();
    let service = start(dir.path());
    service.save_key("synthetic-secret".into()).unwrap();
    for (revision, status, expected) in [
        (1, 401, "检查凭证"),
        (2, 429, "稍后重试"),
        (3, 413, "上下文过长"),
        (4, 404, "切换模型"),
        (5, 400, "上下文过长"),
    ] {
        service
            .submit_new_question(revision, format!("W0_HTTP_{status}"))
            .unwrap();
        let view = wait(&service, |v| {
            v.revision == revision && v.phase == "error" && v.task_id.is_none()
        });
        assert!(view.message.contains(expected), "{}", view.message);
        assert!(!view.message.contains("PRIVATE_PROVIDER_RESPONSE"));
        assert!(
            !serde_json::to_string(&view)
                .unwrap()
                .contains("synthetic-secret")
        );
    }
    service.shutdown();
}
