//! Account discovery and managed-account control (Stage 8).
//!
//! Every managed Claude account owns an isolated `CLAUDE_CONFIG_DIR` root plus
//! a mode-0600 credential file inside the daemon's private data directory.
//! Nothing here touches the user's shared CLI home or native Keychain:
//! logout deletes only the private credential file.

pub(crate) mod config;
pub(crate) mod managed;
pub(crate) mod models;
pub(crate) mod probe;
pub(crate) mod profile;
pub(crate) mod sources;

pub(crate) use probe::{ApiEngineValidation, ApiValidation};
pub(crate) use profile::{ApiProfile, ModelCapabilities, ModelCapabilitySupport};

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use ts_rs::TS;

use crate::error::Result;
use crate::worker::Database;

pub const NATIVE_CLAUDE_ID: &str = "native-claude";
const NATIVE_NAME: &str = "本机默认";
const CODEX_STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const STATUS_TIMEOUT: Duration = Duration::from_secs(12);
/// Mirrors the legacy agent-accounts runner output cap.
const MAX_STATUS_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum AccountStatus {
    SignedIn,
    SignedOut,
    Unavailable,
    Error,
}

/// Legacy AgentAccountCapabilities contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AccountCapabilities {
    pub session_kinds: Vec<crate::protocol::SessionKind>,
    pub plan: bool,
    pub resume: bool,
    pub model_selection: bool,
    pub reasoning_effort: bool,
}

/// Legacy AgentAccount record; `managed` distinguishes the native row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct NativeAccount {
    pub id: String,
    pub agent: crate::protocol::AgentKind,
    pub name: String,
    pub managed: bool,
    pub is_default: bool,
    pub status: AccountStatus,
    pub capabilities: AccountCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_profile: Option<ApiProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_source: Option<sources::SourceBindingView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_validation: Option<ApiValidation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_engine_validation: Option<ApiEngineValidation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_capability_support: Option<ModelCapabilitySupport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "number")]
    pub active_sessions: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountListRequest {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AccountListResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub action: String,
    pub ok: bool,
    pub accounts: Vec<NativeAccount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<ApiValidation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_validation: Option<ApiEngineValidation>,
}

/// Tag dispatch for `/v1/accounts`. API/profile actions remain a later slice.
///
/// `rename_all` on an internally tagged enum only renames variants, so every
/// field must declare its camelCase wire name explicitly.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum AccountControl {
    #[serde(rename = "agent.accounts.list")]
    List {
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "agent.account.create")]
    Create {
        #[serde(rename = "requestId")]
        request_id: String,
        agent: String,
        name: String,
    },
    #[serde(rename = "agent.account.api.create")]
    ApiCreate {
        #[serde(rename = "requestId")]
        request_id: String,
        agent: String,
        name: String,
        provider: Option<String>,
        protocol: Option<String>,
        #[serde(rename = "baseUrl")]
        base_url: String,
        model: String,
        #[serde(rename = "apiKey")]
        api_key: String,
        #[serde(rename = "modelCapabilities")]
        model_capabilities: Option<serde_json::Value>,
    },
    #[serde(rename = "agent.account.api.configure")]
    ApiConfigure {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
        name: Option<String>,
        provider: Option<String>,
        protocol: Option<String>,
        #[serde(rename = "baseUrl")]
        base_url: Option<String>,
        model: Option<String>,
        #[serde(rename = "apiKey")]
        api_key: Option<String>,
        /// Nullable: `null` clears capabilities, omission keeps them. The
        /// double option encodes missing=None vs explicit-null=Some(None).
        #[serde(rename = "modelCapabilities", default)]
        model_capabilities: Option<Option<serde_json::Value>>,
    },
    #[serde(rename = "agent.account.api.test")]
    ApiTest {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
        scope: Option<String>,
    },
    #[serde(rename = "agent.account.api.models.get")]
    ApiModelsGet {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: Option<String>,
        protocol: Option<String>,
        #[serde(rename = "baseUrl")]
        base_url: Option<String>,
        #[serde(rename = "apiKey")]
        api_key: Option<String>,
        headers: Option<serde_json::Value>,
    },
    #[serde(rename = "agent.account.config.get")]
    ConfigGet {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
    },
    #[serde(rename = "agent.account.config.set")]
    ConfigSet {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
        #[serde(rename = "documentId")]
        document_id: String,
        revision: String,
        content: Option<String>,
        #[serde(rename = "defaultEffort", default)]
        default_effort: Option<Option<String>>,
    },
    #[serde(rename = "agent.account.rename")]
    Rename {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
        name: String,
    },
    #[serde(rename = "agent.account.default")]
    SetDefault {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
    },
    #[serde(rename = "agent.account.login")]
    Login {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "agent.account.credential.set")]
    SetCredential {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
        #[serde(rename = "credentialKind")]
        credential_kind: String,
        credential: String,
    },
    #[serde(rename = "agent.account.logout")]
    Logout {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
    },
    #[serde(rename = "agent.account.delete")]
    Delete {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "accountId")]
        account_id: String,
    },
}

