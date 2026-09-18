//! Managed Claude accounts: SQLite metadata plus private credential files.
//!
//! Secrets never enter the database. Each account owns an isolated
//! `CLAUDE_CONFIG_DIR` root under the daemon data directory, so managed
//! sessions can never silently use the machine's shared Claude identity.

use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use uuid::Uuid;

use crate::database::{now, validate_id};
use crate::error::{Error, Result};

use super::probe::{ApiEngineValidation, ApiValidation, revision};
use super::profile::{ApiProfile, clean_profile, session_environment};
use crate::protocol::AgentKind;

/// Managed account metadata row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedRecord {
    pub id: String,
    pub agent: AgentKind,
    pub name: String,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub api_profile: Option<ApiProfile>,
    pub api_validation: Option<ApiValidation>,
    pub api_engine_validation: Option<ApiEngineValidation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAccountsFile {
    #[serde(default)]
    accounts: Vec<LegacyAccount>,
    #[serde(default)]
    defaults: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAccount {
    id: String,
    agent: String,
    name: String,
    #[serde(default)]
    api_profile: Option<serde_json::Value>,
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

/// `<data>/agent-accounts/<agent>/<id>`. Legacy non-profile managed
/// accounts are Claude-only; API profile roots follow the profile agent so
/// Codex/OpenAI profiles get isolated CODEX_HOME directories compatible with
/// the TypeScript daemon layout.
fn account_root_for_agent(data: &Path, agent: &str, id: &str) -> Result<PathBuf> {
    validate_account_id(id)?;
    Ok(roots_dir(data).join(agent).join(id))
}

/// `<data>/agent-accounts/claude/<id>`.
pub(crate) fn account_root(data: &Path, id: &str) -> Result<PathBuf> {
    account_root_for_agent(data, "claude", id)
}

fn profile_account_root_for_agent(data: &Path, id: &str, agent: AgentKind) -> Result<PathBuf> {
    let agent = match agent {
        AgentKind::Codex => "codex",
        AgentKind::Opencode => "opencode",
        _ => "claude",
    };
    account_root_for_agent(data, agent, id)
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

pub(crate) fn profile_secret_for_agent(
    data: &Path,
    id: &str,
    agent: AgentKind,
    _profile: &ApiProfile,
) -> Result<Option<String>> {
    let root = profile_account_root_for_agent(data, id, agent)?;
    profile_secret_from_root(&root)
}

fn profile_secret_from_root(root: &Path) -> Result<Option<String>> {
    match read_credential(root)? {
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
    agent: AgentKind,
    profile: &ApiProfile,
) -> Result<Vec<(String, String)>> {
    let root = profile_account_root_for_agent(data, id, agent)?;
    let secret = profile_secret_for_agent(data, id, agent, profile)?.unwrap_or_default();
    if profile.protocol() == "openai_chat_completions" {
        return opencode_environment(&root, profile, &secret);
    }
    Ok(session_environment(&root, profile, &secret))
}

fn opencode_environment(
    root: &Path,
    profile: &ApiProfile,
    secret: &str,
) -> Result<Vec<(String, String)>> {
    let data = root.join("xdg-data");
    let cache = root.join("xdg-cache");
    let state = root.join("xdg-state");
    let config = root.join("xdg-config");
    let opencode = config.join("opencode");
    for directory in [&data, &cache, &state, &config, &opencode] {
        ensure_private_dir(directory)?;
    }
    let mut headers = BTreeMap::new();
    if let Some(profile_headers) = &profile.headers {
        for (name, value) in profile_headers {
            headers.insert(name.clone(), value.clone());
        }
    }
    let mut model = serde_json::Map::new();
    model.insert("name".into(), serde_json::json!(profile.model));
    model.insert(
        "tool_call".into(),
        serde_json::json!(
            profile
                .model_capabilities
                .as_ref()
                .and_then(|caps| caps.tools)
                .unwrap_or(true)
        ),
    );
    if let Some(caps) = profile.model_capabilities.as_ref() {
        if let Some(reasoning) = caps.reasoning {
            model.insert("reasoning".into(), serde_json::json!(reasoning));
        }
        if let Some(vision) = caps.vision {
            model.insert(
                "modalities".into(),
                serde_json::json!({"input": if vision { vec!["text", "image"] } else { vec!["text"] }, "output": ["text"]}),
            );
        }
        if caps.context_window.is_some() || caps.max_output_tokens.is_some() {
            let mut limit = serde_json::Map::new();
            if let Some(context) = caps.context_window {
                limit.insert("context".into(), serde_json::json!(context));
            }
            if let Some(output) = caps.max_output_tokens {
                limit.insert("output".into(), serde_json::json!(output));
            }
            model.insert("limit".into(), serde_json::Value::Object(limit));
        }
    }
    let config_file = opencode.join("opencode.json");
    let body = serde_json::to_vec(&serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "model": format!("prospero/{}", profile.model),
        "small_model": format!("prospero/{}", profile.model),
        "provider": {
            "prospero": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Prospero API Profile",
                "env": ["OPENAI_API_KEY"],
                "options": {
                    "baseURL": profile.base_url,
                    "headers": headers,
                },
                "models": {
                    profile.model.clone(): serde_json::Value::Object(model),
                },
            },
        },
    }))?;
    fs::write(&config_file, body)?;
    fs::set_permissions(&config_file, fs::Permissions::from_mode(0o600))?;
    Ok(vec![
        ("XDG_DATA_HOME".into(), data.to_string_lossy().into_owned()),
        (
            "XDG_CACHE_HOME".into(),
            cache.to_string_lossy().into_owned(),
        ),
        (
            "XDG_STATE_HOME".into(),
            state.to_string_lossy().into_owned(),
        ),
        (
            "XDG_CONFIG_HOME".into(),
            config.to_string_lossy().into_owned(),
        ),
        ("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "1".into()),
        (
            "PROSPERO_API_PROFILE_CONFIG".into(),
            config_file.to_string_lossy().into_owned(),
        ),
        ("PROSPERO_API_PROFILE_FINGERPRINT".into(), {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(profile.base_url.as_bytes());
            hasher.update(profile.model.as_bytes());
            hasher.update(secret.as_bytes());
            hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        }),
        (
            "PROSPERO_API_PROFILE_MODEL".into(),
            format!("prospero/{}", profile.model),
        ),
        (
            "PROSPERO_API_PROFILE_VISION".into(),
            if profile.model_capabilities.as_ref().and_then(|c| c.vision) == Some(false) {
                "0"
            } else {
                "1"
            }
            .into(),
        ),
        ("OPENAI_API_KEY".into(), secret.to_owned()),
    ])
}

#[allow(clippy::too_many_arguments)]
fn decode_record(
    id: String,
    agent_raw: Option<String>,
    name: String,
    is_default: i64,
    created_at: i64,
    updated_at: i64,
    profile_raw: Option<String>,
    validation_raw: Option<String>,
    validation_revision: Option<String>,
    engine_validation_raw: Option<String>,
    engine_validation_revision: Option<String>,
    current_revision: Option<&str>,
) -> ManagedRecord {
    let api_profile = profile_raw.and_then(|raw| super::profile::parse_profile_json(&raw));
    let agent = agent_from_storage(agent_raw.as_deref(), api_profile.as_ref());
    let engine_label = profile_engine_label(agent, api_profile.as_ref());
    let api_validation = match (api_profile.as_ref(), validation_raw, validation_revision) {
        (Some(_), Some(raw), Some(stored)) if Some(stored.as_str()) == current_revision => {
            serde_json::from_str::<ApiValidation>(&raw)
                .ok()
                .filter(|validation| validation.engine == engine_label)
        }
        _ => None,
    };
    let api_engine_validation = match (
        api_profile.as_ref(),
        engine_validation_raw,
        engine_validation_revision,
    ) {
        (Some(_), Some(raw), Some(stored)) if Some(stored.as_str()) == current_revision => {
            serde_json::from_str::<ApiEngineValidation>(&raw)
                .ok()
                .filter(|validation| validation.engine == engine_label)
        }
        _ => None,
    };
    ManagedRecord {
        id,
        agent,
        name,
        is_default: is_default != 0,
        created_at,
        updated_at,
        api_profile,
        api_validation,
        api_engine_validation,
    }
}

fn agent_from_storage(raw: Option<&str>, profile: Option<&ApiProfile>) -> AgentKind {
    match raw {
        Some("codex") => AgentKind::Codex,
        Some("opencode") => AgentKind::Opencode,
        Some("claude") => AgentKind::Claude,
        _ => profile
            .map(super::profile::agent_kind)
            .unwrap_or(AgentKind::Claude),
    }
}

fn agent_label_value(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::Codex => "codex",
        AgentKind::Opencode => "opencode",
        _ => "claude",
    }
}

fn profile_engine_label(agent: AgentKind, profile: Option<&ApiProfile>) -> &'static str {
    agent_label_value(profile.map(super::profile::agent_kind).unwrap_or(agent))
}

