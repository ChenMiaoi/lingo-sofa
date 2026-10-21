use lingo_sofa_app_services::TranslationDisplay;
use lingo_sofa_core::overlay::Rect;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::Manager;
struct RecognizedRegion {
    text: String,
    bounds: Rect,
}
use tempfile::TempDir;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn kill(pid: i32, signal: i32) -> i32;
}

#[derive(Clone, Default)]
pub struct CaptureState(Arc<Mutex<Option<Arc<Job>>>>);
struct Job {
    cancelled: AtomicBool,
    child: Mutex<Option<Child>>,
    directory: Mutex<Option<TempDir>>,
}
struct Guard {
    state: CaptureState,
    job: Arc<Job>,
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.job.cancel();
        let mut active = self.state.0.lock().unwrap();
        if active
            .as_ref()
            .is_some_and(|job| Arc::ptr_eq(job, &self.job))
        {
            *active = None;
        }
    }
}
impl CaptureState {
    fn begin(&self, root: &Path) -> Result<Guard, &'static str> {
        use std::os::unix::fs::PermissionsExt;
        let mut active = self.0.lock().unwrap();
        if active.is_some() {
            return Err("ocr_busy");
        }
        fs::create_dir_all(root).map_err(|_| "ocr_capture_failed")?;
        // Only this application's private, interrupted capture jobs are swept.
        for entry in fs::read_dir(root)
            .map_err(|_| "ocr_capture_failed")?
            .flatten()
        {
            if entry.file_name().to_string_lossy().starts_with("capture-")
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
            {
                fs::remove_dir_all(entry.path()).map_err(|_| "ocr_capture_failed")?;
            }
        }
        let directory = tempfile::Builder::new()
            .prefix("capture-")
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir_in(root)
            .map_err(|_| "ocr_capture_failed")?;
        let job = Arc::new(Job {
            cancelled: AtomicBool::new(false),
            child: Mutex::new(None),
            directory: Mutex::new(Some(directory)),
        });
        *active = Some(job.clone());
        Ok(Guard {
            state: self.clone(),
            job,
        })
    }
    pub fn active(&self) -> bool {
        self.0.lock().unwrap().is_some()
    }
    pub fn cancel(&self) {
        if let Some(job) = self.0.lock().unwrap().as_ref() {
            job.cancel();
        }
    }
}
impl Job {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().unwrap().take() {
            // Region selection may have a short-lived screenshot child too.
            unsafe {
                kill(-(child.id() as i32), 9);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        // Stop the reader/writer before removing the private temporary images.
        self.directory.lock().unwrap().take();
    }
    fn run(
        &self,
        command: &mut Command,
        timeout: Duration,
    ) -> Result<std::process::ExitStatus, &'static str> {
        {
            let mut child = self.child.lock().unwrap();
            if self.cancelled.load(Ordering::SeqCst) {
                return Err("ocr_cancelled");
            }
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            *child = Some(
                command
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|_| "ocr_capture_failed")?,
            );
        }
        let deadline = Instant::now() + timeout;
        loop {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err("ocr_cancelled");
            }
            {
                let mut child = self.child.lock().unwrap();
                let process = child.as_mut().ok_or("ocr_cancelled")?;
                if let Some(status) = process.try_wait().map_err(|_| "ocr_failed")? {
                    child.take();
                    return Ok(status);
                }
            }
            if Instant::now() >= deadline {
                self.cancel();
                return Err("ocr_timeout");
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    fn recognize(
        &self,
        helper: &Path,
        selector: &Path,
    ) -> Result<Option<RecognizedRegion>, &'static str> {
        let root: PathBuf = self
            .directory
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("ocr_cancelled")?
            .path()
            .into();
        let image = root.join("region.png");
        use std::os::unix::fs::OpenOptionsExt;
        let selected = root.join("selection.json");
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&selected)
            .map_err(|_| "ocr_failed")?;
        let status = self.run(
            Command::new(selector).arg(&image).stdout(file),
            Duration::from_secs(90),
        )?;
        if !status.success() {
            return Err("ocr_capture_failed");
        }
        let selection: serde_json::Value =
            serde_json::from_slice(&fs::read(selected).map_err(|_| "ocr_capture_failed")?)
                .map_err(|_| "ocr_capture_failed")?;
        if selection["cancelled"] == true {
            return Ok(None);
        }
        if selection["error"] == "ocr_image_too_large" {
            return Err("ocr_image_too_large");
        }
        let bounds: Rect = serde_json::from_value(selection["bounds"].clone())
            .map_err(|_| "ocr_capture_failed")?;
        if !bounds.valid() || !image.is_file() {
            return Err("ocr_capture_failed");
        }
        let output = root.join("result.json");
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&output)
            .map_err(|_| "ocr_failed")?;
        let status = self.run(
            Command::new(helper).arg(&image).stdout(file),
            Duration::from_secs(20),
        )?;
        if !status.success() {
            return Err("ocr_failed");
        }
        let mut bytes = Vec::new();
        fs::File::open(output)
            .map_err(|_| "ocr_failed")?
            .take(100_001)
            .read_to_end(&mut bytes)
            .map_err(|_| "ocr_failed")?;
        if bytes.len() > 100_000 {
            return Err("ocr_failed");
        }
        let result: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "ocr_failed")?;
        match result["error"].as_str() {
            Some("ocr_os_unsupported") => return Err("ocr_os_unsupported"),
            Some("ocr_empty") => return Err("ocr_empty"),
            Some("ocr_image_too_large") => return Err("ocr_image_too_large"),
            Some("ocr_text_too_long") => return Err("ocr_text_too_long"),
            Some(_) => return Err("ocr_failed"),
            None => {}
        }
        let text = result["text"]
            .as_str()
            .filter(|text| !text.trim().is_empty() && text.len() <= 15000)
            .ok_or("ocr_failed")?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("ocr_cancelled");
        }
        Ok(Some(RecognizedRegion {
            text: text.into(),
            bounds,
        }))
    }
}

