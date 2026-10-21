// Shared orchestration for the opt-in live binary and offline SDK regressions.
use lingo_sofa_omp_client::{
    Result,
    client::Host,
    scheduler::{Outcome, Priority, Status, Task, Work},
};
use serde_json::{Value, json};
use std::time::Duration;
#[derive(Clone, Copy)]
pub enum Workload {
    Fixture,
    Desktop,
}
impl Workload {
    fn compaction_calls(self, count: usize) -> bool {
        match self {
            Self::Fixture => count == 2,
            Self::Desktop => (2..=3).contains(&count),
        }
    }

    fn notes(self) -> String {
        match self {Self::Fixture=>"Reading note: this application translates selected text and keeps the original text visible. ".repeat(55),Self::Desktop=>"Reading identifiers: a0 b1 c2 d3 e4 f5 g6 h7 i8 j9. ".repeat(250)}
    }
    fn recall(self, notes: &str) -> String {
        let question = "What is the project code I gave you? Reply with the code only.";
        match self {
            Self::Fixture => question.into(),
            Self::Desktop => format!("Additional reading identifiers: {notes}\n{question}"),
        }
    }
}
fn require(condition: bool, code: &'static str) -> Result<()> {
    if condition { Ok(()) } else { Err(code) }
}
fn task(session: &str, priority: Priority, work: Work) -> Task {
    Task {
        session_id: session.into(),
        scope: session.into(),
        revision: 1,
        priority,
        ttl: Duration::from_secs(120),
        work,
    }
}
fn completed(host: &mut Host, id: u64) -> Result<Outcome> {
    let outcome = host.wait_task(id, Duration::from_secs(60))?;
    require(
        outcome.status == Status::Completed,
        "queued_operation_not_completed",
    )?;
    Ok(outcome)
}
fn prompt(host: &mut Host, session: &str, text: &str) -> Result<(u64, u64, String)> {
    let id = host.submit_task(task(session, Priority::Manual, Work::Prompt(text.into())))?;
    let outcome = completed(host, id)?;
    let request = outcome.request_id.ok_or("task_request_missing")?;
    require(
        outcome
            .response
            .as_ref()
            .is_some_and(|r| r["status"] == "stop"),
        "generation_not_completed",
    )?;
    let text = host
        .events
        .iter()
        .filter(|e| e["requestId"].as_u64() == Some(request))
        .filter_map(|e| e["text"].as_str())
        .collect::<String>();
    require(!text.is_empty(), "missing_streamed_output")?;
    let calls: Vec<_> = host
        .usage
        .records()
        .into_iter()
        .filter(|c| c["requestId"].as_u64() == Some(request))
        .collect();
    require(
        calls.len() == 1 && calls[0]["usageState"] == "reported",
        "generation_usage_missing",
    )?;
    Ok((id, request, text))
}
fn count(host: &mut Host) -> Result<u64> {
    host.request("stats", json!({}))?["providerCalls"]
        .as_u64()
        .ok_or("call_count_missing")
}

