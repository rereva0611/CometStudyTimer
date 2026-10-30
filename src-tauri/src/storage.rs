use chrono::{Duration as DateDuration, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::Path;

pub struct Store {
    connection: Connection,
    backups: Option<crate::auto_backups::AutoBackups>,
}
impl Store {
    #[cfg(feature = "native-qa")]
    pub fn qa_set_read_only(&self, enabled: bool) -> Result<(), String> {
        self.connection
            .pragma_update(None, "query_only", enabled)
            .map_err(db_error)?;
        let actual: bool = self
            .connection
            .pragma_query_value(None, "query_only", |row| row.get(0))
            .map_err(db_error)?;
        if actual != enabled {
            return Err("SQLite did not apply the requested QA write policy.".into());
        }
        Ok(())
    }
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection =
            Connection::open(path).map_err(|e| format!("Unable to open Comet data: {e}"))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS state_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0)); INSERT OR IGNORE INTO state_revision VALUES(1,0);").map_err(db_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("Unable to protect Comet data: {e}"))?;
        }
        Ok(Self {
            connection,
            backups: None,
        })
    }
    pub fn open_with_backups(path: &Path, directory: &Path) -> Result<Self, String> {
        let mut store = Self::open(path)?;
        let mut backups = crate::auto_backups::AutoBackups::new(directory);
        if let Some(value) = store.load()? {
            backups.refresh(&value);
        }
        store.backups = Some(backups);
        Ok(store)
    }
    pub fn backup_status(&self) -> Option<String> {
        self.backups.as_ref().and_then(|b| b.status())
    }
    pub fn list_auto_backups(&self) -> Result<Vec<Value>, String> {
        self.backups
            .as_ref()
            .ok_or("Automatic backups are unavailable.")?
            .list()
    }
    pub fn restore_auto_backup(&mut self, id: &str) -> Result<Value, String> {
        let backups = self
            .backups
            .as_ref()
            .ok_or("Automatic backups are unavailable.")?;
        let snapshot = backups.read(id)?;
        let mut current = self
            .load()?
            .ok_or("No current Comet state is available to protect.")?;
        backups.preserve_recovery(&current)?;
        current["records"] = snapshot["records"].clone();
        current["goal"] = snapshot["goal"].clone();
        current["lastTimerSessionId"] = snapshot
            .get("lastTimerSessionId")
            .cloned()
            .unwrap_or(Value::Null);
        self.save(&current)?;
        Ok(current)
    }
    pub fn load(&self) -> Result<Option<Value>, String> {
        let text: Option<String> = self
            .connection
            .query_row("SELECT payload FROM state WHERE id=1", [], |r| r.get(0))
            .optional()
            .map_err(db_error)?;
        text.map(|text| decode_saved_state(&text)).transpose()
    }

    pub fn load_snapshot(&self) -> Result<Value, String> {
        // One SQLite statement gives a consistent payload/revision pair even
        // when another connection commits between reads.
        let (text, revision): (Option<String>, i64) = self.connection.query_row(
            "SELECT state.payload,state_revision.revision FROM state_revision LEFT JOIN state ON state.id=state_revision.id WHERE state_revision.id=1",
            [], |row| Ok((row.get(0)?,row.get(1)?))).map_err(db_error)?;
        let value = text.map(|text| decode_saved_state(&text)).transpose()?;
        Ok(serde_json::json!({"value":value,"revision":revision}))
    }
    pub fn save(&mut self, value: &Value) -> Result<(), String> {
        self.write(value, None).map(|_| ())
    }
    pub fn save_checked(&mut self, value: &Value, expected_revision: u64) -> Result<Value, String> {
        self.write(value, Some(expected_revision))
    }
    fn write(&mut self, value: &Value, expected_revision: Option<u64>) -> Result<Value, String> {
        validate_state(value)?;
        let text = serde_json::to_string(value)
            .map_err(|e| format!("Unable to encode Comet data: {e}"))?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let revision: i64 = transaction
            .query_row("SELECT revision FROM state_revision WHERE id=1", [], |r| {
                r.get(0)
            })
            .map_err(db_error)?;
        let revision = revision as u64;
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(format!(
                "COMET_STATE_CONFLICT: expected revision {}, current revision {revision}",
                expected_revision.unwrap()
            ));
        }
        let next = revision
            .checked_add(1)
            .filter(|n| *n <= i64::MAX as u64)
            .ok_or("Comet revision limit reached.")?;
        let current = if self.backups.is_some() {
            let text: Option<String> = transaction
                .query_row("SELECT payload FROM state WHERE id=1", [], |r| r.get(0))
                .optional()
                .map_err(db_error)?;
            text.map(|text| decode_saved_state(&text)).transpose()?
        } else {
            None
        };
        if let (Some(backups), Some(current)) = (&mut self.backups, current.as_ref()) {
            backups.before_save(current);
        }
        transaction.execute("INSERT INTO state (id,payload) VALUES (1,?1) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",params![text]).map_err(db_error)?;
        transaction
            .execute(
                "UPDATE state_revision SET revision=?1 WHERE id=1",
                params![next as i64],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        if let Some(backups) = &mut self.backups {
            backups.refresh(value);
        }
        Ok(serde_json::json!({"value":value,"revision":next}))
    }
    pub fn pause_at(&mut self, now: i64) -> Result<(), String> {
        let Some(mut value) = self.load()? else {
            return Ok(());
        };
        if value["timer"]["startedAt"].is_null() {
            return Ok(());
        }
        let mut from = value["timer"]["startedAt"]
            .as_i64()
            .ok_or("Invalid saved timer start.")?;
        if now < from {
            return Err("Your device clock changed. Correct it before quitting Comet.".into());
        }
        let started = from;
        while from < now {
            let date = Local
                .timestamp_millis_opt(from)
                .single()
                .ok_or("Invalid saved timer date.")?;
            let key = date.format("%Y-%m-%d").to_string();
            let next = date
                .date_naive()
                .succ_opt()
                .ok_or("Invalid timer date.")?
                .and_hms_opt(0, 0, 0)
                .unwrap();
            // A midnight skipped by a timezone transition belongs to the next day too.
            let midnight = (0..=180)
                .find_map(|m| {
                    Local
                        .from_local_datetime(&(next + DateDuration::minutes(m)))
                        .earliest()
                })
                .ok_or("Unable to find the next local day.")?
                .timestamp_millis();
            let end = now.min(midnight);
            if end <= from {
                return Err("Unable to split this timer across local days.".into());
            }
            let old = value["timer"]["allocations"][&key].as_f64().unwrap_or(0.0);
            let total = old + (end - from) as f64;
            value["timer"]["allocations"][&key] =
                if total.fract() == 0.0 && total <= i64::MAX as f64 {
                    Value::from(total as i64)
                } else {
                    Value::from(total)
                };
            from = end;
        }
        if now > started {
            if let Some(intervals) = value["timer"]
                .get_mut("intervals")
                .and_then(Value::as_array_mut)
            {
                intervals.push(serde_json::json!({"start":started,"end":now}));
            }
        }
        value["timer"]["startedAt"] = Value::Null;
        self.save(&value)
    }
}

