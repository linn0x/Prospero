//! Managed Claude accounts: SQLite metadata plus private credential files.
//!
//! Secrets never enter the database. Each account owns an isolated
//! `CLAUDE_CONFIG_DIR` root under the daemon data directory, so managed
//! sessions can never silently use the machine's shared Claude identity.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use uuid::Uuid;

use crate::database::{now, validate_id};
use crate::error::{Error, Result};

use super::probe::{ApiValidation, revision};
use super::profile::{ApiProfile, clean_profile, session_environment};

/// Managed account metadata row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedRecord {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub api_profile: Option<ApiProfile>,
    pub api_validation: Option<ApiValidation>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CredentialKind {
    OauthToken,
    ApiKey,
}

impl CredentialKind {
    fn label(&self) -> &'static str {
        match self {
            CredentialKind::OauthToken => "oauth_token",
            CredentialKind::ApiKey => "api_key",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Credential {
    pub kind: CredentialKind,
    pub secret: String,
}

/// Legacy sentinel: a non-secret placeholder that stops the CLI from falling
/// back to the process-global macOS Keychain identity while unauthenticated.
pub(crate) const MISSING_CLAUDE_CREDENTIAL: &str = "prospero-managed-account-not-authenticated";
const CREDENTIAL_FILE: &str = ".prospero-credential.json";

fn clean_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(Error::Invalid("账号名称应为 1–80 个字符".into()));
    }
    Ok(name.to_owned())
}

/// Account ids are used as path segments; only a charset-safe subset is legal.
fn validate_account_id(id: &str) -> Result<()> {
    validate_id(id)?;
    if id.chars().count() > 100 {
        return Err(Error::Invalid("账号 ID 无效".into()));
    }
    Ok(())
}

/// `<data>/agent-accounts`, the private anchor for every managed root.
pub(crate) fn roots_dir(data: &Path) -> PathBuf {
    data.join("agent-accounts")
}

/// `<data>/agent-accounts/claude/<id>`.
pub(crate) fn account_root(data: &Path, id: &str) -> Result<PathBuf> {
    validate_account_id(id)?;
    Ok(roots_dir(data).join("claude").join(id))
}

fn credential_path(root: &Path) -> PathBuf {
    root.join(CREDENTIAL_FILE)
}

fn ensure_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(Error::Invalid("账号配置目录无效".into()));
    }
    Ok(())
}

/// Writes the credential through a temp file in the same directory, then
/// renames over the target with mode 0600.
pub(crate) fn write_credential(root: &Path, credential: &Credential) -> Result<()> {
    ensure_private_dir(root)?;
    let body = serde_json::json!({ "kind": credential.kind.label(), "secret": credential.secret });
    let temporary = root.join(format!(".credential.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, serde_json::to_vec(&body)?)?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
    fs::rename(&temporary, credential_path(root))?;
    Ok(())
}

pub(crate) fn read_credential(root: &Path) -> Result<Option<Credential>> {
    let path = credential_path(root);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Error::Invalid("账号凭据文件不可读或损坏".into())),
    };
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| Error::Invalid("账号凭据文件损坏".into()))?;
    let kind = match parsed.get("kind").and_then(|v| v.as_str()) {
        Some("oauth_token") => CredentialKind::OauthToken,
        Some("api_key") => CredentialKind::ApiKey,
        _ => return Err(Error::Invalid("账号凭据文件损坏".into())),
    };
    let secret = parsed
        .get("secret")
        .and_then(|v| v.as_str())
        .ok_or_else(|| Error::Invalid("账号凭据文件损坏".into()))?;
    Ok(Some(clean_credential(kind, secret)?))
}

fn clean_credential(kind: CredentialKind, raw: &str) -> Result<Credential> {
    let secret = raw.trim();
    if secret.is_empty() || secret.len() > 8192 || secret.contains(['\r', '\n', '\0']) {
        return Err(Error::Invalid("凭据格式无效".into()));
    }
    Ok(Credential {
        kind,
        secret: secret.to_owned(),
    })
}

