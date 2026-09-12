//! Read-only account discovery (Stage 8).
//!
//! This slice exposes only the legacy "本机默认" native environment for Claude:
//! no managed accounts, credentials, API profiles, or login flows exist yet, so
//! nothing here mutates the user's CLI state. The status probe runs
//! `claude auth status --json` — a read-only command — with a bounded timeout.

use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use ts_rs::TS;

use crate::database::Store;
use crate::error::Result;

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

/// Legacy AgentAccountCapabilities contract. modelSelection/reasoningEffort are
/// false for now: the Rust daemon does not serve a launch-model catalog yet, so
/// the desktop hides the model/effort switchers instead of hitting an
/// unimplemented endpoint.
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

/// Subset of the legacy AgentAccount record that this read-only slice can
/// populate honestly.
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
}

fn binary() -> String {
    std::env::var("PROSPERO_CLAUDE_BIN").unwrap_or_else(|_| "claude".into())
}

fn native_capabilities() -> AccountCapabilities {
    AccountCapabilities {
        session_kinds: vec![
            crate::protocol::SessionKind::Pty,
            crate::protocol::SessionKind::Structured,
        ],
        plan: true,
        resume: true,
        // Launch-model/effort catalogs are a later slice.
        model_selection: false,
        reasoning_effort: false,
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

/// Runs `<claude> auth status --json`. Read-only: stdin/null, no env overrides.
async fn probe_auth_status() -> AuthProbe {
    let output = Command::new(binary())
        .arg("auth")
        .arg("status")
        .arg("--json")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
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
        return AuthProbe {
            status: AccountStatus::SignedOut,
            ..Default::default()
        };
    }
    let parsed: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => {
            return AuthProbe {
                status: AccountStatus::SignedOut,
                ..Default::default()
            };
        }
    };
    if parsed.get("loggedIn") != Some(&serde_json::Value::Bool(true)) {
        return AuthProbe {
            status: AccountStatus::SignedOut,
            ..Default::default()
        };
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

/// Counts live structured Claude sessions not bound to a managed account.
fn active_native_sessions(store: &mut Store) -> Result<i64> {
    let page = store.sessions(crate::protocol::SessionQuery {
        limit: Some(100),
        cursor: None,
        lifecycle: Some(crate::protocol::SessionLifecycle::Active),
        workspace: None,
        text: None,
    })?;
    Ok(page
        .items
        .iter()
        .filter(|head| head.agent == crate::protocol::AgentKind::Claude)
        .count()
        .min(i64::MAX as usize) as i64)
}

/// Builds the account list. Only the native Claude account exists in this
/// slice; its status is freshly probed on every request.
pub async fn list_accounts(
    database: &crate::worker::Database,
    request_id: &str,
) -> Result<AccountListResult> {
    let db = database.clone();
    let active = db.call(active_native_sessions).await?;
    let probe = probe_auth_status().await;
    let now = crate::database::now();
    let account = NativeAccount {
        id: NATIVE_CLAUDE_ID.into(),
        agent: crate::protocol::AgentKind::Claude,
        name: NATIVE_NAME.into(),
        managed: false,
        is_default: true,
        status: probe.status,
        capabilities: native_capabilities(),
        auth_method: probe.auth_method,
        detail: probe.detail,
        // Legacy native rows report epoch 0 for creation timestamps.
        created_at: 0,
        updated_at: now,
        active_sessions: active,
    };
    Ok(AccountListResult {
        kind: "agent.accounts.result".into(),
        request_id: request_id.chars().take(100).collect(),
        action: "list".into(),
        ok: true,
        accounts: vec![account],
    })
}
