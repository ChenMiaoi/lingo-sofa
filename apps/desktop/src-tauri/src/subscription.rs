use lingo_sofa_app_services::{LoginRequest, Service};
use std::time::{Duration, Instant};
use tauri::Manager;

pub fn login_url_allowed(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && !matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]") | None
        )
}

/// The cookie never enters the main WebView: only Rust returns it to the SDK
/// prompt over the private worker pipe. This window has an isolated cookie jar.
#[tauri::command]
pub async fn open_login_browser(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    service: tauri::State<'_, Service>,
    attempt: String,
    prompt: u64,
) -> Result<(), String> {
    super::allowed(&window)?;
    let service = service.inner().clone();
    let lookup = service.clone();
    let id = attempt.clone();
    let state = tauri::async_runtime::spawn_blocking(move || {
        lookup.subscription_login(LoginRequest::Status { attempt: id })
    })
    .await
    .map_err(|_| "service_unavailable")?
    .map_err(String::from)?;
    if state["phase"] != "prompt" || state["prompt"]["id"] != prompt {
        return Err("login_expired".into());
    }
    let session = &state["prompt"]["browser"];
    let url = tauri::Url::parse(session["url"].as_str().ok_or("login_url_missing")?)
        .map_err(|_| "login_url_invalid")?;
    if !login_url_allowed(&url) {
        return Err("login_url_invalid".into());
    }
    let names: Vec<String> = session["cookieNames"]
        .as_array()
        .ok_or("invalid_login_input")?
        .iter()
        .filter_map(|name| name.as_str().map(String::from))
        .collect();
    if names.is_empty() || names.len() > 8 || names.iter().any(|name| name.len() > 128) {
        return Err("invalid_login_input".into());
    }
    let label = format!("subscription-login-{attempt}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    let browser =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url.clone()))
            .title("订阅账户登录")
            .inner_size(760.0, 680.0)
            .incognito(true)
            .on_navigation(|url| login_url_allowed(url) || url.as_str() == "about:blank")
            .build()
            .map_err(|_| "browser_open_failed")?;
    tauri::async_runtime::spawn_blocking(move || {
        let deadline = Instant::now() + Duration::from_secs(600);
        let result = (|| -> Result<(), String> {
            while Instant::now() < deadline {
                let state = service
                    .subscription_login(LoginRequest::Status {
                        attempt: attempt.clone(),
                    })
                    .map_err(String::from)?;
                if state["phase"] != "prompt" || state["prompt"]["id"] != prompt {
                    return Err("login_expired".into());
                }
                if app.get_webview_window(&label).is_none() {
                    return Err("login_cancelled".into());
                }
                let cookies = browser
                    .cookies_for_url(url.clone())
                    .map_err(|_| "browser_cookie_unavailable")?;
                for name in &names {
                    if let Some(cookie) = cookies
                        .iter()
                        .find(|cookie| cookie.name() == name && !cookie.value().is_empty())
                    {
                        service
                            .subscription_login(LoginRequest::Input {
                                attempt: attempt.clone(),
                                prompt,
                                value: cookie.value().to_owned(),
                            })
                            .map_err(String::from)?;
                        return Ok(());
                    }
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            Err("login_expired".into())
        })();
        let _ = browser.close();
        if result.is_err() {
            let _ = service.subscription_login(LoginRequest::Cancel { attempt });
        }
        result
    })
    .await
    .map_err(|_| "service_unavailable".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sdk_authorization_urls_require_https_and_no_embedded_credentials() {
        for value in [
            "https://auth.openai.com/oauth/authorize",
            "https://accounts.google.com/o/oauth2/auth",
            "https://auth.kimi.com/device",
            "https://www.perplexity.ai/auth/signin",
        ] {
            assert!(login_url_allowed(&tauri::Url::parse(value).unwrap()));
        }
        for value in [
            "file:///tmp/credentials",
            "http://localhost:1455",
            "https://user:password@example.com",
            "https://127.0.0.1/",
        ] {
            assert!(!login_url_allowed(&tauri::Url::parse(value).unwrap()));
        }
    }
}
