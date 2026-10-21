use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSelection {
    pub provider: String,
    pub model_id: String,
}
impl Default for ModelSelection {
    fn default() -> Self {
        Self {
            provider: "deepseek".into(),
            model_id: "deepseek-flash".into(),
        }
    }
}
pub fn validate_provider(provider: &str) -> Result<(), &'static str> {
    if provider.is_empty()
        || provider.len() > 64
        || !provider
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("provider_unsupported");
    }
    Ok(())
}
pub fn validate_selection(model: &ModelSelection) -> Result<(), &'static str> {
    validate_provider(&model.provider)?;
    if model.model_id.is_empty()
        || model.model_id.len() > 512
        || model.model_id.chars().any(char::is_control)
    {
        return Err("invalid_model");
    }
    Ok(())
}
pub fn load(db: &rusqlite::Connection) -> Result<ModelSelection, &'static str> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS default_model(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)").map_err(|_| "settings_open_failed")?;
    let body: Option<String> = db
        .query_row("SELECT body FROM default_model WHERE id=1", [], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|_| "settings_read_failed")?;
    let model = body
        .map(|body| serde_json::from_str(&body).map_err(|_| "invalid_model"))
        .transpose()?
        .unwrap_or_default();
    validate_selection(&model)?;
    Ok(model)
}
pub fn save(db: &rusqlite::Connection, model: &ModelSelection) -> Result<(), &'static str> {
    validate_selection(model)?;
    let body = serde_json::to_string(model).map_err(|_| "invalid_model")?;
    db.execute("INSERT INTO default_model(id,body) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET body=excluded.body", [body]).map_err(|_| "settings_write_failed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_model_selection_migrates_to_deepseek_and_failed_writes_preserve_selection() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        assert_eq!(load(&db).unwrap(), ModelSelection::default());
        let selected = ModelSelection {
            provider: "openai".into(),
            model_id: "model-with/slash".into(),
        };
        save(&db, &selected).unwrap();
        db.execute_batch("PRAGMA query_only=ON").unwrap();
        assert_eq!(
            save(&db, &ModelSelection::default()),
            Err("settings_write_failed")
        );
        assert_eq!(load(&db).unwrap(), selected);
    }
    #[test]
    fn invalid_or_corrupt_selection_is_reported_without_replacing_it() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        load(&db).unwrap();
        db.execute("INSERT INTO default_model VALUES(1,?1)", ["not-json"])
            .unwrap();
        assert_eq!(load(&db), Err("invalid_model"));
        assert!(validate_provider("../../other-account").is_err());
        assert!(
            validate_selection(&ModelSelection {
                provider: "openai".into(),
                model_id: "\n".into()
            })
            .is_err()
        );
    }
}
