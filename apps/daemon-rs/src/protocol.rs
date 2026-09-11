use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const API_VERSION: u32 = 1;
pub const MAX_PAGE_ITEMS: usize = 200;
pub const MAX_PAGE_BYTES: usize = 1024 * 1024;
pub const CONTENT_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_EVENT_BYTES: usize = 16 * 1024;
pub const EVENT_RETENTION: i64 = 10_000;
pub const DATABASE_QUEUE_CAPACITY: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Codex,
    Claude,
    Opencode,
    Deepseek,
    Grok,
    Trae,
    Shell,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SessionLifecycle {
    Active,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Structured,
    Pty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Starting,
    Running,
    WaitingPermission,
    WaitingInput,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionHead {
    pub id: String,
    pub agent: AgentKind,
    pub kind: SessionKind,
    pub title: String,
    pub workspace: String,
    pub lifecycle: SessionLifecycle,
    pub status: SessionStatus,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "number")]
    pub revision: i64,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSession {
    pub agent: AgentKind,
    pub kind: SessionKind,
    pub title: String,
    pub workspace: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSession {
    #[ts(type = "number")]
    pub revision: i64,
    pub title: Option<String>,
    pub lifecycle: Option<SessionLifecycle>,
    pub status: Option<SessionStatus>,
}

#[derive(Debug, Default, Deserialize, Serialize, Clone, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
    pub lifecycle: Option<SessionLifecycle>,
    pub workspace: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub items: Vec<SessionHead>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    #[ts(type = "number")]
    pub total: i64,
    #[ts(type = "number")]
    pub latest_seq: i64,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    #[ts(type = "number")]
    pub total: i64,
    #[ts(type = "number")]
    pub active: i64,
    #[ts(type = "number")]
    pub archived: i64,
    #[ts(type = "number")]
    pub attention: i64,
    #[ts(type = "number")]
    pub latest_seq: i64,
}

#[derive(Debug, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHead {
    pub workspace: String,
    pub summary: SessionSummary,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePage {
    pub items: Vec<WorkspaceHead>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    #[ts(type = "number")]
    pub latest_seq: i64,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionLookup {
    pub ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionLookupResult {
    pub items: Vec<SessionHead>,
    pub missing_ids: Vec<String>,
    #[ts(type = "number")]
    pub latest_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub scope: String,
    #[ts(type = "number")]
    pub seq: i64,
    pub kind: String,
    pub entity_id: String,
    #[ts(type = "unknown")]
    pub data: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub items: Vec<ChangeEvent>,
    #[ts(type = "number")]
    pub next_seq: i64,
    #[ts(type = "number")]
    pub latest_seq: i64,
    #[ts(type = "number")]
    pub floor_seq: i64,
    pub has_more: bool,
    pub resync_required: bool,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub api_version: u32,
    pub backend: String,
    pub active_runtime_sessions: usize,
    pub database_queue_capacity: usize,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameSession {
    #[ts(type = "number")]
    pub revision: i64,
    pub title: String,
}

#[derive(Debug, Default, Deserialize, Serialize, Clone, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventQuery {
    pub scope: String,
    #[ts(type = "number | null")]
    pub after_seq: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResyncRequired {
    pub scope: String,
    #[ts(type = "number")]
    pub latest_seq: i64,
    #[ts(type = "number")]
    pub floor_seq: i64,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentHead {
    pub id: String,
    #[ts(type = "number")]
    pub bytes: i64,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContentPage {
    pub items: Vec<ContentHead>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

pub fn typescript() -> String {
    let config = ts_rs::Config::default();
    let declarations = [
        AgentKind::decl(&config),
        SessionKind::decl(&config),
        SessionLifecycle::decl(&config),
        SessionStatus::decl(&config),
        SessionHead::decl(&config),
        CreateSession::decl(&config),
        UpdateSession::decl(&config),
        SessionQuery::decl(&config),
        SessionPage::decl(&config),
        SessionSummary::decl(&config),
        WorkspaceQuery::decl(&config),
        WorkspaceHead::decl(&config),
        WorkspacePage::decl(&config),
        SessionLookup::decl(&config),
        SessionLookupResult::decl(&config),
        ChangeEvent::decl(&config),
        EventPage::decl(&config),
        Health::decl(&config),
        RenameSession::decl(&config),
        EventQuery::decl(&config),
        ResyncRequired::decl(&config),
        ContentHead::decl(&config),
        ContentPage::decl(&config),
        crate::error::ErrorBody::decl(&config),
    ];
    declarations
        .into_iter()
        .map(|value| format!("export {value}\n"))
        .collect()
}
