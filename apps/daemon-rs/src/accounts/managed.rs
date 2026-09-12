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

/// Managed account metadata row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedRecord {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
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
fn write_credential(root: &Path, credential: &Credential) -> Result<()> {
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
    if secret.len() < 20 || secret.len() > 8192 || secret.contains(['\r', '\n', '\0']) {
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

impl crate::database::Store {
    pub(crate) fn list_managed_accounts(&self) -> Result<Vec<ManagedRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT id,name,is_default,created_at,updated_at FROM managed_accounts \
             ORDER BY created_at,id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ManagedRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                is_default: row.get::<_, i64>(2)? != 0,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub(crate) fn managed_account(&self, id: &str) -> Result<ManagedRecord> {
        validate_account_id(id)?;
        self.connection
            .query_row(
                "SELECT id,name,is_default,created_at,updated_at FROM managed_accounts WHERE id=?",
                [id],
                |row| {
                    Ok(ManagedRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        is_default: row.get::<_, i64>(2)? != 0,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
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
        let existing = self.list_managed_accounts()?;
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
        let _record = self.managed_account(id)?;
        let credential = clean_credential(kind, secret)?;
        write_credential(&account_root(data, id)?, &credential)?;
        self.connection.execute(
            "UPDATE managed_accounts SET updated_at=?1 WHERE id=?2",
            params![now(), id],
        )?;
        Ok(())
    }

    /// Removes the credential file only; never invokes `claude auth logout`,
    /// which on macOS would mutate the shared native Keychain identity.
    pub(crate) fn logout_managed_account(&mut self, data: &Path, id: &str) -> Result<()> {
        let _record = self.managed_account(id)?;
        let root = account_root(data, id)?;
        match fs::remove_file(credential_path(&root)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        // Credentials written by older builds into the config root.
        let _ = fs::remove_file(root.join(".credentials.json"));
        self.connection.execute(
            "UPDATE managed_accounts SET updated_at=?1 WHERE id=?2",
            params![now(), id],
        )?;
        Ok(())
    }

    /// Deletes metadata, the isolated config root, and any credential. A
    /// running session (structured turn or live login PTY) blocks deletion.
    pub(crate) fn delete_managed_account(&mut self, data: &Path, id: &str) -> Result<()> {
        let _record = self.managed_account(id)?;
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
