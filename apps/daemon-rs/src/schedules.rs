use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, watch};
use toml::Value as TomlValue;
use ts_rs::TS;

use crate::agent::{Agents, AttachmentInput, CreateAgentSession};
use crate::database::{now, validate_text};
use crate::error::{Error, Result};
use crate::protocol::{AgentKind, SessionHead, SessionLifecycle, UpdateSession};

const MAX_PROMPT_CHARS: usize = 200_000;
const MAX_RRULE_CHARS: usize = 500;
const MAX_ERROR_CHARS: usize = 2_000;
const DEFAULT_INTERVAL_MS: i64 = 30_000;
const MAX_TIMEOUT_MS: i64 = 2_147_483_647;
const TRANSIENT_RETRY_BACKOFFS_MS: [i64; 3] = [2 * 60_000, 5 * 60_000, 15 * 60_000];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ScheduledAgentTaskKind {
    Cron,
    Heartbeat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ScheduledAgentTaskStatus {
    Enabled,
    Paused,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub last_run_at: Option<i64>,
    #[ts(type = "number")]
    pub next_run_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(skip)]
    #[serde(skip)]
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct StatusScheduledAgentTask {
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub last_run_at: Option<i64>,
    #[ts(type = "number")]
    pub next_run_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

impl From<ScheduledAgentTask> for StatusScheduledAgentTask {
    fn from(task: ScheduledAgentTask) -> Self {
        Self {
            version: task.version,
            id: task.id,
            kind: task.kind,
            name: task.name,
            prompt: task.prompt,
            status: task.status,
            rrule: task.rrule,
            agent: task.agent,
            approval_policy: task.approval_policy,
            cwd: task.cwd,
            cwds: task.cwds,
            account_id: task.account_id,
            model: task.model,
            reasoning_effort: task.reasoning_effort,
            mode: task.mode,
            target_thread_id: task.target_thread_id,
            last_session_id: task.last_session_id,
            last_run_at: task.last_run_at,
            next_run_at: task.next_run_at,
            last_error: task.last_error,
            created_at: task.created_at,
            updated_at: task.updated_at,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleCreate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ScheduledAgentTaskKind>,
    pub name: String,
    pub prompt: String,
    pub rrule: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ScheduledAgentTaskStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwds: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor_session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ScheduledAgentTaskKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rrule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<ScheduledAgentTaskStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwds: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_thread_id: Option<Option<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleId {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunResult {
    pub task: ScheduledAgentTask,
    pub session: SessionHead,
    pub queued: bool,
}

#[derive(Clone)]
pub struct Schedules(Arc<State>);

const PARSED_SCHEDULE_ENTRIES: usize = 512;
const PARSED_SCHEDULE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
struct FileRevision {
    bytes: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, i64, i64),
}
impl FileRevision {
    fn new(metadata: &std::fs::Metadata) -> Self {
        Self {
            bytes: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (metadata.ino(), metadata.ctime(), metadata.ctime_nsec())
            },
        }
    }
}
struct ParsedSchedule {
    revision: FileRevision,
    value: Arc<TomlValue>,
}
#[derive(Default)]
struct ParsedSchedules {
    entries: HashMap<PathBuf, ParsedSchedule>,
    order: VecDeque<PathBuf>,
    bytes: usize,
}
impl ParsedSchedules {
    fn remove(&mut self, path: &Path) {
        if let Some(old) = self.entries.remove(path) {
            self.bytes -= old.revision.bytes as usize;
        }
        self.order.retain(|item| item != path);
    }
    fn insert(&mut self, path: PathBuf, value: ParsedSchedule) {
        self.remove(&path);
        let bytes = value.revision.bytes as usize;
        if bytes > PARSED_SCHEDULE_BYTES {
            return;
        }
        while self.entries.len() >= PARSED_SCHEDULE_ENTRIES
            || self.bytes + bytes > PARSED_SCHEDULE_BYTES
        {
            let Some(old) = self.order.front().cloned() else {
                break;
            };
            self.remove(&old);
        }
        self.bytes += bytes;
        self.order.push_back(path.clone());
        self.entries.insert(path, value);
    }
}

struct State {
    root: PathBuf,
    agents: Agents,
    closed: AtomicBool,
    inflight: Mutex<HashSet<String>>,
    write_lock: std::sync::Mutex<()>,
    parsed: std::sync::Mutex<ParsedSchedules>,
    retry_counts: std::sync::Mutex<HashMap<String, usize>>,
    changed: watch::Sender<u64>,
}

impl Schedules {
    pub fn new(home: &Path, agents: Agents) -> Self {
        let root = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().unwrap_or_else(|| home.to_owned()).join(".codex"))
            .join("automations");
        Self::with_directory(root, agents)
    }

    pub fn with_directory(root: PathBuf, agents: Agents) -> Self {
        Self(Arc::new(State {
            root,
            agents,
            closed: AtomicBool::new(false),
            inflight: Mutex::new(HashSet::new()),
            write_lock: std::sync::Mutex::new(()),
            parsed: std::sync::Mutex::new(ParsedSchedules::default()),
            retry_counts: std::sync::Mutex::new(HashMap::new()),
            changed: watch::channel(0).0,
        }))
    }

    pub fn changes(&self) -> watch::Receiver<u64> {
        self.0.changed.subscribe()
    }

    pub async fn start(&self) {
        let _ = self.tick(now()).await;
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_millis(DEFAULT_INTERVAL_MS as u64));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if runtime.0.closed.load(Ordering::Acquire) {
                    return;
                }
                let _ = runtime.tick(now()).await;
            }
        });
    }

    pub fn close(&self) {
        self.0.closed.store(true, Ordering::Release);
        self.publish();
    }

    pub fn list(&self) -> Result<Vec<ScheduledAgentTask>> {
        self.ensure_root()?;
        let mut items = Vec::new();
        for entry in std::fs::read_dir(&self.0.root)? {
            let entry = entry?;
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if !kind.is_dir() {
                continue;
            }
            let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if validate_schedule_id(&id).is_err() {
                continue;
            }
            if let Ok(Some(task)) = self.read(&id) {
                items.push(task);
            }
        }
        items.sort_by(|a, b| a.next_run_at.cmp(&b.next_run_at).then(a.name.cmp(&b.name)));
        Ok(items)
    }

    pub async fn list_async(&self) -> Result<Vec<ScheduledAgentTask>> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.list())
            .await
            .map_err(|_| Error::Closed)?
    }

    pub async fn status_list_async(&self) -> Result<Vec<StatusScheduledAgentTask>> {
        Ok(self
            .list_async()
            .await?
            .into_iter()
            .map(Into::into)
            .collect())
    }

    pub fn status_list(&self) -> Result<Vec<StatusScheduledAgentTask>> {
        Ok(self.list()?.into_iter().map(Into::into).collect())
    }

    pub fn get(&self, id: &str) -> Result<ScheduledAgentTask> {
        let id = validate_schedule_id(id)?;
        self.read(id)?.ok_or(Error::NotFound)
    }

    pub async fn create(&self, input: ScheduleCreate) -> Result<ScheduledAgentTask> {
        let now = now();
        let id = validate_schedule_id(&input.id.unwrap_or_else(|| slug(&input.name)))?.to_owned();
        let path = self.file_for(&id);
        if path.exists() {
            return Err(Error::Conflict);
        }
        let actor = input
            .actor_session_id
            .as_deref()
            .map(|id| async { self.session(id).await.ok() });
        let actor = match actor {
            Some(actor) => actor.await,
            None => None,
        };
        let cwd = first_directory(
            input.cwd.as_deref(),
            input.cwds.as_deref(),
            actor.as_ref().map(|head| head.workspace.clone()),
        )?;
        let cwds = normalize_directories(input.cwds.unwrap_or_else(|| vec![cwd.clone()]), &cwd)?;
        let task = ScheduledAgentTask {
            version: 1,
            id,
            kind: input.kind.unwrap_or(ScheduledAgentTaskKind::Heartbeat),
            name: required_text(&input.name, 500, "name 无效")?,
            prompt: required_text(&input.prompt, MAX_PROMPT_CHARS, "prompt 无效")?,
            status: input.status.unwrap_or(ScheduledAgentTaskStatus::Enabled),
            rrule: required_text(&input.rrule, MAX_RRULE_CHARS, "rrule 无效")?,
            agent: input
                .agent
                .unwrap_or_else(|| actor.map_or(AgentKind::Codex, |head| head.agent)),
            approval_policy: input.approval_policy.unwrap_or_else(|| "standard".into()),
            cwd,
            cwds,
            account_id: input.account_id,
            model: input.model,
            reasoning_effort: input.reasoning_effort,
            mode: input.mode,
            target_thread_id: input.target_thread_id,
            last_session_id: None,
            last_run_at: None,
            next_run_at: 0,
            last_error: None,
            created_at: now,
            updated_at: now,
            path: path.to_string_lossy().into_owned(),
        };
        let mut task = validate_task(task)?;
        task.next_run_at = next_run_after(&task.rrule, now)?;
        self.write(&task)?;
        self.publish();
        Ok(task)
    }

    pub fn update(&self, input: ScheduleUpdate) -> Result<ScheduledAgentTask> {
        let _guard = self.0.write_lock.lock().map_err(|_| Error::Closed)?;
        let current = self.get(&input.id)?;
        let now = now();
        let rrule_changed = input.rrule.is_some();
        let mut task = ScheduledAgentTask {
            kind: input.kind.unwrap_or(current.kind),
            name: input.name.unwrap_or(current.name),
            prompt: input.prompt.unwrap_or(current.prompt),
            rrule: input.rrule.unwrap_or(current.rrule),
            status: input.status.unwrap_or(current.status),
            agent: input.agent.unwrap_or(current.agent),
            approval_policy: input.approval_policy.unwrap_or(current.approval_policy),
            cwd: input.cwd.unwrap_or(current.cwd),
            cwds: input.cwds.unwrap_or(current.cwds),
            account_id: input.account_id.unwrap_or(current.account_id),
            model: input.model.unwrap_or(current.model),
            reasoning_effort: input.reasoning_effort.unwrap_or(current.reasoning_effort),
            mode: input.mode.unwrap_or(current.mode),
            target_thread_id: input.target_thread_id.unwrap_or(current.target_thread_id),
            updated_at: now,
            ..current
        };
        task = validate_task(task)?;
        if rrule_changed || input.status.is_some() {
            if let Ok(mut retries) = self.0.retry_counts.lock() {
                retries.remove(&task.id);
            }
        }
        if rrule_changed {
            task.next_run_at = next_run_after(&task.rrule, now)?;
        }
        self.write(&task)?;
        drop(_guard);
        self.publish();
        Ok(task)
    }

    pub fn pause(&self, id: &str) -> Result<ScheduledAgentTask> {
        self.update(ScheduleUpdate {
            id: id.to_owned(),
            status: Some(ScheduledAgentTaskStatus::Paused),
            operation_id: None,
            kind: None,
            name: None,
            prompt: None,
            rrule: None,
            agent: None,
            approval_policy: None,
            cwd: None,
            cwds: None,
            account_id: None,
            model: None,
            reasoning_effort: None,
            mode: None,
            target_thread_id: None,
        })
    }

    pub fn resume(&self, id: &str) -> Result<ScheduledAgentTask> {
        let task = self.get(id)?;
        self.update(ScheduleUpdate {
            id: id.to_owned(),
            status: Some(ScheduledAgentTaskStatus::Enabled),
            rrule: Some(task.rrule),
            operation_id: None,
            kind: None,
            name: None,
            prompt: None,
            agent: None,
            approval_policy: None,
            cwd: None,
            cwds: None,
            account_id: None,
            model: None,
            reasoning_effort: None,
            mode: None,
            target_thread_id: None,
        })
    }

    pub fn delete(&self, id: &str) -> Result<serde_json::Value> {
        let id = validate_schedule_id(id)?;
        if let Ok(mut retries) = self.0.retry_counts.lock() {
            retries.remove(id);
        }
        self.0
            .parsed
            .lock()
            .map_err(|_| Error::Closed)?
            .remove(&self.file_for(id));
        let dir = self.0.root.join(id);
        let deleted = dir.exists();
        std::fs::remove_dir_all(dir).or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(error)
            }
        })?;
        self.publish();
        Ok(serde_json::json!({"id": id, "deleted": deleted}))
    }

    pub async fn run_now(&self, id: &str) -> Result<ScheduleRunResult> {
        let task = self.get(id)?;
        self.trigger(task, now()).await
    }

    async fn tick(&self, timestamp: i64) -> Result<Vec<ScheduleRunResult>> {
        let due = self
            .list_async()
            .await?
            .into_iter()
            .filter(|task| {
                task.status == ScheduledAgentTaskStatus::Enabled && task.next_run_at <= timestamp
            })
            .collect::<Vec<_>>();
        let mut results = Vec::new();
        for task in due {
            match self.trigger(task, timestamp).await {
                Ok(result) => results.push(result),
                Err(error) => eprintln!("schedule trigger failed: {error}"),
            }
        }
        Ok(results)
    }

    async fn trigger(&self, task: ScheduledAgentTask, timestamp: i64) -> Result<ScheduleRunResult> {
        {
            let mut inflight = self.0.inflight.lock().await;
            if !inflight.insert(task.id.clone()) {
                return Err(Error::Conflict);
            }
        }
        let mut active_session_id = task.last_session_id.clone();
        let result = self
            .trigger_inner(task.clone(), timestamp, &mut active_session_id)
            .await;
        if let Err(error) = &result {
            let _ = self.record_trigger_failure(&task, timestamp, active_session_id, error);
        }
        self.0.inflight.lock().await.remove(&task.id);
        result
    }

    async fn trigger_inner(
        &self,
        task: ScheduledAgentTask,
        timestamp: i64,
        active_session_id: &mut Option<String>,
    ) -> Result<ScheduleRunResult> {
        let mut session = None;
        if let Some(id) = task.last_session_id.as_deref()
            && let Ok(head) = self.session(id).await
        {
            if head.lifecycle == SessionLifecycle::Active
                && head.agent == task.agent
                && !is_dead(head.status)
            {
                session = Some(head);
            } else {
                *active_session_id = None;
                if head.lifecycle == SessionLifecycle::Active {
                    self.retire_session(&head.id).await;
                }
            }
        }
        if session.is_none() {
            let created = self
                .0
                .agents
                .create(CreateAgentSession {
                    agent: task.agent,
                    title: task.name.clone(),
                    workspace: task.cwd.clone(),
                    auto_approve: task.approval_policy == "yolo" || task.approval_policy == "auto",
                    mode: task.mode.clone(),
                    model: task.model.clone(),
                    effort: task.reasoning_effort.clone(),
                    agent_preset: None,
                    account_id: task.account_id.clone(),
                    resume: task
                        .target_thread_id
                        .clone()
                        .filter(|_| resumable_agent(task.agent))
                        .map(|id| crate::agent::ResumeInput {
                            id,
                            title: None,
                            fork: None,
                        }),
                })
                .await?;
            *active_session_id = Some(created.id.clone());
            session = Some(created);
        }
        let session = session.expect("session is set");
        let queued = !matches!(
            session.status,
            crate::protocol::SessionStatus::Idle | crate::protocol::SessionStatus::Completed
        );
        self.0
            .agents
            .send(
                &session.id,
                task.prompt.clone(),
                Some("queue".into()),
                Vec::<AttachmentInput>::new(),
            )
            .await?;
        if let Ok(mut retries) = self.0.retry_counts.lock() {
            retries.remove(&task.id);
        }
        let saved = self.mark_triggered(&task, timestamp, Some(session.id.clone()), None, None)?;
        self.publish();
        Ok(ScheduleRunResult {
            task: saved,
            session,
            queued,
        })
    }

    async fn retire_session(&self, id: &str) {
        if self.0.agents.archive(id).await.is_ok() {
            return;
        }
        let _ = self.0.agents.close(id).await;
        let sid = id.to_owned();
        let _ = self
            .0
            .agents
            .database()
            .call(move |store| {
                let current = store.session(&sid)?;
                if current.lifecycle == SessionLifecycle::Archived {
                    return Ok(());
                }
                store
                    .update_session(
                        &sid,
                        UpdateSession {
                            revision: current.revision,
                            title: None,
                            lifecycle: Some(SessionLifecycle::Archived),
                            status: None,
                        },
                    )
                    .map(|_| ())
            })
            .await;
    }

    fn record_trigger_failure(
        &self,
        task: &ScheduledAgentTask,
        timestamp: i64,
        session_id: Option<String>,
        error: &Error,
    ) -> Result<ScheduledAgentTask> {
        let retry_delay_ms = if is_transient_schedule_error(error) {
            let mut retries = self.0.retry_counts.lock().map_err(|_| Error::Closed)?;
            let attempt = retries.get(&task.id).copied().unwrap_or(0);
            if let Some(&backoff_ms) = TRANSIENT_RETRY_BACKOFFS_MS.get(attempt) {
                retries.insert(task.id.clone(), attempt + 1);
                Some(backoff_ms)
            } else {
                retries.remove(&task.id);
                None
            }
        } else {
            if let Ok(mut retries) = self.0.retry_counts.lock() {
                retries.remove(&task.id);
            }
            None
        };
        self.mark_triggered(
            task,
            timestamp,
            session_id,
            Some(error.to_string()),
            retry_delay_ms,
        )
    }

    fn mark_triggered(
        &self,
        task: &ScheduledAgentTask,
        timestamp: i64,
        session_id: Option<String>,
        error: Option<String>,
        retry_delay_ms: Option<i64>,
    ) -> Result<ScheduledAgentTask> {
        let _guard = self.0.write_lock.lock().map_err(|_| Error::Closed)?;
        let mut updated = self.read(&task.id)?.unwrap_or_else(|| task.clone());
        let regular_next = next_run_after(&updated.rrule, timestamp)?;
        updated.last_run_at = Some(timestamp);
        updated.next_run_at = match retry_delay_ms {
            Some(backoff_ms) => timestamp.saturating_add(backoff_ms).min(regular_next),
            None => regular_next,
        };
        updated.updated_at = now();
        updated.last_session_id = session_id;
        updated.last_error = error.map(|value| value.chars().take(MAX_ERROR_CHARS).collect());
        self.write(&updated)?;
        drop(_guard);
        self.publish();
        Ok(updated)
    }

    fn read(&self, id: &str) -> Result<Option<ScheduledAgentTask>> {
        let id = validate_schedule_id(id)?;
        let file = self.file_for(id);
        if !file.exists() {
            return Ok(None);
        }
        let metadata = std::fs::symlink_metadata(&file)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 512 * 1024 {
            return Ok(None);
        }
        let revision = FileRevision::new(&metadata);
        let cached = self
            .0
            .parsed
            .lock()
            .map_err(|_| Error::Closed)?
            .entries
            .get(&file)
            .filter(|entry| entry.revision == revision)
            .map(|entry| entry.value.clone());
        let parsed = match cached {
            Some(value) => value,
            None => {
                let raw = std::fs::read_to_string(&file)?;
                let value =
                    Arc::new(toml::from_str::<TomlValue>(&raw).map_err(|error| {
                        Error::Invalid(format!("invalid schedule toml: {error}"))
                    })?);
                self.0.parsed.lock().map_err(|_| Error::Closed)?.insert(
                    file.clone(),
                    ParsedSchedule {
                        revision,
                        value: value.clone(),
                    },
                );
                value
            }
        };
        // Validation and time-dependent defaults still run on every read.
        Ok(Some(self.parse_toml_task(id, &file, &parsed)?))
    }

    fn write(&self, task: &ScheduledAgentTask) -> Result<()> {
        self.ensure_root()?;
        let dir = self.0.root.join(&task.id);
        std::fs::create_dir_all(&dir)?;
        private_dir(&dir)?;
        let file = self.file_for(&task.id);
        let result = write_private_toml(&file, task);
        self.0
            .parsed
            .lock()
            .map_err(|_| Error::Closed)?
            .remove(&file);
        result
    }

    fn file_for(&self, id: &str) -> PathBuf {
        self.0.root.join(id).join("automation.toml")
    }

    fn ensure_root(&self) -> Result<()> {
        std::fs::create_dir_all(&self.0.root)?;
        private_dir(&self.0.root)
    }

    fn publish(&self) {
        self.0.changed.send_modify(|seq| *seq = seq.wrapping_add(1));
    }

    async fn session(&self, id: &str) -> Result<SessionHead> {
        let id = id.to_owned();
        self.0
            .agents
            .database()
            .call(move |store| store.session(&id))
            .await
    }

    fn parse_toml_task(
        &self,
        id: &str,
        file: &Path,
        data: &TomlValue,
    ) -> Result<ScheduledAgentTask> {
        let table = data
            .as_table()
            .ok_or_else(|| Error::Invalid("schedule file must be a table".into()))?;
        let now = now();
        let rrule = required_toml_string(table, "rrule", MAX_RRULE_CHARS)?;
        let created_at = toml_i64(table, "created_at").unwrap_or(now);
        let updated_at = toml_i64(table, "updated_at").unwrap_or(created_at);
        let last_run_at = toml_i64(table, "last_run_at");
        let next_run_at = toml_i64(table, "next_run_at").unwrap_or_else(|| {
            next_run_from_anchor(&rrule, last_run_at.unwrap_or(created_at), now).unwrap_or(now)
        });
        let status = schedule_status(toml_str(table, "status").unwrap_or("PAUSED"));
        let target_thread_id = optional_toml_string(table, "target_thread_id", 500);
        let cwd = first_directory(
            toml_str(table, "cwd"),
            toml_strings(table, "cwds").as_deref(),
            None,
        )?;
        let agent = toml_str(table, "agent")
            .and_then(agent_kind)
            .unwrap_or(AgentKind::Codex);
        let mut task = ScheduledAgentTask {
            version: 1,
            id: validate_schedule_id(toml_str(table, "id").unwrap_or(id))?.to_owned(),
            kind: if toml_str(table, "kind") == Some("cron") {
                ScheduledAgentTaskKind::Cron
            } else {
                ScheduledAgentTaskKind::Heartbeat
            },
            name: toml_str(table, "name").unwrap_or(id).to_owned(),
            prompt: rrule.clone(),
            status,
            rrule,
            agent,
            approval_policy: toml_str(table, "approval_policy")
                .unwrap_or("standard")
                .to_owned(),
            cwd,
            cwds: toml_strings(table, "cwds").unwrap_or_default(),
            account_id: optional_toml_string(table, "account_id", 100),
            model: optional_toml_string(table, "model", 300),
            reasoning_effort: optional_toml_string(table, "reasoning_effort", 100),
            mode: optional_toml_string(table, "mode", 20),
            target_thread_id,
            last_session_id: optional_toml_string(table, "last_session_id", 200),
            last_run_at,
            next_run_at,
            last_error: optional_toml_string(table, "last_error", MAX_ERROR_CHARS),
            created_at,
            updated_at,
            path: file.to_string_lossy().into_owned(),
        };
        task.prompt = required_toml_string(table, "prompt", MAX_PROMPT_CHARS)?;
        validate_task(task).map(|mut task| {
            task.path = file.to_string_lossy().into_owned();
            task
        })
    }
}

