use std::collections::VecDeque;
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

use crate::auth::Token;
use crate::database::Store;
use crate::error::{Error, Result};
use crate::protocol::*;
use crate::terminal::{
    CreateTerminal, TerminalInput, TerminalPage, TerminalQuery, TerminalSize, runtime::Terminals,
};
use crate::worker::Database;

#[derive(Clone)]
pub struct Api {
    pub database: Database,
    pub terminals: Terminals,
    token: Token,
    changes: watch::Sender<u64>,
    stopping: watch::Sender<bool>,
    requests: Arc<Semaphore>,
    streams: Arc<Semaphore>,
    terminal_reads: Arc<Semaphore>,
}

impl Api {
    pub fn new(database: Database, token: Token) -> Self {
        let terminals = Terminals::new(database.clone());
        let changes = terminals.changes();
        Self {
            terminals,
            database,
            token,
            changes,
            stopping: watch::channel(false).0,
            requests: Arc::new(Semaphore::new(32)),
            streams: Arc::new(Semaphore::new(16)),
            terminal_reads: Arc::new(Semaphore::new(16)),
        }
    }

    pub fn router(&self) -> Router {
        Router::new()
            .route("/v1/health", get(health))
            .route("/v1/shutdown", post(shutdown))
            .route("/v1/terminals", post(create_terminal))
            .route("/v1/terminals/{id}/output", get(terminal_output))
            .route("/v1/terminals/{id}/input", post(terminal_input))
            .route("/v1/terminals/{id}/resize", post(terminal_resize))
            .route("/v1/terminals/{id}/close", post(terminal_close))
            .route("/v1/sessions", get(sessions))
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
            .fallback(|| async { ApiError(Error::NotFound) })
            .layer(DefaultBodyLimit::max(16 * 1024))
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
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Conflict | Error::AlreadyRunning => StatusCode::CONFLICT,
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
    Ok(Json(Health {
        api_version: API_VERSION,
        backend: "rust".into(),
        active_runtime_sessions: api.terminals.count(),
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
            #[cfg(unix)]
            "terminal.unix",
            "terminal.output.page",
            "events.replay",
            "events.stream",
        ]
        .map(str::to_owned)
        .to_vec(),
    }))
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
