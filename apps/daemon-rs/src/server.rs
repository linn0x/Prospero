use std::collections::{BTreeMap, HashSet, VecDeque};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{
    IntoResponse, Response, Sse,
    sse::{Event, KeepAlive},
};
use axum::{
    Json, Router,
    routing::{get, post},
};
use futures_util::{Stream, stream};
use tokio::sync::{Semaphore, watch};

use crate::agent::Agents;
use crate::agent::{
    AgentModeSelection, AgentModelSelection, AgentSend, CreateAgentSession, PermissionDecision,
    PermissionMode, QuestionDecision, UsageReport, UsageResult, mode_catalog,
};
use crate::auth::Token;
use crate::database::Store;
use crate::error::{Error, Result};
use crate::orchestration::{
    self, AbandonDispatch, AbandonRun, ApplyTaskGraph, CancelTask, CleanupWorktree, CompleteRun,
    CreateGate, CreateRun, CreateRunGraph, CreateTask, DeleteRun, DispatchTask, InspectWorktree,
    MarkMessages, PostMessage, ResolveGate, SettleDispatch, StartWorker, StopWorker,
};
use crate::protocol::*;
use crate::terminal::{
    CreateTerminal, TerminalInput, TerminalPage, TerminalQuery, TerminalSize, TerminalSnapshot,
    runtime::Terminals,
};
use crate::worker::Database;

#[derive(Clone)]
pub struct Api {
    pub database: Database,
    pub terminals: Terminals,
    pub agents: Agents,
    token: Token,
    changes: watch::Sender<u64>,
    stopping: watch::Sender<bool>,
    requests: Arc<Semaphore>,
    streams: Arc<Semaphore>,
    terminal_reads: Arc<Semaphore>,
    terminal_snapshots: Arc<Semaphore>,
    api_tests: Arc<Semaphore>,
    api_testing: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
    api_features: Arc<Semaphore>,
}

impl Api {
    pub fn new(database: Database, token: Token) -> Self {
        Self::with_guard(database, token, None)
    }

    pub fn with_guard(database: Database, token: Token, guard: Option<std::path::PathBuf>) -> Self {
        let terminals = Terminals::with_guard(database.clone(), guard);
        let changes = terminals.changes();
        let agents = Agents::new(database.clone());
        // Forward agent notifications onto the shared change watch.
        let mut agent_changes = agents.changes().subscribe();
        let shared_changes = changes.clone();
        tokio::spawn(async move {
            while agent_changes.changed().await.is_ok() {
                shared_changes.send_modify(|seq| *seq = seq.wrapping_add(1));
            }
        });
        Self {
            terminals,
            agents,
            database,
            token,
            changes,
            stopping: watch::channel(false).0,
            requests: Arc::new(Semaphore::new(32)),
            streams: Arc::new(Semaphore::new(16)),
            terminal_reads: Arc::new(Semaphore::new(16)),
            terminal_snapshots: Arc::new(Semaphore::new(2)),
            api_tests: Arc::new(Semaphore::new(4)),
            api_testing: Arc::new(tokio::sync::Mutex::new(std::collections::HashSet::new())),
            api_features: Arc::new(Semaphore::new(4)),
        }
    }

    pub fn router(&self) -> Router {
        Router::new()
            .route("/v1/health", get(health))
            .route("/v1/shutdown", post(shutdown))
            .route("/v1/agent-sessions", post(create_agent))
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
            .route("/v1/agent-sessions/{id}/interrupt", post(agent_interrupt))
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
            .route("/v1/runs/{id}/gates", post(create_gate))
            .route("/v1/tasks", get(list_tasks).post(create_task))
            .route("/v1/tasks/{id}", get(task))
            .route("/v1/tasks/{id}/cancel", post(cancel_task))
            .route("/v1/tasks/{id}/retry", post(retry_task))
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
            Error::Busy | Error::Closed => StatusCode::SERVICE_UNAVAILABLE,
            Error::Timeout => StatusCode::GATEWAY_TIMEOUT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(self.0.public())).into_response()
    }
}

