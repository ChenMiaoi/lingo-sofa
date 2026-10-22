use lingo_sofa_app_services::TranslationDisplay;
use lingo_sofa_core::overlay::Rect;
#[cfg(target_os = "macos")]
use std::{fs, path::PathBuf};
use std::{
    io::Read,
    path::Path,
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
#[cfg(target_os = "macos")]
use tempfile::TempDir;

#[cfg(target_os = "macos")]
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
    #[cfg(target_os = "macos")]
    directory: Mutex<Option<TempDir>>,
    output: Mutex<Vec<u8>>,
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
        #[cfg(target_os = "macos")]
        use std::os::unix::fs::PermissionsExt;
        let mut active = self.0.lock().unwrap();
        if active.is_some() {
            return Err("ocr_busy");
        }
        #[cfg(target_os = "macos")]
        let directory = {
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
            Some(directory)
        };
        #[cfg(windows)]
        let _ = root;
        let job = Arc::new(Job {
            cancelled: AtomicBool::new(false),
            child: Mutex::new(None),
            #[cfg(target_os = "macos")]
            directory: Mutex::new(directory),
            output: Mutex::new(Vec::new()),
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
            #[cfg(target_os = "macos")]
            unsafe {
                kill(-(child.id() as i32), 9);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        // Stop the reader/writer before removing the private temporary images.
        #[cfg(target_os = "macos")]
        self.directory.lock().unwrap().take();
    }
    fn run(
        &self,
        command: &mut Command,
        timeout: Duration,
    ) -> Result<std::process::ExitStatus, &'static str> {
        let mut reader;
        #[cfg(windows)]
        let _process_job;
        {
            let mut child = self.child.lock().unwrap();
            if self.cancelled.load(Ordering::SeqCst) {
                return Err("ocr_cancelled");
            }
            #[cfg(target_os = "macos")]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0);
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            *child = Some(
                command
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|_| "ocr_capture_failed")?,
            );
            #[cfg(windows)]
            {
                _process_job = match lingo_sofa_omp_client::Job::attach(child.as_ref().unwrap()) {
                    Ok(job) => job,
                    Err(_) => {
                        if let Some(mut process) = child.take() {
                            let _ = process.kill();
                            let _ = process.wait();
                        }
                        return Err("ocr_capture_failed");
                    }
                };
            }
            reader = child
                .as_mut()
                .and_then(|child| child.stdout.take())
                .map(|stdout| {
                    std::thread::spawn(move || {
                        let mut bytes = Vec::new();
                        let _ = stdout.take(100_001).read_to_end(&mut bytes);
                        bytes
                    })
                });
        }
        let deadline = Instant::now() + timeout;
        let outcome = loop {
            if self.cancelled.load(Ordering::SeqCst) {
                break Err("ocr_cancelled");
            }
            let status = {
                let mut child = self.child.lock().unwrap();
                match child.as_mut() {
                    Some(process) => match process.try_wait() {
                        Ok(Some(status)) => {
                            child.take();
                            Ok(Some(status))
                        }
                        Ok(None) => Ok(None),
                        Err(_) => Err("ocr_failed"),
                    },
                    None => Err("ocr_cancelled"),
                }
            };
            match status {
                Ok(Some(status)) => break Ok(status),
                Err(error) => break Err(error),
                Ok(None) => {}
            }
            if Instant::now() >= deadline {
                break Err("ocr_timeout");
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        if outcome.is_err() {
            self.cancel();
        }
        // Close the Windows job before joining: descendants cannot keep stdout open.
        #[cfg(windows)]
        drop(_process_job);
        if let Some(reader) = reader.take() {
            let bytes = reader.join().map_err(|_| "ocr_failed")?;
            if outcome.is_ok() {
                *self.output.lock().unwrap() = bytes;
            }
        }
        outcome
    }

    #[cfg(target_os = "macos")]
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
    #[cfg(windows)]
    fn recognize(&self, helper: &Path) -> Result<Option<RecognizedRegion>, &'static str> {
        let status = self.run(
            Command::new(helper).arg("--capture").stdout(Stdio::piped()),
            Duration::from_secs(112),
        )?;
        if !status.success() {
            return Err("ocr_failed");
        }
        let bytes = self.output.lock().unwrap();
        if bytes.len() > 100_000 {
            return Err("ocr_failed");
        }
        let result: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| "ocr_failed")?;
        if result["cancelled"] == true {
            return Ok(None);
        }
        if let Some(error) = result["error"].as_str() {
            return Err(match error {
                "ocr_os_unsupported" => "ocr_os_unsupported",
                "ocr_resource_invalid" => "ocr_resource_invalid",
                "ocr_runtime_unavailable" => "ocr_runtime_unavailable",
                "ocr_model_invalid" => "ocr_model_invalid",
                "ocr_empty" => "ocr_empty",
                "ocr_timeout" => "ocr_timeout",
                "ocr_image_too_large" => "ocr_image_too_large",
                "ocr_cross_screen" => "ocr_cross_screen",
                "ocr_text_too_long" => "ocr_text_too_long",
                _ => "ocr_failed",
            });
        }
        let text = result["text"]
            .as_str()
            .filter(|text| {
                !text.trim().is_empty() && text.len() <= 15000 && text.chars().count() <= 5000
            })
            .ok_or("ocr_failed")?;
        let bounds: Rect =
            serde_json::from_value(result["bounds"].clone()).map_err(|_| "ocr_failed")?;
        if !bounds.valid() || self.cancelled.load(Ordering::SeqCst) {
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
    #[cfg(target_os = "macos")]
    let selector = crate::resource(&app, "region-selector")?;
    let helper = crate::resource(&app, &crate::executable("ocr-helper"))?;
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|_| "ocr_capture_failed")?
        .join("ocr");
    let guard = state.begin(&root)?;
    // A click or /ocr explicitly requests permission; never prompt at startup.
    #[cfg(target_os = "macos")]
    if !unsafe { CGPreflightScreenCaptureAccess() } && !unsafe { CGRequestScreenCaptureAccess() } {
        return Err("ocr_screen_permission_required".into());
    }
    let before = shell.state(&service).desktop;
    let window = app.get_webview_window("main").ok_or("window_unavailable")?;
    window.hide().map_err(|_| "ocr_capture_failed")?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let result = guard.job.recognize(&helper, &selector);
        #[cfg(windows)]
        let result = guard.job.recognize(&helper);
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

#[cfg(all(test, target_os = "macos"))]
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
        #[cfg(target_os = "macos")]
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

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    #[test]
    fn cancel_and_timeout_reap_helpers_and_reject_late_results() {
        let state = CaptureState::default();
        let guard = state.begin(Path::new("unused")).unwrap();
        assert!(matches!(state.begin(Path::new("unused")), Err("ocr_busy")));
        let job = guard.job.clone();
        let worker = std::thread::spawn(move || {
            job.run(
                Command::new("powershell.exe")
                    .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 5"])
                    .stdout(Stdio::piped()),
                Duration::from_secs(10),
            )
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while guard.job.child.lock().unwrap().is_none() {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        state.cancel();
        assert_eq!(worker.join().unwrap(), Err("ocr_cancelled"));
        assert!(guard.job.child.lock().unwrap().is_none());
        assert_eq!(
            guard.job.recognize(Path::new("unused")).err(),
            Some("ocr_cancelled")
        );
        drop(guard);
        assert!(!state.active());
        let guard = state.begin(Path::new("unused")).unwrap();
        assert_eq!(
            guard.job.run(
                Command::new("powershell.exe").args([
                    "-NoProfile",
                    "-Command",
                    "Start-Sleep -Seconds 5"
                ]),
                Duration::from_millis(40)
            ),
            Err("ocr_timeout")
        );
        assert!(guard.job.child.lock().unwrap().is_none());
    }
}