pub fn queued_model_path(host: &mut Host, workload: Workload) -> Result<Value> {
    let created = host.request("session.create", json!({}))?;
    let session = created["sessionId"].as_str().ok_or("session_missing")?;
    let blocker = host.request("session.create", json!({}))?;
    let blocker = blocker["sessionId"].as_str().ok_or("session_missing")?;
    let notes = workload.notes();
    let (translation, translation_request, translated) = prompt(
        host,
        session,
        &format!(
            "Translate 'The sofa is green.' into simplified Chinese. Reply with the translation only. Remember project code W0-ALPHA. {notes}"
        ),
    )?;
    require(translated.contains("沙发"), "translation_assertion_failed")?;
    let (before, before_request, before_text) = prompt(host, session, &workload.recall(&notes))?;
    require(
        before_text.contains("W0-ALPHA"),
        "continuity_before_compaction_failed",
    )?;
    // Background resets the fairness streak; the waiting manual compaction must
    // precede an earlier background recall once the second slot becomes free.
    let cancelled_generation=host.submit_task(task(blocker,Priority::Background,Work::Prompt("Write 1000 numbered English sentences about sofas. Start immediately, one sentence per line, keep going without a conclusion. W0_SLOW".into())))?;
    let first_text =
        host.wait_task_event(cancelled_generation, "text_delta", Duration::from_secs(30))?;
    let cancel_request = first_text["requestId"]
        .as_u64()
        .ok_or("task_request_missing")?;
    require(
        host.task_outcome(cancelled_generation)?.is_none(),
        "cancel_target_completed_early",
    )?;
    let after = host.submit_task(task(
        session,
        Priority::Background,
        Work::Prompt("What is the project code? Reply with that code only.".into()),
    ))?;
    let compact = host.submit_task(task(session, Priority::Manual, Work::Compact))?;
    let queued_cancel = host.submit_task(task(
        session,
        Priority::Manual,
        Work::Prompt("W0_QUEUED_CANCEL_MUST_NOT_DISPATCH".into()),
    ))?;
    require(
        host.queued_tasks() == 3 && host.running_tasks() == 1,
        "tasks_not_queued",
    )?;
    require(
        count(host)? == 3 && host.queued_tasks() == 3,
        "queued_work_dispatched_early",
    )?;
    host.cancel_task(queued_cancel)?;
    host.cancel_task(queued_cancel)?;
    let cancelled = host.wait_task(queued_cancel, Duration::from_secs(1))?;
    require(
        cancelled.status == Status::Cancelled && cancelled.request_id.is_none(),
        "queued_cancel_dispatched",
    )?;
    require(
        count(host)? == 3 && host.queued_tasks() == 2,
        "queued_cancel_caused_http",
    )?;
    host.cancel_task(cancelled_generation)?;
    let aborted = host.wait_task(cancelled_generation, Duration::from_secs(30))?;
    require(
        aborted.status == Status::Cancelled && aborted.request_id == Some(cancel_request),
        "running_cancel_not_terminal",
    )?;
    let compacted = completed(host, compact)?;
    require(
        compacted
            .response
            .as_ref()
            .is_some_and(|r| r["summaryCommitted"] == true),
        "compaction_failed",
    )?;
    let compact_request = compacted.request_id.ok_or("task_request_missing")?;
    let recalled = completed(host, after)?;
    let after_request = recalled.request_id.ok_or("task_request_missing")?;
    require(
        compact_request < after_request,
        "manual_priority_not_observed",
    )?;
    let after_text = host
        .events
        .iter()
        .filter(|e| e["requestId"].as_u64() == Some(after_request))
        .filter_map(|e| e["text"].as_str())
        .collect::<String>();
    require(
        after_text.contains("W0-ALPHA"),
        "continuity_after_compaction_failed",
    )?;
    require(
        host.peak_active_calls() > 0 && host.peak_active_calls() <= 2,
        "global_concurrency_exceeded",
    )?;
    let peak = host.peak_active_calls();
    let count_before = count(host)?;
    std::thread::sleep(Duration::from_millis(300));
    require(count(host)? == count_before, "unexpected_call_replay")?;
    let calls = host.usage.records();
    let allowed = [
        translation_request,
        before_request,
        cancel_request,
        compact_request,
        after_request,
    ];
    require(
        calls.len() as u64 == count_before
            && calls.iter().all(|c| {
                c["requestId"]
                    .as_u64()
                    .is_some_and(|r| allowed.contains(&r))
            }),
        "call_ledger_task_mismatch",
    )?;
    let compact_calls: Vec<_> = calls
        .iter()
        .filter(|c| c["requestId"].as_u64() == Some(compact_request))
        .collect();
    require(
        workload.compaction_calls(compact_calls.len())
            && calls.len() == 4 + compact_calls.len()
            && compact_calls
                .iter()
                .all(|c| c["purpose"] == "compaction" && c["usageState"] == "reported"),
        "compaction_usage_missing",
    )?;
    let cancelled_calls: Vec<_> = calls
        .iter()
        .filter(|c| c["requestId"].as_u64() == Some(cancel_request))
        .collect();
    require(
        cancelled_calls.len() == 1
            && matches!(
                cancelled_calls[0]["usageState"].as_str(),
                Some("unknown" | "partial")
            ),
        "cancel_usage_not_unknown_or_partial",
    )?;
    require(
        calls
            .iter()
            .filter(|c| c["requestId"].as_u64() != Some(cancel_request))
            .all(|c| c["usageState"] == "reported"),
        "completed_usage_missing",
    )?;
    require(
        host.queued_tasks() == 0 && host.running_tasks() == 0 && host.usage.active() == 0,
        "tasks_not_drained",
    )?;
    host.request("session.close", json!({"sessionId":session}))?;
    host.request("session.close", json!({"sessionId":blocker}))?;
    host.recycle()?;
    require(host.pid().is_none(), "worker_not_reaped")?;
    Ok(
        json!({"passed":true,"providerCalls":count_before,"peakActiveCalls":peak,"compactionCalls":compact_calls.len(),"calls":calls,
        "tasks":{"translation":{"taskId":translation,"requestId":translation_request},"beforeCompaction":{"taskId":before,"requestId":before_request},"cancelledGeneration":{"taskId":cancelled_generation,"requestId":cancel_request},"queuedCancelled":{"taskId":queued_cancel,"requestId":null},"compaction":{"taskId":compact,"requestId":compact_request},"afterCompaction":{"taskId":after,"requestId":after_request}},
        "checks":{"allModelCallsQueued":true,"globalConcurrencyLimited":true,"streamedTranslation":true,"queuedTasksWaitedForCapacity":true,"queuedCancelNoDispatch":true,"manualCompactionBeforeBackgroundRecall":true,"cancelledAfterStreamedText":true,"noCancelReplay":true,"continuityBeforeAndAfterCompaction":true,"allCallsAccountedBeforeTerminal":true,"queueAndUsageDrained":true,"cleanShutdown":true},"pricingKnown":false,"cancelledCallBillingKnown":false}),
    )
}

