//! Bounded, validated snapshots. Timer state deliberately never enters a snapshot.
use crate::{
    backups::{read_backup, write_backup},
    storage::validate_state,
};
use chrono::{Local, NaiveDate};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub struct AutoBackups {
    directory: PathBuf,
    last_day: Option<String>,
    last_data: Option<Value>,
    error: Option<String>,
    pending_history: Option<(String, Value, String)>,
    pub(crate) directory_sync: fn(&Path) -> Result<(), String>,
}
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| {
                "Unable to complete backup directory sync. Check disk space and permissions."
                    .to_owned()
            })?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}
fn valid_day(day: &str) -> bool {
    day.len() == 10
        && day >= "1900-01-01"
        && NaiveDate::parse_from_str(day, "%Y-%m-%d")
            .is_ok_and(|d| d.format("%Y-%m-%d").to_string() == day)
}
fn auto_day(id: &str) -> Option<&str> {
    let day = id.strip_prefix("auto-")?.strip_suffix(".json")?;
    valid_day(day).then_some(day)
}
fn recovery_id(id: &str) -> bool {
    let Some(stamp) = id
        .strip_prefix("recovery-")
        .and_then(|s| s.strip_suffix(".json"))
    else {
        return false;
    };
    let Some((stamp, counter)) = stamp.split_once('-') else {
        return false;
    };
    stamp.len() == 19
        && counter.len() == 4
        && stamp
            .bytes()
            .chain(counter.bytes())
            .all(|b| b.is_ascii_digit())
}