impl AccountControl {
    pub(crate) fn request_id(&self) -> &str {
        match self {
            AccountControl::List { request_id }
            | AccountControl::Create { request_id, .. }
            | AccountControl::ApiCreate { request_id, .. }
            | AccountControl::ApiConfigure { request_id, .. }
            | AccountControl::ApiTest { request_id, .. }
            | AccountControl::ApiModelsGet { request_id, .. }
            | AccountControl::ConfigGet { request_id, .. }
            | AccountControl::ConfigSet { request_id, .. }
            | AccountControl::Rename { request_id, .. }
            | AccountControl::SetDefault { request_id, .. }
            | AccountControl::Login { request_id, .. }
            | AccountControl::SetCredential { request_id, .. }
            | AccountControl::Logout { request_id, .. }
            | AccountControl::Delete { request_id, .. } => request_id,
        }
    }

    fn action(&self) -> &'static str {
        match self {
            AccountControl::List { .. } => "list",
            AccountControl::Create { .. } => "create",
            AccountControl::ApiCreate { .. } => "api_create",
            AccountControl::ApiConfigure { .. } => "api_configure",
            AccountControl::ApiTest { .. } => "api_test",
            AccountControl::ApiModelsGet { .. } => "api_models",
            AccountControl::ConfigGet { .. } | AccountControl::ConfigSet { .. } => "config",
            AccountControl::Rename { .. } => "rename",
            AccountControl::SetDefault { .. } => "default",
            AccountControl::Login { .. } => "login",
            AccountControl::SetCredential { .. } => "credential",
            AccountControl::Logout { .. } => "logout",
            AccountControl::Delete { .. } => "delete",
        }
    }

    pub(crate) fn account_id(&self) -> Option<&str> {
        match self {
            AccountControl::ApiConfigure { account_id, .. }
            | AccountControl::ApiTest { account_id, .. }
            | AccountControl::ApiModelsGet {
                account_id: Some(account_id),
                ..
            }
            | AccountControl::ConfigGet { account_id, .. }
            | AccountControl::ConfigSet { account_id, .. }
            | AccountControl::Rename { account_id, .. }
            | AccountControl::SetDefault { account_id, .. }
            | AccountControl::Login { account_id, .. }
            | AccountControl::SetCredential { account_id, .. }
            | AccountControl::Logout { account_id, .. }
            | AccountControl::Delete { account_id, .. } => Some(account_id),
            AccountControl::List { .. }
            | AccountControl::Create { .. }
            | AccountControl::ApiCreate { .. }
            | AccountControl::ApiModelsGet { .. } => None,
        }
    }
}

