use crate::{
    Result,
    platform::Job,
    protocol::{Frame, MAX_PENDING, read_frame, write_frame},
    vault::Vault,
};
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, SyncSender},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Config {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub directory: PathBuf,
    pub accounts: Vec<String>,
}

struct Process {
    child: Child,
    job: Option<Job>,
    tx: Option<SyncSender<Frame>>,
    rx: Option<Receiver<Result<Frame>>>,
    threads: Vec<JoinHandle<()>>,
    instance: String,
    next: u64,
    pending: HashSet<u64>,
    responses: HashMap<u64, Frame>,
    sequence: u64,
    credential_sequence: u64,
    admission_sequence: u64,
    ready: bool,
    models: HashMap<u64, usize>,
}

impl Process {
    fn spawn(config: &Config) -> Result<Self> {
        let mut command = Command::new(&config.program);
        command
            .args(&config.args)
            .current_dir(&config.directory)
            .env_clear();
        for name in [
            "SystemRoot",
            "WINDIR",
            "SystemDrive",
            "COMSPEC",
            "TEMP",
            "TMP",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        #[cfg(windows)]
        let system = std::env::var("SystemRoot").map_err(|_| "windows_environment_missing")?;
        #[cfg(windows)]
        command.env("PATH", format!("{system}\\System32;{system}"));
        #[cfg(unix)]
        command
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .process_group(0);
        command
            .env("HOME", config.directory.join("home"))
            .env("USERPROFILE", config.directory.join("home"));
        command.env("PI_CODING_AGENT_DIR", config.directory.join("agent"));
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| "worker_spawn_failed")?;
        let job = match Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let mut input = child.stdin.take().ok_or("worker_pipe_missing")?;
        let mut output = child.stdout.take().ok_or("worker_pipe_missing")?;
        let mut stderr = child.stderr.take().ok_or("worker_pipe_missing")?;
        let (tx, outgoing) = mpsc::sync_channel::<Frame>(MAX_PENDING);
        let (incoming, rx) = mpsc::sync_channel(MAX_PENDING);
        let failures = incoming.clone();
        let reader = thread::spawn(move || {
            loop {
                let frame = read_frame(&mut output);
                let failed = frame.is_err();
                if incoming.send(frame).is_err() || failed {
                    break;
                }
            }
        });
        let writer = thread::spawn(move || {
            while let Ok(frame) = outgoing.recv() {
                if let Err(error) = write_frame(&mut input, &frame) {
                    let _ = failures.send(Err(error));
                    break;
                }
            }
        });
        // Drain diagnostics concurrently; never retain raw SDK/provider output.
        let diagnostics = thread::spawn(move || {
            let mut bytes = [0; 4096];
            while let Ok(length) = stderr.read(&mut bytes) {
                if length == 0 {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            job: Some(job),
            tx: Some(tx),
            rx: Some(rx),
            threads: vec![reader, writer, diagnostics],
            instance: Uuid::new_v4().to_string(),
            next: 1,
            pending: HashSet::new(),
            responses: HashMap::new(),
            sequence: 0,
            credential_sequence: 0,
            admission_sequence: 0,
            ready: false,
            models: HashMap::new(),
        })
    }

    fn send(&mut self, method: &str, payload: Value) -> Result<u64> {
        if self.pending.len() >= MAX_PENDING {
            return Err("worker_busy");
        }
        let id = self.next;
        self.next = self.next.checked_add(1).ok_or("request_id_overflow")?;
        let frame = Frame {
            v: 1,
            instance: self.instance.clone(),
            kind: "request".into(),
            id,
            method: Some(method.into()),
            ok: None,
            payload,
        };
        // Validate before enqueueing so an invalid caller frame never reaches the writer.
        if serde_json::to_vec(&frame)
            .map_err(|_| "frame_encode_failed")?
            .len()
            > crate::protocol::MAX_FRAME
        {
            return Err("invalid_frame_length");
        }
        self.tx
            .as_ref()
            .ok_or("worker_closed")?
            .try_send(frame)
            .map_err(|_| "worker_busy")?;
        if matches!(method, "prompt" | "session.compact") {
            self.models
                .insert(id, if method == "session.compact" { 2 } else { 1 });
        }
        self.pending.insert(id);
        Ok(id)
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.tx.take();
        self.rx.take();
        // Closing the non-inherited job handle kills the worker and descendants.
        self.job.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        for handle in self.threads.drain(..) {
            let _ = handle.join();
        }
    }
}

pub struct Host {
    config: Config,
    process: Option<Process>,
    pub vault: Vault,
    pub lost_requests: Vec<u64>,
    pub events: Vec<Value>,
    pub usage: crate::usage::UsageLedger,
    ledger_error: Option<&'static str>,
    scheduler: crate::scheduler::Scheduler,
    peak_active_calls: usize,
}

impl Host {
    pub fn new(config: Config, vault: Vault) -> Result<Self> {
        let usage = crate::usage::UsageLedger::open(&config.directory.join("usage.sqlite"))?;
        Ok(Self {
            config,
            process: None,
            vault,
            lost_requests: vec![],
            events: vec![],
            usage,
            ledger_error: None,
            scheduler: crate::scheduler::Scheduler::default(),
            peak_active_calls: 0,
        })
    }
    pub fn submit_task(&mut self, task: crate::scheduler::Task) -> Result<u64> {
        if let Some(error) = self.ledger_error {
            return Err(error);
        }
        self.scheduler.submit(task, Instant::now())
    }
    pub fn peak_active_calls(&self) -> usize {
        self.peak_active_calls
    }
    pub fn poll(&mut self, timeout: Duration) -> Result<()> {
        if self.process.is_none() && self.scheduler.queued() == 0 {
            return Ok(());
        }
        let deadline = Instant::now() + timeout;
        self.advance_tasks(deadline)
    }
    pub fn queued_tasks(&self) -> usize {
        self.scheduler.queued()
    }
    pub fn running_tasks(&self) -> usize {
        self.scheduler.running()
    }
    pub fn task_outcome(&mut self, id: u64) -> Result<Option<crate::scheduler::Outcome>> {
        self.scheduler.expire(Instant::now());
        self.scheduler.outcome(id)
    }
    pub fn cancel_task(&mut self, id: u64) -> Result<()> {
        if let Some(session) = self.scheduler.cancel(id)? {
            self.request("cancel", json!({"sessionId":session}))?;
        }
        Ok(())
    }
    pub fn wait_task(&mut self, id: u64, timeout: Duration) -> Result<crate::scheduler::Outcome> {
        let deadline = Instant::now() + timeout;
        loop {
            self.scheduler.expire(Instant::now());
            if let Some(outcome) = self.scheduler.outcome(id)? {
                return Ok(outcome);
            }
            if Instant::now() >= deadline {
                return Err("task_wait_timeout");
            }
            self.advance_tasks(deadline)?;
        }
    }
    pub fn wait_task_event(&mut self, id: u64, kind: &str, timeout: Duration) -> Result<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            self.scheduler.expire(Instant::now());
            let outcome = self.scheduler.outcome(id)?;
            if outcome
                .as_ref()
                .is_some_and(|o| o.status != crate::scheduler::Status::Completed)
            {
                return Err("task_terminal_without_event");
            }
            if let Some(request) = self.scheduler.request_id(id)?
                && let Some(event) = self
                    .events
                    .iter()
                    .find(|e| e["requestId"].as_u64() == Some(request) && e["type"] == kind)
            {
                return Ok(event.clone());
            }
            if outcome.is_some() {
                return Err("task_terminal_without_event");
            }
            if Instant::now() >= deadline {
                return Err("task_wait_timeout");
            }
            self.advance_tasks(deadline)?;
        }
    }
    fn advance_tasks(&mut self, deadline: Instant) -> Result<()> {
        self.start()?;
        if let Err(error) = self.pump(deadline) {
            if error == "worker_timeout_unknown" && Instant::now() >= deadline {
                return Err("task_wait_timeout");
            }
            self.stop();
            return Err(error);
        }
        Ok(())
    }
    fn drive_tasks(&mut self) -> Result<()> {
        self.scheduler.expire(Instant::now());
        let Some(process) = self.process.as_mut().filter(|p| p.ready) else {
            return Ok(());
        };
        for request in self.scheduler.requests() {
            if let Some(frame) = process.responses.remove(&request) {
                process.pending.remove(&request);
                self.scheduler
                    .finish(request, frame.ok == Some(true), frame.payload);
            }
        }
        loop {
            let reserved: usize = process.models.values().sum();
            let available =
                crate::usage::MAX_ACTIVE.saturating_sub(reserved.max(self.usage.active()));
            if !self.scheduler.dispatch(Instant::now(), available, |task| {
                let (method, payload) = task.command();
                process.send(method, payload)
            })? {
                break;
            }
        }
        Ok(())
    }
    pub fn pid(&self) -> Option<u32> {
        self.process.as_ref().map(|process| process.child.id())
    }

