use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::{Mutex, Semaphore, oneshot, watch};

use super::claude::{AdapterEvent, ClaudeTurn, spawn_turn};
use super::store::ApprovalPolicy;
use super::*;
use crate::error::{Error, Result};
use crate::protocol::*;
use crate::worker::Database;

const MAX_TURNS: usize = 16;

struct Handle {
    driver: Mutex<ClaudeTurn>,
    replies: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    /// request id -> timeline record id of pending approvals.
    records: Mutex<HashMap<String, String>>,
}

struct Session {
    handle: Mutex<Option<Arc<Handle>>>,
    ended: watch::Sender<()>,
    /// Concurrency slot; released when the session entry is dropped.
    #[allow(dead_code)]
    permit: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
}

struct State {
    database: Database,
    entries: Mutex<HashMap<String, Arc<Session>>>,
    slots: Arc<Semaphore>,
    closed: AtomicBool,
    failed: AtomicBool,
    changed: watch::Sender<u64>,
}

#[derive(Clone)]
pub struct Agents(Arc<State>);

impl Agents {
    pub fn new(database: Database) -> Self {
        Self(Arc::new(State {
            database,
            entries: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(MAX_TURNS)),
            closed: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            changed: watch::channel(0).0,
        }))
    }

    pub fn count(&self) -> usize {
        MAX_TURNS - self.0.slots.available_permits()
    }

    pub(crate) fn changes(&self) -> watch::Sender<u64> {
        self.0.changed.clone()
    }

    pub fn check(&self) -> Result<()> {
        if self.0.failed.load(Ordering::Acquire) {
            Err(Error::Closed)
        } else {
            Ok(())
        }
    }

    pub async fn create(&self, input: CreateAgentSession) -> Result<SessionHead> {
        crate::database::validate_text(&input.title, 512, false)?;
        if input.workspace.len() > 4096 || input.workspace.trim().is_empty() {
            return Err(Error::Invalid("invalid workspace".into()));
        }
        if !Path::new(&input.workspace).is_absolute() {
            return Err(Error::Invalid("workspace must be absolute".into()));
        }
        if self.0.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let workspace = tokio::task::spawn_blocking({
            let workspace = input.workspace.clone();
            move || std::fs::canonicalize(workspace)
        })
        .await
        .map_err(|_| Error::Closed)??;
        if !workspace.is_dir() {
            return Err(Error::Invalid("workspace is not a directory".into()));
        }
        let workspace = workspace
            .to_str()
            .ok_or_else(|| Error::Invalid("workspace must be Unicode".into()))?
            .to_owned();
        let permit = self
            .0
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy)?;
        let policy = if input.auto_approve {
            ApprovalPolicy::Auto
        } else {
            ApprovalPolicy::Manual
        };
        let create = CreateAgentSession {
            title: input.title,
            workspace,
            auto_approve: input.auto_approve,
        };
        let head = self
            .0
            .database
            .call(move |store| store.create_agent_session(create, policy))
            .await?;
        let (ended, _) = watch::channel(());
        self.0.entries.lock().await.insert(
            head.id.clone(),
            Arc::new(Session {
                handle: Mutex::new(None),
                ended,
                permit: Mutex::new(Some(permit)),
            }),
        );
        self.publish();
        Ok(head)
    }

    async fn session_entry(&self, id: &str) -> Result<Arc<Session>> {
        crate::database::validate_id(id)?;
        self.0
            .entries
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or(Error::NotFound)
    }

    pub async fn send(&self, id: &str, text: String) -> Result<()> {
        if text.is_empty() || text.len() > 64 * 1024 {
            return Err(Error::Invalid("invalid message".into()));
        }
        let entry = self.session_entry(id).await?;
        let mut guard = entry.handle.lock().await;
        if guard.is_some() {
            return Err(Error::Conflict);
        }
        let run = self
            .0
            .database
            .call({
                let id = id.to_owned();
                move |store| {
                    let run = store.agent_run(&id)?;
                    if !run.active {
                        return Err(Error::Conflict);
                    }
                    Ok(run)
                }
            })
            .await?;
        let (turn, native_id) = {
            let id = id.to_owned();
            self.0
                .database
                .call(move |store| store.begin_agent_turn(&id))
                .await?
        };
        let workspace = {
            let id = id.to_owned();
            self.0
                .database
                .call(move |store| Ok(store.session(&id)?.workspace))
                .await?
        };
        // Expand @file/$skill mentions for the CLI while the stored user
        // record keeps the original text (mirrors legacy structured-session).
        let expanded = tokio::task::spawn_blocking({
            let workspace = workspace.clone();
            let prompt = text.clone();
            move || crate::skills::expand_prompt(&workspace, &prompt)
        })
        .await
        .map_err(|_| Error::Closed)?;
        self.set_status(id, SessionStatus::Running).await?;
        // Persist the user's original message before invoking the provider.
        let user_write = TimelineWrite {
            id: format!("turn{turn}-user"),
            turn_id: format!("turn{turn}"),
            expected_revision: 0,
            body: TimelineBody::Message {
                role: MessageRole::User,
                final_answer: false,
            },
            text,
            replace: false,
        };
        {
            let id = id.to_owned();
            self.0
                .database
                .call(move |store| store.append_agent_records(&id, vec![user_write]))
                .await?;
        }
        let driver = spawn_turn(&workspace, &expanded, native_id.as_deref(), run.policy)?;
        let handle = Arc::new(Handle {
            driver: Mutex::new(driver),
            replies: Mutex::new(HashMap::new()),
            records: Mutex::new(HashMap::new()),
        });
        *guard = Some(handle.clone());
        drop(guard);
        self.spawn_turn(id.to_owned(), turn, handle);
        Ok(())
    }

    fn spawn_turn(&self, id: String, turn: i64, handle: Arc<Handle>) {
        let runtime = self.clone();
        tokio::spawn(async move {
            runtime.run_turn(id.clone(), turn, handle.clone()).await;
            if let Ok(entry) = runtime.session_entry(&id).await {
                *entry.handle.lock().await = None;
                entry.ended.send_replace(());
            }
            runtime.publish();
        });
    }

    async fn run_turn(&self, id: String, turn: i64, handle: Arc<Handle>) {
        let mut events = {
            let mut driver = handle.driver.lock().await;
            match driver.take_events() {
                Some(events) => events,
                None => return,
            }
        };
        // Revision counters for streaming records that get rewritten in place.
        let mut revisions: HashMap<String, i64> = HashMap::new();
        let mut pending: Vec<TimelineWrite> = Vec::new();
        let mut native_persisted = false;
        let mut interrupted = false;
        let mut failure: Option<String> = None;

        macro_rules! flush {
            () => {{
                let writes = std::mem::take(&mut pending);
                if !writes.is_empty() {
                    let result = self
                        .0
                        .database
                        .call({
                            let id = id.clone();
                            move |store| store.append_agent_records(&id, writes)
                        })
                        .await;
                    if let Err(error) = result {
                        self.0.failed.store(true, Ordering::Release);
                        failure = Some(error.to_string());
                        break;
                    }
                }
            }};
        }

        loop {
            let Some(event) = events.recv().await else {
                failure.get_or_insert_with(|| "agent stream closed".into());
                break;
            };
            match event {
                AdapterEvent::NativeId(native_id) => {
                    if !native_persisted {
                        native_persisted = true;
                        let result = {
                            let id = id.clone();
                            let native = native_id;
                            self.0
                                .database
                                .call(move |store| store.set_agent_native_id(&id, turn, &native))
                                .await
                        };
                        if result.is_err() {
                            failure = result.err().map(|error| error.to_string());
                            break;
                        }
                    }
                }
                AdapterEvent::Text(text) => {
                    let record = format!("turn{turn}-answer");
                    let revision = revisions.get(&record).copied().unwrap_or(0);
                    pending.push(TimelineWrite {
                        id: record.clone(),
                        turn_id: format!("turn{turn}"),
                        expected_revision: revision,
                        body: TimelineBody::Message {
                            role: MessageRole::Assistant,
                            final_answer: true,
                        },
                        text: bounded_text(text),
                        replace: true,
                    });
                    revisions.insert(record, revision + 1);
                    flush!();
                }
                AdapterEvent::Thinking(text) => {
                    let record = format!("turn{turn}-reasoning");
                    let revision = revisions.get(&record).copied().unwrap_or(0);
                    pending.push(TimelineWrite {
                        id: record.clone(),
                        turn_id: format!("turn{turn}"),
                        expected_revision: revision,
                        body: TimelineBody::Reasoning,
                        text: bounded_text(text),
                        replace: true,
                    });
                    revisions.insert(record, revision + 1);
                    flush!();
                }
                AdapterEvent::ToolCall {
                    call_id,
                    name,
                    summary,
                } => {
                    pending.push(TimelineWrite {
                        id: call_id.clone(),
                        turn_id: format!("turn{turn}"),
                        expected_revision: 0,
                        body: TimelineBody::Tool {
                            name,
                            state: ToolState::Running,
                            summary,
                        },
                        text: String::new(),
                        replace: false,
                    });
                    revisions.insert(call_id, 1);
                    flush!();
                }
                AdapterEvent::ToolResult {
                    call_id,
                    name,
                    summary,
                    error,
                } => {
                    let revision = revisions.get(&call_id).copied().unwrap_or(1);
                    pending.push(TimelineWrite {
                        id: call_id.clone(),
                        turn_id: format!("turn{turn}"),
                        expected_revision: revision,
                        body: TimelineBody::Tool {
                            name,
                            state: if error {
                                ToolState::Failed
                            } else {
                                ToolState::Success
                            },
                            summary: String::new(),
                        },
                        text: summary,
                        replace: false,
                    });
                    revisions.insert(call_id, revision + 1);
                    flush!();
                }
                AdapterEvent::Permission {
                    request_id,
                    tool,
                    summary,
                    reply,
                } => {
                    flush!();
                    let record_id = format!("turn{turn}-perm-{request_id}");
                    handle
                        .replies
                        .lock()
                        .await
                        .insert(request_id.clone(), reply);
                    handle
                        .records
                        .lock()
                        .await
                        .insert(request_id.clone(), record_id.clone());
                    let write = TimelineWrite {
                        id: record_id,
                        turn_id: format!("turn{turn}"),
                        expected_revision: 0,
                        body: TimelineBody::PermissionRequest {
                            request_id,
                            tool,
                            resolved: false,
                        },
                        text: summary,
                        replace: false,
                    };
                    let result = self
                        .0
                        .database
                        .call({
                            let id = id.clone();
                            move |store| store.append_agent_records(&id, vec![write])
                        })
                        .await;
                    if result.is_err() {
                        failure = result.err().map(|error| error.to_string());
                        break;
                    }
                    self.set_status(&id, SessionStatus::WaitingPermission)
                        .await
                        .ok();
                }
                AdapterEvent::Finish {
                    interrupted: was_interrupted,
                    error,
                } => {
                    interrupted = was_interrupted;
                    failure = error;
                    break;
                }
            }
        }

        // Terminal records: error (if any) and the turn end marker.
        let finish = if interrupted {
            "interrupted"
        } else if failure.is_some() {
            "failed"
        } else {
            "completed"
        };
        let mut terminal = Vec::new();
        if let Some(message) = &failure {
            terminal.push(TimelineWrite {
                id: format!("turn{turn}-error"),
                turn_id: format!("turn{turn}"),
                expected_revision: 0,
                body: TimelineBody::Error,
                text: bounded_text(message.clone()),
                replace: false,
            });
        }
        terminal.push(TimelineWrite {
            id: format!("turn{turn}-end"),
            turn_id: format!("turn{turn}"),
            expected_revision: 0,
            body: TimelineBody::TurnEnd {
                finish: finish.into(),
            },
            text: String::new(),
            replace: false,
        });
        let _ = {
            let id = id.clone();
            self.0
                .database
                .call(move |store| store.append_agent_records(&id, terminal))
                .await
        };
        let status = if failure.is_some() {
            SessionStatus::Failed
        } else {
            SessionStatus::Idle
        };
        self.set_status(&id, status).await.ok();
    }

    async fn set_status(&self, id: &str, status: SessionStatus) -> Result<SessionHead> {
        let head = self
            .0
            .database
            .call({
                let id = id.to_owned();
                move |store| {
                    let head = store.session(&id)?;
                    store.update_session(
                        &id,
                        UpdateSession {
                            revision: head.revision,
                            title: None,
                            lifecycle: None,
                            status: Some(status),
                        },
                    )
                }
            })
            .await?;
        self.publish();
        Ok(head)
    }

    fn publish(&self) {
        self.0.changed.send_modify(|seq| *seq = seq.wrapping_add(1));
    }

    pub async fn respond_permission(&self, id: &str, request_id: &str, allow: bool) -> Result<()> {
        crate::database::validate_id(request_id)?;
        let entry = self.session_entry(id).await?;
        let guard = entry.handle.lock().await;
        let handle = guard.as_ref().ok_or(Error::NotFound)?;
        let reply = handle
            .replies
            .lock()
            .await
            .remove(request_id)
            .ok_or(Error::NotFound)?;
        let record_id = handle.records.lock().await.remove(request_id);
        // The translator's reply task owns the control_response frame.
        let _ = reply.send(allow);
        drop(guard);
        if let Some(record_id) = record_id {
            let id = id.to_owned();
            let result = self
                .0
                .database
                .call(move |store| store.resolve_agent_permission(&id, &record_id))
                .await;
            // A concurrently-archived session makes the record update moot.
            if !matches!(result, Err(Error::NotFound)) {
                result?;
            }
        }
        self.set_status(id, SessionStatus::Running).await?;
        Ok(())
    }

    pub async fn interrupt(&self, id: &str) -> Result<()> {
        let entry = self.session_entry(id).await?;
        let guard = entry.handle.lock().await;
        let handle = guard.as_ref().ok_or(Error::NotFound)?;
        // Any unresolved approvals are rejected when the turn is interrupted.
        let pending: Vec<_> = std::mem::take(&mut *handle.replies.lock().await)
            .into_iter()
            .collect();
        std::mem::take(&mut *handle.records.lock().await);
        for (_request_id, reply) in pending {
            // The translator's reply task writes the deny frame.
            let _ = reply.send(false);
        }
        drop(guard);
        let resolved = {
            let id = id.to_owned();
            self.0
                .database
                .call(move |store| store.resolve_all_agent_permissions(&id))
                .await?
        };
        if resolved > 0 {
            self.publish();
        }
        // Tell the CLI to stop after it finishes the current response.
        let entry = self.session_entry(id).await?;
        if let Some(handle) = entry.handle.lock().await.as_ref() {
            handle.driver.lock().await.interrupt();
        }
        Ok(())
    }

    pub async fn close(&self, id: &str) -> Result<()> {
        if let Ok(entry) = self.session_entry(id).await {
            if let Some(handle) = entry.handle.lock().await.take() {
                let pending = std::mem::take(&mut *handle.replies.lock().await);
                for (_request_id, reply) in pending {
                    // The translator's reply task owns the deny frame; sending
                    // here is enough, calling driver.respond_permission too
                    // would write the frame twice.
                    let _ = reply.send(false);
                }
                handle.driver.lock().await.kill();
                let mut ended = entry.ended.subscribe();
                let _ = tokio::time::timeout(Duration::from_secs(3), ended.changed()).await;
            }
            self.0.entries.lock().await.remove(id);
        }
        let id = id.to_owned();
        self.0
            .database
            .call(move |store| store.archive_agent_session(&id, true))
            .await?;
        self.publish();
        Ok(())
    }

    /// Archive runs left active by a previous daemon process. The provider
    /// process is gone with that daemon, so turns are never replayed.
    pub async fn recover(&self) -> Result<usize> {
        let ids: Vec<String> = self
            .0
            .database
            .call(|store| {
                let mut statement = store.connection.prepare(
                    "SELECT session_id FROM agent_runs WHERE active=1 ORDER BY session_id",
                )?;
                let ids = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(ids)
            })
            .await?;
        for id in &ids {
            let id = id.clone();
            self.0
                .database
                .call(move |store| store.archive_agent_session(&id, true))
                .await?;
        }
        Ok(ids.len())
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.0.closed.store(true, Ordering::Release);
        let sessions: Vec<Arc<Session>> = self.0.entries.lock().await.values().cloned().collect();
        for session in &sessions {
            if let Some(handle) = session.handle.lock().await.take() {
                let pending = std::mem::take(&mut *handle.replies.lock().await);
                for (_request_id, reply) in pending {
                    // See close(): the translator task writes the deny frame.
                    let _ = reply.send(false);
                }
                handle.driver.lock().await.kill();
            }
        }
        for session in &sessions {
            let mut ended = session.ended.subscribe();
            let _ = tokio::time::timeout(Duration::from_secs(3), ended.changed()).await;
        }
        self.check()
    }
}

/// Cap text persisted with a single streaming rewrite.
fn bounded_text(mut text: String) -> String {
    const LIMIT: usize = 60_000;
    if text.len() <= LIMIT {
        return text;
    }
    let mut end = LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text
}
