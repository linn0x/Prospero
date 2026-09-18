use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::{AgentKind, Run, SessionHead, Task, WorktreeAsset, WorktreeInspection};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeInput {
    pub id: String,
    pub title: Option<String>,
    pub fork: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSessionCreate {
    pub agent: AgentKind,
    pub title: String,
    pub workspace: String,
    pub auto_approve: bool,
    pub mode: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub agent_preset: Option<String>,
    pub account_id: Option<String>,
    pub resume: Option<ResumeInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumableConversation {
    pub id: String,
    pub agent: AgentKind,
    pub title: String,
    pub preview: Option<String>,
    pub cwd: String,
    pub created_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationSearchResult {
    pub agent: AgentKind,
    pub conversations: Vec<ResumableConversation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphNodeInputView {
    pub client_id: String,
    pub title: String,
    pub spec: String,
    pub skills: Vec<String>,
    pub deps: Vec<String>,
    pub parent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRunGraphView {
    pub objective: String,
    pub nodes: Vec<GraphNodeInputView>,
    pub coordinator_session_id: Option<String>,
    pub operation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyTaskGraphView {
    pub run_id: String,
    pub base_revision: i64,
    pub nodes: Vec<GraphNodeInputView>,
    pub delete_task_ids: Vec<String>,
    pub operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphMutationResultView {
    pub run: Run,
    pub tasks: Vec<Task>,
    pub id_map: HashMap<String, String>,
    pub deleted_task_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectWorktreeView {
    pub target_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupWorktreeView {
    pub target_ref: Option<String>,
    pub confirm: bool,
    pub delete_branch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCleanupResultView {
    pub asset: WorktreeAsset,
    pub inspection: WorktreeInspection,
    pub branch_deleted: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillView {
    pub name: String,
    pub description: String,
    pub path: String,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SkillListView {
    pub items: Vec<SkillView>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowView {
    pub label: String,
    pub utilization: f64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAccountView {
    pub agent: AgentKind,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub source: Option<String>,
    pub available: bool,
    pub subscription: Option<String>,
    pub cost_usd: Option<f64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub lifetime_tokens: Option<i64>,
    pub credits_unlimited: Option<bool>,
    pub credits_balance: Option<String>,
    pub spend_limit: Option<String>,
    pub spend_used: Option<String>,
    pub spend_remaining_percent: Option<f64>,
    pub windows: Vec<UsageWindowView>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageResultView {
    #[serde(rename = "type")]
    pub kind: String,
    pub sid: Option<String>,
    pub available: bool,
    pub subscription: Option<String>,
    pub cost_usd: Option<f64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub lifetime_tokens: Option<i64>,
    pub credits_unlimited: Option<bool>,
    pub credits_balance: Option<String>,
    pub spend_limit: Option<String>,
    pub spend_used: Option<String>,
    pub spend_remaining_percent: Option<f64>,
    pub windows: Vec<UsageWindowView>,
    pub reason: Option<String>,
    pub accounts: Option<Vec<UsageAccountView>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModeEntryView {
    pub id: String,
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModeCatalogView {
    pub modes: Vec<AgentModeEntryView>,
    pub current_mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelEntryView {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub supported_efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelCatalogView {
    pub models: Vec<AgentModelEntryView>,
    pub current_model: Option<String>,
    pub current_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessageView {
    pub id: String,
    pub text: String,
    pub kind: String,
    pub created_at: i64,
    pub attachment_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentQueueView {
    pub session_id: String,
    pub items: Vec<QueuedMessageView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAgentControlsView {
    pub session_id: String,
    pub approval_policy: String,
    pub compact: bool,
    pub model: bool,
    pub mode: bool,
    pub current_model: Option<String>,
    pub current_effort: Option<String>,
    pub current_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentControlsProjectionView {
    pub controls: Vec<SessionAgentControlsView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledAgentTaskKind {
    Cron,
    Heartbeat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ScheduledAgentTaskStatus {
    Enabled,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledAgentTask {
    pub version: u8,
    pub id: String,
    pub kind: ScheduledAgentTaskKind,
    pub name: String,
    pub prompt: String,
    pub status: ScheduledAgentTaskStatus,
    pub rrule: String,
    pub agent: AgentKind,
    pub approval_policy: String,
    pub cwd: String,
    pub cwds: Vec<String>,
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub mode: Option<String>,
    pub target_thread_id: Option<String>,
    pub last_session_id: Option<String>,
    pub last_run_at: Option<i64>,
    pub next_run_at: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunResult {
    pub task: ScheduledAgentTask,
    pub session: SessionHead,
    pub queued: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleCreateRequest {
    pub name: String,
    pub prompt: String,
    pub rrule: String,
    pub agent: AgentKind,
    pub approval_policy: String,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleUpdateRequest {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub rrule: String,
    pub agent: AgentKind,
    pub approval_policy: String,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDeleted {
    pub deleted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginServiceMode {
    Manual,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginServiceHealth {
    Unknown,
    Healthy,
    Unhealthy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginServiceStatus {
    Stopped,
    Starting,
    Running,
    Exited,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPluginService {
    pub id: String,
    pub mode: PluginServiceMode,
    pub command: Vec<String>,
    pub cwd: String,
    pub env_keys: Vec<String>,
    pub port_env: String,
    pub health_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicProsperoPlugin {
    pub name: String,
    pub version: Option<String>,
    pub root: String,
    pub skills_root: Option<String>,
    pub agents_root: Option<String>,
    pub runtime_root: Option<String>,
    pub bootstrap: Option<String>,
    pub services: Vec<PublicPluginService>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiscoveryError {
    pub root: String,
    pub manifest_path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPluginDiscoveryResult {
    pub items: Vec<PublicProsperoPlugin>,
    pub errors: Vec<PluginDiscoveryError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceLogFiles {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceView {
    pub plugin_id: String,
    pub service_id: String,
    pub mode: PluginServiceMode,
    pub status: PluginServiceStatus,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    pub started_at: Option<i64>,
    pub updated_at: i64,
    pub last_exit: Option<PluginServiceExit>,
    pub last_error: Option<String>,
    pub health: PluginServiceHealth,
    pub health_checked_at: Option<i64>,
    pub health_error: Option<String>,
    pub config_key: String,
    pub configured: bool,
    pub plugin_root: Option<String>,
    pub command: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub log_files: PluginServiceLogFiles,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceList {
    pub items: Vec<PluginServiceView>,
    pub errors: Vec<PluginDiscoveryError>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub agent: AgentKind,
    pub name: String,
    pub managed: bool,
    pub is_default: bool,
    pub status: String,
    pub capabilities: Value,
    pub api_profile: Option<Value>,
    pub model_source: Option<ModelSourceBindingView>,
    pub engine: Option<String>,
    pub api_validation: Option<Value>,
    pub api_engine_validation: Option<Value>,
    pub model_capability_support: Option<Value>,
    pub auth_method: Option<String>,
    pub detail: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub active_sessions: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountListResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub action: String,
    pub ok: bool,
    pub accounts: Vec<AccountView>,
    pub account_id: Option<String>,
    pub session_id: Option<String>,
    pub validation: Option<Value>,
    pub engine_validation: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSourceBindingView {
    pub source_id: String,
    pub route_id: String,
    pub revision: i64,
    pub source_name: String,
    pub route_name: String,
    pub legacy: bool,
    pub current: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSourceView {
    pub id: String,
    pub name: String,
    pub revision: i64,
    pub enabled: bool,
    pub endpoints: Vec<Value>,
    pub credentials: Vec<Value>,
    pub routes: Vec<Value>,
    pub default_route_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSourceResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub ok: bool,
    pub sources: Option<Vec<ModelSourceView>>,
    pub models: Option<Vec<Value>>,
    pub migrations: Option<Vec<Value>>,
    pub skipped_accounts: Option<i64>,
    pub account_id: Option<String>,
    pub accounts: Option<Vec<AccountView>>,
    pub error: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub allow_shell: bool,
    pub allow_orchestration: bool,
    pub bound: bool,
    pub relay_ready: bool,
    pub created_at: i64,
    pub last_seen_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    pub items: Vec<DeviceView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingCreate {
    pub name: String,
    pub allow_shell: bool,
    pub allow_orchestration: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingCreated {
    pub device: DeviceView,
    pub uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRevoked {
    pub ok: bool,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayView {
    pub configured_url: Option<String>,
    pub effective_url: Option<String>,
    pub re_pair_required: bool,
    pub runtime: crate::RelayRuntimeStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayUpdate {
    pub enabled: Option<bool>,
    pub url: Option<String>,
    #[serde(default)]
    pub rotate_key: bool,
}