    pub fn start(&mut self) -> Result<()> {
        if let Some(error) = self.ledger_error {
            return Err(error);
        }
        if self.process.is_some() {
            return Ok(());
        }
        self.events.clear();
        self.process = Some(Process::spawn(&self.config)?);
        let id = self
            .process
            .as_mut()
            .unwrap()
            .send("hello", json!({"sdk":"18.12.3"}))?;
        let hello = match self.wait(id, Duration::from_secs(15)) {
            Ok(hello) => hello,
            Err(error) => {
                self.stop();
                return Err(error);
            }
        };
        if hello["sdk"] != "18.12.3"
            || hello["protocol"] != 1
            || hello["pid"].as_u64() != self.pid().map(u64::from)
        {
            self.stop();
            return Err("handshake_failed");
        }
        self.process.as_mut().unwrap().ready = true;
        Ok(())
    }

    pub fn send(&mut self, method: &str, payload: Value) -> Result<u64> {
        self.start()?;
        self.process
            .as_mut()
            .ok_or("worker_closed")?
            .send(method, payload)
    }

    pub fn request(&mut self, method: &str, payload: Value) -> Result<Value> {
        let id = self.send(method, payload)?;
        self.wait(id, Duration::from_secs(10))
    }

    pub fn wait(&mut self, id: u64, timeout: Duration) -> Result<Value> {
        let result = self.receive(id, timeout);
        if matches!(result, Err(error) if error != "remote_error" && error != "unknown_request") {
            self.stop();
        }
        result
    }

