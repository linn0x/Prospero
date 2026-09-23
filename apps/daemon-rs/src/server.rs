use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::path::Path as FsPath;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{
    IntoResponse, Response, Sse,
    sse::{Event, KeepAlive},
};
use axum::{
    Json, Router,
    routing::{delete, get, post},
};
use base64::Engine;
use base64::prelude::{BASE64_STANDARD, BASE64_URL_SAFE_NO_PAD};
use futures_util::{Stream, stream};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use tokio::sync::{Semaphore, watch};

use crate::agent::Agents;
use crate::agent::{
    AgentCompactRequest, AgentModeSelection, AgentModelSelection, AgentSend,
    ApprovalPolicySelection, CancelCrossModelChild, CreateAgentSession, CreateCrossModelChild,
    CrossModelChildLogsQuery, CrossModelChildQuery, FollowUpCrossModelChild,
    MessageCrossModelChild, PermissionDecision, PermissionMode, QuestionDecision,
    ScheduleCrossModelCheck, UsageReport, UsageResult, mode_catalog,
};
use crate::auth::Token;
use crate::database::Store;
use crate::error::{Error, Result};
use crate::orchestration::{
    self, AbandonDispatch, AbandonRun, ApplyTaskGraph, CancelTask, CleanupWorktree, CompleteRun,
    CreateGate, CreateRun, CreateRunGraph, CreateTask, DeleteRun, DispatchTask, InspectWorktree,
    MarkMessages, PostMessage, ResolveGate, SettleDispatch, StartAutomation, StartWorker,
    StopWorker,
};
use crate::pairing::{self, AuthFailure, DeviceRecord};
use crate::plugins::{
    PluginServiceList, PluginServiceSupervisor, PluginServiceView, PublicPluginDiscoveryResult,
};
use crate::project::{
    FsChunk, FsChunkQuery, FsContent, FsDone, FsListing, FsPathQuery, FsPathRequest, FsPutRequest,
    FsRenameRequest, FsWriteRequest, FsWritten, GitCommitRequest, GitDiffQuery, GitDiffResult,
    GitDone, GitHistoryResult, GitStageRequest, GitStatusResult, ProjectSearchRequest,
    SearchResult, WorkspaceSummaryResult,
};
use crate::protocol::*;
use crate::remote_crypto::{self, SecureChannel};
use crate::schedules::{
    ScheduleCreate, ScheduleRunResult, ScheduleUpdate, ScheduledAgentTask, Schedules,
};
use crate::terminal::{
    CreateTerminal, TerminalEvent, TerminalInput, TerminalPage, TerminalQuery, TerminalSize,
    TerminalSnapshot, runtime::Terminals,
};
use crate::worker::Database;
use prospero_protocol_rs::{
    DeviceList, DeviceRevoked, DeviceView, PairingCreate, PairingCreated, RelayUpdate, RelayView,
};

#[derive(Clone)]
pub struct Api {
    pub database: Database,
    pub terminals: Terminals,
    pub agents: Agents,
    pub relay_status: crate::relay::RelayStatusHandle,
    pub schedules: Schedules,
    pub plugin_services: PluginServiceSupervisor,
    build_id: Arc<str>,
    token: Token,
    projection: Arc<Mutex<ProjectionState>>,
    projection_writer: Arc<tokio::sync::Mutex<()>>,
    changes: watch::Sender<u64>,
    stopping: watch::Sender<bool>,
    requests: Arc<Semaphore>,
    streams: Arc<Semaphore>,
    terminal_reads: Arc<Semaphore>,
    terminal_snapshots: Arc<Semaphore>,
    api_tests: Arc<Semaphore>,
    api_testing: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
    api_features: Arc<Semaphore>,
    remote_config: Arc<tokio::sync::Mutex<()>>,
    dev_mode: bool,
    remote_ws_handshake_timeout: Duration,
}

#[derive(Default)]
struct ProjectionState {
    initialized: bool,
    attention: i64,
    sessions: Option<(SessionSummary, Vec<SessionHead>)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotifyConfig {
    url: String,
    deep_link: Option<String>,
}

#[derive(Deserialize)]
struct RuntimeConfig {
    notify: Option<NotifyConfig>,
}

impl Api {
    pub fn new(database: Database, token: Token) -> Self {
        Self::with_guard(database, token, None)
    }

    pub fn with_guard(database: Database, token: Token, guard: Option<std::path::PathBuf>) -> Self {
        let build_id: String = guard
            .as_deref()
            .and_then(|path| std::fs::read(path).ok())
            .map(|bytes| {
                use sha2::{Digest, Sha256};
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let digest = Sha256::digest(bytes);
                let mut encoded = String::with_capacity(digest.len() * 2);
                for byte in digest {
                    encoded.push(HEX[(byte >> 4) as usize] as char);
                    encoded.push(HEX[(byte & 15) as usize] as char);
                }
                encoded
            })
            .unwrap_or_else(|| "development".into());
        let relay_status = crate::relay::RelayStatusHandle::new(database.directory());
        let guard_hash = guard.as_ref().map(|_| build_id.clone());
        let terminals = Terminals::with_guard(database.clone(), guard, guard_hash);
        let changes = terminals.changes();
        let agents = Agents::new(database.clone());
        let mut agent_changes = agents.changes().subscribe();
        let schedules = Schedules::new(database.directory(), agents.clone());
        let mut schedule_changes = schedules.changes();
        let plugin_services = PluginServiceSupervisor::new(database.directory());
        let shared_api = Self {
            terminals: terminals.clone(),
            agents: agents.clone(),
            relay_status: relay_status.clone(),
            schedules: schedules.clone(),
            plugin_services,
            build_id: build_id.into(),
            database: database.clone(),
            token: token.clone(),
            projection: Arc::new(Mutex::new(ProjectionState::default())),
            projection_writer: Arc::new(tokio::sync::Mutex::new(())),
            changes: changes.clone(),
            stopping: watch::channel(false).0,
            requests: Arc::new(Semaphore::new(32)),
            streams: Arc::new(Semaphore::new(16)),
            terminal_reads: Arc::new(Semaphore::new(16)),
            terminal_snapshots: Arc::new(Semaphore::new(2)),
            api_tests: Arc::new(Semaphore::new(4)),
            api_testing: Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
            api_features: Arc::new(Semaphore::new(4)),
            remote_config: Arc::new(tokio::sync::Mutex::new(())),
            dev_mode: false,
            remote_ws_handshake_timeout: REMOTE_WS_HANDSHAKE_TIMEOUT,
        };
        let agent_api = shared_api.clone();
        tokio::spawn(async move {
            while agent_changes.changed().await.is_ok() {
                agent_api.publish();
            }
        });
        let schedule_api = shared_api.clone();
        tokio::spawn(async move {
            while schedule_changes.changed().await.is_ok() {
                schedule_api.publish();
            }
        });
        shared_api
    }

    pub fn with_remote_ws_handshake_timeout(mut self, timeout: Duration) -> Self {
        self.remote_ws_handshake_timeout = timeout;
        self
    }

    pub fn with_dev_mode(mut self, dev_mode: bool) -> Self {
        self.dev_mode = dev_mode;
        self
    }

    pub fn router(&self) -> Router {
        Router::new()
            .route("/v1/health", get(health))
            .route("/v1/devices", get(device_list))
            .route("/v1/devices/{id}", delete(device_revoke))
            .route("/v1/pairings", post(pairing_create))
            .route("/v1/relay", get(relay_get).patch(relay_update))
            .route("/ws", get(remote_ws))
            .route("/v1/shutdown", post(shutdown))
            .route("/v1/agent-sessions", post(create_agent))
            .route(
                "/v1/cross-model-children",
                get(list_all_cross_model_children),
            )
            .route(
                "/v1/agent-sessions/{id}/cross-model-children",
                get(list_cross_model_children).post(create_cross_model_child),
            )
            .route(
                "/v1/agent-sessions/{id}/cross-model-children/{child}",
                get(get_cross_model_child),
            )
            .route(
                "/v1/agent-sessions/{id}/cross-model-children/{child}/logs",
                get(cross_model_child_logs),
            )
            .route(
                "/v1/agent-sessions/{id}/cross-model-children/{child}/result",
                get(cross_model_child_result),
            )
            .route(
                "/v1/agent-sessions/{id}/cross-model-children/{child}/message",
                post(message_cross_model_child),
            )
            .route(
                "/v1/agent-sessions/{id}/cross-model-children/{child}/follow-up",
                post(follow_up_cross_model_child),
            )
            .route(
                "/v1/agent-sessions/{id}/cross-model-children/{child}/cancel",
                post(cancel_cross_model_child),
            )
            .route(
                "/v1/agent-sessions/{id}/cross-model-children/{child}/redeliver",
                post(redeliver_cross_model_child),
            )
            .route(
                "/v1/agent-sessions/{id}/cross-model-children/{child}/ack",
                post(ack_cross_model_child),
            )
            .route(
                "/v1/agent-sessions/{id}/cross-model-checks",
                post(schedule_cross_model_check),
            )
            .route("/v1/conversations", get(conversation_search))
            .route("/v1/agent-sessions/queues", get(agent_queues))
            .route("/v1/usage", get(usage_route))
            .route("/v1/agent-sessions/{id}/send", post(agent_send))
            .route(
                "/v1/agent-sessions/{id}/suggestions",
                get(agent_suggestions),
            )
            .route(
                "/v1/agent-sessions/{id}/modes",
                get(agent_modes).post(set_agent_mode),
            )
            .route(
                "/v1/agent-sessions/{id}/models",
                get(agent_models).post(set_agent_model),
            )
            .route("/v1/agent-sessions/controls", get(agent_controls))
            .route(
                "/v1/agent-sessions/{id}/subagents/{subagent}/events",
                get(agent_subagent_events),
            )
            .route(
                "/v1/agent-sessions/{id}/subagents/{subagent}/send",
                post(agent_subagent_send),
            )
            .route("/v1/agent-sessions/{id}/interrupt", post(agent_interrupt))
            .route("/v1/agent-sessions/{id}/compact", post(agent_compact))
            .route(
                "/v1/agent-sessions/{id}/tool-output",
                get(agent_tool_output),
            )
            .route("/v1/agent-sessions/{id}/attachment", get(agent_attachment))
            .route(
                "/v1/sessions/{id}/workspace-summary",
                get(workspace_summary),
            )
            .route("/v1/sessions/{id}/fs/list", get(fs_list))
            .route("/v1/sessions/{id}/fs/read", get(fs_read))
            .route("/v1/sessions/{id}/fs/write", post(fs_write))
            .route("/v1/sessions/{id}/fs/get", get(fs_get))
            .route("/v1/sessions/{id}/fs/put", post(fs_put))
            .route("/v1/sessions/{id}/fs/mkdir", post(fs_mkdir))
            .route("/v1/sessions/{id}/fs/remove", post(fs_remove))
            .route("/v1/sessions/{id}/fs/rename", post(fs_rename))
            .route("/v1/sessions/{id}/search", post(project_search))
            .route("/v1/sessions/{id}/git/status", get(git_status))
            .route("/v1/sessions/{id}/git/diff", get(git_diff))
            .route("/v1/sessions/{id}/git/history", get(git_history))
            .route("/v1/sessions/{id}/git/stage", post(git_stage))
            .route("/v1/sessions/{id}/git/discard", post(git_discard))
            .route("/v1/sessions/{id}/git/commit", post(git_commit))
            .route(
                "/v1/agent-sessions/{id}/approval-policy",
                post(agent_approval_policy),
            )
            .route("/v1/agent-sessions/{id}/permission", post(agent_permission))
            .route("/v1/agent-sessions/{id}/question", post(agent_question))
            .route("/v1/agent-sessions/{id}/queue", get(agent_queue))
            .route(
                "/v1/agent-sessions/{id}/queue/{queue_id}/remove",
                post(agent_queue_remove),
            )
            .route(
                "/v1/agent-sessions/{id}/queue/{queue_id}/guide",
                post(agent_queue_guide),
            )
            .route(
                "/v1/agent-sessions/{id}",
                axum::routing::delete(agent_close),
            )
            .route("/v1/terminals", post(create_terminal))
            .route("/v1/terminals/{id}/output", get(terminal_output))
            .route("/v1/terminals/{id}/snapshot", get(terminal_snapshot))
            .route("/v1/terminals/{id}/input", post(terminal_input))
            .route("/v1/terminals/{id}/resize", post(terminal_resize))
            .route("/v1/terminals/{id}/close", post(terminal_close))
            .route("/v1/sessions", get(sessions))
            .route("/v1/skills", get(list_skills_route))
            .route("/v1/plugins", get(plugin_list))
            .route("/v1/plugin-services", get(plugin_service_status))
            .route(
                "/v1/plugin/{plugin}/service/{service}/start",
                post(plugin_service_start),
            )
            .route(
                "/v1/plugin/{plugin}/service/{service}/stop",
                post(plugin_service_stop),
            )
            .route(
                "/v1/plugin/{plugin}/service/{service}/restart",
                post(plugin_service_restart),
            )
            .route(
                "/v1/plugin/{plugin}/service/{service}/health",
                get(plugin_service_health),
            )
            .route("/v1/schedules", get(schedule_list).post(schedule_create))
            .route(
                "/v1/schedules/{id}",
                get(schedule_get)
                    .patch(schedule_update)
                    .delete(schedule_delete),
            )
            .route("/v1/schedules/{id}/pause", post(schedule_pause))
            .route("/v1/schedules/{id}/resume", post(schedule_resume))
            .route("/v1/schedules/{id}/run", post(schedule_run))
            .route("/v1/accounts", post(accounts_route))
            .route("/v1/model-sources", post(model_sources_route))
            .route("/v1/launch/models", get(launch_models))
            .route("/v1/sessions/summary", get(summary))
            .route("/v1/sessions/lookup", post(lookup))
            .route("/v1/workspaces", get(workspaces))
            .route("/v1/sessions/{id}", get(session).patch(rename))
            .route("/v1/sessions/{id}/contents", get(contents))
            .route("/v1/sessions/{id}/content/{content}", get(content))
            .route("/v1/sessions/{id}/timeline", get(timeline))
            .route("/v1/sessions/{id}/timeline/lookup", post(timeline_lookup))
            .route(
                "/v1/sessions/{id}/timeline/{record}/body",
                get(timeline_text),
            )
            .route("/v1/events", get(events))
            .route("/v1/events/stream", get(subscribe))
            .route("/v1/runs", get(list_runs).post(create_run))
            .route("/v1/runs/graph", post(create_run_graph))
            .route("/v1/runs/graph/apply", post(apply_task_graph))
            .route("/v1/runs/{id}", get(run_snapshot).delete(delete_run))
            .route("/v1/runs/{id}/ready", get(ready_tasks))
            .route("/v1/runs/{id}/complete", post(complete_run))
            .route("/v1/runs/{id}/abandon", post(abandon_run))
            .route(
                "/v1/runs/{id}/automation/start",
                post(start_automation_route),
            )
            .route(
                "/v1/runs/{id}/automation/pause",
                post(pause_automation_route),
            )
            .route("/v1/runs/{id}/gates", post(create_gate))
            .route("/v1/tasks", get(list_tasks).post(create_task))
            .route("/v1/tasks/{id}", get(task))
            .route("/v1/tasks/{id}/cancel", post(cancel_task))
            .route("/v1/tasks/{id}/retry", post(retry_task))
            .route("/v1/tasks/{id}/complete", post(complete_task))
            .route("/v1/tasks/{id}/fail", post(fail_task))
            .route("/v1/tasks/{id}/dispatch", post(dispatch_task))
            .route("/v1/workers/start", post(start_worker_route))
            .route("/v1/workers/stop", post(stop_worker_route))
            .route("/v1/worktrees", get(list_worktrees))
            .route("/v1/worktrees/{id}", get(worktree_asset_route))
            .route("/v1/worktrees/{id}/inspect", post(inspect_worktree_route))
            .route("/v1/worktrees/{id}/cleanup", post(cleanup_worktree_route))
            .route("/v1/dispatches", get(list_dispatches))
            .route("/v1/dispatches/recover", post(recover_dispatches))
            .route("/v1/dispatches/{id}", get(dispatch))
            .route("/v1/dispatches/{id}/running", post(dispatch_running))
            .route("/v1/dispatches/{id}/settle", post(settle_dispatch))
            .route("/v1/dispatches/{id}/abandon", post(abandon_dispatch))
            .route("/v1/gates", get(list_gates))
            .route("/v1/gates/{id}/resolve", post(resolve_gate))
            .route("/v1/messages", get(list_messages).post(post_message))
            .route("/v1/messages/unread", get(unread_messages))
            .route("/v1/messages/read", post(mark_messages_read))
            .route("/v1/messages/{id}/answered", post(mark_message_answered))
            .fallback(|| async { ApiError(Error::NotFound) })
            // Image sends carry up to ~15 MiB of base64 payload (6 images).
            .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
            .layer(middleware::from_fn_with_state(self.clone(), authorize))
            .with_state(self.clone())
    }

    pub fn publish(&self) {
        self.changes
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    pub async fn run_status_projection(
        &self,
        port: u16,
        bind: Option<String>,
        control_token: String,
        mut stopping: watch::Receiver<bool>,
    ) {
        let mut changes = self.changes.subscribe();
        let mut interval = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(1),
            Duration::from_secs(1),
        );
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        if let Err(error) = self
            .write_status_projection(port, bind.clone(), control_token.clone())
            .await
        {
            eprintln!("status projection failed: {error}");
        }
        let mut next_write = tokio::time::Instant::now() + Duration::from_millis(100);
        loop {
            tokio::select! {
                _ = interval.tick() => {},
                changed = changes.changed() => {
                    if changed.is_err() {
                        return;
                    }
                },
                changed = stopping.changed() => {
                    if changed.is_err() || *stopping.borrow() {
                        return;
                    }
                }
            }
            // Coalesce notifications while keeping the one-second heartbeat.
            tokio::select! {
                _ = tokio::time::sleep_until(next_write) => {},
                changed = stopping.changed() => {
                    if changed.is_err() || *stopping.borrow() { return; }
                    continue;
                },
            }
            changes.borrow_and_update();
            if let Err(error) = self
                .write_status_projection(port, bind.clone(), control_token.clone())
                .await
            {
                eprintln!("status projection failed: {error}");
            }
            next_write = tokio::time::Instant::now() + Duration::from_millis(100);
        }
    }

    pub async fn write_status_projection(
        &self,
        port: u16,
        bind: Option<String>,
        control_token: String,
    ) -> Result<()> {
        let _writer = self.projection_writer.lock().await;
        let cached = self
            .projection
            .lock()
            .map_err(|_| Error::Closed)?
            .sessions
            .clone();
        let (summary, sessions) = self
            .database
            .call(move |store| {
                let summary = store.session_summary(None)?;
                if let Some((previous, sessions)) = cached
                    && previous == summary
                {
                    return Ok((summary, sessions));
                }
                let active = store.sessions(SessionQuery {
                    cursor: None,
                    limit: Some(100),
                    lifecycle: Some(SessionLifecycle::Active),
                    workspace: None,
                    text: None,
                })?;
                let archived = store.sessions(SessionQuery {
                    cursor: None,
                    limit: Some(20),
                    lifecycle: Some(SessionLifecycle::Archived),
                    workspace: None,
                    text: None,
                })?;
                let mut sessions = active.items;
                sessions.extend(archived.items);
                Ok((summary, sessions))
            })
            .await?;
        self.projection.lock().map_err(|_| Error::Closed)?.sessions =
            Some((summary.clone(), sessions.clone()));
        let attention = summary.attention;
        let schedules = self.schedules.status_list_async().await.unwrap_or_default();
        let relay_status = self.relay_status.clone();
        tokio::task::spawn_blocking(move || {
            relay_status.write_minimal_status(crate::relay::RustDaemonStatusInput {
                port,
                bind,
                control_token,
                capabilities: health_capabilities(),
                session_summary: summary,
                sessions,
                schedules,
            })
        })
        .await
        .map_err(|_| Error::Closed)??;
        drop(_writer);
        self.notify_attention(attention).await;
        Ok(())
    }

    async fn notify_attention(&self, attention: i64) {
        let should_notify = {
            let Ok(mut state) = self.projection.lock() else {
                return;
            };
            let notify = state.initialized && attention > state.attention;
            state.initialized = true;
            state.attention = attention;
            notify
        };
        if !should_notify {
            return;
        }
        let Some(config) = load_notify_config(self.database.directory()) else {
            return;
        };
        if config.url.trim().is_empty() {
            return;
        }
        let url = config.deep_link.unwrap_or_else(|| "prospero://".into());
        let body = json!({
            "title": "Prospero 等待你的处理",
            "body": format!("{attention} 个审批或问题需要处理"),
            "message": format!("{attention} 个审批或问题需要处理"),
            "group": "Prospero",
            "tags": ["warning"],
            "level": "timeSensitive",
            "url": url,
            "click": url
        });
        let client = match Client::builder().timeout(Duration::from_secs(10)).build() {
            Ok(client) => client,
            Err(_) => return,
        };
        if !client
            .post(config.url)
            .json(&body)
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            eprintln!("notification delivery failed");
        }
    }
    pub fn stop(&self) {
        self.stopping.send_replace(true);
    }

    pub async fn wait_stopped(&self) {
        let mut stopped = self.stopping.subscribe();
        if *stopped.borrow() {
            return;
        }
        let _ = stopped.changed().await;
    }

    async fn call<T, F>(&self, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Store) -> Result<T> + Send + 'static,
    {
        tokio::time::timeout(Duration::from_secs(5), self.database.call(operation))
            .await
            .map_err(|_| Error::Timeout)?
    }
}

pub struct ApiError(pub Error);
impl From<Error> for ApiError {
    fn from(error: Error) -> Self {
        Self(error)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self.0 {
            Error::Unauthorized => StatusCode::UNAUTHORIZED,
            Error::Forbidden => StatusCode::FORBIDDEN,
            Error::Invalid(_) => StatusCode::BAD_REQUEST,
            Error::Feature(code, _) if matches!(code.as_str(), "busy" | "conflict" | "in_use") => {
                StatusCode::CONFLICT
            }
            Error::Feature(code, _) if code == "not_found" => StatusCode::NOT_FOUND,
            Error::Feature(code, _) if code == "unauthorized" => StatusCode::UNAUTHORIZED,
            Error::Feature(_, _) => StatusCode::BAD_REQUEST,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Conflict
            | Error::AlreadyRunning
            | Error::InUse
            | Error::ApiTestBusy
            | Error::ApiTestInFlight => StatusCode::CONFLICT,
            Error::Busy | Error::Closed | Error::DatabaseUnavailable(_) => {
                StatusCode::SERVICE_UNAVAILABLE
            }
            Error::Timeout => StatusCode::GATEWAY_TIMEOUT,
            Error::DatabaseOperationFailed(_) => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(self.0.public())).into_response()
    }
}

async fn authorize(State(api): State<Api>, request: Request, next: Next) -> Response {
    if request.headers().contains_key("origin") {
        return ApiError(Error::Forbidden).into_response();
    }
    let is_remote_ws = request.uri().path() == "/ws";
    if !is_remote_ws
        && (request.headers().get_all("authorization").iter().count() != 1
            || !request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| api.token.accepts(value)))
    {
        return ApiError(Error::Unauthorized).into_response();
    }
    let Ok(_permit) = api.requests.clone().try_acquire_owned() else {
        return ApiError(Error::Busy).into_response();
    };
    let path = request.uri().path();
    let request_timeout = if request.method() == axum::http::Method::POST
        && (matches!(path, "/v1/terminals" | "/v1/agent-sessions")
            || (path.starts_with("/v1/schedules/") && path.ends_with("/run")))
    {
        Duration::from_secs(180)
    } else if path == "/v1/accounts" {
        Duration::from_secs(90)
    } else if path == "/v1/launch/models" {
        Duration::from_secs(35)
    } else {
        Duration::from_secs(10)
    };
    let mut response = match tokio::time::timeout(request_timeout, next.run(request)).await {
        Ok(response) => response,
        Err(_) => ApiError(Error::Timeout).into_response(),
    };
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}

const WS_MAX_PAYLOAD: usize = 16 * 1024 * 1024;
const REMOTE_WS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