fn agent_label(agent: AgentKind) -> Result<&'static str> {
    match agent {
        AgentKind::Claude => Ok("claude"),
        AgentKind::Codex => Ok("codex"),
        AgentKind::Opencode => Ok("opencode"),
        _ => Err(Error::Invalid("Agent 不支持 API Profile".into())),
    }
}

pub(crate) fn validate_profile_agent(agent: AgentKind, profile: &ApiProfile) -> Result<()> {
    let ok = match agent {
        AgentKind::Claude => profile.protocol() == "anthropic",
        AgentKind::Codex => matches!(
            profile.protocol(),
            "openai_responses" | "openai_chat_completions"
        ),
        AgentKind::Opencode => profile.protocol() == "openai_chat_completions",
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(Error::Invalid(
            "所选 Agent、Provider 与 API 协议不兼容".into(),
        ))
    }
}

/// Revision-sha input for a row: the stored key when it is an API key,
/// otherwise null (legacy canonicalization includes `credential ?? null`).
fn row_revision_for_agent(
    data: &Path,
    id: &str,
    agent: AgentKind,
    profile: Option<&ApiProfile>,
) -> Option<String> {
    let profile = profile?;
    let secret = profile_secret_for_agent(data, id, agent, profile).unwrap_or_default();
    Some(revision(profile, secret.as_deref()))
}

