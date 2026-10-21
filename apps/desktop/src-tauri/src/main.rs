#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod shell;
mod shortcuts;
use lingo_sofa_app_services::{ModelSelection, Service, Settings, SettingsPatch};
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
}
fn allowed(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("window_not_allowed".into());
    }
    Ok(())
}
#[tauri::command]
fn desktop_state(
    window: tauri::WebviewWindow,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
    shortcuts: tauri::State<Mutex<shortcuts::Manager>>,
) -> Result<DesktopSnapshot, String> {
    allowed(&window)?;
    Ok(DesktopSnapshot {
        state: shell.state(&service),
        shortcuts: shortcuts.lock().unwrap().snapshot(),
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
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    shell: tauri::State<Shell>,
    service: tauri::State<Service>,
) -> Result<(), String> {
    allowed(&window)?;
    shell.capture(app, service.inner().clone());
    Ok(())
}
fn clipboard(app: &tauri::AppHandle) -> Result<String, String> {
    let text = app
        .clipboard()
        .read_text()
        .map_err(|_| "clipboard_unavailable")?;
    if text.trim().is_empty() || text.len() > 15000 {
        return Err("invalid_text".into());
    }
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
fn save_settings(
    window: tauri::WebviewWindow,
    service: tauri::State<Service>,
    settings: Settings,
) -> Result<(), String> {
    allowed(&window)?;
    service.settings(settings).map_err(String::from)
}
#[tauri::command]
async fn patch_settings(
    window: tauri::WebviewWindow,
    service: tauri::State<'_, Service>,
    patch: SettingsPatch,
) -> Result<(), String> {
    allowed(&window)?;
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || service.patch_settings(patch))
        .await
        .map_err(|_| "service_unavailable".to_string())?
        .map_err(String::from)
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
        .map_err(|_| "clipboard_unavailable".into())
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
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(shell) = app.try_state::<Shell>() {
                shell.mode(app, Mode::Input);
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
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
            desktop_state,
            set_mode,
            back_reading,
            capture_selection,
            translate_clipboard,
            translate_text,
            ask_text,
            ask_question,
            clear_context,
            new_session,
            model_catalog,
            save_provider,
            select_model,
            cancel_task,
            compact_session,
            save_settings,
            patch_settings,
            save_shortcuts,
            copy_result,
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
                            shell.shutdown();
                            app.state::<Service>().shutdown();
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            app.state::<Shell>().position(app.handle());
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
                app.state::<Shell>().shutdown();
                app.state::<Service>().shutdown();
            }
        });
}