async fn remote_ws(State(api): State<Api>, ws: WebSocketUpgrade) -> Response {
    let Ok(permit) = api.streams.clone().try_acquire_owned() else {
        return ApiError(Error::Busy).into_response();
    };
    ws.max_message_size(WS_MAX_PAYLOAD)
        .max_frame_size(WS_MAX_PAYLOAD)
        .on_upgrade(move |socket| handle_remote_ws(api, socket, permit))
}

const CLOSE_AUTH_FAILED: u16 = 4001;
const CLOSE_PROTOCOL: u16 = 4003;
const CLOSE_REVOKED: u16 = 4004;

async fn handle_remote_ws(
    api: Api,
    mut socket: WebSocket,
    _permit: tokio::sync::OwnedSemaphorePermit,
) {
    let first = match tokio::time::timeout(
        api.remote_ws_handshake_timeout,
        recv_text_frame(&mut socket),
    )
    .await
    {
        Ok(Ok(Some(text))) => text,
        Ok(Ok(None)) => return,
        Ok(Err(_)) | Err(_) => {
            close_ws(&mut socket, CLOSE_PROTOCOL, "handshake error").await;
            return;
        }
    };
    let home = api.database.directory().to_path_buf();
    let identity = match pairing::load_identity(&home) {
        Ok(identity) => identity,
        Err(_) => {
            close_ws(&mut socket, CLOSE_REVOKED, "not paired").await;
            return;
        }
    };
    let responded = match remote_crypto::server_handshake_respond(&first, &identity.secret_key) {
        Ok(responded) => responded,
        Err(_) => {
            close_ws(&mut socket, CLOSE_PROTOCOL, "handshake error").await;
            return;
        }
    };
    if socket
        .send(Message::Text(responded.frame.into()))
        .await
        .is_err()
    {
        return;
    }
    let hello_frame = match tokio::time::timeout(
        api.remote_ws_handshake_timeout,
        recv_text_frame(&mut socket),
    )
    .await
    {
        Ok(Ok(Some(text))) => text,
        Ok(Ok(None)) => return,
        Ok(Err(_)) | Err(_) => {
            close_ws(&mut socket, CLOSE_PROTOCOL, "handshake error").await;
            return;
        }
    };
    let accepted = match remote_crypto::server_handshake_accept(responded.state, &hello_frame) {
        Ok(accepted) => accepted,
        Err(_) => {
            close_ws(&mut socket, CLOSE_PROTOCOL, "handshake error").await;
            return;
        }
    };
    let token = accepted
        .hello
        .get("token")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let client_pub_key = accepted
        .hello
        .get("clientPubKey")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    let authenticated = {
        let _guard = api.remote_config.lock().await;
        pairing::authenticate(&home, token, client_pub_key)
    };
    let device = match authenticated {
        Ok(Ok(device)) => device,
        Ok(Err(AuthFailure::UnknownToken | AuthFailure::KeyMismatch)) => {
            let mut channel = accepted.channel;
            let _ = send_remote_json(
                &mut socket,
                &mut channel,
                &json!({"type":"error","code":"auth_failed","message":"invalid token, or device key changed"}),
            )
            .await;
            close_ws(&mut socket, CLOSE_AUTH_FAILED, "auth failed").await;
            return;
        }
        Err(_) => {
            close_ws(&mut socket, CLOSE_AUTH_FAILED, "auth failed").await;
            return;
        }
    };
    let mut channel = accepted.channel;
    if send_hello_ok(&api, &mut socket, &mut channel, accepted.protocol_version)
        .await
        .is_err()
    {
        return;
    }
    let mut state = RemoteWsState::default();
    let mut changes = api.changes.subscribe();
    let mut revoke_check = tokio::time::interval(Duration::from_millis(500));
    revoke_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            frame = socket.recv() => {
                let text = match frame {
                    Some(Ok(Message::Text(text))) => text.to_string(),
                    Some(Ok(Message::Binary(bytes))) => match String::from_utf8(bytes.to_vec()) {
                        Ok(text) => text,
                        Err(_) => {
                            close_ws(&mut socket, CLOSE_PROTOCOL, "binary WebSocket frame is not UTF-8").await;
                            return;
                        }
                    },
                    Some(Ok(Message::Ping(bytes))) => {
                        if socket.send(Message::Pong(bytes)).await.is_err() {
                            return;
                        }
                        continue;
                    }
                    Some(Ok(Message::Pong(_))) => continue,
                    Some(Ok(Message::Close(_))) | None => return,
                    Some(Err(_)) => return,
                };
                let message = match channel.open(&text) {
                    Ok(message) => message,
                    Err(_) => {
                        close_ws(&mut socket, CLOSE_PROTOCOL, "crypto").await;
                        return;
                    }
                };
                if remote_device_revoked(&home, &device.token) {
                    close_ws(&mut socket, CLOSE_REVOKED, "revoked").await;
                    return;
                }
                if let Err(error) = route_remote_ws_message(
                    &api,
                    &mut socket,
                    &mut channel,
                    &mut state,
                    &device,
                    accepted.protocol_version,
                    message,
                )
                .await
                    && send_remote_error(&mut socket, &mut channel, &error, None)
                        .await
                        .is_err()
                {
                    return;
                }
            }
            changed = changes.changed() => {
                if changed.is_err() {
                    return;
                }
                if flush_remote_ws_changes(&api, &mut socket, &mut channel, &mut state).await.is_err() {
                    return;
                }
            }
            _ = revoke_check.tick() => {
                if remote_device_revoked(&home, &device.token) {
                    close_ws(&mut socket, CLOSE_REVOKED, "revoked").await;
                    return;
                }
            }
        }
    }
}

#[derive(Debug, Default)]
struct RemoteWsState {
    pty_attachments: HashMap<String, RemotePtyAttachment>,
    chat_attachments: HashMap<String, RemoteChatAttachment>,
    session_revisions: HashMap<String, i64>,
    orchestration_snapshot: Option<String>,
}

#[derive(Debug)]
struct RemotePtyAttachment {
    last_sent_seq: i64,
    last_ack_seq: i64,
}

#[derive(Debug)]
struct RemoteChatAttachment {
    cursor_position: i64,
    last_event_seq: i64,
}

async fn recv_text_frame(socket: &mut WebSocket) -> Result<Option<String>> {
    loop {
        match socket.recv().await {
            Some(Ok(Message::Text(text))) => return Ok(Some(text.to_string())),
            Some(Ok(Message::Binary(bytes))) => {
                return String::from_utf8(bytes.to_vec())
                    .map(Some)
                    .map_err(|_| Error::Invalid("binary WebSocket frame is not UTF-8".into()));
            }
            Some(Ok(Message::Ping(bytes))) => {
                if socket.send(Message::Pong(bytes)).await.is_err() {
                    return Ok(None);
                }
            }
            Some(Ok(Message::Pong(_))) => {}
            Some(Ok(Message::Close(_))) | None => return Ok(None),
            Some(Err(_)) => return Err(Error::Closed),
        }
    }
}

async fn close_ws(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_owned().into(),
        })))
        .await;
}

fn remote_device_revoked(home: &FsPath, token: &str) -> bool {
    pairing::load_devices(home).map_or(true, |devices| {
        !devices.iter().any(|device| device.token == token)
    })
}

async fn send_remote_json(
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    value: &JsonValue,
) -> Result<()> {
    let frame = channel.seal(value)?;
    socket
        .send(Message::Text(frame.into()))
        .await
        .map_err(|_| Error::Closed)
}

async fn send_hello_ok(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    protocol_version: u8,
) -> Result<()> {
    let page = api
        .call(|store| {
            store.sessions(SessionQuery {
                limit: Some(100),
                lifecycle: Some(SessionLifecycle::Active),
                ..SessionQuery::default()
            })
        })
        .await?;
    send_remote_json(
        socket,
        channel,
        &json!({
            "type": "hello.ok",
            "host": remote_host_info(protocol_version),
            "sessions": page.items.into_iter().map(remote_session_info).collect::<Vec<_>>(),
        }),
    )
    .await
}

fn remote_host_info(protocol_version: u8) -> JsonValue {
    let mut capabilities = vec![
        "session.create-result.v1",
        "conversation.search.v1",
        "chat.attachment-previews.v1",
        "agent.deepseek-harness.v1",
        "model.sources.v1",
        "orchestration.automation.v1",
        "scheduled-agents.v1",
    ];
    if cfg!(windows) {
        capabilities.push("workspace.roots-mkdir.v1");
    }
    json!({
        "name": std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".into()),
        "daemonVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": remote_crypto::PROTOCOL_VERSION,
        "minimumProtocolVersion": remote_crypto::MIN_PROTOCOL_VERSION,
        "negotiatedProtocolVersion": protocol_version,
        "capabilities": capabilities,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "daemonStartedAt": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0),
        "tmuxManaged": false,
    })
}

fn remote_session_info(head: SessionHead) -> JsonValue {
    let mut value = json!({
        "id": head.id,
        "agent": head.agent,
        "kind": head.kind,
        "title": head.title,
        "cwd": head.workspace,
        "status": head.status,
        "createdAt": head.created_at,
        "cols": 80,
        "rows": 24,
    });
    if let Some(busy_since) = head.busy_since {
        value["busySince"] = busy_since.into();
    }
    value
}

async fn route_remote_ws_message(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    state: &mut RemoteWsState,
    device: &DeviceRecord,
    protocol_version: u8,
    message: JsonValue,
) -> Result<()> {
    let kind = message
        .get("type")
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    match kind {
        "connection.ping" => {
            let id = message.get("id").and_then(JsonValue::as_str).unwrap_or("");
            send_remote_json(socket, channel, &json!({"type":"connection.pong","id":id})).await
        }
        "session.create" => remote_session_create(api, socket, channel, device, message).await,
        "session.attach" => remote_session_attach(api, socket, channel, state, message).await,
        "session.detach" => {
            let sid = require_str(&message, "sid")?;
            state.pty_attachments.remove(sid);
            state.chat_attachments.remove(sid);
            Ok(())
        }
        "agent.accounts.list"
        | "agent.account.create"
        | "agent.account.api.create"
        | "agent.account.api.configure"
        | "agent.account.api.test"
        | "agent.account.api.models.get"
        | "agent.account.config.get"
        | "agent.account.config.set"
        | "agent.account.rename"
        | "agent.account.default"
        | "agent.account.login"
        | "agent.account.credential.set"
        | "agent.account.logout"
        | "agent.account.delete" => remote_accounts_control(api, socket, channel, message).await,
        "model.source.action" => remote_model_sources_control(api, socket, channel, message).await,
        "launch.models.get" => remote_launch_models(api, socket, channel, message).await,
        "agent.models.get" => remote_agent_models(api, socket, channel, message).await,
        "agent.modes.get" => remote_agent_modes(api, socket, channel, message).await,
        "agent.model.set" => remote_agent_model_set(api, socket, channel, message).await,
        "agent.mode.set" => remote_agent_mode_set(api, socket, channel, message).await,
        "agent.compact" => remote_agent_compact(api, socket, channel, message).await,
        "tool.output.get" => remote_tool_output(api, socket, channel, message).await,
        "chat.attachment.get" => remote_chat_attachment(api, socket, channel, message).await,
        "approval.policy.set" => remote_approval_policy_set(api, message).await,
        "session.interrupt" => {
            let sid = require_str(&message, "sid")?;
            signal_session(api, sid, false).await
        }
        "session.kill" => {
            let sid = require_str(&message, "sid")?;
            signal_session(api, sid, true).await
        }
        "permission.respond" => remote_permission_respond(api, message).await,
        "question.respond" => remote_question_respond(api, message).await,
        "subagent.send" => remote_subagent_send(api, message).await,
        "subagent.history.get" => remote_subagent_history(api, socket, channel, message).await,
        "usage.get" => remote_usage(api, socket, channel, message).await,
        "schedule.list"
        | "schedule.get"
        | "schedule.create"
        | "schedule.update"
        | "schedule.pause"
        | "schedule.resume"
        | "schedule.delete"
        | "schedule.run" => {
            remote_schedule_control(api, socket, channel, device, protocol_version, message).await
        }
        "orchestration.snapshot" => {
            let snapshot = load_orchestration_snapshot(api).await?;
            state.orchestration_snapshot = Some(serde_json::to_string(&snapshot)?);
            send_remote_json(
                socket,
                channel,
                &json!({"type":"orchestration.snapshot","snapshot":snapshot}),
            )
            .await
        }
        "orchestration.gate.resolve"
        | "orchestration.run.create"
        | "orchestration.run.complete"
        | "orchestration.run.abandon"
        | "orchestration.run.delete"
        | "orchestration.task.create"
        | "orchestration.task.cancel"
        | "orchestration.task.retry"
        | "orchestration.graph.create"
        | "orchestration.graph.apply"
        | "orchestration.automation.start"
        | "orchestration.automation.pause"
        | "orchestration.worktree.inspect"
        | "orchestration.worktree.cleanup" => {
            remote_orchestration_control(api, socket, channel, device, message).await
        }
        "orchestration.worker.start" | "orchestration.worker.stop" => {
            remote_orchestration_control(api, socket, channel, device, message).await
        }
        "conversation.search" => remote_conversation_search(api, socket, channel, message).await,
        "workspace.list" => remote_workspace_list(socket, channel, message).await,
        "workspace.summary" => remote_workspace_summary(api, socket, channel, message).await,
        "fs.list" => remote_fs_list(api, socket, channel, message).await,
        "fs.read" => remote_fs_read(api, socket, channel, message).await,
        "fs.get" => remote_fs_get(api, socket, channel, message).await,
        "fs.write" => remote_fs_write(api, socket, channel, message).await,
        "fs.put" => remote_fs_put(api, socket, channel, message).await,
        "fs.mkdir" => remote_fs_mkdir(api, socket, channel, message).await,
        "fs.remove" => remote_fs_remove(api, socket, channel, message).await,
        "fs.rename" => remote_fs_rename(api, socket, channel, message).await,
        "git.status" => remote_git_status(api, socket, channel, message).await,
        "git.diff" => remote_git_diff(api, socket, channel, message).await,
        "git.history" => remote_git_history(api, socket, channel, message).await,
        "git.stage" => remote_git_stage(api, socket, channel, message).await,
        "git.discard" => remote_git_discard(api, socket, channel, message).await,
        "git.commit" => remote_git_commit(api, socket, channel, message).await,
        "chat.send" => {
            let sid = require_str(&message, "sid")?;
            let text = message
                .get("text")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_owned();
            let delivery = message
                .get("delivery")
                .and_then(JsonValue::as_str)
                .map(str::to_owned);
            let attachments = message
                .get("attachments")
                .cloned()
                .map(serde_json::from_value)
                .transpose()?
                .unwrap_or_default();
            api.agents.send(sid, text, delivery, attachments).await?;
            api.publish();
            Ok(())
        }
        "chat.queue.remove" => {
            let sid = require_str(&message, "sid")?;
            let queue_id = require_str(&message, "queueId")?;
            api.agents.remove_queued(sid, queue_id).await?;
            api.publish();
            Ok(())
        }
        "chat.queue.guide" => {
            let sid = require_str(&message, "sid")?;
            let queue_id = require_str(&message, "queueId")?;
            api.agents.guide_queued(sid, queue_id).await?;
            api.publish();
            Ok(())
        }
        "term.input" => {
            if !device.allow_shell {
                return send_remote_json(
                    socket,
                    channel,
                    &json!({"type":"error","code":"shell_not_allowed","message":"shell access is not allowed"}),
                )
                .await;
            }
            let sid = require_str(&message, "sid")?;
            let data_b64 = require_str(&message, "dataB64")?.to_owned();
            api.terminals.input(sid, TerminalInput { data_b64 }).await
        }
        "term.resize" => {
            if !device.allow_shell {
                return send_remote_json(
                    socket,
                    channel,
                    &json!({"type":"error","code":"shell_not_allowed","message":"shell access is not allowed"}),
                )
                .await;
            }
            let sid = require_str(&message, "sid")?;
            let cols = require_u16(&message, "cols")?;
            let rows = require_u16(&message, "rows")?;
            api.terminals
                .resize(sid, crate::terminal::validate_size(TerminalSize { cols, rows })?)
                .await
        }
        "term.ack" => {
            let sid = require_str(&message, "sid")?;
            let seq = message.get("seq").and_then(JsonValue::as_i64).unwrap_or(0);
            if let Some(att) = state.pty_attachments.get_mut(sid) {
                att.last_ack_seq = seq;
            }
            Ok(())
        }
        _ => {
            send_remote_json(
                socket,
                channel,
                &json!({"type":"error","code":"bad_message","message":format!("unsupported message type: {kind}")}),
            )
            .await
        }
    }
}

async fn send_remote_error(
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    error: &Error,
    sid: Option<&str>,
) -> Result<()> {
    let mut body = json!({
        "type": "error",
        "code": remote_error_code(error),
        "message": error.to_string(),
    });
    if let Some(sid) = sid {
        body["sid"] = json!(sid);
    }
    send_remote_json(socket, channel, &body).await
}

async fn send_http_json_response(
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    response: Response,
) -> Result<()> {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .map_err(|_| Error::Closed)?;
    let value: JsonValue = serde_json::from_slice(&bytes)?;
    if status.is_success() || value.get("type").and_then(JsonValue::as_str).is_some() {
        send_remote_json(socket, channel, &value).await
    } else {
        let code = value
            .get("code")
            .and_then(JsonValue::as_str)
            .unwrap_or("bad_message");
        let message = value
            .get("message")
            .and_then(JsonValue::as_str)
            .unwrap_or("request failed");
        send_remote_json(
            socket,
            channel,
            &json!({"type":"error","code":code,"message":message}),
        )
        .await
    }
}

async fn remote_accounts_control(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let response = accounts_route(State(api.clone()), Ok(Json(message))).await;
    send_http_json_response(socket, channel, response).await
}

async fn remote_model_sources_control(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let control: crate::accounts::sources::SourceControl = serde_json::from_value(message)?;
    let response = model_sources_route(State(api.clone()), Ok(Json(control))).await;
    send_http_json_response(socket, channel, response).await
}

async fn remote_launch_models(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let request_id = require_str(&message, "requestId")?.to_owned();
    let agent = require_str(&message, "agent")?;
    let account_id = message
        .get("accountId")
        .and_then(JsonValue::as_str)
        .map(str::to_owned);
    let mut out = json!({"type":"launch.models","requestId":request_id,"agent":agent,"models":[]});
    match agent {
        "deepseek" => match crate::agent::Agents::deepseek_launch_catalog().await {
            Ok(catalog) => {
                let catalog = serde_json::to_value(catalog)?;
                out["models"] = catalog["models"].clone();
                out["presets"] = catalog["presets"].clone();
                out["currentModel"] = catalog["currentModel"].clone();
                out["currentEffort"] = catalog["currentEffort"].clone();
                out["currentPreset"] = catalog["currentPreset"].clone();
            }
            Err(error) => out["error"] = json!(error.to_string()),
        },
        "opencode" => {
            let result = match account_id.as_deref() {
                Some(id) => {
                    profile_launch_catalog(
                        api,
                        id,
                        crate::protocol::AgentKind::Opencode,
                        "OpenCode",
                    )
                    .await
                }
                None => crate::agent::Agents::opencode_launch_catalog().await,
            };
            match result {
                Ok(catalog) => {
                    let catalog = serde_json::to_value(catalog)?;
                    out["models"] = catalog["models"].clone();
                    out["currentModel"] = catalog["currentModel"].clone();
                    out["currentEffort"] = catalog["currentEffort"].clone();
                }
                Err(error) => out["error"] = json!(error.to_string()),
            }
        }
        "codex" => match codex_launch_catalog(api, account_id.as_deref()).await {
            Ok(catalog) => {
                let catalog = serde_json::to_value(catalog)?;
                out["models"] = catalog["models"].clone();
                out["currentModel"] = catalog["currentModel"].clone();
                out["currentEffort"] = catalog["currentEffort"].clone();
            }
            Err(error) => out["error"] = json!(error.to_string()),
        },
        "claude" => {
            let account_id = account_id.or_else(|| Some(crate::accounts::NATIVE_CLAUDE_ID.into()));
            match api.agents.launch_catalog_for(account_id.as_deref()).await {
                Ok(catalog) => {
                    let catalog = serde_json::to_value(catalog)?;
                    out["models"] = catalog["models"].clone();
                    out["currentModel"] = catalog["currentModel"].clone();
                    out["currentEffort"] = catalog["currentEffort"].clone();
                }
                Err(error) => out["error"] = json!(error.to_string()),
            }
        }
        _ => out["error"] = json!("invalid model catalog agent"),
    }
    send_remote_json(socket, channel, &out).await
}

async fn remote_agent_models(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let request_id = require_str(&message, "requestId")?;
    let catalog = api.agents.models(sid).await?;
    let value = serde_json::to_value(catalog)?;
    send_remote_json(
        socket,
        channel,
        &json!({"type":"agent.models","sid":sid,"requestId":request_id,"models":value["models"],"currentModel":value["currentModel"],"currentEffort":value["currentEffort"]}),
    )
    .await
}

async fn remote_agent_modes(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let request_id = require_str(&message, "requestId")?;
    let mode = api.agents.mode(sid).await?;
    let catalog = serde_json::to_value(mode_catalog(mode.label()))?;
    send_remote_json(
        socket,
        channel,
        &json!({"type":"agent.modes","sid":sid,"requestId":request_id,"modes":catalog["modes"],"currentMode":catalog["currentMode"]}),
    )
    .await
}

async fn remote_agent_model_set(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let request_id = require_str(&message, "requestId")?;
    let model = require_str(&message, "model")?.to_owned();
    let effort = message
        .get("effort")
        .and_then(JsonValue::as_str)
        .map(str::to_owned);
    let result = api.agents.set_model(sid, model, effort).await?;
    let result = serde_json::to_value(result)?;
    send_remote_json(
        socket,
        channel,
        &json!({"type":"agent.control.result","sid":sid,"requestId":request_id,"action":"model.set","ok":true,"currentModel":result["currentModel"],"currentEffort":result["currentEffort"]}),
    )
    .await
}

async fn remote_agent_mode_set(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let request_id = require_str(&message, "requestId")?;
    let mode = PermissionMode::from_wire(require_str(&message, "mode")?)?;
    api.agents.set_mode(sid, mode).await?;
    send_remote_json(
        socket,
        channel,
        &json!({"type":"agent.control.result","sid":sid,"requestId":request_id,"action":"mode.set","ok":true,"currentMode":mode.label()}),
    )
    .await
}

async fn remote_agent_compact(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let request_id = require_str(&message, "requestId")?;
    let result = api.agents.compact(sid, request_id).await?;
    send_remote_json(socket, channel, &serde_json::to_value(result)?).await
}

async fn remote_tool_output(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let call_id = require_str(&message, "callId")?.to_owned();
    crate::timeline::validate_record_id(&call_id)?;
    let lookup_sid = sid.clone();
    let lookup_call_id = call_id.clone();
    let output = api
        .database
        .call(move |store| {
            let record = store.timeline_record(&lookup_sid, &lookup_call_id)?;
            if !matches!(record.body, TimelineBody::Tool { .. }) {
                return Err(Error::NotFound);
            }
            let page =
                store.timeline_text(&lookup_sid, &lookup_call_id, TimelineTextQuery::default())?;
            Ok(json!({
                "type":"tool.output",
                "sid": sid,
                "callId": call_id,
                "output": page.text,
                "truncated": page.next_part.is_some(),
            }))
        })
        .await?;
    send_remote_json(socket, channel, &output).await
}

async fn remote_chat_attachment(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let msg_id = require_str(&message, "msgId")?;
    let attachment_id = require_str(&message, "attachmentId")?;
    let request_id = require_str(&message, "requestId")?;
    let offset = message
        .get("offset")
        .and_then(JsonValue::as_u64)
        .unwrap_or(0);
    let length = message
        .get("length")
        .and_then(JsonValue::as_u64)
        .unwrap_or(1024 * 1024)
        .try_into()
        .map_err(|_| Error::Invalid("invalid length".into()))?;
    let Some(chunk) = api
        .agents
        .attachment_chunk(sid, msg_id, attachment_id, offset, length)
        .await?
    else {
        return send_remote_json(
            socket,
            channel,
            &json!({"type":"error","code":"fs_error","message":"图片附件已不可用","sid":sid}),
        )
        .await;
    };
    let chunk = serde_json::to_value(chunk)?;
    send_remote_json(
        socket,
        channel,
        &json!({
            "type":"chat.attachment.chunk",
            "sid":sid,
            "msgId":msg_id,
            "attachmentId":attachment_id,
            "mimeType":chunk["mimeType"],
            "dataB64":chunk["dataB64"],
            "total":chunk["total"],
            "eof":chunk["eof"],
            "requestId":request_id,
        }),
    )
    .await
}