/// Environment overrides for a managed Claude CLI invocation. An absent
/// credential installs the non-secret sentinel so the CLI cannot fall back to
/// the shared Keychain identity. `login` additionally clears every imported
/// secret because `claude setup-token` must mint a fresh token.
pub(crate) fn claude_environment(
    data: &Path,
    id: &str,
    login: bool,
) -> Result<Vec<(String, String)>> {
    let root = account_root(data, id)?;
    let credential = read_credential(&root)?;
    let (api_key, oauth_token) = if login {
        (String::new(), String::new())
    } else {
        match credential {
            Some(Credential {
                kind: CredentialKind::ApiKey,
                secret,
            }) => (secret, String::new()),
            Some(Credential {
                kind: CredentialKind::OauthToken,
                secret,
            }) => (String::new(), secret),
            None => (String::new(), MISSING_CLAUDE_CREDENTIAL.into()),
        }
    };
    Ok(vec![
        ("ANTHROPIC_API_KEY".into(), api_key),
        ("ANTHROPIC_AUTH_TOKEN".into(), String::new()),
        ("CLAUDE_CODE_OAUTH_TOKEN".into(), oauth_token),
        ("CLAUDE_CODE_OAUTH_REFRESH_TOKEN".into(), String::new()),
        ("CLAUDE_CODE_OAUTH_SCOPES".into(), String::new()),
        ("CLAUDE_CODE_USE_BEDROCK".into(), String::new()),
        ("CLAUDE_CODE_USE_VERTEX".into(), String::new()),
        ("CLAUDE_CODE_USE_FOUNDRY".into(), String::new()),
        ("CLAUDE_CODE_USE_GATEWAY".into(), String::new()),
        (
            "CLAUDE_CONFIG_DIR".into(),
            root.to_string_lossy().into_owned(),
        ),
    ])
}

pub(crate) fn clean_api_key(raw: &str) -> Result<String> {
    let secret = raw.trim();
    if secret.is_empty() || secret.len() > 8192 || secret.contains(['\r', '\n', '\0']) {
        return Err(Error::Invalid("API Key 格式无效".into()));
    }
    Ok(secret.to_owned())
}

/// Reads a profile account's API key; missing or non-key credentials are
/// reported as `None` so snapshots can show `signed_out`.
pub(crate) fn profile_secret(data: &Path, id: &str) -> Result<Option<String>> {
    let root = account_root(data, id)?;
    match read_credential(&root)? {
        Some(Credential {
            kind: CredentialKind::ApiKey,
            secret,
        }) => Ok(Some(secret)),
        _ => Ok(None),
    }
}

/// Environment overrides for a session bound to an API profile account.
pub(crate) fn profile_account_environment(
    data: &Path,
    id: &str,
    profile: &ApiProfile,
) -> Result<Vec<(String, String)>> {
    let root = account_root(data, id)?;
    let secret = profile_secret(data, id)?.unwrap_or_default();
    Ok(session_environment(&root, profile, &secret))
}

#[allow(clippy::too_many_arguments)]
fn decode_record(
    id: String,
    name: String,
    is_default: i64,
    created_at: i64,
    updated_at: i64,
    profile_raw: Option<String>,
    validation_raw: Option<String>,
    validation_revision: Option<String>,
    current_revision: Option<&str>,
) -> ManagedRecord {
    let api_profile = profile_raw.and_then(|raw| super::profile::parse_profile_json(&raw));
    let api_validation = match (api_profile.as_ref(), validation_raw, validation_revision) {
        (Some(_), Some(raw), Some(stored)) if Some(stored.as_str()) == current_revision => {
            serde_json::from_str::<ApiValidation>(&raw).ok()
        }
        _ => None,
    };
    ManagedRecord {
        id,
        name,
        is_default: is_default != 0,
        created_at,
        updated_at,
        api_profile,
        api_validation,
    }
}

