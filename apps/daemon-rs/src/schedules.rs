use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, watch};
use toml::Value as TomlValue;
use ts_rs::TS;

use crate::agent::{Agents, AttachmentInput, CreateAgentSession};
use crate::database::{now, validate_text};
use crate::error::{Error, Result};
use crate::protocol::{AgentKind, SessionHead};

const MAX_PROMPT_CHARS: usize = 200_000;
const MAX_RRULE_CHARS: usize = 500;
const MAX_ERROR_CHARS: usize = 2_000;
const DEFAULT_INTERVAL_MS: i64 = 30_000;
const MAX_TIMEOUT_MS: i64 = 2_147_483_647;

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

struct State {
    root: PathBuf,
    agents: Agents,
    closed: AtomicBool,
    inflight: Mutex<HashSet<String>>,
    changed: watch::Sender<u64>,
}

impl Schedules {
    pub fn new(home: &Path, agents: Agents) -> Self {
        let root = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().unwrap_or_else(|| home.to_owned()).join(".codex"))
            .join("automations");
        Self(Arc::new(State {
            root,
            agents,
            closed: AtomicBool::new(false),
            inflight: Mutex::new(HashSet::new()),
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
        if rrule_changed {
            task.next_run_at = next_run_after(&task.rrule, now)?;
        }
        self.write(&task)?;
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
            .list()?
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
        let result = self.trigger_inner(task.clone(), timestamp).await;
        if let Err(error) = &result {
            let _ = self.mark_triggered(
                &task,
                timestamp,
                task.last_session_id.clone(),
                Some(error.to_string()),
            );
        }
        self.0.inflight.lock().await.remove(&task.id);
        result
    }

    async fn trigger_inner(
        &self,
        task: ScheduledAgentTask,
        timestamp: i64,
    ) -> Result<ScheduleRunResult> {
        let mut session = match task.last_session_id.as_deref() {
            Some(id) => self
                .session(id)
                .await
                .ok()
                .filter(|head| head.agent == task.agent && !is_dead(head.status)),
            None => None,
        };
        if session.is_none() {
            session = Some(
                self.0
                    .agents
                    .create(CreateAgentSession {
                        agent: task.agent,
                        title: task.name.clone(),
                        workspace: task.cwd.clone(),
                        auto_approve: task.approval_policy == "yolo"
                            || task.approval_policy == "auto",
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
                    .await?,
            );
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
        let saved = self.mark_triggered(&task, timestamp, Some(session.id.clone()), None)?;
        self.publish();
        Ok(ScheduleRunResult {
            task: saved,
            session,
            queued,
        })
    }

    fn mark_triggered(
        &self,
        task: &ScheduledAgentTask,
        timestamp: i64,
        session_id: Option<String>,
        error: Option<String>,
    ) -> Result<ScheduledAgentTask> {
        let mut updated = task.clone();
        updated.last_run_at = Some(timestamp);
        updated.next_run_at = next_run_after(&updated.rrule, timestamp)?;
        updated.updated_at = now();
        updated.last_session_id = session_id.or(updated.last_session_id);
        updated.last_error = error.map(|value| value.chars().take(MAX_ERROR_CHARS).collect());
        self.write(&updated)?;
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
        let raw = std::fs::read_to_string(&file)?;
        let parsed = toml::from_str::<TomlValue>(&raw)
            .map_err(|error| Error::Invalid(format!("invalid schedule toml: {error}")))?;
        Ok(Some(self.parse_toml_task(id, &file, &parsed)?))
    }

    fn write(&self, task: &ScheduledAgentTask) -> Result<()> {
        self.ensure_root()?;
        let dir = self.0.root.join(&task.id);
        std::fs::create_dir_all(&dir)?;
        private_dir(&dir)?;
        write_private_toml(&self.file_for(&task.id), task)
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
            | AgentKind::Grok
    )
}

fn resumable_agent(agent: AgentKind) -> bool {
    matches!(
        agent,
        AgentKind::Claude | AgentKind::Codex | AgentKind::Deepseek
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

fn next_run_after(rrule: &str, now: i64) -> Result<i64> {
    let interval = rrule_interval_ms(rrule)?.min(MAX_TIMEOUT_MS);
    Ok(now.saturating_add(interval))
}

fn next_run_from_anchor(rrule: &str, anchor: i64, now: i64) -> Result<i64> {
    let interval = rrule_interval_ms(rrule)?;
    if anchor >= now {
        return Ok(anchor.saturating_add(interval));
    }
    let elapsed = now.saturating_sub(anchor);
    let missed = elapsed / interval;
    Ok(anchor.saturating_add((missed + 1).saturating_mul(interval)))
}

fn rrule_interval_ms(rrule: &str) -> Result<i64> {
    let mut freq = None;
    let mut interval = 1_i64;
    for part in rrule.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_uppercase().as_str() {
            "FREQ" => freq = Some(value.trim().to_ascii_uppercase()),
            "INTERVAL" => {
                interval = value
                    .trim()
                    .parse::<i64>()
                    .map_err(|_| Error::Invalid("rrule INTERVAL 无效".into()))?;
            }
            _ => {}
        }
    }
    if interval < 1 {
        return Err(Error::Invalid("rrule INTERVAL 无效".into()));
    }
    let unit = match freq.as_deref() {
        Some("MINUTELY") => 60_000,
        Some("HOURLY") => 3_600_000,
        Some("DAILY") => 86_400_000,
        Some("WEEKLY") => 604_800_000,
        _ => {
            return Err(Error::Invalid(
                "rrule 仅支持 FREQ=MINUTELY/HOURLY/DAILY/WEEKLY".into(),
            ));
        }
    };
    interval
        .checked_mul(unit)
        .filter(|value| *value <= 366 * 86_400_000)
        .ok_or_else(|| Error::Invalid("rrule 间隔过大".into()))
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
