#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(windows)]
mod auto_selection;
mod clipboard_text;
mod external_links;
mod ocr;
mod shell;
mod shortcuts;
mod subscription;
mod updates;
mod window_drag;
use lingo_sofa_app_services::{
    LoginRequest, ModelSelection, Service, SessionRequest, Settings, SettingsPatch,
    TranslationDisplay,
};
use shell::{Mode, Shell};
use std::sync::Mutex;
use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::ShortcutState;
#[derive(serde::Serialize)]
struct DesktopSnapshot {
    #[serde(flatten)]
    state: shell::State,
    shortcuts: shortcuts::Snapshot,
    updates: updates::Snapshot,
}
fn allowed(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("window_not_allowed".into());
    }
    Ok(())
}
#[tauri::command]
fn drag_window(window: tauri::WebviewWindow) -> Result<(), String> {
    allowed(&window)?;
    window_drag::start(&window)
}
#[tauri::command]
fn desktop_state(
    window: tauri::WebviewWindow,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
    shortcuts: tauri::State<Mutex<shortcuts::Manager>>,
    updates: tauri::State<updates::Updates>,
) -> Result<DesktopSnapshot, String> {
    allowed(&window)?;
    Ok(DesktopSnapshot {
        state: shell.state(&service),
        shortcuts: shortcuts.lock().unwrap().snapshot(),
        updates: updates.snapshot(),
    })
}
#[tauri::command]
fn save_shortcuts(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shortcuts: tauri::State<Mutex<shortcuts::Manager>>,
    bindings: shortcuts::Bindings,
) -> Result<(), String> {
    allowed(&window)?;
    shortcuts
        .lock()
        .unwrap()
        .save(bindings, &shortcuts::AppRegistry(&app))
}
#[tauri::command]
fn set_mode(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    mode: Mode,
) -> Result<(), String> {
    allowed(&window)?;
    shell.mode(&app, mode);
    Ok(())
}
#[tauri::command]
fn resize_translation(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    epoch: u64,
    height: f64,
) -> Result<(), String> {
    allowed(&window)?;
    shell.resize_translation(&app, epoch, height);
    Ok(())
}
#[tauri::command]
fn back_reading(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
) -> Result<(), String> {
    allowed(&window)?;
    if matches!(
        shell.state(&service).desktop.mode,
        Mode::Ask | Mode::AskResult
    ) {
        let _ = service.cancel();
    }
    shell.back(&app);
    Ok(())
}
#[tauri::command]
fn capture_selection(
    display: Option<TranslationDisplay>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
) -> Result<(), String> {
    allowed(&window)?;
    shell.capture_display(app, service.inner().clone(), display);
    Ok(())
}
#[tauri::command]
async fn capture_ocr(
    display: Option<TranslationDisplay>,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<'_, Shell>,
    service: tauri::State<'_, Service>,
    state: tauri::State<'_, ocr::CaptureState>,
) -> Result<(), String> {
    allowed(&window)?;
    ocr::capture(
        app,
        shell.inner().clone(),
        service.inner().clone(),
        state.inner().clone(),
        display,
    )
    .await
}
fn clipboard(app: &tauri::AppHandle) -> Result<String, String> {
    let text = app
        .clipboard()
        .read_text()
        .map_err(|_| "clipboard_unavailable")?;
    lingo_sofa_core::validate_text(&text).map_err(String::from)?;
    Ok(text)
}
#[tauri::command]
fn translate_clipboard(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
) -> Result<(), String> {
    allowed(&window)?;
    shell
        .translate(&app, &service, clipboard(&app)?, "clipboard")
        .map_err(String::from)
}
#[tauri::command]
fn translate_text(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
    text: String,
) -> Result<(), String> {
    allowed(&window)?;
    shell
        .translate(&app, &service, text, "input")
        .map_err(String::from)
}
#[tauri::command]
fn ask_text(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
    text: String,
) -> Result<(), String> {
    allowed(&window)?;
    shell.ask_text(&app, &service, text).map_err(String::from)
}
#[tauri::command]
fn ask_question(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
    question: String,
) -> Result<(), String> {
    allowed(&window)?;
    shell.ask(&app, &service, question).map_err(String::from)
}
#[tauri::command]
async fn session_request(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<'_, Shell>,
    service: tauri::State<'_, Service>,
    request: SessionRequest,
) -> Result<serde_json::Value, String> {
    allowed(&window)?;
    let automatic = matches!(request, SessionRequest::Restore);
    let before = shell.state(&service).desktop;
    if automatic && before.mode != Mode::Idle {
        return Ok(serde_json::json!({}));
    }
    let restoring = matches!(
        request,
        SessionRequest::Resume { .. } | SessionRequest::Restore
    );
    let service = service.inner().clone();
    let worker_service = service.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || worker_service.session_request(request))
            .await
            .map_err(|_| "service_unavailable")?
            .map_err(String::from)?;
    let after = shell.state(&service).desktop;
    if restoring && (!automatic || (after.mode == Mode::Idle && after.epoch == before.epoch)) {
        shell.restore(&app, &service, &result);
    }
    Ok(result)
}
#[tauri::command]
fn clear_context(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
) -> Result<(), String> {
    allowed(&window)?;
    shell.clear(&app, &service).map_err(String::from)
}
#[tauri::command]
fn new_session(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
) -> Result<(), String> {
    allowed(&window)?;
    shell.new_session(&app, &service).map_err(String::from)
}
#[tauri::command]
async fn subscription_login(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Service>,
    request: LoginRequest,
) -> Result<serde_json::Value, String> {
    allowed(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.subscription_login(request))
        .await
        .map_err(|_| "service_unavailable".to_string())?
        .map_err(String::from)
}
#[tauri::command]
async fn open_login_url(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Service>,
    attempt: String,
) -> Result<(), String> {
    allowed(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = service
            .subscription_login(LoginRequest::Status { attempt })
            .map_err(String::from)?;
        if state["phase"] != "waiting" && state["phase"] != "prompt" {
            return Err("login_expired".into());
        }
        let url = state["url"].as_str().ok_or("login_url_missing")?;
        let parsed = tauri::Url::parse(url).map_err(|_| "login_url_invalid")?;
        if !subscription::login_url_allowed(&parsed) {
            return Err("login_url_invalid".into());
        }
        #[cfg(not(windows))]
        let status = std::process::Command::new("open")
            .arg("--")
            .arg(url)
            .status();
        #[cfg(windows)]
        let status = std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url])
            .status();
        status
            .map_err(|_| "browser_open_failed")?
            .success()
            .then_some(())
            .ok_or_else(|| "browser_open_failed".into())
    })
    .await
    .map_err(|_| "service_unavailable".to_string())?
}
#[tauri::command]
async fn model_catalog(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Service>,
    provider: Option<String>,
    offset: Option<usize>,
) -> Result<serde_json::Value, String> {
    allowed(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.model_catalog(provider, offset.unwrap_or(0))
    })
    .await
    .map_err(|_| "service_unavailable".to_string())?
    .map_err(String::from)
}
#[tauri::command]
async fn save_provider(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Service>,
    provider: String,
    key: String,
) -> Result<(), String> {
    allowed(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.save_provider(provider, key))
        .await
        .map_err(|_| "service_unavailable".to_string())?
        .map_err(String::from)
}
#[tauri::command]
async fn select_model(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Service>,
    model: ModelSelection,
) -> Result<(), String> {
    allowed(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.select_model(model))
        .await
        .map_err(|_| "service_unavailable".to_string())?
        .map_err(String::from)
}
#[tauri::command]
fn cancel_task(window: tauri::WebviewWindow, service: tauri::State<Service>) -> Result<(), String> {
    allowed(&window)?;
    service.cancel().map_err(String::from)
}
#[tauri::command]
fn compact_session(
    window: tauri::WebviewWindow,
    service: tauri::State<Service>,
) -> Result<(), String> {
    allowed(&window)?;
    service.compact().map_err(String::from)
}
#[tauri::command]
async fn save_settings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<'_, Shell>,
    service: tauri::State<'_, Service>,
    settings: Settings,
) -> Result<(), String> {
    allowed(&window)?;
    let service = service.inner().clone();
    let worker_service = service.clone();
    tauri::async_runtime::spawn_blocking(move || worker_service.settings(settings))
        .await
        .map_err(|_| "service_unavailable".to_string())?
        .map_err(String::from)?;
    shell.apply_pinning(&app);
    shell.sync_automatic(service.state().settings.auto_selection_translation);
    Ok(())
}
#[tauri::command]
async fn patch_settings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<'_, Shell>,
    service: tauri::State<'_, Service>,
    patch: SettingsPatch,
) -> Result<(), String> {
    allowed(&window)?;
    let service = service.inner().clone();
    let worker_service = service.clone();
    tauri::async_runtime::spawn_blocking(move || worker_service.patch_settings(patch))
        .await
        .map_err(|_| "service_unavailable".to_string())?
        .map_err(String::from)?;
    shell.apply_pinning(&app);
    shell.sync_automatic(service.state().settings.auto_selection_translation);
    Ok(())
}
#[tauri::command]
fn copy_result(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
) -> Result<(), String> {
    allowed(&window)?;
    let state = shell.state(&service);
    let text = if matches!(state.desktop.mode, Mode::AskResult) {
        if state.model.revision != state.desktop.model_revision {
            return Err("result_not_ready".into());
        }
        state.model.output
    } else {
        state.desktop.translation
    };
    app.clipboard()
        .write_text(text)
        .map_err(|_| "clipboard_write_failed".into())
}
#[tauri::command]
fn copy_text(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    text: String,
) -> Result<(), String> {
    allowed(&window)?;
    clipboard_text::validate(&text).map_err(String::from)?;
    app.clipboard()
        .write_text(text)
        .map_err(|_| "clipboard_write_failed".into())
}
#[tauri::command]
fn collapse(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
) -> Result<(), String> {
    allowed(&window)?;
    let _ = service.cancel();
    shell.mode(&app, Mode::Idle);
    Ok(())
}
fn executable(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}
fn resource(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|_| "resource_unavailable")?
        .join("runtime")
        .join(name);
    let path = if bundled.is_file() {
        bundled
    } else {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(name)
    };
    if !path.is_file() {
        return Err("Run build:worker before launching desktop".into());
    }
    Ok(path)
}
#[tauri::command]
async fn check_updates(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    updates: tauri::State<'_, updates::Updates>,
) -> Result<(), String> {
    allowed(&window)?;
    updates.check(&app, false).await;
    Ok(())
}
#[tauri::command]
async fn download_update(
    window: tauri::WebviewWindow,
    updates: tauri::State<'_, updates::Updates>,
) -> Result<(), String> {
    allowed(&window)?;
    updates.download().await;
    Ok(())
}
#[tauri::command]
async fn install_update(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    updates: tauri::State<'_, updates::Updates>,
) -> Result<(), String> {
    allowed(&window)?;
    updates.install(&app)
}
#[tauri::command]
fn set_auto_update(
    window: tauri::WebviewWindow,
    updates: tauri::State<updates::Updates>,
    enabled: bool,
) -> Result<(), String> {
    allowed(&window)?;
    updates.set_auto(enabled)
}
fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .manage(ocr::CaptureState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(shell) = app.try_state::<Shell>() {
                shell.mode(app, Mode::Input);
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let shell = app.state::<Shell>();
                    let service = app.state::<Service>();
                    let action = app
                        .state::<Mutex<shortcuts::Manager>>()
                        .lock()
                        .unwrap()
                        .action(shortcut);
                    let capturing = app.state::<ocr::CaptureState>().active();
                    if action.is_some() {
                        app.state::<ocr::CaptureState>().cancel();
                    }
                    if capturing
                        && matches!(
                            action,
                            Some(shortcuts::Action::Ocr | shortcuts::Action::OcrAlternate)
                        )
                    {
                        return;
                    }
                    match action {
                        Some(shortcuts::Action::Input) => {
                            // Repeated activation while typing must retain the current draft.
                            if shell.state(&service).desktop.mode != Mode::Input {
                                shell.mode(app, Mode::Input);
                            } else if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        Some(shortcuts::Action::Selection) => {
                            shell.capture(app.clone(), service.inner().clone())
                        }
                        Some(shortcuts::Action::SelectionAlternate) => {
                            shell.capture_display(
                                app.clone(),
                                service.inner().clone(),
                                Some(service.state().settings.translation_display.alternate()),
                            );
                        }
                        Some(shortcuts::Action::Ocr | shortcuts::Action::OcrAlternate) => {
                            let display = if action == Some(shortcuts::Action::OcrAlternate) {
                                Some(service.state().settings.translation_display.alternate())
                            } else {
                                None
                            };
                            let app = app.clone();
                            let shell = shell.inner().clone();
                            let service = service.inner().clone();
                            let state = app.state::<ocr::CaptureState>().inner().clone();
                            tauri::async_runtime::spawn(async move {
                                if let Err(error) = ocr::capture(
                                    app.clone(),
                                    shell.clone(),
                                    service,
                                    state,
                                    display,
                                )
                                .await
                                {
                                    shell.failure(&app, &error);
                                }
                            });
                        }
                        Some(shortcuts::Action::Clipboard) => match clipboard(app) {
                            Ok(text) => {
                                let _ = shell.translate(app, &service, text, "clipboard");
                            }
                            Err(_) => shell.mode(app, Mode::Input),
                        },
                        None => {}
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            drag_window,
            desktop_state,
            check_updates,
            download_update,
            install_update,
            set_auto_update,
            set_mode,
            resize_translation,
            back_reading,
            capture_selection,
            capture_ocr,
            translate_clipboard,
            translate_text,
            ask_text,
            ask_question,
            session_request,
            clear_context,
            new_session,
            model_catalog,
            subscription_login,
            open_login_url,
            external_links::open_external_url,
            subscription::open_login_browser,
            save_provider,
            select_model,
            cancel_task,
            compact_session,
            save_settings,
            patch_settings,
            save_shortcuts,
            copy_result,
            copy_text,
            collapse
        ])
        .setup(|app| {
            #[cfg(windows)]
            let data = std::path::PathBuf::from(
                std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA missing")?,
            )
            .join("LingoSofa");
            #[cfg(target_os = "macos")]
            let data = std::path::PathBuf::from(std::env::var_os("HOME").ok_or("HOME missing")?)
                .join("Library/Application Support/LingoSofa");
            let service = Service::start(
                data.clone(),
                resource(app.handle(), &executable("omp-worker"))?,
            )?;
            let shortcuts = shortcuts::Manager::open(&data.join("shortcuts.sqlite"))?;
            app.manage(Mutex::new(shortcuts));
            let shell = Shell::new(resource(app.handle(), &executable("selection-helper"))?);
            app.manage(updates::Updates::open(
                &data.join("updates.sqlite"),
                &app.package_info().version.to_string(),
            )?);
            app.manage(service);
            app.manage(shell);
            app.state::<Mutex<shortcuts::Manager>>()
                .lock()
                .unwrap()
                .initialize(&shortcuts::AppRegistry(app.handle()));
            let open = MenuItem::with_id(app, "open", "输入翻译", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &settings, &quit])?;
            TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!(
                    "../icons/icon.png"
                ))?)
                .tooltip("LingoSofa · 输入、选区与剪贴板翻译 · 快捷键可在设置中修改")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    let shell = app.state::<Shell>();
                    match event.id.as_ref() {
                        "open" => shell.mode(app, Mode::Input),
                        "settings" => shell.mode(app, Mode::Settings),
                        "quit" => {
                            app.state::<ocr::CaptureState>().cancel();
                            shell.shutdown();
                            app.state::<Service>().shutdown();
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            #[cfg(windows)]
            app.state::<Shell>()
                .start_automatic(app.handle().clone(), app.state::<Service>().inner().clone());
            app.state::<Shell>().position(app.handle());
            updates::schedule(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle();
                let _ = app.state::<Service>().cancel();
                if let Some(shell) = app.try_state::<Shell>() {
                    shell.mode(app, Mode::Idle);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize LingoSofa")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                app.state::<ocr::CaptureState>().cancel();
                app.state::<Shell>().shutdown();
                app.state::<Service>().shutdown();
            }
        });
}
