#[cfg(windows)]
mod capture_windows;
#[cfg(windows)]
mod paddle;
#[cfg(target_os = "macos")]
mod vision;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::validate_dimensions;
fn main() {
    #[cfg(windows)]
    let response = if std::env::args().nth(1).as_deref() == Some("--capture") {
        match capture_windows::capture().and_then(|(image, bounds)| {
            windows::with_deadline(|| windows::recognize_image(image)).map(|text| (text, bounds))
        }) {
            Ok((text, bounds)) => serde_json::json!({"text":text,"bounds":bounds}),
            Err("ocr_cancelled") => serde_json::json!({"cancelled":true}),
            Err(error) => serde_json::json!({"error":error}),
        }
    } else if std::env::args().nth(1).as_deref() == Some("--self-test") {
        response(windows::with_deadline(|| {
            capture_windows::self_test(false).and_then(windows::recognize_image)
        }))
    } else if std::env::args().nth(1).as_deref() == Some("--self-test-blank") {
        response(windows::with_deadline(|| {
            capture_windows::self_test(true).and_then(windows::recognize_image)
        }))
    } else {
        response(recognize())
    };
    #[cfg(not(windows))]
    let response = response(recognize());
    println!("{response}");
}
fn response(result: Result<String, &str>) -> serde_json::Value {
    match result {
        Ok(text) => serde_json::json!({"text":text}),
        Err(error) => serde_json::json!({"error":error}),
    }
}
fn recognize() -> Result<String, &'static str> {
    #[cfg(any(target_os = "macos", windows))]
    match std::env::args_os().skip(1).collect::<Vec<_>>().as_slice() {
        [image] => {
            #[cfg(target_os = "macos")]
            {
                vision::recognize(std::path::Path::new(image))
            }
            #[cfg(windows)]
            {
                windows::with_deadline(|| windows::recognize(std::path::Path::new(image)))
            }
        }
        _ => Err("ocr_invalid_image"),
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    Err("ocr_unsupported")
}