async fn remote_approval_policy_set(api: &Api, message: JsonValue) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let policy = crate::agent::ApprovalPolicy::from_wire(require_str(&message, "policy")?)?;
    api.agents.set_approval_policy(sid, policy).await
}

async fn remote_permission_respond(api: &Api, message: JsonValue) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let request_id = require_str(&message, "reqId")?.to_owned();
    let allow = matches!(
        message.get("reply").and_then(JsonValue::as_str),
        Some("once") | Some("always")
    );
    api.agents.respond_permission(sid, &request_id, allow).await
}

async fn remote_question_respond(api: &Api, message: JsonValue) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let request_id = require_str(&message, "reqId")?;
    let answers = message
        .get("answers")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    let cancelled = message
        .get("cancelled")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    api.agents
        .respond_question(sid, request_id, answers, cancelled)
        .await
}

async fn remote_subagent_send(api: &Api, message: JsonValue) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let subagent = require_str(&message, "subagentId")?;
    let text = require_str(&message, "text")?.to_owned();
    api.agents.send_to_subagent(sid, subagent, text).await
}

async fn remote_subagent_history(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?;
    let subagent = require_str(&message, "subagentId")?;
    let request_id = require_str(&message, "requestId")?;
    let snapshot = api.agents.subagent_snapshot(sid, subagent).await?;
    let mut value = serde_json::to_value(snapshot)?;
    value["type"] = json!("subagent.history.result");
    value["sid"] = json!(sid);
    value["requestId"] = json!(request_id);
    send_remote_json(socket, channel, &value).await
}

async fn remote_usage(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = message
        .get("sid")
        .and_then(JsonValue::as_str)
        .map(str::to_owned);
    let result = if let Some(sid) = sid {
        if let Some(report) = api.agents.usage(&sid).await? {
            UsageResult {
                kind: "usage.result".into(),
                sid: Some(sid),
                available: true,
                reason: if report.windows.is_empty() {
                    Some("这个后端不提供套餐限流窗口。".into())
                } else {
                    None
                },
                report,
                accounts: None,
            }
        } else {
            empty_usage(
                Some(sid),
                false,
                Some("这个会话还没产生用量，发一条消息后再看。".into()),
            )
        }
    } else {
        let accounts = api.agents.account_usage().await?;
        let lead = accounts.first();
        let mut result = if let Some(lead) = lead {
            UsageResult {
                kind: "usage.result".into(),
                sid: None,
                available: accounts.iter().any(|account| account.available),
                report: lead.report.clone(),
                reason: lead.reason.clone(),
                accounts: None,
            }
        } else {
            empty_usage(None, false, None)
        };
        result.accounts = Some(accounts);
        result
    };
    send_remote_json(socket, channel, &serde_json::to_value(result)?).await
}

async fn load_orchestration_snapshot(api: &Api) -> Result<JsonValue> {
    let schedules = api.schedules.status_list_async().await?;
    api.call(move |store| {
        Ok(json!({
            "runs": store.list_runs()?,
            "tasks": store.list_tasks(None)?,
            "dispatches": store.list_dispatches(None)?,
            "gates": store.list_gates(None, None)?,
            "worktreeAssets": store.list_worktree_assets(None)?,
            "schedules": schedules,
        }))
    })
    .await
}

async fn send_orchestration_snapshot(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
) -> Result<()> {
    let snapshot = load_orchestration_snapshot(api).await?;
    send_remote_json(
        socket,
        channel,
        &json!({"type":"orchestration.snapshot","snapshot":snapshot}),
    )
    .await
}

async fn remote_schedule_control(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    device: &DeviceRecord,
    protocol_version: u8,
    message: JsonValue,
) -> Result<()> {
    let request_id = message
        .get("requestId")
        .and_then(JsonValue::as_str)
        .map(str::to_owned);
    if protocol_version < 16 || !device.can_orchestrate() || !device.allow_shell {
        let mut body = json!({
            "type":"error",
            "code":"forbidden",
            "message":"这台设备没有定时任务权限，或 daemon 版本过旧",
        });
        add_request_id(&mut body, request_id.as_deref());
        return send_remote_json(socket, channel, &body).await;
    }
    let kind = require_str(&message, "type")?.to_owned();
    let mut result = match kind.as_str() {
        "schedule.list" => {
            let schedules = api.schedules.status_list_async().await?;
            json!({"type":"schedule.result","ok":true,"schedules":schedules})
        }
        "schedule.get" => {
            let task = api.schedules.get(require_str(&message, "id")?)?;
            json!({"type":"schedule.result","ok":true,"task":task})
        }
        "schedule.create" => {
            let input: ScheduleCreate = serde_json::from_value(schedule_payload(message))?;
            let task = api.schedules.create(input).await?;
            api.publish();
            json!({"type":"schedule.result","ok":true,"task":task})
        }
        "schedule.update" => {
            let input: ScheduleUpdate = serde_json::from_value(schedule_payload(message))?;
            let task = api.schedules.update(input)?;
            api.publish();
            json!({"type":"schedule.result","ok":true,"task":task})
        }
        "schedule.pause" => {
            let task = api.schedules.pause(require_str(&message, "id")?)?;
            api.publish();
            json!({"type":"schedule.result","ok":true,"task":task})
        }
        "schedule.resume" => {
            let task = api.schedules.resume(require_str(&message, "id")?)?;
            api.publish();
            json!({"type":"schedule.result","ok":true,"task":task})
        }
        "schedule.delete" => {
            let result = api.schedules.delete(require_str(&message, "id")?)?;
            api.publish();
            json!({"type":"schedule.result","ok":true,"deleted":result["deleted"] == true})
        }
        "schedule.run" => {
            let result = api.schedules.run_now(require_str(&message, "id")?).await?;
            api.publish();
            json!({"type":"schedule.result","ok":true,"task":result.task,"session":remote_session_info(result.session),"queued":result.queued})
        }
        _ => {
            json!({"type":"schedule.result","ok":false,"error":"unknown schedule operation"})
        }
    };
    add_request_id(&mut result, request_id.as_deref());
    send_remote_json(socket, channel, &result).await
}

fn add_request_id(value: &mut JsonValue, request_id: Option<&str>) {
    if let (Some(object), Some(request_id)) = (value.as_object_mut(), request_id) {
        object.insert("requestId".into(), json!(request_id));
    }
}

fn schedule_payload(mut message: JsonValue) -> JsonValue {
    if let Some(object) = message.as_object_mut() {
        object.remove("type");
        object.remove("requestId");
    }
    message
}

async fn remote_orchestration_control(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    device: &DeviceRecord,
    message: JsonValue,
) -> Result<()> {
    if !device.can_orchestrate() {
        return send_remote_json(
            socket,
            channel,
            &json!({"type":"error","code":"forbidden","message":"这台设备没有人工编排权限"}),
        )
        .await;
    }
    let kind = require_str(&message, "type")?.to_owned();
    let result = match kind.as_str() {
        "orchestration.gate.resolve" => {
            let gate_id = require_str(&message, "gateId")?.to_owned();
            let decision = require_str(&message, "decision")?.to_owned();
            api.call(move |store| store.resolve_gate(&gate_id, &decision).map(|_| ()))
                .await
        }
        "orchestration.run.create" => {
            let objective = require_str(&message, "objective")?.to_owned();
            api.call(move |store| {
                store
                    .create_run(CreateRun {
                        objective,
                        coordinator_session_id: None,
                    })
                    .map(|_| ())
            })
            .await
        }
        "orchestration.run.complete" => {
            let run_id = require_str(&message, "runId")?.to_owned();
            let allow_failed = message
                .get("allowFailedTasks")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false);
            api.call(move |store| store.complete_run(&run_id, allow_failed).map(|_| ()))
                .await
        }
        "orchestration.run.abandon" => {
            let run_id = require_str(&message, "runId")?.to_owned();
            api.call(move |store| store.abandon_run(&run_id, "Run abandoned").map(|_| ()))
                .await
        }
        "orchestration.run.delete" => {
            let run_id = require_str(&message, "runId")?.to_owned();
            let force = message
                .get("force")
                .and_then(JsonValue::as_bool)
                .unwrap_or(false);
            api.call(move |store| store.delete_run(&run_id, force).map(|_| ()))
                .await
        }
        "orchestration.task.create" => {
            let input = CreateTask {
                run_id: require_str(&message, "runId")?.to_owned(),
                title: require_str(&message, "title")?.to_owned(),
                spec: require_str(&message, "spec")?.to_owned(),
                skills: message
                    .get("skills")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?
                    .unwrap_or_default(),
                deps: message
                    .get("deps")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?
                    .unwrap_or_default(),
                parent_id: message
                    .get("parentId")
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned),
            };
            api.call(move |store| store.create_task(input).map(|_| ()))
                .await
        }
        "orchestration.task.cancel" => {
            let task_id = require_str(&message, "taskId")?.to_owned();
            let reason = message
                .get("reason")
                .and_then(JsonValue::as_str)
                .unwrap_or("cancelled by user")
                .to_owned();
            api.call(move |store| store.cancel_task(&task_id, &reason).map(|_| ()))
                .await
        }
        "orchestration.task.retry" => {
            let task_id = require_str(&message, "taskId")?.to_owned();
            api.call(move |store| store.retry_task(&task_id).map(|_| ()))
                .await
        }
        "orchestration.worker.start" => {
            let agent = message
                .get("agent")
                .cloned()
                .map(serde_json::from_value)
                .transpose()?
                .unwrap_or(AgentKind::Claude);
            let input = StartWorker {
                task_id: require_str(&message, "taskId")?.to_owned(),
                agent,
                cwd: require_str(&message, "cwd")?.to_owned(),
                worktree: message
                    .get("worktree")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("new")
                    .to_owned(),
                kind: message
                    .get("kind")
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned),
                skills: message
                    .get("skills")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?
                    .unwrap_or_default(),
                approval_policy: message
                    .get("approvalPolicy")
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned),
                account_id: message
                    .get("accountId")
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned),
                operation_id: message
                    .get("operationId")
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned),
            };
            orchestration::start_worker(&api.database, &api.agents, input)
                .await
                .map(|_| ())
        }
        "orchestration.worker.stop" => {
            let input = StopWorker {
                task_id: require_str(&message, "taskId")?.to_owned(),
                reason: message
                    .get("reason")
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned),
                final_status: message
                    .get("finalStatus")
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned),
            };
            orchestration::stop_worker(&api.database, &api.agents, input)
                .await
                .map(|_| ())
        }
        "orchestration.graph.create" => {
            let input = CreateRunGraph {
                objective: require_str(&message, "objective")?.to_owned(),
                nodes: message
                    .get("nodes")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?
                    .unwrap_or_default(),
                coordinator_session_id: None,
                operation_id: require_str(&message, "operationId")?.to_owned(),
            };
            api.call(move |store| store.create_run_graph(input).map(|_| ()))
                .await
        }
        "orchestration.graph.apply" => {
            let input = ApplyTaskGraph {
                run_id: require_str(&message, "runId")?.to_owned(),
                base_revision: message
                    .get("baseRevision")
                    .and_then(JsonValue::as_i64)
                    .ok_or_else(|| Error::Invalid("missing baseRevision".into()))?,
                nodes: message
                    .get("nodes")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?
                    .unwrap_or_default(),
                delete_task_ids: message
                    .get("deleteTaskIds")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?
                    .unwrap_or_default(),
                operation_id: Some(require_str(&message, "operationId")?.to_owned()),
            };
            api.call(move |store| store.apply_task_graph(input).map(|_| ()))
                .await
        }
        "orchestration.automation.start" => {
            let input = StartAutomation {
                run_id: require_str(&message, "runId")?.to_owned(),
                agent: message
                    .get("agent")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?
                    .unwrap_or(AgentKind::Claude),
                account_id: message
                    .get("accountId")
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned),
                approval_policy: require_str(&message, "approvalPolicy")?.to_owned(),
                workspace: message
                    .get("workspace")
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()?
                    .ok_or_else(|| Error::Invalid("missing workspace".into()))?,
                cwd: require_str(&message, "cwd")?.to_owned(),
            };
            orchestration::start_automation(&api.database, &api.agents, input)
                .await
                .map(|_| ())
        }
        "orchestration.automation.pause" => {
            let run_id = require_str(&message, "runId")?.to_owned();
            orchestration::pause_automation(&api.database, &run_id)
                .await
                .map(|_| ())
        }
        "orchestration.worktree.inspect" => {
            let asset_id = require_str(&message, "assetId")?.to_owned();
            let target_ref = message
                .get("targetRef")
                .and_then(JsonValue::as_str)
                .map(str::to_owned);
            orchestration::inspect_worktree(&api.database, &asset_id, target_ref)
                .await
                .map(|_| ())
        }
        "orchestration.worktree.cleanup" => {
            let asset_id = require_str(&message, "assetId")?.to_owned();
            let request = CleanupWorktree {
                target_ref: message
                    .get("targetRef")
                    .and_then(JsonValue::as_str)
                    .map(str::to_owned),
                confirm: message
                    .get("confirm")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false),
                delete_branch: message
                    .get("deleteBranch")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false),
            };
            orchestration::cleanup_worktree(&api.database, &asset_id, request)
                .await
                .map(|_| ())
        }
        _ => Ok(()),
    };
    match result {
        Ok(()) => {
            api.publish();
            send_orchestration_snapshot(api, socket, channel).await
        }
        Err(error) => send_remote_json(
            socket,
            channel,
            &json!({"type":"error","code":remote_error_code(&error),"message":error.to_string()}),
        )
        .await,
    }
}

async fn remote_conversation_search(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let request_id = require_str(&message, "requestId")?;
    let agent = require_str(&message, "agent")?;
    let query = message
        .get("query")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_owned();
    let limit = message
        .get("limit")
        .and_then(JsonValue::as_u64)
        .map(|v| v as usize);
    let account_id = message
        .get("accountId")
        .and_then(JsonValue::as_str)
        .map(str::to_owned);
    let mut out = json!({"type":"conversation.results","requestId":request_id,"agent":agent,"conversations":[]});
    let conversations = match agent {
        "codex" => {
            crate::agent::conversations::search_codex_conversations(
                &api.database,
                account_id,
                query,
                limit,
            )
            .await
        }
        "claude" => {
            crate::agent::conversations::search_claude_conversations(
                &api.database,
                account_id,
                query,
                limit,
            )
            .await
        }
        "deepseek" => {
            crate::agent::conversations::search_deepseek_conversations(account_id, query, limit)
                .await
        }
        _ => Err(Error::Invalid(
            "Rust daemon 当前仅支持搜索 Claude/Codex/DeepSeek 本机对话".into(),
        )),
    };
    match conversations {
        Ok(conversations) => out["conversations"] = serde_json::to_value(conversations)?,
        Err(error) => out["error"] = json!(error.to_string()),
    }
    send_remote_json(socket, channel, &out).await
}

fn home_dir() -> Result<std::path::PathBuf> {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| Error::Invalid("home directory is unavailable".into()))
}

async fn remote_workspace_list(
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let requested_root = message
        .get("root")
        .and_then(JsonValue::as_str)
        .unwrap_or("home")
        .to_owned();
    let path = message
        .get("path")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_owned();
    let mkdir = message
        .get("mkdir")
        .and_then(JsonValue::as_str)
        .map(str::to_owned);
    let mut out = json!({
        "type":"workspace.listing",
        "root":requested_root,
        "path":path,
        "cwd":"",
        "entries":[],
    });
    let root = match requested_root.as_str() {
        "home" => home_dir()?,
        "computer" if cfg!(windows) => {
            out["entries"] = serde_json::to_value(windows_workspace_drives())?;
            return send_remote_json(socket, channel, &out).await;
        }
        "computer" => {
            out["error"] = json!("computer root is only available on Windows");
            return send_remote_json(socket, channel, &out).await;
        }
        other if cfg!(windows) && other.len() == 2 && other.ends_with(':') => {
            std::path::PathBuf::from(format!("{other}\\"))
        }
        _ => {
            out["error"] = json!("invalid workspace root");
            return send_remote_json(socket, channel, &out).await;
        }
    };
    let cwd = root.join(&path);
    out["cwd"] = json!(cwd.to_string_lossy());
    let result = tokio::task::spawn_blocking(move || {
        if let Some(name) = mkdir {
            let target = if path.is_empty() {
                name
            } else {
                format!("{path}/{name}")
            };
            crate::project::make_dir(&root, &target)?;
        }
        crate::project::list_dir(&root, &path)
    })
    .await
    .map_err(|_| Error::Closed)?;
    match result {
        Ok(entries) => out["entries"] = serde_json::to_value(entries)?,
        Err(error) => out["error"] = json!(error.to_string()),
    }
    send_remote_json(socket, channel, &out).await
}

fn windows_workspace_drives() -> Vec<FsEntry> {
    if !cfg!(windows) {
        return Vec::new();
    }
    (b'A'..=b'Z')
        .map(|letter| format!("{}:", char::from(letter)))
        .filter(|drive| std::path::Path::new(&format!("{drive}\\")).exists())
        .map(|name| FsEntry {
            name,
            kind: "dir".into(),
            size: 0,
            mtime: 0,
        })
        .collect()
}

async fn remote_workspace_summary(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let request_id = require_str(&message, "requestId")?.to_owned();
    let root = session_workspace(api, &sid).await?;
    let value = crate::project::workspace_summary(sid, root, request_id).await?;
    send_remote_json(socket, channel, &serde_json::to_value(value)?).await
}

async fn remote_fs_list(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let path = require_str(&message, "path")?.to_owned();
    let root = session_workspace(api, &sid).await?;
    let response_path = path.clone();
    let entries = tokio::task::spawn_blocking(move || crate::project::list_dir(&root, &path))
        .await
        .map_err(|_| Error::Closed)??;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(FsListing {
            r#type: "fs.listing".into(),
            sid,
            path: response_path,
            entries,
        })?,
    )
    .await
}

async fn remote_fs_read(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let path = require_str(&message, "path")?.to_owned();
    let root = session_workspace(api, &sid).await?;
    let response_path = path.clone();
    let (content, size, truncated, binary) =
        tokio::task::spawn_blocking(move || crate::project::read_for_edit(&root, &path))
            .await
            .map_err(|_| Error::Closed)??;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(FsContent {
            r#type: "fs.content".into(),
            sid,
            path: response_path,
            content_b64: BASE64_STANDARD.encode(content),
            size,
            truncated,
            binary,
        })?,
    )
    .await
}

async fn remote_fs_get(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let path = require_str(&message, "path")?.to_owned();
    let offset = message
        .get("offset")
        .and_then(JsonValue::as_u64)
        .unwrap_or(0);
    let length = message
        .get("length")
        .and_then(JsonValue::as_u64)
        .ok_or_else(|| Error::Invalid("missing length".into()))?;
    let root = session_workspace(api, &sid).await?;
    let response_path = path.clone();
    let (data, total, eof) = tokio::task::spawn_blocking(move || {
        crate::project::read_chunk(&root, &path, offset, length)
    })
    .await
    .map_err(|_| Error::Closed)??;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(FsChunk {
            r#type: "fs.chunk".into(),
            sid,
            path: response_path,
            offset,
            data_b64: BASE64_STANDARD.encode(data),
            total,
            eof,
        })?,
    )
    .await
}

async fn remote_fs_write(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let path = require_str(&message, "path")?.to_owned();
    let content_b64 = require_str(&message, "contentB64")?;
    let content = BASE64_STANDARD
        .decode(content_b64)
        .map_err(|_| Error::Invalid("invalid base64".into()))?;
    let create_new = message
        .get("createNew")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let expected_version = message
        .get("expectedVersion")
        .and_then(JsonValue::as_str)
        .map(str::to_owned);
    let root = session_workspace(api, &sid).await?;
    let response_path = path.clone();
    let size = tokio::task::spawn_blocking(move || {
        crate::project::write_file_at(&root, &path, content, create_new, expected_version)
    })
    .await
    .map_err(|_| Error::Closed)??;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(FsWritten {
            r#type: "fs.written".into(),
            sid,
            path: response_path,
            size,
        })?,
    )
    .await
}

async fn remote_fs_put(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let path = require_str(&message, "path")?.to_owned();
    let offset = message
        .get("offset")
        .and_then(JsonValue::as_u64)
        .unwrap_or(0);
    let data = BASE64_STANDARD
        .decode(require_str(&message, "dataB64")?)
        .map_err(|_| Error::Invalid("invalid base64".into()))?;
    let root = session_workspace(api, &sid).await?;
    let response_path = path.clone();
    let size = tokio::task::spawn_blocking(move || {
        crate::project::write_chunk(&root, &path, offset, data)
    })
    .await
    .map_err(|_| Error::Closed)??;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(FsWritten {
            r#type: "fs.written".into(),
            sid,
            path: response_path,
            size,
        })?,
    )
    .await
}

async fn remote_fs_mkdir(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let path = require_str(&message, "path")?.to_owned();
    let root = session_workspace(api, &sid).await?;
    let response_path = path.clone();
    tokio::task::spawn_blocking(move || crate::project::make_dir(&root, &path))
        .await
        .map_err(|_| Error::Closed)??;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(FsDone {
            r#type: "fs.done".into(),
            sid,
            path: response_path,
            op: "mkdir".into(),
        })?,
    )
    .await
}

async fn remote_fs_remove(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let path = require_str(&message, "path")?.to_owned();
    let root = session_workspace(api, &sid).await?;
    let response_path = path.clone();
    tokio::task::spawn_blocking(move || crate::project::remove_entry(&root, &path))
        .await
        .map_err(|_| Error::Closed)??;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(FsDone {
            r#type: "fs.done".into(),
            sid,
            path: response_path,
            op: "remove".into(),
        })?,
    )
    .await
}

async fn remote_fs_rename(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let path = require_str(&message, "path")?.to_owned();
    let to = require_str(&message, "to")?.to_owned();
    let root = session_workspace(api, &sid).await?;
    let response_path = path.clone();
    tokio::task::spawn_blocking(move || crate::project::rename_entry(&root, &path, &to))
        .await
        .map_err(|_| Error::Closed)??;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(FsDone {
            r#type: "fs.done".into(),
            sid,
            path: response_path,
            op: "rename".into(),
        })?,
    )
    .await
}

async fn remote_git_status(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let root = session_workspace(api, &sid).await?;
    let value = crate::project::git_status(sid, root).await?;
    send_remote_json(socket, channel, &serde_json::to_value(value)?).await
}

async fn remote_git_diff(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let path = require_str(&message, "path")?.to_owned();
    let staged = message
        .get("staged")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let root = session_workspace(api, &sid).await?;
    let value = crate::project::git_diff(sid, root, path, staged).await?;
    send_remote_json(socket, channel, &serde_json::to_value(value)?).await
}

async fn remote_git_history(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let root = session_workspace(api, &sid).await?;
    let value = crate::project::git_history(sid, root).await?;
    send_remote_json(socket, channel, &serde_json::to_value(value)?).await
}

async fn remote_git_stage(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let paths: Vec<String> = serde_json::from_value(
        message
            .get("paths")
            .cloned()
            .ok_or_else(|| Error::Invalid("missing paths".into()))?,
    )?;
    let unstage = message
        .get("unstage")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let root = session_workspace(api, &sid).await?;
    crate::project::git_stage(root, paths, unstage).await?;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(GitDone {
            r#type: "git.done".into(),
            sid,
            op: if unstage { "unstage" } else { "stage" }.into(),
            detail: None,
        })?,
    )
    .await
}

async fn remote_git_discard(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let path = require_str(&message, "path")?.to_owned();
    let root = session_workspace(api, &sid).await?;
    crate::project::git_discard(root, path).await?;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(GitDone {
            r#type: "git.done".into(),
            sid,
            op: "discard".into(),
            detail: None,
        })?,
    )
    .await
}

async fn remote_git_commit(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let commit_message = require_str(&message, "message")?.to_owned();
    let root = session_workspace(api, &sid).await?;
    let detail = crate::project::git_commit(root, commit_message).await?;
    send_remote_json(
        socket,
        channel,
        &serde_json::to_value(GitDone {
            r#type: "git.done".into(),
            sid,
            op: "commit".into(),
            detail: Some(detail),
        })?,
    )
    .await
}

