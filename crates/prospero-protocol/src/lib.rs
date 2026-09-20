use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub mod management;
pub use management::*;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub busy_since: Option<i64>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "number")]
    pub revision: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSession {
    pub agent: AgentKind,
    pub kind: SessionKind,
    pub title: String,
    pub workspace: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub items: Vec<SessionHead>,
    pub next_cursor: Option<String>,
    pub previous_cursor: Option<String>,
    pub has_more: bool,
    #[ts(type = "number")]
    pub total: i64,
    #[ts(type = "number")]
    pub latest_seq: i64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    #[ts(type = "number")]
    pub revision: i64,
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

#[derive(Debug, Default, Deserialize, Serialize, Clone, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceQuery {
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHead {
    pub workspace: String,
    pub summary: SessionSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePage {
    pub items: Vec<WorkspaceHead>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    #[ts(type = "number")]
    pub latest_seq: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionLookup {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum RelayConnectionState {
    Disabled,
    Offline,
    Connecting,
    Syncing,
    Online,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayRuntimeDeviceStatus {
    #[ts(type = "number")]
    pub total: usize,
    #[ts(type = "number")]
    pub ready: usize,
    #[ts(type = "number")]
    pub needs_re_pair: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RelayRuntimeStatus {
    pub enabled: bool,
    pub state: RelayConnectionState,
    pub url: Option<String>,
    pub route_id: Option<String>,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | undefined")]
    pub last_connected_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub devices: RelayRuntimeDeviceStatus,
    #[serde(default, skip_serializing_if = "is_zero_usize")]
    #[ts(type = "number | undefined")]
    pub active_streams: usize,
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    #[ts(type = "number | undefined")]
    pub stream_failures: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_stream_error: Option<String>,
}

fn is_zero_usize(value: &usize) -> bool {
    *value == 0
}

fn is_zero_u64(value: &u64) -> bool {
    *value == 0
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub api_version: u32,
    pub backend: String,
    #[serde(default)]
    pub daemon_version: String,
    #[serde(default)]
    pub build_id: String,
    pub active_runtime_sessions: usize,
    pub database_queue_capacity: usize,
    #[serde(default)]
    pub database: DatabaseHealth,
    pub capabilities: Vec<String>,
    pub persistence: HealthPersistence,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<RelayRuntimeStatus>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHealth {
    pub alive: bool,
    pub queue_depth: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HealthPersistence {
    pub pty: bool,
    pub structured: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ToolState {
    Running,
    Success,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub patch: String,
    #[ts(type = "number")]
    pub additions: i64,
    #[ts(type = "number")]
    pub deletions: i64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    pub allow_other: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct MessageAttachment {
    pub id: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TimelineBody {
    Message {
        role: MessageRole,
        final_answer: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<MessageAttachment>,
    },
    Reasoning,
    Tool {
        name: String,
        state: ToolState,
        summary: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<FileDiff>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        has_more: bool,
    },
    PermissionRequest {
        request_id: String,
        tool: String,
        resolved: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        subagent: Option<String>,
    },
    Question {
        request_id: String,
        questions: Vec<AgentQuestion>,
        resolved: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        subagent: Option<String>,
    },
    TurnEnd {
        finish: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        diffs: Vec<FileDiff>,
    },
    Subagent {
        subagent_id: String,
        name: String,
        role: Option<String>,
        task: Option<String>,
        status: String,
        can_message: bool,
        summary: String,
        #[ts(type = "number")]
        created_at: i64,
        #[ts(type = "number")]
        updated_at: i64,
    },
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TimelineRecord {
    pub id: String,
    pub turn_id: String,
    #[ts(type = "number")]
    pub position: i64,
    #[ts(type = "number")]
    pub revision: i64,
    pub body: TimelineBody,
    pub preview: String,
    #[ts(type = "number")]
    pub bytes: i64,
    #[ts(type = "number")]
    pub generation: i64,
    pub truncated: bool,
    #[serde(skip)]
    #[ts(skip)]
    pub subagent_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineWrite {
    pub id: String,
    pub turn_id: String,
    #[ts(type = "number")]
    pub expected_revision: i64,
    pub body: TimelineBody,
    pub text: String,
    pub replace: bool,
    #[serde(skip)]
    #[ts(skip)]
    pub subagent_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineQuery {
    #[ts(type = "number | null")]
    pub before: Option<i64>,
    #[ts(type = "number | null")]
    pub after: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePage {
    pub items: Vec<TimelineRecord>,
    #[ts(type = "number | null")]
    pub older: Option<i64>,
    #[ts(type = "number | null")]
    pub newer: Option<i64>,
    #[ts(type = "number")]
    pub latest_position: i64,
    #[ts(type = "number")]
    pub revision: i64,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLookupResult {
    pub items: Vec<TimelineRecord>,
    #[ts(type = "number")]
    pub latest_position: i64,
    #[ts(type = "number")]
    pub revision: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimelineTextQuery {
    pub part: Option<u32>,
    #[ts(type = "number | null")]
    pub generation: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTextPage {
    pub text: String,
    pub part: u32,
    pub next_part: Option<u32>,
    pub previous_part: Option<u32>,
    #[ts(type = "number")]
    pub total_bytes: i64,
    #[ts(type = "number")]
    pub generation: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    pub fn is_valid(self) -> bool {
        (20..=500).contains(&self.cols) && (5..=300).contains(&self.rows)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTerminal {
    pub title: String,
    pub workspace: String,
    pub size: TerminalSize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TerminalEvent {
    Output { data_b64: String },
    Resize { size: TerminalSize },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalQuery {
    #[ts(type = "number | null")]
    pub after_seq: Option<i64>,
    pub wait_ms: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPage {
    pub initial_size: TerminalSize,
    #[ts(type = "number")]
    pub base_seq: i64,
    #[ts(type = "number")]
    pub next_seq: i64,
    #[ts(type = "number")]
    pub latest_seq: i64,
    #[ts(type = "number")]
    pub floor_seq: i64,
    pub events: Vec<TerminalEvent>,
    pub resync_required: bool,
    pub exited: bool,
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalInput {
    pub data_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    #[ts(type = "number")]
    pub seq: i64,
    pub size: TerminalSize,
    pub data_b64: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct AttachmentInput {
    pub mime_type: String,
    pub data_b64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSend {
    pub text: String,
    #[serde(default)]
    pub delivery: Option<String>,
    #[serde(default)]
    pub attachments: Vec<AttachmentInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionDecision {
    pub request_id: String,
    pub allow: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionAnswer {
    pub question_id: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionDecision {
    pub request_id: String,
    #[serde(default)]
    pub answers: Vec<QuestionAnswer>,
    #[serde(default)]
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub kind: String,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub mtime: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsListing {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    pub entries: Vec<FsEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsContent {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    pub content_b64: String,
    #[ts(type = "number")]
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsWritten {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    #[ts(type = "number")]
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsChunk {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    #[ts(type = "number")]
    pub offset: u64,
    pub data_b64: String,
    #[ts(type = "number")]
    pub total: u64,
    pub eof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsDone {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    pub op: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummaryResult {
    pub r#type: String,
    pub sid: String,
    pub request_id: String,
    pub branch: Option<String>,
    #[ts(type = "number | null")]
    pub size_bytes: Option<u64>,
    pub size_complete: bool,
    #[ts(type = "number")]
    pub checked_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub index: String,
    pub worktree: String,
    pub untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub r#type: String,
    pub sid: String,
    pub branch: Option<String>,
    #[ts(type = "number")]
    pub ahead: u32,
    #[ts(type = "number")]
    pub behind: u32,
    pub files: Vec<GitFile>,
    pub staged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    pub patch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryEntry {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryResult {
    pub r#type: String,
    pub sid: String,
    pub entries: Vec<GitHistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDone {
    pub r#type: String,
    pub sid: String,
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsPathQuery {
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsChunkQuery {
    pub path: String,
    #[ts(type = "number")]
    pub offset: u64,
    #[ts(type = "number")]
    pub length: u64,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffQuery {
    pub path: String,
    pub staged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    #[ts(type = "number")]
    pub line: usize,
    #[ts(type = "number")]
    pub column: usize,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    #[ts(type = "number")]
    pub scanned: usize,
    #[ts(type = "number")]
    pub skipped: usize,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSearchRequest {
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub path_filter: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsWriteRequest {
    pub path: String,
    pub content_b64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_new: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsPathRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsRenameRequest {
    pub path: String,
    pub to: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitStageRequest {
    pub paths: Vec<String>,
    pub unstage: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitRequest {
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsPutRequest {
    pub path: String,
    #[ts(type = "number")]
    pub offset: u64,
    pub data_b64: String,
    #[serde(rename = "final")]
    pub final_chunk: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Active,
    Completed,
    Abandoned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, Hash)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Pending,
    Dispatched,
    Blocked,
    Done,
    Failed,
    Cancelled,
}

impl TaskStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Dispatched => "dispatched",
            Self::Blocked => "blocked",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "dispatched" => Self::Dispatched,
            "blocked" => Self::Blocked,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum DispatchState {
    Starting,
    Running,
    Succeeded,
    Failed,
    Abandoned,
}

impl DispatchState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Abandoned => "abandoned",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "starting" => Self::Starting,
            "running" => Self::Running,
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            "abandoned" => Self::Abandoned,
            _ => return None,
        })
    }

    pub fn active(self) -> bool {
        matches!(self, Self::Starting | Self::Running)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Pending,
    Resolved,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AutomationState {
    Running,
    Paused,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AutomationWorkspace {
    Run,
    Current,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunAutomation {
    pub state: AutomationState,
    pub agent: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "string | undefined")]
    pub account_id: Option<String>,
    pub approval_policy: String,
    pub workspace: AutomationWorkspace,
    pub cwd: String,
    pub workspace_path: String,
    #[ts(type = "string | null")]
    pub branch: Option<String>,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "string | null")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub objective: String,
    pub status: RunStatus,
    pub coordinator_session_id: Option<String>,
    #[ts(type = "RunAutomation | null")]
    pub automation: Option<RunAutomation>,
    #[ts(type = "number")]
    pub graph_revision: i64,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub spec: String,
    pub skills: Vec<String>,
    pub deps: Vec<String>,
    pub parent_id: Option<String>,
    pub status: TaskStatus,
    pub result: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub session_id: String,
    pub state: DispatchState,
    pub outcome: Option<String>,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number | null")]
    pub settled_at: Option<i64>,
    #[ts(type = "string | null")]
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub question: String,
    pub options: Vec<String>,
    pub status: GateStatus,
    pub decision: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub resolved_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub run: Run,
    pub tasks: Vec<Task>,
    pub ready: Vec<String>,
    pub dispatches: Vec<Dispatch>,
    pub gates: Vec<Gate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeAssetKind {
    Run,
    Worker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeAssetState {
    Active,
    Preserved,
    Missing,
    Dirty,
    Unmerged,
    Equivalent,
    SafeToClean,
    Cleaned,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInspection {
    pub state: WorktreeAssetState,
    pub target_ref: String,
    #[ts(type = "number")]
    pub checked_at: i64,
    pub path_exists: bool,
    #[ts(type = "boolean | null")]
    pub registered: Option<bool>,
    #[ts(type = "boolean | null")]
    pub dirty: Option<bool>,
    #[ts(type = "string | null")]
    pub branch: Option<String>,
    #[ts(type = "number | null")]
    pub ahead_commit_count: Option<i64>,
    #[ts(type = "number | null")]
    pub equivalent_commit_count: Option<i64>,
    #[ts(type = "string | null")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCleanup {
    #[ts(type = "number")]
    pub removed_at: i64,
    pub branch_deleted: bool,
    #[ts(type = "string | null")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAsset {
    pub id: String,
    pub kind: WorktreeAssetKind,
    pub run_id: String,
    #[ts(type = "string | null")]
    pub task_id: Option<String>,
    #[ts(type = "string | null")]
    pub dispatch_id: Option<String>,
    pub repo: String,
    pub path: String,
    #[ts(type = "string | null")]
    pub branch: Option<String>,
    pub state: WorktreeAssetState,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "number | null")]
    pub run_deleted_at: Option<i64>,
    #[ts(type = "WorktreeInspection | null")]
    pub last_inspection: Option<WorktreeInspection>,
    #[ts(type = "WorktreeCleanup | null")]
    pub cleanup: Option<WorktreeCleanup>,
    #[ts(type = "string | null")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelTask {
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveGate {
    pub decision: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_dimensions_match_daemon_limits() {
        assert!(TerminalSize { cols: 20, rows: 5 }.is_valid());
        assert!(
            TerminalSize {
                cols: 500,
                rows: 300
            }
            .is_valid()
        );
        assert!(!TerminalSize { cols: 19, rows: 24 }.is_valid());
        assert!(
            !TerminalSize {
                cols: 80,
                rows: 301
            }
            .is_valid()
        );
    }
}
