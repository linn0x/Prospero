use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use prospero_protocol_rs::{
    AccountListResult, AgentControlsProjectionView, AgentModeCatalogView, AgentModelCatalogView,
    AgentQueueView, AgentSend, AgentSessionCreate, ApplyTaskGraphView, CancelTask,
    CleanupWorktreeView, ConversationSearchResult, CreateRunGraphView, CreateTerminal, EventPage,
    EventQuery, FsContent, FsListing, FsPathRequest, FsWriteRequest, FsWritten, GitCommitRequest,
    GitDiffResult, GitDone, GitHistoryResult, GitStageRequest, GitStatusResult,
    GraphMutationResultView, Health, InspectWorktreeView, ModelSourceResult, PairingCreate,
    PairingCreated, PermissionDecision, PluginServiceList, PluginServiceView,
    PublicPluginDiscoveryResult, QuestionDecision, RelayUpdate, RelayView, ResolveGate, Run,
    RunSnapshot, ScheduleCreateRequest, ScheduleDeleted, ScheduleRunResult, ScheduleUpdateRequest,
    ScheduledAgentTask, SessionHead, SessionLifecycle, SessionLookup, SessionLookupResult,
    SessionPage, SessionQuery, SessionSummary, SkillListView, TerminalInput, TerminalPage,
    TerminalQuery, TerminalSize, TerminalSnapshot, TimelinePage, TimelineQuery, TimelineTextPage,
    UsageResultView, WorkspacePage, WorkspaceQuery, WorktreeAsset, WorktreeCleanupResultView,
    WorktreeInspection,
};
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use url::Url;

const MAX_CONNECTION_BYTES: u64 = 4096;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(7);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("daemon connection file is unavailable")]
    ConnectionUnavailable,
    #[error("daemon connection file is not private")]
    InsecureConnectionFile,
    #[error("daemon connection file is invalid")]
    InvalidConnectionFile,
    #[error("daemon is not running")]
    DaemonNotRunning,
    #[error("daemon request timed out")]
    Timeout,
    #[error("cannot connect to the local Rust daemon")]
    Unavailable,
    #[error("daemon response exceeded the 2 MiB page limit")]
    ResponseTooLarge,
    #[error("daemon returned invalid JSON")]
    InvalidResponse,
    #[error("daemon request failed ({status}): {message}")]
    Api { status: StatusCode, message: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub api_version: u32,
    pub pid: u32,
    pub base_url: String,
    pub token: String,
}

#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    base_url: Url,
    token: String,
    pid: u32,
}

#[derive(Debug, Clone)]
pub enum DecodedTerminalEvent {
    Output(Vec<u8>),
    Resize(TerminalSize),
}