fn validate_schedule_id(id: &str) -> Result<&str> {
    if id.is_empty()
        || id.len() > 100
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        return Err(Error::Invalid(
            "定时任务 ID 只能包含字母、数字、点、下划线和短横线".into(),
        ));
    }
    Ok(id)
}

fn valid_agent(agent: AgentKind) -> bool {
    matches!(
        agent,
        AgentKind::Claude
            | AgentKind::Codex
            | AgentKind::Deepseek
            | AgentKind::Opencode
            | AgentKind::Pi
            | AgentKind::Agy
            | AgentKind::Grok
    )
}

fn resumable_agent(agent: AgentKind) -> bool {
    matches!(
        agent,
        AgentKind::Claude | AgentKind::Codex | AgentKind::Deepseek | AgentKind::Pi | AgentKind::Agy
    )
}

fn is_dead(status: crate::protocol::SessionStatus) -> bool {
    matches!(
        status,
        crate::protocol::SessionStatus::Completed | crate::protocol::SessionStatus::Failed
    )
}

fn required_text(value: &str, maximum: usize, message: &'static str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(Error::Invalid(message.into()));
    }
    Ok(value.to_owned())
}

fn optional_text(
    value: Option<String>,
    maximum: usize,
    message: &'static str,
) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.len() > maximum || value.contains('\0') {
        return Err(Error::Invalid(message.into()));
    }
    let value = value.trim();
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

