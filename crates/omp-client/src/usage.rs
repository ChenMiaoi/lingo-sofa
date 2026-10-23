use crate::Result;
use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

pub const MAX_ACTIVE: usize = 2;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub calls: u64,
    pub pending: u64,
    pub reported: u64,
    pub partial: u64,
    pub unknown: u64,
    pub not_dispatched: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total_tokens: u64,
    pub priced_calls: u64,
    pub unpriced: u64,
    pub estimated_cost: f64,
}
impl UsageTotals {
    fn update(&mut self, record: &Value, add: bool) {
        macro_rules! count {
            ($field:ident, $value:expr) => {
                if add {
                    self.$field += $value;
                } else {
                    self.$field -= $value;
                }
            };
        }
        if record["usageState"] == "not_dispatched" {
            count!(not_dispatched, 1);
            return;
        }
        count!(calls, 1);
        match record["usageState"].as_str() {
            Some("pending") => count!(pending, 1),
            Some("reported") => count!(reported, 1),
            Some("partial") => count!(partial, 1),
            Some("unknown") => count!(unknown, 1),
            _ => {}
        }
        for (field, bucket) in [
            (&mut self.input, "input"),
            (&mut self.output, "output"),
            (&mut self.cache_read, "cacheRead"),
            (&mut self.cache_write, "cacheWrite"),
            (&mut self.total_tokens, "totalTokens"),
        ] {
            let value = record["usage"][bucket].as_u64().unwrap_or(0);
            if add {
                *field += value;
            } else {
                *field -= value;
            }
        }
        if let Some(cost) = record["estimatedCost"].as_f64() {
            count!(priced_calls, 1);
            self.estimated_cost += if add { cost } else { -cost };
        } else {
            count!(unpriced, 1);
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub provider: String,
    pub model: String,
    pub totals: UsageTotals,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UsageReport {
    pub totals: UsageTotals,
    pub models: Vec<ModelUsage>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UsageSummary {
    pub active: usize,
    pub tokens: u64,
    pub estimated_cost: f64,
    pub unpriced: usize,
    pub unknown: usize,
}
impl UsageSummary {
    fn update(&mut self, record: &Value, add: bool) {
        let active = usize::from(record["usageState"] == "pending");
        let tokens = record["usage"]["totalTokens"].as_u64().unwrap_or(0);
        let cost = record["estimatedCost"].as_f64().unwrap_or(0.0);
        let unpriced = usize::from(
            record["usageState"] != "not_dispatched" && record["estimatedCost"].as_f64().is_none(),
        );
        let unknown =
            usize::from(record["usageState"] == "unknown" || record["usageState"] == "partial");
        if add {
            self.active += active;
            self.tokens += tokens;
            self.estimated_cost += cost;
            self.unpriced += unpriced;
            self.unknown += unknown;
        } else {
            self.active -= active;
            self.tokens -= tokens;
            self.estimated_cost -= cost;
            self.unpriced -= unpriced;
            self.unknown -= unknown;
        }
    }
}

// SQLite's exclusive connection also locks ownership until process exit.
pub struct UsageLedger {
    db: Connection,
    records: BTreeMap<String, Value>,
    summary: UsageSummary,
    sessions: BTreeMap<String, UsageSummary>,
    totals: UsageTotals,
    models: BTreeMap<(String, String), UsageTotals>,
}

impl UsageLedger {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path).map_err(|_| "ledger_open_failed")?;
        db.busy_timeout(std::time::Duration::ZERO)
            .map_err(|_| "ledger_open_failed")?;
        let version: u32 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| "ledger_open_failed")?;
        if version > 1 {
            return Err("ledger_version_unsupported");
        }
        db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS calls (call_id TEXT PRIMARY KEY, record TEXT NOT NULL); PRAGMA user_version=1; COMMIT;").map_err(|_| "ledger_locked_or_unavailable")?;
        let records = {
            let mut query = db
                .prepare("SELECT call_id, record FROM calls")
                .map_err(|_| "ledger_read_failed")?;
            let rows = query
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|_| "ledger_read_failed")?;
            let mut records = BTreeMap::new();
            for row in rows {
                let (id, text) = row.map_err(|_| "ledger_read_failed")?;
                records.insert(
                    id,
                    serde_json::from_str(&text).map_err(|_| "ledger_corrupt")?,
                );
            }
            records
        };
        let mut ledger = Self {
            db,
            records,
            summary: UsageSummary::default(),
            sessions: BTreeMap::new(),
            totals: UsageTotals::default(),
            models: BTreeMap::new(),
        };
        for record in ledger.records.values() {
            ledger.totals.update(record, true);
            ledger
                .models
                .entry(model_key(record)?)
                .or_default()
                .update(record, true);
            ledger.summary.update(record, true);
            ledger
                .sessions
                .entry(record["sessionId"].as_str().ok_or("ledger_corrupt")?.into())
                .or_default()
                .update(record, true);
        }
        ledger.mark_lost()?;
        Ok(ledger)
    }