#[derive(Debug, Clone)]
pub struct DecodedTerminalPage {
    pub initial_size: TerminalSize,
    pub next_seq: i64,
    pub latest_seq: i64,
    pub floor_seq: i64,
    pub events: Vec<DecodedTerminalEvent>,
    pub resync_required: bool,
    pub exited: bool,
    pub exit_code: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct DecodedTerminalSnapshot {
    pub seq: i64,
    pub size: TerminalSize,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct DecodedFsContent {
    pub path: String,
    pub bytes: Vec<u8>,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
    pub version: String,
}

impl Client {
    pub fn from_home(home: &Path) -> Result<Self, Error> {
        let connection = read_connection(&home.join("connection.json"))?;
        Self::from_connection(connection)
    }

    pub fn from_connection(connection: Connection) -> Result<Self, Error> {
        if connection.api_version != prospero_protocol_rs::API_VERSION
            || connection.pid == 0
            || !valid_token(&connection.token)
            || !process_alive(connection.pid)
        {
            return Err(Error::InvalidConnectionFile);
        }
        let base_url =
            Url::parse(&connection.base_url).map_err(|_| Error::InvalidConnectionFile)?;
        if base_url.scheme() != "http"
            || !matches!(base_url.host_str(), Some("127.0.0.1") | Some("::1"))
            || base_url.username() != ""
            || base_url.password().is_some()
            || base_url.path() != "/"
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(Error::InvalidConnectionFile);
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .map_err(|_| Error::Unavailable)?;
        Ok(Self {
            http,
            base_url,
            token: connection.token,
            pid: connection.pid,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub async fn health(&self) -> Result<Health, Error> {
        self.get("v1/health", &[]).await
    }

    pub async fn create_agent(&self, input: &AgentSessionCreate) -> Result<SessionHead, Error> {
        self.post("v1/agent-sessions", input).await
    }

    pub async fn create_terminal(&self, input: &CreateTerminal) -> Result<SessionHead, Error> {
        self.post("v1/terminals", input).await
    }

    pub async fn conversations(
        &self,
        agent: prospero_protocol_rs::AgentKind,
        account_id: Option<String>,
        query: String,
        limit: usize,
    ) -> Result<ConversationSearchResult, Error> {
        if !matches!(
            agent,
            prospero_protocol_rs::AgentKind::Claude
                | prospero_protocol_rs::AgentKind::Codex
                | prospero_protocol_rs::AgentKind::Deepseek
        ) || !(1..=50).contains(&limit)
            || query.chars().count() > 300
            || query.chars().any(char::is_control)
        {
            return Err(Error::InvalidConnectionFile);
        }
        let params = optional_query([
            ("agent", Some(agent_name(agent).to_owned())),
            ("accountId", account_id),
            ("query", Some(query)),
            ("limit", Some(limit.to_string())),
        ]);
        self.get("v1/conversations", &params).await
    }

    pub async fn close_agent(&self, session_id: &str) -> Result<(), Error> {
        let session_id = record_id(session_id)?;
        let url = self
            .base_url
            .join(&format!("v1/agent-sessions/{session_id}"))
            .map_err(|_| Error::InvalidConnectionFile)?;
        require_ack(self.request(Method::DELETE, url).await?)
    }

    pub async fn close_terminal(&self, session_id: &str) -> Result<(), Error> {
        let session_id = record_id(session_id)?;
        let ack: Ack = self
            .post_empty(&format!("v1/terminals/{session_id}/close"))
            .await?;
        require_ack(ack)
    }

    pub async fn sessions(&self, query: SessionQuery) -> Result<SessionPage, Error> {
        let limit = query.limit.map(|value| value.to_string());
        let lifecycle = query.lifecycle.map(|value| match value {
            SessionLifecycle::Active => "active".to_owned(),
            SessionLifecycle::Archived => "archived".to_owned(),
        });
        let params = optional_query([
            ("cursor", query.cursor),
            ("limit", limit),
            ("lifecycle", lifecycle),
            ("workspace", query.workspace),
            ("text", query.text),
        ]);
        self.get("v1/sessions", &params).await
    }

    pub async fn lookup_sessions(&self, ids: Vec<String>) -> Result<SessionLookupResult, Error> {
        if ids.len() > 500 {
            return Err(Error::InvalidConnectionFile);
        }
        let mut result = SessionLookupResult {
            items: Vec::new(),
            missing_ids: Vec::new(),
            latest_seq: 0,
        };
        for chunk in ids.chunks(100) {
            let page: SessionLookupResult = self
                .post(
                    "v1/sessions/lookup",
                    &SessionLookup {
                        ids: chunk.to_vec(),
                    },
                )
                .await?;
            result.items.extend(page.items);
            result.missing_ids.extend(page.missing_ids);
            result.latest_seq = result.latest_seq.max(page.latest_seq);
        }
        Ok(result)
    }

    pub async fn summary(&self, workspace: Option<String>) -> Result<SessionSummary, Error> {
        self.get(
            "v1/sessions/summary",
            &optional_query([("workspace", workspace)]),
        )
        .await
    }

    pub async fn workspaces(&self, query: WorkspaceQuery) -> Result<WorkspacePage, Error> {
        let params = optional_query([
            ("cursor", query.cursor),
            ("limit", query.limit.map(|value| value.to_string())),
        ]);
        self.get("v1/workspaces", &params).await
    }

    pub async fn events(&self, query: EventQuery) -> Result<EventPage, Error> {
        let params = optional_query([
            ("scope", Some(query.scope)),
            ("afterSeq", query.after_seq.map(|value| value.to_string())),
            ("limit", query.limit.map(|value| value.to_string())),
        ]);
        self.get("v1/events", &params).await
    }

    pub async fn timeline(
        &self,
        session_id: &str,
        query: TimelineQuery,
    ) -> Result<TimelinePage, Error> {
        let session_id = record_id(session_id)?;
        let params = optional_query([
            ("before", query.before.map(|value| value.to_string())),
            ("after", query.after.map(|value| value.to_string())),
            ("limit", query.limit.map(|value| value.to_string())),
        ]);
        self.get(&format!("v1/sessions/{session_id}/timeline"), &params)
            .await
    }

    pub async fn timeline_text(
        &self,
        session_id: &str,
        record_id_value: &str,
        part: Option<u32>,
        generation: Option<i64>,
    ) -> Result<TimelineTextPage, Error> {
        let session_id = record_id(session_id)?;
        let record_id_value = record_id(record_id_value)?;
        let params = optional_query([
            ("part", part.map(|value| value.to_string())),
            ("generation", generation.map(|value| value.to_string())),
        ]);
        self.get(
            &format!("v1/sessions/{session_id}/timeline/{record_id_value}/body"),
            &params,
        )
        .await
    }

    pub async fn terminal_snapshot(
        &self,
        session_id: &str,
    ) -> Result<Option<TerminalSnapshot>, Error> {
        let session_id = record_id(session_id)?;
        self.get(&format!("v1/terminals/{session_id}/snapshot"), &[])
            .await
    }

    pub async fn terminal_snapshot_decoded(
        &self,
        session_id: &str,
    ) -> Result<Option<DecodedTerminalSnapshot>, Error> {
        self.terminal_snapshot(session_id)
            .await?
            .map(|snapshot| {
                Ok(DecodedTerminalSnapshot {
                    seq: snapshot.seq,
                    size: snapshot.size,
                    bytes: STANDARD
                        .decode(snapshot.data_b64)
                        .map_err(|_| Error::InvalidResponse)?,
                })
            })
            .transpose()
    }

    pub async fn terminal_output(
        &self,
        session_id: &str,
        query: TerminalQuery,
    ) -> Result<TerminalPage, Error> {
        let session_id = record_id(session_id)?;
        let params = optional_query([
            ("afterSeq", query.after_seq.map(|value| value.to_string())),
            ("waitMs", query.wait_ms.map(|value| value.to_string())),
        ]);
        self.get(&format!("v1/terminals/{session_id}/output"), &params)
            .await
    }

    pub async fn terminal_output_decoded(
        &self,
        session_id: &str,
        query: TerminalQuery,
    ) -> Result<DecodedTerminalPage, Error> {
        let page = self.terminal_output(session_id, query).await?;
        let events = page
            .events
            .into_iter()
            .map(|event| match event {
                prospero_protocol_rs::TerminalEvent::Output { data_b64 } => STANDARD
                    .decode(data_b64)
                    .map(DecodedTerminalEvent::Output)
                    .map_err(|_| Error::InvalidResponse),
                prospero_protocol_rs::TerminalEvent::Resize { size } => {
                    Ok(DecodedTerminalEvent::Resize(size))
                }
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(DecodedTerminalPage {
            initial_size: page.initial_size,
            next_seq: page.next_seq,
            latest_seq: page.latest_seq,
            floor_seq: page.floor_seq,
            events,
            resync_required: page.resync_required,
            exited: page.exited,
            exit_code: page.exit_code,
        })
    }

    pub async fn terminal_input(&self, session_id: &str, bytes: &[u8]) -> Result<(), Error> {
        if bytes.is_empty() || bytes.len() > 8192 {
            return Err(Error::InvalidConnectionFile);
        }
        let session_id = record_id(session_id)?;
        let ack: Ack = self
            .post(
                &format!("v1/terminals/{session_id}/input"),
                &TerminalInput {
                    data_b64: STANDARD.encode(bytes),
                },
            )
            .await?;
        if !ack.ok {
            return Err(Error::InvalidResponse);
        }
        Ok(())
    }

    pub async fn terminal_resize(&self, session_id: &str, size: TerminalSize) -> Result<(), Error> {
        if !size.is_valid() {
            return Err(Error::InvalidConnectionFile);
        }
        let session_id = record_id(session_id)?;
        let ack: Ack = self
            .post(&format!("v1/terminals/{session_id}/resize"), &size)
            .await?;
        if !ack.ok {
            return Err(Error::InvalidResponse);
        }
        Ok(())
    }

    pub async fn agent_send(&self, session_id: &str, input: &AgentSend) -> Result<(), Error> {
        let session_id = record_id(session_id)?;
        let ack: Ack = self
            .post(&format!("v1/agent-sessions/{session_id}/send"), input)
            .await?;
        require_ack(ack)
    }

    pub async fn agent_interrupt(&self, session_id: &str) -> Result<(), Error> {
        let session_id = record_id(session_id)?;
        let ack: Ack = self
            .post_empty(&format!("v1/agent-sessions/{session_id}/interrupt"))
            .await?;
        require_ack(ack)
    }

    pub async fn agent_permission(
        &self,
        session_id: &str,
        decision: &PermissionDecision,
    ) -> Result<(), Error> {
        let session_id = record_id(session_id)?;
        let ack: Ack = self
            .post(
                &format!("v1/agent-sessions/{session_id}/permission"),
                decision,
            )
            .await?;
        require_ack(ack)
    }

    pub async fn agent_question(
        &self,
        session_id: &str,
        decision: &QuestionDecision,
    ) -> Result<(), Error> {
        let session_id = record_id(session_id)?;
        let ack: Ack = self
            .post(
                &format!("v1/agent-sessions/{session_id}/question"),
                decision,
            )
            .await?;
        require_ack(ack)
    }

    pub async fn agent_modes(&self, session_id: &str) -> Result<AgentModeCatalogView, Error> {
        let session_id = record_id(session_id)?;
        self.get(&format!("v1/agent-sessions/{session_id}/modes"), &[])
            .await
    }

    pub async fn agent_controls(&self) -> Result<AgentControlsProjectionView, Error> {
        self.get("v1/agent-sessions/controls", &[]).await
    }

    pub async fn set_agent_mode(&self, session_id: &str, mode: &str) -> Result<String, Error> {
        let session_id = record_id(session_id)?;
        let value: serde_json::Value = self
            .post(
                &format!("v1/agent-sessions/{session_id}/modes"),
                &serde_json::json!({"mode": mode}),
            )
            .await?;
        value
            .get("currentMode")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or(Error::InvalidResponse)
    }

    pub async fn agent_models(&self, session_id: &str) -> Result<AgentModelCatalogView, Error> {
        let session_id = record_id(session_id)?;
        self.get(&format!("v1/agent-sessions/{session_id}/models"), &[])
            .await
    }

    pub async fn set_agent_model(
        &self,
        session_id: &str,
        model: String,
        effort: Option<String>,
    ) -> Result<serde_json::Value, Error> {
        let session_id = record_id(session_id)?;
        self.post(
            &format!("v1/agent-sessions/{session_id}/models"),
            &serde_json::json!({"model": model, "effort": effort}),
        )
        .await
    }

    pub async fn set_approval_policy(&self, session_id: &str, policy: &str) -> Result<(), Error> {
        let session_id = record_id(session_id)?;
        let ack: Ack = self
            .post(
                &format!("v1/agent-sessions/{session_id}/approval-policy"),
                &serde_json::json!({"policy": policy}),
            )
            .await?;
        require_ack(ack)
    }

    pub async fn compact_agent(&self, session_id: &str) -> Result<(), Error> {
        let session_id = record_id(session_id)?;
        let value: serde_json::Value = self
            .post(
                &format!("v1/agent-sessions/{session_id}/compact"),
                &serde_json::json!({"requestId": uuid::Uuid::new_v4().to_string()}),
            )
            .await?;
        if value.get("ok") == Some(&serde_json::Value::Bool(true)) {
            Ok(())
        } else {
            Err(Error::InvalidResponse)
        }
    }

    pub async fn agent_queue(&self, session_id: &str) -> Result<AgentQueueView, Error> {
        let session_id = record_id(session_id)?;
        self.get(&format!("v1/agent-sessions/{session_id}/queue"), &[])
            .await
    }

    pub async fn agent_queue_action(
        &self,
        session_id: &str,
        queue_id: &str,
        action: &str,
    ) -> Result<(), Error> {
        let session_id = record_id(session_id)?;
        let queue_id = record_id(queue_id)?;
        if !matches!(action, "remove" | "guide") {
            return Err(Error::InvalidConnectionFile);
        }
        let ack: Ack = self
            .post_empty(&format!(
                "v1/agent-sessions/{session_id}/queue/{queue_id}/{action}"
            ))
            .await?;
        require_ack(ack)
    }

    pub async fn fs_list(&self, session_id: &str, path: &str) -> Result<FsListing, Error> {
        let session_id = record_id(session_id)?;
        self.get(
            &format!("v1/sessions/{session_id}/fs/list"),
            &[("path".to_owned(), path.to_owned())],
        )
        .await
    }

    pub async fn fs_read(&self, session_id: &str, path: &str) -> Result<FsContent, Error> {
        let session_id = record_id(session_id)?;
        self.get(
            &format!("v1/sessions/{session_id}/fs/read"),
            &[("path".to_owned(), path.to_owned())],
        )
        .await
    }

    pub async fn fs_read_decoded(
        &self,
        session_id: &str,
        path: &str,
    ) -> Result<DecodedFsContent, Error> {
        let content = self.fs_read(session_id, path).await?;
        let bytes = STANDARD
            .decode(content.content_b64)
            .map_err(|_| Error::InvalidResponse)?;
        let version = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(DecodedFsContent {
            path: content.path,
            bytes,
            size: content.size,
            truncated: content.truncated,
            binary: content.binary,
            version,
        })
    }

    pub async fn fs_write(
        &self,
        session_id: &str,
        path: String,
        bytes: &[u8],
        expected_version: Option<String>,
        create_new: bool,
    ) -> Result<FsWritten, Error> {
        if bytes.len() > 1024 * 1024 {
            return Err(Error::InvalidConnectionFile);
        }
        let session_id = record_id(session_id)?;
        self.post(
            &format!("v1/sessions/{session_id}/fs/write"),
            &FsWriteRequest {
                path,
                content_b64: STANDARD.encode(bytes),
                create_new: create_new.then_some(true),
                expected_version,
            },
        )
        .await
    }

    pub async fn git_status(&self, session_id: &str) -> Result<GitStatusResult, Error> {
        let session_id = record_id(session_id)?;
        self.get(&format!("v1/sessions/{session_id}/git/status"), &[])
            .await
    }

    pub async fn git_diff(
        &self,
        session_id: &str,
        path: &str,
        staged: bool,
    ) -> Result<GitDiffResult, Error> {
        let session_id = record_id(session_id)?;
        self.get(
            &format!("v1/sessions/{session_id}/git/diff"),
            &[
                ("path".to_owned(), path.to_owned()),
                ("staged".to_owned(), staged.to_string()),
            ],
        )
        .await
    }

    pub async fn git_history(&self, session_id: &str) -> Result<GitHistoryResult, Error> {
        let session_id = record_id(session_id)?;
        self.get(&format!("v1/sessions/{session_id}/git/history"), &[])
            .await
    }

    pub async fn git_stage(
        &self,
        session_id: &str,
        paths: Vec<String>,
        unstage: bool,
    ) -> Result<GitDone, Error> {
        let session_id = record_id(session_id)?;
        self.post(
            &format!("v1/sessions/{session_id}/git/stage"),
            &GitStageRequest { paths, unstage },
        )
        .await
    }

    pub async fn git_discard(&self, session_id: &str, path: String) -> Result<GitDone, Error> {
        let session_id = record_id(session_id)?;
        self.post(
            &format!("v1/sessions/{session_id}/git/discard"),
            &FsPathRequest { path },
        )
        .await
    }

    pub async fn git_commit(&self, session_id: &str, message: String) -> Result<GitDone, Error> {
        let session_id = record_id(session_id)?;
        self.post(
            &format!("v1/sessions/{session_id}/git/commit"),
            &GitCommitRequest { message },
        )
        .await
    }

    pub async fn runs(&self) -> Result<Vec<Run>, Error> {
        self.get("v1/runs", &[]).await
    }

    pub async fn create_run_graph(
        &self,
        input: &CreateRunGraphView,
    ) -> Result<GraphMutationResultView, Error> {
        self.post("v1/runs/graph", input).await
    }

    pub async fn apply_task_graph(
        &self,
        input: &ApplyTaskGraphView,
    ) -> Result<GraphMutationResultView, Error> {
        self.post("v1/runs/graph/apply", input).await
    }

    pub async fn run_snapshot(&self, run_id: &str) -> Result<RunSnapshot, Error> {
        let run_id = record_id(run_id)?;
        self.get(&format!("v1/runs/{run_id}"), &[]).await
    }

    pub async fn worktrees(&self, run_id: &str) -> Result<Vec<WorktreeAsset>, Error> {
        let run_id = record_id(run_id)?;
        self.get("v1/worktrees", &[("runId".to_owned(), run_id.to_owned())])
            .await
    }

    pub async fn inspect_worktree(
        &self,
        asset_id: &str,
        target_ref: Option<String>,
    ) -> Result<WorktreeInspection, Error> {
        let asset_id = record_id(asset_id)?;
        self.post(
            &format!("v1/worktrees/{asset_id}/inspect"),
            &InspectWorktreeView { target_ref },
        )
        .await
    }

    pub async fn cleanup_worktree(
        &self,
        asset_id: &str,
        target_ref: Option<String>,
        delete_branch: bool,
    ) -> Result<WorktreeCleanupResultView, Error> {
        let asset_id = record_id(asset_id)?;
        self.post(
            &format!("v1/worktrees/{asset_id}/cleanup"),
            &CleanupWorktreeView {
                target_ref,
                confirm: true,
                delete_branch,
            },
        )
        .await
    }

    pub async fn skills(&self, cwd: String) -> Result<SkillListView, Error> {
        if cwd.trim().is_empty() || cwd.chars().count() > 4096 || !Path::new(&cwd).is_absolute() {
            return Err(Error::InvalidConnectionFile);
        }
        self.get("v1/skills", &[("cwd".into(), cwd)]).await
    }

    pub async fn usage(&self, session_id: Option<String>) -> Result<UsageResultView, Error> {
        if let Some(id) = session_id.as_deref() {
            record_id(id)?;
        }
        self.get("v1/usage", &optional_query([("sid", session_id)]))
            .await
    }

    pub async fn pause_automation(&self, run_id: &str) -> Result<Run, Error> {
        let run_id = record_id(run_id)?;
        self.post_empty(&format!("v1/runs/{run_id}/automation/pause"))
            .await
    }

    pub async fn retry_task(&self, task_id: &str) -> Result<prospero_protocol_rs::Task, Error> {
        let task_id = record_id(task_id)?;
        self.post_empty(&format!("v1/tasks/{task_id}/retry")).await
    }

    pub async fn cancel_task(&self, task_id: &str) -> Result<prospero_protocol_rs::Task, Error> {
        let task_id = record_id(task_id)?;
        self.post(
            &format!("v1/tasks/{task_id}/cancel"),
            &CancelTask {
                reason: Some("Cancelled from native desktop".into()),
            },
        )
        .await
    }

    pub async fn resolve_gate(
        &self,
        gate_id: &str,
        decision: String,
    ) -> Result<prospero_protocol_rs::Gate, Error> {
        let gate_id = record_id(gate_id)?;
        self.post(
            &format!("v1/gates/{gate_id}/resolve"),
            &ResolveGate { decision },
        )
        .await
    }

    pub async fn schedules(&self) -> Result<Vec<ScheduledAgentTask>, Error> {
        self.get("v1/schedules", &[]).await
    }

    pub async fn create_schedule(
        &self,
        input: &ScheduleCreateRequest,
    ) -> Result<ScheduledAgentTask, Error> {
        self.post("v1/schedules", input).await
    }

    pub async fn update_schedule(
        &self,
        input: &ScheduleUpdateRequest,
    ) -> Result<ScheduledAgentTask, Error> {
        let id = schedule_id(&input.id)?;
        let url = self
            .base_url
            .join(&format!("v1/schedules/{id}"))
            .map_err(|_| Error::InvalidConnectionFile)?;
        self.request_builder(self.http.patch(url).json(input)).await
    }

    pub async fn delete_schedule(&self, id: &str) -> Result<ScheduleDeleted, Error> {
        let id = schedule_id(id)?;
        let url = self
            .base_url
            .join(&format!("v1/schedules/{id}"))
            .map_err(|_| Error::InvalidConnectionFile)?;
        self.request(Method::DELETE, url).await
    }

    pub async fn pause_schedule(&self, id: &str) -> Result<ScheduledAgentTask, Error> {
        let id = schedule_id(id)?;
        self.post_empty(&format!("v1/schedules/{id}/pause")).await
    }

    pub async fn resume_schedule(&self, id: &str) -> Result<ScheduledAgentTask, Error> {
        let id = schedule_id(id)?;
        self.post_empty(&format!("v1/schedules/{id}/resume")).await
    }

    pub async fn run_schedule(&self, id: &str) -> Result<ScheduleRunResult, Error> {
        let id = schedule_id(id)?;
        self.post_empty(&format!("v1/schedules/{id}/run")).await
    }

    pub async fn plugins(&self) -> Result<PublicPluginDiscoveryResult, Error> {
        self.get("v1/plugins", &[]).await
    }

    pub async fn plugin_services(&self) -> Result<PluginServiceList, Error> {
        self.get("v1/plugin-services", &[]).await
    }

    pub async fn plugin_service_action(
        &self,
        plugin: &str,
        service: &str,
        action: &str,
    ) -> Result<PluginServiceView, Error> {
        let plugin = plugin_id(plugin)?;
        let service = plugin_id(service)?;
        if !matches!(action, "start" | "stop" | "restart" | "health") {
            return Err(Error::InvalidConnectionFile);
        }
        let path = format!("v1/plugin/{plugin}/service/{service}/{action}");
        if action == "health" {
            self.get(&path, &[]).await
        } else {
            self.post_empty(&path).await
        }
    }

    pub async fn accounts(&self) -> Result<AccountListResult, Error> {
        self.account_action(serde_json::json!({"type": "agent.accounts.list"}))
            .await
    }

    pub async fn account_action(
        &self,
        mut action: serde_json::Value,
    ) -> Result<AccountListResult, Error> {
        let object = action.as_object_mut().ok_or(Error::InvalidConnectionFile)?;
        object.insert(
            "requestId".into(),
            serde_json::Value::String(uuid::Uuid::new_v4().to_string()),
        );
        self.post("v1/accounts", &action).await
    }

    pub async fn model_sources(&self) -> Result<ModelSourceResult, Error> {
        self.model_source_action(serde_json::json!({"kind": "list"}))
            .await
    }

    pub async fn model_source_action(
        &self,
        action: serde_json::Value,
    ) -> Result<ModelSourceResult, Error> {
        self.post(
            "v1/model-sources",
            &serde_json::json!({
                "type": "model.source.action",
                "requestId": uuid::Uuid::new_v4().to_string(),
                "action": action,
            }),
        )
        .await
    }

    pub async fn devices(&self) -> Result<prospero_protocol_rs::DeviceList, Error> {
        self.get("v1/devices", &[]).await
    }

    pub async fn create_pairing(&self, input: &PairingCreate) -> Result<PairingCreated, Error> {
        self.post("v1/pairings", input).await
    }

    pub async fn revoke_device(
        &self,
        id: &str,
    ) -> Result<prospero_protocol_rs::DeviceRevoked, Error> {
        let id = remote_id(id)?;
        let url = self
            .base_url
            .join(&format!("v1/devices/{id}"))
            .map_err(|_| Error::InvalidConnectionFile)?;
        self.request(Method::DELETE, url).await
    }

    pub async fn relay(&self) -> Result<RelayView, Error> {
        self.get("v1/relay", &[]).await
    }

    pub async fn update_relay(&self, input: &RelayUpdate) -> Result<RelayView, Error> {
        let url = self
            .base_url
            .join("v1/relay")
            .map_err(|_| Error::InvalidConnectionFile)?;
        self.request_builder(self.http.patch(url).json(input)).await
    }

    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(String, String)],
    ) -> Result<T, Error> {
        let mut url = self
            .base_url
            .join(path)
            .map_err(|_| Error::InvalidConnectionFile)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        self.request(Method::GET, url).await
    }

    async fn request<T: DeserializeOwned>(&self, method: Method, url: Url) -> Result<T, Error> {
        self.request_builder(self.http.request(method, url)).await
    }

    async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl serde::Serialize,
    ) -> Result<T, Error> {
        let url = self
            .base_url
            .join(path)
            .map_err(|_| Error::InvalidConnectionFile)?;
        self.request_builder(self.http.post(url).json(body)).await
    }

    async fn post_empty<T: DeserializeOwned>(&self, path: &str) -> Result<T, Error> {
        let url = self
            .base_url
            .join(path)
            .map_err(|_| Error::InvalidConnectionFile)?;
        self.request_builder(self.http.post(url)).await
    }

    async fn request_builder<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, Error> {
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(map_request_error)?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(Error::ResponseTooLarge);
        }
        let status = response.status();
        let mut stream = response.bytes_stream();
        let mut body = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(map_request_error)?;
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err(Error::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let message = serde_json::from_slice::<ApiError>(&body)
                .ok()
                .map(|value| value.message)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    status
                        .canonical_reason()
                        .unwrap_or("request failed")
                        .to_owned()
                });
            return Err(Error::Api { status, message });
        }
        serde_json::from_slice(&body).map_err(|_| Error::InvalidResponse)
    }
}

#[derive(Deserialize)]
struct ApiError {
    message: String,
}

#[derive(Deserialize)]
struct Ack {
    ok: bool,
}

fn require_ack(ack: Ack) -> Result<(), Error> {
    if ack.ok {
        Ok(())
    } else {
        Err(Error::InvalidResponse)
    }
}

fn optional_query<const N: usize>(values: [(&str, Option<String>); N]) -> Vec<(String, String)> {
    values
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value)))
        .collect()
}

