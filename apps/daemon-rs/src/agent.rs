mod claude;
mod runtime;
mod store;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSend {
    pub text: String,
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