fn normalize_directories(cwds: Vec<String>, cwd: &str) -> Result<Vec<String>> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in std::iter::once(cwd.to_owned()).chain(cwds) {
        let candidate = canonical_directory(&item)?;
        if seen.insert(candidate.clone()) {
            out.push(candidate);
        }
    }
    if out.len() > 20 {
        return Err(Error::Invalid("cwds 过多".into()));
    }
    Ok(out)
}

fn first_directory(
    cwd: Option<&str>,
    cwds: Option<&[String]>,
    fallback: Option<String>,
) -> Result<String> {
    let candidates = cwd
        .map(str::to_owned)
        .into_iter()
        .chain(cwds.into_iter().flatten().cloned())
        .chain(fallback)
        .collect::<Vec<_>>();
    let Some(candidate) = candidates
        .into_iter()
        .find(|item| Path::new(item).is_absolute() && Path::new(item).is_dir())
    else {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| Error::Invalid("cwd 不存在或不是目录".into()))?;
        return Ok(home.to_string_lossy().into_owned());
    };
    canonical_directory(&candidate)
}

fn canonical_directory(value: &str) -> Result<String> {
    validate_text(value, 20_000, false)?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(Error::Invalid("cwd must be absolute".into()));
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|_| Error::Invalid(format!("cwd 不存在或不是目录: {}", path.display())))?;
    if !metadata.is_dir() {
        return Err(Error::Invalid(format!(
            "cwd 不存在或不是目录: {}",
            path.display()
        )));
    }
    Ok(std::fs::canonicalize(&path)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned())
}