fn binary() -> String {
    std::env::var("PROSPERO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into())
}

fn claude_capabilities() -> AccountCapabilities {
    AccountCapabilities {
        session_kinds: vec![
            crate::protocol::SessionKind::Pty,
            crate::protocol::SessionKind::Structured,
        ],
        plan: true,
        resume: true,
        // GET /v1/launch/models serves the headless CLI catalog.
        model_selection: true,
        reasoning_effort: true,
    }
}

fn codex_capabilities() -> AccountCapabilities {
    AccountCapabilities {
        // Rust supports PTY plus the native app-server structured runtime for
        // Codex's core thread/turn lifecycle.
        session_kinds: vec![
            crate::protocol::SessionKind::Pty,
            crate::protocol::SessionKind::Structured,
        ],
        plan: true,
        resume: true,
        model_selection: true,
        reasoning_effort: true,
    }
}

async fn probe_codex_status(data: &std::path::Path) -> AuthProbe {
    let (cwd, environment) = match crate::agent::native_codex_environment(data) {
        Ok(value) => value,
        Err(_) => {
            return AuthProbe {
                status: AccountStatus::Error,
                detail: Some("无法准备 Codex 账号目录".into()),
                ..Default::default()
            };
        }
    };
    let binary = std::env::var("PROSPERO_CODEX_BIN").unwrap_or_else(|_| "codex".into());
    let mut command = Command::new(binary);
    command
        .args(["login", "status"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in environment {
        command.env(key, value);
    }
    let output = command.output();
    match tokio::time::timeout(CODEX_STATUS_TIMEOUT, output).await {
        Ok(Ok(output)) => {
            let raw = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let raw = raw.trim();
            if raw.is_empty() || raw.to_ascii_lowercase().contains("not logged in") {
                return AuthProbe::default();
            }
            if !output.status.success() {
                return AuthProbe {
                    status: AccountStatus::Error,
                    detail: Some("Codex CLI 无法读取登录状态".into()),
                    ..Default::default()
                };
            }
            let auth_method = raw
                .to_ascii_lowercase()
                .split("logged in")
                .nth(1)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(200).collect::<String>());
            AuthProbe {
                status: AccountStatus::SignedIn,
                auth_method,
                detail: None,
            }
        }
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => AuthProbe {
            status: AccountStatus::Unavailable,
            detail: Some("未安装 codex".into()),
            ..Default::default()
        },
        _ => AuthProbe {
            status: AccountStatus::Error,
            detail: Some("Codex CLI 无法读取登录状态".into()),
            ..Default::default()
        },
    }
}

#[derive(Debug, PartialEq, Eq)]
struct AuthProbe {
    status: AccountStatus,
    auth_method: Option<String>,
    detail: Option<String>,
}

impl Default for AuthProbe {
    fn default() -> Self {
        Self {
            status: AccountStatus::SignedOut,
            auth_method: None,
            detail: None,
        }
    }
}

/// Runs `<claude> auth status --json` with the given environment overrides.
/// Read-only: stdin/null, never clears the inherited environment.
async fn probe_auth_status(environment: &[(String, String)]) -> AuthProbe {
    let mut command = Command::new(binary());
    command
        .arg("auth")
        .arg("status")
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in environment {
        command.env(key, value);
    }
    let output = command.output();
    let child = match tokio::time::timeout(STATUS_TIMEOUT, output).await {
        Ok(Ok(child)) => child,
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return AuthProbe {
                status: AccountStatus::Unavailable,
                detail: Some("未安装 claude".into()),
                ..Default::default()
            };
        }
        Ok(Err(_)) | Err(_) => {
            return AuthProbe {
                status: AccountStatus::Unavailable,
                detail: Some("claude CLI 不可用".into()),
                ..Default::default()
            };
        }
    };
    if child.stdout.len() > MAX_STATUS_BYTES || child.stderr.len() > MAX_STATUS_BYTES {
        return AuthProbe {
            status: AccountStatus::Error,
            detail: Some("无法读取登录状态".into()),
            ..Default::default()
        };
    }
    let raw = String::from_utf8_lossy(&child.stdout);
    let raw = raw.trim();
    if raw.is_empty() {
        return AuthProbe::default();
    }
    let parsed: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return AuthProbe::default(),
    };
    if parsed.get("loggedIn") != Some(&serde_json::Value::Bool(true)) {
        return AuthProbe::default();
    }
    let auth_method = parsed
        .get("authMethod")
        .and_then(|value| value.as_str())
        .map(|value| value.chars().take(200).collect::<String>());
    let detail = parsed
        .get("apiProvider")
        .and_then(|value| value.as_str())
        .map(|value| value.chars().take(1000).collect::<String>());
    AuthProbe {
        status: AccountStatus::SignedIn,
        auth_method,
        detail,
    }
}

#[allow(dead_code)]
pub(crate) fn source_bound_launch_error(
    database: &Database,
    account_id: &str,
) -> Result<Option<String>> {
    let sources = sources::ModelSources::open(database.directory())?;
    Ok(if sources.allows_new_sessions(account_id) {
        None
    } else {
        Some("模型源或模型已停用，无法创建新会话".into())
    })
}

fn profile_capabilities() -> AccountCapabilities {
    AccountCapabilities {
        session_kinds: vec![
            crate::protocol::SessionKind::Pty,
            crate::protocol::SessionKind::Structured,
        ],
        plan: true,
        resume: true,
        // Profile sessions pin model/reasoning through the profile itself.
        model_selection: false,
        reasoning_effort: false,
    }
}

