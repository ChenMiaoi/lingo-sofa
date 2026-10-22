use rusqlite::Connection;
use serde::Serialize;
use std::{
    path::Path,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const ENDPOINT: &str =
    "https://github.com/ChenMiaoi/lingo-sofa/releases/latest/download/latest.json";
const INTERVAL: u64 = 6 * 60 * 60;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    current_version: String,
    auto_check: bool,
    phase: String,
    available_version: Option<String>,
    notes: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    last_checked: Option<u64>,
    error: Option<String>,
}
struct Inner {
    view: Snapshot,
    candidate: Option<Update>,
    bytes: Option<Vec<u8>>,
    next_check: u64,
}
pub struct Updates {
    inner: Mutex<Inner>,
    db: Mutex<Connection>,
}
fn busy(phase: &str) -> bool {
    matches!(phase, "checking" | "downloading" | "ready" | "installing")
}
impl Updates {
    pub fn open(path: &Path, version: &str) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY CHECK(id=1), auto_check INTEGER NOT NULL); INSERT OR IGNORE INTO updates VALUES(1,1);")?;
        let auto_check = db.query_row("SELECT auto_check FROM updates WHERE id=1", [], |row| {
            row.get(0)
        })?;
        Ok(Self {
            inner: Mutex::new(Inner {
                view: Snapshot {
                    current_version: version.into(),
                    auto_check,
                    phase: "idle".into(),
                    available_version: None,
                    notes: None,
                    downloaded: 0,
                    total: None,
                    last_checked: None,
                    error: None,
                },
                candidate: None,
                bytes: None,
                next_check: 0,
            }),
            db: Mutex::new(db),
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        self.inner.lock().unwrap().view.clone()
    }
    fn begin_check(&self, automatic: bool, time: u64) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if busy(&inner.view.phase)
            || (automatic && (!inner.view.auto_check || time < inner.next_check))
        {
            return false;
        }
        inner.view.phase = "checking".into();
        inner.view.error = None;
        inner.next_check = time + INTERVAL;
        true
    }
    pub fn set_auto(&self, enabled: bool) -> Result<(), String> {
        self.db
            .lock()
            .unwrap()
            .execute("UPDATE updates SET auto_check=?1 WHERE id=1", [enabled])
            .map_err(|_| "settings_write_failed".to_string())?;
        self.inner.lock().unwrap().view.auto_check = enabled;
        Ok(())
    }
    fn fail(&self, code: &str, fallback: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.view.phase = fallback.into();
        inner.view.error = Some(code.into());
    }
    pub async fn check(&self, app: &AppHandle, automatic: bool) {
        if !self.begin_check(automatic, now()) {
            return;
        }
        let result = async {
            let metadata = fetch_metadata(ENDPOINT).await?;
            let Some(metadata) = metadata else {
                return Ok(None);
            };
            let candidate = app
                .updater_builder()
                .on_before_exit({
                    let app = app.clone();
                    move || {
                        app.state::<crate::shell::Shell>().shutdown();
                        // Keep the actor usable if launching the Windows installer fails.
                        let _ = app.state::<lingo_sofa_app_services::Service>().reset();
                        app.cleanup_before_exit();
                    }
                })
                .build()
                .map_err(|_| "metadata")?
                .restore_update(metadata)
                .map_err(|_| "metadata")?;
            if candidate
                .as_ref()
                .is_some_and(|update| update.download_url.scheme() != "https")
            {
                return Err("metadata");
            }
            Ok::<_, &'static str>(Some(candidate))
        }
        .await;
        let mut inner = self.inner.lock().unwrap();
        inner.view.last_checked = Some(now());
        match result {
            Ok(candidate) => {
                let no_release = candidate.is_none();
                inner.candidate = candidate.flatten();
                inner.bytes = None;
                inner.view.available_version = inner
                    .candidate
                    .as_ref()
                    .map(|update| update.version.clone());
                inner.view.notes = inner
                    .candidate
                    .as_ref()
                    .and_then(|update| update.body.clone());
                inner.view.phase = if inner.candidate.is_some() {
                    "available"
                } else if no_release {
                    "no-release"
                } else {
                    "up-to-date"
                }
                .into();
            }
            Err(code) => {
                inner.view.phase = "error".into();
                inner.view.error = Some(code.into());
            }
        }
    }
    pub async fn download(&self) {
        let candidate = {
            let mut inner = self.inner.lock().unwrap();
            if inner.view.phase != "available" {
                return;
            }
            let Some(mut candidate) = inner.candidate.clone() else {
                return;
            };
            if cfg!(debug_assertions) {
                inner.view.error = Some("development".into());
                return;
            }
            candidate.timeout = Some(Duration::from_secs(300));
            inner.view.phase = "downloading".into();
            inner.view.error = None;
            inner.view.downloaded = 0;
            inner.view.total = None;
            candidate
        };
        match candidate
            .download(
                |size, total| {
                    let mut inner = self.inner.lock().unwrap();
                    inner.view.downloaded = inner.view.downloaded.saturating_add(size as u64);
                    inner.view.total = total;
                },
                || {},
            )
            .await
        {
            Ok(bytes) => {
                let mut inner = self.inner.lock().unwrap();
                inner.bytes = Some(bytes);
                inner.view.phase = "ready".into();
            }
            Err(_) => self.fail("download", "available"),
        }
    }
    pub fn install(&self, app: &AppHandle) -> Result<(), String> {
        if matches!(
            app.state::<lingo_sofa_app_services::Service>()
                .state()
                .phase
                .as_str(),
            "preparing" | "running" | "compacting"
        ) {
            return Err("update_task_active".into());
        }
        let (candidate, bytes) = {
            let mut inner = self.inner.lock().unwrap();
            if inner.view.phase != "ready" {
                return Ok(());
            }
            let Some(candidate) = inner.candidate.clone() else {
                return Ok(());
            };
            let Some(bytes) = inner.bytes.take() else {
                return Ok(());
            };
            inner.view.phase = "installing".into();
            (candidate, bytes)
        };
        if candidate.install(&bytes).is_err() {
            let mut inner = self.inner.lock().unwrap();
            inner.bytes = Some(bytes);
            inner.view.phase = "ready".into();
            inner.view.error = Some("install".into());
            return Ok(());
        }
        app.state::<crate::shell::Shell>().shutdown();
        app.state::<lingo_sofa_app_services::Service>().shutdown();
        app.restart();
    }
}
async fn fetch_metadata(endpoint: &str) -> Result<Option<serde_json::Value>, &'static str> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .https_only(!cfg!(test))
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("LingoSofa/", env!("CARGO_PKG_VERSION")));
    #[cfg(test)]
    let client = client.no_proxy();
    let client = client.build().map_err(|_| "network")?;
    let response = client.get(endpoint).send().await.map_err(|_| "network")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let response = response.error_for_status().map_err(|_| "network")?;
    if response
        .content_length()
        .is_some_and(|size| size > 1024 * 1024)
    {
        return Err("metadata");
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "network")? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("metadata");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "metadata")
}
pub fn schedule(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            app.state::<Updates>().check(&app, true).await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preferences_persist_and_automatic_checks_respect_cadence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("updates.sqlite");
        let updates = Updates::open(&path, "0.1.0").unwrap();
        assert!(updates.snapshot().auto_check);
        updates.set_auto(false).unwrap();
        assert!(!Updates::open(&path, "0.1.0").unwrap().snapshot().auto_check);
        assert!(!updates.begin_check(true, 100));
        assert!(updates.begin_check(false, 100));
        assert!(!updates.begin_check(false, 101));
        updates.fail("network", "error");
        updates.set_auto(true).unwrap();
        assert!(!updates.begin_check(true, 101));
        assert!(updates.begin_check(true, 100 + INTERVAL));
    }
    #[test]
    fn failed_preference_write_keeps_the_previous_setting() {
        let dir = tempfile::tempdir().unwrap();
        let updates = Updates::open(&dir.path().join("updates.sqlite"), "0.1.0").unwrap();
        updates.db.lock().unwrap().execute_batch("CREATE TRIGGER reject_write BEFORE UPDATE ON updates BEGIN SELECT RAISE(ABORT, 'readonly'); END;").unwrap();
        assert_eq!(updates.set_auto(false), Err("settings_write_failed".into()));
        assert!(updates.snapshot().auto_check);
    }
    #[test]
    fn ready_download_and_install_block_rechecks() {
        let dir = tempfile::tempdir().unwrap();
        let updates = Updates::open(&dir.path().join("updates.sqlite"), "0.1.0").unwrap();
        for phase in ["downloading", "ready", "installing"] {
            updates.inner.lock().unwrap().view.phase = phase.into();
            assert!(!updates.begin_check(false, 100));
            assert!(!updates.begin_check(true, 100));
        }
    }
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn read_request_headers(input: &mut impl Read) -> Vec<u8> {
        let mut request = Vec::new();
        let mut chunk = [0; 1024];
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let length = input.read(&mut chunk).unwrap();
            assert!(length > 0, "incomplete metadata fixture request");
            request.extend_from_slice(&chunk[..length]);
            assert!(
                request.len() <= 16 * 1024,
                "oversized metadata fixture request"
            );
        }
        request
    }
    #[test]
    fn fixture_waits_for_all_fragmented_request_headers() {
        struct Fragmented(std::io::Cursor<Vec<u8>>);
        impl Read for Fragmented {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let size = output.len().min(1);
                self.0.read(&mut output[..size])
            }
        }
        let request = b"GET /latest.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n";
        let mut input = Fragmented(std::io::Cursor::new(request.to_vec()));
        assert_eq!(read_request_headers(&mut input), request);
    }
    fn fetch(status: &str, body: &str) -> Result<Option<serde_json::Value>, &'static str> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/latest.json", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let server = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(error) => panic!("metadata fixture connection failed: {error}"),
                }
            };
            // Windows accepted sockets inherit the listener's nonblocking mode.
            // The fixture must wait for request bytes before sending its response.
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            // Drain the complete header before closing, avoiding TCP resets from unread bytes.
            read_request_headers(&mut stream);
            stream.write_all(response.as_bytes()).unwrap();
        });
        let result = tauri::async_runtime::block_on(fetch_metadata(&endpoint));
        server.join().unwrap();
        result
    }
    #[test]
    fn missing_release_is_distinct_from_failure_and_valid_metadata() {
        assert_eq!(fetch("404 Not Found", "not found").unwrap(), None);
        assert_eq!(
            fetch("503 Service Unavailable", "unavailable"),
            Err("network")
        );
        assert_eq!(fetch("200 OK", "not json"), Err("metadata"));
        assert_eq!(
            fetch("200 OK", r#"{"version":"0.2.0"}"#).unwrap(),
            Some(serde_json::json!({"version":"0.2.0"}))
        );
    }
}
