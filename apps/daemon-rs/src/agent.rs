mod claude;
mod runtime;
mod store;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{Error, Result};

pub use runtime::Agents;
pub use store::PermissionMode;

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAgentSession {
    pub title: String,
    pub workspace: String,
    #[serde(default)]
    pub auto_approve: bool,
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