fn data(value: &Value) -> Value {
    json!({"goal":value["goal"],"records":value["records"],"lastTimerSessionId":value["lastTimerSessionId"]})
}
fn snapshot(value: &Value) -> Value {
    let mut result = json!({"version":1,"exportedAt":Local::now().to_rfc3339(),"goal":value["goal"],"records":value["records"]});
    if let Some(id) = value.get("lastTimerSessionId") {
        result["lastTimerSessionId"] = id.clone();
    }
    result
}
fn validate_snapshot(value: &Value) -> Result<(), String> {
    let mut candidate = json!({"version":value["version"],"goal":value["goal"],"records":value["records"],"timer":{"startedAt":null,"allocations":{},"note":""}});
    if let Some(id) = value.get("lastTimerSessionId") {
        candidate["lastTimerSessionId"] = id.clone();
    }
    validate_state(&candidate).map_err(|_| {
        "This automatic backup contains invalid records or a goal. Saved data has been kept."
            .to_owned()
    })?;
    let exported = value["exportedAt"]
        .as_str()
        .ok_or("This automatic backup has no valid export time.")?;
    if exported.len() > 64 || chrono::DateTime::parse_from_rfc3339(exported).is_err() {
        return Err("This automatic backup has an invalid export time.".into());
    }
    Ok(())
}
impl AutoBackups {
    pub fn new(directory: &Path) -> Self {
        Self {
            directory: directory.into(),
            last_day: None,
            last_data: None,
            error: None,
            pending_history: None,
            directory_sync: sync_directory,
        }
    }
    pub fn status(&self) -> Option<String> {
        self.error.clone()
    }
    fn note(&mut self, result: Result<(), String>) {
        self.error = result
            .err()
            .or_else(|| {
                self.pending_history
                    .as_ref()
                    .map(|(_, _, error)| error.clone())
            })
            .map(|e| {
                format!(
                    "Automatic backup unavailable: {}",
                    e.chars().take(350).collect::<String>()
                )
            });
    }
    fn check_directory(&self) -> Result<(), String> {
        match std::fs::symlink_metadata(&self.directory) {
            Ok(metadata) if !metadata.file_type().is_dir() => {
                Err("The backup folder is not a regular directory.".into())
            }
            Ok(_) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Unable to inspect the backup folder.".into()),
        }
    }
    fn write(&self, id: &str, value: &Value) -> Result<(), String> {
        self.check_directory()?;
        if !self.directory.exists() {
            // app-data already exists: create only its direct backup child, then
            // make that child's directory entry durable before writing snapshots.
            std::fs::create_dir(&self.directory).map_err(|_| {
                "Unable to create the backup folder. Check disk space and permissions.".to_owned()
            })?;
        }
        // Retry the parent barrier even if an earlier directory creation succeeded
        // but its sync failed; an existing directory alone does not prove durability.
        let parent = self
            .directory
            .parent()
            .ok_or("Unable to locate the backup folder parent.")?;
        (self.directory_sync)(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "Unable to protect the backup folder.".to_owned())?;
        }
        let path = self.directory.join(id);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.file_type().is_file()) {
            return Err("The snapshot destination is not a regular file.".into());
        }
        let text = serde_json::to_string(&snapshot(value))
            .map_err(|_| "Unable to encode the snapshot.".to_owned())?;
        write_backup(&path, &text).map_err(|_| {
            "Unable to write the snapshot. Check disk space and permissions.".to_owned()
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "Unable to protect the snapshot.".to_owned())?;
        }
        // write_backup synced the tempfile's bytes before atomic rename. Sync
        // the directory entry as well before a restore may replace SQLite data.
        (self.directory_sync)(&self.directory)?;
        Ok(())
    }
    fn prune(&self, recovery: bool) -> Result<(), String> {
        let mut files = self
            .files()?
            .into_iter()
            .filter(|id| {
                if recovery {
                    recovery_id(id)
                } else {
                    auto_day(id).is_some()
                }
            })
            .collect::<Vec<_>>();
        files.sort();
        let excess = files.len().saturating_sub(30);
        for id in files.into_iter().take(excess) {
            std::fs::remove_file(self.directory.join(id))
                .map_err(|_| "Unable to remove an expired snapshot.".to_owned())?;
        }
        Ok(())
    }
    fn files(&self) -> Result<Vec<String>, String> {
        self.check_directory()?;
        if !self.directory.exists() {
            return Ok(vec![]);
        }
        let entries = std::fs::read_dir(&self.directory)
            .map_err(|_| "Unable to read the backup folder.".to_owned())?;
        let mut result = vec![];
        for entry in entries {
            let entry = entry.map_err(|_| "Unable to read a backup entry.".to_owned())?;
            if entry
                .file_type()
                .map_err(|_| "Unable to inspect a backup entry.".to_owned())?
                .is_file()
            {
                if let Some(id) = entry.file_name().to_str() {
                    result.push(id.to_owned());
                }
            }
        }
        Ok(result)
    }
    pub fn refresh(&mut self, value: &Value) {
        self.refresh_at(value, &today());
    }
    fn refresh_at(&mut self, value: &Value, day: &str) {
        if self.last_data.as_ref() == Some(&data(value)) {
            return;
        }
        let result = validate_state(value)
            .and_then(|_| self.write(&format!("auto-{day}.json"), value))
            .and_then(|_| self.prune(false));
        if result.is_ok() {
            self.last_day = Some(day.into());
            self.last_data = Some(data(value));
        }
        self.note(result);
    }
    pub fn before_save(&mut self, current: &Value) {
        let day = today();
        let pending = self
            .pending_history
            .take()
            .map(|(day, value, _)| (day, value));
        let target = pending.or_else(|| {
            self.last_day
                .clone()
                .filter(|old| old != &day)
                .map(|old| (old, current.clone()))
        });
        if let Some((old_day, value)) = target {
            let id = format!("auto-{old_day}.json");
            if self
                .read(&id)
                .is_ok_and(|saved| data(&saved) == data(&value))
            {
                self.note(Ok(()));
                return;
            }
            let result = self.write(&id, &value);
            if let Err(error) = &result {
                self.pending_history = Some((old_day, value, error.clone()));
            }
            self.note(result);
        }
    }
    pub fn list(&self) -> Result<Vec<Value>, String> {
        let mut result = vec![];
        for id in self.files()? {
            let daily = auto_day(&id);
            let recovery = recovery_id(&id);
            if daily.is_none() && !recovery {
                continue;
            }
            // A corrupt snapshot does not hide the other valid recovery choices.
            if let Ok(value) = self.read(&id) {
                let exported =
                    chrono::DateTime::parse_from_rfc3339(value["exportedAt"].as_str().unwrap())
                        .unwrap();
                let day = daily.map(str::to_owned).unwrap_or_else(|| {
                    exported
                        .with_timezone(&Local)
                        .format("%Y-%m-%d")
                        .to_string()
                });
                let records = value["records"].as_object().unwrap();
                let total: u64 = records
                    .values()
                    .map(|r| r["seconds"].as_u64().unwrap())
                    .sum();
                result.push(json!({"id":id,"kind":if recovery { "recovery" } else { "daily" },"date":day,"exportedAt":value["exportedAt"],"days":records.values().filter(|record| record["seconds"].as_u64().unwrap() > 0).count(),"totalSeconds":total}));
            }
        }
        result.sort_by(|a, b| {
            let stamp = |v: &Value| {
                chrono::DateTime::parse_from_rfc3339(v["exportedAt"].as_str().unwrap()).unwrap()
            };
            stamp(b)
                .cmp(&stamp(a))
                .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
        });
        Ok(result)
    }
    pub fn read(&self, id: &str) -> Result<Value, String> {
        self.check_directory()?;
        let day = auto_day(id);
        if day.is_none() && !recovery_id(id) {
            return Err("Choose a valid backup filename.".into());
        }
        if day.is_some_and(|day| day > today().as_str()) {
            return Err("This automatic backup is dated in the future.".into());
        }
        let path = self.directory.join(id);
        if !std::fs::symlink_metadata(&path)
            .map_err(|_| "This automatic backup is unavailable.".to_owned())?
            .file_type()
            .is_file()
        {
            return Err("This automatic backup is not a regular file.".into());
        }
        let text = read_backup(&path).map_err(|_| {
            "Unable to read this automatic backup; it must be valid text smaller than 5 MB."
                .to_owned()
        })?;
        let value: Value = serde_json::from_str(&text).map_err(|_| {
            "This automatic backup is damaged. Saved data has been kept.".to_owned()
        })?;
        validate_snapshot(&value)?;
        Ok(value)
    }
    pub fn preserve_recovery(&self, current: &Value) -> Result<(), String> {
        validate_state(current)?;
        // Nanosecond timestamp plus collision counter avoids overwriting another safety snapshot.
        let stamp = Local::now()
            .timestamp_nanos_opt()
            .unwrap_or_else(|| Local::now().timestamp_micros() * 1000);
        let mut counter = 0;
        let id = loop {
            let id = format!("recovery-{stamp:019}-{counter:04}.json");
            if !self.directory.join(&id).exists() {
                break id;
            }
            counter += 1;
            if counter > 9999 {
                return Err("Unable to allocate a safety snapshot.".into());
            }
        };
        self.write(&id, current)?;
        self.prune(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> Value {
        json!({"version":1,"goal":60,"records":{"2026-01-01":{"seconds":90,"note":"Math"}},"timer":{"startedAt":null,"allocations":{},"note":""}})
    }
    #[test]
    fn retention_is_thirty_exact_auto_names_only() {
        let dir = tempfile::tempdir().unwrap();
        let mut b = AutoBackups::new(dir.path());
        for n in 1..=31 {
            let mut value = state();
            value["goal"] = json!(60 + n);
            b.refresh_at(&value, &format!("2026-01-{n:02}"));
        }
        for name in [
            "auto-not-a-date.json",
            "auto-2026-1-01.json",
            "manual.json",
            "recovery-123.json",
        ] {
            std::fs::write(dir.path().join(name), "keep").unwrap();
        }
        b.refresh_at(&state(), "2026-02-01");
        assert_eq!(
            b.files()
                .unwrap()
                .iter()
                .filter(|s| auto_day(s).is_some())
                .count(),
            30
        );
        assert!(!dir.path().join("auto-2026-01-01.json").exists());
        for name in [
            "auto-not-a-date.json",
            "auto-2026-1-01.json",
            "manual.json",
            "recovery-123.json",
        ] {
            assert_eq!(
                std::fs::read_to_string(dir.path().join(name)).unwrap(),
                "keep"
            );
        }
    }
    #[test]
    fn metadata_and_ids_are_validated_without_exposing_content() {
        let dir = tempfile::tempdir().unwrap();
        let mut b = AutoBackups::new(dir.path());
        b.refresh(&state());
        let list = b.list().unwrap();
        assert_eq!(list[0]["days"], 1);
        assert_eq!(list[0]["totalSeconds"], 90);
        for id in [
            "../auto-2026-01-01.json",
            "/auto-2026-01-01.json",
            "auto-2026-02-31.json",
            "auto-aa界aaaab.json",
            "recovery-123.json",
            "auto-9999-01-01.json",
        ] {
            assert!(b.read(id).is_err());
        }
    }
    #[test]
    fn corrupt_future_and_oversized_snapshots_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let b = AutoBackups::new(dir.path());
        let id = "auto-2026-01-01.json";
        let mut candidates = vec![json!({}), snapshot(&state())];
        candidates[1]["records"] = json!({"9999-01-01":{"seconds":1}});
        for seconds in [json!(-1), json!(86401), json!(1.1)] {
            let mut x = snapshot(&state());
            x["records"]["2026-01-01"]["seconds"] = seconds;
            candidates.push(x);
        }
        let mut x = snapshot(&state());
        x["records"]["2026-01-01"]["note"] = json!("x".repeat(121));
        candidates.push(x);
        for x in candidates {
            std::fs::write(dir.path().join(id), x.to_string()).unwrap();
            assert!(b.read(id).is_err());
        }
        std::fs::write(
            dir.path().join(id),
            vec![b' '; crate::backups::MAX_BACKUP_BYTES as usize + 1],
        )
        .unwrap();
        assert!(b.read(id).is_err());
        std::fs::write(dir.path().join(id), "{broken").unwrap();
        assert!(b.read(id).is_err());
        assert!(b.list().unwrap().is_empty());
    }
    #[test]
    fn recovery_retention_does_not_remove_unrelated_names() {
        let dir = tempfile::tempdir().unwrap();
        let b = AutoBackups::new(dir.path());
        std::fs::write(dir.path().join("recovery-123.json"), "keep").unwrap();
        for _ in 0..35 {
            b.preserve_recovery(&state()).unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("recovery-123.json")).unwrap(),
            "keep"
        );
        assert_eq!(
            b.files()
                .unwrap()
                .iter()
                .filter(|id| recovery_id(id))
                .count(),
            30
        );
    }
    #[test]
    fn failed_historical_backup_stays_visible_after_successful_current_backup() {
        let dir = tempfile::tempdir().unwrap();
        let mut b = AutoBackups::new(dir.path());
        b.refresh_at(&state(), "2026-01-01");
        std::fs::remove_file(dir.path().join("auto-2026-01-01.json")).unwrap();
        std::fs::create_dir(dir.path().join("auto-2026-01-01.json")).unwrap();
        b.before_save(&state());
        let mut changed = state();
        changed["goal"] = json!(90);
        b.refresh(&changed);
        assert!(b.status().is_some());
    }
    #[test]
    fn timer_only_save_on_new_day_does_not_create_daily_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut b = AutoBackups::new(dir.path());
        b.refresh_at(&state(), "2026-01-01");
        let mut changed = state();
        changed["timer"]["note"] = json!("changed");
        b.refresh_at(&changed, "2026-01-02");
        assert!(!dir.path().join("auto-2026-01-02.json").exists());
        changed["goal"] = json!(90);
        b.refresh_at(&changed, "2026-01-02");
        assert!(dir.path().join("auto-2026-01-02.json").exists());
        assert_eq!(b.read("auto-2026-01-01.json").unwrap()["goal"], 60);
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_directory_and_snapshot_do_not_escape_backup_folder() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let linked = dir.path().join("backups");
        symlink(outside.path(), &linked).unwrap();
        let mut b = AutoBackups::new(&linked);
        b.refresh(&state());
        assert!(b.status().is_some());
        assert!(b.list().is_err());
        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
        let mut b = AutoBackups::new(dir.path());
        b.refresh(&state());
        let id = b.list().unwrap()[0]["id"].as_str().unwrap().to_owned();
        symlink(dir.path().join(id), dir.path().join("auto-2026-01-01.json")).unwrap();
        assert!(b.read("auto-2026-01-01.json").is_err());
    }
    #[test]
    fn rollover_keeps_already_preserved_historical_snapshot_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let mut b = AutoBackups::new(dir.path());
        b.refresh_at(&state(), "2026-01-01");
        let path = dir.path().join("auto-2026-01-01.json");
        let before = std::fs::read(&path).unwrap();
        let mut x = state();
        x["timer"]["note"] = json!("timer only");
        b.before_save(&x);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    #[test]
    fn newly_created_backup_folder_parent_sync_failure_is_retried() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("backups");
        let mut b = AutoBackups::new(&folder);
        b.directory_sync = |_| Err("Injected parent directory sync failure.".into());
        assert!(b.preserve_recovery(&state()).is_err());
        assert!(folder.is_dir());
        assert!(std::fs::read_dir(&folder).unwrap().next().is_none());
        // The folder now exists, but the previously failed creation barrier must
        // still run on retry rather than being skipped because of its existence.
        b.directory_sync = |path| {
            if path.join("backups").is_dir() {
                Err("Injected retry parent directory sync failure.".into())
            } else {
                Ok(())
            }
        };
        assert!(b
            .preserve_recovery(&state())
            .unwrap_err()
            .contains("retry parent"));
        assert!(std::fs::read_dir(&folder).unwrap().next().is_none());
        b.directory_sync = sync_directory;
        b.preserve_recovery(&state()).unwrap();
        assert_eq!(b.list().unwrap().len(), 1);
    }
    #[test]
    fn metadata_study_days_excludes_zero_duration_records() {
        let dir = tempfile::tempdir().unwrap();
        let mut b = AutoBackups::new(dir.path());
        let mut value = state();
        value["records"]["2026-01-02"] = json!({"seconds":0,"note":"zero total"});
        b.refresh(&value);
        b.preserve_recovery(&value).unwrap();
        let list = b.list().unwrap();
        assert_eq!(list.len(), 2);
        for row in list {
            assert_eq!(row["days"], 1);
            assert_eq!(row["totalSeconds"], 90);
        }
        assert_eq!(
            b.read(&format!("auto-{}.json", today())).unwrap()["records"]
                .as_object()
                .unwrap()
                .len(),
            2
        );
    }
}
