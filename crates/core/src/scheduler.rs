use crate::Result;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, VecDeque},
    time::{Duration, Instant},
};

pub const MAX_QUEUED: usize = 32;
const MAX_RESULTS: usize = 64;
const MAX_SCOPES: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    Manual,
    Background,
}
#[derive(Clone)]
pub enum Work {
    Prompt(String),
    Compact,
}
#[derive(Clone)]
pub struct Task {
    pub session_id: String,
    pub scope: String,
    pub revision: u64,
    pub priority: Priority,
    pub ttl: Duration,
    pub work: Work,
}
impl Task {
    pub fn cost(&self) -> usize {
        if matches!(self.work, Work::Compact) {
            2
        } else {
            1
        }
    }
    pub fn command(&self) -> (&'static str, Value) {
        match &self.work {
            Work::Prompt(text) => ("prompt", json!({"sessionId":self.session_id,"text":text})),
            Work::Compact => ("session.compact", json!({"sessionId":self.session_id})),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Completed,
    Truncated,
    Incomplete,
    Failed,
    Cancelled,
    Expired,
    Stale,
    Lost,
}
#[derive(Clone, Debug)]
pub struct Outcome {
    pub status: Status,
    pub request_id: Option<u64>,
    pub response: Option<Value>,
}
struct Entry {
    id: u64,
    task: Task,
    expires: Instant,
}
struct Running {
    entry: Entry,
    request: u64,
    cancelled: bool,
}
#[derive(Default)]
pub struct Scheduler {
    next: u64,
    queue: VecDeque<Entry>,
    running: Vec<Running>,
    results: VecDeque<(u64, Outcome)>,
    revisions: BTreeMap<String, u64>,
    manual_streak: usize,
}
impl Scheduler {
    fn record(&mut self, id: u64, outcome: Outcome) {
        if self.results.len() == MAX_RESULTS {
            self.results.pop_front();
        }
        self.results.push_back((id, outcome));
    }
    fn discard(&mut self, entry: Entry, status: Status) {
        self.record(
            entry.id,
            Outcome {
                status,
                request_id: None,
                response: None,
            },
        );
    }
    pub fn expire(&mut self, now: Instant) {
        let mut kept = VecDeque::new();
        while let Some(entry) = self.queue.pop_front() {
            if entry.expires <= now {
                self.discard(entry, Status::Expired);
            } else {
                kept.push_back(entry);
            }
        }
        self.queue = kept;
    }
    pub fn submit(&mut self, task: Task, now: Instant) -> Result<u64> {
        if task.session_id.is_empty()
            || task.session_id.len() > 64
            || task.scope.is_empty()
            || task.scope.len() > 64
            || task.ttl > Duration::from_secs(300)
            || matches!(&task.work,Work::Prompt(text) if text.len()>16000)
        {
            return Err("invalid_task");
        }
        self.expire(now);
        if let Some(revision) = self.revisions.get(&task.scope) {
            if task.revision < *revision {
                return Err("stale_task_revision");
            }
        } else if self.revisions.len() == MAX_SCOPES {
            return Err("task_scope_limit");
        }
        // A rejected submission must not advance revision or invalidate accepted work.
        let superseded = self
            .queue
            .iter()
            .filter(|e| e.task.scope == task.scope && e.task.revision < task.revision)
            .count();
        if self.queue.len() - superseded >= MAX_QUEUED {
            return Err("task_queue_full");
        }
        let id = self.next.checked_add(1).ok_or("task_id_overflow")?;
        let expires = now.checked_add(task.ttl).ok_or("invalid_task")?;
        self.next = id;
        self.revisions.insert(task.scope.clone(), task.revision);
        let mut kept = VecDeque::new();
        while let Some(entry) = self.queue.pop_front() {
            if entry.task.scope == task.scope && entry.task.revision < task.revision {
                self.discard(entry, Status::Stale);
            } else {
                kept.push_back(entry);
            }
        }
        self.queue = kept;
        self.queue.push_back(Entry { id, task, expires });
        self.expire(now);
        Ok(id)
    }
    pub fn next_expiry(&self) -> Option<Instant> {
        self.queue.iter().map(|e| e.expires).min()
    }
    pub fn queued(&self) -> usize {
        self.queue.len()
    }
    pub fn running(&self) -> usize {
        self.running.len()
    }
    pub fn outcome(&self, id: u64) -> Result<Option<Outcome>> {
        if let Some((_, outcome)) = self.results.iter().find(|(key, _)| *key == id) {
            return Ok(Some(outcome.clone()));
        }
        if self.queue.iter().any(|e| e.id == id) || self.running.iter().any(|e| e.entry.id == id) {
            Ok(None)
        } else {
            Err("unknown_task")
        }
    }
    pub fn request_id(&self, id: u64) -> Result<Option<u64>> {
        if let Some(running) = self.running.iter().find(|r| r.entry.id == id) {
            return Ok(Some(running.request));
        }
        Ok(self.outcome(id)?.and_then(|outcome| outcome.request_id))
    }
    pub fn cancel(&mut self, id: u64) -> Result<Option<String>> {
        if let Some(index) = self.queue.iter().position(|e| e.id == id) {
            let entry = self.queue.remove(index).unwrap();
            self.discard(entry, Status::Cancelled);
            return Ok(None);
        }
        if let Some(running) = self.running.iter_mut().find(|e| e.entry.id == id) {
            if running.cancelled {
                return Ok(None);
            }
            running.cancelled = true;
            return Ok(Some(running.entry.task.session_id.clone()));
        }
        self.outcome(id)?;
        Ok(None)
    }
    pub fn dispatch(
        &mut self,
        now: Instant,
        available: usize,
        send: impl FnOnce(&Task) -> Result<u64>,
    ) -> Result<bool> {
        self.expire(now);
        let eligible = |e: &&Entry| {
            !self
                .running
                .iter()
                .any(|r| r.entry.task.session_id == e.task.session_id)
        };
        // Select by ID to preserve FIFO among eligible tasks, without skipping a
        // selected compaction just because only one global slot is free.
        let preferred = if self.manual_streak >= 3 {
            Priority::Background
        } else {
            Priority::Manual
        };
        let candidate = self
            .queue
            .iter()
            .filter(eligible)
            .find(|e| e.task.priority == preferred)
            .or_else(|| {
                self.queue.iter().find(|e| {
                    !self
                        .running
                        .iter()
                        .any(|r| r.entry.task.session_id == e.task.session_id)
                })
            });
        let Some(candidate) = candidate else {
            return Ok(false);
        };
        if candidate.task.cost() > available {
            return Ok(false);
        }
        let index = self
            .queue
            .iter()
            .position(|e| e.id == candidate.id)
            .unwrap();
        let entry = self.queue.remove(index).unwrap();
        let request = match send(&entry.task) {
            Ok(id) => id,
            Err(error) => {
                self.queue.insert(index, entry);
                return Err(error);
            }
        };
        if entry.task.priority == Priority::Manual {
            self.manual_streak = (self.manual_streak + 1).min(3);
        } else {
            self.manual_streak = 0;
        }
        self.running.push(Running {
            entry,
            request,
            cancelled: false,
        });
        Ok(true)
    }
    pub fn requests(&self) -> Vec<u64> {
        self.running.iter().map(|r| r.request).collect()
    }
    pub fn finish(&mut self, request: u64, ok: bool, payload: Value) {
        let Some(index) = self.running.iter().position(|r| r.request == request) else {
            return;
        };
        let running = self.running.remove(index);
        let stale = self
            .revisions
            .get(&running.entry.task.scope)
            .is_some_and(|r| *r > running.entry.task.revision);
        let status = if stale {
            Status::Stale
        } else if running.cancelled {
            Status::Cancelled
        } else if ok {
            match payload["status"].as_str() {
                Some("stop") => Status::Completed,
                Some("length") => Status::Truncated,
                Some("aborted") => Status::Cancelled,
                Some("error") => Status::Failed,
                None if matches!(running.entry.task.work, Work::Compact) => Status::Completed,
                _ => Status::Incomplete,
            }
        } else {
            Status::Failed
        };
        self.record(
            running.entry.id,
            Outcome {
                status,
                request_id: Some(request),
                response: if matches!(
                    status,
                    Status::Completed | Status::Truncated | Status::Incomplete | Status::Failed
                ) {
                    Some(payload)
                } else {
                    None
                },
            },
        );
    }
    pub fn lose(&mut self) {
        while let Some(entry) = self.queue.pop_front() {
            self.discard(entry, Status::Lost);
        }
        while let Some(running) = self.running.pop() {
            self.record(
                running.entry.id,
                Outcome {
                    status: Status::Lost,
                    request_id: Some(running.request),
                    response: None,
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task(session: &str, priority: Priority) -> Task {
        Task {
            session_id: session.into(),
            scope: session.into(),
            revision: 1,
            priority,
            ttl: Duration::from_secs(10),
            work: Work::Prompt("test".into()),
        }
    }
    #[test]
    fn terminal_reasons_preserve_partial_output_and_never_assume_success() {
        for (reason, expected) in [
            ("stop", Status::Completed),
            ("length", Status::Truncated),
            ("error", Status::Failed),
            ("aborted", Status::Cancelled),
            ("unknown", Status::Incomplete),
            ("toolUse", Status::Incomplete),
        ] {
            let mut scheduler = Scheduler::default();
            let now = Instant::now();
            let id = scheduler.submit(task("a", Priority::Manual), now).unwrap();
            scheduler.dispatch(now, 2, |_| Ok(1)).unwrap();
            scheduler.finish(1, true, json!({"status":reason,"text":"partial"}));
            let result = scheduler.outcome(id).unwrap().unwrap();
            assert_eq!(result.status, expected);
            if expected != Status::Cancelled {
                assert_eq!(result.response.unwrap()["text"], "partial");
            }
        }
    }
    #[test]
    fn bounded_queue_cancel_expiry_and_revision_rejection_are_atomic() {
        let now = Instant::now();
        let mut s = Scheduler::default();
        let old = s.submit(task("owner", Priority::Background), now).unwrap();
        for i in 0..31 {
            s.submit(task(&format!("s{i}"), Priority::Manual), now)
                .unwrap();
        }
        assert_eq!(s.queued(), 32);
        assert_eq!(
            s.submit(task("overflow", Priority::Manual), now),
            Err("task_queue_full")
        );
        let mut replacement = task("owner", Priority::Manual);
        replacement.revision = 2;
        let fresh = s.submit(replacement, now).unwrap();
        assert_eq!(s.outcome(old).unwrap().unwrap().status, Status::Stale);
        assert_eq!(s.queued(), 32);
        assert_eq!(
            s.submit(task("owner", Priority::Manual), now),
            Err("stale_task_revision")
        );
        s.cancel(fresh).unwrap();
        s.cancel(fresh).unwrap();
        assert_eq!(s.queued(), 31);
        s.expire(now + Duration::from_secs(10));
        assert_eq!(s.queued(), 0);
        assert_eq!(s.outcome(fresh).unwrap().unwrap().status, Status::Cancelled);
        let expired = s
            .submit(
                Task {
                    ttl: Duration::ZERO,
                    ..task("expired", Priority::Manual)
                },
                now,
            )
            .unwrap();
        assert_eq!(s.outcome(expired).unwrap().unwrap().status, Status::Expired);
        assert!(
            !s.dispatch(now, 2, |_| panic!("expired work dispatched"))
                .unwrap()
        );
    }
    #[test]
    fn manual_priority_fifo_and_bounded_starvation() {
        let now = Instant::now();
        let mut s = Scheduler::default();
        let bg = s.submit(task("bg", Priority::Background), now).unwrap();
        let manual: Vec<_> = (0..4)
            .map(|i| {
                s.submit(task(&format!("m{i}"), Priority::Manual), now)
                    .unwrap()
            })
            .collect();
        let mut order = vec![];
        for request in 1..=5 {
            s.dispatch(now, 2, |_| Ok(request)).unwrap();
            let r = &s.running[0];
            order.push(r.entry.id);
            s.finish(request, true, json!({}));
        }
        assert_eq!(order, vec![manual[0], manual[1], manual[2], bg, manual[3]]);
    }
    #[test]
    fn session_serialization_compaction_reservation_and_stale_result_fencing() {
        let now = Instant::now();
        let mut s = Scheduler::default();
        let first = s.submit(task("same", Priority::Manual), now).unwrap();
        s.dispatch(now, 2, |_| Ok(1)).unwrap();
        let mut fresh = task("same", Priority::Manual);
        fresh.revision = 2;
        let second = s.submit(fresh, now).unwrap();
        assert!(
            !s.dispatch(now, 1, |_| panic!("session overlapped"))
                .unwrap()
        );
        s.finish(1, true, json!({"text":"STALE_TEXT"}));
        let outcome = s.outcome(first).unwrap().unwrap();
        assert_eq!(outcome.status, Status::Stale);
        assert!(outcome.response.is_none());
        s.dispatch(now, 2, |_| Ok(2)).unwrap();
        assert_eq!(s.running[0].entry.id, second);
        s.finish(2, true, json!({}));
        s.submit(
            Task {
                work: Work::Compact,
                ..task("compact", Priority::Manual)
            },
            now,
        )
        .unwrap();
        s.submit(task("later", Priority::Manual), now).unwrap();
        assert!(
            !s.dispatch(now, 1, |_| panic!("compaction bypassed capacity"))
                .unwrap()
        );
        assert!(
            s.dispatch(now, 2, |task| {
                assert_eq!(task.cost(), 2);
                Ok(3)
            })
            .unwrap()
        );
        assert!(!s.dispatch(now, 0, |_| panic!("over capacity")).unwrap());
        s.lose();
        assert_eq!(s.queued() + s.running(), 0);
    }
    #[test]
    fn cancellation_does_not_release_running_work_until_terminal_and_results_are_bounded() {
        let now = Instant::now();
        let mut s = Scheduler::default();
        let first = s.submit(task("a", Priority::Manual), now).unwrap();
        s.dispatch(now, 2, |_| Ok(1)).unwrap();
        assert_eq!(s.cancel(first).unwrap(), Some("a".into()));
        assert_eq!(s.cancel(first).unwrap(), None);
        assert_eq!(s.running(), 1);
        assert!(s.outcome(first).unwrap().is_none());
        s.finish(1, true, json!({"text":"cancelled"}));
        assert_eq!(s.outcome(first).unwrap().unwrap().status, Status::Cancelled);
        for _ in 0..64 {
            let id = s.submit(task("a", Priority::Manual), now).unwrap();
            s.cancel(id).unwrap();
        }
        assert_eq!(s.results.len(), 64);
        assert_eq!(s.outcome(first).unwrap_err(), "unknown_task");
    }
}