    fn save(&mut self, call_id: &str, record: Value) -> Result<()> {
        let text = serde_json::to_string(&record).map_err(|_| "ledger_encode_failed")?;
        // Autocommit + FULL synchronization: no acknowledgement before commit.
        self.db.execute("INSERT INTO calls(call_id, record) VALUES (?1, ?2) ON CONFLICT(call_id) DO UPDATE SET record=excluded.record", params![call_id, text]).map_err(|_| "ledger_write_failed")?;
        if let Some(previous) = self.records.get(call_id) {
            self.totals.update(previous, false);
            self.models
                .get_mut(&model_key(previous)?)
                .unwrap()
                .update(previous, false);
            self.summary.update(previous, false);
            self.sessions
                .get_mut(previous["sessionId"].as_str().unwrap())
                .unwrap()
                .update(previous, false);
        }
        self.summary.update(&record, true);
        self.totals.update(&record, true);
        self.models
            .entry(model_key(&record)?)
            .or_default()
            .update(&record, true);
        self.sessions
            .entry(record["sessionId"].as_str().unwrap().into())
            .or_default()
            .update(&record, true);
        self.records.insert(call_id.into(), record);
        Ok(())
    }

    pub fn active(&self) -> usize {
        self.summary.active
    }

    pub fn summary(&self) -> UsageSummary {
        self.summary
    }
    // Clone aggregates only on explicit demand, never the raw per-call records.
    pub fn report(&self) -> UsageReport {
        UsageReport {
            totals: self.totals.clone(),
            models: self
                .models
                .iter()
                .map(|((provider, model), totals)| ModelUsage {
                    provider: provider.clone(),
                    model: model.clone(),
                    totals: totals.clone(),
                })
                .collect(),
        }
    }
    pub fn session_summary(&self, id: &str) -> UsageSummary {
        self.sessions.get(id).copied().unwrap_or_default()
    }

    pub fn acquire(&mut self, instance: &str, request_id: u64, event: &Value) -> Result<bool> {
        let mut record = scope(instance, request_id, event)?;
        let id = record["callId"].as_str().unwrap().to_owned();
        if self.records.contains_key(&id) {
            return Err("duplicate_call_start");
        }
        let admitted = self.active() < MAX_ACTIVE;
        record["type"] = json!(if admitted {
            "call_started"
        } else {
            "call_completed"
        });
        record["usageState"] = json!(if admitted {
            "pending"
        } else {
            "not_dispatched"
        });
        if !admitted {
            record["stopReason"] = json!("admission_busy");
        }
        self.save(&id, record)?;
        Ok(admitted)
    }

