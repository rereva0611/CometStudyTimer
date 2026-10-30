use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Preferences {
    pub theme: String,
    pub pinned: bool,
    pub collapsed: bool,
    pub autostart: bool,
    pub production_autostart_initialized: bool,
    pub position: Option<(f64, f64)>,
    pub screen: Option<Rect>,
}
impl Preferences {
    pub fn should_initialize_production_autostart(&self, production: bool) -> bool {
        production && !self.production_autostart_initialized
    }
    pub fn size(&self) -> (f64, f64) {
        if self.collapsed {
            (48.0, 48.0)
        } else {
            (320.0, 300.0)
        }
    }
    pub fn public_value(&self) -> Value {
        json!({"pinned":self.pinned,"collapsed":self.collapsed,"autostart":self.autostart,"theme":self.theme})
    }
}
pub struct PreferencesStore {
    path: PathBuf,
    pub preferences: Preferences,
}
impl PreferencesStore {
    pub fn open(path: &Path, default_autostart: bool) -> Result<Self, String> {
        reject_symlink(path)?;
        let first_run = !path.exists();
        let mut prefs = Preferences {
            theme: "rose".into(),
            pinned: false,
            collapsed: false,
            autostart: default_autostart,
            production_autostart_initialized: false,
            position: None,
            screen: None,
        };
        if !first_run {
            let bytes = std::fs::read(path)
                .map_err(|e| format!("Unable to read widget preferences: {e}"))?;
            let v: Value = serde_json::from_slice(&bytes)
                .map_err(|e| format!("Invalid widget preferences: {e}"))?;
            let invalid = || "Invalid widget preferences. The saved file has been kept.".to_owned();
            if v["theme"].as_str() == Some("github-dark") {
                prefs.theme = "github-dark".into();
            }
            prefs.pinned = v["pinned"].as_bool().ok_or_else(invalid)?;
            prefs.collapsed = v["collapsed"].as_bool().ok_or_else(invalid)?;
            prefs.autostart = v["autostart"].as_bool().ok_or_else(invalid)?;
            prefs.production_autostart_initialized = match v.get("productionAutostartInitialized") {
                None => false,
                Some(value) => value.as_bool().ok_or_else(invalid)?,
            };
            if !v["position"].is_null() {
                let a = v["position"]
                    .as_array()
                    .filter(|a| a.len() == 2)
                    .ok_or_else(invalid)?;
                prefs.position = Some((
                    finite(&a[0]).ok_or_else(invalid)?,
                    finite(&a[1]).ok_or_else(invalid)?,
                ));
            }
            if !v["screen"].is_null() {
                let s = &v["screen"];
                let screen = Rect {
                    x: finite(&s["x"]).ok_or_else(invalid)?,
                    y: finite(&s["y"]).ok_or_else(invalid)?,
                    width: finite(&s["width"])
                        .filter(|n| *n > 0.0)
                        .ok_or_else(invalid)?,
                    height: finite(&s["height"])
                        .filter(|n| *n > 0.0)
                        .ok_or_else(invalid)?,
                };
                prefs.screen = Some(screen);
            }
        }
        Ok(Self {
            path: path.to_owned(),
            preferences: prefs,
        })
    }
    pub fn toggle_theme(&mut self) -> Result<Value, String> {
        let old = self.preferences.theme.clone();
        self.preferences.theme = if old == "rose" {
            "github-dark".into()
        } else {
            "rose".into()
        };
        if let Err(error) = self.persist() {
            self.preferences.theme = old;
            return Err(error);
        }
        Ok(self.preferences.public_value())
    }
    pub fn persist(&self) -> Result<(), String> {
        reject_symlink(&self.path)?;
        let screen = self
            .preferences
            .screen
            .map(|s| json!({"x":s.x,"y":s.y,"width":s.width,"height":s.height}));
        let p = &self.preferences;
        let value = json!({"pinned":p.pinned,"collapsed":p.collapsed,"autostart":p.autostart,"theme":p.theme,"productionAutostartInitialized":p.production_autostart_initialized,"position":p.position.map(|(x,y)|[x,y]),"screen":screen});
        let parent = self
            .path
            .parent()
            .ok_or("Invalid widget preferences directory.")?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|e| format!("Unable to write widget preferences: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        file.write_all(value.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(&self.path)
            .map_err(|e| format!("Unable to save widget preferences: {e}"))?;
        std::fs::File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|e| format!("Unable to sync widget preferences: {e}"))?;
        Ok(())
    }
}
fn reject_symlink(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            Err("Widget preferences must be a regular private file.".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Unable to inspect widget preferences: {error}")),
    }
}
fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && n.abs() < 1e9)
}
pub fn resize_anchor(position: (f64, f64), old: (f64, f64), new: (f64, f64)) -> (f64, f64) {
    (position.0 + old.0 - new.0, position.1)
}
pub fn clamp_position(position: (f64, f64), screen: Rect, size: (f64, f64)) -> (f64, f64) {
    (
        position
            .0
            .clamp(screen.x, screen.x + (screen.width - size.0).max(0.0)),
        position
            .1
            .clamp(screen.y, screen.y + (screen.height - size.1).max(0.0)),
    )
}
pub const PREVIEW_SIZE: (f64, f64) = (176.0, 48.0);
const PREVIEW_CLOCK_WIDTH: f64 = PREVIEW_SIZE.0 - 48.0;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreviewDirection {
    Left,
    Right,
}
impl PreviewDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
        }
    }
    pub fn icon_position(self, window_position: (f64, f64)) -> (f64, f64) {
        match self {
            Self::Left => (window_position.0 + PREVIEW_CLOCK_WIDTH, window_position.1),
            Self::Right => window_position,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PreviewLayout {
    pub position: (f64, f64),
    pub direction: PreviewDirection,
}
pub fn preview_layout(anchor: (f64, f64), screen: Rect) -> PreviewLayout {
    let left_space = anchor.0 - screen.x;
    let right_space = screen.x + screen.width - anchor.0 - 48.0;
    let direction = if right_space >= PREVIEW_CLOCK_WIDTH {
        PreviewDirection::Right
    } else if left_space >= PREVIEW_CLOCK_WIDTH || left_space > right_space {
        PreviewDirection::Left
    } else {
        // On very narrow work areas the clock may crop, but the icon stays put.
        PreviewDirection::Right
    };
    let position = match direction {
        PreviewDirection::Left => (anchor.0 - PREVIEW_CLOCK_WIDTH, anchor.1),
        PreviewDirection::Right => anchor,
    };
    PreviewLayout {
        position,
        direction,
    }
}
pub fn preview_position(anchor: (f64, f64), screen: Rect) -> (f64, f64) {
    preview_layout(anchor, screen).position
}
pub fn initial_position(screen: Rect, size: (f64, f64)) -> (f64, f64) {
    clamp_position(
        (
            screen.x + screen.width - size.0 - 16.0,
            screen.y + screen.height - size.1 - 16.0,
        ),
        screen,
        size,
    )
}
pub fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_:-".contains(&b))
}
pub fn valid_day(day: &str) -> bool {
    day.len() == 10
        && day >= "1900-01-01"
        && chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
            .is_ok_and(|d| d.format("%Y-%m-%d").to_string() == day)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hover_preview_opens_to_the_available_side_without_moving_the_icon() {
        let screen = Rect {
            x: 0.0,
            y: 0.0,
            width: 500.0,
            height: 600.0,
        };
        assert_eq!(preview_position((100.0, 120.0), screen), (100.0, 120.0));
        assert_eq!(preview_position((324.0, 120.0), screen), (324.0, 120.0));
        assert_eq!(preview_position((325.0, 120.0), screen), (197.0, 120.0));
        assert_eq!(preview_position((372.0, 120.0), screen), (244.0, 120.0));
        let left_screen = Rect {
            x: -1440.0,
            y: 40.0,
            width: 1440.0,
            height: 900.0,
        };
        assert_eq!(
            preview_position((-64.0, 100.0), left_screen),
            (-192.0, 100.0)
        );
        assert_eq!(
            preview_position((-1000.0, 100.0), left_screen),
            (-1000.0, 100.0)
        );
        assert_eq!(PREVIEW_SIZE, (176.0, 48.0));
    }
    #[test]
    fn hover_preview_keeps_the_icon_fixed_even_when_neither_side_fits() {
        let screen = Rect {
            x: -200.0,
            y: 40.0,
            width: 160.0,
            height: 100.0,
        };
        // Crop the clock on the roomier side, instead of shifting the icon.
        assert_eq!(preview_position((-180.0, 60.0), screen), (-180.0, 60.0));
        assert_eq!(preview_position((-100.0, 60.0), screen), (-228.0, 60.0));
    }
    #[test]
    fn hover_preview_direction_recovers_the_icon_origin_for_dragging() {
        let screen = Rect {
            x: -500.0,
            y: 40.0,
            width: 500.0,
            height: 300.0,
        };
        for (anchor, direction) in [
            ((-400.0, 80.0), PreviewDirection::Right),
            ((-176.0, 80.0), PreviewDirection::Right),
            ((-175.0, 80.0), PreviewDirection::Left),
            ((-48.0, 80.0), PreviewDirection::Left),
        ] {
            let layout = preview_layout(anchor, screen);
            assert_eq!(layout.direction, direction);
            assert_eq!(layout.direction.icon_position(layout.position), anchor);
        }
        assert_eq!(PreviewDirection::Left.as_str(), "left");
        assert_eq!(PreviewDirection::Right.as_str(), "right");
    }
    #[test]
    fn appearance_defaults_for_legacy_preferences_and_roundtrips_without_touching_geometry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        let legacy = json!({"pinned":true,"collapsed":true,"autostart":false,"position":[300,400],"screen":null});
        std::fs::write(&path, legacy.to_string()).unwrap();
        let store = PreferencesStore::open(&path, false).unwrap();
        assert_eq!(store.preferences.public_value()["theme"], "rose");
        let mut dark = legacy.clone();
        dark["theme"] = json!("github-dark");
        std::fs::write(&path, dark.to_string()).unwrap();
        let store = PreferencesStore::open(&path, false).unwrap();
        assert_eq!(store.preferences.public_value()["theme"], "github-dark");
        store.persist().unwrap();
        let reloaded = PreferencesStore::open(&path, false).unwrap();
        assert_eq!(reloaded.preferences.public_value()["theme"], "github-dark");
        assert_eq!(reloaded.preferences.position, Some((300.0, 400.0)));
        assert!(reloaded.preferences.pinned && reloaded.preferences.collapsed);
    }
    #[test]
    fn unknown_appearance_identifiers_fall_back_to_rose() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        for theme in [json!("unknown"), json!(null), json!({"color":"red"})] {
            std::fs::write(
                &path,
                json!({"pinned":false,"collapsed":false,"autostart":false,"theme":theme})
                    .to_string(),
            )
            .unwrap();
            assert_eq!(
                PreferencesStore::open(&path, false)
                    .unwrap()
                    .preferences
                    .public_value()["theme"],
                "rose"
            );
        }
    }
    #[test]
    fn failed_appearance_save_preserves_current_theme_and_other_preferences() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        let mut store = PreferencesStore::open(&path, false).unwrap();
        store.preferences.pinned = true;
        assert_eq!(store.toggle_theme().unwrap()["theme"], "github-dark");
        assert_eq!(store.toggle_theme().unwrap()["theme"], "rose");
        let before = store.preferences.clone();
        store.path = dir.path().join("absent").join("prefs.json");
        assert!(store.toggle_theme().is_err());
        assert_eq!(store.preferences, before);
        assert_eq!(
            PreferencesStore::open(&path, false).unwrap().preferences,
            before
        );
    }
    #[test]
    fn autostart_initialization_survives_qa_and_preserves_production_off_choice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("widget-preferences.json");
        let qa = PreferencesStore::open(&path, false).unwrap();
        assert!(!qa.preferences.should_initialize_production_autostart(false));
        qa.persist().unwrap();
        let mut production = PreferencesStore::open(&path, false).unwrap();
        assert!(production
            .preferences
            .should_initialize_production_autostart(true));
        assert!(!production.preferences.production_autostart_initialized);
        // Only a successful production enable/status check marks this flag.
        production.preferences.production_autostart_initialized = true;
        production.preferences.autostart = true;
        production.persist().unwrap();
        let mut disabled = PreferencesStore::open(&path, false).unwrap();
        disabled.preferences.autostart = false;
        disabled.persist().unwrap();
        let reopened = PreferencesStore::open(&path, false).unwrap();
        assert!(!reopened
            .preferences
            .should_initialize_production_autostart(true));
        assert!(!reopened.preferences.autostart);
        assert!(reopened.preferences.production_autostart_initialized);
    }
    #[test]
    fn legacy_preferences_do_not_consume_production_initialization() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        std::fs::write(
            &path,
            r#"{"pinned":false,"collapsed":false,"autostart":false}"#,
        )
        .unwrap();
        let store = PreferencesStore::open(&path, false).unwrap();
        assert!(store
            .preferences
            .should_initialize_production_autostart(true));
        assert!(!store
            .preferences
            .should_initialize_production_autostart(false));
    }
    #[test]
    fn defaults_and_private_atomic_preferences_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("widget-preferences.json");
        let mut store = PreferencesStore::open(&path, false).unwrap();
        assert_eq!(
            store.preferences.public_value(),
            serde_json::json!({"pinned":false,"collapsed":false,"autostart":false,"theme":"rose"})
        );
        store.preferences.pinned = true;
        store.preferences.collapsed = true;
        store.preferences.position = Some((900.0, 600.0));
        store.preferences.screen = Some(Rect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        });
        store.persist().unwrap();
        let reloaded = PreferencesStore::open(&path, true).unwrap();
        assert_eq!(reloaded.preferences, store.preferences);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn geometry_preserves_top_right_and_clamps_every_size() {
        let screen = Rect {
            x: -1000.0,
            y: 40.0,
            width: 1000.0,
            height: 700.0,
        };
        let initial = initial_position(screen, (320.0, 300.0));
        assert_eq!(initial, (-336.0, 424.0));
        let icon = resize_anchor(initial, (320.0, 300.0), (48.0, 48.0));
        assert_eq!(icon, (-64.0, 424.0));
        assert_eq!(resize_anchor(icon, (48.0, 48.0), (320.0, 300.0)), initial);
        for x in [-100000.0, -1000.0, -100.0, 0.0, 100000.0] {
            for y in [-100000.0, 40.0, 100.0, 100000.0] {
                for size in [(320.0, 300.0), (48.0, 48.0)] {
                    let (a, b) = clamp_position((x, y), screen, size);
                    assert!(a >= screen.x && a + size.0 <= screen.x + screen.width);
                    assert!(b >= screen.y && b + size.1 <= screen.y + screen.height);
                    assert_eq!(clamp_position((a, b), screen, size), (a, b));
                }
            }
        }
    }
    #[test]
    fn ipc_and_preferences_reject_malformed_values() {
        assert!(valid_request_id("request:1"));
        assert!(!valid_request_id(""));
        assert!(!valid_request_id(&"a".repeat(129)));
        assert!(!valid_request_id("line\nbreak"));
        assert!(valid_day("2026-01-31"));
        assert!(!valid_day("2026-02-30"));
        assert!(!valid_day("2026-1-31"));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prefs.json");
        std::fs::write(
            &path,
            r#"{"pinned":false,"collapsed":false,"autostart":false,"position":[null,0]}"#,
        )
        .unwrap();
        assert!(PreferencesStore::open(&path, false).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_preferences_are_rejected_before_read_or_write() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("retained.json");
        let bytes = r#"{"pinned":false,"collapsed":false,"autostart":false}"#;
        std::fs::write(&target, bytes).unwrap();
        let link = dir.path().join("prefs.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(PreferencesStore::open(&link, false).is_err());
        let mut store = PreferencesStore::open(&dir.path().join("new.json"), false).unwrap();
        store.path = link;
        assert!(store.persist().is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), bytes);
    }
}