// Version 1.3.5 could leave this optional pointer behind after a session was
// deleted or changed to a manual entry. Normalize only loaded database state;
// imported snapshot files still pass strict validate_state without this repair.
fn decode_saved_state(text: &str) -> Result<Value, String> {
    let mut value: Value = serde_json::from_str(text)
        .map_err(|_| "Saved Comet data is damaged. Keep your database for recovery.".to_owned())?;
    let stale = value
        .get("lastTimerSessionId")
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 100
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_:-".contains(&b))
        })
        .is_some_and(|id| {
            !value["records"].as_object().is_some_and(|records| {
                records.values().any(|day| {
                    day["sessions"].as_array().is_some_and(|sessions| {
                        sessions.iter().any(|session| {
                            session["id"].as_str() == Some(id) && session["source"] == "timer"
                        })
                    })
                })
            })
        });
    if stale {
        value["lastTimerSessionId"] = Value::Null;
    }
    validate_state(&value)?;
    Ok(value)
}

fn db_error(e: rusqlite::Error) -> String {
    format!("Unable to save or read Comet data: {e}. Check disk space and permissions.")
}
fn date_key(key: &str) -> Option<NaiveDate> {
    if key.len() != 10
        || key.as_bytes()[4] != b'-'
        || key.as_bytes()[7] != b'-'
        || !key
            .as_bytes()
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return None;
    }
    let date = NaiveDate::parse_from_str(key, "%Y-%m-%d").ok()?;
    if key < "1900-01-01" || date.format("%Y-%m-%d").to_string() != key {
        return None;
    }
    Some(date)
}
pub fn validate_state(value: &Value) -> Result<(), String> {
    let fail = || "Invalid Comet state. Your previous saved data has been kept.".to_owned();
    if value["version"].as_u64() != Some(1) {
        return Err(fail());
    }
    let records = value["records"].as_object().ok_or_else(fail)?;
    if records.len() > 50000 {
        return Err(fail());
    }
    // A saved civil day can be ahead of this device after travelling west.
    let today = Local::now()
        .date_naive()
        .max((Utc::now() + DateDuration::hours(14)).date_naive());
    let mut ids = std::collections::HashSet::new();
    for (key, record) in records {
        if date_key(key).is_none_or(|d| d > today)
            || record["seconds"].as_u64().is_none_or(|n| n > 86400)
            || record
                .get("note")
                .is_some_and(|n| n.as_str().is_none_or(|s| s.chars().count() > 120))
        {
            return Err(fail());
        }
        if let Some(sessions) = record.get("sessions") {
            let sessions = sessions.as_array().ok_or_else(fail)?;
            let note = record
                .get("note")
                .and_then(Value::as_str)
                .ok_or_else(fail)?;
            let date = date_key(key).ok_or_else(fail)?;
            let mut total = 0u64;
            for session in sessions {
                let id = session["id"].as_str().ok_or_else(fail)?;
                if id.is_empty()
                    || id.len() > 100
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_:-".contains(&b))
                    || !ids.insert(id)
                    || ids.len() > 50000
                {
                    return Err(fail());
                }
                let seconds = session["seconds"]
                    .as_u64()
                    .filter(|n| (1..=86400).contains(n))
                    .ok_or_else(fail)?;
                let _subject = session["note"]
                    .as_str()
                    .filter(|s| s.chars().count() <= 120)
                    .ok_or_else(fail)?;
                if !matches!(
                    session["source"].as_str(),
                    Some("legacy" | "manual" | "timer")
                ) {
                    return Err(fail());
                }
                let start = session.get("start").ok_or_else(fail)?;
                let end = session.get("end").ok_or_else(fail)?;
                if start.is_null() && end.is_null() {
                    if session.get("utcOffsets").is_some() {
                        return Err(fail());
                    }
                } else {
                    let a = start
                        .as_i64()
                        .filter(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
                        .ok_or_else(fail)?;
                    let b = end
                        .as_i64()
                        .filter(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
                        .ok_or_else(fail)?;
                    let lo = date
                        .and_hms_opt(0, 0, 0)
                        .unwrap()
                        .and_utc()
                        .timestamp_millis();
                    let hi = lo + 86_400_000;
                    if b <= a || b - a > 26 * 3_600_000 || seconds > ((b - a) / 1000) as u64 {
                        return Err(fail());
                    }
                    if let Some(offsets) = session.get("utcOffsets") {
                        let offsets = offsets
                            .as_object()
                            .filter(|o| o.len() == 2)
                            .ok_or_else(fail)?;
                        let start_offset = offsets
                            .get("start")
                            .and_then(Value::as_i64)
                            .filter(|n| (-840..=840).contains(n))
                            .ok_or_else(fail)?;
                        let end_offset = offsets
                            .get("end")
                            .and_then(Value::as_i64)
                            .filter(|n| (-840..=840).contains(n))
                            .ok_or_else(fail)?;
                        let wall_start = a + start_offset * 60_000;
                        let wall_end = b + end_offset * 60_000;
                        if wall_start < lo || wall_start >= hi || wall_end < lo || wall_end > hi {
                            return Err(fail());
                        }
                    } else if a < lo - 840 * 60_000
                        || a >= hi + 840 * 60_000
                        || b <= lo - 840 * 60_000
                        || b > hi + 840 * 60_000
                    {
                        return Err(fail());
                    }
                }
                total = total.checked_add(seconds).ok_or_else(fail)?;
            }
            if total != record["seconds"].as_u64().ok_or_else(fail)?
                || sessions
                    .last()
                    .is_some_and(|session| session["note"].as_str() != Some(note))
            {
                return Err(fail());
            }
        }
    }
    if let Some(id) = value.get("lastTimerSessionId").filter(|id| !id.is_null()) {
        let id = id.as_str().ok_or_else(fail)?;
        if !records.values().any(|day| {
            day["sessions"].as_array().is_some_and(|sessions| {
                sessions.iter().any(|session| {
                    session["id"].as_str() == Some(id) && session["source"] == "timer"
                })
            })
        }) {
            return Err(fail());
        }
    }
    if value["goal"]
        .as_u64()
        .is_none_or(|g| !(5..=1440).contains(&g))
    {
        return Err(fail());
    }
    let timer = value["timer"].as_object().ok_or_else(fail)?;
    let start = timer.get("startedAt").ok_or_else(fail)?;
    if !start.is_null()
        && start
            .as_i64()
            .is_none_or(|s| s < 0 || Local.timestamp_millis_opt(s).single().is_none())
    {
        return Err(fail());
    }
    let allocations = timer
        .get("allocations")
        .and_then(Value::as_object)
        .ok_or_else(fail)?;
    if allocations.len() > 50000
        || allocations.iter().any(|(k, n)| {
            date_key(k).is_none() || n.as_f64().is_none_or(|ms| !ms.is_finite() || ms < 0.0)
        })
    {
        return Err(fail());
    }
    if let Some(intervals) = timer.get("intervals") {
        let intervals = intervals.as_array().ok_or_else(fail)?;
        if intervals.len() > 50000 {
            return Err(fail());
        }
        let mut previous = None;
        for interval in intervals {
            let a = interval["start"].as_i64().ok_or_else(fail)?;
            let b = interval["end"].as_i64().ok_or_else(fail)?;
            if a < 0
                || b <= a
                || Local.timestamp_millis_opt(a).single().is_none()
                || Local.timestamp_millis_opt(b).single().is_none()
                || previous.is_some_and(|p| a < p)
            {
                return Err(fail());
            }
            previous = Some(b);
        }
        if let (Some(end), Some(start)) = (previous, start.as_i64()) {
            if start < end {
                return Err(fail());
            }
        }
    }
    if timer
        .get("note")
        .and_then(Value::as_str)
        .is_none_or(|s| s.chars().count() > 120)
    {
        return Err(fail());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, TimeZone};
    use serde_json::json;
    fn state() -> Value {
        json!({"version":1,"records":{"2026-01-01":{"seconds":90,"note":"Math"}},"goal":60,"timer":{"startedAt":null,"allocations":{},"note":""}})
    }
    fn timezone_state() -> Value {
        let mut value = state();
        value["records"] = json!({"2026-01-01":{"seconds":3600,"note":"Saved", "sessions":[{"id":"timer:one","seconds":3600,"note":"Saved","source":"timer","start":1767196800000_i64,"end":1767200400000_i64}]}});
        value["lastTimerSessionId"] = json!("timer:one");
        value
    }
    #[test]
    fn timezone_records_load_in_isolated_timezones() {
        const CHILD: &str = "COMET_TIMEZONE_LOAD_CHILD";
        if std::env::var_os(CHILD).is_none() {
            for zone in ["UTC", "America/New_York", "Pacific/Honolulu"] {
                assert!(
                    std::process::Command::new(std::env::current_exe().unwrap())
                        .args([
                            "--exact",
                            "storage::tests::timezone_records_load_in_isolated_timezones"
                        ])
                        .env("TZ", zone)
                        .env(CHILD, "1")
                        .status()
                        .unwrap()
                        .success(),
                    "load failed in {zone}"
                );
            }
            return;
        }
        let dir = tempfile::Builder::new()
            .prefix("comet-cross-tz-")
            .tempdir_in("/tmp")
            .unwrap();
        let path = dir.path().join("db");
        let mut db = Store::open(&path).unwrap();
        let legacy = timezone_state();
        db.save(&legacy).unwrap();
        drop(db);
        let mut db = Store::open(&path).unwrap();
        assert_eq!(db.load().unwrap().unwrap(), legacy);
        let mut explicit = legacy.clone();
        explicit["records"]["2026-01-01"]["sessions"][0]["utcOffsets"] =
            json!({"start":480,"end":480});
        db.save(&explicit).unwrap();
        assert_eq!(db.load().unwrap().unwrap(), explicit);
        let latest = (Utc::now() + DateDuration::hours(14))
            .format("%Y-%m-%d")
            .to_string();
        let mut global_day = state();
        global_day["records"] = json!({latest:{"seconds":60,"note":"Travel"}});
        db.save(&global_day).unwrap();
        assert_eq!(db.load().unwrap().unwrap(), global_day);
    }
    #[test]
    fn recorded_offsets_support_dst_fold_and_exact_next_midnight() {
        let mut value = timezone_state();
        let date = "2026-01-01";
        let start = chrono::DateTime::parse_from_rfc3339("2026-01-01T23:00:00+08:00")
            .unwrap()
            .timestamp_millis();
        value["records"][date]["sessions"][0]["start"] = json!(start);
        value["records"][date]["sessions"][0]["end"] = json!(start + 3_600_000);
        value["records"][date]["sessions"][0]["utcOffsets"] = json!({"start":480,"end":480});
        assert!(validate_state(&value).is_ok());
        value["records"][date]["sessions"][0]["end"] = json!(start + 3_600_001);
        assert!(validate_state(&value).is_err());
        // A fall-back day has different offsets at its two known endpoints.
        let mut session = value["records"][date]["sessions"][0].clone();
        session["start"] = json!(
            chrono::DateTime::parse_from_rfc3339("2025-11-02T00:30:00-04:00")
                .unwrap()
                .timestamp_millis()
        );
        session["end"] = json!(
            chrono::DateTime::parse_from_rfc3339("2025-11-02T02:30:00-05:00")
                .unwrap()
                .timestamp_millis()
        );
        session["utcOffsets"] = json!({"start":-240,"end":-300});
        value["records"] =
            json!({"2025-11-02":{"seconds":3600,"note":"Saved","sessions":[session]}});
        assert!(validate_state(&value).is_ok());
    }
    #[test]
    fn legacy_epochs_validate_independently_of_machine_zone_and_new_offsets_are_checked() {
        let legacy = timezone_state();
        assert!(validate_state(&legacy).is_ok());
        let mut explicit = legacy.clone();
        explicit["records"]["2026-01-01"]["sessions"][0]["utcOffsets"] =
            json!({"start":480,"end":480});
        assert!(validate_state(&explicit).is_ok());
        for offsets in [
            json!({"start":0,"end":0}),
            json!({"start":841,"end":480}),
            json!({"start":480}),
            Value::Null,
        ] {
            explicit["records"]["2026-01-01"]["sessions"][0]["utcOffsets"] = offsets;
            assert!(validate_state(&explicit).is_err());
        }
        let mut unrelated = legacy;
        unrelated["records"]["2026-01-01"]["sessions"][0]["start"] = json!(0);
        unrelated["records"]["2026-01-01"]["sessions"][0]["end"] = json!(3600000);
        assert!(validate_state(&unrelated).is_err());
    }
    #[test]
    fn automatic_restore_and_recovery_keep_saved_timer_identity_and_old_restore_clears_it() {
        let dir = tempfile::Builder::new()
            .prefix("comet-tz-backup-")
            .tempdir_in("/tmp")
            .unwrap();
        let mut db =
            Store::open_with_backups(&dir.path().join("db"), &dir.path().join("backups")).unwrap();
        let original = timezone_state();
        db.save(&original).unwrap();
        let mut changed = original.clone();
        changed["records"]["2026-01-01"]["sessions"][0]["id"] = json!("timer:two");
        changed["lastTimerSessionId"] = json!("timer:two");
        db.save(&changed).unwrap();
        // An independent safety snapshot cannot be replaced by the daily refresh.
        db.backups
            .as_ref()
            .unwrap()
            .preserve_recovery(&original)
            .unwrap();
        let old_id = db
            .list_auto_backups()
            .unwrap()
            .into_iter()
            .find(|row| row["kind"] == "recovery")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let restored = db.restore_auto_backup(&old_id).unwrap();
        assert_eq!(restored["lastTimerSessionId"], "timer:one");
        let recovery_values: Vec<_> = db
            .list_auto_backups()
            .unwrap()
            .iter()
            .filter(|row| row["kind"] == "recovery")
            .map(|row| {
                db.backups
                    .as_ref()
                    .unwrap()
                    .read(row["id"].as_str().unwrap())
                    .unwrap()
            })
            .collect();
        assert!(recovery_values
            .iter()
            .any(|v| v["lastTimerSessionId"] == "timer:two"));
        let old = json!({"version":1,"goal":60,"records":state()["records"],"exportedAt":"2026-01-01T00:00:00Z"});
        std::fs::write(
            dir.path().join("backups/auto-2026-01-01.json"),
            old.to_string(),
        )
        .unwrap();
        assert!(
            db.restore_auto_backup("auto-2026-01-01.json").unwrap()["lastTimerSessionId"].is_null()
        );
    }
    #[test]
    fn legacy_dangling_task_identity_loads_without_rewriting_raw_database() {
        for non_timer in [false, true] {
            let dir = tempfile::Builder::new()
                .prefix("comet-legacy-task-")
                .tempdir_in("/tmp")
                .unwrap();
            let path = dir.path().join("db");
            let mut legacy = timezone_state();
            if non_timer {
                legacy["records"]["2026-01-01"]["sessions"][0]["source"] = json!("manual");
            } else {
                legacy["lastTimerSessionId"] = json!("timer:deleted");
            }
            let raw = legacy.to_string();
            let db = Store::open(&path).unwrap();
            db.connection
                .execute(
                    "INSERT INTO state (id,payload) VALUES (1,?1)",
                    params![&raw],
                )
                .unwrap();
            drop(db);
            let db = Store::open_with_backups(&path, &dir.path().join("backups")).unwrap();
            let loaded = db.load().unwrap().unwrap();
            assert_eq!(loaded["lastTimerSessionId"], Value::Null);
            assert_eq!(loaded["records"], legacy["records"]);
            assert_eq!(
                db.load_snapshot().unwrap(),
                json!({"value":loaded,"revision":0})
            );
            let stored: String = db
                .connection
                .query_row("SELECT payload FROM state WHERE id=1", [], |row| row.get(0))
                .unwrap();
            assert_eq!(stored, raw);
            let snapshot = db.list_auto_backups().unwrap().into_iter().next().unwrap();
            let backup = db
                .backups
                .as_ref()
                .unwrap()
                .read(snapshot["id"].as_str().unwrap())
                .unwrap();
            assert_eq!(backup["lastTimerSessionId"], Value::Null);
            assert_eq!(backup["records"], legacy["records"]);
            for malformed in [json!(12), json!("bad space")] {
                let mut bad = legacy.clone();
                bad["lastTimerSessionId"] = malformed;
                db.connection
                    .execute(
                        "UPDATE state SET payload=?1 WHERE id=1",
                        params![bad.to_string()],
                    )
                    .unwrap();
                assert!(db.load().is_err());
                assert!(db.load_snapshot().is_err());
            }
        }
    }
    #[test]
    fn timer_identity_rejects_invalid_or_unrelated_ids() {
        for id in [json!(12), json!("bad space"), json!("missing")] {
            let mut value = timezone_state();
            value["lastTimerSessionId"] = id;
            assert!(validate_state(&value).is_err());
        }
    }
    #[test]
    fn revision_migrates_legacy_database_and_checked_writes_reject_stale_connections() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let legacy = Connection::open(&path).unwrap();
        legacy
            .execute_batch("CREATE TABLE state(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);")
            .unwrap();
        legacy
            .execute("INSERT INTO state VALUES(1,?1)", [state().to_string()])
            .unwrap();
        drop(legacy);
        let mut a = Store::open(&path).unwrap();
        let mut b = Store::open(&path).unwrap();
        assert_eq!(
            a.load_snapshot().unwrap(),
            json!({"value":state(),"revision":0})
        );
        let mut changed = state();
        changed["goal"] = json!(90);
        assert_eq!(a.save_checked(&changed, 0).unwrap()["revision"], 1);
        assert!(b
            .save_checked(&state(), 0)
            .unwrap_err()
            .starts_with("COMET_STATE_CONFLICT"));
        assert_eq!(
            b.load_snapshot().unwrap(),
            json!({"value":changed,"revision":1})
        );
        b.save(&state()).unwrap();
        assert_eq!(a.load_snapshot().unwrap()["revision"], 2);
    }
    #[test]
    fn conflict_has_no_backup_effect_and_pause_and_restore_advance_revision() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        let mut db = Store::open_with_backups(&dir.path().join("db"), &folder).unwrap();
        assert_eq!(
            db.load_snapshot().unwrap(),
            json!({"value":null,"revision":0})
        );
        let mut running = state();
        running["timer"]["startedAt"] = json!(1768000000000_i64);
        db.save_checked(&running, 0).unwrap();
        let files = || {
            let mut entries: Vec<_> = std::fs::read_dir(&folder)
                .unwrap()
                .map(|e| {
                    let e = e.unwrap();
                    (
                        e.file_name(),
                        std::fs::read(e.path()).unwrap(),
                        e.metadata().unwrap().modified().unwrap(),
                    )
                })
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            entries
        };
        let before = files();
        assert!(db
            .save_checked(&state(), 0)
            .unwrap_err()
            .starts_with("COMET_STATE_CONFLICT"));
        assert_eq!(before, files());
        db.pause_at(1768000001000).unwrap();
        assert_eq!(db.load_snapshot().unwrap()["revision"], 2);
        db.pause_at(1768000002000).unwrap();
        assert_eq!(db.load_snapshot().unwrap()["revision"], 2);
        let id = db.list_auto_backups().unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        db.restore_auto_backup(&id).unwrap();
        assert_eq!(db.load_snapshot().unwrap()["revision"], 3);
    }
    #[test]
    fn simultaneous_checked_writers_have_exactly_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let a = Store::open(&path).unwrap();
        let b = Store::open(&path).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = [a, b]
            .into_iter()
            .enumerate()
            .map(|(n, mut store)| {
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut value = state();
                    value["goal"] = json!(60 + n * 30);
                    barrier.wait();
                    store.save_checked(&value, 0)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert!(results
            .iter()
            .find_map(|r| r.as_ref().err())
            .unwrap()
            .starts_with("COMET_STATE_CONFLICT"));
        assert_eq!(
            Store::open(&path).unwrap().load_snapshot().unwrap()["revision"],
            1
        );
    }
    fn rich_state() -> Value {
        let mut x = state();
        x["records"]["2026-01-01"]["sessions"] = json!([{"id":"s:1","seconds":90,"note":"Math","start":null,"end":null,"source":"legacy"}]);
        x
    }
    #[test]
    fn rich_validation_rejects_malformed_sessions_and_intervals() {
        assert!(validate_state(&rich_state()).is_ok());
        let mut variants = Vec::new();
        for (field, value) in [
            ("seconds", json!(91)),
            ("id", json!("bad id")),
            ("source", json!("other")),
            ("start", json!(1)),
            ("note", json!("different")),
        ] {
            let mut x = rich_state();
            x["records"]["2026-01-01"]["sessions"][0][field] = value;
            variants.push(x);
        }
        let mut x = rich_state();
        x["records"]["2026-01-02"] = x["records"]["2026-01-01"].clone();
        variants.push(x);
        let mut x = rich_state();
        x["timer"]["intervals"] = json!([{"start":20,"end":10}]);
        variants.push(x);
        for x in variants {
            assert!(validate_state(&x).is_err(), "accepted {x}");
        }
    }
    #[test]
    fn rich_sessions_accept_skipped_midnight_in_isolated_timezone() {
        const CHILD: &str = "COMET_SKIPPED_MIDNIGHT_TEST";
        if std::env::var_os(CHILD).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "storage::tests::rich_sessions_accept_skipped_midnight_in_isolated_timezone",
                    "--nocapture",
                ])
                .env("TZ", "America/Sao_Paulo")
                .env(CHILD, "1")
                .status()
                .unwrap();
            assert!(
                status.success(),
                "isolated skipped-midnight validation failed"
            );
            return;
        }
        // JS new Date(2018, 10, 4) resolves to 01:00, the first valid instant.
        let first = 1_541_300_400_000_i64;
        let date = NaiveDate::from_ymd_opt(2018, 11, 4).unwrap();
        let boundary = Local
            .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
            .earliest()
            .unwrap();
        assert_eq!(boundary.timestamp_millis(), first);
        assert_eq!(
            Local
                .timestamp_millis_opt(first)
                .single()
                .unwrap()
                .naive_local(),
            date.and_hms_opt(1, 0, 0).unwrap()
        );
        let make = |day: &str, start: i64, end: i64| {
            let mut x = state();
            x["records"] = json!({day: {"seconds":60,"note":"Math","sessions":[{"id":"dst","seconds":60,"note":"Math","start":start,"end":end,"source":"manual","utcOffsets":{"start":Local.timestamp_millis_opt(start).single().unwrap().offset().local_minus_utc()/60,"end":Local.timestamp_millis_opt(end-1).single().unwrap().offset().local_minus_utc()/60}}]}});
            x
        };
        assert!(validate_state(&make("2018-11-04", first, first + 60_000)).is_ok());
        assert!(validate_state(&make("2018-11-03", first - 60_000, first)).is_ok());
        let last = Local
            .with_ymd_and_hms(2018, 11, 5, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        assert!(validate_state(&make("2018-11-04", last - 60_000, last)).is_ok());
        for (day, start, end) in [
            ("2018-11-04", first - 1, first + 60_000),
            ("2018-11-04", first, first + 59_999),
            ("2018-11-04", last - 60_000, last + 1),
            ("2018-11-03", first - 60_000, first + 1),
        ] {
            assert!(validate_state(&make(day, start, end)).is_err());
        }
    }
    #[test]
    fn rich_timestamp_boundaries_and_empty_day_compatibility() {
        let a = Local
            .with_ymd_and_hms(2026, 1, 1, 23, 58, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let b = Local
            .with_ymd_and_hms(2026, 1, 2, 0, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let mut x = rich_state();
        x["records"]["2026-01-01"]["sessions"][0]["start"] = json!(a);
        x["records"]["2026-01-01"]["sessions"][0]["end"] = json!(b);
        x["records"]["2026-01-01"]["sessions"][0]["utcOffsets"] = json!({"start":Local.timestamp_millis_opt(a).single().unwrap().offset().local_minus_utc()/60,"end":Local.timestamp_millis_opt(b-1).single().unwrap().offset().local_minus_utc()/60});
        assert!(validate_state(&x).is_ok());
        for end in [a, a + 89999, b + 1] {
            let mut bad = x.clone();
            bad["records"]["2026-01-01"]["sessions"][0]["end"] = json!(end);
            assert!(validate_state(&bad).is_err());
        }
        x["records"]["2026-01-01"] = json!({"seconds":0,"note":"old note","sessions":[]});
        assert!(validate_state(&x).is_ok());
        x["records"]["2026-01-01"]
            .as_object_mut()
            .unwrap()
            .remove("note");
        assert!(validate_state(&x).is_err());
    }
    #[test]
    fn interval_order_and_running_start_are_validated() {
        let mut x = rich_state();
        x["timer"]["intervals"] = json!([{"start":1000,"end":2000},{"start":2000,"end":3000}]);
        assert!(validate_state(&x).is_ok());
        x["timer"]["startedAt"] = json!(2999);
        assert!(validate_state(&x).is_err());
        x["timer"]["startedAt"] = json!(3000);
        assert!(validate_state(&x).is_ok());
        x["timer"]["intervals"][1]["start"] = json!(1999);
        assert!(validate_state(&x).is_err());
    }
    #[test]
    fn global_session_and_interval_limits_are_enforced() {
        let mut x = rich_state();
        let mut records = serde_json::Map::new();
        for day in 1..=2 {
            let sessions: Vec<Value> = (0..25000).map(|n| json!({"id":format!("{day}:{n}"),"seconds":1,"note":"","start":null,"end":null,"source":"manual"})).collect();
            records.insert(
                format!("2026-01-0{day}"),
                json!({"seconds":25000,"note":"","sessions":sessions}),
            );
        }
        x["records"] = Value::Object(records);
        assert!(validate_state(&x).is_ok());
        x["records"]["2026-01-03"] = json!({"seconds":1,"note":"","sessions":[{"id":"extra","seconds":1,"note":"","start":null,"end":null,"source":"manual"}]});
        assert!(validate_state(&x).is_err());
        let mut x = state();
        x["timer"]["intervals"] = json!((0..50001)
            .map(|n| json!({"start":n*2,"end":n*2+1}))
            .collect::<Vec<_>>());
        assert!(validate_state(&x).is_err());
    }
    #[test]
    fn pause_retains_known_interval() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Store::open(&dir.path().join("db")).unwrap();
        let mut x = rich_state();
        x["timer"]["startedAt"] = json!(1768000000000_i64);
        x["timer"]["intervals"] = json!([]);
        db.save(&x).unwrap();
        db.pause_at(1768000005000).unwrap();
        assert_eq!(
            db.load().unwrap().unwrap()["timer"]["intervals"],
            json!([{"start":1768000000000_i64,"end":1768000005000_i64}])
        );
    }
    #[test]
    fn rich_daily_recovery_roundtrip_and_invalid_restore_preserves_state() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        let mut db = Store::open_with_backups(&dir.path().join("db"), &folder).unwrap();
        let original = rich_state();
        db.save(&original).unwrap();
        let id = db.list_auto_backups().unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        std::fs::copy(folder.join(&id), folder.join("auto-2026-01-02.json")).unwrap();
        let mut changed = rich_state();
        changed["records"]["2026-01-01"]["sessions"][0]["id"] = json!("changed");
        changed["timer"]["intervals"] =
            json!([{"start":1768000000000_i64,"end":1768000005000_i64}]);
        db.save(&changed).unwrap();
        let restored = db.restore_auto_backup("auto-2026-01-02.json").unwrap();
        assert_eq!(restored["records"], original["records"]);
        assert_eq!(restored["timer"], changed["timer"]);
        let list = db.list_auto_backups().unwrap();
        let recovery = list.iter().find(|r| r["kind"] == "recovery").unwrap()["id"]
            .as_str()
            .unwrap();
        assert_eq!(
            db.restore_auto_backup(recovery).unwrap()["records"],
            changed["records"]
        );
        let mut malformed: Value = serde_json::from_str(
            &std::fs::read_to_string(folder.join("auto-2026-01-02.json")).unwrap(),
        )
        .unwrap();
        malformed["records"]["2026-01-01"]["sessions"][0]["seconds"] = json!(99);
        std::fs::write(folder.join("auto-2026-01-03.json"), malformed.to_string()).unwrap();
        let before = db.load().unwrap();
        let files = std::fs::read_dir(&folder).unwrap().count();
        assert!(db.restore_auto_backup("auto-2026-01-03.json").is_err());
        assert_eq!(db.load().unwrap(), before);
        assert_eq!(std::fs::read_dir(&folder).unwrap().count(), files);
    }
    #[test]
    fn saves_survive_database_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("comet.sqlite3");
        assert_eq!(Store::open(&path).unwrap().load().unwrap(), None);
        {
            let mut db = Store::open(&path).unwrap();
            db.save(&state()).unwrap();
        }
        assert_eq!(Store::open(&path).unwrap().load().unwrap(), Some(state()));
    }
    #[test]
    fn invalid_state_preserves_previous_durable_record() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Store::open(&dir.path().join("comet.sqlite3")).unwrap();
        db.save(&state()).unwrap();
        for broken in [
            json!({"version":2}),
            {
                let mut x = state();
                x["records"]["2026-01-01"]["seconds"] = json!(-1);
                x
            },
            {
                let mut x = state();
                x["timer"]["allocations"] = json!({"2026-02-31":12});
                x
            },
            {
                let mut x = state();
                x["goal"] = json!(1);
                x
            },
        ] {
            assert!(db.save(&broken).is_err());
            assert_eq!(db.load().unwrap(), Some(state()));
        }
    }
    #[test]
    fn exit_pause_splits_at_local_midnight_and_resume_preserves_time() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Store::open(&dir.path().join("comet.sqlite3")).unwrap();
        let start = Local
            .with_ymd_and_hms(2026, 1, 2, 23, 59, 58)
            .single()
            .unwrap()
            .timestamp_millis();
        let end = Local
            .with_ymd_and_hms(2026, 1, 3, 0, 0, 3)
            .single()
            .unwrap()
            .timestamp_millis();
        let mut x = state();
        x["timer"] = json!({"startedAt":start,"allocations":{"2026-01-02":1000},"note":"Physics"});
        db.save(&x).unwrap();
        db.pause_at(end).unwrap();
        let mut paused = db.load().unwrap().unwrap();
        assert_eq!(
            paused["timer"],
            json!({"startedAt":null,"allocations":{"2026-01-02":3000,"2026-01-03":3000},"note":"Physics"})
        );
        db.pause_at(end + 1000).unwrap();
        assert_eq!(db.load().unwrap().unwrap(), paused);
        paused["timer"]["startedAt"] = json!(end + 1000);
        db.save(&paused).unwrap();
        db.pause_at(end + 4000).unwrap();
        assert_eq!(
            db.load().unwrap().unwrap()["timer"]["allocations"]["2026-01-03"],
            6000
        );
    }
    #[test]
    fn malformed_unicode_dates_are_rejected_without_panicking() {
        let mut x = state();
        x["records"] = json!({"aa界aaaab":{"seconds":2,"note":""}});
        assert!(validate_state(&x).is_err());
    }
    #[test]
    fn sqlite_write_failure_keeps_previous_durable_state() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Store::open(&dir.path().join("comet.sqlite3")).unwrap();
        db.save(&state()).unwrap();
        db.connection.execute_batch("PRAGMA query_only=ON").unwrap();
        let mut changed = state();
        changed["goal"] = json!(120);
        assert!(db.save(&changed).is_err());
        assert_eq!(db.load().unwrap().unwrap(), state());
        let mut running = state();
        running["timer"]["startedAt"] = json!(1768000000000_i64);
        db.connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        db.save(&running).unwrap();
        db.connection.execute_batch("PRAGMA query_only=ON").unwrap();
        assert!(db.pause_at(1768000005000).is_err());
        assert_eq!(db.load().unwrap().unwrap(), running);
    }
    #[test]
    fn clock_rollback_prevents_exit_and_retains_running_timer() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = Store::open(&dir.path().join("comet.sqlite3")).unwrap();
        let mut x = state();
        x["timer"]["startedAt"] = json!(1768000000000_i64);
        db.save(&x).unwrap();
        assert!(db.pause_at(1767999999000).is_err());
        assert_eq!(db.load().unwrap().unwrap(), x);
    }
    #[test]
    fn startup_snapshot_and_timer_exclusion() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let backups = dir.path().join("backups");
        let mut db = Store::open(&path).unwrap();
        db.save(&state()).unwrap();
        drop(db);
        let mut db = Store::open_with_backups(&path, &backups).unwrap();
        let list = db.list_auto_backups().unwrap();
        assert_eq!(list.len(), 1);
        let file = backups.join(list[0]["id"].as_str().unwrap());
        let before = std::fs::read(&file).unwrap();
        let mut x = state();
        x["timer"]["note"] = json!("running");
        db.save(&x).unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), before);
        x["goal"] = json!(90);
        db.save(&x).unwrap();
        assert_ne!(std::fs::read(&file).unwrap(), before);
    }
    #[test]
    fn restore_replaces_records_exactly_preserves_timer_and_safety_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        let mut db = Store::open_with_backups(&dir.path().join("db"), &folder).unwrap();
        db.save(&state()).unwrap();
        let id = db.list_auto_backups().unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let historical = folder.join("auto-2026-01-02.json");
        std::fs::copy(folder.join(&id), &historical).unwrap();
        let mut x = state();
        x["records"] = json!({"2026-01-03":{"seconds":777,"note":"new"}});
        x["goal"] = json!(120);
        x["timer"] = json!({"startedAt":1768000000000_i64,"allocations":{"2026-01-03":1234.5},"note":"Active"});
        db.save(&x).unwrap();
        let restored = db.restore_auto_backup("auto-2026-01-02.json").unwrap();
        assert_eq!(restored["records"], state()["records"]);
        assert_eq!(restored["goal"], 60);
        assert_eq!(restored["timer"], x["timer"]);
        assert_eq!(restored["version"], 1);
        assert_eq!(db.load().unwrap(), Some(restored));
        let recovery = std::fs::read_dir(&folder)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("recovery-")
            })
            .unwrap();
        let safe: Value =
            serde_json::from_str(&std::fs::read_to_string(recovery).unwrap()).unwrap();
        assert_eq!(safe["records"], x["records"]);
        assert_eq!(safe["goal"], x["goal"]);
    }
    #[test]
    fn backup_failure_does_not_reject_durable_save_and_restore_requires_safety() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        std::fs::write(&folder, "blocked").unwrap();
        let mut db = Store::open_with_backups(&dir.path().join("db"), &folder).unwrap();
        db.save(&state()).unwrap();
        assert_eq!(db.load().unwrap(), Some(state()));
        assert!(db.backup_status().is_some());
        assert!(db.restore_auto_backup("auto-2026-01-01.json").is_err());
        assert_eq!(db.load().unwrap(), Some(state()));
    }
    #[test]
    fn restore_write_failure_retains_database_and_pre_restore_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        let mut db = Store::open_with_backups(&dir.path().join("db"), &folder).unwrap();
        db.save(&state()).unwrap();
        let id = db.list_auto_backups().unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut changed = state();
        changed["goal"] = json!(90);
        db.save(&changed).unwrap();
        db.connection.execute_batch("PRAGMA query_only=ON").unwrap();
        assert!(db.restore_auto_backup(&id).is_err());
        assert_eq!(db.load().unwrap(), Some(changed.clone()));
        let recovery = std::fs::read_dir(&folder)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("recovery-")
            })
            .unwrap();
        let safe: Value =
            serde_json::from_str(&std::fs::read_to_string(recovery).unwrap()).unwrap();
        assert_eq!(safe["goal"], changed["goal"]);
    }
    #[test]
    fn restore_safety_snapshot_failure_leaves_current_database_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        let mut db = Store::open_with_backups(&dir.path().join("db"), &folder).unwrap();
        db.save(&state()).unwrap();
        let id = db.list_auto_backups().unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut current = state();
        let mut records = serde_json::Map::new();
        let first = NaiveDate::from_ymd_opt(1900, 1, 1).unwrap();
        for n in 0..15000 {
            records.insert(
                (first + DateDuration::days(n))
                    .format("%Y-%m-%d")
                    .to_string(),
                json!({"seconds":1,"note":"界".repeat(120)}),
            );
        }
        current["records"] = Value::Object(records);
        db.save(&current).unwrap();
        assert!(db.backup_status().is_some());
        assert!(db.restore_auto_backup(&id).is_err());
        assert_eq!(db.load().unwrap(), Some(current));
        assert!(!std::fs::read_dir(&folder).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("recovery-")));
    }
    #[test]
    fn invalid_restore_does_not_create_recovery_snapshot_or_change_database() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        let mut db = Store::open_with_backups(&dir.path().join("db"), &folder).unwrap();
        db.save(&state()).unwrap();
        std::fs::write(folder.join("auto-2026-01-01.json"), "{bad").unwrap();
        assert!(db.restore_auto_backup("auto-2026-01-01.json").is_err());
        assert_eq!(db.load().unwrap(), Some(state()));
        assert!(!std::fs::read_dir(&folder).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("recovery-")));
    }
    #[test]
    fn failed_durable_save_does_not_update_existing_daily_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        let mut db = Store::open_with_backups(&dir.path().join("db"), &folder).unwrap();
        db.save(&state()).unwrap();
        let id = db.list_auto_backups().unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let before = std::fs::read(folder.join(&id)).unwrap();
        db.connection.execute_batch("PRAGMA query_only=ON").unwrap();
        let mut changed = state();
        changed["goal"] = json!(90);
        assert!(db.save(&changed).is_err());
        assert_eq!(std::fs::read(folder.join(&id)).unwrap(), before);
        assert_eq!(db.load().unwrap(), Some(state()));
    }
    #[test]
    fn pre_restore_recovery_is_available_and_restorable_through_same_api() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        let mut db = Store::open_with_backups(&dir.path().join("db"), &folder).unwrap();
        db.save(&state()).unwrap();
        let daily = db.list_auto_backups().unwrap()[0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        std::fs::copy(folder.join(&daily), folder.join("auto-2026-01-02.json")).unwrap();
        let mut changed = state();
        changed["records"] = json!({"2026-01-03":{"seconds":777,"note":"before restore"}});
        changed["goal"] = json!(90);
        db.save(&changed).unwrap();
        db.restore_auto_backup("auto-2026-01-02.json").unwrap();
        let list = db.list_auto_backups().unwrap();
        let recovery = list
            .iter()
            .find(|row| row["kind"] == "recovery")
            .expect("pre-restore recovery must appear in the same picker");
        let id = recovery["id"].as_str().unwrap().to_owned();
        assert_eq!(recovery["days"], 1);
        assert_eq!(recovery["totalSeconds"], 777);
        let restored = db.restore_auto_backup(&id).unwrap();
        assert_eq!(restored["records"], changed["records"]);
        assert_eq!(restored["goal"], changed["goal"]);
    }
    #[test]
    fn directory_sync_failure_aborts_restore_but_durable_save_stays_successful() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        let mut db = Store::open_with_backups(&dir.path().join("db"), &folder).unwrap();
        db.save(&state()).unwrap();
        let daily = db
            .list_auto_backups()
            .unwrap()
            .iter()
            .find(|row| row["kind"] == "daily")
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        std::fs::copy(folder.join(&daily), folder.join("auto-2026-01-02.json")).unwrap();
        db.backups.as_mut().unwrap().directory_sync = |path| {
            if path.file_name().is_some_and(|name| name == "backups") {
                Err("Injected directory sync failure.".into())
            } else {
                Ok(())
            }
        };
        let mut changed = state();
        changed["goal"] = json!(90);
        db.save(&changed).unwrap();
        assert_eq!(db.load().unwrap(), Some(changed.clone()));
        assert!(db.backup_status().unwrap().contains("directory sync"));
        let error = db.restore_auto_backup("auto-2026-01-02.json").unwrap_err();
        assert!(error.contains("directory sync"));
        assert_eq!(db.load().unwrap(), Some(changed));
        assert!(std::fs::read_dir(&folder).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("recovery-")));
    }
}
