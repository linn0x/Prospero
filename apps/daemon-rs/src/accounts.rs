//! Account discovery and managed-account control (Stage 8).
//!
//! Every managed Claude account owns an isolated `CLAUDE_CONFIG_DIR` root plus
//! a mode-0600 credential file inside the daemon's private data directory.
//! Nothing here touches the user's shared CLI home or native Keychain:
//! logout deletes only the private credential file.

pub(crate) mod managed;

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use ts_rs::TS;

use crate::error::Result;
use crate::worker::Database;

pub const NATIVE_CLAUDE_ID: &str = "native-claude";
const NATIVE_NAME: &str = "本机默认";
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
    fn request_id(&self) -> &str {
        match self {
            AccountControl::List { request_id }
            | AccountControl::Create { request_id, .. }
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
            AccountControl::Rename { .. } => "rename",
            AccountControl::SetDefault { .. } => "default",
            AccountControl::Login { .. } => "login",
            AccountControl::SetCredential { .. } => "credential",
            AccountControl::Logout { .. } => "logout",
            AccountControl::Delete { .. } => "delete",
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

/// Builds one account row for a managed record.
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
        auth_method: probe.auth_method,
        detail: probe.detail,
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
    snapshot_with(database, request_id, action, None, None).await
}

async fn snapshot_with(
    database: &Database,
    request_id: &str,
    action: &str,
    account_id: Option<String>,
    session_id: Option<String>,
) -> Result<AccountListResult> {
    let db = database.clone();
    let (managed, native_active, mut managed_active) = db
        .call(|store| {
            let managed = store.list_managed_accounts()?;
            let ids: Vec<String> = managed.iter().map(|record| record.id.clone()).collect();
            let (native_active, managed_active) = store.account_active_counts(&ids)?;
            Ok((managed, native_active, managed_active))
        })
        .await?;
    let any_default = managed.iter().any(|record| record.is_default);
    let probe = probe_auth_status(&[]).await;
    let now = crate::database::now();
    let mut accounts = vec![NativeAccount {
        id: NATIVE_CLAUDE_ID.into(),
        agent: crate::protocol::AgentKind::Claude,
        name: NATIVE_NAME.into(),
        managed: false,
        is_default: !any_default,
        status: probe.status,
        capabilities: claude_capabilities(),
        auth_method: probe.auth_method,
        detail: probe.detail,
        created_at: 0,
        updated_at: now,
        active_sessions: native_active,
    }];
    for record in managed {
        let active = managed_active.remove(&record.id).unwrap_or(0);
        accounts.push(managed_row(database, record, active).await?);
    }
    Ok(AccountListResult {
        kind: "agent.accounts.result".into(),
        request_id: request_id.chars().take(100).collect(),
        action: action.into(),
        ok: true,
        accounts,
        account_id,
        session_id,
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

/// Completes a control request by re-snapshotting accounts.
pub(crate) async fn respond(
    database: &Database,
    control: &AccountControl,
    account_id: Option<String>,
    session_id: Option<String>,
) -> Result<AccountListResult> {
    snapshot_with(
        database,
        control.request_id(),
        control.action(),
        account_id,
        session_id,
    )
    .await
}
