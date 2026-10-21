use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Input,
    Selection,
    Clipboard,
}
const ACTIONS: [Action; 3] = [Action::Input, Action::Selection, Action::Clipboard];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bindings {
    pub input: String,
    pub selection: String,
    pub clipboard: String,
}
impl Default for Bindings {
    fn default() -> Self {
        Self {
            input: "Alt+Shift+Space".into(),
            selection: "Alt+Shift+S".into(),
            clipboard: "Alt+Shift+T".into(),
        }
    }
}
impl Bindings {
    fn values(&self) -> [&str; 3] {
        [&self.input, &self.selection, &self.clipboard]
    }
    fn validate(&self) -> Result<(Self, [Shortcut; 3]), String> {
        let mut values = Vec::new();
        let mut keys = Vec::new();
        for (index, value) in self.values().iter().enumerate() {
            let parts: Vec<_> = value.split('+').map(str::trim).collect();
            let mut ctrl = false;
            let mut alt = false;
            let mut shift = false;
            let mut key = None;
            let invalid = || format!("shortcut_invalid_{index}");
            for part in parts {
                match part.to_ascii_lowercase().as_str() {
                    "ctrl" | "control" if !ctrl => ctrl = true,
                    "alt" if !alt => alt = true,
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
            if !ctrl && !alt {
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
            normalized.push_str(&key.ok_or_else(invalid)?);
            let parsed = normalized.parse::<Shortcut>().map_err(|_| invalid())?;
            if keys.iter().any(|k: &Shortcut| k.id() == parsed.id()) {
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
    pub bindings: Bindings,
    pub registered: [bool; 3],
    pub revision: u64,
    pub message: String,
}
pub struct Manager {
    db: rusqlite::Connection,
    bindings: Bindings,
    keys: [Shortcut; 3],
    held: HashMap<u32, Shortcut>,
    revision: u64,
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
            Some(body) => {
                serde_json::from_str::<Bindings>(&body).map_err(|_| "shortcuts_invalid_storage")?
            }
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
        })
    }
    pub fn initialize(&mut self, registry: &impl Registry) {
        for key in self.keys {
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
            bindings: self.bindings.clone(),
            registered: self.keys.map(|key| self.held.contains_key(&key.id())),
            revision: self.revision,
            message: self.message.clone(),
        }
    }
    pub fn action(&self, key: &Shortcut) -> Option<Action> {
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
        let (bindings, keys) = proposed.validate()?;
        let old: HashSet<_> = self.held.keys().copied().collect();
        for (index, key) in keys.iter().enumerate() {
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
        self.cleanup(registry, &keys.iter().map(Shortcut::id).collect());
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
            if *self.fail_remove.borrow() {
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
        }
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
    fn startup_conflict_is_visible_and_retry_recovers_without_disabling_other_actions() {
        let mut manager = Manager::open(std::path::Path::new(":memory:")).unwrap();
        let registry = Fake::default();
        let input = manager.keys[0];
        registry.blocked.borrow_mut().insert(input.id());
        manager.initialize(&registry);
        assert_eq!(manager.snapshot().registered, [false, true, true]);
        assert_eq!(manager.action(&input), None);
        registry.blocked.borrow_mut().clear();
        manager.save(Bindings::default(), &registry).unwrap();
        assert_eq!(manager.snapshot().registered, [true; 3]);
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
        assert_eq!(registry.held.borrow().len(), 3);
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
}