fn validate_task(mut task: ScheduledAgentTask) -> Result<ScheduledAgentTask> {
    validate_schedule_id(&task.id)?;
    task.name = required_text(&task.name, 500, "name 无效")?;
    task.prompt = required_text(&task.prompt, MAX_PROMPT_CHARS, "prompt 无效")?;
    task.rrule = required_text(&task.rrule, MAX_RRULE_CHARS, "rrule 无效")?;
    if !valid_agent(task.agent) {
        return Err(Error::Invalid("定时任务不支持此 Agent".into()));
    }
    if !matches!(
        task.approval_policy.as_str(),
        "strict" | "standard" | "yolo"
    ) {
        return Err(Error::Invalid("approvalPolicy 无效".into()));
    }
    if task
        .mode
        .as_deref()
        .is_some_and(|mode| mode != "default" && mode != "plan")
    {
        return Err(Error::Invalid("mode 无效".into()));
    }
    if task.mode.is_some() && !matches!(task.agent, AgentKind::Claude | AgentKind::Codex) {
        return Err(Error::Invalid("mode 只支持 Claude/Codex".into()));
    }
    if task.reasoning_effort.is_some() && task.model.is_none() {
        return Err(Error::Invalid(
            "reasoningEffort 必须和 model 一起设置".into(),
        ));
    }
    task.cwd = canonical_directory(&task.cwd)?;
    task.cwds = normalize_directories(task.cwds, &task.cwd)?;
    task.account_id = optional_text(task.account_id, 100, "accountId 无效")?;
    task.model = optional_text(task.model, 300, "model 无效")?;
    task.reasoning_effort = optional_text(task.reasoning_effort, 100, "reasoningEffort 无效")?;
    task.mode = optional_text(task.mode, 20, "mode 无效")?;
    task.target_thread_id = optional_text(task.target_thread_id, 500, "targetThreadId 无效")?;
    task.last_session_id = optional_text(task.last_session_id, 200, "lastSessionId 无效")?;
    task.path = task.path.trim().to_owned();
    if let Some(error) = task.last_error.take() {
        task.last_error = Some(error.chars().take(MAX_ERROR_CHARS).collect());
    }
    let _ = next_run_after(&task.rrule, now())?;
    Ok(task)
}

fn agent_kind(value: &str) -> Option<AgentKind> {
    match value {
        "claude" => Some(AgentKind::Claude),
        "codex" => Some(AgentKind::Codex),
        "deepseek" => Some(AgentKind::Deepseek),
        "opencode" => Some(AgentKind::Opencode),
        "pi" => Some(AgentKind::Pi),
        "agy" => Some(AgentKind::Agy),
        "grok" => Some(AgentKind::Grok),
        _ => None,
    }
}