fn agent_name(agent: prospero_protocol_rs::AgentKind) -> &'static str {
    match agent {
        prospero_protocol_rs::AgentKind::Codex => "codex",
        prospero_protocol_rs::AgentKind::Claude => "claude",
        prospero_protocol_rs::AgentKind::Opencode => "opencode",
        prospero_protocol_rs::AgentKind::Deepseek => "deepseek",
        prospero_protocol_rs::AgentKind::Grok => "grok",
        prospero_protocol_rs::AgentKind::Trae => "trae",
        prospero_protocol_rs::AgentKind::Shell => "shell",
        prospero_protocol_rs::AgentKind::Custom => "custom",
    }
}

fn map_request_error(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        Error::Timeout
    } else {
        Error::Unavailable
    }
}

fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn record_id(value: &str) -> Result<&str, Error> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(Error::InvalidConnectionFile);
    }
    Ok(value)
}

fn remote_id(value: &str) -> Result<&str, Error> {
    if value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        Ok(value)
    } else {
        Err(Error::InvalidConnectionFile)
    }
}

fn schedule_id(value: &str) -> Result<&str, Error> {
    if value.is_empty()
        || value.len() > 100
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || index > 0 && matches!(byte, b'.' | b'_' | b'-')
        })
    {
        return Err(Error::InvalidConnectionFile);
    }
    Ok(value)
}

