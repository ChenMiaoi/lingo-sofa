use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Input,
    Selection,
    Clipboard,
    SelectionAlternate,
    Ocr,
    OcrAlternate,
}
const ACTIONS: [Action; 6] = [
    Action::Input,
    Action::Selection,
    Action::Clipboard,
    Action::SelectionAlternate,
    Action::Ocr,
    Action::OcrAlternate,
];
fn active_count() -> usize {
    if cfg!(any(target_os = "macos", windows)) {
        6
    } else {
        4
    }
}
fn selection_alternate() -> String {
    "Ctrl+Alt+Shift+S".into()
}
fn ocr() -> String {
    "Alt+Shift+O".into()
}
fn ocr_alternate() -> String {
    "Ctrl+Alt+Shift+O".into()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bindings {
    pub input: String,
    pub selection: String,
    pub clipboard: String,
    #[serde(default = "selection_alternate")]
    pub selection_alternate: String,
    #[serde(default = "ocr")]
    pub ocr: String,
    #[serde(default = "ocr_alternate")]
    pub ocr_alternate: String,
}
impl Default for Bindings {
    fn default() -> Self {
        Self {
            input: "Alt+Shift+Space".into(),
            selection: "Alt+Shift+S".into(),
            clipboard: "Alt+Shift+T".into(),
            selection_alternate: selection_alternate(),
            ocr: ocr(),
            ocr_alternate: ocr_alternate(),
        }
    }
}
impl Bindings {
    fn from_stored(body: &str) -> Result<Self, String> {
        let stored: serde_json::Value =
            serde_json::from_str(body).map_err(|_| "shortcuts_invalid_storage")?;
        let mut bindings: Self =
            serde_json::from_value(stored.clone()).map_err(|_| "shortcuts_invalid_storage")?;
        // Keep every existing combination. A new default must not collide with
        // an older custom binding and prevent the application from starting.
        for (index, name) in [(3, "selectionAlternate"), (4, "ocr"), (5, "ocrAlternate")] {
            // Older Windows versions persisted the two inactive OCR defaults too.
            // Their presence does not mean a user had configured those actions.
            let existing = stored.get(name).is_some() && !(cfg!(windows) && index >= 4);
            if index >= active_count() || existing {
                continue;
            }
            let values = bindings.values();
            let keys: Vec<_> = values
                .iter()
                .take(active_count())
                .map(|value| value.parse::<Shortcut>().ok())
                .collect();
            if keys[index].is_some_and(|key| {
                keys.iter()
                    .enumerate()
                    .any(|(other, value)| other != index && *value == Some(key))
            }) {
                let replacement = (1..=24)
                    .map(|number| format!("Ctrl+Alt+F{number}"))
                    .find(|value| !keys.contains(&value.parse::<Shortcut>().ok()))
                    .ok_or("shortcut_duplicate")?;
                match index {
                    3 => bindings.selection_alternate = replacement,
                    4 => bindings.ocr = replacement,
                    5 => bindings.ocr_alternate = replacement,
                    _ => unreachable!(),
                }
            }
        }
        Ok(bindings)
    }
    fn values(&self) -> [&str; 6] {
        [
            &self.input,
            &self.selection,
            &self.clipboard,
            &self.selection_alternate,
            &self.ocr,
            &self.ocr_alternate,
        ]
    }
    fn validate(&self) -> Result<(Self, [Shortcut; 6]), String> {
        self.validate_for_platform(cfg!(target_os = "macos"))
    }
    fn validate_for_platform(&self, macos: bool) -> Result<(Self, [Shortcut; 6]), String> {
        let mut values = Vec::new();
        let mut keys = Vec::new();
        for (index, value) in self.values().iter().enumerate() {
            let invalid = || format!("shortcut_invalid_{index}");
            let mut parts = Vec::new();
            for part in value.split('+').map(str::trim) {
                if part.is_empty() {
                    return Err(invalid());
                }
                // Accept both compact macOS notation (⌘⌥S) and separated symbols.
                let expanded = if macos {
                    part.replace('⌘', "Command+")
                        .replace('⌥', "Alt+")
                        .replace('⌃', "Ctrl+")
                        .replace('⇧', "Shift+")
                } else {
                    part.to_string()
                };
                parts.extend(
                    expanded
                        .trim_end_matches('+')
                        .split('+')
                        .map(str::to_string),
                );
            }
            let mut ctrl = false;
            let mut alt = false;
            let mut shift = false;
            let mut command = false;
            let mut key = None;
            for part in parts {
                match part.to_ascii_lowercase().as_str() {
                    "ctrl" | "control" if !ctrl => ctrl = true,
                    "alt" if !alt => alt = true,
                    "option" | "opt" if macos && !alt => alt = true,
                    "command" | "cmd" | "meta" | "super" if macos && !command => command = true,
                    "shift" if !shift => shift = true,
                    raw if key.is_none() => {
                        let normalized = if raw == "space" {
                            "Space".to_string()
                        } else if (raw.len() == 1 && raw.as_bytes()[0].is_ascii_alphanumeric())
                            || raw
                                .strip_prefix('f')
                                .and_then(|n| n.parse::<u8>().ok())
                                .is_some_and(|n| (1..=24).contains(&n))
                        {
                            raw.to_ascii_uppercase()
                        } else {
                            return Err(invalid());
                        };
                        key = Some(normalized);
                    }
                    _ => return Err(invalid()),
                }
            }
            if !ctrl && !alt && !command {
                return Err(invalid());
            }
            let mut normalized = String::new();
            if ctrl {
                normalized.push_str("Ctrl+");
            }
            if alt {
                normalized.push_str("Alt+");
            }
            if shift {
                normalized.push_str("Shift+");
            }
            if command {
                normalized.push_str("Super+");
            }
            normalized.push_str(&key.ok_or_else(invalid)?);
            let parsed = normalized.parse::<Shortcut>().map_err(|_| invalid())?;
            if index < active_count() && keys.iter().any(|k: &Shortcut| k.id() == parsed.id()) {
                return Err("shortcut_duplicate".into());
            }
            values.push(normalized);
            keys.push(parsed);
        }
        Ok((
            Self {
                input: values[0].clone(),
                selection: values[1].clone(),
                clipboard: values[2].clone(),
                selection_alternate: values[3].clone(),
                ocr: values[4].clone(),
                ocr_alternate: values[5].clone(),
            },
            keys.try_into().unwrap(),
        ))
    }
}

pub trait Registry {
    fn register(&self, key: Shortcut) -> Result<(), ()>;
    fn unregister(&self, key: Shortcut) -> Result<(), ()>;
}
pub struct AppRegistry<'a>(pub &'a tauri::AppHandle);
impl Registry for AppRegistry<'_> {
    fn register(&self, key: Shortcut) -> Result<(), ()> {
        self.0.global_shortcut().register(key).map_err(|_| ())
    }
    fn unregister(&self, key: Shortcut) -> Result<(), ()> {
        self.0.global_shortcut().unregister(key).map_err(|_| ())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub macos: bool,
    pub ocr: bool,
    pub bindings: Bindings,
    pub registered: Vec<bool>,
    pub revision: u64,
    pub message: String,
    pub recording: bool,
}
pub struct Manager {
    db: rusqlite::Connection,
    bindings: Bindings,
    keys: [Shortcut; 6],
    held: HashMap<u32, Shortcut>,
    revision: u64,
    message: String,
    recording: Option<Recording>,
}
struct Recording {
    token: String,
    keys: Vec<Shortcut>,
    active: bool,
    message: String,
}
impl Manager {
    pub fn open(path: &std::path::Path) -> Result<Self, String> {
        let db = rusqlite::Connection::open(path).map_err(|_| "shortcuts_storage_failed")?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS shortcuts(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)").map_err(|_| "shortcuts_storage_failed")?;
        let body: Option<String> = db
            .query_row("SELECT body FROM shortcuts WHERE id=1", [], |r| r.get(0))
            .optional()
            .map_err(|_| "shortcuts_storage_failed")?;
        let bindings = match body {
            Some(body) => Bindings::from_stored(&body)?,
            None => Bindings::default(),
        };
        let (bindings, keys) = bindings.validate()?;
        Ok(Self {
            db,
            bindings,
            keys,
            held: HashMap::new(),
            revision: 0,
            message: String::new(),
            recording: None,
        })
    }
    pub fn begin_recording(
        &mut self,
        token: String,
        registry: &impl Registry,
    ) -> Result<(), String> {
        if self.recording.is_some() || token.is_empty() || token.len() > 80 {
            return Err("shortcut_recording_unavailable".into());
        }
        let keys: Vec<_> = self.held.values().copied().collect();
        let mut released = Vec::new();
        for key in &keys {
            if registry.unregister(*key).is_err() {
                self.recording = Some(Recording {
                    token,
                    keys: released,
                    active: false,
                    message: self.message.clone(),
                });
                let _ = self.end_recording(None, registry);
                return Err("shortcut_recording_unavailable".into());
            }
            self.held.remove(&key.id());
            released.push(*key);
        }
        self.recording = Some(Recording {
            token,
            keys,
            active: true,
            message: self.message.clone(),
        });
        Ok(())
    }
    pub fn end_recording(
        &mut self,
        token: Option<&str>,
        registry: &impl Registry,
    ) -> Result<(), String> {
        let Some(recording) = self.recording.as_mut() else {
            return Ok(());
        };
        if token.is_some_and(|token| token != recording.token) {
            return Ok(());
        }
        recording.active = false;
        let mut failed = false;
        for key in &recording.keys {
            if let std::collections::hash_map::Entry::Vacant(entry) = self.held.entry(key.id()) {
                if registry.register(*key).is_ok() {
                    entry.insert(*key);
                } else {
                    failed = true;
                }
            }
        }
        if failed {
            self.message = "部分快捷键未恢复，请结束录入后重试恢复。".into();
            return Err("shortcut_recording_restore_failed".into());
        }
        self.message = recording.message.clone();
        self.recording = None;
        Ok(())
    }
    pub fn initialize(&mut self, registry: &impl Registry) {
        for key in self.keys.iter().take(active_count()).copied() {
            if registry.register(key).is_ok() {
                self.held.insert(key.id(), key);
            }
        }
        if self.snapshot().registered.contains(&false) {
            self.message = "部分快捷键无法注册，请在设置中更换组合。".into();
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            macos: cfg!(target_os = "macos"),
            ocr: cfg!(any(target_os = "macos", windows)),
            bindings: self.bindings.clone(),
            registered: self
                .keys
                .iter()
                .take(active_count())
                .map(|key| self.held.contains_key(&key.id()))
                .collect(),
            revision: self.revision,
            message: self.message.clone(),
            recording: self
                .recording
                .as_ref()
                .is_some_and(|recording| recording.active),
        }
    }
    pub fn action(&self, key: &Shortcut) -> Option<Action> {
        if self
            .recording
            .as_ref()
            .is_some_and(|recording| recording.active)
        {
            return None;
        }
        self.keys
            .iter()
            .position(|k| k.id() == key.id() && self.held.contains_key(&k.id()))
            .map(|i| ACTIONS[i])
    }
    fn cleanup(&mut self, registry: &impl Registry, ids: &HashSet<u32>) {
        let obsolete: Vec<_> = self
            .held
            .values()
            .filter(|key| !ids.contains(&key.id()))
            .copied()
            .collect();
        for key in obsolete {
            if registry.unregister(key).is_ok() {
                self.held.remove(&key.id());
            } else {
                self.message = "旧组合已停止响应，但系统未能释放注册；退出应用后可释放。".into();
            }
        }
    }
    pub fn save(&mut self, proposed: Bindings, registry: &impl Registry) -> Result<(), String> {
        if self.recording.is_some() {
            return Err("shortcut_recording_unavailable".into());
        }
        let (bindings, keys) = proposed.validate()?;
        let old: HashSet<_> = self.held.keys().copied().collect();
        for (index, key) in keys.iter().take(active_count()).enumerate() {
            if !self.held.contains_key(&key.id()) {
                if registry.register(*key).is_err() {
                    self.cleanup(registry, &old);
                    return Err(format!("shortcut_conflict_{index}"));
                }
                self.held.insert(key.id(), *key);
            }
        }
        let body = serde_json::to_string(&bindings).map_err(|_| "shortcuts_storage_failed")?;
        if self.db.execute("INSERT INTO shortcuts(id,body) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET body=excluded.body", [body]).is_err() {
            self.cleanup(registry, &old);
            return Err("shortcuts_storage_failed".into());
        }
        // Publish routing only after persistence succeeds. Staged keys never
        // dispatch actions; obsolete registrations left by OS failures do not either.
        self.bindings = bindings;
        self.keys = keys;
        self.revision += 1;
        self.message = "快捷键已保存并生效。".into();
        self.cleanup(
            registry,
            &keys.iter().take(active_count()).map(Shortcut::id).collect(),
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[derive(Default)]
    struct Fake {
        held: RefCell<HashSet<u32>>,
        blocked: RefCell<HashSet<u32>>,
        fail_remove: RefCell<bool>,
        remove_calls: std::cell::Cell<usize>,
        fail_remove_at: std::cell::Cell<Option<usize>>,
    }
    impl Registry for Fake {
        fn register(&self, key: Shortcut) -> Result<(), ()> {
            if self.blocked.borrow().contains(&key.id()) || !self.held.borrow_mut().insert(key.id())
            {
                Err(())
            } else {
                Ok(())
            }
        }
        fn unregister(&self, key: Shortcut) -> Result<(), ()> {
            let call = self.remove_calls.get() + 1;
            self.remove_calls.set(call);
            if *self.fail_remove.borrow() || self.fail_remove_at.get() == Some(call) {
                Err(())
            } else {
                self.held.borrow_mut().remove(&key.id());
                Ok(())
            }
        }
    }
    fn changed() -> Bindings {
        Bindings {
            input: "Ctrl+Alt+I".into(),
            selection: "Ctrl+Alt+S".into(),
            clipboard: "Ctrl+Alt+T".into(),
            ..Bindings::default()
        }
    }
    #[test]
    fn recording_suspends_registered_combinations_and_restores_without_persisting_changes() {
        let mut manager = Manager::open(std::path::Path::new(":memory:")).unwrap();
        let registry = Fake::default();
        manager.initialize(&registry);
        let original = manager.snapshot();
        let keys = manager.keys;
        manager.begin_recording("first".into(), &registry).unwrap();
        assert!(registry.held.borrow().is_empty());
        assert!(manager.snapshot().recording);
        for key in keys {
            assert_eq!(manager.action(&key), None);
        }
        assert!(manager.save(changed(), &registry).is_err());
        manager.end_recording(Some("stale"), &registry).unwrap();
        assert!(manager.snapshot().recording);
        manager.end_recording(Some("first"), &registry).unwrap();
        let restored = manager.snapshot();
        assert!(!restored.recording);
        assert_eq!(restored.registered, original.registered);
        assert_eq!(restored.revision, original.revision);
        assert_eq!(
            serde_json::to_string(&restored.bindings).unwrap(),
            serde_json::to_string(&original.bindings).unwrap()
        );
        assert_eq!(manager.action(&keys[0]), Some(Action::Input));
        let persisted: i64 = manager
            .db
            .query_row("SELECT count(*) FROM shortcuts", [], |row| row.get(0))
            .unwrap();
        assert_eq!(persisted, 0);
        manager.begin_recording("second".into(), &registry).unwrap();
        manager.end_recording(Some("first"), &registry).unwrap();
        assert!(
            manager.snapshot().recording,
            "a stale token cannot release a newer recording"
        );
        manager.end_recording(None, &registry).unwrap(); // Native focus/close and remount recovery.
        assert_eq!(manager.snapshot().registered, original.registered);
    }
    #[test]
    fn recording_unregister_failure_rolls_back_and_restoration_failure_remains_retryable() {
        let mut manager = Manager::open(std::path::Path::new(":memory:")).unwrap();
        let registry = Fake::default();
        manager.initialize(&registry);
        let count = registry.held.borrow().len();
        registry.fail_remove_at.set(Some(2));
        assert!(
            manager
                .begin_recording("rollback".into(), &registry)
                .is_err()
        );
        assert_eq!(registry.held.borrow().len(), count);
        assert!(!manager.snapshot().recording);
        registry.fail_remove_at.set(None);
        manager.begin_recording("retry".into(), &registry).unwrap();
        let blocked = manager.keys[0];
        registry.blocked.borrow_mut().insert(blocked.id());
        assert!(manager.end_recording(Some("retry"), &registry).is_err());
        assert!(!manager.snapshot().registered[0]);
        assert_eq!(manager.action(&blocked), None);
        assert!(manager.snapshot().message.contains("未恢复"));
        registry.blocked.borrow_mut().clear();
        manager.end_recording(None, &registry).unwrap();
        assert_eq!(registry.held.borrow().len(), count);
        assert!(
            manager
                .snapshot()
                .registered
                .iter()
                .all(|registered| *registered)
        );
        assert!(!manager.snapshot().message.contains("未恢复"));
    }
    #[test]
    fn aliases_duplicates_and_unsafe_or_ambiguous_combinations_are_validated() {
        let mut value = Bindings {
            input: " shift + ALT + space ".into(),
            ..Bindings::default()
        };
        assert_eq!(value.validate().unwrap().0, Bindings::default());
        for invalid in [
            "S",
            "Shift+S",
            "Win+S",
            "Ctrl++S",
            "Ctrl+Alt+Delete",
            "Ctrl+Ctrl+S",
        ] {
            value.input = invalid.into();
            assert!(value.validate().is_err(), "{invalid}");
        }
        value.input = "Shift+Alt+S".into();
        assert_eq!(value.validate().unwrap_err(), "shortcut_duplicate");
    }
    #[test]
    fn macos_aliases_and_symbols_map_to_native_modifiers_and_detect_duplicates() {
        for alias in ["Command", "Cmd", "Meta", "Super", "⌘"] {
            let value = Bindings {
                input: format!("{alias}+Option+I"),
                ..Bindings::default()
            };
            let (normalized, keys) = value.validate_for_platform(true).unwrap();
            assert_eq!(normalized.input, "Alt+Super+I");
            assert_eq!(keys[0], "Alt+Super+I".parse::<Shortcut>().unwrap());
            assert!(value.validate_for_platform(false).is_err());
        }
        for alias in ["Option", "Opt", "Alt", "⌥"] {
            let value = Bindings {
                input: format!("{alias}+Shift+Space"),
                ..Bindings::default()
            };
            assert_eq!(
                value.validate_for_platform(true).unwrap().0,
                Bindings::default()
            );
        }
        for input in ["⌃⌥⇧⌘I", "⌃+⌥+⇧+⌘+I", " control + option + shift + cmd + i "]
        {
            let value = Bindings {
                input: input.into(),
                ..Bindings::default()
            };
            assert_eq!(
                value.validate_for_platform(true).unwrap().0.input,
                "Ctrl+Alt+Shift+Super+I"
            );
        }
        for input in [
            "Cmd+Cmd+I",
            "Command+Meta+I",
            "Option+Alt+I",
            "⌘⌘I",
            "⌘++I",
            "⌘",
            "⇧I",
            "Cmd+Delete",
        ] {
            let value = Bindings {
                input: input.into(),
                ..Bindings::default()
            };
            assert!(value.validate_for_platform(true).is_err(), "{input}");
        }
        let value = Bindings {
            input: "Cmd+Option+S".into(),
            selection: "⌥⌘S".into(),
            ..Bindings::default()
        };
        assert_eq!(
            value.validate_for_platform(true).unwrap_err(),
            "shortcut_duplicate"
        );
        assert_eq!(
            Bindings::default().validate_for_platform(false).unwrap().0,
            Bindings::default()
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn command_bindings_persist_route_and_keep_previous_binding_on_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shortcuts.sqlite");
        let mut manager = Manager::open(&path).unwrap();
        let registry = Fake::default();
        manager.initialize(&registry);
        let proposed = Bindings {
            input: "⌘⌥I".into(),
            selection: "Command+Shift+S".into(),
            clipboard: "Meta+T".into(),
            ..Bindings::default()
        };
        manager.save(proposed.clone(), &registry).unwrap();
        assert_eq!(
            manager.action(&"Super+T".parse().unwrap()),
            Some(Action::Clipboard)
        );
        assert_eq!(manager.action(&"Alt+Shift+T".parse().unwrap()), None);
        let mut reopened = Manager::open(&path).unwrap();
        assert!(reopened.snapshot().macos);
        assert_eq!(reopened.bindings, proposed.validate().unwrap().0);
        let next_registry = Fake::default();
        reopened.initialize(&next_registry);
        assert_eq!(reopened.snapshot().registered, vec![true; active_count()]);
        next_registry
            .blocked
            .borrow_mut()
            .insert("Super+Q".parse::<Shortcut>().unwrap().id());
        let conflicting = Bindings {
            input: "Cmd+Q".into(),
            ..proposed.clone()
        };
        assert_eq!(
            reopened.save(conflicting, &next_registry).unwrap_err(),
            "shortcut_conflict_0"
        );
        assert_eq!(reopened.bindings, proposed.validate().unwrap().0);
        assert_eq!(
            reopened.action(&"Alt+Super+I".parse().unwrap()),
            Some(Action::Input)
        );
    }
    #[test]
    fn startup_conflict_is_visible_and_retry_recovers_without_disabling_other_actions() {
        let mut manager = Manager::open(std::path::Path::new(":memory:")).unwrap();
        let registry = Fake::default();
        let input = manager.keys[0];
        registry.blocked.borrow_mut().insert(input.id());
        manager.initialize(&registry);
        assert_eq!(manager.snapshot().registered, {
            let mut flags = vec![true; active_count()];
            flags[0] = false;
            flags
        });
        assert_eq!(manager.action(&input), None);
        registry.blocked.borrow_mut().clear();
        manager.save(Bindings::default(), &registry).unwrap();
        assert_eq!(manager.snapshot().registered, vec![true; active_count()]);
        assert_eq!(manager.action(&input), Some(Action::Input));
    }
    #[test]
    fn registration_and_persistence_failures_keep_previous_routes_and_undo_staged_keys() {
        let mut manager = Manager::open(std::path::Path::new(":memory:")).unwrap();
        let registry = Fake::default();
        manager.initialize(&registry);
        let old = registry.held.borrow().clone();
        registry
            .blocked
            .borrow_mut()
            .insert(changed().validate().unwrap().1[1].id());
        assert_eq!(
            manager.save(changed(), &registry).unwrap_err(),
            "shortcut_conflict_1"
        );
        assert_eq!(*registry.held.borrow(), old);
        assert_eq!(manager.bindings, Bindings::default());
        registry.blocked.borrow_mut().clear();
        manager.db.execute_batch("PRAGMA query_only=ON").unwrap();
        assert_eq!(
            manager.save(changed(), &registry).unwrap_err(),
            "shortcuts_storage_failed"
        );
        assert_eq!(*registry.held.borrow(), old);
        assert_eq!(manager.action(&manager.keys[0]), Some(Action::Input));
    }
    #[test]
    fn swaps_persist_across_restart_and_obsolete_os_registrations_never_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shortcuts.sqlite");
        let mut manager = Manager::open(&path).unwrap();
        let registry = Fake::default();
        manager.initialize(&registry);
        let mut swap = Bindings::default();
        std::mem::swap(&mut swap.input, &mut swap.selection);
        manager.save(swap.clone(), &registry).unwrap();
        assert_eq!(registry.held.borrow().len(), active_count());
        assert_eq!(
            manager.action(&"Alt+Shift+S".parse().unwrap()),
            Some(Action::Input)
        );
        assert_eq!(Manager::open(&path).unwrap().bindings, swap);
        let stale = manager.keys[0];
        *registry.fail_remove.borrow_mut() = true;
        manager.save(changed(), &registry).unwrap();
        assert_eq!(manager.action(&stale), None);
        assert!(manager.snapshot().message.contains("未能释放"));
        assert_eq!(Manager::open(&path).unwrap().bindings, changed());
    }
    #[test]
    fn legacy_bindings_keep_old_combinations_and_avoid_new_default_collisions() {
        let old =
            r#"{"input":"Ctrl+Alt+Shift+S","selection":"Alt+Shift+O","clipboard":"Alt+Shift+T"}"#;
        let bindings = Bindings::from_stored(old).unwrap();
        assert_eq!(bindings.input, "Ctrl+Alt+Shift+S");
        assert_eq!(bindings.selection, "Alt+Shift+O");
        assert_ne!(bindings.selection_alternate, bindings.input);
        if cfg!(any(target_os = "macos", windows)) {
            assert_ne!(bindings.ocr, bindings.selection);
        }
        assert!(bindings.validate().is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn previously_inactive_stored_ocr_defaults_cannot_block_windows_startup() {
        let old = Bindings {
            selection: "Alt+Shift+O".into(),
            clipboard: "Ctrl+Alt+Shift+O".into(),
            ..Bindings::default()
        };
        let stored = serde_json::to_string(&old).unwrap();
        let migrated = Bindings::from_stored(&stored).unwrap();
        assert_eq!(migrated.input, old.input);
        assert_eq!(migrated.selection, old.selection);
        assert_eq!(migrated.clipboard, old.clipboard);
        assert_eq!(migrated.selection_alternate, old.selection_alternate);
        assert_ne!(migrated.ocr, old.selection);
        assert_ne!(migrated.ocr_alternate, old.clipboard);
        assert!(migrated.validate().is_ok());
        assert_eq!(
            Bindings::from_stored(&serde_json::to_string(&migrated).unwrap()).unwrap(),
            migrated
        );
        let custom = Bindings {
            ocr: "Ctrl+Alt+Q".into(),
            ..migrated.clone()
        };
        assert_eq!(
            Bindings::from_stored(&serde_json::to_string(&custom).unwrap()).unwrap(),
            custom
        );
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shortcuts.sqlite");
        let mut manager = Manager::open(&path).unwrap();
        manager.save(migrated.clone(), &Fake::default()).unwrap();
        drop(manager);
        assert_eq!(Manager::open(&path).unwrap().bindings, migrated);
    }
    #[test]
    fn alternate_and_ocr_shortcuts_route_separately_without_changing_old_actions() {
        let mut manager = Manager::open(std::path::Path::new(":memory:")).unwrap();
        manager.initialize(&Fake::default());
        assert_eq!(
            manager.action(&"Alt+Shift+S".parse().unwrap()),
            Some(Action::Selection)
        );
        assert_eq!(
            manager.action(&"Ctrl+Alt+Shift+S".parse().unwrap()),
            Some(Action::SelectionAlternate)
        );
        assert_eq!(
            manager.action(&"Alt+Shift+O".parse().unwrap()),
            if cfg!(any(target_os = "macos", windows)) {
                Some(Action::Ocr)
            } else {
                None
            }
        );
        assert_eq!(
            manager.action(&"Ctrl+Alt+Shift+O".parse().unwrap()),
            if cfg!(any(target_os = "macos", windows)) {
                Some(Action::OcrAlternate)
            } else {
                None
            }
        );
    }
}