    pub fn complete(&mut self, instance: &str, request_id: u64, event: &Value) -> Result<()> {
        let mut record = scope(instance, request_id, event)?;
        let id = record["callId"].as_str().unwrap().to_owned();
        let previous = self.records.get(&id).ok_or("missing_call_start")?;
        for field in [
            "instance",
            "requestId",
            "purpose",
            "sessionId",
            "provider",
            "model",
        ] {
            if record[field] != previous[field] {
                return Err("call_scope_changed");
            }
        }
        let state = event["usageState"].as_str().ok_or("invalid_usage_state")?;
        let reason = event["stopReason"].as_str().ok_or("invalid_stop_reason")?;
        if !matches!(state, "reported" | "partial" | "unknown" | "not_dispatched")
            || !matches!(
                reason,
                "stop" | "length" | "toolUse" | "error" | "aborted" | "cancelled_before_dispatch"
            )
            || (state == "not_dispatched" && reason != "cancelled_before_dispatch")
        {
            return Err("invalid_call_terminal");
        }
        record["type"] = json!("call_completed");
        record["usageState"] = json!(state);
        record["stopReason"] = json!(reason);
        if matches!(state, "reported" | "partial") {
            let mut usage = json!({});
            for bucket in ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] {
                let count = event["usage"][bucket]
                    .as_u64()
                    .filter(|value| *value <= 9_007_199_254_740_991)
                    .ok_or("invalid_usage_count")?;
                usage[bucket] = json!(count);
            }
            if usage["totalTokens"] == 0 {
                return Err("invalid_usage_count");
            }
            record["usage"] = usage;
            if event["pricingKnown"] == true {
                let cost = event["estimatedCost"]
                    .as_f64()
                    .filter(|cost| cost.is_finite() && *cost >= 0.0)
                    .ok_or("invalid_usage_cost")?;
                record["pricingKnown"] = json!(true);
                record["estimatedCost"] = json!(cost);
            }
        }
        if previous["usageState"] != "pending" {
            return if previous == &record {
                Ok(())
            } else {
                Err("conflicting_call_terminal")
            };
        }
        self.save(&id, record)
    }

    pub fn mark_lost(&mut self) -> Result<()> {
        let lost: Vec<_> = self
            .records
            .iter()
            .filter(|(_, record)| record["usageState"] == "pending")
            .map(|(id, record)| (id.clone(), record.clone()))
            .collect();
        for (id, mut record) in lost {
            record["type"] = json!("call_completed");
            record["usageState"] = json!("unknown");
            record["stopReason"] = json!("worker_lost");
            self.save(&id, record)?;
        }
        Ok(())
    }

    pub fn records(&self) -> Vec<Value> {
        self.records.values().cloned().collect()
    }
}

fn model_key(record: &Value) -> Result<(String, String)> {
    Ok((
        record["provider"].as_str().ok_or("ledger_corrupt")?.into(),
        record["model"].as_str().ok_or("ledger_corrupt")?.into(),
    ))
}