    fn receive(&mut self, id: u64, timeout: Duration) -> Result<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return Err("worker_timeout_unknown");
            }
            let process = self.process.as_mut().ok_or("worker_closed")?;
            if !process.pending.contains(&id) {
                return Err("unknown_request");
            }
            if let Some(frame) = process.responses.remove(&id) {
                process.pending.remove(&id);
                return if frame.ok == Some(true) {
                    Ok(frame.payload)
                } else {
                    Err("remote_error")
                };
            }
            self.pump(deadline)?;
        }
    }

    fn pump(&mut self, deadline: Instant) -> Result<()> {
        let unresolved = self.scheduler.queued() + self.scheduler.running();
        self.drive_tasks()?;
        if self.scheduler.queued() + self.scheduler.running() < unresolved {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("worker_timeout_unknown");
        }
        let process = self.process.as_mut().ok_or("worker_closed")?;
        let wake = self
            .scheduler
            .next_expiry()
            .map_or(deadline, |expiry| expiry.min(deadline));
        let frame = match process
            .rx
            .as_ref()
            .ok_or("worker_closed")?
            .recv_timeout(wake.saturating_duration_since(Instant::now()))
        {
            Ok(frame) => frame?,
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {
                self.drive_tasks()?;
                return Ok(());
            }
            Err(_) => return Err("worker_timeout_unknown"),
        };
        if frame.v != 1 || frame.instance != process.instance || frame.id == 0 {
            return Err("protocol_identity_failed");
        }
        match frame.kind.as_str() {
            "response" => {
                if frame.method.is_some() {
                    return Err("invalid_response");
                }
                if !process.pending.contains(&frame.id)
                    || process.responses.contains_key(&frame.id)
                    || frame.ok.is_none()
                {
                    return Err("unexpected_response");
                }
                process.models.remove(&frame.id);
                process.responses.insert(frame.id, frame);
            }
            "event" => {
                let sequence = frame.payload["sequence"].as_u64().ok_or("invalid_event")?;
                if sequence != process.sequence + 1 || !process.pending.contains(&frame.id) {
                    return Err("invalid_event");
                }
                process.sequence = sequence;
                // Usage changes are committed through the acknowledged admission RPC.
                if self.events.len() >= 256 {
                    self.events.remove(0);
                }
                self.events.push(frame.payload);
            }
            "admission_request" => {
                if frame.id != process.admission_sequence + 1 || frame.ok.is_some() {
                    return Err("admission_sequence_failed");
                }
                process.admission_sequence = frame.id;
                let request_id = frame.payload["requestId"]
                    .as_u64()
                    .ok_or("invalid_call_scope")?;
                if !process.pending.contains(&request_id)
                    || process.responses.contains_key(&request_id)
                {
                    return Err("unattributed_call");
                }
                let payload = match frame.method.as_deref() {
                    Some("acquire") => {
                        let admitted =
                            self.usage
                                .acquire(&process.instance, request_id, &frame.payload)?;
                        self.peak_active_calls = self.peak_active_calls.max(self.usage.active());
                        json!({"admitted":admitted})
                    }
                    Some("complete") => {
                        self.usage
                            .complete(&process.instance, request_id, &frame.payload)?;
                        json!({"committed":true})
                    }
                    _ => return Err("admission_method_not_allowed"),
                };
                process
                    .tx
                    .as_ref()
                    .ok_or("worker_closed")?
                    .try_send(Frame {
                        v: 1,
                        instance: process.instance.clone(),
                        kind: "admission_response".into(),
                        id: frame.id,
                        method: None,
                        ok: Some(true),
                        payload,
                    })
                    .map_err(|_| "worker_busy")?;
            }
            "credential_request" => {
                if frame.id != process.credential_sequence + 1 {
                    return Err("credential_sequence_failed");
                }
                process.credential_sequence = frame.id;
                let account = frame.payload["account"]
                    .as_str()
                    .ok_or("invalid_credential_request")?;
                let result = if !self
                    .config
                    .accounts
                    .iter()
                    .any(|allowed| allowed == account)
                {
                    Err("account_not_allowed")
                } else {
                    match frame.method.as_deref() {
                        Some("read") => self.vault.read(account),
                        Some("commit") => {
                            let expected = frame.payload["expected"]
                                .as_u64()
                                .ok_or("invalid_credential_request")?;
                            self.vault
                                .commit(account, expected, &frame.payload["credential"])
                        }
                        _ => Err("credential_method_not_allowed"),
                    }
                };
                let response = Frame {
                    v: 1,
                    instance: process.instance.clone(),
                    kind: "credential_response".into(),
                    id: frame.id,
                    method: None,
                    ok: Some(result.is_ok()),
                    payload: result.unwrap_or_else(|code| json!({"code":code})),
                };
                process
                    .tx
                    .as_ref()
                    .ok_or("worker_closed")?
                    .try_send(response)
                    .map_err(|_| "worker_busy")?;
            }
            _ => return Err("unknown_frame_kind"),
        }
        self.drive_tasks()?;
        Ok(())
    }

    pub fn wait_event(&mut self, id: u64, kind: &str, timeout: Duration) -> Result<Value> {
        let deadline = Instant::now() + timeout;
        let result = (|| loop {
            if let Some(event) = self
                .events
                .iter()
                .find(|event| event["requestId"].as_u64() == Some(id) && event["type"] == kind)
            {
                return Ok(event.clone());
            }
            let process = self.process.as_ref().ok_or("worker_closed")?;
            if !process.pending.contains(&id) || process.responses.contains_key(&id) {
                return Err("terminal_without_event");
            }
            self.pump(deadline)?;
        })();
        if result.is_err() {
            self.stop();
        }
        result
    }

    pub fn recycle(&mut self) -> Result<()> {
        self.scheduler.expire(Instant::now());
        if self.scheduler.queued() + self.scheduler.running() > 0 {
            return Err("worker_busy");
        }
        if self.process.is_none() {
            return Ok(());
        }
        self.request("shutdown", json!({}))?;
        self.stop();
        Ok(())
    }

    pub fn stop(&mut self) {
        self.scheduler.lose();
        if let Some(process) = self.process.take() {
            self.lost_requests.extend(process.pending.iter().copied());
            drop(process);
        }
        if let Err(error) = self.usage.mark_lost() {
            self.ledger_error = Some(error);
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.stop();
    }
}
