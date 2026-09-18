use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::theme::Mode;

const VERSION: u8 = 1;
const MAX_ITEMS: usize = 500;
const MAX_PATH_CHARS: usize = 4096;
const MAX_ID_CHARS: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    System,
    Dark,
    Light,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub version: u8,
    pub theme: ThemePreference,
    pub pinned_project_paths: Vec<String>,
    pub pinned_session_ids: Vec<String>,
    pub archived_session_ids: Vec<String>,
    pub unread_session_ids: Vec<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            version: VERSION,
            theme: ThemePreference::System,
            pinned_project_paths: Vec::new(),
            pinned_session_ids: Vec::new(),
            archived_session_ids: Vec::new(),
            unread_session_ids: Vec::new(),
        }
    }
}

impl Preferences {
    pub fn load() -> Self {
        let path = path();
        if let Some(preferences) = read_preferences(&path) {
            return preferences;
        }
        let mut preferences = Self::default();
        if let Some(legacy) = legacy_path().and_then(|path| read_json(&path)) {
            migrate(&mut preferences, &legacy);
            let _ = preferences.save();
        }
        preferences
    }

    pub fn mode(&self, system: Mode) -> Mode {
        match self.theme {
            ThemePreference::System => system,
            ThemePreference::Dark => Mode::Dark,
            ThemePreference::Light => Mode::Light,
        }
    }

    pub fn toggle_theme(&mut self, current: Mode) -> Mode {
        let next = if current == Mode::Dark {
            Mode::Light
        } else {
            Mode::Dark
        };
        self.theme = if next == Mode::Dark {
            ThemePreference::Dark
        } else {
            ThemePreference::Light
        };
        let _ = self.save();
        next
    }

    pub fn set_session_archived(&mut self, id: &str, archived: bool) -> Result<(), String> {
        if id.is_empty() || id.chars().count() > MAX_ID_CHARS || id.chars().any(char::is_control) {
            return Err("invalid session id".into());
        }
        if archived
            && !self.archived_session_ids.iter().any(|value| value == id)
            && self.archived_session_ids.len() >= MAX_ITEMS
        {
            return Err("too many archived sessions".into());
        }
        self.archived_session_ids.retain(|value| value != id);
        if archived {
            self.archived_session_ids.push(id.to_owned());
            self.pinned_session_ids.retain(|value| value != id);
        }
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        let path = path();
        let parent = path
            .parent()
            .ok_or_else(|| "native desktop state path has no parent".to_owned())?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = parent.join(format!(".desktop.json.{}.tmp", std::process::id()));
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        fs::write(&temporary, [bytes, b"\n".to_vec()].concat())
            .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        fs::rename(temporary, path).map_err(|error| error.to_string())
    }
}

fn read_preferences(path: &Path) -> Option<Preferences> {
    let value = read_json(path)?;
    let version = value.get("version").and_then(serde_json::Value::as_u64)?;
    if version != u64::from(VERSION) {
        return None;
    }
    serde_json::from_value(value).ok()
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > 2 * 1024 * 1024 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn migrate(preferences: &mut Preferences, value: &serde_json::Value) {
    let settings = value.get("settings").and_then(serde_json::Value::as_object);
    preferences.theme = match settings
        .and_then(|settings| settings.get("theme"))
        .and_then(serde_json::Value::as_str)
    {
        Some("dark") => ThemePreference::Dark,
        Some("light") => ThemePreference::Light,
        _ => ThemePreference::System,
    };
    preferences.pinned_project_paths = string_list(value, "pinnedProjectPaths", true);
    preferences.pinned_session_ids = string_list(value, "pinnedSessionIds", false);
    preferences.archived_session_ids = string_list(value, "archivedSessionIds", false);
    preferences.unread_session_ids = string_list(value, "unreadSessionIds", false);
}

fn string_list(value: &serde_json::Value, key: &str, path: bool) -> Vec<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.chars().count() <= if path { MAX_PATH_CHARS } else { MAX_ID_CHARS }
                && !value.chars().any(char::is_control)
                && (!path || Path::new(value).is_absolute())
        })
        .take(MAX_ITEMS)
        .map(str::to_owned)
        .collect()
}

pub fn path() -> PathBuf {
    data_root().join("desktop/native-desktop.json")
}

fn legacy_path() -> Option<PathBuf> {
    let rust = data_root().join("desktop/desktop.json");
    if rust.exists() {
        return Some(rust);
    }
    user_home().map(|home| home.join(".prospero/desktop.json"))
}

fn data_root() -> PathBuf {
    if let Some(path) = std::env::var_os("PROSPERO_RUST_HOME") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = user_home() {
        return home.join("Library/Application Support/Prospero Rust");
    }
    #[cfg(target_os = "windows")]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        return PathBuf::from(app_data).join("Prospero Rust");
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(data).join("prospero");
        }
        if let Some(home) = user_home() {
            return home.join(".local/share/prospero");
        }
    }
    PathBuf::from(".prospero-rust")
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_keeps_only_supported_non_secret_ui_state() {
        let value = serde_json::json!({
            "settings": {"theme": "dark", "daemonBackend": "legacy"},
            "pinnedProjectPaths": ["/tmp/repo", "relative"],
            "pinnedSessionIds": ["session-1", "bad\nvalue"],
            "archivedSessionIds": ["session-2"],
            "unreadSessionIds": ["session-3"],
            "remoteHosts": [{"token": "secret"}]
        });
        let mut preferences = Preferences::default();
        migrate(&mut preferences, &value);
        assert_eq!(preferences.theme, ThemePreference::Dark);
        assert_eq!(preferences.pinned_project_paths, ["/tmp/repo"]);
        assert_eq!(preferences.pinned_session_ids, ["session-1"]);
        assert_eq!(preferences.archived_session_ids, ["session-2"]);
        assert_eq!(preferences.unread_session_ids, ["session-3"]);
        assert!(
            !serde_json::to_string(&preferences)
                .unwrap()
                .contains("secret")
        );
    }

    #[test]
    fn archive_toggle_rejects_invalid_and_overflow_ids() {
        let mut preferences = Preferences::default();
        assert!(preferences.set_session_archived("bad\n", true).is_err());
        preferences.archived_session_ids = (0..MAX_ITEMS)
            .map(|index| format!("session-{index}"))
            .collect();
        assert!(preferences.set_session_archived("overflow", true).is_err());
    }
}