fn slug(value: &str) -> String {
    let mut out = String::new();
    for character in value.trim().to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            out.push(character);
        } else if !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 72 {
            break;
        }
    }
    out.trim_matches('-')
        .to_owned()
        .if_empty(&format!("schedule-{}", uuid::Uuid::new_v4().simple()))
}

fn is_transient_schedule_error(error: &Error) -> bool {
    match error {
        Error::Invalid(_) | Error::Unauthorized | Error::Forbidden => false,
        Error::Feature(code, _)
            if matches!(
                code.as_str(),
                "invalid_request" | "forbidden" | "unsupported" | "authentication"
            ) =>
        {
            false
        }
        _ => true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScheduleFreq {
    Minutely,
    Hourly,
    Daily,
    Weekly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScheduleZone {
    Local,
    OffsetMinutes(i32),
}

#[derive(Debug, Clone)]
struct ParsedRrule {
    freq: ScheduleFreq,
    interval: i64,
    interval_ms: i64,
    by_hour: Option<Vec<u8>>,
    by_minute: Option<Vec<u8>>,
    by_day: Option<Vec<u8>>,
    zone: ScheduleZone,
}

impl ParsedRrule {
    fn has_calendar_selectors(&self) -> bool {
        self.by_hour.is_some() || self.by_minute.is_some() || self.by_day.is_some()
    }
}

fn next_run_after(rrule: &str, now: i64) -> Result<i64> {
    let parsed = parse_rrule(rrule)?;
    if !parsed.has_calendar_selectors() {
        return Ok(now.saturating_add(parsed.interval_ms.min(MAX_TIMEOUT_MS)));
    }
    next_calendar_occurrence(&parsed, now, now)
}

fn next_run_from_anchor(rrule: &str, anchor: i64, now: i64) -> Result<i64> {
    let parsed = parse_rrule(rrule)?;
    if !parsed.has_calendar_selectors() {
        let interval = parsed.interval_ms;
        if anchor >= now {
            return Ok(anchor.saturating_add(interval));
        }
        let elapsed = now.saturating_sub(anchor);
        let missed = elapsed / interval;
        return Ok(anchor.saturating_add((missed + 1).saturating_mul(interval)));
    }
    let baseline = now.max(anchor);
    next_calendar_occurrence(&parsed, anchor, baseline)
}

fn parse_rrule(rrule: &str) -> Result<ParsedRrule> {
    let trimmed = rrule.trim();
    let body = if trimmed.len() >= 6 && trimmed[..6].eq_ignore_ascii_case("RRULE:") {
        &trimmed[6..]
    } else {
        trimmed
    };
    let mut freq = None;
    let mut interval = 1_i64;
    let mut by_hour = None;
    let mut by_minute = None;
    let mut by_day = None;
    let mut zone = ScheduleZone::Local;

    for part in body.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                freq = Some(match value.to_ascii_uppercase().as_str() {
                    "MINUTELY" => ScheduleFreq::Minutely,
                    "HOURLY" => ScheduleFreq::Hourly,
                    "DAILY" => ScheduleFreq::Daily,
                    "WEEKLY" => ScheduleFreq::Weekly,
                    _ => {
                        return Err(Error::Invalid(
                            "rrule 仅支持 FREQ=MINUTELY/HOURLY/DAILY/WEEKLY".into(),
                        ));
                    }
                });
            }
            "INTERVAL" => {
                interval = value
                    .parse::<i64>()
                    .map_err(|_| Error::Invalid("rrule INTERVAL 无效".into()))?;
            }
            "BYHOUR" => {
                by_hour = Some(parse_bounded_u8_list(value, 23, "rrule BYHOUR 无效")?);
            }
            "BYMINUTE" => {
                by_minute = Some(parse_bounded_u8_list(value, 59, "rrule BYMINUTE 无效")?);
            }
            "BYDAY" => {
                by_day = Some(parse_byday_list(value)?);
            }
            "TZID" => {
                zone = parse_schedule_zone(value);
            }
            _ => {}
        }
    }

    if interval < 1 {
        return Err(Error::Invalid("rrule INTERVAL 无效".into()));
    }
    let Some(freq) = freq else {
        return Err(Error::Invalid(
            "rrule 仅支持 FREQ=MINUTELY/HOURLY/DAILY/WEEKLY".into(),
        ));
    };
    let unit = match freq {
        ScheduleFreq::Minutely => 60_000,
        ScheduleFreq::Hourly => 3_600_000,
        ScheduleFreq::Daily => 86_400_000,
        ScheduleFreq::Weekly => 604_800_000,
    };
    let interval_ms = interval
        .checked_mul(unit)
        .filter(|value| *value <= 366 * 86_400_000)
        .ok_or_else(|| Error::Invalid("rrule 间隔过大".into()))?;

    Ok(ParsedRrule {
        freq,
        interval,
        interval_ms,
        by_hour,
        by_minute,
        by_day,
        zone,
    })
}

fn parse_bounded_u8_list(raw: &str, max: u8, message: &'static str) -> Result<Vec<u8>> {
    if raw.is_empty() {
        return Err(Error::Invalid(message.into()));
    }
    let mut values = Vec::new();
    for token in raw.split(',') {
        let parsed = token
            .trim()
            .parse::<u8>()
            .map_err(|_| Error::Invalid(message.into()))?;
        if parsed > max {
            return Err(Error::Invalid(message.into()));
        }
        values.push(parsed);
    }
    values.sort_unstable();
    values.dedup();
    if values.is_empty() {
        return Err(Error::Invalid(message.into()));
    }
    Ok(values)
}

fn parse_byday_list(raw: &str) -> Result<Vec<u8>> {
    if raw.is_empty() {
        return Err(Error::Invalid("rrule BYDAY 无效".into()));
    }
    let mut days = Vec::new();
    for token in raw.split(',') {
        let day = match token.trim().to_ascii_uppercase().as_str() {
            "SU" => 0,
            "MO" => 1,
            "TU" => 2,
            "WE" => 3,
            "TH" => 4,
            "FR" => 5,
            "SA" => 6,
            _ => return Err(Error::Invalid("rrule BYDAY 无效".into())),
        };
        days.push(day);
    }
    days.sort_unstable();
    days.dedup();
    if days.is_empty() {
        return Err(Error::Invalid("rrule BYDAY 无效".into()));
    }
    Ok(days)
}

fn parse_schedule_zone(raw: &str) -> ScheduleZone {
    let upper = raw.trim().to_ascii_uppercase();
    if matches!(
        upper.as_str(),
        "UTC" | "Z" | "GMT" | "ETC/UTC" | "ETC/GMT" | "+00:00" | "+0000"
    ) {
        return ScheduleZone::OffsetMinutes(0);
    }
    let offset_raw = upper.strip_prefix("UTC").unwrap_or(upper.as_str());
    if let Some(sign) = offset_raw.as_bytes().first().and_then(|b| match b {
        b'+' => Some(1_i32),
        b'-' => Some(-1_i32),
        _ => None,
    }) {
        let rest = &offset_raw[1..];
        let (hours_str, mins_str) = rest.split_once(':').unwrap_or((rest, "0"));
        if let (Ok(hours), Ok(mins)) = (hours_str.parse::<i32>(), mins_str.parse::<i32>())
            && (0..=14).contains(&hours)
            && (0..=59).contains(&mins)
        {
            return ScheduleZone::OffsetMinutes(sign * (hours * 60 + mins));
        }
    }
    ScheduleZone::Local
}