fn snapshot(host: &mut Host, phase: &str, started: std::time::Instant) -> Result<Value> {
    let stats = host.request("stats", json!({}))?;
    Ok(
        json!({"phase":phase,"elapsedMs":started.elapsed().as_millis(),
        "providerCalls":stats["providerCalls"],"activeProviderCalls":stats["activeProviderCalls"],
        "activeCallIds":stats["activeCallIds"],"peakProviderCalls":stats["peakProviderCalls"],
        "activeLedgerCalls":host.usage.active(),"peakLedgerCalls":host.peak_active_calls(),
        "queuedTasks":host.queued_tasks(),"runningTasks":host.running_tasks()}),
    )
}

pub fn saturated_model_path(host: &mut Host, workload: Workload) -> Result<Value> {
    let started = std::time::Instant::now();
    let mut sessions = vec![];
    for _ in 0..3 {
        let created = host.request("session.create", json!({}))?;
        sessions.push(
            created["sessionId"]
                .as_str()
                .ok_or("session_missing")?
                .to_owned(),
        );
    }
    let notes = workload.notes();
    let (translation, translation_request, translated) = prompt(
        host,
        &sessions[0],
        &format!(
            "Translate 'The sofa is green.' into simplified Chinese. Reply with the translation only. Remember project code W0-ALPHA. {notes}"
        ),
    )?;
    require(translated.contains("沙发"), "translation_assertion_failed")?;
    let (before, before_request, before_text) =
        prompt(host, &sessions[0], &workload.recall(&notes))?;
    require(
        before_text.contains("W0-ALPHA"),
        "continuity_before_compaction_failed",
    )?;
    let mut blockers = vec![];
    // Both jobs are submitted before driving the host. No local transport delay
    // or extra permit is used to manufacture overlap on the real provider.
    for (index, session) in sessions[1..].iter().enumerate() {
        blockers.push(host.submit_task(task(session,Priority::Background,Work::Prompt(format!("Write 1000 numbered English sentences about sofas. Start immediately, one sentence per line, keep going without a conclusion. Independent stream {index}. W0_SLOW"))))?);
    }
    let mut blocker_requests = vec![];
    for id in &blockers {
        let event = host.wait_task_event(*id, "text_delta", Duration::from_secs(30))?;
        blocker_requests.push(event["requestId"].as_u64().ok_or("task_request_missing")?);
    }
    for id in &blockers {
        require(
            host.task_outcome(*id)?.is_none(),
            "dual_stream_completed_early",
        )?;
    }
    let saturated = snapshot(host, "both_streaming", started)?;
    require(
        saturated["activeProviderCalls"] == 2
            && saturated["activeLedgerCalls"] == 2
            && saturated["runningTasks"] == 2
            && saturated["providerCalls"] == 4,
        "dual_streams_not_saturated",
    )?;
    let active_ids = saturated["activeCallIds"]
        .as_array()
        .ok_or("active_calls_missing")?;
    require(
        host.usage
            .records()
            .iter()
            .filter(|c| {
                c["requestId"]
                    .as_u64()
                    .is_some_and(|id| blocker_requests.contains(&id))
            })
            .all(|c| active_ids.contains(&c["callId"])),
        "stream_activity_mismatch",
    )?;
    let after = host.submit_task(task(
        &sessions[0],
        Priority::Background,
        Work::Prompt("What is the project code? Reply with that code only.".into()),
    ))?;
    let compact = host.submit_task(task(&sessions[0], Priority::Manual, Work::Compact))?;
    let queued_cancel = host.submit_task(task(
        &sessions[0],
        Priority::Manual,
        Work::Prompt("W0_QUEUED_CANCEL_MUST_NOT_DISPATCH".into()),
    ))?;
    let queued = snapshot(host, "full_with_queue", started)?;
    require(
        queued["activeProviderCalls"] == 2
            && queued["activeLedgerCalls"] == 2
            && queued["queuedTasks"] == 3
            && queued["providerCalls"] == 4,
        "full_queue_dispatched_early",
    )?;
    host.cancel_task(queued_cancel)?;
    host.cancel_task(queued_cancel)?;
    let cancelled = host.wait_task(queued_cancel, Duration::from_secs(1))?;
    require(
        cancelled.status == Status::Cancelled && cancelled.request_id.is_none(),
        "queued_cancel_dispatched",
    )?;
    let queued_cancelled = snapshot(host, "queued_cancelled", started)?;
    require(
        queued_cancelled["activeProviderCalls"] == 2
            && queued_cancelled["queuedTasks"] == 2
            && queued_cancelled["providerCalls"] == 4,
        "queued_cancel_changed_active_calls",
    )?;
    host.cancel_task(blockers[0])?;
    require(
        host.wait_task(blockers[0], Duration::from_secs(30))?.status == Status::Cancelled,
        "first_cancel_failed",
    )?;
    let one_left = snapshot(host, "one_slot_free", started)?;
    require(
        one_left["activeProviderCalls"] == 1
            && one_left["activeLedgerCalls"] == 1
            && one_left["runningTasks"] == 1
            && one_left["queuedTasks"] == 2
            && one_left["providerCalls"] == 4,
        "compaction_did_not_wait_for_two_slots",
    )?;
    require(
        !host
            .usage
            .records()
            .iter()
            .any(|c| c["purpose"] == "compaction"),
        "compaction_started_with_one_slot",
    )?;
    host.cancel_task(blockers[1])?;
    require(
        host.wait_task(blockers[1], Duration::from_secs(30))?.status == Status::Cancelled,
        "second_cancel_failed",
    )?;
    let compacted = completed(host, compact)?;
    require(
        compacted
            .response
            .as_ref()
            .is_some_and(|r| r["summaryCommitted"] == true),
        "compaction_failed",
    )?;
    let compact_request = compacted.request_id.ok_or("task_request_missing")?;
    let recalled = completed(host, after)?;
    let after_request = recalled.request_id.ok_or("task_request_missing")?;
    require(
        compact_request < after_request,
        "manual_priority_not_observed",
    )?;
    let recalled_text = host
        .events
        .iter()
        .filter(|e| e["requestId"].as_u64() == Some(after_request))
        .filter_map(|e| e["text"].as_str())
        .collect::<String>();
    require(
        recalled_text.contains("W0-ALPHA"),
        "continuity_after_compaction_failed",
    )?;
    let drained = snapshot(host, "drained", started)?;
    let provider_calls = drained["providerCalls"]
        .as_u64()
        .ok_or("call_count_missing")?;
    require(
        drained["activeProviderCalls"] == 0
            && drained["activeLedgerCalls"] == 0
            && drained["queuedTasks"] == 0
            && drained["runningTasks"] == 0
            && (7..=8).contains(&provider_calls),
        "dual_tasks_not_drained",
    )?;
    require(
        drained["peakProviderCalls"] == 2 && drained["peakLedgerCalls"] == 2,
        "global_concurrency_not_exactly_two",
    )?;
    std::thread::sleep(Duration::from_millis(300));
    require(count(host)? == provider_calls, "unexpected_call_replay")?;
    let calls = host.usage.records();
    let allowed = [
        translation_request,
        before_request,
        blocker_requests[0],
        blocker_requests[1],
        compact_request,
        after_request,
    ];
    require(
        calls.len() as u64 == provider_calls
            && calls.iter().all(|c| {
                c["requestId"]
                    .as_u64()
                    .is_some_and(|r| allowed.contains(&r))
            }),
        "call_ledger_task_mismatch",
    )?;
    for request in &blocker_requests {
        let records: Vec<_> = calls
            .iter()
            .filter(|c| c["requestId"].as_u64() == Some(*request))
            .collect();
        require(
            records.len() == 1
                && matches!(
                    records[0]["usageState"].as_str(),
                    Some("unknown" | "partial")
                ),
            "cancel_usage_not_unknown_or_partial",
        )?;
    }
    let compact_calls: Vec<_> = calls
        .iter()
        .filter(|c| c["requestId"].as_u64() == Some(compact_request))
        .collect();
    require(
        workload.compaction_calls(compact_calls.len())
            && calls.len() == 5 + compact_calls.len()
            && compact_calls
                .iter()
                .all(|c| c["purpose"] == "compaction" && c["usageState"] == "reported"),
        "compaction_usage_missing",
    )?;
    require(
        calls
            .iter()
            .filter(|c| {
                !c["requestId"]
                    .as_u64()
                    .is_some_and(|r| blocker_requests.contains(&r))
            })
            .all(|c| c["usageState"] == "reported"),
        "completed_usage_missing",
    )?;
    for session in sessions {
        host.request("session.close", json!({"sessionId":session}))?;
    }
    host.recycle()?;
    require(host.pid().is_none(), "worker_not_reaped")?;
    Ok(
        json!({"passed":true,"scenario":"dual-saturation","providerCalls":provider_calls,"compactionCalls":compact_calls.len(),"peakActiveCalls":host.peak_active_calls(),"peakProviderCalls":drained["peakProviderCalls"],"calls":calls,
        "observations":[saturated,queued,queued_cancelled,one_left,drained],
        "tasks":{"translation":{"taskId":translation,"requestId":translation_request},"beforeCompaction":{"taskId":before,"requestId":before_request},"cancelledFirst":{"taskId":blockers[0],"requestId":blocker_requests[0]},"cancelledSecond":{"taskId":blockers[1],"requestId":blocker_requests[1]},"queuedCancelled":{"taskId":queued_cancel,"requestId":null},"compaction":{"taskId":compact,"requestId":compact_request},"afterCompaction":{"taskId":after,"requestId":after_request}},
        "checks":{"bothStreamsProducedText":true,"workerAndLedgerSaturated":true,"fullQueueNoDispatch":true,"queuedCancelNoDispatch":true,"oneSlotNotEnoughForCompaction":true,"bothRunningTasksCancelled":true,"compactionCallsAccounted":true,"priorityAndRecallPreserved":true,"globalConcurrencyExactlyTwo":true,"noAutomaticReplay":true,"allModelCallsQueued":true,"queueAndUsageDrained":true,"cleanShutdown":true},"pricingKnown":false,"cancelledCallBillingKnown":false}),
    )
}