/// Revision-sha input for a row: the stored key when it is an API key,
/// otherwise null (legacy canonicalization includes `credential ?? null`).
fn row_revision(data: &Path, id: &str, profile: Option<&ApiProfile>) -> Option<String> {
    let profile = profile?;
    let root = account_root(data, id).ok()?;
    let secret = match read_credential(&root) {
        Ok(Some(Credential {
            kind: CredentialKind::ApiKey,
            secret,
        })) => Some(secret),
        _ => None,
    };
    Some(revision(profile, secret.as_deref()))
}

const RECORD_COLUMNS: &str =
    "id,name,is_default,created_at,updated_at,api_profile,api_validation,api_validation_revision";

impl crate::database::Store {
    pub(crate) fn list_managed_accounts(&self, data: &Path) -> Result<Vec<ManagedRecord>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {RECORD_COLUMNS} FROM managed_accounts ORDER BY created_at,id"
        ))?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?;
        let mut records = Vec::new();
        for row in rows {
            let (
                id,
                name,
                is_default,
                created_at,
                updated_at,
                profile_raw,
                validation_raw,
                validation_revision,
            ) = row?;
            let profile = profile_raw
                .as_deref()
                .and_then(super::profile::parse_profile_json);
            let current = row_revision(data, &id, profile.as_ref());
            records.push(decode_record(
                id,
                name,
                is_default,
                created_at,
                updated_at,
                profile_raw,
                validation_raw,
                validation_revision,
                current.as_deref(),
            ));
        }
        Ok(records)
    }

    pub(crate) fn managed_account(&self, id: &str) -> Result<ManagedRecord> {
        validate_account_id(id)?;
        self.connection
            .query_row(
                &format!("SELECT {RECORD_COLUMNS} FROM managed_accounts WHERE id=?"),
                [id],
                |row| {
                    Ok(decode_record(
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        None,
                        None,
                        None,
                    ))
                },
            )
            .optional()?
            .ok_or(Error::NotFound)
    }

    pub(crate) fn create_managed_account(
        &mut self,
        data: &Path,
        raw_name: &str,
    ) -> Result<ManagedRecord> {
        let name = clean_name(raw_name)?;
        let existing = self.list_managed_accounts(data)?;
        let becomes_default = !existing.iter().any(|account| account.is_default);
        let id = Uuid::new_v4().to_string();
        let timestamp = now();
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO managed_accounts(id,name,is_default,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?4)",
            params![id, name, becomes_default as i64, timestamp],
        )?;
        transaction.commit()?;
        // Create the isolated private root eagerly (legacy lazily mkdirs on
        // resolve; doing it at create time keeps later turns off the fs path).
        ensure_private_dir(&account_root(data, &id)?)?;
        self.managed_account(&id)
    }

    /// Row with validation decoded against the current profile+key revision.
    pub(crate) fn managed_snapshot_row(&self, data: &Path, id: &str) -> Result<ManagedRecord> {
        validate_account_id(id)?;
        let (profile_raw, validation_raw, validation_revision): (
            Option<String>,
            Option<String>,
            Option<String>,
        ) = self.connection.query_row(
            "SELECT api_profile,api_validation,api_validation_revision FROM managed_accounts WHERE id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).optional()?
        .ok_or(Error::NotFound)?;
        let profile = profile_raw
            .as_deref()
            .and_then(super::profile::parse_profile_json);
        let current = row_revision(data, id, profile.as_ref());
        let mut record = self.managed_account(id)?;
        record.api_profile = profile;
        record.api_validation = match (validation_raw, validation_revision) {
            (Some(raw), Some(stored)) if current.as_deref() == Some(stored.as_str()) => {
                serde_json::from_str::<ApiValidation>(&raw).ok()
            }
            _ => None,
        };
        Ok(record)
    }

    /// Creates a managed account holding an Anthropic-compatible API profile
    /// and writes its API Key into the private credential file.
    pub(crate) fn create_api_profile_account(
        &mut self,
        data: &Path,
        raw_name: &str,
        profile: &ApiProfile,
        secret: &str,
    ) -> Result<ManagedRecord> {
        let name = clean_name(raw_name)?;
        let secret = clean_api_key(secret)?;
        let existing = self.list_managed_accounts(data)?;
        let becomes_default = !existing.iter().any(|account| account.is_default);
        let id = Uuid::new_v4().to_string();
        let timestamp = now();
        let profile_json = serde_json::to_string(profile)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO managed_accounts(id,name,is_default,created_at,updated_at,api_profile) \
             VALUES(?1,?2,?3,?4,?4,?5)",
            params![id, name, becomes_default as i64, timestamp, profile_json],
        )?;
        transaction.commit()?;
        let root = account_root(data, &id)?;
        write_credential(
            &root,
            &Credential {
                kind: CredentialKind::ApiKey,
                secret,
            },
        )?;
        self.managed_snapshot_row(data, &id)
    }

    pub(crate) fn insert_api_profile_account_with_id(
        &mut self,
        data: &Path,
        id: &str,
        raw_name: &str,
        profile: &ApiProfile,
        secret: &str,
    ) -> Result<ManagedRecord> {
        validate_account_id(id)?;
        let name = clean_name(raw_name)?;
        let secret = clean_api_key(secret)?;
        let existing = self.list_managed_accounts(data)?;
        let becomes_default = !existing.iter().any(|account| account.is_default);
        let timestamp = now();
        let profile_json = serde_json::to_string(profile)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO managed_accounts(id,name,is_default,created_at,updated_at,api_profile) \
             VALUES(?1,?2,?3,?4,?4,?5)",
            params![id, name, becomes_default as i64, timestamp, profile_json],
        )?;
        transaction.commit()?;
        write_credential(
            &account_root(data, id)?,
            &Credential {
                kind: CredentialKind::ApiKey,
                secret,
            },
        )?;
        self.managed_snapshot_row(data, id)
    }

    /// Updates a profile account's name/connection/key. Any connection or key
    /// change invalidates the recorded validation and is blocked while a
    /// session is active; a name-only rename is always allowed.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn configure_api_profile_account(
        &mut self,
        data: &Path,
        id: &str,
        raw_name: Option<&str>,
        base_url: Option<&str>,
        model: Option<&str>,
        provider: Option<&str>,
        protocol: Option<&str>,
        capabilities: Option<serde_json::Value>,
        new_secret: Option<&str>,
    ) -> Result<ManagedRecord> {
        let record = self.managed_snapshot_row(data, id)?;
        let source_bound = super::sources::ModelSources::open(data)?.is_bound(id);
        let Some(existing) = record.api_profile else {
            return Err(Error::Invalid("这个账号不是第三方 API Profile".into()));
        };
        let name = match raw_name {
            Some(raw) => clean_name(raw)?,
            None => record.name.clone(),
        };
        let existing_caps = existing
            .model_capabilities
            .as_ref()
            .map(|caps| serde_json::to_value(caps).unwrap_or(serde_json::Value::Null))
            .unwrap_or(serde_json::Value::Null);
        let updates_capabilities = capabilities.is_some();
        let preserved_headers = existing
            .headers
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?;
        let profile = clean_profile(
            "claude",
            base_url.unwrap_or(&existing.base_url),
            model.unwrap_or(&existing.model),
            provider.or(Some(existing.provider.as_str())),
            protocol.or(existing.protocol.as_deref()),
            Some(capabilities.unwrap_or(existing_caps)),
            preserved_headers,
        )?;
        let connection_changed = profile != existing;
        let trimmed_secret = new_secret.map(str::trim);
        let updates_credential = trimmed_secret.is_some_and(|secret| !secret.is_empty());
        if source_bound && (updates_credential || connection_changed || updates_capabilities) {
            return Err(Error::InUse);
        }
        if (updates_credential || connection_changed || updates_capabilities)
            && self.active_session_count(id)? > 0
        {
            return Err(Error::InUse);
        }
        if let Some(secret) = trimmed_secret.filter(|secret| !secret.is_empty()) {
            let secret = clean_api_key(secret)?;
            write_credential(
                &account_root(data, id)?,
                &Credential {
                    kind: CredentialKind::ApiKey,
                    secret,
                },
            )?;
        }
        let profile_json = serde_json::to_string(&profile)?;
        let transaction = self.connection.transaction()?;
        let validation_invalidated = connection_changed || updates_credential;
        if validation_invalidated {
            transaction.execute(
                "UPDATE managed_accounts SET name=?1,updated_at=?2,api_profile=?3, \
                 api_validation=NULL,api_validation_revision=NULL WHERE id=?4",
                params![name, now(), profile_json, id],
            )?;
        } else {
            // A name-only rename preserves the recorded probe validation.
            transaction.execute(
                "UPDATE managed_accounts SET name=?1,updated_at=?2,api_profile=?3 WHERE id=?4",
                params![name, now(), profile_json, id],
            )?;
        }
        transaction.commit()?;
        self.managed_snapshot_row(data, id)
    }

    /// Records a probe result only when the profile+key revision still
    /// matches the revision captured before the probe started.
    pub(crate) fn record_api_validation(
        &mut self,
        data: &Path,
        id: &str,
        expected_revision: &str,
        validation: &ApiValidation,
    ) -> Result<bool> {
        let record = self.managed_account(id)?;
        let Some(profile) = record.api_profile else {
            return Err(Error::Invalid("此账号没有有效的 API Profile".into()));
        };
        let current = revision(&profile, profile_secret(data, id)?.as_deref());
        if current != expected_revision {
            return Ok(false);
        }
        let json = serde_json::to_string(validation)?;
        self.connection.execute(
            "UPDATE managed_accounts SET api_validation=?1,api_validation_revision=?2,updated_at=?3 WHERE id=?4",
            params![json, expected_revision, now(), id],
        )?;
        Ok(true)
    }

    /// Current validation revision for a profile account (re-reads key).
    pub(crate) fn api_validation_revision(&self, data: &Path, id: &str) -> Result<String> {
        let record = self.managed_account(id)?;
        let Some(profile) = record.api_profile else {
            return Err(Error::Invalid("此账号没有有效的 API Profile".into()));
        };
        Ok(revision(&profile, profile_secret(data, id)?.as_deref()))
    }

    pub(crate) fn rename_managed_account(&mut self, id: &str, raw_name: &str) -> Result<()> {
        let _record = self.managed_account(id)?;
        let name = clean_name(raw_name)?;
        self.connection.execute(
            "UPDATE managed_accounts SET name=?1,updated_at=?2 WHERE id=?3",
            params![name, now(), id],
        )?;
        Ok(())
    }

    pub(crate) fn set_default_managed_account(&mut self, id: &str) -> Result<()> {
        let _record = self.managed_account(id)?;
        let transaction = self.connection.transaction()?;
        transaction.execute("UPDATE managed_accounts SET is_default=0", [])?;
        transaction.execute(
            "UPDATE managed_accounts SET is_default=1,updated_at=?1 WHERE id=?2",
            params![now(), id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub(crate) fn set_managed_credential(
        &mut self,
        data: &Path,
        id: &str,
        kind: CredentialKind,
        secret: &str,
    ) -> Result<()> {
        let record = self.managed_snapshot_row(data, id)?;
        // The desktop bridge mirrors this same floor; profile key rotation
        // goes through configure_api_profile_account instead (non-empty only).
        if secret.trim().len() < 20 {
            return Err(Error::Invalid("凭据格式无效".into()));
        }
        if super::sources::ModelSources::open(data)?.is_bound(id) {
            return Err(Error::InUse);
        }
        if record.api_profile.is_some() {
            // Third-party profiles only accept API keys and cannot rotate them
            // while a session is using the old connection.
            if !matches!(kind, CredentialKind::ApiKey) {
                return Err(Error::Invalid("第三方 API Profile 只能使用 API Key".into()));
            }
            if self.active_session_count(id)? > 0 {
                return Err(Error::InUse);
            }
        }
        let credential = clean_credential(kind, secret)?;
        write_credential(&account_root(data, id)?, &credential)?;
        self.connection.execute(
            "UPDATE managed_accounts SET updated_at=?1,api_validation=NULL, \
             api_validation_revision=NULL WHERE id=?2",
            params![now(), id],
        )?;
        Ok(())
    }

    /// Removes the credential file only; never invokes `claude auth logout`,
    /// which on macOS would mutate the shared native Keychain identity. A
    /// profile account cannot sign out while a session is using its key.
    pub(crate) fn logout_managed_account(&mut self, data: &Path, id: &str) -> Result<()> {
        let record = self.managed_snapshot_row(data, id)?;
        if super::sources::ModelSources::open(data)?.is_bound(id) {
            return Err(Error::InUse);
        }
        if record.api_profile.is_some() && self.active_session_count(id)? > 0 {
            return Err(Error::InUse);
        }
        let root = account_root(data, id)?;
        match fs::remove_file(credential_path(&root)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        // Credentials written by older builds into the config root.
        let _ = fs::remove_file(root.join(".credentials.json"));
        self.connection.execute(
            "UPDATE managed_accounts SET updated_at=?1,api_validation=NULL, \
             api_validation_revision=NULL WHERE id=?2",
            params![now(), id],
        )?;
        Ok(())
    }

    /// Deletes metadata, the isolated config root, and any credential. A
    /// running session (structured turn or live login PTY) blocks deletion.
    pub(crate) fn delete_managed_account(&mut self, data: &Path, id: &str) -> Result<()> {
        let _record = self.managed_account(id)?;
        if super::sources::ModelSources::open(data)?.is_bound(id) {
            return Err(Error::InUse);
        }
        if self.active_session_count(id)? > 0 {
            return Err(Error::InUse);
        }
        self.connection
            .execute("DELETE FROM managed_accounts WHERE id=?", [id])?;
        let root = account_root(data, id)?;
        match fs::remove_dir_all(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    /// Active structured runs plus live login terminals bound to the account.
    /// Used to gate deletion: a live process blocks removal even if the
    /// session head was already archived.
    pub(crate) fn active_session_count(&self, id: &str) -> Result<i64> {
        validate_account_id(id)?;
        let agents: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE active=1 AND account_id=?",
            [id],
            |row| row.get(0),
        )?;
        let terminals: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM terminal_runs WHERE active=1 AND account_id=?",
            [id],
            |row| row.get(0),
        )?;
        Ok(agents + terminals)
    }

    /// Snapshot counts anchored on active Claude session heads, matching the
    /// legacy native counter. A session belongs to the account named by its
    /// run row (structured or PTY); a missing/NULL binding is the native
    /// account.
    pub(crate) fn account_active_counts(
        &self,
        managed_ids: &[String],
    ) -> Result<(i64, std::collections::HashMap<String, i64>)> {
        let mut statement = self.connection.prepare(
            "SELECT COALESCE(ar.account_id, tr.account_id) AS bound
             FROM session_heads sh
             LEFT JOIN agent_runs ar ON ar.session_id = sh.id
             LEFT JOIN terminal_runs tr ON tr.session_id = sh.id
             WHERE sh.lifecycle = 'active'
               AND json_extract(sh.payload, '$.agent') = 'claude'",
        )?;
        let bindings = statement.query_map([], |row| row.get::<_, Option<String>>(0))?;
        let mut native = 0i64;
        let mut counts: std::collections::HashMap<String, i64> =
            managed_ids.iter().map(|id| (id.clone(), 0)).collect();
        for binding in bindings {
            match binding? {
                Some(id) => *counts.entry(id).or_insert(0) += 1,
                None => native += 1,
            }
        }
        Ok((native, counts))
    }
}