type ValidationColumns = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

const RECORD_COLUMNS: &str = "id,agent,name,is_default,created_at,updated_at,api_profile,api_validation,api_validation_revision,api_engine_validation,api_engine_validation_revision";

impl crate::database::Store {
    pub(crate) fn import_legacy_accounts(
        &mut self,
        data: &Path,
        legacy_home: &Path,
    ) -> Result<usize> {
        let path = legacy_home.join("agent-accounts.json");
        if !path.exists() {
            return Ok(0);
        }
        let raw = fs::read_to_string(&path)?;
        let legacy: LegacyAccountsFile = serde_json::from_str(&raw)
            .map_err(|_| Error::Invalid("旧账号配置无法读取，原文件已保留".into()))?;
        let mut imported = 0;
        let mut default_ids = Vec::new();
        for account in legacy.accounts {
            if validate_account_id(&account.id).is_err() {
                continue;
            }
            if self.managed_account(&account.id).is_ok() {
                continue;
            }
            let Some(profile_raw) = account.api_profile else {
                continue;
            };
            let profile = match (
                profile_raw
                    .get("baseUrl")
                    .and_then(serde_json::Value::as_str),
                profile_raw.get("model").and_then(serde_json::Value::as_str),
            ) {
                (Some(base_url), Some(model)) => match super::profile::clean_profile(
                    &account.agent,
                    base_url,
                    model,
                    profile_raw
                        .get("provider")
                        .and_then(serde_json::Value::as_str),
                    profile_raw
                        .get("protocol")
                        .and_then(serde_json::Value::as_str),
                    profile_raw.get("modelCapabilities").cloned(),
                    profile_raw.get("headers").cloned(),
                ) {
                    Ok(profile) => profile,
                    Err(_) => continue,
                },
                _ => continue,
            };
            let agent = match account.agent.as_str() {
                "claude" => AgentKind::Claude,
                "codex" => AgentKind::Codex,
                "opencode" => AgentKind::Opencode,
                _ => continue,
            };
            if validate_profile_agent(agent, &profile).is_err() {
                continue;
            };
            let source_root = legacy_home
                .join("agent-accounts")
                .join(&account.agent)
                .join(&account.id);
            let credential = match read_credential(&source_root) {
                Ok(Some(Credential {
                    kind: CredentialKind::ApiKey,
                    secret,
                })) => secret,
                _ => continue,
            };
            if self
                .insert_api_profile_account_with_id(
                    data,
                    &account.id,
                    &account.name,
                    agent,
                    &profile,
                    &credential,
                )
                .is_err()
            {
                continue;
            };
            if legacy
                .defaults
                .get(&account.agent)
                .is_some_and(|id| id == &account.id)
            {
                default_ids.push(account.id.clone());
            }
            imported += 1;
        }
        for id in default_ids {
            self.set_default_managed_account(&id)?;
        }
        Ok(imported)
    }