const fn days_from_civil(year: i32, month: u8, day: u8) -> i64 {
    let y = year as i64 - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = month as i64;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

const fn civil_from_days(days: i64) -> (i32, u8, u8) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = (y + if m <= 2 { 1 } else { 0 }) as i32;
    (year, m as u8, d as u8)
}

const fn weekday_sun0(days: i64) -> u8 {
    (days + 4).rem_euclid(7) as u8
}

const fn iso_week_index(days: i64) -> i64 {
    (days + 3).div_euclid(7)
}

fn epoch_ms_to_civil(epoch_ms: i64, zone: ScheduleZone) -> (i64, u8, u8) {
    match zone {
        ScheduleZone::OffsetMinutes(offset_min) => {
            let shifted = epoch_ms.saturating_add(offset_min as i64 * 60_000);
            let days = shifted.div_euclid(86_400_000);
            let rem = shifted.rem_euclid(86_400_000);
            let hour = (rem / 3_600_000) as u8;
            let minute = ((rem % 3_600_000) / 60_000) as u8;
            (days, hour, minute)
        }
        ScheduleZone::Local => {
            #[cfg(unix)]
            {
                let secs = epoch_ms.div_euclid(1_000) as libc::time_t;
                let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
                if !unsafe { libc::localtime_r(&secs, &mut tm) }.is_null() {
                    let days =
                        days_from_civil(tm.tm_year + 1900, (tm.tm_mon + 1) as u8, tm.tm_mday as u8);
                    return (days, tm.tm_hour as u8, tm.tm_min as u8);
                }
            }
            epoch_ms_to_civil(epoch_ms, ScheduleZone::OffsetMinutes(0))
        }
    }
}

fn civil_to_epoch_ms(days: i64, hour: u8, minute: u8, zone: ScheduleZone) -> i64 {
    match zone {
        ScheduleZone::OffsetMinutes(offset_min) => {
            (days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 - offset_min as i64 * 60)
                * 1_000
        }
        ScheduleZone::Local => {
            #[cfg(unix)]
            {
                let (year, month, day) = civil_from_days(days);
                let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
                tm.tm_year = year - 1900;
                tm.tm_mon = month as i32 - 1;
                tm.tm_mday = day as i32;
                tm.tm_hour = hour as i32;
                tm.tm_min = minute as i32;
                tm.tm_sec = 0;
                tm.tm_isdst = -1;
                let secs = unsafe { libc::mktime(&mut tm) };
                if secs != -1 {
                    return (secs as i64) * 1_000;
                }
            }
            civil_to_epoch_ms(days, hour, minute, ScheduleZone::OffsetMinutes(0))
        }
    }
}

fn next_calendar_occurrence(parsed: &ParsedRrule, anchor: i64, now: i64) -> Result<i64> {
    let (anchor_days, _, _) = epoch_ms_to_civil(anchor, parsed.zone);
    let (now_days, _, _) = epoch_ms_to_civil(now, parsed.zone);

    match parsed.freq {
        ScheduleFreq::Daily => {
            let hours = parsed.by_hour.as_deref().unwrap_or(&[0]);
            let minutes = parsed.by_minute.as_deref().unwrap_or(&[0]);
            let start_step = if now_days > anchor_days {
                (now_days - anchor_days) / parsed.interval
            } else {
                0
            };
            for offset in 0..800_i64 {
                let day = anchor_days + (start_step + offset) * parsed.interval;
                if let Some(by_day) = parsed.by_day.as_deref()
                    && !by_day.contains(&weekday_sun0(day))
                {
                    continue;
                }
                for &hour in hours {
                    for &minute in minutes {
                        let candidate = civil_to_epoch_ms(day, hour, minute, parsed.zone);
                        if candidate > now {
                            return Ok(candidate);
                        }
                    }
                }
            }
            Err(Error::Invalid("rrule 无法计算下次执行时间".into()))
        }
        ScheduleFreq::Weekly => {
            let hours = parsed.by_hour.as_deref().unwrap_or(&[0]);
            let minutes = parsed.by_minute.as_deref().unwrap_or(&[0]);
            let default_day = [weekday_sun0(anchor_days)];
            let days_of_week = parsed.by_day.as_deref().unwrap_or(&default_day);
            let mut iso_offsets = days_of_week
                .iter()
                .map(|&wday| (wday as i64 + 6) % 7)
                .collect::<Vec<_>>();
            iso_offsets.sort_unstable();

            let anchor_week = iso_week_index(anchor_days);
            let now_week = iso_week_index(now_days);
            let start_step = if now_week > anchor_week {
                (now_week - anchor_week) / parsed.interval
            } else {
                0
            };
            for offset in 0..400_i64 {
                let week = anchor_week + (start_step + offset) * parsed.interval;
                let monday = week * 7 - 3;
                for &day_offset in &iso_offsets {
                    let day = monday + day_offset;
                    for &hour in hours {
                        for &minute in minutes {
                            let candidate = civil_to_epoch_ms(day, hour, minute, parsed.zone);
                            if candidate > now {
                                return Ok(candidate);
                            }
                        }
                    }
                }
            }
            Err(Error::Invalid("rrule 无法计算下次执行时间".into()))
        }
        ScheduleFreq::Hourly => {
            let minutes = parsed.by_minute.as_deref().unwrap_or(&[0]);
            let anchor_hour = anchor.div_euclid(3_600_000);
            let now_hour = now.div_euclid(3_600_000);
            let start_step = if now_hour > anchor_hour {
                (now_hour - anchor_hour) / parsed.interval
            } else {
                0
            };
            for offset in 0..(24 * 400_i64) {
                let hour_epoch = anchor_hour + (start_step + offset) * parsed.interval;
                let (day, hour, _) = epoch_ms_to_civil(hour_epoch * 3_600_000, parsed.zone);
                if let Some(by_day) = parsed.by_day.as_deref()
                    && !by_day.contains(&weekday_sun0(day))
                {
                    continue;
                }
                if let Some(by_hour) = parsed.by_hour.as_deref()
                    && !by_hour.contains(&hour)
                {
                    continue;
                }
                for &minute in minutes {
                    let candidate = civil_to_epoch_ms(day, hour, minute, parsed.zone);
                    if candidate > now {
                        return Ok(candidate);
                    }
                }
            }
            Err(Error::Invalid("rrule 无法计算下次执行时间".into()))
        }
        ScheduleFreq::Minutely => {
            let anchor_min = anchor.div_euclid(60_000);
            let now_min = now.div_euclid(60_000);
            let start_step = if now_min > anchor_min {
                (now_min - anchor_min) / parsed.interval
            } else {
                0
            };
            for offset in 0..(60 * 24 * 14_i64) {
                let min_epoch = anchor_min + (start_step + offset) * parsed.interval;
                let candidate = min_epoch * 60_000;
                if candidate <= now {
                    continue;
                }
                let (day, hour, minute) = epoch_ms_to_civil(candidate, parsed.zone);
                if let Some(by_day) = parsed.by_day.as_deref()
                    && !by_day.contains(&weekday_sun0(day))
                {
                    continue;
                }
                if let Some(by_hour) = parsed.by_hour.as_deref()
                    && !by_hour.contains(&hour)
                {
                    continue;
                }
                if let Some(by_minute) = parsed.by_minute.as_deref()
                    && !by_minute.contains(&minute)
                {
                    continue;
                }
                return Ok(candidate);
            }
            Err(Error::Invalid("rrule 无法计算下次执行时间".into()))
        }
    }
}