async fn remote_session_create(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    device: &DeviceRecord,
    message: JsonValue,
) -> Result<()> {
    let request_id = message
        .get("requestId")
        .and_then(JsonValue::as_str)
        .map(str::to_owned);
    let created = async {
        let agent: AgentKind = serde_json::from_value(
            message
                .get("agent")
                .cloned()
                .ok_or_else(|| Error::Invalid("missing agent".into()))?,
        )?;
        let kind = message
            .get("kind")
            .cloned()
            .map(serde_json::from_value::<SessionKind>)
            .transpose()?;
        let cwd = message
            .get("cwd")
            .and_then(JsonValue::as_str)
            .unwrap_or(".")
            .to_owned();
        let title = std::path::Path::new(&cwd)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Prospero")
            .to_owned();
        if kind == Some(SessionKind::Pty) || matches!(agent, AgentKind::Shell | AgentKind::Custom) {
            if !device.allow_shell {
                return Err(Error::Feature(
                    "shell_not_allowed".into(),
                    "shell access is not allowed".into(),
                ));
            }
            let cols = message
                .get("cols")
                .and_then(JsonValue::as_u64)
                .unwrap_or(80) as u16;
            let rows = message
                .get("rows")
                .and_then(JsonValue::as_u64)
                .unwrap_or(24) as u16;
            let head = api
                .terminals
                .create(CreateTerminal {
                    title,
                    workspace: cwd,
                    size: crate::terminal::validate_size(TerminalSize { cols, rows })?,
                    agent: Some(agent),
                    command: message
                        .get("command")
                        .and_then(JsonValue::as_str)
                        .map(str::to_owned),
                    account_id: message
                        .get("accountId")
                        .and_then(JsonValue::as_str)
                        .map(str::to_owned),
                    model: message
                        .get("model")
                        .and_then(JsonValue::as_str)
                        .map(str::to_owned),
                    effort: message
                        .get("effort")
                        .and_then(JsonValue::as_str)
                        .map(str::to_owned),
                })
                .await?;
            Ok(head)
        } else {
            api.agents
                .create(CreateAgentSession {
                    agent,
                    title,
                    workspace: cwd,
                    auto_approve: matches!(
                        message.get("approvalPolicy").and_then(JsonValue::as_str),
                        Some("always" | "yolo" | "auto")
                    ),
                    mode: message
                        .get("mode")
                        .and_then(JsonValue::as_str)
                        .map(str::to_owned),
                    model: message
                        .get("model")
                        .and_then(JsonValue::as_str)
                        .map(str::to_owned),
                    effort: message
                        .get("effort")
                        .and_then(JsonValue::as_str)
                        .map(str::to_owned),
                    agent_preset: message
                        .get("agentPreset")
                        .and_then(JsonValue::as_str)
                        .map(str::to_owned),
                    account_id: message
                        .get("accountId")
                        .and_then(JsonValue::as_str)
                        .map(str::to_owned),
                    resume: message
                        .get("resume")
                        .cloned()
                        .map(serde_json::from_value)
                        .transpose()?,
                })
                .await
        }
    }
    .await;
    match (request_id, created) {
        (Some(request_id), Ok(head)) => {
            let session = remote_session_info(head);
            send_remote_json(
                socket,
                channel,
                &json!({"type":"session.create.result","requestId":request_id,"ok":true,"session":session}),
            )
            .await
        }
        (Some(request_id), Err(error)) => {
            send_remote_json(
                socket,
                channel,
                &json!({"type":"session.create.result","requestId":request_id,"ok":false,"error":error.to_string(),"code":remote_error_code(&error)}),
            )
            .await
        }
        (None, Ok(head)) => {
            send_remote_json(
                socket,
                channel,
                &json!({"type":"session.state","session":remote_session_info(head)}),
            )
            .await
        }
        (None, Err(error)) => Err(error),
    }
}

async fn remote_session_attach(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    state: &mut RemoteWsState,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let last_seq = message.get("lastSeq").and_then(JsonValue::as_i64);
    if remote_try_pty_attach(api, socket, channel, state, &sid, last_seq).await? {
        return Ok(());
    }
    remote_chat_attach(api, socket, channel, state, message).await
}

async fn remote_try_pty_attach(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    state: &mut RemoteWsState,
    sid: &str,
    last_seq: Option<i64>,
) -> Result<bool> {
    let page = match api
        .terminals
        .read(
            sid.to_owned(),
            TerminalQuery {
                after_seq: Some(last_seq.unwrap_or(0)),
                wait_ms: None,
            },
        )
        .await
    {
        Ok(page) => page,
        Err(Error::NotFound) => return Ok(false),
        Err(error) => return Err(error),
    };
    state.pty_attachments.insert(
        sid.to_owned(),
        RemotePtyAttachment {
            last_sent_seq: last_seq.unwrap_or(0),
            last_ack_seq: last_seq.unwrap_or(0),
        },
    );
    if last_seq.is_some() && !page.resync_required {
        send_terminal_page(socket, channel, sid, &page).await?;
        if let Some(att) = state.pty_attachments.get_mut(sid) {
            att.last_sent_seq = page.next_seq.max(page.latest_seq);
        }
        return Ok(true);
    }
    send_terminal_snapshot(api, socket, channel, state, sid).await?;
    Ok(true)
}

async fn send_terminal_snapshot(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    state: &mut RemoteWsState,
    sid: &str,
) -> Result<()> {
    if let Some(snapshot) = api.terminals.snapshot(sid.to_owned()).await? {
        send_remote_json(
            socket,
            channel,
            &json!({
                "type":"term.snapshot",
                "sid":sid,
                "ansi":"",
                "dataB64": snapshot.data_b64,
                "seq":snapshot.seq,
                "cols":snapshot.size.cols,
                "rows":snapshot.size.rows,
            }),
        )
        .await?;
        if let Some(att) = state.pty_attachments.get_mut(sid) {
            att.last_sent_seq = snapshot.seq;
        }
        if let Ok(page) = api
            .terminals
            .read(
                sid.to_owned(),
                TerminalQuery {
                    after_seq: Some(snapshot.seq),
                    wait_ms: None,
                },
            )
            .await
            && !page.resync_required
        {
            send_terminal_page(socket, channel, sid, &page).await?;
            if let Some(att) = state.pty_attachments.get_mut(sid) {
                att.last_sent_seq = page.next_seq.max(page.latest_seq);
            }
        }
    } else {
        let page = api
            .terminals
            .read(sid.to_owned(), TerminalQuery::default())
            .await?;
        let data_b64 = terminal_page_output_b64(&page)?;
        send_remote_json(
            socket,
            channel,
            &json!({
                "type":"term.snapshot",
                "sid":sid,
                "ansi":"",
                "dataB64": data_b64,
                "seq":page.latest_seq,
                "cols":page.initial_size.cols,
                "rows":page.initial_size.rows,
            }),
        )
        .await?;
        if let Some(att) = state.pty_attachments.get_mut(sid) {
            att.last_sent_seq = page.latest_seq;
        }
    }
    Ok(())
}

async fn send_terminal_page(
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    sid: &str,
    page: &TerminalPage,
) -> Result<()> {
    let data_b64 = terminal_page_output_b64(page)?;
    if !data_b64.is_empty() {
        send_remote_json(
            socket,
            channel,
            &json!({"type":"term.output","sid":sid,"dataB64":data_b64,"seq":page.next_seq}),
        )
        .await?;
    }
    Ok(())
}

fn terminal_page_output_b64(page: &TerminalPage) -> Result<String> {
    let mut bytes = Vec::new();
    for event in &page.events {
        if let TerminalEvent::Output { data_b64 } = event {
            bytes.extend(
                BASE64_STANDARD
                    .decode(data_b64)
                    .map_err(|_| Error::Invalid("terminal output encoding is invalid".into()))?,
            );
        }
    }
    Ok(BASE64_STANDARD.encode(bytes))
}

fn timeline_text_or_preview(store: &mut Store, sid: &str, record: &TimelineRecord) -> String {
    store
        .timeline_text(sid, &record.id, TimelineTextQuery::default())
        .map(|page| page.text)
        .unwrap_or_else(|_| record.preview.clone())
}

fn timeline_record_events(store: &mut Store, sid: &str, record: &TimelineRecord) -> Vec<JsonValue> {
    match &record.body {
        TimelineBody::Message {
            role,
            final_answer,
            attachments,
        } => {
            let text = timeline_text_or_preview(store, sid, record);
            if *role == MessageRole::User {
                vec![json!({
                    "kind":"user.message",
                    "msgId":record.id,
                    "text":text,
                    "attachments":attachments,
                })]
            } else {
                vec![json!({
                    "kind":"text.delta",
                    "msgId":record.id,
                    "textId":record.id,
                    "delta":text,
                    "replace":true,
                    "phase": if *final_answer { "final_answer" } else { "commentary" },
                })]
            }
        }
        TimelineBody::Reasoning => vec![json!({
            "kind":"reasoning.delta",
            "msgId":record.id,
            "delta":timeline_text_or_preview(store, sid, record),
        })],
        TimelineBody::Tool {
            name,
            state,
            summary,
            diff,
            has_more,
        } => {
            let state_wire = match state {
                ToolState::Running => "running",
                ToolState::Success => "success",
                ToolState::Failed => "failed",
            };
            let mut events = vec![json!({
                "kind":"tool.start",
                "msgId":record.turn_id,
                "callId":record.id,
                "tool":name,
                "summary":summary,
                "diff":diff,
            })];
            if *state != ToolState::Running {
                events.push(json!({
                    "kind":"tool.end",
                    "callId":record.id,
                    "state":state_wire,
                    "summary":summary,
                    "hasMore":has_more,
                    "diff":diff,
                }));
            }
            events
        }
        TimelineBody::PermissionRequest {
            request_id,
            tool,
            resolved,
            ..
        } => {
            if *resolved {
                vec![json!({"kind":"permission.resolved","reqId":request_id,"reply":"once"})]
            } else {
                vec![json!({
                    "kind":"permission.request",
                    "reqId":request_id,
                    "action":tool,
                    "resources":[],
                    "summary":record.preview,
                })]
            }
        }
        TimelineBody::Question {
            request_id,
            questions,
            resolved,
            ..
        } => {
            if *resolved {
                vec![
                    json!({"kind":"question.resolved","reqId":request_id,"answers":[],"cancelled":true}),
                ]
            } else {
                vec![json!({"kind":"question.request","reqId":request_id,"questions":questions})]
            }
        }
        TimelineBody::TurnEnd { finish, diffs } => vec![json!({
            "kind":"turn.end",
            "msgId":record.id,
            "turnId":record.turn_id,
            "finish":finish,
            "diffs":diffs,
        })],
        TimelineBody::Subagent {
            subagent_id,
            name,
            role,
            task,
            status,
            can_message,
            summary,
            created_at,
            updated_at,
        } => vec![json!({
            "kind":"subagent.started",
            "subagent":{
                "id":subagent_id,
                "name":name,
                "role":role,
                "task":task,
                "status":status,
                "canMessage":can_message,
                "createdAt":created_at,
                "updatedAt":updated_at,
                "preview":summary,
            }
        })],
        TimelineBody::Error => vec![json!({
            "kind":"agent.error",
            "message":timeline_text_or_preview(store, sid, record),
        })],
    }
}

async fn load_remote_timeline_events(
    api: &Api,
    sid: &str,
    after: Option<i64>,
) -> Result<(i64, Vec<JsonValue>)> {
    let sid = sid.to_owned();
    api.call(move |store| {
        let mut cursor = Some(after.unwrap_or(0));
        let mut events = Vec::new();
        loop {
            let page = store.timeline(
                &sid,
                TimelineQuery {
                    after: cursor,
                    limit: Some(100),
                    ..TimelineQuery::default()
                },
            )?;
            let latest = page.latest_position;
            if page.items.is_empty() {
                return Ok((latest, events));
            }
            cursor = page.items.last().map(|record| record.position);
            for record in &page.items {
                events.extend(timeline_record_events(store, &sid, record));
            }
            if page.newer.is_none() {
                return Ok((latest, events));
            }
        }
    })
    .await
}

async fn remote_chat_attach(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    state: &mut RemoteWsState,
    message: JsonValue,
) -> Result<()> {
    let sid = require_str(&message, "sid")?.to_owned();
    let last_seq = message.get("lastSeq").and_then(JsonValue::as_i64);
    let (latest, events) = load_remote_timeline_events(api, &sid, last_seq).await?;
    let mut ev_seq = last_seq.unwrap_or(latest);
    if last_seq.is_some() {
        for body in &events {
            ev_seq += 1;
            send_remote_json(
                socket,
                channel,
                &json!({"type":"agent.event","sid":sid,"evSeq":ev_seq,"body":body}),
            )
            .await?;
        }
    } else {
        send_remote_json(
            socket,
            channel,
            &json!({"type":"chat.snapshot","sid":sid,"evSeq":latest,"events":events}),
        )
        .await?;
    }
    state.chat_attachments.insert(
        sid,
        RemoteChatAttachment {
            cursor_position: latest,
            last_event_seq: ev_seq.max(latest),
        },
    );
    Ok(())
}

async fn flush_remote_ws_changes(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    state: &mut RemoteWsState,
) -> Result<()> {
    flush_remote_session_states(api, socket, channel, state).await?;
    flush_remote_orchestration_snapshot(api, socket, channel, state).await?;
    flush_remote_chat_events(api, socket, channel, state).await?;
    flush_remote_terminal_events(api, socket, channel, state).await
}

async fn flush_remote_session_states(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    state: &mut RemoteWsState,
) -> Result<()> {
    let page = api
        .call(|store| {
            store.sessions(SessionQuery {
                limit: Some(100),
                lifecycle: Some(SessionLifecycle::Active),
                ..SessionQuery::default()
            })
        })
        .await?;
    let mut seen = HashSet::new();
    for head in page.items {
        seen.insert(head.id.clone());
        let revision = head.revision;
        if state
            .session_revisions
            .get(&head.id)
            .is_none_or(|previous| *previous != revision)
        {
            state.session_revisions.insert(head.id.clone(), revision);
            send_remote_json(
                socket,
                channel,
                &json!({"type":"session.state","session":remote_session_info(head)}),
            )
            .await?;
        }
    }
    state.session_revisions.retain(|sid, _| {
        seen.contains(sid)
            || state.pty_attachments.contains_key(sid)
            || state.chat_attachments.contains_key(sid)
    });
    Ok(())
}

async fn flush_remote_orchestration_snapshot(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    state: &mut RemoteWsState,
) -> Result<()> {
    let Some(previous) = state.orchestration_snapshot.clone() else {
        return Ok(());
    };
    let snapshot = load_orchestration_snapshot(api).await?;
    let serialized = serde_json::to_string(&snapshot)?;
    if serialized != previous {
        send_remote_json(
            socket,
            channel,
            &json!({"type":"orchestration.snapshot","snapshot":snapshot}),
        )
        .await?;
        state.orchestration_snapshot = Some(serialized);
    }
    Ok(())
}

async fn flush_remote_chat_events(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    state: &mut RemoteWsState,
) -> Result<()> {
    let attached: Vec<(String, i64, i64)> = state
        .chat_attachments
        .iter()
        .map(|(sid, att)| (sid.clone(), att.cursor_position, att.last_event_seq))
        .collect();
    for (sid, cursor_position, last_event_seq) in attached {
        let page = match load_remote_timeline_events(api, &sid, Some(cursor_position)).await {
            Ok(page) => page,
            Err(Error::NotFound) => {
                state.chat_attachments.remove(&sid);
                continue;
            }
            Err(error) => return Err(error),
        };
        let (latest, bodies) = page;
        if bodies.is_empty() {
            state.chat_attachments.insert(
                sid,
                RemoteChatAttachment {
                    cursor_position: latest,
                    last_event_seq: last_event_seq.max(latest),
                },
            );
            continue;
        }
        let mut ev_seq = last_event_seq;
        for body in bodies {
            ev_seq += 1;
            send_remote_json(
                socket,
                channel,
                &json!({"type":"agent.event","sid":sid,"evSeq":ev_seq,"body":body}),
            )
            .await?;
        }
        state.chat_attachments.insert(
            sid,
            RemoteChatAttachment {
                cursor_position: latest,
                last_event_seq: ev_seq.max(latest),
            },
        );
    }
    Ok(())
}

async fn flush_remote_terminal_events(
    api: &Api,
    socket: &mut WebSocket,
    channel: &mut SecureChannel,
    state: &mut RemoteWsState,
) -> Result<()> {
    let attached: Vec<(String, i64)> = state
        .pty_attachments
        .iter()
        .map(|(sid, att)| (sid.clone(), att.last_sent_seq))
        .collect();
    for (sid, last_seq) in attached {
        let page = match api
            .terminals
            .read(
                sid.clone(),
                TerminalQuery {
                    after_seq: Some(last_seq),
                    wait_ms: None,
                },
            )
            .await
        {
            Ok(page) => page,
            Err(Error::NotFound) => {
                state.pty_attachments.remove(&sid);
                continue;
            }
            Err(error) => return Err(error),
        };
        if page.resync_required {
            send_terminal_snapshot(api, socket, channel, state, &sid).await?;
            continue;
        }
        send_terminal_page(socket, channel, &sid, &page).await?;
        if let Some(att) = state.pty_attachments.get_mut(&sid) {
            att.last_sent_seq = page.next_seq.max(page.latest_seq);
        }
    }
    Ok(())
}

fn require_str<'a>(value: &'a JsonValue, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(JsonValue::as_str)
        .ok_or_else(|| Error::Invalid(format!("missing {key}")))
}

fn require_u16(value: &JsonValue, key: &str) -> Result<u16> {
    let raw = value
        .get(key)
        .and_then(JsonValue::as_u64)
        .ok_or_else(|| Error::Invalid(format!("missing {key}")))?;
    u16::try_from(raw).map_err(|_| Error::Invalid(format!("invalid {key}")))
}

fn remote_error_code(error: &Error) -> &'static str {
    match error {
        Error::NotFound => "session_not_found",
        Error::Feature(code, _) if code == "shell_not_allowed" => "shell_not_allowed",
        _ => "bad_message",
    }
}

