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
    pub previous_cursor: Option<String>,
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
pub struct QuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// One AskUserQuestion entry, normalized from the Claude tool input.
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

/// Metadata-only reference to an inbound image. The bytes are delivered to
/// the CLI once and are never stored or re-served (matches desktop legacy).
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
    },
    PermissionRequest {
        request_id: String,
        tool: String,
        resolved: bool,
        /// Set when the approval belongs to a Task-tool subagent; the event
        /// still shows on the main timeline so it can be answered there.
        #[serde(skip_serializing_if = "Option::is_none")]
        subagent: Option<String>,
    },
    /// Structured AskUserQuestion request. The CLI blocks on the matching
    /// control_response until `question.respond` (or cancellation/interrupt).
    Question {
        request_id: String,
        questions: Vec<AgentQuestion>,
        resolved: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        subagent: Option<String>,
    },
    TurnEnd {
        finish: String,
    },
    /// Claude Task-tool subagent lifecycle card. Subagent-owned messages and
    /// tool calls stay off the main timeline (they carry `subagent_id` and are
    /// only readable through the subagent-events endpoint); this record is the
    /// single card the chat view folds by `subagent_id`.
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
    /// Internal: owner subagent for records hidden from the main timeline.
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
    /// Internal routing only: when set, the record belongs to a Task-tool
    /// subagent transcript and is hidden from the session's main timeline.
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
        MessageRole::decl(&config),
        ToolState::decl(&config),
        QuestionOption::decl(&config),
        AgentQuestion::decl(&config),
        MessageAttachment::decl(&config),
        TimelineBody::decl(&config),
        TimelineRecord::decl(&config),
        TimelineWrite::decl(&config),
        TimelineQuery::decl(&config),
        TimelinePage::decl(&config),
        TimelineLookupResult::decl(&config),
        TimelineTextQuery::decl(&config),
        TimelineTextPage::decl(&config),
        crate::terminal::CreateTerminal::decl(&config),
        crate::terminal::TerminalSize::decl(&config),
        crate::terminal::TerminalEvent::decl(&config),
        crate::terminal::TerminalQuery::decl(&config),
        crate::terminal::TerminalPage::decl(&config),
        crate::terminal::TerminalInput::decl(&config),
        crate::terminal::TerminalSnapshot::decl(&config),
        crate::agent::CreateAgentSession::decl(&config),
        crate::agent::ResumeInput::decl(&config),
        crate::agent::ResumableConversation::decl(&config),
        crate::agent::ConversationSearchResult::decl(&config),
        crate::agent::AttachmentChunk::decl(&config),
        crate::agent::LaunchModelInfo::decl(&config),
        crate::agent::LaunchModelCatalog::decl(&config),
        crate::agent::AgentModelSelection::decl(&config),
        crate::agent::AgentModelSelectionResult::decl(&config),
        crate::agent::AgentControlResult::decl(&config),
        crate::agent::AgentCompactRequest::decl(&config),
        crate::agent::ApprovalPolicySelection::decl(&config),
        crate::agent::AgentModelCatalog::decl(&config),
        crate::agent::SessionAgentControls::decl(&config),
        crate::agent::AgentControlsProjection::decl(&config),
        crate::agent::AttachmentInput::decl(&config),
        crate::agent::AgentSend::decl(&config),
        crate::agent::QueuedMessage::decl(&config),
        crate::agent::AgentQueue::decl(&config),
        crate::agent::AgentQueues::decl(&config),
        crate::agent::UsageWindow::decl(&config),
        crate::agent::UsageDailyBucket::decl(&config),
        crate::agent::UsageReport::decl(&config),
        crate::agent::UsageAccount::decl(&config),
        crate::agent::UsageResult::decl(&config),
        crate::agent::PermissionDecision::decl(&config),
        crate::agent::QuestionAnswer::decl(&config),
        crate::agent::QuestionDecision::decl(&config),
        crate::agent::AgentModeSelection::decl(&config),
        crate::agent::AgentModeCatalog::decl(&config),
        crate::agent::AgentModeEntry::decl(&config),
        crate::agent::SubagentInfo::decl(&config),
        crate::agent::SubagentSnapshot::decl(&config),
        crate::orchestration::RunStatus::decl(&config),
        crate::orchestration::TaskStatus::decl(&config),
        crate::orchestration::DispatchState::decl(&config),
        crate::orchestration::GateStatus::decl(&config),
        crate::orchestration::MessageType::decl(&config),
        crate::orchestration::Run::decl(&config),
        crate::orchestration::Task::decl(&config),
        crate::orchestration::Dispatch::decl(&config),
        crate::orchestration::Gate::decl(&config),
        crate::orchestration::OrchMessage::decl(&config),
        crate::orchestration::RunSnapshot::decl(&config),
        crate::orchestration::GraphNodeInput::decl(&config),
        crate::orchestration::CreateRunGraph::decl(&config),
        crate::orchestration::ApplyTaskGraph::decl(&config),
        crate::orchestration::GraphMutationResult::decl(&config),
        crate::orchestration::DispatchTask::decl(&config),
        crate::orchestration::SettleDispatch::decl(&config),
        crate::orchestration::AbandonDispatch::decl(&config),
        crate::orchestration::CompleteRun::decl(&config),
        crate::orchestration::AbandonRun::decl(&config),
        crate::orchestration::CancelTask::decl(&config),
        crate::orchestration::CreateGate::decl(&config),
        crate::orchestration::ResolveGate::decl(&config),
        crate::orchestration::PostMessage::decl(&config),
        crate::orchestration::MarkMessages::decl(&config),
        crate::orchestration::SettleOutcome::decl(&config),
        crate::orchestration::RecoveryReport::decl(&config),
        crate::orchestration::WorktreeAssetKind::decl(&config),
        crate::orchestration::WorktreeAssetState::decl(&config),
        crate::orchestration::WorktreeInspection::decl(&config),
        crate::orchestration::WorktreeCleanup::decl(&config),
        crate::orchestration::WorktreeAsset::decl(&config),
        crate::orchestration::WorktreeCleanupResult::decl(&config),
        crate::orchestration::CreateRun::decl(&config),
        crate::orchestration::CreateTask::decl(&config),
        crate::orchestration::DeleteRun::decl(&config),
        crate::orchestration::RunDeletionResult::decl(&config),
        crate::orchestration::StartWorker::decl(&config),
        crate::orchestration::StopWorker::decl(&config),
        crate::orchestration::WorkerStartOutcome::decl(&config),
        crate::orchestration::InspectWorktree::decl(&config),
        crate::orchestration::CleanupWorktree::decl(&config),
        crate::skills::Skill::decl(&config),
        crate::skills::SkillSuggestion::decl(&config),
        crate::accounts::AccountStatus::decl(&config),
        crate::accounts::AccountCapabilities::decl(&config),
        crate::accounts::ModelCapabilities::decl(&config),
        crate::accounts::ApiProfile::decl(&config),
        crate::accounts::probe::Check::decl(&config),
        crate::accounts::probe::ValidationChecks::decl(&config),
        crate::accounts::probe::EngineValidationChecks::decl(&config),
        crate::accounts::ApiValidation::decl(&config),
        crate::accounts::ApiEngineValidation::decl(&config),
        crate::accounts::NativeAccount::decl(&config),
        crate::accounts::AccountListResult::decl(&config),
        crate::accounts::models::CatalogModel::decl(&config),
        crate::accounts::models::FeatureError::decl(&config),
        crate::accounts::models::ModelsResult::decl(&config),
        crate::accounts::config::AccountConfigDocument::decl(&config),
        crate::accounts::config::AgentAccountConfig::decl(&config),
        crate::accounts::config::AccountConfigResult::decl(&config),
        crate::accounts::sources::SourceEndpoint::decl(&config),
        crate::accounts::sources::SourceCredentialInfo::decl(&config),
        crate::accounts::sources::SourceRoute::decl(&config),
        crate::accounts::sources::ModelSource::decl(&config),
        crate::accounts::sources::SourceBindingView::decl(&config),
        crate::accounts::sources::SourceMigrationAccount::decl(&config),
        crate::accounts::sources::SourceMigration::decl(&config),
        crate::accounts::sources::SourceResult::decl(&config),
        crate::project::FsEntry::decl(&config),
        crate::project::FsListing::decl(&config),
        crate::project::FsContent::decl(&config),
        crate::project::FsWritten::decl(&config),
        crate::project::FsChunk::decl(&config),
        crate::project::FsDone::decl(&config),
        crate::project::SearchMatch::decl(&config),
        crate::project::SearchResult::decl(&config),
        crate::project::ProjectSearchRequest::decl(&config),
        crate::project::WorkspaceSummaryResult::decl(&config),
        crate::project::GitFile::decl(&config),
        crate::project::GitStatusResult::decl(&config),
        crate::project::GitDiffResult::decl(&config),
        crate::project::GitHistoryEntry::decl(&config),
        crate::project::GitHistoryResult::decl(&config),
        crate::project::GitDone::decl(&config),
        crate::project::FsPathQuery::decl(&config),
        crate::project::FsChunkQuery::decl(&config),
        crate::project::GitDiffQuery::decl(&config),
        crate::project::FsWriteRequest::decl(&config),
        crate::project::FsPathRequest::decl(&config),
        crate::project::FsRenameRequest::decl(&config),
        crate::project::GitStageRequest::decl(&config),
        crate::project::GitCommitRequest::decl(&config),
        crate::project::FsPutRequest::decl(&config),
        crate::error::ErrorBody::decl(&config),
    ];
    let mut output: String = declarations
        .into_iter()
        .map(|value| format!("export {value}\n"))
        .collect();
    output.push_str(&crate::terminal::screen::width_tables());
    output
}