fn scope(instance: &str, request_id: u64, event: &Value) -> Result<Value> {
    if event["requestId"].as_u64() != Some(request_id)
        || !matches!(event["purpose"].as_str(), Some("generation" | "compaction"))
    {
        return Err("invalid_call_scope");
    }
    let mut record = json!({"instance":instance,"requestId":request_id,"purpose":event["purpose"],"pricingKnown":false});
    for (field, max) in [
        ("callId", 64),
        ("sessionId", 64),
        ("provider", 128),
        ("model", 128),
    ] {
        let value = event[field]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= max)
            .ok_or("invalid_call_scope")?;
        record[field] = json!(value);
    }
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn call(id: &str) -> Value {
        json!({"callId":id,"requestId":2,"purpose":"compaction","sessionId":"session","provider":"test","model":"model"})
    }
    fn terminal(id: &str) -> Value {
        let mut event = call(id);
        event["usageState"] = json!("reported");
        event["stopReason"] = json!("stop");
        event["usage"] =
            json!({"input":10,"output":2,"cacheRead":4,"cacheWrite":0,"totalTokens":16});
        event
    }
    #[test]
    fn aggregates_follow_replacements_sessions_failed_writes_and_cold_rebuild() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.sqlite");
        let mut ledger = UsageLedger::open(&path).unwrap();
        ledger.acquire("worker", 2, &call("priced")).unwrap();
        assert_eq!(ledger.summary().unpriced, 1);
        let mut priced = terminal("priced");
        priced["pricingKnown"] = json!(true);
        priced["estimatedCost"] = json!(0.125);
        ledger.complete("worker", 2, &priced).unwrap();
        ledger.complete("worker", 2, &priced).unwrap();
        let mut other = call("pending");
        other["sessionId"] = json!("other");
        ledger.acquire("worker", 2, &other).unwrap();
        assert_eq!(ledger.summary().tokens, 16);
        assert_eq!(ledger.summary().active, 1);
        assert_eq!(ledger.session_summary("session").estimated_cost, 0.125);
        assert_eq!(ledger.session_summary("other").unpriced, 1);
        let before = ledger.summary();
        let before_session = ledger.session_summary("other");
        let before_records = ledger.records();
        let before_report = ledger.report();
        ledger.db.execute_batch("CREATE TRIGGER reject_usage BEFORE UPDATE ON calls BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;").unwrap();
        let mut completed = terminal("pending");
        completed["sessionId"] = json!("other");
        assert_eq!(
            ledger.complete("worker", 2, &completed),
            Err("ledger_write_failed")
        );
        assert_eq!(ledger.summary(), before);
        assert_eq!(ledger.session_summary("other"), before_session);
        assert_eq!(ledger.records(), before_records);
        assert_eq!(ledger.report(), before_report);
        ledger
            .db
            .execute_batch("DROP TRIGGER reject_usage")
            .unwrap();
        drop(ledger);
        let ledger = UsageLedger::open(&path).unwrap();
        assert_eq!(ledger.summary().tokens, 16);
        assert_eq!(ledger.summary().active, 0);
        assert_eq!(ledger.summary().unknown, 1);
        assert_eq!(ledger.summary().estimated_cost, 0.125);
        assert_eq!(ledger.session_summary("missing").tokens, 0);
    }
    #[test]
    fn model_report_groups_durable_calls_without_recounting_or_inventing_prices() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.sqlite");
        let mut ledger = UsageLedger::open(&path).unwrap();
        assert!(ledger.report().models.is_empty());
        let mut priced = terminal("priced");
        priced["pricingKnown"] = json!(true);
        priced["estimatedCost"] = json!(0.000000001);
        ledger.acquire("worker", 2, &call("priced")).unwrap();
        ledger.complete("worker", 2, &priced).unwrap();
        let once = ledger.report();
        ledger.complete("worker", 2, &priced).unwrap();
        assert_eq!(ledger.report(), once);
        ledger.acquire("worker", 2, &call("partial")).unwrap();
        let mut partial = terminal("partial");
        partial["usageState"] = json!("partial");
        ledger.complete("worker", 2, &partial).unwrap();
        ledger.acquire("worker", 2, &call("unknown")).unwrap();
        let mut unknown = terminal("unknown");
        unknown["usageState"] = json!("unknown");
        ledger.complete("worker", 2, &unknown).unwrap();
        let mut other = call("pending");
        other["provider"] = json!("other");
        other["prompt"] = json!("PRIVATE_PROMPT");
        other["apiKey"] = json!("PRIVATE_KEY");
        ledger.acquire("worker", 2, &other).unwrap();
        ledger.acquire("worker", 2, &call("cancelled")).unwrap();
        assert!(!ledger.acquire("worker", 2, &call("blocked")).unwrap());
        let mut cancelled = terminal("cancelled");
        cancelled["usageState"] = json!("not_dispatched");
        cancelled["stopReason"] = json!("cancelled_before_dispatch");
        ledger.complete("worker", 2, &cancelled).unwrap();
        let report = ledger.report();
        assert_eq!(report.models.len(), 2);
        assert_eq!(report.totals.calls, 4);
        assert_eq!(report.totals.pending, 1);
        assert_eq!(report.totals.partial, 1);
        assert_eq!(report.totals.unknown, 1);
        assert_eq!(report.totals.reported, 1);
        assert_eq!(report.totals.not_dispatched, 2);
        assert_eq!(report.totals.input, 20);
        assert_eq!(report.totals.output, 4);
        assert_eq!(report.totals.cache_read, 8);
        assert_eq!(report.totals.cache_write, 0);
        assert_eq!(report.totals.total_tokens, 32);
        assert_eq!(report.totals.priced_calls, 1);
        assert_eq!(report.totals.unpriced, 3);
        assert_eq!(report.totals.estimated_cost, 0.000000001);
        assert_eq!(report.models[0].provider, "other");
        assert_eq!(report.models[0].totals.pending, 1);
        assert_eq!(report.models[1].totals.calls, 3);
        let serialized = serde_json::to_string(&report).unwrap();
        for private in ["PRIVATE", "sessionId", "callId", "prompt", "apiKey"] {
            assert!(!serialized.contains(private));
        }
        drop(ledger);
        let ledger = UsageLedger::open(&path).unwrap();
        let mut rebuilt = report;
        rebuilt.totals.pending = 0;
        rebuilt.totals.unknown += 1;
        rebuilt.models[0].totals.pending = 0;
        rebuilt.models[0].totals.unknown = 1;
        assert_eq!(ledger.report(), rebuilt);
    }
    #[test]
    fn durable_terminal_is_idempotent_and_does_not_release_another_permit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.sqlite");
        let mut ledger = UsageLedger::open(&path).unwrap();
        assert!(ledger.acquire("worker", 2, &call("a")).unwrap());
        assert!(ledger.acquire("worker", 2, &call("b")).unwrap());
        assert!(!ledger.acquire("worker", 2, &call("busy")).unwrap());
        ledger.complete("worker", 2, &terminal("a")).unwrap();
        assert!(ledger.acquire("worker", 2, &call("c")).unwrap());
        ledger.complete("worker", 2, &terminal("a")).unwrap();
        assert_eq!(ledger.active(), 2);
        assert!(!ledger.acquire("worker", 2, &call("still-busy")).unwrap());
        let mut conflict = terminal("a");
        conflict["usage"]["output"] = json!(3);
        assert_eq!(
            ledger.complete("worker", 2, &conflict),
            Err("conflicting_call_terminal")
        );
        assert_eq!(
            ledger.complete("other", 2, &terminal("a")),
            Err("call_scope_changed")
        );
        drop(ledger);
        let mut ledger = UsageLedger::open(&path).unwrap();
        assert_eq!(ledger.active(), 0);
        assert_eq!(
            ledger
                .records()
                .iter()
                .filter(|r| r["usageState"] == "unknown")
                .count(),
            2
        );
        ledger.complete("worker", 2, &terminal("a")).unwrap();
        assert_eq!(
            ledger
                .records()
                .iter()
                .filter(|r| r["usageState"] == "reported")
                .count(),
            1
        );
    }
    #[test]
    fn sdk_price_estimates_are_durable_and_unknown_costs_are_not_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.sqlite");
        let mut ledger = UsageLedger::open(&path).unwrap();
        ledger.acquire("worker", 2, &call("priced")).unwrap();
        let mut priced = terminal("priced");
        priced["pricingKnown"] = json!(true);
        priced["estimatedCost"] = json!(0.125);
        ledger.complete("worker", 2, &priced).unwrap();
        ledger.complete("worker", 2, &priced).unwrap();
        ledger.acquire("worker", 2, &call("subscription")).unwrap();
        ledger
            .complete("worker", 2, &terminal("subscription"))
            .unwrap();
        drop(ledger);
        let ledger = UsageLedger::open(&path).unwrap();
        let records = ledger.records();
        assert_eq!(
            records
                .iter()
                .filter_map(|r| r["estimatedCost"].as_f64())
                .sum::<f64>(),
            0.125
        );
        assert!(
            records
                .iter()
                .find(|r| r["callId"] == "subscription")
                .unwrap()["estimatedCost"]
                .is_null()
        );
    }
    #[test]
    fn exclusive_owner_and_write_failure_fail_closed_without_sensitive_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("usage.sqlite");
        let mut ledger = UsageLedger::open(&path).unwrap();
        assert!(UsageLedger::open(&path).is_err());
        ledger.db.execute_batch("CREATE TRIGGER fail BEFORE INSERT ON calls BEGIN SELECT RAISE(ABORT, 'test'); END;").unwrap();
        assert_eq!(
            ledger.acquire("worker", 2, &call("a")),
            Err("ledger_write_failed")
        );
        assert_eq!(ledger.active(), 0);
        ledger.db.execute_batch("DROP TRIGGER fail;").unwrap();
        let mut event = call("a");
        event["prompt"] = json!("PRIVATE_PROMPT");
        event["apiKey"] = json!("PRIVATE_KEY");
        ledger.acquire("worker", 2, &event).unwrap();
        ledger.db.execute_batch("CREATE TRIGGER fail BEFORE UPDATE ON calls BEGIN SELECT RAISE(ABORT, 'test'); END;").unwrap();
        assert!(ledger.complete("worker", 2, &terminal("a")).is_err());
        assert_eq!(ledger.active(), 1);
        ledger.db.execute_batch("DROP TRIGGER fail;").unwrap();
        let mut invalid = terminal("a");
        invalid["usage"]["input"] = json!(-1);
        assert!(ledger.complete("worker", 2, &invalid).is_err());
        ledger.mark_lost().unwrap();
        assert!(ledger.records()[0]["usage"].is_null());
        drop(ledger);
        let bytes = std::fs::read(path).unwrap();
        assert!(!bytes.windows(7).any(|s| s == b"PRIVATE"));
    }
}
