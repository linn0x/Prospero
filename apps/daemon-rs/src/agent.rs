mod claude;
mod codex;
pub(crate) mod conversations;
mod deepseek;
mod opencode;
mod runtime;
mod store;
mod usage;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{Error, Result};

pub use runtime::Agents;
pub use store::{ApprovalPolicy, PermissionMode};
pub(crate) use usage::{NATIVE_CODEX_ID, native_codex_environment, read_native_codex_models};

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ResumeInput {
    /// Agent-native conversation/session id to attach on the first turn.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Kept for protocol parity; Rust/Claude rejects forked resume like TS.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAgentSession {
    #[serde(default = "default_agent_kind")]
    pub agent: crate::protocol::AgentKind,
    pub title: String,
    pub workspace: String,
    #[serde(default)]
    pub auto_approve: bool,
    /// Optional initial collaboration mode for structured Claude sessions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Optional launch catalog selection (native CLI aliases / ids).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_preset: Option<String>,
    /// Managed account id; None (or the native id) uses the本机默认环境.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// Agent-native local conversation to resume at launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<ResumeInput>,
}

fn default_agent_kind() -> crate::protocol::AgentKind {
    crate::protocol::AgentKind::Claude
}

/// One row in the launch model catalog (legacy AgentModelCatalog contract).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct LaunchModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub supported_efforts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct LaunchModelCatalog {
    pub models: Vec<LaunchModelInfo>,
    pub current_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub presets: Vec<AgentPresetInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_preset: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AgentPresetInfo {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_default: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub custom: bool,
}