fn plugin_id(value: &str) -> Result<&str, Error> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(Error::InvalidConnectionFile);
    }
    Ok(value)
}

fn read_connection(path: &Path) -> Result<Connection, Error> {
    let file = open_connection(path)?;
    let metadata = file.metadata().map_err(|_| Error::ConnectionUnavailable)?;
    if !metadata.is_file() || metadata.len() > MAX_CONNECTION_BYTES {
        return Err(Error::InvalidConnectionFile);
    }
    validate_connection_metadata(&metadata)?;
    let mut raw = String::new();
    file.take(MAX_CONNECTION_BYTES + 1)
        .read_to_string(&mut raw)
        .map_err(|_| Error::ConnectionUnavailable)?;
    if raw.len() as u64 > MAX_CONNECTION_BYTES {
        return Err(Error::InvalidConnectionFile);
    }
    serde_json::from_str(&raw).map_err(|_| Error::InvalidConnectionFile)
}

#[cfg(unix)]
fn open_connection(path: &Path) -> Result<File, Error> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| Error::ConnectionUnavailable)
}

#[cfg(windows)]
fn open_connection(path: &Path) -> Result<File, Error> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(0x0020_0000)
        .open(path)
        .map_err(|_| Error::ConnectionUnavailable)
}

#[cfg(not(any(unix, windows)))]
fn open_connection(path: &Path) -> Result<File, Error> {
    File::open(path).map_err(|_| Error::ConnectionUnavailable)
}

