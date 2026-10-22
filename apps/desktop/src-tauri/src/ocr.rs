#[cfg(any(target_os = "macos", windows))]
mod native;
#[cfg(any(target_os = "macos", windows))]
pub use native::CaptureState;
#[cfg(not(any(target_os = "macos", windows)))]
#[derive(Clone, Default)]
pub struct CaptureState {
    _unsupported: (),
}
#[cfg(not(any(target_os = "macos", windows)))]
impl CaptureState {
    pub fn active(&self) -> bool {
        false
    }
    pub fn cancel(&self) {}
}

pub async fn capture(
    app: tauri::AppHandle,
    shell: crate::shell::Shell,
    service: lingo_sofa_app_services::Service,
    state: CaptureState,
    display: Option<lingo_sofa_app_services::TranslationDisplay>,
) -> Result<(), String> {
    #[cfg(any(target_os = "macos", windows))]
    {
        native::capture(app, shell, service, state, display).await
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (app, shell, service, state, display);
        Err("ocr_unsupported".into())
    }
}
