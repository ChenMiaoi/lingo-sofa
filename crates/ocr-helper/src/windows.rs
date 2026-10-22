pub use crate::paddle::validate_dimensions;
use image::RgbImage;
use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    time::Duration,
};
fn resources() -> Result<PathBuf, &'static str> {
    let bundled = std::env::current_exe()
        .map_err(|_| "ocr_resource_invalid")?
        .parent()
        .ok_or("ocr_resource_invalid")?
        .join("ocr");
    if bundled.is_dir() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        Ok(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../apps/desktop/src-tauri/resources/ocr"),
        )
    }
    #[cfg(not(debug_assertions))]
    Err("ocr_resource_invalid")
}
// A process watchdog also covers DLL/session loading and resource checks, which
// RunOptions cannot interrupt. The normal path does not publish until it joins.
pub fn with_deadline(
    operation: impl FnOnce() -> Result<String, &'static str>,
) -> Result<String, &'static str> {
    with_timeout(Duration::from_secs(20), operation)
}
fn with_timeout(
    duration: Duration,
    operation: impl FnOnce() -> Result<String, &'static str>,
) -> Result<String, &'static str> {
    let (done, receiver) = mpsc::channel();
    let watchdog = std::thread::spawn(move || {
        if matches!(
            receiver.recv_timeout(duration),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            println!("{}", serde_json::json!({"error":"ocr_timeout"}));
            std::process::exit(0);
        }
    });
    let result = operation();
    let _ = done.send(());
    let _ = watchdog.join();
    result
}
pub fn recognize_image(image: RgbImage) -> Result<String, &'static str> {
    crate::paddle::recognize(image, &resources()?)
}
pub fn recognize(path: &Path) -> Result<String, &'static str> {
    if std::fs::metadata(path)
        .map_err(|_| "ocr_invalid_image")?
        .len()
        > 64 * 1024 * 1024
    {
        return Err("ocr_image_too_large");
    }
    let reader = image::ImageReader::open(path)
        .map_err(|_| "ocr_invalid_image")?
        .with_guessed_format()
        .map_err(|_| "ocr_invalid_image")?;
    let (width, height) = reader.into_dimensions().map_err(|_| "ocr_invalid_image")?;
    validate_dimensions(width, height)?;
    let mut reader = image::ImageReader::open(path)
        .map_err(|_| "ocr_invalid_image")?
        .with_guessed_format()
        .map_err(|_| "ocr_invalid_image")?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    recognize_image(reader.decode().map_err(|_| "ocr_invalid_image")?.to_rgb8())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn watchdog_child() {
        if std::env::var_os("LINGOSOFA_OCR_WATCHDOG_TEST").is_some() {
            let _ = with_timeout(Duration::from_millis(40), || {
                std::thread::sleep(Duration::from_secs(5));
                Ok("late".into())
            });
        }
    }
    #[test]
    fn overall_watchdog_finishes_uninterruptible_initialization_with_one_response() {
        let start = std::time::Instant::now();
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "windows::tests::watchdog_child", "--nocapture"])
            .env("LINGOSOFA_OCR_WATCHDOG_TEST", "1")
            .output()
            .unwrap();
        assert!(out.status.success());
        let text = String::from_utf8(out.stdout).unwrap();
        let responses = text
            .lines()
            .filter(|line| line.starts_with('{'))
            .collect::<Vec<_>>();
        assert_eq!(responses.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(responses[0]).unwrap()["error"],
            "ocr_timeout"
        );
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