async fn health(State(api): State<Api>) -> std::result::Result<Json<Health>, ApiError> {
    api.terminals.check()?;
    api.agents.check()?;
    let database = api.database.health();
    let relay = match api
        .relay_status
        .get()
        .filter(|status| status.state != crate::relay::RelayConnectionState::Disabled)
    {
        Some(status) => Some(status),
        None => {
            let home = api.database.directory().to_owned();
            tokio::task::spawn_blocking(move || crate::relay::relay_status_from_home(&home, false))
                .await
                .map_err(|_| ApiError(Error::Closed))?
        }
    };
    let mut capabilities = health_capabilities();
    if api.terminals.detached() {
        capabilities.push("terminal.detached-host.v1".into());
    }
    Ok(Json(Health {
        api_version: API_VERSION,
        backend: "rust".into(),
        daemon_version: env!("CARGO_PKG_VERSION").into(),
        build_id: api.build_id.to_string(),
        active_runtime_sessions: api.terminals.count() + api.agents.count(),
        database_queue_capacity: DATABASE_QUEUE_CAPACITY,
        database: DatabaseHealth {
            alive: database.alive,
            queue_depth: database.queue_depth,
            last_error: database.last_error,
        },
        capabilities,
        persistence: HealthPersistence {
            pty: api.terminals.detached(),
            structured: true,
        },
        relay,
    }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingPayload {
    v: u8,
    name: String,
    addrs: Vec<String>,
    port: u16,
    token: String,
    #[serde(rename = "pubKey")]
    pub_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    relay: Option<PairingRelay>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingRelay {
    v: u8,
    url: String,
    route_id: String,
    device_id: String,
    token: String,
}

fn device_view(device: &DeviceRecord) -> DeviceView {
    DeviceView {
        id: pairing::device_id(device),
        name: device.name.clone(),
        allow_shell: device.allow_shell,
        allow_orchestration: device.can_orchestrate(),
        bound: device.client_pub_key.is_some(),
        relay_ready: crate::relay::device_relay_credentials(device).is_some(),
        created_at: device.created_at,
        last_seen_at: device.last_seen_at,
    }
}

async fn device_list(State(api): State<Api>) -> std::result::Result<Json<DeviceList>, ApiError> {
    let _guard = api.remote_config.lock().await;
    let items = pairing::load_devices(api.database.directory())?
        .iter()
        .map(device_view)
        .collect();
    Ok(Json(DeviceList { items }))
}

async fn device_revoke(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<DeviceRevoked>, ApiError> {
    if !valid_remote_id(&id) {
        return Err(ApiError(Error::Invalid("invalid device id".into())));
    }
    let _guard = api.remote_config.lock().await;
    if pairing::revoke_device(api.database.directory(), &id)?.is_none() {
        return Err(ApiError(Error::NotFound));
    }
    api.publish();
    Ok(Json(DeviceRevoked { ok: true, id }))
}

async fn pairing_create(
    State(api): State<Api>,
    Json(input): Json<PairingCreate>,
) -> std::result::Result<Json<PairingCreated>, ApiError> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err(ApiError(Error::Invalid("invalid device name".into())));
    }
    if input.allow_orchestration && !input.allow_shell {
        return Err(ApiError(Error::Invalid(
            "orchestration requires shell access".into(),
        )));
    }
    let _guard = api.remote_config.lock().await;
    let home = api.database.directory();
    let identity = pairing::load_or_create_identity(home)?;
    let config = crate::relay::load_daemon_relay_config(home)?;
    let port = config.port.unwrap_or(7423);
    if port == 0 {
        return Err(ApiError(Error::Invalid("daemon port is invalid".into())));
    }
    let relay_enabled = config.relay.as_ref().is_some_and(|relay| relay.enabled);
    if relay_enabled {
        let url = crate::relay::effective_relay_url(&config)
            .ok_or_else(|| ApiError(Error::Invalid("relay configuration incomplete".into())))?;
        let secret = config
            .relay
            .as_ref()
            .and_then(|relay| relay.host_secret.as_deref())
            .filter(|secret| !secret.is_empty())
            .ok_or_else(|| ApiError(Error::Invalid("relay configuration incomplete".into())))?;
        crate::relay::validate_relay_url(&url, api.dev_mode)?;
        crate::relay::derive_relay_route_id(secret)?;
    }
    let addrs = pairing::pairing_addrs(config.bind.as_deref())?;
    let device = pairing::mint_device(
        home,
        name.to_owned(),
        input.allow_shell,
        input.allow_orchestration,
    )?;
    let issued = if relay_enabled {
        pairing::issue_relay_credentials(&device)
    } else {
        device.clone()
    };
    let relay = pairing_relay(&config, &issued, api.dev_mode)?;
    if addrs.is_empty() && relay.is_none() {
        let _ = pairing::revoke_device(home, &pairing::device_id(&device));
        return Err(ApiError(Error::Invalid(
            "at least one direct address or relay is required".into(),
        )));
    }
    let payload = PairingPayload {
        v: 7,
        name: pairing::host_name(),
        addrs,
        port,
        token: issued.token.clone(),
        pub_key: identity.public_key,
        relay,
    };
    let bytes = serde_json::to_vec(&payload).map_err(Error::from)?;
    let uri = format!("prospero://pair?d={}", BASE64_URL_SAFE_NO_PAD.encode(bytes));
    if payload.relay.is_some()
        && let Err(error) = pairing::persist_relay_credentials(home, &issued)
    {
        let _ = pairing::revoke_device(home, &pairing::device_id(&device));
        return Err(ApiError(error));
    }
    api.publish();
    Ok(Json(PairingCreated {
        device: device_view(&issued),
        uri,
    }))
}

fn pairing_relay(
    config: &crate::relay::DaemonRelayConfig,
    device: &DeviceRecord,
    dev_mode: bool,
) -> Result<Option<PairingRelay>> {
    let Some(relay) = config.relay.as_ref().filter(|relay| relay.enabled) else {
        return Ok(None);
    };
    let Some(host_secret) = relay
        .host_secret
        .as_deref()
        .filter(|secret| !secret.is_empty())
    else {
        return Ok(None);
    };
    let Some(url) = crate::relay::effective_relay_url(config) else {
        return Ok(None);
    };
    let (Some(device_id), Some(token)) =
        (device.relay_device_id.clone(), device.relay_token.clone())
    else {
        return Ok(None);
    };
    crate::relay::validate_relay_url(&url, dev_mode)?;
    Ok(Some(PairingRelay {
        v: crate::relay::RELAY_PROTOCOL_VERSION,
        url,
        route_id: crate::relay::derive_relay_route_id(host_secret)?,
        device_id,
        token,
    }))
}

async fn relay_get(State(api): State<Api>) -> std::result::Result<Json<RelayView>, ApiError> {
    let _guard = api.remote_config.lock().await;
    Ok(Json(relay_view(&api)?))
}

async fn relay_update(
    State(api): State<Api>,
    Json(input): Json<RelayUpdate>,
) -> std::result::Result<Json<RelayView>, ApiError> {
    if input.enabled.is_none() && input.url.is_none() && !input.rotate_key {
        return Err(ApiError(Error::Invalid("empty relay update".into())));
    }
    let _guard = api.remote_config.lock().await;
    let home = api.database.directory();
    let config = crate::relay::load_daemon_relay_config(home)?;
    let previous = config.relay.as_ref();
    let enabled = input
        .enabled
        .unwrap_or_else(|| previous.is_some_and(|relay| relay.enabled));
    let configured_url = match input.url.as_deref() {
        Some(url) => {
            let url = url.trim();
            (!url.is_empty()).then(|| url.to_owned())
        }
        None => previous.and_then(|relay| relay.url.clone()),
    };
    let effective_url = configured_url.clone().or_else(|| {
        std::env::var("PROSPERO_DEFAULT_RELAY_URL")
            .ok()
            .filter(|url| !url.is_empty())
    });
    if enabled {
        crate::relay::validate_relay_url(
            effective_url
                .as_deref()
                .ok_or_else(|| Error::Invalid("relay configuration incomplete".into()))?,
            api.dev_mode,
        )?;
    }
    let host_secret = if input.rotate_key {
        pairing::clear_relay_credentials(home)?;
        Some(crate::relay::generate_relay_host_secret())
    } else {
        previous
            .and_then(|relay| relay.host_secret.clone())
            .filter(|secret| !secret.is_empty())
            .or_else(|| enabled.then(crate::relay::generate_relay_host_secret))
    };
    crate::relay::save_relay_config_raw(home, enabled, configured_url, host_secret)?;
    let saved = crate::relay::load_daemon_relay_config(home)?;
    let devices = pairing::load_devices(home)?;
    api.relay_status.set(crate::relay::relay_status_from_config(
        &saved,
        &devices,
        api.dev_mode,
    ));
    api.publish();
    Ok(Json(relay_view(&api)?))
}

fn relay_view(api: &Api) -> Result<RelayView> {
    let home = api.database.directory();
    let config = crate::relay::load_daemon_relay_config(home)?;
    let devices = pairing::load_devices(home)?;
    let mut runtime = api
        .relay_status
        .get()
        .unwrap_or_else(|| crate::relay::relay_status_from_config(&config, &devices, api.dev_mode));
    let credential_ready = devices
        .iter()
        .filter(|device| crate::relay::device_relay_credentials(device).is_some())
        .count();
    runtime.devices.total = devices.len();
    runtime.devices.ready = runtime.devices.ready.min(credential_ready);
    runtime.devices.needs_re_pair = devices.len().saturating_sub(credential_ready);
    Ok(RelayView {
        configured_url: config.relay.as_ref().and_then(|relay| relay.url.clone()),
        effective_url: crate::relay::effective_relay_url(&config),
        re_pair_required: runtime.devices.needs_re_pair > 0,
        runtime,
    })
}

fn valid_remote_id(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn health_capabilities() -> Vec<String> {
    [
        "session.metadata",
        "session.search",
        "session.summary",
        "session.lookup",
        "session.workspace.page",
        "workspace.page",
        "session.content",
        "session.timeline",
        "agent.claude",
        "orchestration.dag",
        "terminal.pty",
        #[cfg(unix)]
        "terminal.unix",
        #[cfg(windows)]
        "terminal.windows.conpty",
        #[cfg(windows)]
        "terminal.windows.direct",
        "terminal.output.page",
        "terminal.snapshot",
        "events.replay",
        "events.stream",
        "agent.account.api.models",
        "agent.account.config",
        "agent.api-validation.v1",
        "agent.api-engine-validation.v1",
        "agent.api-protocols.v1",
        "conversation.search.v1",
        "chat.attachment-previews.v1",
        "agent.deepseek-harness.v1",
        "model.sources.v1",
        "orchestration.automation.v1",
        "scheduled-agents.v1",
        "session.workspace.summary",
        "session.fs",
        "session.git",
        "relay.host.v1",
    ]
    .map(str::to_owned)
    .to_vec()
}

fn load_notify_config(home: &FsPath) -> Option<NotifyConfig> {
    let raw = std::fs::read_to_string(home.join("config.json")).ok()?;
    serde_json::from_str::<RuntimeConfig>(&raw)
        .ok()
        .and_then(|config| config.notify)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversationSearchQuery {
    agent: String,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

async fn conversation_search(
    State(api): State<Api>,
    Query(query): Query<ConversationSearchQuery>,
) -> std::result::Result<Json<crate::agent::ConversationSearchResult>, ApiError> {
    if query.agent != "claude" && query.agent != "codex" && query.agent != "deepseek" {
        return Err(ApiError(Error::Invalid(
            "Rust daemon 当前仅支持搜索 Claude/Codex/DeepSeek 本机对话".into(),
        )));
    }
    if query.query.chars().count() > 300 || query.query.chars().any(char::is_control) {
        return Err(ApiError(Error::Invalid("对话搜索词无效".into())));
    }
    if query.limit.is_some_and(|limit| !(1..=50).contains(&limit)) {
        return Err(ApiError(Error::Invalid("对话搜索数量无效".into())));
    }
    let _permit = api.requests.acquire().await.map_err(|_| Error::Closed)?;
    let (agent, conversations) = match query.agent.as_str() {
        "codex" => (
            crate::protocol::AgentKind::Codex,
            crate::agent::conversations::search_codex_conversations(
                &api.database,
                query.account_id,
                query.query,
                query.limit,
            )
            .await?,
        ),
        "deepseek" => (
            crate::protocol::AgentKind::Deepseek,
            crate::agent::conversations::search_deepseek_conversations(
                query.account_id,
                query.query,
                query.limit,
            )
            .await?,
        ),
        _ => (
            crate::protocol::AgentKind::Claude,
            crate::agent::conversations::search_claude_conversations(
                &api.database,
                query.account_id,
                query.query,
                query.limit,
            )
            .await?,
        ),
    };
    Ok(Json(crate::agent::ConversationSearchResult {
        agent,
        conversations,
    }))
}

async fn create_agent(
    State(api): State<Api>,
    body: std::result::Result<Json<CreateAgentSession>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<SessionHead>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid agent request".into()))?;
    let head = api.agents.create(input).await?;
    api.publish();
    Ok(Json(head))
}

async fn create_cross_model_child(
    State(api): State<Api>,
    Path(parent_session_id): Path<String>,
    body: std::result::Result<Json<CreateCrossModelChild>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<crate::agent::CrossModelChild>, ApiError> {
    let Json(input) =
        body.map_err(|_| Error::Invalid("invalid cross-model child request".into()))?;
    let child = api
        .agents
        .create_cross_model_child(&parent_session_id, input)
        .await?;
    api.publish();
    Ok(Json(child))
}

async fn list_cross_model_children(
    State(api): State<Api>,
    Path(parent_session_id): Path<String>,
    query: std::result::Result<
        Query<CrossModelChildQuery>,
        axum::extract::rejection::QueryRejection,
    >,
) -> std::result::Result<Json<crate::agent::CrossModelChildPage>, ApiError> {
    let Query(mut query) =
        query.map_err(|_| Error::Invalid("invalid cross-model child query".into()))?;
    query.parent_session_id = Some(parent_session_id);
    Ok(Json(api.agents.list_cross_model_children(query).await?))
}

async fn list_all_cross_model_children(
    State(api): State<Api>,
    query: std::result::Result<
        Query<CrossModelChildQuery>,
        axum::extract::rejection::QueryRejection,
    >,
) -> std::result::Result<Json<crate::agent::CrossModelChildPage>, ApiError> {
    let Query(query) =
        query.map_err(|_| Error::Invalid("invalid cross-model child query".into()))?;
    Ok(Json(api.agents.list_cross_model_children(query).await?))
}

async fn get_cross_model_child(
    State(api): State<Api>,
    Path((parent_session_id, child_session_id)): Path<(String, String)>,
) -> std::result::Result<Json<crate::agent::CrossModelChild>, ApiError> {
    Ok(Json(
        api.agents
            .cross_model_child(&parent_session_id, &child_session_id)
            .await?,
    ))
}

async fn cross_model_child_logs(
    State(api): State<Api>,
    Path((parent_session_id, child_session_id)): Path<(String, String)>,
    query: std::result::Result<
        Query<CrossModelChildLogsQuery>,
        axum::extract::rejection::QueryRejection,
    >,
) -> std::result::Result<Json<crate::agent::CrossModelChildLogs>, ApiError> {
    let Query(query) =
        query.map_err(|_| Error::Invalid("invalid cross-model child log query".into()))?;
    Ok(Json(
        api.agents
            .cross_model_child_logs(&parent_session_id, &child_session_id, query)
            .await?,
    ))
}

async fn cross_model_child_result(
    State(api): State<Api>,
    Path((parent_session_id, child_session_id)): Path<(String, String)>,
) -> std::result::Result<Json<crate::agent::CrossModelChildResult>, ApiError> {
    Ok(Json(
        api.agents
            .cross_model_child_result(&parent_session_id, &child_session_id)
            .await?,
    ))
}

async fn message_cross_model_child(
    State(api): State<Api>,
    Path((parent_session_id, child_session_id)): Path<(String, String)>,
    body: std::result::Result<
        Json<MessageCrossModelChild>,
        axum::extract::rejection::JsonRejection,
    >,
) -> std::result::Result<Json<crate::agent::CrossModelChild>, ApiError> {
    let Json(input) =
        body.map_err(|_| Error::Invalid("invalid cross-model child message".into()))?;
    let child = api
        .agents
        .message_cross_model_child(&parent_session_id, &child_session_id, input)
        .await?;
    api.publish();
    Ok(Json(child))
}

async fn follow_up_cross_model_child(
    State(api): State<Api>,
    Path((parent_session_id, child_session_id)): Path<(String, String)>,
    body: std::result::Result<
        Json<FollowUpCrossModelChild>,
        axum::extract::rejection::JsonRejection,
    >,
) -> std::result::Result<Json<crate::agent::CrossModelChild>, ApiError> {
    let Json(input) =
        body.map_err(|_| Error::Invalid("invalid cross-model child follow-up".into()))?;
    let child = api
        .agents
        .follow_up_cross_model_child(&parent_session_id, &child_session_id, input)
        .await?;
    api.publish();
    Ok(Json(child))
}

async fn cancel_cross_model_child(
    State(api): State<Api>,
    Path((parent_session_id, child_session_id)): Path<(String, String)>,
    body: std::result::Result<Json<CancelCrossModelChild>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<crate::agent::CrossModelChild>, ApiError> {
    let input = match body {
        Ok(Json(input)) => input,
        Err(_) => CancelCrossModelChild { reason: None },
    };
    let child = api
        .agents
        .cancel_cross_model_child(&parent_session_id, &child_session_id, input)
        .await?;
    api.publish();
    Ok(Json(child))
}

async fn redeliver_cross_model_child(
    State(api): State<Api>,
    Path((parent_session_id, child_session_id)): Path<(String, String)>,
) -> std::result::Result<Json<crate::agent::CrossModelChild>, ApiError> {
    let child = api
        .agents
        .redeliver_cross_model_child(&parent_session_id, &child_session_id)
        .await?;
    api.publish();
    Ok(Json(child))
}

async fn ack_cross_model_child(
    State(api): State<Api>,
    Path((parent_session_id, child_session_id)): Path<(String, String)>,
) -> std::result::Result<Json<crate::agent::CrossModelChild>, ApiError> {
    let child = api
        .agents
        .acknowledge_cross_model_child(&parent_session_id, &child_session_id)
        .await?;
    api.publish();
    Ok(Json(child))
}

async fn schedule_cross_model_check(
    State(api): State<Api>,
    Path(parent_session_id): Path<String>,
    body: std::result::Result<
        Json<ScheduleCrossModelCheck>,
        axum::extract::rejection::JsonRejection,
    >,
) -> std::result::Result<Json<crate::agent::CrossModelCheck>, ApiError> {
    let Json(input) =
        body.map_err(|_| Error::Invalid("invalid cross-model check request".into()))?;
    let check = api
        .agents
        .schedule_cross_model_check(&parent_session_id, input)
        .await?;
    api.publish();
    Ok(Json(check))
}

async fn agent_send(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<AgentSend>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid agent message".into()))?;
    api.agents
        .send(&id, input.text, input.delivery, input.attachments)
        .await?;
    api.publish();
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn agent_queues(
    State(api): State<Api>,
) -> std::result::Result<Json<crate::agent::AgentQueues>, ApiError> {
    Ok(Json(api.agents.queues().await?))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageQuery {
    sid: Option<String>,
}

fn empty_usage(sid: Option<String>, available: bool, reason: Option<String>) -> UsageResult {
    UsageResult {
        kind: "usage.result".into(),
        sid,
        available,
        report: UsageReport {
            windows: Vec::new(),
            ..Default::default()
        },
        reason,
        accounts: None,
    }
}

async fn usage_route(
    State(api): State<Api>,
    query: std::result::Result<Query<UsageQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<UsageResult>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid usage query".into()))?;
    if let Some(sid) = query.sid {
        crate::database::validate_id(&sid).map_err(ApiError)?;
        let Some(report) = api.agents.usage(&sid).await? else {
            return Ok(Json(empty_usage(
                Some(sid),
                false,
                Some("这个会话还没产生用量，发一条消息后再看。".into()),
            )));
        };
        let reason = if report.windows.is_empty() {
            Some("这个后端不提供套餐限流窗口。".into())
        } else {
            None
        };
        return Ok(Json(UsageResult {
            kind: "usage.result".into(),
            sid: Some(sid),
            available: true,
            report,
            reason,
            accounts: None,
        }));
    }
    let accounts = api.agents.account_usage().await?;
    let lead = accounts.first();
    let mut result = if let Some(lead) = lead {
        UsageResult {
            kind: "usage.result".into(),
            sid: None,
            available: accounts.iter().any(|account| account.available),
            report: lead.report.clone(),
            reason: lead.reason.clone(),
            accounts: None,
        }
    } else {
        empty_usage(None, false, None)
    };
    result.accounts = Some(accounts);
    Ok(Json(result))
}

async fn agent_queue(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<crate::agent::AgentQueue>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    Ok(Json(crate::agent::AgentQueue {
        session_id: id.clone(),
        items: api.agents.queue(&id).await?,
    }))
}

async fn agent_queue_remove(
    State(api): State<Api>,
    Path((id, queue_id)): Path<(String, String)>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    crate::database::validate_id(&queue_id).map_err(ApiError)?;
    api.agents.remove_queued(&id, &queue_id).await?;
    api.publish();
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn agent_queue_guide(
    State(api): State<Api>,
    Path((id, queue_id)): Path<(String, String)>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    crate::database::validate_id(&queue_id).map_err(ApiError)?;
    api.agents.guide_queued(&id, &queue_id).await?;
    api.publish();
    Ok(Json(serde_json::json!({"ok":true})))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SuggestionsQuery {
    kind: String,
    #[serde(default)]
    query: String,
}

async fn agent_suggestions(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<SuggestionsQuery>, axum::extract::rejection::QueryRejection>,
) -> JsonResult<serde_json::Value> {
    crate::database::validate_id(&id)?;
    let Query(query) = query.map_err(|_| Error::Invalid("invalid suggestion query".into()))?;
    if query.kind != "skill" || query.query.chars().count() > 200 {
        return Err(ApiError(Error::Invalid("invalid suggestion query".into())));
    }
    let workspace = api
        .call(move |store| Ok(store.session(&id)?.workspace))
        .await?;
    let needle = query.query.clone();
    let items =
        tokio::task::spawn_blocking(move || crate::skills::complete_skills(&workspace, &needle))
            .await
            .map_err(|_| Error::Closed)?;
    Ok(Json(serde_json::json!({ "items": items })))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillsQuery {
    cwd: String,
}

async fn list_skills_route(
    State(api): State<Api>,
    query: std::result::Result<Query<SkillsQuery>, axum::extract::rejection::QueryRejection>,
) -> JsonResult<serde_json::Value> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid skills query".into()))?;
    if query.cwd.chars().count() > 4096
        || query.cwd.trim().is_empty()
        || !std::path::Path::new(&query.cwd).is_absolute()
    {
        return Err(ApiError(Error::Invalid("invalid workspace path".into())));
    }
    // Cap concurrent filesystem scans independently of the generic API semaphore.
    let _permit = api.requests.acquire().await.map_err(|_| Error::Closed)?;
    let cwd = query.cwd.clone();
    let items = tokio::task::spawn_blocking(move || crate::skills::list_skills(&cwd))
        .await
        .map_err(|_| Error::Closed)?;
    Ok(Json(serde_json::json!({ "items": items })))
}

// ── Accounts (Stage 8: discovery + managed accounts) ─────────────────────

#[derive(Debug, Clone)]
struct MigrationPlan {
    migration: crate::accounts::sources::SourceMigration,
    entries: Vec<crate::accounts::sources::MigrationEntry>,
}

fn migration_id(entries: &[crate::accounts::sources::MigrationEntry]) -> String {
    use sha2::{Digest, Sha256};
    let key = entries
        .iter()
        .map(|entry| {
            let secret = Sha256::digest(entry.secret.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            (
                entry.profile.protocol().to_owned(),
                entry.profile.base_url.clone(),
                entry.profile.headers.clone(),
                entry.account_id.clone(),
                entry.name.clone(),
                entry.profile.model.clone(),
                entry.profile.model_capabilities.clone(),
                secret,
            )
        })
        .collect::<Vec<_>>();
    let digest = Sha256::digest(serde_json::to_vec(&key).unwrap_or_default());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn migration_name(base_url: &str) -> String {
    url::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .filter(|host| !host.trim().is_empty())
        .unwrap_or_else(|| "Migrated Profiles".into())
        .chars()
        .take(80)
        .collect()
}

fn source_migration_plans(
    store: &Store,
    data: &std::path::Path,
    sources: &crate::accounts::sources::ModelSources,
) -> Result<(Vec<MigrationPlan>, i64)> {
    let mut skipped = 0_i64;
    let mut groups: BTreeMap<String, Vec<crate::accounts::sources::MigrationEntry>> =
        BTreeMap::new();
    for account in store.list_managed_accounts(data)? {
        let Some(profile) = account.api_profile.clone() else {
            continue;
        };
        if sources.is_bound(&account.id) {
            continue;
        }
        let Some(secret) = crate::accounts::managed::profile_secret_for_agent(
            data,
            &account.id,
            account.agent,
            &profile,
        )?
        else {
            skipped += 1;
            continue;
        };
        let key =
            serde_json::to_string(&(profile.protocol(), &profile.base_url, &profile.headers))?;
        groups
            .entry(key)
            .or_default()
            .push(crate::accounts::sources::MigrationEntry {
                account_id: account.id,
                name: account.name,
                profile,
                secret,
                default_effort: None,
            });
    }
    let mut plans = Vec::new();
    for entries in groups.into_values() {
        if entries.len() > 500 || plans.len() >= 100 {
            skipped += entries.len() as i64;
            continue;
        }
        let Some(first) = entries.first() else {
            continue;
        };
        let protocol = first.profile.protocol().to_owned();
        let base_url = first.profile.base_url.clone();
        let id = migration_id(&entries);
        let accounts = entries
            .iter()
            .map(|entry| crate::accounts::sources::SourceMigrationAccount {
                id: entry.account_id.clone(),
                name: entry.name.clone(),
                model: entry.profile.model.clone(),
            })
            .collect();
        let credential_count = entries
            .iter()
            .map(|entry| entry.secret.as_str())
            .collect::<HashSet<_>>()
            .len() as i64;
        plans.push(MigrationPlan {
            migration: crate::accounts::sources::SourceMigration {
                id,
                name: migration_name(&base_url),
                protocol,
                base_url,
                credential_count,
                accounts,
            },
            entries,
        });
    }
    Ok((plans, skipped))
}

async fn model_sources_route(
    State(api): State<Api>,
    body: std::result::Result<
        Json<crate::accounts::sources::SourceControl>,
        axum::extract::rejection::JsonRejection,
    >,
) -> Response {
    use crate::accounts::models::{FeatureError, fetch_models};
    use crate::accounts::sources::{BindOutcome, SourceAction, SourceResult};

    let Json(control) = match body {
        Ok(body) => body,
        Err(_) => {
            return ApiError(Error::Invalid("invalid model source request".into())).into_response();
        }
    };
    if control.kind != "model.source.action"
        || control.request_id.trim().is_empty()
        || control.request_id.len() > 100
    {
        return ApiError(Error::Invalid("invalid model source request".into())).into_response();
    }
    let request_id = control.request_id.clone();
    match control.action {
        SourceAction::List => {
            let data = api.database.directory().to_owned();
            let sources = match api
                .call(move |_| {
                    crate::accounts::sources::ModelSources::open(&data)
                        .map(|sources| sources.list())
                })
                .await
            {
                Ok(sources) => sources,
                Err(error) => return ApiError(error).into_response(),
            };
            let mut result = SourceResult::success(&request_id);
            result.sources = Some(sources);
            Json(result).into_response()
        }
        SourceAction::Models {
            source_id,
            revision,
            protocol,
            credential_id,
            ..
        } => {
            let Ok(_permit) = api.api_features.try_acquire() else {
                return Json(SourceResult::failure(
                    &request_id,
                    FeatureError::new("busy", "账号工具繁忙，请稍后重试"),
                ))
                .into_response();
            };
            let data = api.database.directory().to_owned();
            let target = match api
                .call(move |_| {
                    let sources = crate::accounts::sources::ModelSources::open(&data)?;
                    sources.models_target(&source_id, revision, &protocol, &credential_id)
                })
                .await
            {
                Ok(target) => target,
                Err(error) => {
                    return Json(SourceResult::failure(&request_id, feature_error(error)))
                        .into_response();
                }
            };
            let headers = target.0.headers.clone().unwrap_or_else(BTreeMap::new);
            let models = fetch_models(&target.0.base_url, &target.1, &headers).await;
            match models {
                Ok(models) => {
                    let mut result = SourceResult::success(&request_id);
                    result.models = Some(models);
                    Json(result).into_response()
                }
                Err(error) => Json(SourceResult::failure(&request_id, error)).into_response(),
            }
        }
        SourceAction::Bind {
            source_id,
            route_id,
            revision,
            agent,
        } => {
            let data = api.database.directory().to_owned();
            let outcome = match api
                .database
                .call(move |store| {
                    let accounts = store.list_managed_accounts(&data)?;
                    let known = accounts
                        .iter()
                        .map(|account| account.id.clone())
                        .collect::<HashSet<_>>();
                    let account_agents = accounts
                        .into_iter()
                        .map(|account| (account.id, account.agent))
                        .collect::<HashMap<_, _>>();
                    let mut sources = crate::accounts::sources::ModelSources::open(&data)?;
                    let outcome = sources.bind(
                        &source_id,
                        &route_id,
                        revision,
                        agent,
                        &known,
                        &account_agents,
                    )?;
                    if let BindOutcome::Created {
                        account_id,
                        agent,
                        profile,
                        name,
                        secret,
                    } = &outcome
                    {
                        store.insert_api_profile_account_with_id(
                            &data, account_id, name, *agent, profile, secret,
                        )?;
                    }
                    Ok(outcome)
                })
                .await
            {
                Ok(outcome) => outcome,
                Err(error) => return ApiError(error).into_response(),
            };
            let account_id = match outcome {
                BindOutcome::Existing(id) => id,
                BindOutcome::Created { account_id, .. } => account_id,
            };
            api.publish();
            let accounts =
                match crate::accounts::snapshot(&api.database, &request_id, "model_source_bind")
                    .await
                {
                    Ok(result) => result.accounts,
                    Err(error) => return ApiError(error).into_response(),
                };
            let data = api.database.directory().to_owned();
            let sources = match api
                .call(move |_| {
                    crate::accounts::sources::ModelSources::open(&data)
                        .map(|sources| sources.list())
                })
                .await
            {
                Ok(sources) => sources,
                Err(error) => return ApiError(error).into_response(),
            };
            let mut result = SourceResult::success(&request_id);
            result.account_id = Some(account_id);
            result.accounts = Some(accounts);
            result.sources = Some(sources);
            Json(result).into_response()
        }
        action @ (SourceAction::Create { .. }
        | SourceAction::Update { .. }
        | SourceAction::CredentialSet { .. }
        | SourceAction::CredentialRemove { .. }
        | SourceAction::RoutesSet { .. }
        | SourceAction::RouteRemove { .. }
        | SourceAction::Delete { .. }) => {
            let data = api.database.directory().to_owned();
            let sources = match api
                .database
                .call(move |store| {
                    let accounts = store.list_managed_accounts(&data)?;
                    let known = accounts
                        .into_iter()
                        .map(|account| account.id)
                        .collect::<HashSet<_>>();
                    let mut sources = crate::accounts::sources::ModelSources::open(&data)?;
                    match action {
                        SourceAction::Create { .. } => {
                            sources.create(action)?;
                        }
                        _ => {
                            let _ = sources.change(action, &known)?;
                        }
                    }
                    Ok(sources.list())
                })
                .await
            {
                Ok(sources) => sources,
                Err(error) => {
                    return Json(SourceResult::failure(&request_id, feature_error(error)))
                        .into_response();
                }
            };
            api.publish();
            let mut result = SourceResult::success(&request_id);
            result.sources = Some(sources);
            Json(result).into_response()
        }
        SourceAction::MigrationPreview => {
            let data = api.database.directory().to_owned();
            let (migrations, skipped) = match api
                .database
                .call(move |store| {
                    let sources = crate::accounts::sources::ModelSources::open(&data)?;
                    let (plans, skipped) = source_migration_plans(store, &data, &sources)?;
                    Ok((
                        plans
                            .into_iter()
                            .map(|plan| plan.migration)
                            .collect::<Vec<_>>(),
                        skipped,
                    ))
                })
                .await
            {
                Ok(result) => result,
                Err(error) => return ApiError(error).into_response(),
            };
            let mut result = SourceResult::success(&request_id);
            result.migrations = Some(migrations);
            result.skipped_accounts = Some(skipped);
            Json(result).into_response()
        }
        SourceAction::MigrationRollback { account_ids } => {
            let data = api.database.directory().to_owned();
            let sources = match api
                .database
                .call(move |store| {
                    if account_ids.is_empty() || account_ids.len() > 500 {
                        return Err(Error::Invalid("账号列表无效".into()));
                    }
                    let mut sources = crate::accounts::sources::ModelSources::open(&data)?;
                    for id in &account_ids {
                        if store.active_session_count(id)? > 0 {
                            return Err(Error::InUse);
                        }
                        let record = store.managed_snapshot_row(&data, id)?;
                        let Some(profile) = record.api_profile else {
                            return Err(Error::Invalid("只能还原迁移前的独立 Profile".into()));
                        };
                        let Some(secret) = crate::accounts::managed::profile_secret_for_agent(
                            &data,
                            id,
                            record.agent,
                            &profile,
                        )?
                        else {
                            return Err(Error::Conflict);
                        };
                        if sources.binding_secret(id, &profile)? != secret {
                            return Err(Error::Conflict);
                        }
                    }
                    sources.unbind(&account_ids)?;
                    Ok(sources.list())
                })
                .await
            {
                Ok(sources) => sources,
                Err(error) => {
                    return Json(SourceResult::failure(&request_id, feature_error(error)))
                        .into_response();
                }
            };
            api.publish();
            let accounts = match crate::accounts::snapshot(
                &api.database,
                &request_id,
                "model_source_rollback",
            )
            .await
            {
                Ok(result) => result.accounts,
                Err(error) => return ApiError(error).into_response(),
            };
            let mut result = SourceResult::success(&request_id);
            result.sources = Some(sources);
            result.accounts = Some(accounts);
            Json(result).into_response()
        }
        SourceAction::MigrationApply {
            migration_id,
            name,
            target,
        } => {
            let data = api.database.directory().to_owned();
            let sources = match api
                .database
                .call(move |store| {
                    let mut sources = crate::accounts::sources::ModelSources::open(&data)?;
                    let (plans, _skipped) = source_migration_plans(store, &data, &sources)?;
                    let plan = plans
                        .into_iter()
                        .find(|plan| plan.migration.id == migration_id)
                        .ok_or(Error::Conflict)?;
                    for entry in &plan.entries {
                        if store.active_session_count(&entry.account_id)? > 0 {
                            return Err(Error::InUse);
                        }
                    }
                    sources.migrate(&name, plan.entries, target)?;
                    Ok(sources.list())
                })
                .await
            {
                Ok(sources) => sources,
                Err(error) => {
                    return Json(SourceResult::failure(&request_id, feature_error(error)))
                        .into_response();
                }
            };
            api.publish();
            let accounts =
                match crate::accounts::snapshot(&api.database, &request_id, "model_source_migrate")
                    .await
                {
                    Ok(result) => result.accounts,
                    Err(error) => return ApiError(error).into_response(),
                };
            let mut result = SourceResult::success(&request_id);
            result.sources = Some(sources);
            result.accounts = Some(accounts);
            Json(result).into_response()
        }
    }
}

fn feature_error(error: Error) -> crate::accounts::models::FeatureError {
    use crate::accounts::models::FeatureError;
    match error {
        Error::NotFound => FeatureError::new("not_found", "模型源不存在"),
        Error::Conflict => FeatureError::new("conflict", "模型源已变更，请刷新后重试"),
        Error::InUse => FeatureError::new("in_use", "模型源仍被账号或会话使用"),
        Error::Busy => FeatureError::new("busy", "服务繁忙，请稍后重试"),
        Error::Forbidden => FeatureError::new("forbidden", "本机默认账号不支持此操作"),
        Error::Feature(code, message) => FeatureError { code, message },
        Error::Invalid(message) => FeatureError::new("invalid_request", &message),
        other => FeatureError::new("network", &other.to_string()),
    }
}

struct ApiTestLease {
    account: String,
    testing: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
    released: bool,
}
impl ApiTestLease {
    async fn release(mut self) {
        self.testing.lock().await.remove(&self.account);
        self.released = true;
    }
}
impl Drop for ApiTestLease {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let testing = self.testing.clone();
            let account = self.account.clone();
            runtime.spawn(async move {
                testing.lock().await.remove(&account);
            });
        }
    }
}

/// Tag-dispatched account control. Managed metadata mutations run through the
/// database queue; login spawns an isolated `claude setup-token` PTY; the
/// `api.test`/`api.models.get` profile actions return dedicated envelopes.
async fn signal_session(api: &Api, id: &str, close: bool) -> Result<()> {
    let session_id = id.to_owned();
    let session = api
        .database
        .call(move |store| store.session(&session_id))
        .await?;
    match (session.kind, close) {
        (SessionKind::Pty, true) => api.terminals.close(id).await,
        (SessionKind::Pty, false) => {
            api.terminals
                .input(
                    id,
                    TerminalInput {
                        data_b64: BASE64_STANDARD.encode([3]),
                    },
                )
                .await
        }
        (_, true) => api.agents.close(id).await,
        (_, false) => api.agents.interrupt(id).await,
    }
}

async fn accounts_route(
    State(api): State<Api>,
    body: std::result::Result<Json<serde_json::Value>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let value = match body {
        Ok(Json(value)) => value,
        Err(_) => {
            return ApiError(Error::Invalid("invalid account request".into())).into_response();
        }
    };
    let control = match crate::accounts::parse_control(&value) {
        Ok(control) => control,
        Err(error) => return ApiError(error).into_response(),
    };
    let request_id = control.request_id().to_owned();
    let _permit = match api.requests.try_acquire() {
        Ok(permit) => permit,
        Err(_) => return ApiError(Error::Busy).into_response(),
    };

    // ── Profile connectivity test: revision capture → probe → record ──────
    let crate::accounts::AccountControl::ApiTest {
        account_id, scope, ..
    } = &control
    else {
        return account_control_result(State(api.clone()), control).await;
    };
    if account_id == crate::accounts::NATIVE_CLAUDE_ID {
        return ApiError(Error::Forbidden).into_response();
    }
    let engine_scope = match scope.as_deref() {
        None | Some("protocol") => false,
        Some("engine") => true,
        Some(_) => {
            return ApiError(Error::Invalid("连接测试范围无效".into())).into_response();
        }
    };
    // One in-flight test per profile, at most four across the daemon.
    let _test_permit = match api.api_tests.try_acquire() {
        Ok(permit) => permit,
        Err(_) => return ApiError(Error::ApiTestBusy).into_response(),
    };
    {
        let mut testing = api.api_testing.lock().await;
        if testing.contains(account_id) {
            return ApiError(Error::ApiTestInFlight).into_response();
        }
        testing.insert(account_id.clone());
    }
    let lease = ApiTestLease {
        account: account_id.clone(),
        testing: api.api_testing.clone(),
        released: false,
    };
    let outcome = if engine_scope {
        run_profile_engine_test(&api, &request_id, account_id)
            .await
            .map(EitherValidation::Engine)
    } else {
        run_profile_test(&api, &request_id, account_id)
            .await
            .map(EitherValidation::Protocol)
    };
    lease.release().await;
    let (validation, engine_validation) = match outcome {
        Ok(EitherValidation::Protocol(validation)) => (Some(validation), None),
        Ok(EitherValidation::Engine(validation)) => (None, Some(validation)),
        Err(error) => return ApiError(error).into_response(),
    };
    let result = match crate::accounts::respond(
        &api.database,
        &control,
        Some(account_id.clone()),
        None,
        validation,
        engine_validation,
    )
    .await
    {
        Ok(result) => result,
        Err(error) => return ApiError(error).into_response(),
    };
    match serde_json::to_value(result) {
        Ok(value) => Json(value).into_response(),
        Err(error) => ApiError(error.into()).into_response(),
    }
}

/// Loads the profile + current key, runs the probe, and records the result
/// only when the profile revision still matches the one captured beforehand.
enum EitherValidation {
    Protocol(crate::accounts::ApiValidation),
    Engine(crate::accounts::ApiEngineValidation),
}

async fn run_profile_test(
    api: &Api,
    request_id: &str,
    account_id: &str,
) -> Result<crate::accounts::ApiValidation> {
    let _ = request_id;
    let data = api.database.directory().to_owned();
    let id = account_id.to_owned();
    let (revision, record, secret) = api
        .database
        .call({
            let data = data.clone();
            move |store| {
                let revision = store.api_validation_revision(&data, &id)?;
                let record = store.managed_snapshot_row(&data, &id)?;
                let secret = match record.api_profile.as_ref() {
                    Some(profile) => crate::accounts::managed::profile_secret_for_agent(
                        &data,
                        &id,
                        record.agent,
                        profile,
                    )?,
                    None => None,
                };
                Ok((revision, record, secret))
            }
        })
        .await?;
    let profile = record
        .api_profile
        .ok_or_else(|| Error::Invalid("这个账号不是第三方 API Profile".into()))?;
    let secret = secret.unwrap_or_default();
    let validation = crate::accounts::probe::probe(&profile, &secret).await;
    let data = data.clone();
    let id = account_id.to_owned();
    let expected = revision.clone();
    let recorded = api
        .database
        .call({
            let validation = validation.clone();
            move |store| store.record_api_validation(&data, &id, &expected, &validation)
        })
        .await?;
    if !recorded {
        return Err(Error::Invalid("Profile 已变更，请重新测试连接".into()));
    }
    Ok(validation)
}

/// Loads the profile + current key, runs the Rust engine probe, and records
/// the result only when the profile revision still matches the captured one.
async fn run_profile_engine_test(
    api: &Api,
    request_id: &str,
    account_id: &str,
) -> Result<crate::accounts::ApiEngineValidation> {
    let _ = request_id;
    let data = api.database.directory().to_owned();
    let id = account_id.to_owned();
    let (revision, record, secret) = api
        .database
        .call({
            let data = data.clone();
            move |store| {
                let revision = store.api_validation_revision(&data, &id)?;
                let record = store.managed_snapshot_row(&data, &id)?;
                let secret = match record.api_profile.as_ref() {
                    Some(profile) => crate::accounts::managed::profile_secret_for_agent(
                        &data,
                        &id,
                        record.agent,
                        profile,
                    )?,
                    None => None,
                };
                Ok((revision, record, secret))
            }
        })
        .await?;
    let profile = record
        .api_profile
        .ok_or_else(|| Error::Invalid("这个账号不是第三方 API Profile".into()))?;
    let secret = secret.unwrap_or_default();
    let validation = crate::accounts::probe::probe_engine(&profile, &secret).await;
    let data = data.clone();
    let id = account_id.to_owned();
    let expected = revision.clone();
    let recorded = api
        .database
        .call({
            let validation = validation.clone();
            move |store| store.record_api_engine_validation(&data, &id, &expected, &validation)
        })
        .await?;
    if !recorded {
        return Err(Error::Invalid("Profile 已变更，请重新测试连接".into()));
    }
    Ok(validation)
}

/// Handles every non-`api.test` account control, including the models
/// feature which returns `agent.account.api.models.result`.
async fn account_control_result(
    State(api): State<Api>,
    control: crate::accounts::AccountControl,
) -> Response {
    if let crate::accounts::AccountControl::ConfigGet { .. }
    | crate::accounts::AccountControl::ConfigSet { .. } = &control
    {
        let Ok(_permit) = api.api_features.try_acquire() else {
            let result = crate::accounts::config::AccountConfigResult::failure(
                control.request_id(),
                crate::accounts::models::FeatureError::new("busy", "账号工具繁忙，请稍后重试"),
            );
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::to_value(result).unwrap_or_else(|_| serde_json::json!({}))),
            )
                .into_response();
        };
        let result = account_config(&api, &control).await;
        api.publish();
        return Json(serde_json::to_value(result).unwrap_or_else(|_| serde_json::json!({})))
            .into_response();
    }

    if let crate::accounts::AccountControl::ApiModelsGet {
        request_id,
        account_id,
        protocol,
        base_url,
        api_key,
        headers,
    } = &control
    {
        // Legacy parity: the 429 busy response still carries the feature
        // envelope so the renderer's result parser handles it uniformly.
        let Ok(_permit) = api.api_features.try_acquire() else {
            let result = crate::accounts::models::ModelsResult::failure(
                request_id,
                crate::accounts::models::FeatureError::new("busy", "账号工具繁忙，请稍后重试"),
            );
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::to_value(result).unwrap_or_else(|_| serde_json::json!({}))),
            )
                .into_response();
        };
        let result = profile_models(
            &api,
            request_id,
            account_id.as_deref(),
            protocol.as_deref(),
            base_url.as_deref(),
            api_key.as_deref(),
            headers.clone(),
        )
        .await;
        api.publish();
        return Json(serde_json::to_value(result).unwrap_or_else(|_| serde_json::json!({})))
            .into_response();
    }
    let (account_id, session_id) = match &control {
        crate::accounts::AccountControl::List { .. } => (None, None),
        crate::accounts::AccountControl::Login {
            account_id,
            cols,
            rows,
            ..
        } => {
            if account_id == crate::accounts::NATIVE_CLAUDE_ID {
                return ApiError(Error::Forbidden).into_response();
            }
            let size = TerminalSize {
                cols: *cols,
                rows: *rows,
            };
            let size = match crate::terminal::validate_size(size) {
                Ok(size) => size,
                Err(error) => return ApiError(error).into_response(),
            };
            let data = api.database.directory().to_owned();
            let id = account_id.clone();
            let record = match api
                .database
                .call(move |store| store.managed_account(&id))
                .await
            {
                Ok(record) => record,
                Err(error) => return ApiError(error).into_response(),
            };
            let id = account_id.clone();
            let environment = match tokio::task::spawn_blocking(move || {
                crate::accounts::managed::claude_environment(&data, &id, true)
            })
            .await
            .map_err(|_| ApiError(Error::Closed))
            .and_then(|result| result.map_err(ApiError))
            {
                Ok(environment) => environment,
                Err(error) => return error.into_response(),
            };
            let head = match api
                .terminals
                .create_login(
                    account_id,
                    format!("{} · 登录", record.name),
                    size,
                    environment,
                )
                .await
            {
                Ok(head) => head,
                Err(error) => return ApiError(error).into_response(),
            };
            api.publish();
            (Some(account_id.clone()), Some(head.id))
        }
        other => {
            if let Some(id) = other.account_id()
                && id == crate::accounts::NATIVE_CLAUDE_ID
            {
                // The native environment can never be renamed, logged out or
                // deleted, matching legacy account_not_managed (403).
                return ApiError(Error::Forbidden).into_response();
            }
            if let crate::accounts::AccountControl::Create { agent, .. } = other
                && agent != "claude"
            {
                return ApiError(Error::Invalid("Rust 当前仅支持 Claude 托管账号".into()))
                    .into_response();
            }
            let account_id = match crate::accounts::execute_control(&api.database, &control).await {
                Ok(account_id) => account_id,
                Err(error) => return ApiError(error).into_response(),
            };
            api.publish();
            (account_id, None)
        }
    };
    let result =
        match crate::accounts::respond(&api.database, &control, account_id, session_id, None, None)
            .await
        {
            Ok(result) => result,
            Err(error) => return ApiError(error).into_response(),
        };
    match serde_json::to_value(result) {
        Ok(value) => Json(value).into_response(),
        Err(error) => ApiError(error.into()).into_response(),
    }
}

async fn account_config(
    api: &Api,
    control: &crate::accounts::AccountControl,
) -> crate::accounts::config::AccountConfigResult {
    use crate::accounts::config::{self, AccountConfigResult, ConfigTarget};
    let request_id = control.request_id().to_owned();
    let account_id = match control.account_id() {
        Some(id) => id.to_owned(),
        None => {
            return AccountConfigResult::failure(
                &request_id,
                crate::accounts::models::FeatureError::new("invalid_request", "账号 ID 无效"),
            );
        }
    };
    let load = async {
        if account_id == crate::accounts::NATIVE_CLAUDE_ID {
            return Err(Error::Forbidden);
        }
        let data = api.database.directory().to_owned();
        let id = account_id.clone();
        let (target, source_bound) = api
            .database
            .call(move |store| {
                let record = store.managed_snapshot_row(&data, &id)?;
                let active_sessions = store.active_session_count(&id)?;
                let source_bound =
                    crate::accounts::sources::ModelSources::open(&data)?.is_bound(&id);
                Ok((
                    ConfigTarget {
                        account_id: record.id,
                        model: record
                            .api_profile
                            .as_ref()
                            .map(|profile| profile.model.clone()),
                        model_capabilities: record
                            .api_profile
                            .as_ref()
                            .and_then(|profile| profile.model_capabilities.clone()),
                        active_sessions,
                    },
                    source_bound,
                ))
            })
            .await?;
        if source_bound && matches!(control, crate::accounts::AccountControl::ConfigSet { .. }) {
            return Err(Error::Feature(
                "forbidden".into(),
                "请在模型源中编辑模型默认参数".into(),
            ));
        }
        let catalog = if target.model.is_none() {
            api.agents
                .launch_catalog_for(Some(&target.account_id))
                .await
                .ok()
        } else {
            None
        };
        let data = api.database.directory().to_owned();
        match control {
            crate::accounts::AccountControl::ConfigGet { .. } => {
                api.database
                    .call(move |_| config::get_config(&data, target, catalog.as_ref()))
                    .await
            }
            crate::accounts::AccountControl::ConfigSet {
                document_id,
                revision,
                content,
                default_effort,
                ..
            } => {
                let document_id = document_id.clone();
                let revision = revision.clone();
                let content = content.clone();
                let default_effort = default_effort.clone();
                api.database
                    .call(move |_| {
                        config::save_config(
                            &data,
                            target,
                            &document_id,
                            &revision,
                            content.as_deref(),
                            default_effort,
                            catalog.as_ref(),
                        )
                    })
                    .await
            }
            _ => Err(Error::Invalid("unsupported account config action".into())),
        }
    };
    match load.await {
        Ok(config) => AccountConfigResult::success(&request_id, config),
        Err(error) => AccountConfigResult::failure(&request_id, feature_error(error)),
    }
}

/// Loads the profile catalog either from a stored account or from draft
/// connection fields (exactly one of the two must be present, matching the
/// desktop `accountModelsRequest` XOR contract).
async fn profile_models(
    api: &Api,
    request_id: &str,
    account_id: Option<&str>,
    protocol: Option<&str>,
    draft_base_url: Option<&str>,
    draft_key: Option<&str>,
    draft_headers: Option<serde_json::Value>,
) -> crate::accounts::models::ModelsResult {
    use crate::accounts::models::{FeatureError, ModelsResult, fetch_models_with_protocol};
    let load = async {
        match account_id {
            Some(id) => {
                if id == crate::accounts::NATIVE_CLAUDE_ID {
                    return Err(FeatureError::new(
                        "unsupported",
                        "本机默认账号不支持模型目录",
                    ));
                }
                let data = api.database.directory().to_owned();
                let id = id.to_owned();
                let (record, secret) = api
                    .database
                    .call(move |store| {
                        let record = store.managed_snapshot_row(&data, &id)?;
                        let secret = match record.api_profile.as_ref() {
                            Some(profile) => crate::accounts::managed::profile_secret_for_agent(
                                &data,
                                &id,
                                record.agent,
                                profile,
                            )?,
                            None => None,
                        };
                        Ok((record, secret))
                    })
                    .await
                    .map_err(|_| FeatureError::new("storage", "账号读取失败，请稍后重试"))?;
                let profile = record
                    .api_profile
                    .ok_or_else(|| FeatureError::new("unsupported", "这个账号不是 API Profile"))?;
                let headers = profile.headers.clone().unwrap_or_default();
                let secret = secret
                    .ok_or_else(|| FeatureError::new("authentication", "请先配置 API Key"))?;
                fetch_models_with_protocol(profile.protocol(), &profile.base_url, &secret, &headers)
                    .await
            }
            None => {
                let base_url = draft_base_url.unwrap_or("");
                let key = draft_key.unwrap_or("");
                let protocol = protocol.unwrap_or("anthropic");
                if !matches!(
                    protocol,
                    "anthropic" | "openai_responses" | "openai_chat_completions"
                ) {
                    return Err(FeatureError::new("unsupported", "模型协议不支持"));
                }
                let headers = crate::accounts::profile::clean_headers(draft_headers)
                    .map_err(|error| FeatureError::new("invalid_request", &error.to_string()))?;
                fetch_models_with_protocol(protocol, base_url, key, &headers.unwrap_or_default())
                    .await
            }
        }
    };
    match load.await {
        Ok(models) => ModelsResult::success(request_id, models),
        Err(error) => ModelsResult::failure(request_id, error),
    }
}

async fn codex_launch_catalog(
    api: &Api,
    account_id: Option<&str>,
) -> Result<crate::agent::LaunchModelCatalog> {
    match account_id {
        None | Some(crate::agent::NATIVE_CODEX_ID) => {
            crate::agent::read_native_codex_models(api.database.directory()).await
        }
        Some(id) => {
            profile_launch_catalog(api, id, crate::protocol::AgentKind::Codex, "Codex").await
        }
    }
}

async fn profile_launch_catalog(
    api: &Api,
    account_id: &str,
    expected_agent: crate::protocol::AgentKind,
    label: &str,
) -> Result<crate::agent::LaunchModelCatalog> {
    crate::database::validate_id(account_id)?;
    let data = api.database.directory().to_owned();
    let account_id = account_id.to_owned();
    let profile = api
        .database
        .call(move |store| Ok(store.managed_snapshot_row(&data, &account_id)?.api_profile))
        .await?
        .ok_or_else(|| Error::Invalid(format!("所选账号不是 {label} API Profile")))?;
    if crate::accounts::profile::agent_kind(&profile) != expected_agent {
        return Err(Error::Invalid(format!("所选账号不是 {label} API Profile")));
    }
    let model = profile.model.clone();
    Ok(crate::agent::LaunchModelCatalog {
        current_model: Some(model.clone()),
        current_effort: None,
        presets: Vec::new(),
        current_preset: None,
        models: vec![crate::agent::LaunchModelInfo {
            id: model,
            label: profile.model,
            description: None,
            supported_efforts: profile
                .model_capabilities
                .as_ref()
                .and_then(|caps| caps.supported_efforts.clone())
                .unwrap_or_default(),
            default_effort: None,
            is_default: true,
        }],
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchModelsQuery {
    agent: String,
    #[serde(default)]
    account_id: Option<String>,
}

/// Launch model catalog for the desktop new-session dialog. Serves Claude
/// through its headless CLI handshake and native Codex through app-server.
async fn launch_models(
    State(api): State<Api>,
    Query(query): Query<LaunchModelsQuery>,
) -> std::result::Result<Json<crate::agent::LaunchModelCatalog>, ApiError> {
    let _permit = api.requests.acquire().await.map_err(|_| Error::Closed)?;
    if query.agent == "deepseek" {
        return Ok(Json(crate::agent::Agents::deepseek_launch_catalog().await?));
    }
    if query.agent == "opencode" {
        return Ok(Json(match query.account_id.as_deref() {
            Some(id) => {
                profile_launch_catalog(&api, id, crate::protocol::AgentKind::Opencode, "OpenCode")
                    .await?
            }
            None => crate::agent::Agents::opencode_launch_catalog().await?,
        }));
    }
    if query.agent == "codex" {
        return Ok(Json(
            codex_launch_catalog(&api, query.account_id.as_deref()).await?,
        ));
    }
    if query.agent != "claude" {
        return Err(ApiError(Error::Invalid(
            "invalid model catalog agent".into(),
        )));
    }
    // An absent accountId means the native environment; the runtime
    // canonicalizes it the same way.
    let account_id = query
        .account_id
        .or_else(|| Some(crate::accounts::NATIVE_CLAUDE_ID.into()));
    let catalog = api.agents.launch_catalog_for(account_id.as_deref()).await?;
    Ok(Json(catalog))
}

async fn agent_interrupt(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    api.agents.interrupt(&id).await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn agent_modes(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<crate::agent::AgentModeCatalog>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    let mode = api.agents.mode(&id).await?;
    Ok(Json(mode_catalog(mode.label())))
}

async fn set_agent_mode(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<AgentModeSelection>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    let Json(selection) = body.map_err(|_| Error::Invalid("invalid mode selection".into()))?;
    let mode = PermissionMode::from_wire(&selection.mode).map_err(ApiError)?;
    api.agents.set_mode(&id, mode).await?;
    Ok(Json(serde_json::json!({ "currentMode": selection.mode })))
}

async fn agent_models(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<crate::agent::AgentModelCatalog>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    let _permit = api.requests.acquire().await.map_err(|_| Error::Closed)?;
    let catalog = api.agents.models(&id).await.map_err(ApiError)?;
    Ok(Json(catalog))
}

async fn set_agent_model(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<AgentModelSelection>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<crate::agent::AgentModelSelectionResult>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    let Json(selection) = body.map_err(|_| Error::Invalid("invalid model selection".into()))?;
    let _permit = api.requests.acquire().await.map_err(|_| Error::Closed)?;
    let result = api
        .agents
        .set_model(&id, selection.model, selection.effort)
        .await
        .map_err(ApiError)?;
    Ok(Json(result))
}

async fn agent_controls(
    State(api): State<Api>,
) -> std::result::Result<Json<crate::agent::AgentControlsProjection>, ApiError> {
    let controls = api.agents.controls().await.map_err(ApiError)?;
    Ok(Json(controls))
}

async fn agent_subagent_events(
    State(api): State<Api>,
    Path((id, subagent)): Path<(String, String)>,
) -> std::result::Result<Json<crate::agent::SubagentSnapshot>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    crate::database::validate_id(&subagent).map_err(ApiError)?;
    let snapshot = api.agents.subagent_snapshot(&id, &subagent).await?;
    Ok(Json(snapshot))
}

async fn agent_subagent_send(
    State(api): State<Api>,
    Path((id, subagent)): Path<(String, String)>,
    body: std::result::Result<Json<AgentSend>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    crate::database::validate_id(&subagent).map_err(ApiError)?;
    let Json(input) = body.map_err(|_| Error::Invalid("invalid agent message".into()))?;
    if !input.attachments.is_empty() || input.delivery.is_some() {
        return Err(ApiError(Error::Invalid(
            "子 Agent 定向消息暂不支持附件或 delivery".into(),
        )));
    }
    api.agents
        .send_to_subagent(&id, &subagent, input.text)
        .await?;
    api.publish();
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn session_workspace(api: &Api, id: &str) -> Result<std::path::PathBuf> {
    crate::database::validate_id(id)?;
    let id = id.to_owned();
    api.call(move |store| {
        store
            .session(&id)
            .map(|session| std::path::PathBuf::from(session.workspace))
    })
    .await
}

async fn workspace_summary(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<RequestIdQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<WorkspaceSummaryResult>, ApiError> {
    let Query(query) =
        query.map_err(|_| Error::Invalid("invalid workspace summary query".into()))?;
    if query.request_id.trim().is_empty() || query.request_id.len() > 100 {
        return Err(ApiError(Error::Invalid("invalid request id".into())));
    }
    let root = session_workspace(&api, &id).await?;
    Ok(Json(
        crate::project::workspace_summary(id, root, query.request_id).await?,
    ))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestIdQuery {
    request_id: String,
}

async fn fs_list(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<FsPathQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<FsListing>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid fs query".into()))?;
    let root = session_workspace(&api, &id).await?;
    let path = query.path;
    let response_path = path.clone();
    let entries = tokio::task::spawn_blocking(move || crate::project::list_dir(&root, &path))
        .await
        .map_err(|_| Error::Closed)??;
    Ok(Json(FsListing {
        r#type: "fs.listing".into(),
        sid: id,
        path: response_path,
        entries,
    }))
}

async fn fs_read(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<FsPathQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<FsContent>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid fs query".into()))?;
    let root = session_workspace(&api, &id).await?;
    let path = query.path;
    let response_path = path.clone();
    let (content, size, truncated, binary) =
        tokio::task::spawn_blocking(move || crate::project::read_for_edit(&root, &path))
            .await
            .map_err(|_| Error::Closed)??;
    Ok(Json(FsContent {
        r#type: "fs.content".into(),
        sid: id,
        path: response_path,
        content_b64: BASE64_STANDARD.encode(content),
        size,
        truncated,
        binary,
    }))
}

async fn fs_write(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<FsWriteRequest>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<FsWritten>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid fs write".into()))?;
    let root = session_workspace(&api, &id).await?;
    let content = BASE64_STANDARD
        .decode(&input.content_b64)
        .map_err(|_| Error::Invalid("invalid base64".into()))?;
    let path = input.path;
    let response_path = path.clone();
    let create_new = input.create_new.unwrap_or(false);
    let expected_version = input.expected_version;
    let size = tokio::task::spawn_blocking(move || {
        crate::project::write_file_at(&root, &path, content, create_new, expected_version)
    })
    .await
    .map_err(|_| Error::Closed)??;
    Ok(Json(FsWritten {
        r#type: "fs.written".into(),
        sid: id,
        path: response_path,
        size,
    }))
}

async fn fs_get(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<FsChunkQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<FsChunk>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid fs chunk query".into()))?;
    let root = session_workspace(&api, &id).await?;
    let path = query.path;
    let response_path = path.clone();
    let offset = query.offset;
    let length = query.length;
    let (data, total, eof) = tokio::task::spawn_blocking(move || {
        crate::project::read_chunk(&root, &path, offset, length)
    })
    .await
    .map_err(|_| Error::Closed)??;
    Ok(Json(FsChunk {
        r#type: "fs.chunk".into(),
        sid: id,
        path: response_path,
        offset,
        data_b64: BASE64_STANDARD.encode(data),
        total,
        eof,
    }))
}

async fn fs_put(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<FsPutRequest>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<FsWritten>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid fs put".into()))?;
    let root = session_workspace(&api, &id).await?;
    let data = BASE64_STANDARD
        .decode(&input.data_b64)
        .map_err(|_| Error::Invalid("invalid base64".into()))?;
    let path = input.path;
    let response_path = path.clone();
    let offset = input.offset;
    let size = tokio::task::spawn_blocking(move || {
        crate::project::write_chunk(&root, &path, offset, data)
    })
    .await
    .map_err(|_| Error::Closed)??;
    Ok(Json(FsWritten {
        r#type: "fs.written".into(),
        sid: id,
        path: response_path,
        size,
    }))
}

async fn fs_mkdir(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<FsPathRequest>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<FsDone>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid fs mkdir".into()))?;
    let root = session_workspace(&api, &id).await?;
    let path = input.path;
    let response_path = path.clone();
    tokio::task::spawn_blocking(move || crate::project::make_dir(&root, &path))
        .await
        .map_err(|_| Error::Closed)??;
    Ok(Json(FsDone {
        r#type: "fs.done".into(),
        sid: id,
        path: response_path,
        op: "mkdir".into(),
    }))
}

async fn fs_remove(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<FsPathRequest>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<FsDone>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid fs remove".into()))?;
    let root = session_workspace(&api, &id).await?;
    let path = input.path;
    let response_path = path.clone();
    tokio::task::spawn_blocking(move || crate::project::remove_entry(&root, &path))
        .await
        .map_err(|_| Error::Closed)??;
    Ok(Json(FsDone {
        r#type: "fs.done".into(),
        sid: id,
        path: response_path,
        op: "remove".into(),
    }))
}

async fn fs_rename(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<FsRenameRequest>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<FsDone>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid fs rename".into()))?;
    let root = session_workspace(&api, &id).await?;
    let from = input.path;
    let response_path = from.clone();
    let to = input.to;
    tokio::task::spawn_blocking(move || crate::project::rename_entry(&root, &from, &to))
        .await
        .map_err(|_| Error::Closed)??;
    Ok(Json(FsDone {
        r#type: "fs.done".into(),
        sid: id,
        path: response_path,
        op: "rename".into(),
    }))
}

async fn project_search(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<ProjectSearchRequest>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<SearchResult>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid search request".into()))?;
    let root = session_workspace(&api, &id).await?;
    Ok(Json(crate::project::project_search(root, input).await?))
}

async fn git_status(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<GitStatusResult>, ApiError> {
    let root = session_workspace(&api, &id).await?;
    Ok(Json(crate::project::git_status(id, root).await?))
}

async fn git_diff(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<GitDiffQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<GitDiffResult>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid git diff query".into()))?;
    let root = session_workspace(&api, &id).await?;
    Ok(Json(
        crate::project::git_diff(id, root, query.path, query.staged).await?,
    ))
}

async fn git_history(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<GitHistoryResult>, ApiError> {
    let root = session_workspace(&api, &id).await?;
    Ok(Json(crate::project::git_history(id, root).await?))
}

async fn git_stage(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<GitStageRequest>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<GitDone>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid git stage".into()))?;
    let root = session_workspace(&api, &id).await?;
    crate::project::git_stage(root, input.paths, input.unstage).await?;
    Ok(Json(GitDone {
        r#type: "git.done".into(),
        sid: id,
        op: if input.unstage { "unstage" } else { "stage" }.into(),
        detail: None,
    }))
}

async fn git_discard(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<FsPathRequest>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<GitDone>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid git discard".into()))?;
    let root = session_workspace(&api, &id).await?;
    crate::project::git_discard(root, input.path).await?;
    Ok(Json(GitDone {
        r#type: "git.done".into(),
        sid: id,
        op: "discard".into(),
        detail: None,
    }))
}

async fn git_commit(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<GitCommitRequest>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<GitDone>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid git commit".into()))?;
    let root = session_workspace(&api, &id).await?;
    let detail = crate::project::git_commit(root, input.message).await?;
    Ok(Json(GitDone {
        r#type: "git.done".into(),
        sid: id,
        op: "commit".into(),
        detail: Some(detail),
    }))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentQuery {
    msg_id: String,
    attachment_id: String,
    offset: u64,
    length: usize,
}

async fn agent_attachment(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<AttachmentQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<crate::agent::AttachmentChunk>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    let Query(query) = query.map_err(|_| Error::Invalid("invalid attachment request".into()))?;
    let chunk = api
        .agents
        .attachment_chunk(
            &id,
            &query.msg_id,
            &query.attachment_id,
            query.offset,
            query.length,
        )
        .await?
        .ok_or(Error::NotFound)?;
    Ok(Json(chunk))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolOutputQuery {
    call_id: String,
}

async fn agent_tool_output(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<ToolOutputQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    crate::database::validate_id(&id).map_err(ApiError)?;
    let Query(query) = query.map_err(|_| Error::Invalid("missing callId".into()))?;
    crate::timeline::validate_record_id(&query.call_id).map_err(ApiError)?;
    let output = api
        .database
        .call(move |store| {
            let record = store.timeline_record(&id, &query.call_id)?;
            if !matches!(record.body, TimelineBody::Tool { .. }) {
                return Err(Error::NotFound);
            }
            let page = store.timeline_text(&id, &query.call_id, TimelineTextQuery::default())?;
            Ok(serde_json::json!({
                "output": page.text,
                "truncated": page.next_part.is_some(),
            }))
        })
        .await
        .map_err(ApiError)?;
    Ok(Json(output))
}

async fn agent_compact(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<AgentCompactRequest>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<crate::agent::AgentControlResult>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid compact request".into()))?;
    let result = api
        .agents
        .compact(&id, &input.request_id)
        .await
        .map_err(ApiError)?;
    Ok(Json(result))
}

async fn agent_approval_policy(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<
        Json<ApprovalPolicySelection>,
        axum::extract::rejection::JsonRejection,
    >,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid approval policy".into()))?;
    let policy = crate::agent::ApprovalPolicy::from_wire(&input.policy).map_err(ApiError)?;
    api.agents
        .set_approval_policy(&id, policy)
        .await
        .map_err(ApiError)?;
    Ok(Json(serde_json::json!({"ok": true})))
}

async fn agent_permission(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<PermissionDecision>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    let Json(decision) = body.map_err(|_| Error::Invalid("invalid permission decision".into()))?;
    api.agents
        .respond_permission(&id, &decision.request_id, decision.allow)
        .await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn agent_question(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<QuestionDecision>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    let Json(decision) = body.map_err(|_| Error::Invalid("invalid question decision".into()))?;
    api.agents
        .respond_question(
            &id,
            &decision.request_id,
            decision.answers,
            decision.cancelled,
        )
        .await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn agent_close(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    api.agents.close(&id).await?;
    api.publish();
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn create_terminal(
    State(api): State<Api>,
    body: std::result::Result<Json<CreateTerminal>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<SessionHead>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid terminal request".into()))?;
    let head = api.terminals.create(input).await?;
    api.publish();
    Ok(Json(head))
}

async fn terminal_output(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<TerminalQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<TerminalPage>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid terminal query".into()))?;
    let _permit = api
        .terminal_reads
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::Busy)?;
    Ok(Json(api.terminals.read(id, query).await?))
}

async fn terminal_input(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<TerminalInput>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid terminal input".into()))?;
    api.terminals.input(&id, input).await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn terminal_snapshot(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<Option<TerminalSnapshot>>, ApiError> {
    let _permit = api
        .terminal_snapshots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::Busy)?;
    Ok(Json(api.terminals.snapshot(id).await?))
}

async fn terminal_resize(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<TerminalSize>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    let Json(size) = body.map_err(|_| Error::Invalid("invalid terminal size".into()))?;
    api.terminals.resize(&id, size).await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn terminal_close(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<serde_json::Value>, ApiError> {
    api.terminals.close(&id).await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShutdownQuery {
    expected_build_id: Option<String>,
}

async fn shutdown(
    State(api): State<Api>,
    query: std::result::Result<Query<ShutdownQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<impl IntoResponse, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid shutdown query".into()))?;
    if query
        .expected_build_id
        .is_some_and(|expected| expected != api.build_id.as_ref())
    {
        return Err(Error::Conflict.into());
    }
    api.stop();
    Ok((StatusCode::ACCEPTED, Json(serde_json::json!({"ok":true}))))
}

async fn sessions(
    State(api): State<Api>,
    query: std::result::Result<Query<SessionQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<SessionPage>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid session query".into()))?;
    Ok(Json(api.call(move |store| store.sessions(query)).await?))
}

async fn session(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> std::result::Result<Json<SessionHead>, ApiError> {
    Ok(Json(api.call(move |store| store.session(&id)).await?))
}

async fn timeline(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<TimelineQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<TimelinePage>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid timeline query".into()))?;
    Ok(Json(
        api.call(move |store| store.timeline(&id, query)).await?,
    ))
}

async fn timeline_lookup(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<SessionLookup>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<TimelineLookupResult>, ApiError> {
    let Json(body) = body.map_err(|_| Error::Invalid("invalid timeline lookup".into()))?;
    Ok(Json(
        api.call(move |store| store.timeline_lookup(&id, body.ids))
            .await?,
    ))
}

async fn timeline_text(
    State(api): State<Api>,
    Path((id, record)): Path<(String, String)>,
    query: std::result::Result<Query<TimelineTextQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<TimelineTextPage>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid body query".into()))?;
    Ok(Json(
        api.call(move |store| store.timeline_text(&id, &record, query))
            .await?,
    ))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SummaryQuery {
    workspace: Option<String>,
}

async fn summary(
    State(api): State<Api>,
    query: std::result::Result<Query<SummaryQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<SessionSummary>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid summary query".into()))?;
    Ok(Json(
        api.call(move |store| store.session_summary(query.workspace.as_deref()))
            .await?,
    ))
}

async fn workspaces(
    State(api): State<Api>,
    query: std::result::Result<Query<WorkspaceQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<WorkspacePage>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid workspace query".into()))?;
    Ok(Json(api.call(move |store| store.workspaces(query)).await?))
}

async fn lookup(
    State(api): State<Api>,
    body: std::result::Result<Json<SessionLookup>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<SessionLookupResult>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid lookup request".into()))?;
    Ok(Json(
        api.call(move |store| store.lookup_sessions(input)).await?,
    ))
}

async fn rename(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<RenameSession>, axum::extract::rejection::JsonRejection>,
) -> std::result::Result<Json<SessionHead>, ApiError> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid rename request".into()))?;
    let session = api
        .call(move |store| {
            store.update_session(
                &id,
                UpdateSession {
                    revision: input.revision,
                    title: Some(input.title),
                    lifecycle: None,
                    status: None,
                },
            )
        })
        .await?;
    api.publish();
    Ok(Json(session))
}

async fn events(
    State(api): State<Api>,
    query: std::result::Result<Query<EventQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<EventPage>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid event query".into()))?;
    Ok(Json(
        api.call(move |store| {
            store.events(
                &query.scope,
                query.after_seq.unwrap_or(0),
                query.limit.unwrap_or(100),
            )
        })
        .await?,
    ))
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ContentQuery {
    #[serde(default)]
    offset: i64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ContentsQuery {
    cursor: Option<String>,
    limit: Option<usize>,
}

async fn contents(
    State(api): State<Api>,
    Path(id): Path<String>,
    query: std::result::Result<Query<ContentsQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Json<ContentPage>, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid content list query".into()))?;
    Ok(Json(
        api.call(move |store| store.contents(&id, query.cursor, query.limit.unwrap_or(100)))
            .await?,
    ))
}

async fn content(
    State(api): State<Api>,
    Path((id, content)): Path<(String, String)>,
    query: std::result::Result<Query<ContentQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Response, ApiError> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid content query".into()))?;
    let bytes = api
        .call(move |store| store.content(&id, &content, query.offset))
        .await?;
    let next = query.offset + bytes.len() as i64;
    Ok((
        [
            ("content-type", "application/octet-stream".into()),
            ("x-next-offset", next.to_string()),
        ],
        bytes,
    )
        .into_response())
}

struct Subscription {
    api: Api,
    scope: String,
    cursor: i64,
    pending: VecDeque<ChangeEvent>,
    changed: watch::Receiver<u64>,
    stopped: watch::Receiver<bool>,
    ended: bool,
    announced: bool,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

async fn subscribe(
    State(api): State<Api>,
    headers: HeaderMap,
    query: std::result::Result<Query<EventQuery>, axum::extract::rejection::QueryRejection>,
) -> std::result::Result<Sse<impl Stream<Item = std::result::Result<Event, Infallible>>>, ApiError>
{
    let Query(mut query) = query.map_err(|_| Error::Invalid("invalid event query".into()))?;
    if let Some(value) = headers.get("last-event-id") {
        let cursor = value
            .to_str()
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .ok_or_else(|| Error::Invalid("invalid Last-Event-ID".into()))?;
        if query.after_seq.is_some_and(|after| after != cursor) {
            return Err(Error::Invalid("conflicting event cursors".into()).into());
        }
        query.after_seq = Some(cursor);
    }
    let permit = api
        .streams
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::Busy)?;
    let scope = query.scope.clone();
    let cursor = query.after_seq.unwrap_or(0);
    let changed = api.changes.subscribe();
    let stopped = api.stopping.subscribe();
    api.call(move |store| store.events(&scope, cursor, 1))
        .await?;
    let state = Subscription {
        api,
        scope: query.scope,
        cursor,
        pending: VecDeque::new(),
        changed,
        stopped,
        ended: false,
        announced: false,
        _permit: permit,
    };
    let stream = stream::unfold(state, |mut state| async move {
        loop {
            if state.ended || *state.stopped.borrow() {
                return None;
            }
            if !state.announced {
                state.announced = true;
                return Some((Ok(Event::default().comment("connected")), state));
            }
            if let Some(event) = state.pending.pop_front() {
                state.cursor = event.seq;
                let data = serde_json::to_string(&event).expect("change event is serializable");
                return Some((
                    Ok(Event::default()
                        .event("change")
                        .id(event.seq.to_string())
                        .data(data)),
                    state,
                ));
            }
            state.changed.borrow_and_update();
            let scope = state.scope.clone();
            let cursor = state.cursor;
            match state
                .api
                .call(move |store| store.events(&scope, cursor, 32))
                .await
            {
                Ok(page) if page.resync_required => {
                    let data = serde_json::to_string(&ResyncRequired {
                        scope: state.scope.clone(),
                        latest_seq: page.latest_seq,
                        floor_seq: page.floor_seq,
                    })
                    .expect("resync event is serializable");
                    state.ended = true;
                    return Some((Ok(Event::default().event("resync").data(data)), state));
                }
                Ok(page) if !page.items.is_empty() => {
                    state.pending = page.items.into();
                    continue;
                }
                Ok(_) => {}
                Err(error) => {
                    state.ended = true;
                    return Some((
                        Ok(Event::default().event("failure").data(
                            serde_json::to_string(&error.public()).expect("error is serializable"),
                        )),
                        state,
                    ));
                }
            }
            tokio::select! {
                result = state.changed.changed() => { if result.is_err() { return None; } }
                _ = state.stopped.changed() => return None,
            }
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}

// ── Orchestration (Stage 7) ───────────────────────────────────────────────

type JsonResult<T> = std::result::Result<Json<T>, ApiError>;

async fn list_runs(State(api): State<Api>) -> JsonResult<Vec<orchestration::Run>> {
    Ok(Json(api.call(|store| store.list_runs()).await?))
}

async fn schedule_list(State(api): State<Api>) -> JsonResult<Vec<ScheduledAgentTask>> {
    Ok(Json(api.schedules.list_async().await?))
}

async fn schedule_get(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<ScheduledAgentTask> {
    Ok(Json(api.schedules.get(&id)?))
}

async fn schedule_create(
    State(api): State<Api>,
    body: std::result::Result<Json<ScheduleCreate>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<ScheduledAgentTask> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid schedule request".into()))?;
    let task = api.schedules.create(input).await?;
    api.publish();
    Ok(Json(task))
}

async fn schedule_update(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<ScheduleUpdate>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<ScheduledAgentTask> {
    let Json(mut input) = body.map_err(|_| Error::Invalid("invalid schedule update".into()))?;
    if input.id != id {
        return Err(Error::Invalid("schedule id does not match route".into()).into());
    }
    input.id = id;
    let task = api.schedules.update(input)?;
    api.publish();
    Ok(Json(task))
}

async fn schedule_pause(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<ScheduledAgentTask> {
    let task = api.schedules.pause(&id)?;
    api.publish();
    Ok(Json(task))
}

async fn schedule_resume(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<ScheduledAgentTask> {
    let task = api.schedules.resume(&id)?;
    api.publish();
    Ok(Json(task))
}

async fn schedule_delete(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<serde_json::Value> {
    let result = api.schedules.delete(&id)?;
    api.publish();
    Ok(Json(result))
}

async fn schedule_run(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<ScheduleRunResult> {
    let result = api.schedules.run_now(&id).await?;
    api.publish();
    Ok(Json(result))
}

async fn plugin_list(State(api): State<Api>) -> JsonResult<PublicPluginDiscoveryResult> {
    let services = api.plugin_services.clone();
    Ok(Json(
        tokio::task::spawn_blocking(move || services.plugins())
            .await
            .map_err(|_| Error::Closed)?,
    ))
}

async fn plugin_service_status(State(api): State<Api>) -> JsonResult<PluginServiceList> {
    Ok(Json(api.plugin_services.list().await?))
}

async fn plugin_service_start(
    State(api): State<Api>,
    Path((plugin, service)): Path<(String, String)>,
) -> JsonResult<PluginServiceView> {
    let result = api.plugin_services.start(&plugin, &service).await?;
    api.publish();
    Ok(Json(result))
}

async fn plugin_service_stop(
    State(api): State<Api>,
    Path((plugin, service)): Path<(String, String)>,
) -> JsonResult<PluginServiceView> {
    let result = api.plugin_services.stop(&plugin, &service).await?;
    api.publish();
    Ok(Json(result))
}

async fn plugin_service_restart(
    State(api): State<Api>,
    Path((plugin, service)): Path<(String, String)>,
) -> JsonResult<PluginServiceView> {
    let result = api.plugin_services.restart(&plugin, &service).await?;
    api.publish();
    Ok(Json(result))
}

async fn plugin_service_health(
    State(api): State<Api>,
    Path((plugin, service)): Path<(String, String)>,
) -> JsonResult<PluginServiceView> {
    let result = api.plugin_services.check_health(&plugin, &service).await?;
    api.publish();
    Ok(Json(result))
}

async fn create_run(
    State(api): State<Api>,
    body: std::result::Result<Json<CreateRun>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::Run> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid run request".into()))?;
    let run = api.call(move |store| store.create_run(input)).await?;
    api.publish();
    Ok(Json(run))
}

async fn delete_run(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<DeleteRun>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::RunDeletionResult> {
    let force = match body {
        Ok(Json(request)) => request.force,
        Err(_) => false,
    };
    let result = api.call(move |store| store.delete_run(&id, force)).await?;
    api.publish();
    Ok(Json(result))
}

async fn create_run_graph(
    State(api): State<Api>,
    body: std::result::Result<Json<CreateRunGraph>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::GraphMutationResult> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid graph request".into()))?;
    let result = api.call(move |store| store.create_run_graph(input)).await?;
    api.publish();
    Ok(Json(result))
}

async fn apply_task_graph(
    State(api): State<Api>,
    body: std::result::Result<Json<ApplyTaskGraph>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::GraphMutationResult> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid graph edit".into()))?;
    let result = api.call(move |store| store.apply_task_graph(input)).await?;
    api.publish();
    Ok(Json(result))
}

async fn run_snapshot(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<orchestration::RunSnapshot> {
    Ok(Json(api.call(move |store| store.run_snapshot(&id)).await?))
}

async fn ready_tasks(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<Vec<orchestration::Task>> {
    Ok(Json(
        api.call(move |store| store.list_ready_tasks(&id)).await?,
    ))
}

async fn complete_run(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<CompleteRun>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::Run> {
    let Json(request) = body.map_err(|_| Error::Invalid("invalid complete request".into()))?;
    let run = api
        .call(move |store| store.complete_run(&id, request.allow_failed_tasks))
        .await?;
    api.publish();
    Ok(Json(run))
}

async fn abandon_run(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<AbandonRun>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::Run> {
    let reason = match body {
        Ok(Json(request)) => request.reason.unwrap_or_else(|| "Run abandoned".into()),
        Err(_) => "Run abandoned".into(),
    };
    let run = api
        .call(move |store| store.abandon_run(&id, &reason))
        .await?;
    api.publish();
    Ok(Json(run))
}

async fn start_automation_route(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<StartAutomation>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::Run> {
    let Json(input) =
        body.map_err(|_| Error::Invalid("invalid automation start request".into()))?;
    if input.run_id != id {
        return Err(Error::Invalid("runId does not match route".into()).into());
    }
    let run = orchestration::start_automation(&api.database, &api.agents, input).await?;
    api.publish();
    Ok(Json(run))
}

async fn pause_automation_route(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<orchestration::Run> {
    let run = orchestration::pause_automation(&api.database, &id).await?;
    api.publish();
    Ok(Json(run))
}

async fn create_gate(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<CreateGate>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::Gate> {
    let Json(request) = body.map_err(|_| Error::Invalid("invalid gate request".into()))?;
    let gate = api
        .call(move |store| store.create_gate(&id, request))
        .await?;
    api.publish();
    Ok(Json(gate))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunScope {
    run_id: Option<String>,
}

async fn list_tasks(
    State(api): State<Api>,
    query: std::result::Result<Query<RunScope>, axum::extract::rejection::QueryRejection>,
) -> JsonResult<Vec<orchestration::Task>> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid task query".into()))?;
    Ok(Json(
        api.call(move |store| store.list_tasks(query.run_id.as_deref()))
            .await?,
    ))
}

async fn task(State(api): State<Api>, Path(id): Path<String>) -> JsonResult<orchestration::Task> {
    Ok(Json(api.call(move |store| store.task(&id)).await?))
}

async fn create_task(
    State(api): State<Api>,
    body: std::result::Result<Json<CreateTask>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::Task> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid task request".into()))?;
    let task = api.call(move |store| store.create_task(input)).await?;
    api.publish();
    Ok(Json(task))
}

async fn cancel_task(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<CancelTask>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::Task> {
    let reason = match body {
        Ok(Json(request)) => request.reason.unwrap_or_else(|| "cancelled by user".into()),
        Err(_) => "cancelled by user".into(),
    };
    let task = api
        .call(move |store| store.cancel_task(&id, &reason))
        .await?;
    api.publish();
    Ok(Json(task))
}

async fn retry_task(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<orchestration::Task> {
    let task = api.call(move |store| store.retry_task(&id)).await?;
    api.publish();
    Ok(Json(task))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskDelivery {
    body: String,
    #[serde(default)]
    actor_session_id: Option<String>,
}

async fn complete_task(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<TaskDelivery>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::Task> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid task delivery".into()))?;
    let task = settle_task_delivery(&api, &id, input, true).await?;
    api.publish();
    Ok(Json(task))
}

async fn fail_task(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<TaskDelivery>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::Task> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid task delivery".into()))?;
    let task = settle_task_delivery(&api, &id, input, false).await?;
    api.publish();
    Ok(Json(task))
}

async fn settle_task_delivery(
    api: &Api,
    task_id: &str,
    input: TaskDelivery,
    success: bool,
) -> Result<orchestration::Task> {
    crate::database::validate_id(task_id)?;
    crate::database::validate_text(&input.body, 8192, false)?;
    if let Some(actor) = input.actor_session_id.as_deref() {
        crate::database::validate_id(actor)?;
    }
    let actor = input.actor_session_id.clone();
    let body = input.body;
    let task_id_owned = task_id.to_owned();
    let (task, session_id, kick_run) = api
        .call(move |store| {
            let current = store.task(&task_id_owned)?;
            let target = if success {
                orchestration::TaskStatus::Done
            } else {
                orchestration::TaskStatus::Failed
            };
            if current.status == target {
                return Ok((current, None, None));
            }
            let dispatch = store
                .live_dispatch_for_task(&task_id_owned)?
                .ok_or_else(|| {
                    Error::Feature(
                        "worker_dispatch_not_found".into(),
                        "the task has no live worker dispatch".into(),
                    )
                })?;
            if actor
                .as_deref()
                .is_some_and(|actor| actor != dispatch.session_id)
            {
                return Err(Error::Forbidden);
            }
            let outcome = store.settle_dispatch(&dispatch.id, success, &body)?;
            if let Some(coordinator) = store.orch_run(&outcome.task.run_id)?.coordinator_session_id
                && actor.as_deref().is_some_and(|actor| actor != coordinator)
            {
                let label = if success { "完成" } else { "失败" };
                let _ = store.post_message(orchestration::PostMessage {
                    run_id: outcome.task.run_id.clone(),
                    from: actor.clone().unwrap_or_default(),
                    to: coordinator,
                    kind: orchestration::MessageType::Report,
                    subject: format!("任务{label}: {}", outcome.task.title),
                    body: outcome.task.result.clone().unwrap_or_default(),
                    thread_id: None,
                    task_id: Some(outcome.task.id.clone()),
                })?;
            }
            Ok((
                outcome.task,
                Some(dispatch.session_id),
                Some(outcome.dispatch.run_id),
            ))
        })
        .await?;
    if let Some(session_id) = session_id {
        let agents = api.agents.clone();
        tokio::spawn(async move {
            let _ = agents.close(&session_id).await;
        });
    }
    if let Some(run_id) = kick_run {
        orchestration::kick_automation(&api.database, &api.agents, &run_id).await;
    }
    Ok(task)
}

async fn dispatch_task(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<DispatchTask>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::SettleOutcome> {
    let Json(request) = body.map_err(|_| Error::Invalid("invalid dispatch request".into()))?;
    let outcome = api
        .call(move |store| {
            store.dispatch_task(
                &id,
                &request.session_id,
                request.operation_id.as_deref(),
                request.worktree_path.as_deref(),
            )
        })
        .await?;
    api.publish();
    Ok(Json(outcome))
}

// ── Workers & worktrees (Stage 8) ─────────────────────────────────────────

async fn start_worker_route(
    State(api): State<Api>,
    body: std::result::Result<Json<StartWorker>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::WorkerStartOutcome> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid worker start request".into()))?;
    let outcome = orchestration::start_worker(&api.database, &api.agents, input)
        .await
        .map_err(worker_start_error)?;
    api.publish();
    Ok(Json(outcome))
}

fn worker_start_error(error: Error) -> Error {
    match error {
        Error::Closed => Error::Feature(
            "worker_runtime_unavailable".into(),
            "worker runtime channel is unavailable".into(),
        ),
        other => other,
    }
}

async fn stop_worker_route(
    State(api): State<Api>,
    body: std::result::Result<Json<StopWorker>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::SettleOutcome> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid worker stop request".into()))?;
    let outcome = orchestration::stop_worker(&api.database, &api.agents, input).await?;
    api.publish();
    Ok(Json(outcome))
}

async fn list_worktrees(
    State(api): State<Api>,
    query: std::result::Result<Query<RunScope>, axum::extract::rejection::QueryRejection>,
) -> JsonResult<Vec<orchestration::WorktreeAsset>> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid worktree query".into()))?;
    Ok(Json(
        api.call(move |store| store.list_worktree_assets(query.run_id.as_deref()))
            .await?,
    ))
}

async fn worktree_asset_route(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<orchestration::WorktreeAsset> {
    Ok(Json(
        api.call(move |store| store.worktree_asset(&id)).await?,
    ))
}

async fn inspect_worktree_route(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<InspectWorktree>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::WorktreeInspection> {
    let request = body
        .map(|Json(value)| value)
        .unwrap_or(InspectWorktree { target_ref: None });
    let inspection =
        orchestration::inspect_worktree(&api.database, &id, request.target_ref).await?;
    api.publish();
    Ok(Json(inspection))
}

async fn cleanup_worktree_route(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<CleanupWorktree>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::WorktreeCleanupResult> {
    let Json(request) = body.map_err(|_| Error::Invalid("invalid cleanup request".into()))?;
    let result = orchestration::cleanup_worktree(&api.database, &id, request).await?;
    api.publish();
    Ok(Json(result))
}

async fn list_dispatches(
    State(api): State<Api>,
    query: std::result::Result<Query<RunScope>, axum::extract::rejection::QueryRejection>,
) -> JsonResult<Vec<orchestration::Dispatch>> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid dispatch query".into()))?;
    Ok(Json(
        api.call(move |store| store.list_dispatches(query.run_id.as_deref()))
            .await?,
    ))
}

async fn dispatch(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<orchestration::Dispatch> {
    Ok(Json(api.call(move |store| store.dispatch(&id)).await?))
}

async fn dispatch_running(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<orchestration::Dispatch> {
    let dispatch = api
        .call(move |store| store.set_dispatch_running(&id))
        .await?;
    api.publish();
    Ok(Json(dispatch))
}

async fn settle_dispatch(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<SettleDispatch>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::SettleOutcome> {
    let Json(request) = body.map_err(|_| Error::Invalid("invalid settle request".into()))?;
    let outcome = api
        .call(move |store| store.settle_dispatch(&id, request.success, &request.outcome))
        .await?;
    orchestration::kick_automation(&api.database, &api.agents, &outcome.task.run_id).await;
    api.publish();
    Ok(Json(outcome))
}

async fn abandon_dispatch(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<AbandonDispatch>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::SettleOutcome> {
    let request = match body {
        Ok(Json(request)) => request,
        Err(_) => AbandonDispatch {
            reason: None,
            final_status: None,
        },
    };
    let reason = request.reason.unwrap_or_else(|| "worker stopped".into());
    let final_status = match request.final_status.as_deref() {
        Some("cancelled") => orchestration::TaskStatus::Cancelled,
        None | Some("failed") => orchestration::TaskStatus::Failed,
        Some(_) => {
            return Err(Error::Invalid("finalStatus must be failed or cancelled".into()).into());
        }
    };
    let outcome = api
        .call(move |store| store.abandon_dispatch(&id, &reason, final_status))
        .await?;
    api.publish();
    Ok(Json(outcome))
}

async fn recover_dispatches(State(api): State<Api>) -> JsonResult<orchestration::RecoveryReport> {
    let report = api.call(|store| store.recover_dispatches()).await?;
    if !report.settled.is_empty() || !report.resumed.is_empty() {
        api.publish();
    }
    Ok(Json(report))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GateScope {
    run_id: Option<String>,
    status: Option<String>,
}

async fn list_gates(
    State(api): State<Api>,
    query: std::result::Result<Query<GateScope>, axum::extract::rejection::QueryRejection>,
) -> JsonResult<Vec<orchestration::Gate>> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid gate query".into()))?;
    let status = match query.status.as_deref() {
        None => None,
        Some("pending") => Some(orchestration::GateStatus::Pending),
        Some("resolved") => Some(orchestration::GateStatus::Resolved),
        Some("cancelled") => Some(orchestration::GateStatus::Cancelled),
        Some(_) => return Err(Error::Invalid("invalid gate status".into()).into()),
    };
    Ok(Json(
        api.call(move |store| store.list_gates(query.run_id.as_deref(), status))
            .await?,
    ))
}

async fn resolve_gate(
    State(api): State<Api>,
    Path(id): Path<String>,
    body: std::result::Result<Json<ResolveGate>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::Gate> {
    let Json(request) = body.map_err(|_| Error::Invalid("invalid gate decision".into()))?;
    let gate = api
        .call(move |store| store.resolve_gate(&id, &request.decision))
        .await?;
    orchestration::kick_automation(&api.database, &api.agents, &gate.run_id).await;
    api.publish();
    Ok(Json(gate))
}

async fn list_messages(
    State(api): State<Api>,
    query: std::result::Result<Query<RunScope>, axum::extract::rejection::QueryRejection>,
) -> JsonResult<Vec<orchestration::OrchMessage>> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid message query".into()))?;
    Ok(Json(
        api.call(move |store| store.list_messages(query.run_id.as_deref()))
            .await?,
    ))
}

async fn post_message(
    State(api): State<Api>,
    body: std::result::Result<Json<PostMessage>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<orchestration::OrchMessage> {
    let Json(input) = body.map_err(|_| Error::Invalid("invalid message".into()))?;
    let message = api.call(move |store| store.post_message(input)).await?;
    api.publish();
    Ok(Json(message))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnreadScope {
    recipient: String,
    run_id: Option<String>,
}

async fn unread_messages(
    State(api): State<Api>,
    query: std::result::Result<Query<UnreadScope>, axum::extract::rejection::QueryRejection>,
) -> JsonResult<Vec<orchestration::OrchMessage>> {
    let Query(query) = query.map_err(|_| Error::Invalid("invalid unread query".into()))?;
    Ok(Json(
        api.call(move |store| store.unread_messages(&query.recipient, query.run_id.as_deref()))
            .await?,
    ))
}

async fn mark_messages_read(
    State(api): State<Api>,
    body: std::result::Result<Json<MarkMessages>, axum::extract::rejection::JsonRejection>,
) -> JsonResult<serde_json::Value> {
    let Json(request) = body.map_err(|_| Error::Invalid("invalid read request".into()))?;
    api.call(move |store| store.mark_messages_read(&request.ids))
        .await?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn mark_message_answered(
    State(api): State<Api>,
    Path(id): Path<String>,
) -> JsonResult<orchestration::OrchMessage> {
    let message = api
        .call(move |store| store.mark_message_answered(&id))
        .await?;
    api.publish();
    Ok(Json(message))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn saturated_account_requests_fail_fast_instead_of_waiting_on_the_outer_permit() {
        use super::*;
        let root = tempfile::tempdir().unwrap();
        let database = crate::worker::Database::open(root.path().to_path_buf())
            .await
            .unwrap();
        let api = Api::new(database.clone(), Token::parse("a".repeat(64)).unwrap());
        let count = api.requests.available_permits() as u32;
        let held = api
            .requests
            .clone()
            .acquire_many_owned(count)
            .await
            .unwrap();
        let response = tokio::time::timeout(
            Duration::from_millis(100),
            accounts_route(
                State(api.clone()),
                Ok(Json(
                    json!({"type":"agent.accounts.list","requestId":"saturated"}),
                )),
            ),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        drop(held);
        database.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn remote_session_signals_route_pty_interrupt_and_close_to_the_terminal() {
        use super::*;
        let root = tempfile::tempdir().unwrap();
        let database = crate::worker::Database::open(root.path().to_path_buf())
            .await
            .unwrap();
        let api = Api::new(database.clone(), Token::parse("a".repeat(64)).unwrap());
        let input=serde_json::from_value(json!({"title":"remote-control","workspace":root.path(),"size":{"cols":80,"rows":24},"agent":"custom","command":"trap 'printf INTERRUPTED' INT; printf READY; while :; do sleep 0.1; done"})).unwrap();
        let head = api.terminals.create(input).await.unwrap();
        async fn wait_text(api: &Api, id: &str, marker: &str) {
            tokio::time::timeout(Duration::from_secs(5), async {
                let mut cursor = 0;
                let mut bytes = Vec::new();
                loop {
                    let page = api
                        .terminals
                        .read(
                            id.to_owned(),
                            TerminalQuery {
                                after_seq: Some(cursor),
                                wait_ms: Some(100),
                            },
                        )
                        .await
                        .unwrap();
                    cursor = page.next_seq;
                    for event in page.events {
                        if let TerminalEvent::Output { data_b64 } = event {
                            bytes.extend(BASE64_STANDARD.decode(data_b64).unwrap());
                        }
                    }
                    if String::from_utf8_lossy(&bytes).contains(marker) {
                        break;
                    }
                }
            })
            .await
            .unwrap();
        }
        wait_text(&api, &head.id, "READY").await;
        signal_session(&api, &head.id, false).await.unwrap();
        wait_text(&api, &head.id, "INTERRUPTED").await;
        signal_session(&api, &head.id, true).await.unwrap();
        api.terminals.shutdown().await.unwrap();
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_account_probe_releases_its_inflight_lease() {
        let testing =
            std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::from([
                "probe".to_owned(),
            ])));
        let (ready, started) = tokio::sync::oneshot::channel();
        let entries = testing.clone();
        let task = tokio::spawn(async move {
            let _lease = super::ApiTestLease {
                account: "probe".into(),
                testing: entries,
                released: false,
            };
            ready.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        started.await.unwrap();
        task.abort();
        let _ = task.await;
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while testing.lock().await.contains("probe") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        testing.lock().await.insert("probe".into());
        super::ApiTestLease {
            account: "probe".into(),
            testing: testing.clone(),
            released: false,
        }
        .release()
        .await;
        testing.lock().await.insert("probe".into());
        tokio::task::yield_now().await;
        assert!(
            testing.lock().await.contains("probe"),
            "completed lease must not release a newer probe"
        );
    }

    use super::*;

    #[tokio::test]
    async fn projection_cache_invalidates_on_session_change() {
        let dir = tempfile::TempDir::new().unwrap();
        let database = Database::open(dir.path().into()).await.unwrap();
        let mut api = Api::new(
            database.clone(),
            Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
                .unwrap(),
        );
        api.schedules = Schedules::with_directory(dir.path().join("schedules"), api.agents.clone());
        let head = database
            .call(|store| {
                store.create_session(CreateSession {
                    agent: AgentKind::Claude,
                    kind: SessionKind::Structured,
                    title: "before".into(),
                    workspace: "/synthetic".into(),
                })
            })
            .await
            .unwrap();
        api.write_status_projection(7000, None, "token".into())
            .await
            .unwrap();
        api.write_status_projection(7000, None, "token".into())
            .await
            .unwrap();
        let id = head.id.clone();
        database
            .call(move |store| {
                store.update_session(
                    &id,
                    UpdateSession {
                        revision: head.revision,
                        title: Some("after".into()),
                        lifecycle: None,
                        status: None,
                    },
                )
            })
            .await
            .unwrap();
        api.write_status_projection(7000, None, "token".into())
            .await
            .unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("status.json")).unwrap())
                .unwrap();
        assert_eq!(value["sessions"][0]["title"], "after");
        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn projection_coalesces_bursts_but_keeps_heartbeat() {
        let dir = tempfile::TempDir::new().unwrap();
        let database = Database::open(dir.path().into()).await.unwrap();
        let mut api = Api::new(
            database.clone(),
            Token::parse("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into())
                .unwrap(),
        );
        api.schedules = Schedules::with_directory(dir.path().join("schedules"), api.agents.clone());
        let (stop, stopping) = watch::channel(false);
        let worker = api.clone();
        let task = tokio::spawn(async move {
            worker
                .run_status_projection(7000, None, "token".into(), stopping)
                .await;
        });
        let path = dir.path().join("status.json");
        tokio::time::timeout(Duration::from_secs(3), async {
            while !path.exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let mut times = std::collections::HashSet::new();
        for _ in 0..40 {
            api.publish();
            tokio::time::sleep(Duration::from_millis(5)).await;
            let status: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            times.insert(status["builtAt"].as_i64().unwrap());
        }
        assert!(times.len() <= 6, "burst wrote too often: {}", times.len());
        let before = *times.iter().max().unwrap();
        tokio::time::sleep(Duration::from_millis(1100)).await;
        let status: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(status["builtAt"].as_i64().unwrap() > before);
        stop.send(true).unwrap();
        task.await.unwrap();
        database.shutdown().await.unwrap();
    }

    #[test]
    fn worker_start_runtime_failures_are_not_mislabeled_as_database_failures() {
        let body = worker_start_error(Error::Closed).public();
        assert_eq!(body.code, "worker_runtime_unavailable");
        assert!(!body.message.contains("database worker"));
    }

    #[test]
    fn terminal_page_output_reencodes_each_event() {
        let page = TerminalPage {
            initial_size: TerminalSize { cols: 80, rows: 24 },
            base_seq: 0,
            next_seq: 2,
            latest_seq: 2,
            floor_seq: 0,
            events: vec![
                TerminalEvent::Output {
                    data_b64: BASE64_STANDARD.encode(b"a"),
                },
                TerminalEvent::Resize {
                    size: TerminalSize {
                        cols: 100,
                        rows: 30,
                    },
                },
                TerminalEvent::Output {
                    data_b64: BASE64_STANDARD.encode(b"bc"),
                },
            ],
            resync_required: false,
            exited: false,
            exit_code: None,
        };
        let encoded = terminal_page_output_b64(&page).unwrap();
        assert_eq!(BASE64_STANDARD.decode(encoded).unwrap(), b"abc");
    }

    #[test]
    fn terminal_page_output_rejects_invalid_event_data() {
        let page = TerminalPage {
            initial_size: TerminalSize { cols: 80, rows: 24 },
            base_seq: 0,
            next_seq: 1,
            latest_seq: 1,
            floor_seq: 0,
            events: vec![TerminalEvent::Output {
                data_b64: "not base64".into(),
            }],
            resync_required: false,
            exited: false,
            exit_code: None,
        };
        assert!(terminal_page_output_b64(&page).is_err());
    }
}