/// Builds one account row for a legacy managed (OAuth/imported-key) account.
async fn managed_row(
    database: &Database,
    record: managed::ManagedRecord,
    active_sessions: i64,
) -> Result<NativeAccount> {
    let data = database.directory().to_owned();
    let id = record.id.clone();
    let environment =
        tokio::task::spawn_blocking(move || managed::claude_environment(&data, &id, false))
            .await
            .map_err(|_| crate::error::Error::Closed)??;
    let probe = probe_auth_status(&environment).await;
    Ok(NativeAccount {
        id: record.id,
        agent: crate::protocol::AgentKind::Claude,
        name: record.name,
        managed: true,
        is_default: record.is_default,
        status: probe.status,
        capabilities: claude_capabilities(),
        api_profile: None,
        model_source: None,
        engine: None,
        api_validation: None,
        api_engine_validation: None,
        model_capability_support: None,
        auth_method: probe.auth_method,
        detail: probe.detail,
        created_at: record.created_at,
        updated_at: record.updated_at,
        active_sessions,
    })
}

/// Builds one account row for a third-party API profile account. Profile rows
/// never run `claude auth status` (the isolated key is not a CLI login);
/// status derives from runtime availability, key presence and the recorded
/// revision-checked validation.
async fn profile_row(
    database: &Database,
    record: managed::ManagedRecord,
    active_sessions: i64,
    runtime_ok: bool,
    model_source: Option<sources::SourceBindingView>,
) -> Result<NativeAccount> {
    let profile = record
        .api_profile
        .as_ref()
        .expect("profile rows carry a parsed profile");
    let data = database.directory().to_owned();
    let id = record.id.clone();
    let secret_profile = profile.clone();
    let secret =
        tokio::task::spawn_blocking(move || managed::profile_secret(&data, &id, &secret_profile))
            .await
            .map_err(|_| crate::error::Error::Closed)??;
    let (status, auth_method, detail) = if !runtime_ok {
        (
            AccountStatus::Unavailable,
            None,
            Some("claude CLI 不可用".into()),
        )
    } else if secret.is_none() {
        (
            AccountStatus::SignedOut,
            None,
            Some("需要配置该 Profile 的 API Key".into()),
        )
    } else {
        let host = url::Url::parse(&profile.base_url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .unwrap_or_else(|| profile.base_url.clone());
        let state = match (
            record.api_engine_validation.as_ref(),
            record.api_validation.as_ref(),
        ) {
            (Some(validation), _) if validation.status == "passed" => "引擎验证通过",
            (Some(_), _) => "引擎验证失败",
            (None, Some(validation)) if validation.status == "passed" => "协议测试通过",
            (None, Some(_)) => "连接测试失败",
            (None, None) => "已配置，尚未测试连接",
        };
        (
            AccountStatus::SignedIn,
            Some("API Key".into()),
            Some(format!("{state} · {} · {host}", profile.protocol())),
        )
    };
    let model_capability_support = record
        .api_profile
        .as_ref()
        .and_then(profile::capability_support);
    let profile_agent = profile::agent_kind(profile);
    let engine = match profile_agent {
        crate::protocol::AgentKind::Codex => "codex",
        _ => "claude",
    };
    Ok(NativeAccount {
        id: record.id,
        agent: profile_agent,
        name: record.name,
        managed: true,
        is_default: record.is_default,
        status,
        capabilities: profile_capabilities(),
        api_profile: record.api_profile,
        model_source,
        engine: Some(engine.into()),
        api_validation: record.api_validation,
        api_engine_validation: record.api_engine_validation,
        model_capability_support,
        auth_method,
        detail,
        created_at: record.created_at,
        updated_at: record.updated_at,
        active_sessions,
    })
}

/// The native row plus every managed row, status freshly probed.
pub(crate) async fn snapshot(
    database: &Database,
    request_id: &str,
    action: &str,
) -> Result<AccountListResult> {
    snapshot_with(database, request_id, action, None, None, None, None).await
}

#[allow(clippy::too_many_arguments)]
async fn snapshot_with(
    database: &Database,
    request_id: &str,
    action: &str,
    account_id: Option<String>,
    session_id: Option<String>,
    validation: Option<ApiValidation>,
    engine_validation: Option<ApiEngineValidation>,
) -> Result<AccountListResult> {
    let db = database.clone();
    let data = database.directory().to_owned();
    let (managed, native_active, native_codex_active, mut managed_active, bindings) = db
        .call({
            let data = data.clone();
            move |store| {
                let managed = store.list_managed_accounts(&data)?;
                let ids: Vec<String> = managed.iter().map(|record| record.id.clone()).collect();
                let (native_active, managed_active) = store.account_active_counts(&ids)?;
                let native_codex_active =
                    store.native_account_active_count("codex", crate::agent::NATIVE_CODEX_ID)?;
                let sources = sources::ModelSources::open(&data)?;
                let bindings = ids
                    .iter()
                    .filter_map(|id| sources.binding_view(id).map(|view| (id.clone(), view)))
                    .collect::<std::collections::HashMap<_, _>>();
                Ok((
                    managed,
                    native_active,
                    native_codex_active,
                    managed_active,
                    bindings,
                ))
            }
        })
        .await?;
    let any_default = managed.iter().any(|record| record.is_default);
    let probe = probe_auth_status(&[]).await;
    // The isolated runtime probe feeds both the native row and profile rows;
    // run it once per snapshot.
    let runtime_ok = probe::runtime_available().await;
    let codex_probe = probe_codex_status(&data).await;
    let now = crate::database::now();
    let mut accounts = vec![
        NativeAccount {
            id: NATIVE_CLAUDE_ID.into(),
            agent: crate::protocol::AgentKind::Claude,
            name: NATIVE_NAME.into(),
            managed: false,
            is_default: !any_default,
            status: probe.status,
            capabilities: claude_capabilities(),
            api_profile: None,
            model_source: None,
            engine: None,
            api_validation: None,
            api_engine_validation: None,
            model_capability_support: None,
            auth_method: probe.auth_method,
            detail: probe.detail,
            created_at: 0,
            updated_at: now,
            active_sessions: native_active,
        },
        NativeAccount {
            id: crate::agent::NATIVE_CODEX_ID.into(),
            agent: crate::protocol::AgentKind::Codex,
            name: NATIVE_NAME.into(),
            managed: false,
            is_default: true,
            status: codex_probe.status,
            capabilities: codex_capabilities(),
            api_profile: None,
            model_source: None,
            engine: None,
            api_validation: None,
            api_engine_validation: None,
            model_capability_support: None,
            auth_method: codex_probe.auth_method,
            detail: codex_probe.detail,
            created_at: 0,
            updated_at: now,
            active_sessions: native_codex_active,
        },
    ];
    for record in managed {
        let active = managed_active.remove(&record.id).unwrap_or(0);
        if record.api_profile.is_some() {
            let binding = bindings.get(&record.id).cloned();
            accounts.push(profile_row(database, record, active, runtime_ok, binding).await?);
        } else {
            accounts.push(managed_row(database, record, active).await?);
        }
    }
    Ok(AccountListResult {
        kind: "agent.accounts.result".into(),
        request_id: request_id.chars().take(100).collect(),
        action: action.into(),
        ok: true,
        accounts,
        account_id,
        session_id,
        validation,
        engine_validation,
    })
}

/// Builds the account list. Only the native Claude account exists in the
/// read-only slice; its status is freshly probed on every request.
pub async fn list_accounts(database: &Database, request_id: &str) -> Result<AccountListResult> {
    snapshot(database, request_id, "list").await
}

pub(crate) fn parse_control(value: &serde_json::Value) -> Result<AccountControl> {
    let control: AccountControl = serde_json::from_value(value.clone())
        .map_err(|_| crate::error::Error::Invalid("invalid account request".into()))?;
    let request_id = control.request_id();
    if request_id.trim().is_empty() || request_id.chars().count() > 100 {
        return Err(crate::error::Error::Invalid(
            "invalid account request".into(),
        ));
    }
    Ok(control)
}

/// Metadata-only actions. Returns the affected account id for the response.
pub(crate) async fn execute_control(
    database: &Database,
    control: &AccountControl,
) -> Result<Option<String>> {
    let db = database.clone();
    match control {
        AccountControl::List { .. } => Ok(None),
        AccountControl::Create { name, .. } => {
            let data = database.directory().to_owned();
            let name = name.clone();
            let record = db
                .call(move |store| {
                    let record = store.create_managed_account(&data, &name)?;
                    Ok(record.id)
                })
                .await?;
            Ok(Some(record))
        }
        AccountControl::ApiCreate {
            name,
            agent,
            provider,
            protocol,
            base_url,
            model,
            api_key,
            model_capabilities,
            ..
        } => {
            let profile = profile::clean_profile_inputs(
                agent,
                base_url,
                model,
                provider.as_deref(),
                protocol.as_deref(),
                model_capabilities.clone(),
            )?;
            let data = database.directory().to_owned();
            let name = name.clone();
            let secret = api_key.clone();
            let id = db
                .call(move |store| {
                    let record =
                        store.create_api_profile_account(&data, &name, &profile, &secret)?;
                    Ok(record.id)
                })
                .await?;
            Ok(Some(id))
        }
        AccountControl::ApiConfigure {
            account_id,
            name,
            provider,
            protocol,
            base_url,
            model,
            api_key,
            model_capabilities,
            ..
        } => {
            let data = database.directory().to_owned();
            let id = account_id.clone();
            let caps = model_capabilities
                .clone()
                .map(|inner| inner.unwrap_or(serde_json::Value::Null));
            let name = name.clone();
            let base_url = base_url.clone();
            let model = model.clone();
            let provider = provider.clone();
            let protocol = protocol.clone();
            let api_key = api_key.clone();
            let record = db
                .call(move |store| {
                    let record = store.configure_api_profile_account(
                        &data,
                        &id,
                        name.as_deref(),
                        base_url.as_deref(),
                        model.as_deref(),
                        provider.as_deref(),
                        protocol.as_deref(),
                        caps,
                        api_key.as_deref(),
                    )?;
                    Ok(record.id)
                })
                .await?;
            Ok(Some(record))
        }
        AccountControl::ApiTest { .. }
        | AccountControl::ApiModelsGet { .. }
        | AccountControl::ConfigGet { .. }
        | AccountControl::ConfigSet { .. } => Err(crate::error::Error::Invalid(
            "api features require the HTTP runtime".into(),
        )),
        AccountControl::Rename {
            account_id, name, ..
        } => {
            let id = account_id.clone();
            let name = name.clone();
            db.call(move |store| store.rename_managed_account(&id, &name))
                .await?;
            Ok(Some(account_id.clone()))
        }
        AccountControl::SetDefault { account_id, .. } => {
            let id = account_id.clone();
            db.call(move |store| store.set_default_managed_account(&id))
                .await?;
            Ok(Some(account_id.clone()))
        }
        AccountControl::Login { .. } => Err(crate::error::Error::Invalid(
            "login requires the terminal runtime".into(),
        )),
        AccountControl::SetCredential {
            account_id,
            credential_kind,
            credential,
            ..
        } => {
            let kind = match credential_kind.as_str() {
                "oauth_token" => managed::CredentialKind::OauthToken,
                "api_key" => managed::CredentialKind::ApiKey,
                _ => {
                    return Err(crate::error::Error::Invalid("凭据类型无效".into()));
                }
            };
            let data = database.directory().to_owned();
            let id = account_id.clone();
            let secret = credential.clone();
            db.call(move |store| store.set_managed_credential(&data, &id, kind, &secret))
                .await?;
            Ok(Some(account_id.clone()))
        }
        AccountControl::Logout { account_id, .. } => {
            let data = database.directory().to_owned();
            let id = account_id.clone();
            db.call(move |store| store.logout_managed_account(&data, &id))
                .await?;
            Ok(Some(account_id.clone()))
        }
        AccountControl::Delete { account_id, .. } => {
            let data = database.directory().to_owned();
            let id = account_id.clone();
            db.call(move |store| store.delete_managed_account(&data, &id))
                .await?;
            Ok(Some(account_id.clone()))
        }
    }
}

/// Completes a control request by re-snapshotting accounts. `validation` is
/// only populated for an `api.test` result.
pub(crate) async fn respond(
    database: &Database,
    control: &AccountControl,
    account_id: Option<String>,
    session_id: Option<String>,
    validation: Option<ApiValidation>,
    engine_validation: Option<ApiEngineValidation>,
) -> Result<AccountListResult> {
    snapshot_with(
        database,
        control.request_id(),
        control.action(),
        account_id,
        session_id,
        validation,
        engine_validation,
    )
    .await
}
