#[cfg(target_os = "macos")]
mod vision;

fn main() {
    #[cfg(target_os = "macos")]
    let result = match std::env::args_os().skip(1).collect::<Vec<_>>().as_slice() {
        [image] => vision::recognize(std::path::Path::new(image)),
        _ => Err("ocr_invalid_image"),
    };
    #[cfg(not(target_os = "macos"))]
    let result: Result<String, &str> = Err("ocr_unsupported");
    let response = match result {
        Ok(text) => serde_json::json!({"text":text}),
        Err(error) => serde_json::json!({"error":error}),
    };
    println!("{response}");
}