pub async fn capture(
    app: tauri::AppHandle,
    shell: crate::shell::Shell,
    service: lingo_sofa_app_services::Service,
    state: CaptureState,
    display: Option<TranslationDisplay>,
) -> Result<(), String> {
    let model = service.state();
    if model.task_id.is_some()
        || matches!(model.phase.as_str(), "preparing" | "running" | "compacting")
    {
        return Err("task_running".into());
    }
    let display = display.unwrap_or(model.settings.translation_display);
    let selector = crate::resource(&app, "region-selector")?;
    let helper = crate::resource(&app, "ocr-helper")?;
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| "ocr_capture_failed")?
        .join("ocr");
    let guard = state.begin(&root)?;
    // A click or /ocr explicitly requests permission; never prompt at startup.
    if !unsafe { CGPreflightScreenCaptureAccess() } && !unsafe { CGRequestScreenCaptureAccess() } {
        return Err("ocr_screen_permission_required".into());
    }
    let before = shell.state(&service).desktop;
    let window = app.get_webview_window("main").ok_or("window_unavailable")?;
    window.hide().map_err(|_| "ocr_capture_failed")?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let result = guard.job.recognize(&helper, &selector);
        let result = if guard.job.cancelled.load(Ordering::SeqCst) {
            Err("ocr_cancelled")
        } else {
            result
        };
        drop(guard);
        result
    })
    .await
    .map_err(|_| "ocr_failed");
    let after = shell.state(&service).desktop;
    if after.epoch == before.epoch && after.mode == before.mode {
        if let Ok(Ok(Some(region))) = &result {
            shell.ocr_translate(
                &app,
                &service,
                region.text.clone(),
                region.bounds,
                display,
                before.epoch,
            )?;
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    match result? {
        Ok(_) | Err("ocr_cancelled") => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelling_kills_capture_and_removes_private_files_without_reusing_results() {
        let root = tempfile::tempdir().unwrap();
        let state = CaptureState::default();
        let guard = state.begin(root.path()).unwrap();
        let directory = guard
            .job
            .directory
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .path()
            .to_owned();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        fs::write(directory.join("region.png"), b"private fixture").unwrap();
        assert!(matches!(state.begin(root.path()), Err("ocr_busy")));
        let job = guard.job.clone();
        let reader = std::thread::spawn(move || {
            job.run(Command::new("/bin/sleep").arg("5"), Duration::from_secs(10))
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while guard.job.child.lock().unwrap().is_none() {
            assert!(Instant::now() < deadline, "capture process did not start");
            std::thread::sleep(Duration::from_millis(5));
        }
        state.cancel();
        assert_eq!(reader.join().unwrap(), Err("ocr_cancelled"));
        assert!(guard.job.child.lock().unwrap().is_none());
        assert!(!directory.exists());
        assert_eq!(
            guard
                .job
                .run(&mut Command::new("/usr/bin/true"), Duration::from_secs(1)),
            Err("ocr_cancelled")
        );
        drop(guard);
        assert!(state.begin(root.path()).is_ok());
    }
    #[test]
    fn timeout_reaps_the_child_and_discards_the_capture() {
        let root = tempfile::tempdir().unwrap();
        let state = CaptureState::default();
        let guard = state.begin(root.path()).unwrap();
        let result = guard.job.run(
            Command::new("/bin/sleep").arg("5"),
            Duration::from_millis(40),
        );
        assert_eq!(result, Err("ocr_timeout"));
        assert!(guard.job.child.lock().unwrap().is_none());
        assert!(guard.job.directory.lock().unwrap().is_none());
    }
    #[test]
    fn restarting_capture_removes_only_its_own_interrupted_workspace() {
        let root = tempfile::tempdir().unwrap();
        let stale = root.path().join("capture-interrupted");
        let unrelated = root.path().join("other");
        fs::create_dir(&stale).unwrap();
        fs::create_dir(&unrelated).unwrap();
        fs::write(stale.join("region.png"), b"private fixture").unwrap();
        let state = CaptureState::default();
        let _guard = state.begin(root.path()).unwrap();
        assert!(!stale.exists());
        assert!(unrelated.exists());
    }
}