async fn authorize(State(api): State<Api>, request: Request, next: Next) -> Response {
    if request.headers().contains_key("origin") {
        return ApiError(Error::Forbidden).into_response();
    }
    if request.headers().get_all("authorization").iter().count() != 1
        || !request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| api.token.accepts(value))
    {
        return ApiError(Error::Unauthorized).into_response();
    }
    let Ok(_permit) = api.requests.clone().try_acquire_owned() else {
        return ApiError(Error::Busy).into_response();
    };
    let mut response = match tokio::time::timeout(Duration::from_secs(10), next.run(request)).await
    {
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

async fn health(State(api): State<Api>) -> std::result::Result<Json<Health>, ApiError> {
    api.call(|_| Ok(())).await?;
    api.terminals.check()?;
    api.agents.check()?;
    Ok(Json(Health {
        api_version: API_VERSION,
        backend: "rust".into(),
        active_runtime_sessions: api.terminals.count() + api.agents.count(),
        database_queue_capacity: DATABASE_QUEUE_CAPACITY,
        capabilities: [
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
            #[cfg(unix)]
            "terminal.unix",
            "terminal.output.page",
            "terminal.snapshot",
            "events.replay",
            "events.stream",
            "agent.account.api.models",
            "agent.account.config",
            "agent.api-validation.v1",
            "agent.api-protocols.v1",
            "model.sources.v1",
        ]
        .map(str::to_owned)
        .to_vec(),
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
        let Some(secret) = crate::accounts::managed::profile_secret(data, &account.id)? else {
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
        } => {
            let data = api.database.directory().to_owned();
            let outcome = match api
                .database
                .call(move |store| {
                    let accounts = store.list_managed_accounts(&data)?;
                    let known = accounts
                        .into_iter()
                        .map(|account| account.id)
                        .collect::<HashSet<_>>();
                    let mut sources = crate::accounts::sources::ModelSources::open(&data)?;
                    let outcome = sources.bind(&source_id, &route_id, revision, &known)?;
                    if let BindOutcome::Created {
                        account_id,
                        profile,
                        name,
                        secret,
                    } = &outcome
                    {
                        store.insert_api_profile_account_with_id(
                            &data, account_id, name, profile, secret,
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
                Err(error) => return ApiError(error).into_response(),
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
                        let Some(secret) = crate::accounts::managed::profile_secret(&data, id)?
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
                Err(error) => return ApiError(error).into_response(),
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
                Err(error) => return ApiError(error).into_response(),
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

/// Tag-dispatched account control. Managed metadata mutations run through the
/// database queue; login spawns an isolated `claude setup-token` PTY; the
/// `api.test`/`api.models.get` profile actions return dedicated envelopes.
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
    let _permit = match api.requests.acquire().await {
        Ok(permit) => permit,
        Err(_) => return ApiError(Error::Closed).into_response(),
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
    match scope.as_deref() {
        None | Some("protocol") => {}
        Some("engine") => {
            return ApiError(Error::Invalid("引擎验证尚未接入 Rust daemon".into())).into_response();
        }
        Some(_) => {
            return ApiError(Error::Invalid("连接测试范围无效".into())).into_response();
        }
    }
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
    let outcome = run_profile_test(&api, &request_id, account_id).await;
    {
        let mut testing = api.api_testing.lock().await;
        testing.remove(account_id);
    }
    let validation = match outcome {
        Ok(validation) => validation,
        Err(error) => return ApiError(error).into_response(),
    };
    let result = match crate::accounts::respond(
        &api.database,
        &control,
        Some(account_id.clone()),
        None,
        Some(validation),
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
                let secret = crate::accounts::managed::profile_secret(&data, &id)?;
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
            let size = match size.validate() {
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
        match crate::accounts::respond(&api.database, &control, account_id, session_id, None).await
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
    use crate::accounts::models::{FeatureError, ModelsResult, fetch_models};
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
                        let secret = crate::accounts::managed::profile_secret(&data, &id)?;
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
                fetch_models(&profile.base_url, &secret, &headers).await
            }
            None => {
                let base_url = draft_base_url.unwrap_or("");
                let key = draft_key.unwrap_or("");
                if protocol.is_some_and(|protocol| protocol != "anthropic") {
                    return Err(FeatureError::new(
                        "unsupported",
                        "Rust daemon 目前仅支持 Anthropic 协议",
                    ));
                }
                let headers = crate::accounts::profile::clean_headers(draft_headers)
                    .map_err(|error| FeatureError::new("invalid_request", &error.to_string()))?;
                fetch_models(base_url, key, &headers.unwrap_or_default()).await
            }
        }
    };
    match load.await {
        Ok(models) => ModelsResult::success(request_id, models),
        Err(error) => ModelsResult::failure(request_id, error),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchModelsQuery {
    agent: String,
    #[serde(default)]
    account_id: Option<String>,
}

/// Launch model catalog for the desktop new-session dialog. Serves the native
/// Claude environment and managed Claude accounts; other agents are a 400 and
/// unknown accounts a 404, so the desktop never shows a fabricated catalog.
async fn launch_models(
    State(api): State<Api>,
    Query(query): Query<LaunchModelsQuery>,
) -> std::result::Result<Json<crate::agent::LaunchModelCatalog>, ApiError> {
    if query.agent != "claude" {
        return Err(ApiError(Error::Invalid(
            "invalid model catalog agent".into(),
        )));
    }
    let _permit = api.requests.acquire().await.map_err(|_| Error::Closed)?;
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
    let mode = match selection.mode.as_str() {
        "default" => PermissionMode::Default,
        "plan" => PermissionMode::Plan,
        _ => return Err(ApiError(Error::Invalid("会话模式无效".into()))),
    };
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
    api.terminals.close(&id)?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn shutdown(State(api): State<Api>) -> impl IntoResponse {
    api.stop();
    (StatusCode::ACCEPTED, Json(serde_json::json!({"ok":true})))
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
    let outcome = orchestration::start_worker(&api.database, &api.agents, input).await?;
    api.publish();
    Ok(Json(outcome))
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