fn schedule_status(value: &str) -> ScheduledAgentTaskStatus {
    match value.trim().to_ascii_uppercase().as_str() {
        "ENABLED" | "ACTIVE" | "RUNNING" => ScheduledAgentTaskStatus::Enabled,
        _ => ScheduledAgentTaskStatus::Paused,
    }
}

fn toml_str<'a>(table: &'a toml::map::Map<String, TomlValue>, key: &str) -> Option<&'a str> {
    table
        .get(key)
        .and_then(TomlValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn toml_i64(table: &toml::map::Map<String, TomlValue>, key: &str) -> Option<i64> {
    table
        .get(key)
        .and_then(TomlValue::as_integer)
        .filter(|value| *value >= 0)
}

fn toml_strings(table: &toml::map::Map<String, TomlValue>, key: &str) -> Option<Vec<String>> {
    let values = table.get(key)?.as_array()?;
    Some(
        values
            .iter()
            .filter_map(TomlValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

fn required_toml_string(
    table: &toml::map::Map<String, TomlValue>,
    key: &str,
    maximum: usize,
) -> Result<String> {
    toml_str(table, key)
        .filter(|value| value.len() <= maximum)
        .map(str::to_owned)
        .ok_or_else(|| Error::Invalid(format!("{key} 无效")))
}

fn optional_toml_string(
    table: &toml::map::Map<String, TomlValue>,
    key: &str,
    maximum: usize,
) -> Option<String> {
    toml_str(table, key)
        .filter(|value| value.len() <= maximum)
        .map(str::to_owned)
}

fn write_private_toml(path: &Path, task: &ScheduledAgentTask) -> Result<()> {
    let mut table = toml::map::Map::new();
    table.insert("version".into(), TomlValue::Integer(1));
    table.insert("id".into(), TomlValue::String(task.id.clone()));
    table.insert(
        "kind".into(),
        TomlValue::String(kind_label(task.kind).into()),
    );
    table.insert("name".into(), TomlValue::String(task.name.clone()));
    table.insert("prompt".into(), TomlValue::String(task.prompt.clone()));
    table.insert(
        "status".into(),
        TomlValue::String(status_label(task.status).into()),
    );
    table.insert("rrule".into(), TomlValue::String(task.rrule.clone()));
    table.insert(
        "agent".into(),
        TomlValue::String(agent_label(task.agent).into()),
    );
    table.insert(
        "approval_policy".into(),
        TomlValue::String(task.approval_policy.clone()),
    );
    table.insert("cwd".into(), TomlValue::String(task.cwd.clone()));
    table.insert(
        "cwds".into(),
        TomlValue::Array(task.cwds.iter().cloned().map(TomlValue::String).collect()),
    );
    table.insert("created_at".into(), TomlValue::Integer(task.created_at));
    table.insert("updated_at".into(), TomlValue::Integer(task.updated_at));
    table.insert("next_run_at".into(), TomlValue::Integer(task.next_run_at));
    if let Some(value) = &task.account_id {
        table.insert("account_id".into(), TomlValue::String(value.clone()));
    }
    if let Some(value) = &task.model {
        table.insert("model".into(), TomlValue::String(value.clone()));
    }
    if let Some(value) = &task.reasoning_effort {
        table.insert("reasoning_effort".into(), TomlValue::String(value.clone()));
    }
    if let Some(value) = &task.mode {
        table.insert("mode".into(), TomlValue::String(value.clone()));
    }
    if let Some(value) = &task.target_thread_id {
        table.insert("target_thread_id".into(), TomlValue::String(value.clone()));
    }
    if let Some(value) = &task.last_session_id {
        table.insert("last_session_id".into(), TomlValue::String(value.clone()));
    }
    if let Some(value) = task.last_run_at {
        table.insert("last_run_at".into(), TomlValue::Integer(value));
    }
    if let Some(value) = &task.last_error {
        table.insert("last_error".into(), TomlValue::String(value.clone()));
    }
    let tmp = path.with_file_name(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::write(
        &tmp,
        toml::to_string(&TomlValue::Table(table))
            .map_err(|error| Error::Invalid(error.to_string()))?,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(tmp, path)?;
    Ok(())
}

fn kind_label(kind: ScheduledAgentTaskKind) -> &'static str {
    match kind {
        ScheduledAgentTaskKind::Cron => "cron",
        ScheduledAgentTaskKind::Heartbeat => "heartbeat",
    }
}

fn status_label(status: ScheduledAgentTaskStatus) -> &'static str {
    match status {
        ScheduledAgentTaskStatus::Enabled => "ENABLED",
        ScheduledAgentTaskStatus::Paused => "PAUSED",
    }
}

fn agent_label(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Opencode => "opencode",
        AgentKind::Pi => "pi",
        AgentKind::Agy => "agy",
        AgentKind::Deepseek => "deepseek",
        AgentKind::Grok => "grok",
        AgentKind::Trae => "trae",
        AgentKind::Shell => "shell",
        AgentKind::Custom => "custom",
    }
}

fn private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

trait EmptyString {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyString for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.into()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod performance_tests {
    use super::*;
    use crate::worker::Database;
    use tempfile::TempDir;

    #[tokio::test]
    async fn parsed_cache_reuses_unchanged_files_and_observes_external_edits() {
        let directory = TempDir::new().unwrap();
        let database = Database::open(directory.path().join("db")).await.unwrap();
        let schedules = Schedules::with_directory(
            directory.path().join("schedules"),
            Agents::new(database.clone()),
        );
        let path = schedules.file_for("sample");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let raw = format!(
            "id = \"sample\"\nname = \"first\"\nprompt = \"test\"\nrrule = \"FREQ=HOURLY;INTERVAL=1\"\nstatus = \"PAUSED\"\ncreated_at = 1000\nnext_run_at = 2000\ncwd = {:?}\n",
            directory.path().to_str().unwrap()
        );
        std::fs::write(&path, &raw).unwrap();
        assert_eq!(schedules.list_async().await.unwrap()[0].name, "first");
        let parsed = schedules.0.parsed.lock().unwrap().entries[&path]
            .value
            .clone();
        assert_eq!(schedules.list().unwrap()[0].name, "first");
        assert!(Arc::ptr_eq(
            &parsed,
            &schedules.0.parsed.lock().unwrap().entries[&path].value
        ));
        std::fs::write(&path, raw.replace("first", "second")).unwrap();
        assert_eq!(schedules.get("sample").unwrap().name, "second");
        assert!(!Arc::ptr_eq(
            &parsed,
            &schedules.0.parsed.lock().unwrap().entries[&path].value
        ));
        std::fs::remove_file(&path).unwrap();
        assert!(schedules.list().unwrap().is_empty());
        database.shutdown().await.unwrap();
    }

    #[test]
    fn parsed_cache_has_entry_and_source_byte_limits() {
        let mut cache = ParsedSchedules::default();
        for i in 0..PARSED_SCHEDULE_ENTRIES + 5 {
            cache.insert(
                PathBuf::from(format!("{i}.toml")),
                ParsedSchedule {
                    revision: FileRevision {
                        bytes: 32768,
                        modified: None,
                        #[cfg(unix)]
                        identity: (0, 0, 0),
                    },
                    value: Arc::new(TomlValue::Table(Default::default())),
                },
            );
        }
        assert!(cache.entries.len() <= PARSED_SCHEDULE_ENTRIES);
        assert!(cache.bytes <= PARSED_SCHEDULE_BYTES);
    }

    #[test]
    fn rrule_supports_byhour_byminute_and_byday_and_rejects_invalid_selectors() {
        // 2026-11-11 (Wednesday) 08:00:00 UTC
        let wed_0800 = civil_to_epoch_ms(
            days_from_civil(2026, 11, 11),
            8,
            0,
            ScheduleZone::OffsetMinutes(0),
        );
        let wed_0930 = civil_to_epoch_ms(
            days_from_civil(2026, 11, 11),
            9,
            30,
            ScheduleZone::OffsetMinutes(0),
        );
        let thu_0930 = civil_to_epoch_ms(
            days_from_civil(2026, 11, 12),
            9,
            30,
            ScheduleZone::OffsetMinutes(0),
        );

        assert_eq!(
            next_run_after("FREQ=DAILY;BYHOUR=9;BYMINUTE=30;TZID=UTC", wed_0800).unwrap(),
            wed_0930
        );
        assert_eq!(
            next_run_after("FREQ=DAILY;BYHOUR=9;BYMINUTE=30;TZID=UTC", wed_0930).unwrap(),
            thu_0930
        );

        // Biweekly MO,WE,FR at 10:00 UTC:
        // From Wed 2026-11-11 10:00 -> Fri 2026-11-13 10:00 (same week),
        // then from Fri 2026-11-13 10:00 -> Mon 2026-11-23 10:00 (skipping intermediate week).
        let wed_1000 = civil_to_epoch_ms(
            days_from_civil(2026, 11, 11),
            10,
            0,
            ScheduleZone::OffsetMinutes(0),
        );
        let fri_1000 = civil_to_epoch_ms(
            days_from_civil(2026, 11, 13),
            10,
            0,
            ScheduleZone::OffsetMinutes(0),
        );
        let mon_two_weeks = civil_to_epoch_ms(
            days_from_civil(2026, 11, 23),
            10,
            0,
            ScheduleZone::OffsetMinutes(0),
        );
        let weekly_rule =
            "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;BYHOUR=10;BYMINUTE=0;TZID=UTC";
        assert_eq!(next_run_after(weekly_rule, wed_1000).unwrap(), fri_1000);
        assert_eq!(
            next_run_after(weekly_rule, fri_1000).unwrap(),
            mon_two_weeks
        );

        // Hourly at :15 and :45
        let wed_0820 = wed_0800 + 20 * 60_000;
        let wed_0845 = wed_0800 + 45 * 60_000;
        let wed_0915 = wed_0800 + 75 * 60_000;
        assert_eq!(
            next_run_after("FREQ=HOURLY;BYMINUTE=15,45;TZID=UTC", wed_0820).unwrap(),
            wed_0845
        );
        assert_eq!(
            next_run_after("FREQ=HOURLY;BYMINUTE=15,45;TZID=UTC", wed_0845).unwrap(),
            wed_0915
        );

        assert!(next_run_after("FREQ=DAILY;BYHOUR=24", wed_0800).is_err());
        assert!(next_run_after("FREQ=DAILY;BYMINUTE=60", wed_0800).is_err());
        assert!(next_run_after("FREQ=WEEKLY;BYDAY=FUNDAY", wed_0800).is_err());
    }

    #[tokio::test]
    async fn transient_schedule_failures_retry_with_backoff_before_advancing_cadence() {
        let directory = TempDir::new().unwrap();
        let database = Database::open(directory.path().join("db")).await.unwrap();
        let schedules = Schedules::with_directory(
            directory.path().join("schedules"),
            Agents::new(database.clone()),
        );
        let task = schedules
            .create(ScheduleCreate {
                operation_id: None,
                id: Some("daily-job".into()),
                kind: Some(ScheduledAgentTaskKind::Cron),
                name: "Daily Job".into(),
                prompt: "run report".into(),
                rrule: "FREQ=DAILY;INTERVAL=1".into(),
                status: Some(ScheduledAgentTaskStatus::Enabled),
                agent: Some(AgentKind::Codex),
                approval_policy: Some("standard".into()),
                cwd: Some(directory.path().to_string_lossy().into_owned()),
                cwds: None,
                account_id: None,
                model: None,
                reasoning_effort: None,
                mode: None,
                target_thread_id: None,
                actor_session_id: None,
            })
            .await
            .unwrap();

        let base = 1_700_000_000_000_i64;
        let r1 = schedules
            .record_trigger_failure(&task, base, None, &Error::Busy)
            .unwrap();
        assert_eq!(r1.next_run_at, base + 2 * 60_000);

        let r2 = schedules
            .record_trigger_failure(&r1, base + 2 * 60_000, None, &Error::Timeout)
            .unwrap();
        assert_eq!(r2.next_run_at, base + 2 * 60_000 + 5 * 60_000);

        let r3 = schedules
            .record_trigger_failure(&r2, r2.next_run_at, None, &Error::Busy)
            .unwrap();
        assert_eq!(r3.next_run_at, r2.next_run_at + 15 * 60_000);

        // 4th consecutive transient error exhausts retries and advances to regular daily cadence
        let r4 = schedules
            .record_trigger_failure(&r3, r3.next_run_at, None, &Error::Busy)
            .unwrap();
        assert_eq!(r4.next_run_at, r3.next_run_at + 86_400_000);

        // Permanent validation error advances immediately without retry backoff
        let perm = schedules
            .record_trigger_failure(
                &r4,
                r4.next_run_at,
                None,
                &Error::Invalid("bad config".into()),
            )
            .unwrap();
        assert_eq!(perm.next_run_at, r4.next_run_at + 86_400_000);

        database.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn retire_session_archives_dead_previous_session() {
        let directory = TempDir::new().unwrap();
        let database = Database::open(directory.path().join("db")).await.unwrap();
        let schedules = Schedules::with_directory(
            directory.path().join("schedules"),
            Agents::new(database.clone()),
        );
        let cwd = directory.path().to_string_lossy().into_owned();
        let dead_session = database
            .call(move |store| {
                let created = store.create_session(crate::protocol::CreateSession {
                    agent: AgentKind::Codex,
                    kind: crate::protocol::SessionKind::Structured,
                    title: "Old Dead Run".into(),
                    workspace: cwd,
                })?;
                store.update_session(
                    &created.id,
                    UpdateSession {
                        revision: created.revision,
                        title: None,
                        lifecycle: None,
                        status: Some(crate::protocol::SessionStatus::Failed),
                    },
                )
            })
            .await
            .unwrap();
        assert_eq!(dead_session.lifecycle, SessionLifecycle::Active);

        schedules.retire_session(&dead_session.id).await;

        let refreshed = schedules.session(&dead_session.id).await.unwrap();
        assert_eq!(refreshed.lifecycle, SessionLifecycle::Archived);
        database.shutdown().await.unwrap();
    }
}