/// One inbound image attachment. Desktop validation mirrors the legacy
/// AttachmentSchema (at most 6 per message, the four browser image types,
/// base64 payload <= 8 MiB per image).
#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AttachmentInput {
    pub mime_type: String,
    pub data_b64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Resumable native conversation metadata discovered from provider-owned local history.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ResumableConversation {
    pub id: String,
    pub agent: crate::protocol::AgentKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub created_at: Option<i64>,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ConversationSearchResult {
    pub agent: crate::protocol::AgentKind,
    pub conversations: Vec<ResumableConversation>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AttachmentChunk {
    pub mime_type: String,
    pub data_b64: String,
    #[ts(type = "number")]
    pub total: i64,
    pub eof: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSend {
    pub text: String,
    /// `steer` tries to guide the running turn live and falls back to the
    /// front of the queue; anything else enqueues normally (FIFO).
    #[serde(default)]
    pub delivery: Option<String>,
    #[serde(default)]
    pub attachments: Vec<AttachmentInput>,
}

pub(crate) const MAX_ATTACHMENTS: usize = 6;
pub(crate) const MAX_ATTACHMENT_CHARS: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct UsageWindow {
    pub label: String,
    pub utilization: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct UsageDailyBucket {
    pub date: String,
    #[ts(type = "number")]
    pub tokens: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct UsageReport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscription: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub output_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub lifetime_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credits_unlimited: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credits_balance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_limit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_used: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_remaining_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_usage: Option<Vec<UsageDailyBucket>>,
    pub windows: Vec<UsageWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct UsageAccount {
    pub agent: crate::protocol::AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub available: bool,
    #[serde(flatten)]
    pub report: UsageReport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct UsageResult {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    pub available: bool,
    #[serde(flatten)]
    pub report: UsageReport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accounts: Option<Vec<UsageAccount>>,
}

/// Validate the legacy attachment contract: <= 6 images, known image MIME,
/// canonical base64 <= 8 MiB per payload, name <= 200 chars. Text may be
/// empty only when at least one image travels with the message.
pub(crate) fn validate_message(text: &str, attachments: &[AttachmentInput]) -> Result<()> {
    if attachments.len() > MAX_ATTACHMENTS {
        return Err(Error::Invalid("最多附带 6 张图片".into()));
    }
    let mut total = 0usize;
    for attachment in attachments {
        if !matches!(
            attachment.mime_type.as_str(),
            "image/jpeg" | "image/png" | "image/gif" | "image/webp"
        ) {
            return Err(Error::Invalid("不支持的图片类型".into()));
        }
        let data = attachment.data_b64.as_str();
        if data.is_empty()
            || data.len() > MAX_ATTACHMENT_CHARS
            || !data.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/' || byte == b'='
            })
        {
            return Err(Error::Invalid("图片数据无效".into()));
        }
        if attachment
            .name
            .as_deref()
            .is_some_and(|name| name.chars().count() > 200)
        {
            return Err(Error::Invalid("图片名称过长".into()));
        }
        total = total.saturating_add(data.len());
    }
    // The HTTP body limit is 16 MiB; keep the combined payload well inside it.
    if total > 15 * 1024 * 1024 {
        return Err(Error::Invalid("图片总大小超出限制".into()));
    }
    if text.is_empty() && attachments.is_empty() {
        return Err(Error::Invalid("invalid message".into()));
    }
    if text.len() > 64 * 1024 {
        return Err(Error::Invalid("invalid message".into()));
    }
    Ok(())
}

/// One message waiting for the current turn to finish.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub id: String,
    pub text: String,
    /// `guide` rows jump the front of the queue ("现在引导").
    pub kind: String,
    #[ts(type = "number")]
    pub created_at: i64,
    /// Number of images parked with the message (bytes are never projected).
    #[serde(rename = "attachmentCount")]
    pub attachment_count: usize,
}

/// Per-session queue projection for the desktop session list.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentQueue {
    pub session_id: String,
    pub items: Vec<QueuedMessage>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentQueues {
    pub queues: Vec<AgentQueue>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionDecision {
    pub request_id: String,
    pub allow: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionAnswer {
    pub question_id: String,
    pub values: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionDecision {
    pub request_id: String,
    #[serde(default)]
    pub answers: Vec<QuestionAnswer>,
    #[serde(default)]
    pub cancelled: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentModelSelection {
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
}

/// Result of a successful in-session model switch.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentModelSelectionResult {
    pub current_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_effort: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentControlResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub sid: String,
    pub request_id: String,
    pub action: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AgentCompactRequest {
    pub request_id: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct ApprovalPolicySelection {
    pub policy: String,
}

/// In-session model catalog (mirrors the legacy `agent.models` payload):
/// fresh catalog plus the session's persisted current selection.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentModelCatalog {
    pub models: Vec<LaunchModelInfo>,
    pub current_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_effort: Option<String>,
}

/// Per-session model/mode control flags projected into the desktop session
/// list (`agentControls`).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SessionAgentControls {
    pub session_id: String,
    pub compact: bool,
    pub model: bool,
    pub mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_mode: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentControlsProjection {
    pub controls: Vec<SessionAgentControls>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentModeSelection {
    pub mode: String,
}

/// Fixed Claude collaboration-mode catalog (matches the legacy adapter).
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentModeCatalog {
    pub modes: Vec<AgentModeEntry>,
    pub current_mode: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct AgentModeEntry {
    pub id: String,
    pub label: String,
    pub description: String,
}

pub fn mode_catalog(current: &str) -> AgentModeCatalog {
    AgentModeCatalog {
        modes: vec![
            AgentModeEntry {
                id: "default".into(),
                label: "执行".into(),
                description: "允许 Claude 使用工具、修改文件并完成任务。".into(),
            },
            AgentModeEntry {
                id: "plan".into(),
                label: "Plan".into(),
                description: "只调查与规划；需要决策时显示结构化问题卡片。".into(),
            },
        ],
        current_mode: current.into(),
    }
}

/// One Task-tool subagent's current state (mirrors legacy `SubagentInfo`).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    pub status: String,
    pub can_message: bool,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// On-demand "查看执行详情" snapshot: the subagent metadata plus the chat
/// events belonging to its transcript.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct SubagentSnapshot {
    pub subagent: SubagentInfo,
    #[ts(type = "Array<Record<string, unknown>>")]
    pub events: Vec<serde_json::Value>,
    #[ts(type = "number")]
    pub ev_seq: i64,
}