    pub(crate) fn list_managed_accounts(&self, data: &Path) -> Result<Vec<ManagedRecord>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {RECORD_COLUMNS} FROM managed_accounts ORDER BY created_at,id"
        ))?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
            ))
        })?;
        let mut records = Vec::new();
        for row in rows {
            let (
                id,
                agent,
                name,
                is_default,
                created_at,
                updated_at,
                profile_raw,
                validation_raw,
                validation_revision,
                engine_validation_raw,
                engine_validation_revision,
            ) = row?;
            let profile = profile_raw
                .as_deref()
                .and_then(super::profile::parse_profile_json);
            let agent_kind = agent_from_storage(agent.as_deref(), profile.as_ref());
            let current = row_revision_for_agent(data, &id, agent_kind, profile.as_ref());
            records.push(decode_record(
                id,
                agent,
                name,
                is_default,
                created_at,
                updated_at,
                profile_raw,
                validation_raw,
                validation_revision,
                engine_validation_raw,
                engine_validation_revision,
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
                        row.get(6)?,
                        None,
                        None,
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
            "INSERT INTO managed_accounts(id,agent,name,is_default,created_at,updated_at) \
             VALUES(?1,'claude',?2,?3,?4,?4)",
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
        let (
            agent_raw,
            profile_raw,
            validation_raw,
            validation_revision,
            engine_validation_raw,
            engine_validation_revision,
        ): ValidationColumns = self.connection.query_row(
            "SELECT agent,api_profile,api_validation,api_validation_revision,api_engine_validation,api_engine_validation_revision FROM managed_accounts WHERE id=?",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).optional()?
        .ok_or(Error::NotFound)?;
        let profile = profile_raw
            .as_deref()
            .and_then(super::profile::parse_profile_json);
        let agent = agent_from_storage(agent_raw.as_deref(), profile.as_ref());
        let current = row_revision_for_agent(data, id, agent, profile.as_ref());
        let mut record = self.managed_account(id)?;
        record.agent = agent;
        record.api_profile = profile;
        let engine_label = profile_engine_label(record.agent, record.api_profile.as_ref());
        record.api_validation = match (validation_raw, validation_revision) {
            (Some(raw), Some(stored)) if current.as_deref() == Some(stored.as_str()) => {
                serde_json::from_str::<ApiValidation>(&raw)
                    .ok()
                    .filter(|validation| validation.engine == engine_label)
            }
            _ => None,
        };
        record.api_engine_validation = match (engine_validation_raw, engine_validation_revision) {
            (Some(raw), Some(stored)) if current.as_deref() == Some(stored.as_str()) => {
                serde_json::from_str::<ApiEngineValidation>(&raw)
                    .ok()
                    .filter(|validation| validation.engine == engine_label)
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
        agent: AgentKind,
        profile: &ApiProfile,
        secret: &str,
    ) -> Result<ManagedRecord> {
        validate_profile_agent(agent, profile)?;
        let name = clean_name(raw_name)?;
        let secret = clean_api_key(secret)?;
        let existing = self.list_managed_accounts(data)?;
        let becomes_default = !existing.iter().any(|account| account.is_default);
        let id = Uuid::new_v4().to_string();
        let timestamp = now();
        let profile_json = serde_json::to_string(profile)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO managed_accounts(id,agent,name,is_default,created_at,updated_at,api_profile) \
             VALUES(?1,?2,?3,?4,?5,?5,?6)",
            params![id, agent_label(agent)?, name, becomes_default as i64, timestamp, profile_json],
        )?;
        transaction.commit()?;
        let root = profile_account_root_for_agent(data, &id, agent)?;
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
        agent: AgentKind,
        profile: &ApiProfile,
        secret: &str,
    ) -> Result<ManagedRecord> {
        validate_profile_agent(agent, profile)?;
        validate_account_id(id)?;
        let name = clean_name(raw_name)?;
        let secret = clean_api_key(secret)?;
        let existing = self.list_managed_accounts(data)?;
        let becomes_default = !existing.iter().any(|account| account.is_default);
        let timestamp = now();
        let profile_json = serde_json::to_string(profile)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO managed_accounts(id,agent,name,is_default,created_at,updated_at,api_profile) \
             VALUES(?1,?2,?3,?4,?5,?5,?6)",
            params![id, agent_label(agent)?, name, becomes_default as i64, timestamp, profile_json],
        )?;
        transaction.commit()?;
        write_credential(
            &profile_account_root_for_agent(data, id, agent)?,
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
        let next_protocol = protocol.unwrap_or_else(|| existing.protocol());
        let agent = agent_label(record.agent)?;
        let profile = clean_profile(
            agent,
            base_url.unwrap_or(&existing.base_url),
            model.unwrap_or(&existing.model),
            provider.or(Some(existing.provider.as_str())),
            Some(next_protocol),
            Some(capabilities.unwrap_or(existing_caps)),
            preserved_headers,
        )?;
        let connection_changed = profile != existing;
        if connection_changed {
            validate_profile_agent(record.agent, &profile)?;
        }
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
                &profile_account_root_for_agent(data, id, record.agent)?,
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
                 api_validation=NULL,api_validation_revision=NULL,api_engine_validation=NULL,api_engine_validation_revision=NULL WHERE id=?4",
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
        let current = revision(
            &profile,
            profile_secret_for_agent(data, id, record.agent, &profile)?.as_deref(),
        );
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

    /// Records an engine probe result only when the profile+key revision still
    /// matches the revision captured before the probe started.
    pub(crate) fn record_api_engine_validation(
        &mut self,
        data: &Path,
        id: &str,
        expected_revision: &str,
        validation: &ApiEngineValidation,
    ) -> Result<bool> {
        let record = self.managed_account(id)?;
        let Some(profile) = record.api_profile else {
            return Err(Error::Invalid("此账号没有有效的 API Profile".into()));
        };
        let current = revision(
            &profile,
            profile_secret_for_agent(data, id, record.agent, &profile)?.as_deref(),
        );
        if current != expected_revision {
            return Ok(false);
        }
        let json = serde_json::to_string(validation)?;
        self.connection.execute(
            "UPDATE managed_accounts SET api_engine_validation=?1,api_engine_validation_revision=?2,updated_at=?3 WHERE id=?4",
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
        Ok(revision(
            &profile,
            profile_secret_for_agent(data, id, record.agent, &profile)?.as_deref(),
        ))
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
        let root = match record.api_profile.as_ref() {
            Some(_) => profile_account_root_for_agent(data, id, record.agent)?,
            None => account_root(data, id)?,
        };
        write_credential(&root, &credential)?;
        self.connection.execute(
            "UPDATE managed_accounts SET updated_at=?1,api_validation=NULL, \
             api_validation_revision=NULL,api_engine_validation=NULL, \
             api_engine_validation_revision=NULL WHERE id=?2",
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
        let root = match record.api_profile.as_ref() {
            Some(_) => profile_account_root_for_agent(data, id, record.agent)?,
            None => account_root(data, id)?,
        };
        match fs::remove_file(credential_path(&root)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        // Credentials written by older builds into the config root.
        let _ = fs::remove_file(root.join(".credentials.json"));
        self.connection.execute(
            "UPDATE managed_accounts SET updated_at=?1,api_validation=NULL, \
             api_validation_revision=NULL,api_engine_validation=NULL, \
             api_engine_validation_revision=NULL WHERE id=?2",
            params![now(), id],
        )?;
        Ok(())
    }

    /// Deletes metadata, the isolated config root, and any credential. A
    /// running session (structured turn or live login PTY) blocks deletion.
    pub(crate) fn delete_managed_account(&mut self, data: &Path, id: &str) -> Result<()> {
        let record = self.managed_account(id)?;
        if super::sources::ModelSources::open(data)?.is_bound(id) {
            return Err(Error::InUse);
        }
        if self.active_session_count(id)? > 0 {
            return Err(Error::InUse);
        }
        self.connection
            .execute("DELETE FROM managed_accounts WHERE id=?", [id])?;
        let root = match record.api_profile.as_ref() {
            Some(_) => profile_account_root_for_agent(data, id, record.agent)?,
            None => account_root(data, id)?,
        };
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

    pub(crate) fn native_account_active_count(&self, agent: &str, native_id: &str) -> Result<i64> {
        crate::database::validate_text(agent, 32, false)?;
        crate::database::validate_id(native_id)?;
        self.connection.query_row(
            "SELECT COUNT(*) FROM session_heads sh              LEFT JOIN agent_runs ar ON ar.session_id = sh.id              LEFT JOIN terminal_runs tr ON tr.session_id = sh.id              WHERE sh.lifecycle = 'active'                AND json_extract(sh.payload, '$.agent') = ?1                AND (COALESCE(ar.account_id, tr.account_id) IS NULL                     OR COALESCE(ar.account_id, tr.account_id) = ?2)",
            params![agent, native_id],
            |row| row.get(0),
        ).map_err(Error::from)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Store;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn imports_legacy_api_profile_accounts_with_credentials() {
        let legacy = TempDir::new().unwrap();
        std::fs::create_dir_all(legacy.path().join("agent-accounts/codex/acct")).unwrap();
        std::fs::write(
            legacy.path().join("agent-accounts.json"),
            serde_json::to_string(&json!({
                "version": 1,
                "accounts": [{
                    "id": "acct",
                    "agent": "codex",
                    "name": "Legacy",
                    "apiProfile": {
                        "baseUrl": "https://gateway.example/v1/responses",
                        "model": "model-a"
                    },
                    "createdAt": 1,
                    "updatedAt": 2
                }],
                "defaults": { "codex": "acct" }
            }))
            .unwrap(),
        )
        .unwrap();
        write_credential(
            &legacy.path().join("agent-accounts/codex/acct"),
            &Credential {
                kind: CredentialKind::ApiKey,
                secret: "legacy-secret".into(),
            },
        )
        .unwrap();
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        assert_eq!(
            store
                .import_legacy_accounts(directory.path(), legacy.path())
                .unwrap(),
            1
        );
        let record = store
            .managed_snapshot_row(directory.path(), "acct")
            .unwrap();
        assert_eq!(record.agent, AgentKind::Codex);
        assert!(record.is_default);
        assert_eq!(
            record.api_profile.unwrap().base_url,
            "https://gateway.example/v1"
        );
        assert_eq!(
            profile_secret_for_agent(
                directory.path(),
                "acct",
                AgentKind::Codex,
                &ApiProfile {
                    provider: "openai_compatible".into(),
                    protocol: Some("openai_responses".into()),
                    base_url: "https://gateway.example/v1".into(),
                    model: "model-a".into(),
                    model_capabilities: None,
                    headers: None,
                }
            )
            .unwrap()
            .as_deref(),
            Some("legacy-secret")
        );
    }

    #[test]
    fn legacy_mismatched_profile_keeps_credential_accessible_to_protocol_engine() {
        let directory = TempDir::new().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let profile = ApiProfile {
            provider: "openai_compatible".into(),
            protocol: Some("openai_responses".into()),
            base_url: "https://gateway.example/v1".into(),
            model: "model-a".into(),
            model_capabilities: None,
            headers: None,
        };
        store
            .connection
            .execute(
                "INSERT INTO managed_accounts(id,agent,name,is_default,created_at,updated_at,api_profile) VALUES(?1,'claude','Legacy mismatch',0,1,1,?2)",
                rusqlite::params!["mismatch", serde_json::to_string(&profile).unwrap()],
            )
            .unwrap();
        write_credential(
            &profile_account_root_for_agent(directory.path(), "mismatch", AgentKind::Claude)
                .unwrap(),
            &Credential {
                kind: CredentialKind::ApiKey,
                secret: "legacy-secret".into(),
            },
        )
        .unwrap();
        let record = store
            .managed_snapshot_row(directory.path(), "mismatch")
            .unwrap();
        assert_eq!(record.agent, AgentKind::Claude);
        assert_eq!(
            super::super::profile::agent_kind(&profile),
            AgentKind::Codex
        );
        assert_eq!(
            profile_secret_for_agent(
                directory.path(),
                "mismatch",
                record.agent,
                record.api_profile.as_ref().unwrap(),
            )
            .unwrap()
            .as_deref(),
            Some("legacy-secret")
        );
        let environment = profile_account_environment(
            directory.path(),
            "mismatch",
            record.agent,
            record.api_profile.as_ref().unwrap(),
        )
        .unwrap();
        assert!(
            environment
                .iter()
                .any(|(key, value)| key == "OPENAI_API_KEY" && value == "legacy-secret")
        );
        assert!(
            environment
                .iter()
                .all(|(key, _)| key != "ANTHROPIC_API_KEY")
        );
    }
}
