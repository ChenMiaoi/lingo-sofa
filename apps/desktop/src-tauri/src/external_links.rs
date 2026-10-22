fn web_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value).map_err(|_| "external_url_invalid")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("external_url_invalid".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn open_external_url(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    super::allowed(&window)?;
    let url = web_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        let status = std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url.as_str()])
            .status();
        #[cfg(not(windows))]
        let status = std::process::Command::new("open")
            .arg("--")
            .arg(url.as_str())
            .status();
        status
            .map_err(|_| "browser_open_failed")?
            .success()
            .then_some(())
            .ok_or_else(|| "browser_open_failed".into())
    })
    .await
    .map_err(|_| "browser_open_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_navigation_accepts_only_web_links_without_credentials() {
        for url in ["https://example.com/docs?q=a&b=c", "http://localhost:3000/"] {
            assert!(web_url(url).is_ok());
        }
        for url in [
            "javascript:alert(1)",
            "file:///C:/test",
            "mailto:a@example.com",
            "/relative",
            "https://user:secret@example.com",
        ] {
            assert!(web_url(url).is_err());
        }
    }
}