#[cfg(unix)]
fn validate_connection_metadata(metadata: &std::fs::Metadata) -> Result<(), Error> {
    use std::os::unix::fs::MetadataExt;
    if metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(Error::InsecureConnectionFile);
    }
    Ok(())
}

#[cfg(windows)]
fn validate_connection_metadata(metadata: &std::fs::Metadata) -> Result<(), Error> {
    if metadata.file_type().is_symlink() {
        return Err(Error::InsecureConnectionFile);
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn validate_connection_metadata(_: &std::fs::Metadata) -> Result<(), Error> {
    Ok(())
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    unsafe { CloseHandle(handle) };
    true
}

#[cfg(not(any(unix, windows)))]
fn process_alive(_: u32) -> bool {
    true
}

pub fn default_daemon_home() -> PathBuf {
    if let Some(path) = std::env::var_os("PROSPERO_RUST_HOME") {
        return PathBuf::from(path).join("daemon");
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join("Library/Application Support/Prospero Rust/daemon");
    }
    #[cfg(windows)]
    if let Some(app_data) = std::env::var_os("APPDATA") {
        return PathBuf::from(app_data).join("Prospero Rust/daemon");
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(data).join("prospero/daemon");
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(".local/share/prospero/daemon");
        }
    }
    PathBuf::from(".prospero-rust/daemon")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Bytes;
    use axum::extract::{Request, State};
    use axum::http::HeaderMap;
    use axum::routing::get;
    use axum::routing::post;
    use std::sync::{Arc, Mutex};

    type CapturedRequests = Arc<Mutex<Vec<(String, String, String)>>>;

    fn connection(pid: u32, base_url: &str, token: &str) -> Connection {
        Connection {
            api_version: 1,
            pid,
            base_url: base_url.to_owned(),
            token: token.to_owned(),
        }
    }

    #[tokio::test]
    async fn agent_mutations_use_bearer_paths_and_json_contracts() {
        let seen = Arc::new(Mutex::new(Vec::<(String, String, String)>::new()));
        let app = Router::new()
            .fallback(post(capture))
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let token = "a".repeat(64);
        let client = Client::from_connection(connection(
            std::process::id(),
            &format!("http://127.0.0.1:{}/", address.port()),
            &token,
        ))
        .unwrap();
        client
            .agent_send(
                "session-1",
                &AgentSend {
                    text: "hello".into(),
                    delivery: None,
                    attachments: Vec::new(),
                },
            )
            .await
            .unwrap();
        client
            .agent_permission(
                "session-1",
                &PermissionDecision {
                    request_id: "request-1".into(),
                    allow: true,
                },
            )
            .await
            .unwrap();
        client.agent_interrupt("session-1").await.unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert!(
            seen.iter()
                .all(|(_, authorization, _)| authorization == &format!("Bearer {token}"))
        );
        assert_eq!(seen[0].0, "/v1/agent-sessions/session-1/send");
        assert_eq!(
            seen[0].2,
            r#"{"text":"hello","delivery":null,"attachments":[]}"#
        );
        assert_eq!(seen[1].0, "/v1/agent-sessions/session-1/permission");
        assert_eq!(seen[2].0, "/v1/agent-sessions/session-1/interrupt");
    }

    #[tokio::test]
    async fn conversation_search_encodes_query_and_decodes_results() {
        async fn result(request: Request) -> axum::Json<serde_json::Value> {
            assert_eq!(request.uri().path(), "/v1/conversations");
            assert_eq!(
                request.uri().query(),
                Some("agent=codex&accountId=profile-1&query=rust+daemon&limit=20")
            );
            axum::Json(serde_json::json!({
                "agent": "codex",
                "conversations": [{
                    "id": "thread-1",
                    "agent": "codex",
                    "title": "Rust daemon",
                    "preview": "continue migration",
                    "cwd": "/repo",
                    "createdAt": 10,
                    "updatedAt": 20
                }]
            }))
        }

        let app = Router::new().route("/v1/conversations", get(result));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = Client::from_connection(connection(
            std::process::id(),
            &format!("http://127.0.0.1:{}/", address.port()),
            &"a".repeat(64),
        ))
        .unwrap();
        let result = client
            .conversations(
                prospero_protocol_rs::AgentKind::Codex,
                Some("profile-1".into()),
                "rust daemon".into(),
                20,
            )
            .await
            .unwrap();
        assert_eq!(result.agent, prospero_protocol_rs::AgentKind::Codex);
        assert_eq!(result.conversations[0].id, "thread-1");
    }

    async fn capture(
        State(seen): State<CapturedRequests>,
        headers: HeaderMap,
        request: Request,
    ) -> axum::Json<serde_json::Value> {
        let path = request.uri().path().to_owned();
        let authorization = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let body = axum::body::to_bytes(request.into_body(), 16 * 1024)
            .await
            .unwrap_or_else(|_| Bytes::new());
        seen.lock().unwrap().push((
            path,
            authorization,
            String::from_utf8_lossy(&body).into_owned(),
        ));
        axum::Json(serde_json::json!({"ok":true}))
    }

    #[test]
    fn rejects_non_loopback_and_invalid_tokens() {
        let pid = std::process::id();
        assert!(
            Client::from_connection(connection(pid, "https://127.0.0.1:7424/", &"a".repeat(64)))
                .is_err()
        );
        assert!(
            Client::from_connection(connection(pid, "http://localhost:7424/", &"a".repeat(64)))
                .is_err()
        );
        assert!(
            Client::from_connection(connection(pid, "http://127.0.0.1:7424/", "short")).is_err()
        );
        assert!(
            Client::from_connection(connection(pid, "http://127.0.0.1:7424/", &"a".repeat(64)))
                .is_ok()
        );
    }

    #[cfg(unix)]
    #[test]
    fn connection_file_must_be_private() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("connection.json");
        std::fs::write(
            &path,
            format!(
                "{{\"apiVersion\":1,\"pid\":{},\"baseUrl\":\"http://127.0.0.1:7424/\",\"token\":\"{}\"}}",
                std::process::id(),
                "a".repeat(64)
            ),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            read_connection(&path),
            Err(Error::InsecureConnectionFile)
        ));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_connection(&path).is_ok());
    }
}
