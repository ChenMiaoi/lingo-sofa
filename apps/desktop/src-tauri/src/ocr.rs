#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::CaptureState;
#[cfg(not(target_os = "macos"))]
#[derive(Clone, Default)]
pub struct CaptureState {
    _unsupported: (),
}
#[cfg(not(target_os = "macos"))]
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
    #[cfg(target_os = "macos")]
    {
        macos::capture(app, shell, service, state, display).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, shell, service, state, display);
        Err("ocr_unsupported".into())
    }
}
