pub mod feishu;
pub mod pbbp2;

use std::collections::HashMap;
use std::fs;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, watch};
use ts_rs::TS;
use uuid::Uuid;

use self::feishu::{FeishuWorkerConfig, probe_feishu, spawn_worker};
use crate::agent::{Agents, CreateAgentSession};
use crate::database::now;
use crate::error::{Error, Result};
use crate::protocol::{AgentKind, SessionHead, SessionKind};
use crate::worker::Database;

const REGISTRY_VERSION: u32 = 1;
const THREADS_VERSION: u32 = 1;
const MEMORY_INDEX_VERSION: u32 = 1;
const MAX_BOTS: usize = 64;
const MAX_THREADS_PER_BOT: usize = 200;
const MAX_MEMORY_ENTRIES: usize = 500;
const MAX_MEMORY_BYTES: usize = 256 * 1024;
const MAX_PROMPT_MEMORY_CHARS: usize = 1_200;
const MAX_PROMPT_CHARS: usize = 32_000;
const MAX_FEISHU_REPLY_MAP: usize = 500;
const MASTER_BOT_ID: &str = "master";
const BOT_SECTION_START: &str = "<!-- PROSPERO_BOT:START -->";
const BOT_SECTION_END: &str = "<!-- PROSPERO_BOT:END -->";
const LEGACY_MASTER_DESC: &str =
    "全局主控 Bot：统筹多个项目工作区与子 Bot 团队，适合跨仓库拆解与结果汇总。";
const LEGACY_MASTER_PROMPT: &str =
    "你是 Prospero 主控 Bot，负责帮助用户在个人工作台、多个代码工作区以及各专业子 Bot 之间统筹调度、拆解任务与综合汇报。";
const DEFAULT_MASTER_DESC: &str =
    "全能个人主控助手：跨话题持久记忆，支持自由切换模型与统筹子 Bot 团队协同。";
const DEFAULT_MASTER_PROMPT: &str =
    "你是用户的全能个人 AI 助手（Prospero Bot），负责日常问答、深度思考、计划制定，并在需要时统筹各专职子 Bot 协同完成复杂任务。";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum BotKind {
    Master,
    Sub,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FeishuDomain {
    #[default]
    Feishu,
    Lark,
}

impl FeishuDomain {
    pub const fn base_url(self) -> &'static str {
        match self {
            Self::Feishu => "https://open.feishu.cn",
            Self::Lark => "https://open.larksuite.com",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FeishuGroupTrigger {
    #[default]
    Mention,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FeishuConnectionState {
    #[default]
    Disabled,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum BotThreadChannel {
    Desktop,
    FeishuP2p,
    FeishuGroup,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct BotSourceBinding {
    pub source_id: String,
    pub route_id: String,
    pub bound_account_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PublicBotFeishuConfig {
    pub enabled: bool,
    pub domain: FeishuDomain,
    pub app_id: String,
    pub has_app_secret: bool,
    pub group_trigger: FeishuGroupTrigger,
    pub streaming_card: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct BotFeishuRuntimeStatus {
    pub state: FeishuConnectionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_open_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub last_connected_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub last_event_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct BotThread {
    pub id: String,
    pub bot_id: String,
    pub session_id: String,
    pub title: String,
    pub channel: BotThreadChannel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feishu_chat_id: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct PublicBot {
    pub id: String,
    pub kind: BotKind,
    pub name: String,
    pub avatar: String,
    pub description: String,
    pub system_prompt: String,
    pub agent: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_binding: Option<BotSourceBinding>,
    pub workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_workspace: Option<String>,
    pub allow_cross_workspace: bool,
    pub feishu: PublicBotFeishuConfig,
    pub feishu_status: BotFeishuRuntimeStatus,
    pub threads: Vec<BotThread>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct BotFeishuInput {
    pub enabled: bool,
    #[serde(default)]
    pub domain: FeishuDomain,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub app_secret: Option<String>,
    #[serde(default)]
    pub group_trigger: FeishuGroupTrigger,
    #[serde(default = "default_true")]
    pub streaming_card: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct BotUpsertInput {
    pub name: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub system_prompt: String,
    pub agent: AgentKind,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub source_binding: Option<BotSourceBinding>,
    #[serde(default)]
    pub custom_workspace: Option<String>,
    #[serde(default)]
    pub allow_cross_workspace: bool,
    #[serde(default)]
    pub feishu: Option<BotFeishuInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct BotFeishuProbeResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_open_id: Option<String>,
    pub ws_ready: bool,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum BotMemoryScope {
    Global,
    Chat,
    User,
    Member,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct BotMemoryEntry {
    pub key: String,
    pub scope: BotMemoryScope,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    pub preview: String,
    pub has_content: bool,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct BotMemoryView {
    pub bot_id: String,
    pub key: String,
    pub scope: BotMemoryScope,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    pub path: String,
    pub content: String,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct BotActionRequest {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub action: BotAction,
}

#[derive(Debug, Clone, Deserialize, Serialize, TS)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
#[ts(tag = "kind", rename_all_fields = "camelCase")]
pub enum BotAction {
    #[serde(rename = "list")]
    List,
    #[serde(rename = "create")]
    Create { input: BotUpsertInput },
    #[serde(rename = "update")]
    Update {
        bot_id: String,
        input: BotUpsertInput,
    },
    #[serde(rename = "delete")]
    Delete { bot_id: String },
    #[serde(rename = "thread.create")]
    ThreadCreate {
        bot_id: String,
        #[serde(default)]
        title: Option<String>,
    },
    #[serde(rename = "thread.adopt")]
    ThreadAdopt { bot_id: String, session_id: String },
    #[serde(rename = "thread.archive")]
    ThreadArchive { bot_id: String, thread_id: String },
    #[serde(rename = "thread.dispatch")]
    ThreadDispatch {
        bot_id: String,
        task: String,
        #[serde(default)]
        thread_id: Option<String>,
        #[serde(default)]
        title: Option<String>,
    },
    #[serde(rename = "feishu.test")]
    FeishuTest {
        #[serde(default)]
        bot_id: Option<String>,
        #[serde(default)]
        domain: FeishuDomain,
        app_id: String,
        #[serde(default)]
        app_secret: Option<String>,
    },
    #[serde(rename = "feishu.reconnect")]
    FeishuReconnect { bot_id: String },
    #[serde(rename = "memory.read")]
    MemoryRead { bot_id: String },
    #[serde(rename = "memory.write")]
    MemoryWrite { bot_id: String, content: String },
    #[serde(rename = "memory.list")]
    MemoryList { bot_id: String },
    #[serde(rename = "memory.entry.read")]
    MemoryEntryRead { bot_id: String, key: String },
    #[serde(rename = "memory.entry.write")]
    MemoryEntryWrite {
        bot_id: String,
        key: String,
        content: String,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        chat_id: Option<String>,
        #[serde(default)]
        chat_name: Option<String>,
        #[serde(default)]
        user_id: Option<String>,
        #[serde(default)]
        user_name: Option<String>,
    },
    #[serde(rename = "memory.entry.delete")]
    MemoryEntryDelete { bot_id: String, key: String },
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct BotActionResult {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot: Option<PublicBot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bots: Option<Vec<PublicBot>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<BotThread>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<BotFeishuProbeResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<BotMemoryView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memories: Option<Vec<BotMemoryEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::accounts::models::FeatureError>,
}

impl BotActionResult {
    pub fn success(request_id: &str) -> Self {
        Self {
            kind: "bot.result".into(),
            request_id: request_id.chars().take(100).collect(),
            ok: true,
            bot: None,
            bots: None,
            thread: None,
            session_id: None,
            probe: None,
            memory: None,
            memories: None,
            error: None,
        }
    }

    pub fn failure(request_id: &str, code: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            ok: false,
            error: Some(crate::accounts::models::FeatureError::new(code, &message)),
            ..Self::success(request_id)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredFeishuConfig {
    enabled: bool,
    #[serde(default)]
    domain: FeishuDomain,
    #[serde(default)]
    app_id: String,
    #[serde(default)]
    app_secret: String,
    #[serde(default)]
    group_trigger: FeishuGroupTrigger,
    #[serde(default = "default_true")]
    streaming_card: bool,
}

impl Default for StoredFeishuConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            domain: FeishuDomain::Feishu,
            app_id: String::new(),
            app_secret: String::new(),
            group_trigger: FeishuGroupTrigger::Mention,
            streaming_card: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBot {
    id: String,
    kind: BotKind,
    name: String,
    avatar: String,
    description: String,
    system_prompt: String,
    agent: AgentKind,
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default)]
    source_binding: Option<BotSourceBinding>,
    #[serde(default)]
    custom_workspace: Option<String>,
    #[serde(default)]
    allow_cross_workspace: bool,
    #[serde(default)]
    feishu: StoredFeishuConfig,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotRegistryFile {
    version: u32,
    bots: Vec<StoredBot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotThreadsFile {
    version: u32,
    threads: Vec<BotThread>,
    #[serde(default)]
    feishu_chat_threads: HashMap<String, String>,
    #[serde(default)]
    feishu_reply_threads: Vec<(String, String)>,
}

impl Default for BotThreadsFile {
    fn default() -> Self {
        Self {
            version: THREADS_VERSION,
            threads: Vec::new(),
            feishu_chat_threads: HashMap::new(),
            feishu_reply_threads: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredMemoryMeta {
    key: String,
    scope: BotMemoryScope,
    #[serde(default)]
    custom_label: Option<String>,
    #[serde(default)]
    chat_id: Option<String>,
    #[serde(default)]
    chat_name: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    user_name: Option<String>,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotMemoryIndexFile {
    version: u32,
    entries: HashMap<String, StoredMemoryMeta>,
}

impl Default for BotMemoryIndexFile {
    fn default() -> Self {
        Self {
            version: MEMORY_INDEX_VERSION,
            entries: HashMap::new(),
        }
    }
}

pub struct FeishuMemoryTurnInput {
    pub bot_id: String,
    pub chat_id: String,
    pub is_group: bool,
    pub chat_name: Option<String>,
    pub sender_open_id: Option<String>,
    pub sender_name: Option<String>,
    pub user_prompt: String,
}

pub struct PreparedFeishuTurn {
    pub augmented_prompt: String,
    pub thread_title_hint: String,
}

struct WorkerSlot {
    config: StoredFeishuConfig,
    stop: watch::Sender<bool>,
}

struct Inner {
    directory: PathBuf,
    database: Database,
    agents: Agents,
    state: Mutex<BotsState>,
    workers: Mutex<HashMap<String, WorkerSlot>>,
    changes: watch::Sender<u64>,
    started: Mutex<bool>,
}

struct BotsState {
    registry: BotRegistryFile,
    threads: HashMap<String, BotThreadsFile>,
    memories: HashMap<String, BotMemoryIndexFile>,
    statuses: HashMap<String, BotFeishuRuntimeStatus>,
}

#[derive(Clone)]
pub struct BotsSupervisor(Arc<Inner>);

impl BotsSupervisor {
    pub fn new(database: Database, agents: Agents) -> Self {
        let directory = database.directory().to_path_buf();
        let state = load_or_init_state(&directory);
        let (changes, _) = watch::channel(0u64);
        Self(Arc::new(Inner {
            directory,
            database,
            agents,
            state: Mutex::new(state),
            workers: Mutex::new(HashMap::new()),
            changes,
            started: Mutex::new(false),
        }))
    }

    pub fn changes(&self) -> watch::Receiver<u64> {
        self.0.changes.subscribe()
    }

    pub fn database(&self) -> &Database {
        &self.0.database
    }

    pub fn agents(&self) -> &Agents {
        &self.0.agents
    }

    fn notify(&self) {
        self.0
            .changes
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    pub async fn start(&self) {
        {
            let mut started = self.0.started.lock().await;
            if *started {
                return;
            }
            *started = true;
        }
        let bots = {
            let guard = self.0.state.lock().await;
            guard.registry.bots.clone()
        };
        for bot in bots {
            let _ = sync_bot_workspace_files(&self.0.directory, &bot);
            if bot.feishu.enabled {
                self.reconcile_worker(&bot, false).await;
            }
        }
    }

    pub async fn stop_all(&self) {
        let mut workers = self.0.workers.lock().await;
        for (_, slot) in workers.drain() {
            let _ = slot.stop.send(true);
        }
    }

    pub async fn list_public(&self) -> Vec<PublicBot> {
        let guard = self.0.state.lock().await;
        build_public_bots(&self.0.directory, &guard)
    }

    pub async fn handle_action(&self, request: BotActionRequest) -> Result<BotActionResult> {
        if request.kind != "bot.action"
            || request.request_id.trim().is_empty()
            || request.request_id.len() > 100
        {
            return Err(Error::Invalid("invalid bot action request".into()));
        }
        let req_id = request.request_id.clone();
        match request.action {
            BotAction::List => {
                let bots = self.list_public().await;
                let mut result = BotActionResult::success(&req_id);
                result.bots = Some(bots);
                Ok(result)
            }
            BotAction::Create { input } => {
                let (bot, bots) = self.create_bot(input).await?;
                let mut result = BotActionResult::success(&req_id);
                result.bot = Some(bot);
                result.bots = Some(bots);
                Ok(result)
            }
            BotAction::Update { bot_id, input } => {
                let (bot, bots) = self.update_bot(&bot_id, input).await?;
                let mut result = BotActionResult::success(&req_id);
                result.bot = Some(bot);
                result.bots = Some(bots);
                Ok(result)
            }
            BotAction::Delete { bot_id } => {
                let bots = self.delete_bot(&bot_id).await?;
                let mut result = BotActionResult::success(&req_id);
                result.bots = Some(bots);
                Ok(result)
            }
            BotAction::ThreadCreate { bot_id, title } => {
                let (thread, bots) = self
                    .create_thread(&bot_id, title.as_deref(), BotThreadChannel::Desktop, None)
                    .await?;
                let mut result = BotActionResult::success(&req_id);
                result.session_id = Some(thread.session_id.clone());
                result.thread = Some(thread);
                result.bots = Some(bots);
                Ok(result)
            }
            BotAction::ThreadAdopt { bot_id, session_id } => {
                let (thread, bots) = self.adopt_thread(&bot_id, &session_id).await?;
                let mut result = BotActionResult::success(&req_id);
                result.session_id = Some(thread.session_id.clone());
                result.thread = Some(thread);
                result.bots = Some(bots);
                Ok(result)
            }
            BotAction::ThreadArchive { bot_id, thread_id } => {
                let bots = self.archive_thread(&bot_id, &thread_id).await?;
                let mut result = BotActionResult::success(&req_id);
                result.bots = Some(bots);
                Ok(result)
            }
            BotAction::ThreadDispatch {
                bot_id,
                task,
                thread_id,
                title,
            } => {
                let (thread, bots) = self
                    .dispatch_thread(&bot_id, task, thread_id.as_deref(), title.as_deref())
                    .await?;
                let mut result = BotActionResult::success(&req_id);
                result.session_id = Some(thread.session_id.clone());
                result.thread = Some(thread);
                result.bots = Some(bots);
                Ok(result)
            }
            BotAction::FeishuTest {
                bot_id,
                domain,
                app_id,
                app_secret,
            } => {
                let clean_id = app_id.trim().to_owned();
                if clean_id.is_empty() || clean_id.len() > 200 {
                    return Err(Error::Invalid("请填写飞书 App ID".into()));
                }
                let secret = match app_secret
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    Some(secret) => secret.to_owned(),
                    None => {
                        let Some(ref id) = bot_id else {
                            return Err(Error::Invalid("请填写飞书 App Secret".into()));
                        };
                        let guard = self.0.state.lock().await;
                        guard
                            .registry
                            .bots
                            .iter()
                            .find(|bot| bot.id == *id)
                            .map(|bot| bot.feishu.app_secret.clone())
                            .filter(|secret| !secret.is_empty())
                            .ok_or_else(|| Error::Invalid("请填写飞书 App Secret".into()))?
                    }
                };
                let probe = probe_feishu(domain, clean_id, secret).await;
                let mut result = BotActionResult::success(&req_id);
                result.probe = Some(probe);
                Ok(result)
            }
            BotAction::FeishuReconnect { bot_id } => {
                validate_bot_id(&bot_id)?;
                let bot = {
                    let guard = self.0.state.lock().await;
                    guard
                        .registry
                        .bots
                        .iter()
                        .find(|bot| bot.id == bot_id)
                        .cloned()
                        .ok_or(Error::NotFound)?
                };
                if !bot.feishu.enabled {
                    return Err(Error::Invalid("该 Bot 尚未启用飞书 IM".into()));
                }
                self.reconcile_worker(&bot, true).await;
                let bots = self.list_public().await;
                let mut result = BotActionResult::success(&req_id);
                result.bot = bots.iter().find(|item| item.id == bot_id).cloned();
                result.bots = Some(bots);
                Ok(result)
            }
            BotAction::MemoryRead { bot_id } => {
                let memory = self.read_memory_entry(&bot_id, "global").await?;
                let mut result = BotActionResult::success(&req_id);
                result.memory = Some(memory);
                Ok(result)
            }
            BotAction::MemoryWrite { bot_id, content } => {
                let memory = self
                    .write_memory_entry(&bot_id, "global", &content, None, None, None, None, None)
                    .await?;
                let mut result = BotActionResult::success(&req_id);
                result.memory = Some(memory);
                Ok(result)
            }
            BotAction::MemoryList { bot_id } => {
                let memories = self.list_memories(&bot_id).await?;
                let mut result = BotActionResult::success(&req_id);
                result.memories = Some(memories);
                Ok(result)
            }
            BotAction::MemoryEntryRead { bot_id, key } => {
                let memory = self.read_memory_entry(&bot_id, &key).await?;
                let mut result = BotActionResult::success(&req_id);
                result.memory = Some(memory);
                Ok(result)
            }
            BotAction::MemoryEntryWrite {
                bot_id,
                key,
                content,
                label,
                chat_id,
                chat_name,
                user_id,
                user_name,
            } => {
                let memory = self
                    .write_memory_entry(
                        &bot_id,
                        &key,
                        &content,
                        label,
                        chat_id,
                        chat_name,
                        user_id,
                        user_name,
                    )
                    .await?;
                let mut result = BotActionResult::success(&req_id);
                result.memory = Some(memory);
                Ok(result)
            }
            BotAction::MemoryEntryDelete { bot_id, key } => {
                let memories = self.delete_memory_entry(&bot_id, &key).await?;
                let mut result = BotActionResult::success(&req_id);
                result.memories = Some(memories);
                Ok(result)
            }
        }
    }

    async fn create_bot(&self, input: BotUpsertInput) -> Result<(PublicBot, Vec<PublicBot>)> {
        let validated = validate_upsert_input(input, None)?;
        let ts = now();
        let id = format!("bot-{}", &Uuid::new_v4().simple().to_string()[..12]);
        let stored = StoredBot {
            id: id.clone(),
            kind: BotKind::Sub,
            name: validated.name,
            avatar: validated.avatar,
            description: validated.description,
            system_prompt: validated.system_prompt,
            agent: validated.agent,
            account_id: validated.account_id,
            model: validated.model,
            effort: validated.effort,
            source_binding: validated.source_binding,
            custom_workspace: validated.custom_workspace,
            allow_cross_workspace: validated.allow_cross_workspace,
            feishu: validated.feishu,
            created_at: ts,
            updated_at: ts,
        };

        let bots = {
            let mut guard = self.0.state.lock().await;
            if guard.registry.bots.len() >= MAX_BOTS {
                return Err(Error::Invalid("Bot 数量已达上限".into()));
            }
            sync_bot_workspace_files(&self.0.directory, &stored)?;
            guard.registry.bots.push(stored.clone());
            save_registry(&self.0.directory, &guard.registry)?;
            guard.threads.insert(id.clone(), BotThreadsFile::default());
            save_threads(&self.0.directory, &id, &BotThreadsFile::default())?;
            guard
                .memories
                .insert(id.clone(), BotMemoryIndexFile::default());
            save_memory_index(&self.0.directory, &id, &BotMemoryIndexFile::default())?;
            if !stored.feishu.enabled {
                guard.statuses.insert(
                    id.clone(),
                    BotFeishuRuntimeStatus {
                        state: FeishuConnectionState::Disabled,
                        ..Default::default()
                    },
                );
            }
            build_public_bots(&self.0.directory, &guard)
        };

        self.reconcile_worker(&stored, true).await;
        let bots = if stored.feishu.enabled {
            self.list_public().await
        } else {
            bots
        };
        self.notify();
        let bot = bots
            .iter()
            .find(|item| item.id == id)
            .cloned()
            .ok_or(Error::NotFound)?;
        Ok((bot, bots))
    }

    async fn update_bot(
        &self,
        bot_id: &str,
        input: BotUpsertInput,
    ) -> Result<(PublicBot, Vec<PublicBot>)> {
        validate_bot_id(bot_id)?;
        let updated = {
            let mut guard = self.0.state.lock().await;
            let index = guard
                .registry
                .bots
                .iter()
                .position(|bot| bot.id == bot_id)
                .ok_or(Error::NotFound)?;
            let existing = guard.registry.bots[index].clone();
            let validated = validate_upsert_input(input, Some(&existing.feishu))?;
            let next = StoredBot {
                id: existing.id.clone(),
                kind: existing.kind,
                name: validated.name,
                avatar: validated.avatar,
                description: validated.description,
                system_prompt: validated.system_prompt,
                agent: validated.agent,
                account_id: validated.account_id,
                model: validated.model,
                effort: validated.effort,
                source_binding: validated.source_binding,
                custom_workspace: validated.custom_workspace,
                allow_cross_workspace: validated.allow_cross_workspace,
                feishu: validated.feishu,
                created_at: existing.created_at,
                updated_at: now(),
            };
            sync_bot_workspace_files(&self.0.directory, &next)?;
            guard.registry.bots[index] = next.clone();
            save_registry(&self.0.directory, &guard.registry)?;
            next
        };

        self.reconcile_worker(&updated, false).await;
        self.notify();
        let bots = self.list_public().await;
        let bot = bots
            .iter()
            .find(|item| item.id == bot_id)
            .cloned()
            .ok_or(Error::NotFound)?;
        Ok((bot, bots))
    }

    async fn delete_bot(&self, bot_id: &str) -> Result<Vec<PublicBot>> {
        validate_bot_id(bot_id)?;
        if bot_id == MASTER_BOT_ID {
            return Err(Error::Invalid("主控 Bot 不能删除".into()));
        }
        {
            let mut workers = self.0.workers.lock().await;
            if let Some(slot) = workers.remove(bot_id) {
                let _ = slot.stop.send(true);
            }
        }
        let session_ids: Vec<String> = {
            let mut guard = self.0.state.lock().await;
            let Some(pos) = guard.registry.bots.iter().position(|bot| bot.id == bot_id) else {
                return Err(Error::NotFound);
            };
            guard.registry.bots.remove(pos);
            save_registry(&self.0.directory, &guard.registry)?;
            guard.statuses.remove(bot_id);
            guard.memories.remove(bot_id);
            let _ = fs::remove_file(bot_memory_index_path(&self.0.directory, bot_id));
            let removed_threads = guard.threads.remove(bot_id);
            let threads_path = bot_threads_path(&self.0.directory, bot_id);
            let _ = fs::remove_file(threads_path);
            removed_threads
                .map(|file| {
                    file.threads
                        .into_iter()
                        .map(|thread| thread.session_id)
                        .collect()
                })
                .unwrap_or_default()
        };
        for session_id in session_ids {
            let _ = self.0.agents.archive(&session_id).await;
        }
        self.notify();
        Ok(self.list_public().await)
    }

    async fn create_thread(
        &self,
        bot_id: &str,
        title: Option<&str>,
        channel: BotThreadChannel,
        feishu_chat_id: Option<String>,
    ) -> Result<(BotThread, Vec<PublicBot>)> {
        validate_bot_id(bot_id)?;
        let bot = {
            let guard = self.0.state.lock().await;
            guard
                .registry
                .bots
                .iter()
                .find(|bot| bot.id == bot_id)
                .cloned()
                .ok_or(Error::NotFound)?
        };
        sync_bot_workspace_files(&self.0.directory, &bot)?;
        let workspace = resolve_bot_workspace(&self.0.directory, &bot)?;
        let workspace_str = workspace
            .to_str()
            .ok_or_else(|| Error::Invalid("Bot 工作区路径无效".into()))?
            .to_owned();

        let thread_title = clean_thread_title(title, channel);
        let session_title = format!("{} · {}", bot.name, thread_title);
        let head: SessionHead = self
            .0
            .agents
            .create(CreateAgentSession {
                agent: bot.agent,
                title: session_title,
                workspace: workspace_str,
                auto_approve: true,
                mode: None,
                model: bot.model.clone(),
                effort: bot.effort.clone(),
                agent_preset: None,
                account_id: bot.account_id.clone(),
                resume: None,
            })
            .await?;

        let ts = now();
        let thread = BotThread {
            id: format!("thr-{}", &Uuid::new_v4().simple().to_string()[..12]),
            bot_id: bot.id.clone(),
            session_id: head.id,
            title: thread_title,
            channel,
            feishu_chat_id: feishu_chat_id.clone(),
            created_at: ts,
            updated_at: ts,
        };

        let bots = {
            let mut guard = self.0.state.lock().await;
            let file = guard.threads.entry(bot.id.clone()).or_default();
            file.threads.insert(0, thread.clone());
            if file.threads.len() > MAX_THREADS_PER_BOT {
                file.threads.truncate(MAX_THREADS_PER_BOT);
            }
            if let Some(chat_id) = feishu_chat_id {
                file.feishu_chat_threads.insert(chat_id, thread.id.clone());
            }
            save_threads(&self.0.directory, &bot.id, file)?;
            build_public_bots(&self.0.directory, &guard)
        };
        self.notify();
        Ok((thread, bots))
    }

    async fn adopt_thread(
        &self,
        bot_id: &str,
        session_id: &str,
    ) -> Result<(BotThread, Vec<PublicBot>)> {
        validate_bot_id(bot_id)?;
        crate::database::validate_id(session_id)?;
        let sid = session_id.to_owned();
        let head = self
            .0
            .database
            .read("bots.adopt_session", move |store| store.session(&sid))
            .await?;
        if head.kind != SessionKind::Structured {
            return Err(Error::Invalid("仅结构化对话可接入 Bot 模式".into()));
        }

        let (thread, bots, adopted_new) = {
            let mut guard = self.0.state.lock().await;
            if !guard.registry.bots.iter().any(|bot| bot.id == bot_id) {
                return Err(Error::NotFound);
            }
            for file in guard.threads.values() {
                if let Some(existing) = file.threads.iter().find(|t| t.session_id == session_id) {
                    let bots = build_public_bots(&self.0.directory, &guard);
                    return Ok((existing.clone(), bots));
                }
            }
            let title = if head.title.trim().is_empty() {
                "历史主对话".into()
            } else {
                head.title.clone()
            };
            let ts = now();
            let thread = BotThread {
                id: format!("thr-{}", &Uuid::new_v4().simple().to_string()[..12]),
                bot_id: bot_id.to_owned(),
                session_id: session_id.to_owned(),
                title,
                channel: BotThreadChannel::Desktop,
                feishu_chat_id: None,
                created_at: head.created_at,
                updated_at: ts,
            };
            let file = guard.threads.entry(bot_id.to_owned()).or_default();
            file.threads.insert(0, thread.clone());
            if file.threads.len() > MAX_THREADS_PER_BOT {
                file.threads.truncate(MAX_THREADS_PER_BOT);
            }
            save_threads(&self.0.directory, bot_id, file)?;
            let bots = build_public_bots(&self.0.directory, &guard);
            (thread, bots, true)
        };
        if adopted_new {
            self.notify();
        }
        Ok((thread, bots))
    }

    async fn archive_thread(&self, bot_id: &str, thread_id: &str) -> Result<Vec<PublicBot>> {
        validate_bot_id(bot_id)?;
        let session_id = {
            let mut guard = self.0.state.lock().await;
            let file = guard.threads.get_mut(bot_id).ok_or(Error::NotFound)?;
            let Some(pos) = file.threads.iter().position(|t| t.id == thread_id) else {
                return Err(Error::NotFound);
            };
            let removed = file.threads.remove(pos);
            file.feishu_chat_threads
                .retain(|_, active_id| active_id != thread_id);
            file.feishu_reply_threads
                .retain(|(_, mapped_id)| mapped_id != thread_id);
            save_threads(&self.0.directory, bot_id, file)?;
            removed.session_id
        };
        let _ = self.0.agents.archive(&session_id).await;
        self.notify();
        Ok(self.list_public().await)
    }

    async fn dispatch_thread(
        &self,
        bot_id: &str,
        task: String,
        thread_id: Option<&str>,
        title: Option<&str>,
    ) -> Result<(BotThread, Vec<PublicBot>)> {
        validate_bot_id(bot_id)?;
        let trimmed = task.trim();
        if trimmed.is_empty() {
            return Err(Error::Invalid("任务内容不能为空".into()));
        }
        let thread = if let Some(thread_id) = thread_id.filter(|v| !v.trim().is_empty()) {
            let guard = self.0.state.lock().await;
            let file = guard.threads.get(bot_id).ok_or(Error::NotFound)?;
            file.threads
                .iter()
                .find(|t| t.id == thread_id)
                .cloned()
                .ok_or(Error::NotFound)?
        } else {
            let default_title = title
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| truncate_chars(trimmed, 36));
            self.create_thread(
                bot_id,
                Some(&default_title),
                BotThreadChannel::Desktop,
                None,
            )
            .await?
            .0
        };
        self.0
            .agents
            .send(&thread.session_id, trimmed.to_owned(), None, Vec::new())
            .await?;
        let bots = {
            let mut guard = self.0.state.lock().await;
            if let Some(file) = guard.threads.get_mut(bot_id)
                && let Some(item) = file.threads.iter_mut().find(|t| t.id == thread.id)
            {
                item.updated_at = now();
                let _ = save_threads(&self.0.directory, bot_id, file);
            }
            build_public_bots(&self.0.directory, &guard)
        };
        self.notify();
        Ok((thread, bots))
    }

    pub async fn update_feishu_status(&self, bot_id: &str, status: BotFeishuRuntimeStatus) {
        let mut guard = self.0.state.lock().await;
        guard.statuses.insert(bot_id.to_owned(), status);
        drop(guard);
        self.notify();
    }

    pub async fn create_feishu_thread(
        &self,
        bot_id: &str,
        chat_id: &str,
        channel: BotThreadChannel,
        title_hint: &str,
    ) -> Result<BotThread> {
        let title = truncate_chars(title_hint, 36);
        let (thread, _) = self
            .create_thread(bot_id, Some(&title), channel, Some(chat_id.to_owned()))
            .await?;
        Ok(thread)
    }

    pub async fn resolve_or_create_feishu_thread(
        &self,
        bot_id: &str,
        chat_id: &str,
        channel: BotThreadChannel,
        reply_to_message_id: Option<&str>,
        prompt: &str,
        force_new: bool,
    ) -> Result<BotThread> {
        if !force_new {
            let existing = {
                let mut guard = self.0.state.lock().await;
                if let Some(file) = guard.threads.get_mut(bot_id) {
                    let target_id = reply_to_message_id
                        .and_then(|msg_id| {
                            file.feishu_reply_threads
                                .iter()
                                .rev()
                                .find(|(reply_id, _)| reply_id == msg_id)
                                .map(|(_, thread_id)| thread_id.clone())
                        })
                        .or_else(|| file.feishu_chat_threads.get(chat_id).cloned());
                    if let Some(tid) = target_id {
                        if let Some(pos) = file.threads.iter().position(|t| t.id == tid) {
                            file.threads[pos].updated_at = now();
                            let thread = file.threads[pos].clone();
                            file.feishu_chat_threads
                                .insert(chat_id.to_owned(), thread.id.clone());
                            let _ = save_threads(&self.0.directory, bot_id, file);
                            Some(thread)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            if let Some(thread) = existing {
                let sid = thread.session_id.clone();
                let valid = self
                    .0
                    .database
                    .read("bots.feishu_session_check", move |store| {
                        store.session(&sid)
                    })
                    .await
                    .is_ok();
                if valid {
                    self.notify();
                    return Ok(thread);
                }
            }
        }
        let title_hint = truncate_chars(prompt, 36);
        self.create_feishu_thread(bot_id, chat_id, channel, &title_hint)
            .await
    }

    pub async fn record_feishu_reply(&self, bot_id: &str, reply_message_id: &str, thread_id: &str) {
        if reply_message_id.is_empty() {
            return;
        }
        let mut guard = self.0.state.lock().await;
        if let Some(file) = guard.threads.get_mut(bot_id) {
            file.feishu_reply_threads
                .push((reply_message_id.to_owned(), thread_id.to_owned()));
            if file.feishu_reply_threads.len() > MAX_FEISHU_REPLY_MAP {
                let drain = file.feishu_reply_threads.len() - MAX_FEISHU_REPLY_MAP;
                file.feishu_reply_threads.drain(0..drain);
            }
            let _ = save_threads(&self.0.directory, bot_id, file);
        }
    }

    pub async fn touch_session_message(&self, session_id: &str, message_text: &str) {
        let trimmed = message_text.trim();
        let updated = {
            let mut guard = self.0.state.lock().await;
            let mut touched_bot: Option<String> = None;
            for (bot_id, file) in guard.threads.iter_mut() {
                if let Some(thread) = file
                    .threads
                    .iter_mut()
                    .find(|item| item.session_id == session_id)
                {
                    thread.updated_at = now();
                    if !trimmed.is_empty()
                        && (thread.title == "新对话" || thread.title.ends_with(" 对话"))
                    {
                        thread.title = truncate_chars(trimmed, 32);
                    }
                    touched_bot = Some(bot_id.clone());
                    break;
                }
            }
            if let Some(bot_id) = touched_bot {
                if let Some(file) = guard.threads.get(&bot_id) {
                    let _ = save_threads(&self.0.directory, &bot_id, file);
                }
                true
            } else {
                false
            }
        };
        if updated {
            self.notify();
        }
    }

    pub async fn notify_memory_updated(&self) {
        self.notify();
    }

    pub async fn prepare_feishu_memory_turn(
        &self,
        input: FeishuMemoryTurnInput,
    ) -> Result<PreparedFeishuTurn> {
        validate_bot_id(&input.bot_id)?;
        let clean_chat = sanitize_memory_entity_id(&input.chat_id, "群聊 ID")?;
        let clean_sender = input
            .sender_open_id
            .as_deref()
            .and_then(|value| sanitize_memory_entity_id(value, "用户 ID").ok());
        let ts = now();

        let (bot, metas_changed) = {
            let mut guard = self.0.state.lock().await;
            let bot = guard
                .registry
                .bots
                .iter()
                .find(|bot| bot.id == input.bot_id)
                .cloned()
                .ok_or(Error::NotFound)?;
            sync_bot_workspace_files(&self.0.directory, &bot)?;
            let index = guard.memories.entry(bot.id.clone()).or_default();
            let mut changed = false;

            if input.is_group {
                let chat_key = format!("chat:{clean_chat}");
                changed |= upsert_memory_meta(
                    index,
                    &chat_key,
                    BotMemoryScope::Chat,
                    None,
                    Some(clean_chat.clone()),
                    input.chat_name.clone(),
                    None,
                    None,
                    ts,
                );
                if let Some(ref uid) = clean_sender {
                    let user_key = format!("user:{uid}");
                    changed |= upsert_memory_meta(
                        index,
                        &user_key,
                        BotMemoryScope::User,
                        None,
                        None,
                        None,
                        Some(uid.clone()),
                        input.sender_name.clone(),
                        ts,
                    );
                    let member_key = format!("member:{clean_chat}:{uid}");
                    changed |= upsert_memory_meta(
                        index,
                        &member_key,
                        BotMemoryScope::Member,
                        None,
                        Some(clean_chat.clone()),
                        input.chat_name.clone(),
                        Some(uid.clone()),
                        input.sender_name.clone(),
                        ts,
                    );
                }
            } else if let Some(ref uid) = clean_sender {
                let user_key = format!("user:{uid}");
                changed |= upsert_memory_meta(
                    index,
                    &user_key,
                    BotMemoryScope::User,
                    None,
                    None,
                    None,
                    Some(uid.clone()),
                    input.sender_name.clone(),
                    ts,
                );
            } else {
                let chat_key = format!("chat:{clean_chat}");
                changed |= upsert_memory_meta(
                    index,
                    &chat_key,
                    BotMemoryScope::Chat,
                    None,
                    Some(clean_chat.clone()),
                    input.chat_name.clone(),
                    None,
                    None,
                    ts,
                );
            }

            prune_memory_index(index);
            if changed {
                let _ = save_memory_index(&self.0.directory, &bot.id, index);
            }
            (bot, changed)
        };

        let memory_root = bot_memory_root(&self.0.directory, &bot);
        ensure_dir_private(&memory_root)?;

        let global_path = bot_memory_path(&self.0.directory, &bot);
        let global_text = read_memory_excerpt(&global_path);

        let mut allowed_sections: Vec<String> = Vec::new();
        if !global_text.is_empty() {
            allowed_sections.push(format!("[全局长期记忆 (`MEMORY.md`)]\n{global_text}"));
        }

        let chat_display = input
            .chat_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&clean_chat);
        let sender_display = input
            .sender_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or(clean_sender.as_deref())
            .unwrap_or("成员");

        let mut writable_targets: Vec<String> = vec![format!(
            "- 公共/跨场景事实 → `{}`",
            global_path.display()
        )];

        if input.is_group {
            let chat_key = format!("chat:{clean_chat}");
            let chat_parsed = parse_memory_key(&chat_key)?;
            let chat_path = memory_file_path(&self.0.directory, &bot, &chat_parsed);
            ensure_scoped_starter_file(
                &chat_path,
                &format!(
                    "# 群记忆 · {chat_display}\n\n> 该记忆仅在当前群对话中读写，与其他群完全隔离。\n"
                ),
            )?;
            let chat_text = read_memory_excerpt(&chat_path);
            if !chat_text.is_empty() {
                allowed_sections.push(format!(
                    "[本群记忆 · {chat_display} (`memory/chats/{clean_chat}.md`)]\n{chat_text}"
                ));
            }
            writable_targets.push(format!(
                "- 本群共享背景、规范与结论 → `{}`",
                chat_path.display()
            ));

            if let Some(ref uid) = clean_sender {
                let member_key = format!("member:{clean_chat}:{uid}");
                let member_parsed = parse_memory_key(&member_key)?;
                let member_path = memory_file_path(&self.0.directory, &bot, &member_parsed);
                ensure_scoped_starter_file(
                    &member_path,
                    &format!(
                        "# 群内成员记忆 · {chat_display} / {sender_display}\n\n> 该记忆仅记录「{sender_display}」在「{chat_display}」群内的角色、上下文与待办。\n"
                    ),
                )?;
                let member_text = read_memory_excerpt(&member_path);
                if !member_text.is_empty() {
                    allowed_sections.push(format!(
                        "[群+人专属记忆 · {chat_display} · {sender_display} (`memory/members/{clean_chat}__{uid}.md`)]\n{member_text}"
                    ));
                }
                writable_targets.push(format!(
                    "- 「{sender_display}」在本群的角色/任务/上下文 → `{}`",
                    member_path.display()
                ));

                let user_key = format!("user:{uid}");
                let user_parsed = parse_memory_key(&user_key)?;
                let user_path = memory_file_path(&self.0.directory, &bot, &user_parsed);
                ensure_scoped_starter_file(
                    &user_path,
                    &format!(
                        "# 个人记忆 · {sender_display}\n\n> 该记忆记录「{sender_display}」的通用称呼、角色与表达偏好；切勿将私聊敏感信息带入公开群聊。\n"
                    ),
                )?;
                let user_text = read_memory_excerpt(&user_path);
                if !user_text.is_empty() {
                    allowed_sections.push(format!(
                        "[发言人通用偏好 · {sender_display} (`memory/users/{uid}.md`)]\n{user_text}"
                    ));
                }
                writable_targets.push(format!(
                    "- 「{sender_display}」的通用称呼/跨场景公开偏好 → `{}`",
                    user_path.display()
                ));
            }
        } else if let Some(ref uid) = clean_sender {
            let user_key = format!("user:{uid}");
            let user_parsed = parse_memory_key(&user_key)?;
            let user_path = memory_file_path(&self.0.directory, &bot, &user_parsed);
            ensure_scoped_starter_file(
                &user_path,
                &format!(
                    "# 个人记忆 · {sender_display}\n\n> 该记忆记录「{sender_display}」的个人偏好、私聊背景与长期习惯。\n"
                ),
            )?;
            let user_text = read_memory_excerpt(&user_path);
            if !user_text.is_empty() {
                allowed_sections.push(format!(
                    "[私聊对象个人记忆 · {sender_display} (`memory/users/{uid}.md`)]\n{user_text}"
                ));
            }
            writable_targets.push(format!(
                "- 「{sender_display}」的个人偏好与私聊重要记忆 → `{}`",
                user_path.display()
            ));
        } else {
            let chat_key = format!("chat:{clean_chat}");
            let chat_parsed = parse_memory_key(&chat_key)?;
            let chat_path = memory_file_path(&self.0.directory, &bot, &chat_parsed);
            ensure_scoped_starter_file(
                &chat_path,
                &format!(
                    "# 对话记忆 · {chat_display}\n\n> 该记忆仅在当前飞书会话中读写。\n"
                ),
            )?;
            let chat_text = read_memory_excerpt(&chat_path);
            if !chat_text.is_empty() {
                allowed_sections.push(format!(
                    "[本会话记忆 · {chat_display} (`memory/chats/{clean_chat}.md`)]\n{chat_text}"
                ));
            }
            writable_targets.push(format!("- 本会话记忆 → `{}`", chat_path.display()));
        }

        if metas_changed {
            self.notify();
        }

        let header = if input.is_group {
            format!("[飞书群聊: {chat_display} | 发言人: {sender_display}]")
        } else {
            format!("[飞书私聊 | 发言人: {sender_display}]")
        };

        let existing_block = if allowed_sections.is_empty() {
            "（当前作用域尚无额外长期记忆）".to_owned()
        } else {
            allowed_sections.join("\n\n")
        };

        let privacy_note = if input.is_group {
            "隐私与隔离原则：只可读写以上属于本群及当前发言人的记忆文件；严禁读取或引用其他群的记忆，也不要在公开群内泄露私聊敏感信息。回复用户时严禁提及文件路径或目录结构。"
        } else {
            "隔离原则：只可读写以上属于全局或当前私聊对象的记忆文件；回复用户时严禁提及文件路径或目录结构。"
        };

        let augmented_prompt = format!(
            "{header}\n{}\n\n<prospero_memory_context>\n{existing_block}\n\n需要记住新信息时，请按作用域写入对应文件：\n{}\n\n{privacy_note}\n</prospero_memory_context>",
            input.user_prompt.trim(),
            writable_targets.join("\n"),
        );

        let prompt_short = truncate_chars(input.user_prompt.trim(), 24);
        let thread_title_hint = if input.is_group {
            if let Some(name) = input
                .chat_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                truncate_chars(&format!("{name} · {prompt_short}"), 40)
            } else {
                truncate_chars(input.user_prompt.trim(), 36)
            }
        } else if let Some(name) = input
            .sender_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            truncate_chars(&format!("{name} · {prompt_short}"), 40)
        } else {
            truncate_chars(input.user_prompt.trim(), 36)
        };

        Ok(PreparedFeishuTurn {
            augmented_prompt,
            thread_title_hint,
        })
    }

    pub async fn describe_feishu_status(&self, bot_id: &str, chat_id: &str) -> Result<String> {
        let guard = self.0.state.lock().await;
        let bot = guard
            .registry
            .bots
            .iter()
            .find(|bot| bot.id == bot_id)
            .ok_or(Error::NotFound)?;
        let active_thread = guard
            .threads
            .get(bot_id)
            .and_then(|file| {
                let tid = file.feishu_chat_threads.get(chat_id)?;
                file.threads.iter().find(|t| &t.id == tid)
            })
            .map(|t| format!("{} (`{}`)", t.title, t.id))
            .unwrap_or_else(|| "暂无（发送任意消息将自动创建）".into());
        let (chat_count, user_count, member_count) = guard
            .memories
            .get(bot_id)
            .map(|index| {
                index
                    .entries
                    .values()
                    .fold((0usize, 0usize, 0usize), |acc, entry| match entry.scope {
                        BotMemoryScope::Chat => (acc.0 + 1, acc.1, acc.2),
                        BotMemoryScope::User => (acc.0, acc.1 + 1, acc.2),
                        BotMemoryScope::Member => (acc.0, acc.1, acc.2 + 1),
                        BotMemoryScope::Global => acc,
                    })
            })
            .unwrap_or((0, 0, 0));
        let model = bot.model.as_deref().unwrap_or("默认");
        Ok(format!(
            "- **Bot**: {} (`{}`)\n- **Harness / 模型**: `{:?}` / `{}`\n- **多 Bot 协同**: {}\n- **分层记忆**: 群 {} · 个人 {} · 群+人 {}\n- **当前话题**: {}\n\n发送 `/new` 可开启新话题。",
            bot.name,
            bot.id,
            bot.agent,
            model,
            if bot.allow_cross_workspace {
                "已开启"
            } else {
                "独立运行"
            },
            chat_count,
            user_count,
            member_count,
            active_thread
        ))
    }

    async fn list_memories(&self, bot_id: &str) -> Result<Vec<BotMemoryEntry>> {
        validate_bot_id(bot_id)?;
        let (bot, mut index) = {
            let guard = self.0.state.lock().await;
            let bot = guard
                .registry
                .bots
                .iter()
                .find(|bot| bot.id == bot_id)
                .cloned()
                .ok_or(Error::NotFound)?;
            let index = guard.memories.get(bot_id).cloned().unwrap_or_default();
            (bot, index)
        };
        sync_bot_workspace_files(&self.0.directory, &bot)?;
        let discovered_changed = discover_disk_memories(&self.0.directory, &bot, &mut index);
        if discovered_changed {
            let mut guard = self.0.state.lock().await;
            let current = guard.memories.entry(bot.id.clone()).or_default();
            for (k, meta) in &index.entries {
                current.entries.entry(k.clone()).or_insert_with(|| meta.clone());
            }
            prune_memory_index(current);
            let _ = save_memory_index(&self.0.directory, &bot.id, current);
            index = current.clone();
        }

        let global_path = bot_memory_path(&self.0.directory, &bot);
        let global_content = fs::read_to_string(&global_path).unwrap_or_default();
        let (global_preview, global_has_content) = memory_content_summary(&global_content);
        let global_mtime = file_mtime_ms(&global_path).max(bot.updated_at);
        let mut items = vec![BotMemoryEntry {
            key: "global".into(),
            scope: BotMemoryScope::Global,
            label: "全局长期记忆".into(),
            chat_id: None,
            chat_name: None,
            user_id: None,
            user_name: None,
            preview: global_preview,
            has_content: global_has_content,
            updated_at: global_mtime,
        }];

        let mut scoped: Vec<BotMemoryEntry> = Vec::new();
        for meta in index.entries.values() {
            let Ok(parsed) = parse_memory_key(&meta.key) else {
                continue;
            };
            if matches!(parsed, ParsedMemoryKey::Global) {
                continue;
            }
            let path = memory_file_path(&self.0.directory, &bot, &parsed);
            if !path.exists() {
                continue;
            }
            let content = fs::read_to_string(&path).unwrap_or_default();
            let (preview, has_content) = memory_content_summary(&content);
            let updated_at = meta.updated_at.max(file_mtime_ms(&path));
            scoped.push(BotMemoryEntry {
                key: meta.key.clone(),
                scope: meta.scope,
                label: compute_memory_label(meta),
                chat_id: meta.chat_id.clone(),
                chat_name: meta.chat_name.clone(),
                user_id: meta.user_id.clone(),
                user_name: meta.user_name.clone(),
                preview,
                has_content,
                updated_at,
            });
        }
        scoped.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.key.cmp(&b.key)));
        items.extend(scoped);
        Ok(items)
    }

    async fn read_memory_entry(&self, bot_id: &str, key: &str) -> Result<BotMemoryView> {
        validate_bot_id(bot_id)?;
        let parsed = parse_memory_key(key)?;
        let (bot, meta) = {
            let guard = self.0.state.lock().await;
            let bot = guard
                .registry
                .bots
                .iter()
                .find(|bot| bot.id == bot_id)
                .cloned()
                .ok_or(Error::NotFound)?;
            let meta = guard
                .memories
                .get(bot_id)
                .and_then(|idx| idx.entries.get(key))
                .cloned();
            (bot, meta)
        };
        sync_bot_workspace_files(&self.0.directory, &bot)?;
        let path = memory_file_path(&self.0.directory, &bot, &parsed);
        let content = fs::read_to_string(&path).unwrap_or_default();
        let file_ts = file_mtime_ms(&path);
        match parsed {
            ParsedMemoryKey::Global => Ok(BotMemoryView {
                bot_id: bot.id,
                key: "global".into(),
                scope: BotMemoryScope::Global,
                label: "全局长期记忆".into(),
                chat_id: None,
                chat_name: None,
                user_id: None,
                user_name: None,
                path: path.to_string_lossy().into_owned(),
                content,
                updated_at: file_ts.max(bot.updated_at),
            }),
            ParsedMemoryKey::Chat(chat_id) => {
                let effective = meta.unwrap_or_else(|| {
                    default_memory_meta(key, BotMemoryScope::Chat, Some(chat_id), None, file_ts)
                });
                Ok(BotMemoryView {
                    bot_id: bot.id,
                    key: effective.key.clone(),
                    scope: BotMemoryScope::Chat,
                    label: compute_memory_label(&effective),
                    chat_id: effective.chat_id,
                    chat_name: effective.chat_name,
                    user_id: None,
                    user_name: None,
                    path: path.to_string_lossy().into_owned(),
                    content,
                    updated_at: effective.updated_at.max(file_ts),
                })
            }
            ParsedMemoryKey::User(user_id) => {
                let effective = meta.unwrap_or_else(|| {
                    default_memory_meta(key, BotMemoryScope::User, None, Some(user_id), file_ts)
                });
                Ok(BotMemoryView {
                    bot_id: bot.id,
                    key: effective.key.clone(),
                    scope: BotMemoryScope::User,
                    label: compute_memory_label(&effective),
                    chat_id: None,
                    chat_name: None,
                    user_id: effective.user_id,
                    user_name: effective.user_name,
                    path: path.to_string_lossy().into_owned(),
                    content,
                    updated_at: effective.updated_at.max(file_ts),
                })
            }
            ParsedMemoryKey::Member { chat_id, user_id } => {
                let effective = meta.unwrap_or_else(|| {
                    default_memory_meta(
                        key,
                        BotMemoryScope::Member,
                        Some(chat_id),
                        Some(user_id),
                        file_ts,
                    )
                });
                Ok(BotMemoryView {
                    bot_id: bot.id,
                    key: effective.key.clone(),
                    scope: BotMemoryScope::Member,
                    label: compute_memory_label(&effective),
                    chat_id: effective.chat_id,
                    chat_name: effective.chat_name,
                    user_id: effective.user_id,
                    user_name: effective.user_name,
                    path: path.to_string_lossy().into_owned(),
                    content,
                    updated_at: effective.updated_at.max(file_ts),
                })
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn write_memory_entry(
        &self,
        bot_id: &str,
        key: &str,
        content: &str,
        label: Option<String>,
        chat_id_override: Option<String>,
        chat_name_override: Option<String>,
        user_id_override: Option<String>,
        user_name_override: Option<String>,
    ) -> Result<BotMemoryView> {
        validate_bot_id(bot_id)?;
        if content.len() > MAX_MEMORY_BYTES {
            return Err(Error::Invalid("长期记忆内容不能超过 256 KB".into()));
        }
        let parsed = parse_memory_key(key)?;
        let ts = now();
        let (bot, meta) = {
            let mut guard = self.0.state.lock().await;
            let bot = guard
                .registry
                .bots
                .iter()
                .find(|bot| bot.id == bot_id)
                .cloned()
                .ok_or(Error::NotFound)?;
            sync_bot_workspace_files(&self.0.directory, &bot)?;

            let meta = match &parsed {
                ParsedMemoryKey::Global => None,
                ParsedMemoryKey::Chat(cid) => {
                    let index = guard.memories.entry(bot.id.clone()).or_default();
                    let chat_id = chat_id_override
                        .as_deref()
                        .and_then(|v| sanitize_memory_entity_id(v, "群聊 ID").ok())
                        .unwrap_or_else(|| cid.clone());
                    upsert_memory_meta(
                        index,
                        key,
                        BotMemoryScope::Chat,
                        clean_optional_label(label),
                        Some(chat_id),
                        clean_optional_label(chat_name_override),
                        None,
                        None,
                        ts,
                    );
                    prune_memory_index(index);
                    save_memory_index(&self.0.directory, &bot.id, index)?;
                    index.entries.get(key).cloned()
                }
                ParsedMemoryKey::User(uid) => {
                    let index = guard.memories.entry(bot.id.clone()).or_default();
                    let user_id = user_id_override
                        .as_deref()
                        .and_then(|v| sanitize_memory_entity_id(v, "用户 ID").ok())
                        .unwrap_or_else(|| uid.clone());
                    upsert_memory_meta(
                        index,
                        key,
                        BotMemoryScope::User,
                        clean_optional_label(label),
                        None,
                        None,
                        Some(user_id),
                        clean_optional_label(user_name_override),
                        ts,
                    );
                    prune_memory_index(index);
                    save_memory_index(&self.0.directory, &bot.id, index)?;
                    index.entries.get(key).cloned()
                }
                ParsedMemoryKey::Member { chat_id, user_id } => {
                    let index = guard.memories.entry(bot.id.clone()).or_default();
                    let cid = chat_id_override
                        .as_deref()
                        .and_then(|v| sanitize_memory_entity_id(v, "群聊 ID").ok())
                        .unwrap_or_else(|| chat_id.clone());
                    let uid = user_id_override
                        .as_deref()
                        .and_then(|v| sanitize_memory_entity_id(v, "用户 ID").ok())
                        .unwrap_or_else(|| user_id.clone());
                    upsert_memory_meta(
                        index,
                        key,
                        BotMemoryScope::Member,
                        clean_optional_label(label),
                        Some(cid),
                        clean_optional_label(chat_name_override),
                        Some(uid),
                        clean_optional_label(user_name_override),
                        ts,
                    );
                    prune_memory_index(index);
                    save_memory_index(&self.0.directory, &bot.id, index)?;
                    index.entries.get(key).cloned()
                }
            };
            (bot, meta)
        };

        let path = memory_file_path(&self.0.directory, &bot, &parsed);
        write_atomic_file(&path, content.as_bytes())?;
        self.notify();

        match meta {
            None => Ok(BotMemoryView {
                bot_id: bot.id,
                key: "global".into(),
                scope: BotMemoryScope::Global,
                label: "全局长期记忆".into(),
                chat_id: None,
                chat_name: None,
                user_id: None,
                user_name: None,
                path: path.to_string_lossy().into_owned(),
                content: content.to_owned(),
                updated_at: ts,
            }),
            Some(entry) => Ok(BotMemoryView {
                bot_id: bot.id,
                key: entry.key.clone(),
                scope: entry.scope,
                label: compute_memory_label(&entry),
                chat_id: entry.chat_id,
                chat_name: entry.chat_name,
                user_id: entry.user_id,
                user_name: entry.user_name,
                path: path.to_string_lossy().into_owned(),
                content: content.to_owned(),
                updated_at: entry.updated_at,
            }),
        }
    }

    async fn delete_memory_entry(&self, bot_id: &str, key: &str) -> Result<Vec<BotMemoryEntry>> {
        validate_bot_id(bot_id)?;
        let parsed = parse_memory_key(key)?;
        let bot = {
            let mut guard = self.0.state.lock().await;
            let bot = guard
                .registry
                .bots
                .iter()
                .find(|bot| bot.id == bot_id)
                .cloned()
                .ok_or(Error::NotFound)?;
            if !matches!(parsed, ParsedMemoryKey::Global)
                && let Some(index) = guard.memories.get_mut(bot_id)
            {
                index.entries.remove(key);
                save_memory_index(&self.0.directory, &bot.id, index)?;
            }
            bot
        };

        let path = memory_file_path(&self.0.directory, &bot, &parsed);
        if matches!(parsed, ParsedMemoryKey::Global) {
            let initial_memory = format!(
                "# {} · 长期记忆\n\n> 该文件跨话题持久保存，可在桌面端查看与编辑。\n",
                bot.name
            );
            write_atomic_file(&path, initial_memory.as_bytes())?;
        } else if path.exists() {
            let _ = fs::remove_file(&path);
        }
        self.notify();
        self.list_memories(bot_id).await
    }

    async fn reconcile_worker(&self, bot: &StoredBot, force_restart: bool) {
        let mut workers = self.0.workers.lock().await;
        if !bot.feishu.enabled {
            if let Some(slot) = workers.remove(&bot.id) {
                let _ = slot.stop.send(true);
            }
            drop(workers);
            self.update_feishu_status(
                &bot.id,
                BotFeishuRuntimeStatus {
                    state: FeishuConnectionState::Disabled,
                    ..Default::default()
                },
            )
            .await;
            return;
        }
        if !force_restart
            && let Some(existing) = workers.get(&bot.id)
            && existing.config == bot.feishu
        {
            return;
        }
        if let Some(old) = workers.remove(&bot.id) {
            let _ = old.stop.send(true);
        }
        let (stop_tx, stop_rx) = watch::channel(false);
        workers.insert(
            bot.id.clone(),
            WorkerSlot {
                config: bot.feishu.clone(),
                stop: stop_tx,
            },
        );
        drop(workers);
        spawn_worker(
            FeishuWorkerConfig {
                bot_id: bot.id.clone(),
                bot_name: bot.name.clone(),
                domain: bot.feishu.domain,
                app_id: bot.feishu.app_id.clone(),
                app_secret: bot.feishu.app_secret.clone(),
                group_trigger: bot.feishu.group_trigger,
                streaming_card: bot.feishu.streaming_card,
            },
            self.clone(),
            stop_rx,
        );
    }
}

struct ValidatedUpsert {
    name: String,
    avatar: String,
    description: String,
    system_prompt: String,
    agent: AgentKind,
    account_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    source_binding: Option<BotSourceBinding>,
    custom_workspace: Option<String>,
    allow_cross_workspace: bool,
    feishu: StoredFeishuConfig,
}

fn validate_bot_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(Error::Invalid("Bot ID 无效".into()));
    }
    Ok(())
}

fn validate_upsert_input(
    input: BotUpsertInput,
    existing_feishu: Option<&StoredFeishuConfig>,
) -> Result<ValidatedUpsert> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
        return Err(Error::Invalid("Bot 名称应为 1–60 个字符".into()));
    }
    if !matches!(
        input.agent,
        AgentKind::Codex
            | AgentKind::Claude
            | AgentKind::Agy
            | AgentKind::Deepseek
            | AgentKind::Opencode
            | AgentKind::Pi
    ) {
        return Err(Error::Invalid(
            "Bot 仅支持结构化 Agent（Codex / Claude / AGY / DeepSeek / OpenCode / Pi）".into(),
        ));
    }
    if input.system_prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err(Error::Invalid("系统人设提示词过长".into()));
    }
    let avatar = {
        let trimmed = input.avatar.trim();
        if trimmed.is_empty() {
            "🤖".into()
        } else {
            trimmed.chars().take(8).collect()
        }
    };
    let description = input.description.trim().chars().take(240).collect();

    let mut account_id = input
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if let Some(ref binding) = input.source_binding {
        if binding.source_id.trim().is_empty()
            || binding.route_id.trim().is_empty()
            || binding.bound_account_id.trim().is_empty()
        {
            return Err(Error::Invalid("模型源绑定信息不完整".into()));
        }
        account_id = Some(binding.bound_account_id.trim().to_owned());
    }
    if input.agent == AgentKind::Opencode && account_id.is_none() {
        return Err(Error::Invalid(
            "OpenCode Bot 需要绑定 OpenAI Chat Completions 账号或模型源".into(),
        ));
    }

    let custom_workspace = match input
        .custom_workspace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(raw) => {
            let path = Path::new(raw);
            if !path.is_absolute() {
                return Err(Error::Invalid("自定义工作区必须是绝对路径".into()));
            }
            let canonical = fs::canonicalize(path)
                .map_err(|_| Error::Invalid("自定义工作区目录不存在".into()))?;
            if !canonical.is_dir() {
                return Err(Error::Invalid("自定义工作区不是有效目录".into()));
            }
            Some(
                canonical
                    .to_str()
                    .ok_or_else(|| Error::Invalid("自定义工作区路径必须是有效的 UTF-8".into()))?
                    .to_owned(),
            )
        }
        None => None,
    };

    let feishu = match input.feishu {
        Some(cfg) => {
            let app_id = cfg.app_id.trim().to_owned();
            let app_secret = cfg
                .app_secret
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .or_else(|| existing_feishu.map(|item| item.app_secret.clone()))
                .unwrap_or_default();
            if cfg.enabled && (app_id.is_empty() || app_secret.is_empty()) {
                return Err(Error::Invalid(
                    "启用飞书 IM 时必须填写 App ID 和 App Secret".into(),
                ));
            }
            StoredFeishuConfig {
                enabled: cfg.enabled,
                domain: cfg.domain,
                app_id,
                app_secret,
                group_trigger: cfg.group_trigger,
                streaming_card: cfg.streaming_card,
            }
        }
        None => existing_feishu.cloned().unwrap_or_default(),
    };

    Ok(ValidatedUpsert {
        name: name.to_owned(),
        avatar,
        description,
        system_prompt: input.system_prompt.trim().to_owned(),
        agent: input.agent,
        account_id,
        model: input
            .model
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned),
        effort: input
            .effort
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned),
        source_binding: input.source_binding,
        custom_workspace,
        allow_cross_workspace: input.allow_cross_workspace,
        feishu,
    })
}

fn default_master_bot() -> StoredBot {
    let ts = now();
    StoredBot {
        id: MASTER_BOT_ID.into(),
        kind: BotKind::Master,
        name: "Prospero Bot".into(),
        avatar: "⚡".into(),
        description: DEFAULT_MASTER_DESC.into(),
        system_prompt: DEFAULT_MASTER_PROMPT.into(),
        agent: AgentKind::Codex,
        account_id: None,
        model: Some("gpt-6-astra".into()),
        effort: None,
        source_binding: None,
        custom_workspace: None,
        allow_cross_workspace: true,
        feishu: StoredFeishuConfig::default(),
        created_at: ts,
        updated_at: ts,
    }
}

fn bots_root(daemon_home: &Path) -> PathBuf {
    daemon_home.join("bots")
}

fn bot_dir(daemon_home: &Path, bot_id: &str) -> PathBuf {
    bots_root(daemon_home).join(bot_id)
}

fn bot_managed_workspace(daemon_home: &Path, bot_id: &str) -> PathBuf {
    bot_dir(daemon_home, bot_id).join("workspace")
}

fn bot_threads_path(daemon_home: &Path, bot_id: &str) -> PathBuf {
    bot_dir(daemon_home, bot_id).join("threads.json")
}

fn bot_memory_index_path(daemon_home: &Path, bot_id: &str) -> PathBuf {
    bot_dir(daemon_home, bot_id).join("memory-index.json")
}

fn resolve_bot_workspace(daemon_home: &Path, bot: &StoredBot) -> Result<PathBuf> {
    if let Some(custom) = bot.custom_workspace.as_deref() {
        let path = PathBuf::from(custom);
        if path.is_dir() {
            return Ok(path);
        }
    }
    let managed = bot_managed_workspace(daemon_home, &bot.id);
    ensure_dir_private(&managed)?;
    Ok(managed)
}

fn bot_memory_path(daemon_home: &Path, bot: &StoredBot) -> PathBuf {
    if bot.custom_workspace.is_some() {
        bot_dir(daemon_home, &bot.id).join("MEMORY.md")
    } else {
        bot_managed_workspace(daemon_home, &bot.id).join("MEMORY.md")
    }
}

fn bot_memory_root(daemon_home: &Path, bot: &StoredBot) -> PathBuf {
    if bot.custom_workspace.is_some() {
        bot_dir(daemon_home, &bot.id).join("memory")
    } else {
        bot_managed_workspace(daemon_home, &bot.id).join("memory")
    }
}

enum ParsedMemoryKey {
    Global,
    Chat(String),
    User(String),
    Member { chat_id: String, user_id: String },
}

fn sanitize_memory_entity_id(value: &str, label: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > 128
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(Error::Invalid(format!("{label} 无效（仅支持字母、数字、-、_）")));
    }
    Ok(trimmed.to_owned())
}

fn parse_memory_key(key: &str) -> Result<ParsedMemoryKey> {
    if key == "global" {
        return Ok(ParsedMemoryKey::Global);
    }
    if let Some(chat_id) = key.strip_prefix("chat:") {
        return Ok(ParsedMemoryKey::Chat(sanitize_memory_entity_id(
            chat_id,
            "群聊记忆 ID",
        )?));
    }
    if let Some(user_id) = key.strip_prefix("user:") {
        return Ok(ParsedMemoryKey::User(sanitize_memory_entity_id(
            user_id,
            "用户记忆 ID",
        )?));
    }
    if let Some(rest) = key.strip_prefix("member:")
        && let Some((chat_id, user_id)) = rest.split_once(':')
    {
        return Ok(ParsedMemoryKey::Member {
            chat_id: sanitize_memory_entity_id(chat_id, "群聊记忆 ID")?,
            user_id: sanitize_memory_entity_id(user_id, "用户记忆 ID")?,
        });
    }
    Err(Error::Invalid("长期记忆 key 无效".into()))
}

fn memory_file_path(daemon_home: &Path, bot: &StoredBot, parsed: &ParsedMemoryKey) -> PathBuf {
    match parsed {
        ParsedMemoryKey::Global => bot_memory_path(daemon_home, bot),
        ParsedMemoryKey::Chat(chat_id) => bot_memory_root(daemon_home, bot)
            .join("chats")
            .join(format!("{chat_id}.md")),
        ParsedMemoryKey::User(user_id) => bot_memory_root(daemon_home, bot)
            .join("users")
            .join(format!("{user_id}.md")),
        ParsedMemoryKey::Member { chat_id, user_id } => bot_memory_root(daemon_home, bot)
            .join("members")
            .join(format!("{chat_id}__{user_id}.md")),
    }
}

fn clean_optional_label(raw: Option<String>) -> Option<String> {
    raw.map(|s| s.trim().chars().take(80).collect::<String>())
        .filter(|s| !s.is_empty())
}

fn default_memory_meta(
    key: &str,
    scope: BotMemoryScope,
    chat_id: Option<String>,
    user_id: Option<String>,
    ts: i64,
) -> StoredMemoryMeta {
    StoredMemoryMeta {
        key: key.to_owned(),
        scope,
        custom_label: None,
        chat_id,
        chat_name: None,
        user_id,
        user_name: None,
        created_at: ts,
        updated_at: ts,
    }
}

#[allow(clippy::too_many_arguments)]
fn upsert_memory_meta(
    index: &mut BotMemoryIndexFile,
    key: &str,
    scope: BotMemoryScope,
    custom_label: Option<String>,
    chat_id: Option<String>,
    chat_name: Option<String>,
    user_id: Option<String>,
    user_name: Option<String>,
    ts: i64,
) -> bool {
    let clean_chat_name = clean_optional_label(chat_name);
    let clean_user_name = clean_optional_label(user_name);
    if let Some(existing) = index.entries.get_mut(key) {
        let mut changed = false;
        if let Some(next_label) = custom_label
            && existing.custom_label.as_deref() != Some(next_label.as_str())
        {
            existing.custom_label = Some(next_label);
            changed = true;
        }
        if let Some(name) = clean_chat_name
            && existing.chat_name.as_deref() != Some(name.as_str())
        {
            existing.chat_name = Some(name);
            changed = true;
        }
        if let Some(name) = clean_user_name
            && existing.user_name.as_deref() != Some(name.as_str())
        {
            existing.user_name = Some(name);
            changed = true;
        }
        if existing.updated_at != ts {
            existing.updated_at = ts;
        }
        return changed;
    }
    index.entries.insert(
        key.to_owned(),
        StoredMemoryMeta {
            key: key.to_owned(),
            scope,
            custom_label,
            chat_id,
            chat_name: clean_chat_name,
            user_id,
            user_name: clean_user_name,
            created_at: ts,
            updated_at: ts,
        },
    );
    true
}

fn prune_memory_index(index: &mut BotMemoryIndexFile) {
    if index.entries.len() <= MAX_MEMORY_ENTRIES {
        return;
    }
    let mut keys: Vec<(String, i64)> = index
        .entries
        .iter()
        .map(|(k, v)| (k.clone(), v.updated_at))
        .collect();
    keys.sort_by(|a, b| b.1.cmp(&a.1));
    for (k, _) in keys.into_iter().skip(MAX_MEMORY_ENTRIES) {
        index.entries.remove(&k);
    }
}

fn compute_memory_label(meta: &StoredMemoryMeta) -> String {
    if let Some(custom) = meta
        .custom_label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return custom.to_owned();
    }
    let chat = meta
        .chat_name
        .as_deref()
        .or(meta.chat_id.as_deref())
        .unwrap_or("未命名群聊");
    let user = meta
        .user_name
        .as_deref()
        .or(meta.user_id.as_deref())
        .unwrap_or("未命名成员");
    match meta.scope {
        BotMemoryScope::Global => "全局长期记忆".into(),
        BotMemoryScope::Chat => chat.to_owned(),
        BotMemoryScope::User => user.to_owned(),
        BotMemoryScope::Member => format!("{chat} · {user}"),
    }
}

fn memory_content_summary(content: &str) -> (String, bool) {
    let meaningful: Vec<&str> = content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("> 该"))
        .collect();
    if meaningful.is_empty() {
        return (String::new(), false);
    }
    (truncate_chars(meaningful[0], 140), true)
}

fn read_memory_excerpt(path: &Path) -> String {
    let Ok(raw) = fs::read_to_string(path) else {
        return String::new();
    };
    let (_, has_content) = memory_content_summary(&raw);
    if !has_content {
        return String::new();
    }
    let trimmed = raw.trim();
    if trimmed.chars().count() <= MAX_PROMPT_MEMORY_CHARS {
        trimmed.to_owned()
    } else {
        let head: String = trimmed.chars().take(MAX_PROMPT_MEMORY_CHARS).collect();
        format!("{head}\n...(完整内容见 `{}`)", path.display())
    }
}

fn file_mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as i64)
        .unwrap_or(0)
}

fn ensure_scoped_starter_file(path: &Path, starter: &str) -> Result<()> {
    if path.exists() {
        return Ok(());
    }
    write_atomic_file(path, starter.as_bytes())
}

fn discover_disk_memories(
    daemon_home: &Path,
    bot: &StoredBot,
    index: &mut BotMemoryIndexFile,
) -> bool {
    let root = bot_memory_root(daemon_home, bot);
    let mut changed = false;
    for (subdir, scope) in [
        ("chats", BotMemoryScope::Chat),
        ("users", BotMemoryScope::User),
        ("members", BotMemoryScope::Member),
    ] {
        let dir = root.join(subdir);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let ts = file_mtime_ms(&path).max(now());
            match scope {
                BotMemoryScope::Chat => {
                    if let Ok(cid) = sanitize_memory_entity_id(stem, "群聊 ID") {
                        let key = format!("chat:{cid}");
                        if !index.entries.contains_key(&key) {
                            index.entries.insert(
                                key.clone(),
                                default_memory_meta(&key, BotMemoryScope::Chat, Some(cid), None, ts),
                            );
                            changed = true;
                        }
                    }
                }
                BotMemoryScope::User => {
                    if let Ok(uid) = sanitize_memory_entity_id(stem, "用户 ID") {
                        let key = format!("user:{uid}");
                        if !index.entries.contains_key(&key) {
                            index.entries.insert(
                                key.clone(),
                                default_memory_meta(&key, BotMemoryScope::User, None, Some(uid), ts),
                            );
                            changed = true;
                        }
                    }
                }
                BotMemoryScope::Member => {
                    if let Some((raw_chat, raw_user)) = stem.split_once("__")
                        && let (Ok(cid), Ok(uid)) = (
                            sanitize_memory_entity_id(raw_chat, "群聊 ID"),
                            sanitize_memory_entity_id(raw_user, "用户 ID"),
                        )
                    {
                        let key = format!("member:{cid}:{uid}");
                        if !index.entries.contains_key(&key) {
                            index.entries.insert(
                                key.clone(),
                                default_memory_meta(
                                    &key,
                                    BotMemoryScope::Member,
                                    Some(cid),
                                    Some(uid),
                                    ts,
                                ),
                            );
                            changed = true;
                        }
                    }
                }
                BotMemoryScope::Global => {}
            }
        }
    }
    changed
}

fn save_memory_index(daemon_home: &Path, bot_id: &str, index: &BotMemoryIndexFile) -> Result<()> {
    let dir = bot_dir(daemon_home, bot_id);
    ensure_dir_private(&dir)?;
    let bytes = serde_json::to_vec_pretty(index)?;
    write_atomic_file(&bot_memory_index_path(daemon_home, bot_id), &bytes)
}

fn sync_bot_workspace_files(daemon_home: &Path, bot: &StoredBot) -> Result<()> {
    let managed_ws = bot_managed_workspace(daemon_home, &bot.id);
    ensure_dir_private(&managed_ws)?;
    let memory_path = bot_memory_path(daemon_home, bot);
    if !memory_path.exists() {
        let initial_memory = format!(
            "# {} · 长期记忆\n\n> 该文件跨话题持久保存，可在桌面端查看与编辑。\n",
            bot.name
        );
        write_atomic_file(&memory_path, initial_memory.as_bytes())?;
    }
    let memory_root = bot_memory_root(daemon_home, bot);
    for sub in ["chats", "users", "members"] {
        let _ = ensure_dir_private(&memory_root.join(sub));
    }

    let managed_section = build_bot_instruction_section(bot, &memory_path, &memory_root);
    if let Some(custom) = bot.custom_workspace.as_deref() {
        let custom_path = Path::new(custom);
        if custom_path.is_dir() {
            for filename in ["AGENTS.md", "CLAUDE.md"] {
                let target = custom_path.join(filename);
                upsert_delimited_section(&target, &managed_section)?;
            }
        }
    } else {
        for filename in ["AGENTS.md", "CLAUDE.md"] {
            let target = managed_ws.join(filename);
            write_atomic_file(&target, managed_section.as_bytes())?;
        }
    }
    Ok(())
}

fn build_bot_instruction_section(bot: &StoredBot, memory_path: &Path, memory_root: &Path) -> String {
    let role_label = match bot.kind {
        BotKind::Master => "主控 Bot (Master Bot)",
        BotKind::Sub => "子 Bot (Sub-Bot)",
    };
    let mut section = String::new();
    section.push_str(BOT_SECTION_START);
    section.push('\n');
    section.push_str(&format!("# {} ({})\n\n", bot.name, role_label));
    if !bot.description.is_empty() {
        section.push_str(&format!("简介：{}\n\n", bot.description));
    }
    if !bot.system_prompt.is_empty() {
        section.push_str("## 角色人设与行为准则\n\n");
        section.push_str(&bot.system_prompt);
        section.push_str("\n\n");
    }
    section.push_str("## 交互原则\n\n");
    section.push_str(
        "你是一位直接面向用户的个人智能体（类似 GrokBot / Muse），用户可能从桌面端或飞书 IM 与你对话。\n\
         - 除非用户主动要求操作某个本地文件，否则不要在回复中向用户提及底层目录路径、`AGENTS.md` / `CLAUDE.md` 或“工作区（Workspace）”概念。\n\
         - 对用户自然地呈现为纯粹的个人助手体验。\n\n",
    );
    section.push_str("## 分层长期记忆\n\n");
    section.push_str(&format!(
        "- 全局记忆文件：`{}`（公共事实、默认设定与桌面端对话通用偏好）。\n\
         - 分层记忆目录：`{}`（包含 `chats/<chat_id>.md` 群记忆、`users/<open_id>.md` 个人记忆、`members/<chat_id>__<open_id>.md` 群+人专属记忆）。\n\
         - 在飞书对话中，每条消息都会通过 `<prospero_memory_context>` 给出当前群与发言人允许访问的精确文件；请按作用域写入对应文件，切勿跨群读取或泄露他人私聊内容。\n\n",
        memory_path.display(),
        memory_root.display()
    ));
    if bot.allow_cross_workspace {
        section.push_str("## 多 Bot 协同调度\n\n");
        section.push_str(
            "当复杂任务适合交给专职子 Bot 分工合作时：\n\
             - 调用 `prospero bot list` 查看所有已配置的子 Bot 及其职责。\n\
             - 调用 `prospero bot dispatch --bot <botId> --task \"<完整任务>\"` 将子任务派发给对应子 Bot。\n\
             - 如需调用其他模型辅助推理，也可使用 `prospero child sources` 与 `prospero child start --agent <agent> --task \"<任务>\"` 启动后台子代理，无需让用户指定任何目录。\n",
        );
    } else {
        section.push_str("## 职责专注\n\n");
        section.push_str("专注于你自身的角色设定独立完成用户请求。\n");
    }
    section.push_str(BOT_SECTION_END);
    section.push('\n');
    section
}

fn upsert_delimited_section(path: &Path, section: &str) -> Result<()> {
    let existing = fs::read_to_string(path).unwrap_or_default();
    let next = if let (Some(start), Some(end)) = (
        existing.find(BOT_SECTION_START),
        existing.find(BOT_SECTION_END),
    ) {
        if end >= start {
            let after_end = end + BOT_SECTION_END.len();
            let suffix = existing[after_end..].trim_start_matches(['\r', '\n']);
            let prefix = existing[..start].trim_end_matches(['\r', '\n']);
            match (prefix.is_empty(), suffix.is_empty()) {
                (true, true) => section.to_owned(),
                (false, true) => format!("{prefix}\n\n{section}"),
                (true, false) => format!("{section}\n{suffix}"),
                (false, false) => format!("{prefix}\n\n{section}\n{suffix}"),
            }
        } else {
            format!("{existing}\n\n{section}")
        }
    } else if existing.trim().is_empty() {
        section.to_owned()
    } else {
        format!("{}\n\n{}", existing.trim_end(), section)
    };
    write_atomic_file(path, next.as_bytes())
}

fn load_or_init_state(daemon_home: &Path) -> BotsState {
    let root = bots_root(daemon_home);
    let _ = ensure_dir_private(&root);
    let registry_path = root.join("registry.json");
    let mut registry = fs::read_to_string(&registry_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<BotRegistryFile>(&raw).ok())
        .unwrap_or_else(|| BotRegistryFile {
            version: REGISTRY_VERSION,
            bots: Vec::new(),
        });

    if let Some(master) = registry
        .bots
        .iter_mut()
        .find(|bot| bot.id == MASTER_BOT_ID)
    {
        let mut migrated = false;
        if master.description == LEGACY_MASTER_DESC {
            master.description = DEFAULT_MASTER_DESC.into();
            migrated = true;
        }
        if master.system_prompt == LEGACY_MASTER_PROMPT {
            master.system_prompt = DEFAULT_MASTER_PROMPT.into();
            migrated = true;
        }
        if migrated {
            let _ = save_registry(daemon_home, &registry);
        }
    } else {
        registry.bots.insert(0, default_master_bot());
        let _ = save_registry(daemon_home, &registry);
    }

    let mut threads = HashMap::new();
    let mut memories = HashMap::new();
    let mut statuses = HashMap::new();
    for bot in &registry.bots {
        let _ = sync_bot_workspace_files(daemon_home, bot);
        let tpath = bot_threads_path(daemon_home, &bot.id);
        let tfile = fs::read_to_string(&tpath)
            .ok()
            .and_then(|raw| serde_json::from_str::<BotThreadsFile>(&raw).ok())
            .unwrap_or_default();
        threads.insert(bot.id.clone(), tfile);
        let mpath = bot_memory_index_path(daemon_home, &bot.id);
        let mfile = fs::read_to_string(&mpath)
            .ok()
            .and_then(|raw| serde_json::from_str::<BotMemoryIndexFile>(&raw).ok())
            .unwrap_or_default();
        memories.insert(bot.id.clone(), mfile);
        statuses.insert(
            bot.id.clone(),
            BotFeishuRuntimeStatus {
                state: if bot.feishu.enabled {
                    FeishuConnectionState::Connecting
                } else {
                    FeishuConnectionState::Disabled
                },
                ..Default::default()
            },
        );
    }

    BotsState {
        registry,
        threads,
        memories,
        statuses,
    }
}

fn build_public_bots(daemon_home: &Path, state: &BotsState) -> Vec<PublicBot> {
    let mut out: Vec<PublicBot> =
        state
            .registry
            .bots
            .iter()
            .map(|bot| {
                let workspace = bot
                    .custom_workspace
                    .clone()
                    .filter(|path| Path::new(path).is_dir())
                    .unwrap_or_else(|| {
                        bot_managed_workspace(daemon_home, &bot.id)
                            .to_string_lossy()
                            .into_owned()
                    });
                let threads = state
                    .threads
                    .get(&bot.id)
                    .map(|file| file.threads.clone())
                    .unwrap_or_default();
                let feishu_status = state.statuses.get(&bot.id).cloned().unwrap_or_else(|| {
                    BotFeishuRuntimeStatus {
                        state: if bot.feishu.enabled {
                            FeishuConnectionState::Connecting
                        } else {
                            FeishuConnectionState::Disabled
                        },
                        ..Default::default()
                    }
                });
                PublicBot {
                    id: bot.id.clone(),
                    kind: bot.kind,
                    name: bot.name.clone(),
                    avatar: bot.avatar.clone(),
                    description: bot.description.clone(),
                    system_prompt: bot.system_prompt.clone(),
                    agent: bot.agent,
                    account_id: bot.account_id.clone(),
                    model: bot.model.clone(),
                    effort: bot.effort.clone(),
                    source_binding: bot.source_binding.clone(),
                    workspace,
                    custom_workspace: bot.custom_workspace.clone(),
                    allow_cross_workspace: bot.allow_cross_workspace,
                    feishu: PublicBotFeishuConfig {
                        enabled: bot.feishu.enabled,
                        domain: bot.feishu.domain,
                        app_id: bot.feishu.app_id.clone(),
                        has_app_secret: !bot.feishu.app_secret.is_empty(),
                        group_trigger: bot.feishu.group_trigger,
                        streaming_card: bot.feishu.streaming_card,
                    },
                    feishu_status,
                    threads,
                    created_at: bot.created_at,
                    updated_at: bot.updated_at,
                }
            })
            .collect();
    out.sort_by(|a, b| match (a.kind, b.kind) {
        (BotKind::Master, BotKind::Sub) => std::cmp::Ordering::Less,
        (BotKind::Sub, BotKind::Master) => std::cmp::Ordering::Greater,
        _ => a.created_at.cmp(&b.created_at),
    });
    out
}

fn save_registry(daemon_home: &Path, registry: &BotRegistryFile) -> Result<()> {
    let root = bots_root(daemon_home);
    ensure_dir_private(&root)?;
    let bytes = serde_json::to_vec_pretty(registry)?;
    write_atomic_file(&root.join("registry.json"), &bytes)
}

fn save_threads(daemon_home: &Path, bot_id: &str, threads: &BotThreadsFile) -> Result<()> {
    let dir = bot_dir(daemon_home, bot_id);
    ensure_dir_private(&dir)?;
    let bytes = serde_json::to_vec_pretty(threads)?;
    write_atomic_file(&dir.join("threads.json"), &bytes)
}

fn ensure_dir_private(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn write_atomic_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        ensure_dir_private(parent)?;
    }
    let tmp = path.with_extension(format!("tmp-{}", Uuid::new_v4().simple()));
    let mut file = {
        #[cfg(unix)]
        {
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&tmp)?
        }
        #[cfg(not(unix))]
        {
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&tmp)?
        }
    };
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)?;
    Ok(())
}

fn clean_thread_title(raw: Option<&str>, channel: BotThreadChannel) -> String {
    if let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) {
        return truncate_chars(value, 60);
    }
    match channel {
        BotThreadChannel::Desktop => "新对话".into(),
        BotThreadChannel::FeishuP2p => "飞书私聊".into(),
        BotThreadChannel::FeishuGroup => "飞书群聊".into(),
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    let one_line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or(text.trim());
    let mut chars = one_line.chars();
    let collected: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{collected}…")
    } else {
        collected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn master_bot_is_seeded_and_feishu_disabled_by_default() {
        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().to_path_buf()).await.unwrap();
        let agents = Agents::new(db.clone());
        let supervisor = BotsSupervisor::new(db.clone(), agents.clone());

        let bots = supervisor.list_public().await;
        assert_eq!(bots.len(), 1);
        let master = &bots[0];
        assert_eq!(master.id, MASTER_BOT_ID);
        assert_eq!(master.kind, BotKind::Master);
        assert!(master.allow_cross_workspace);
        assert!(!master.feishu.enabled);
        assert_eq!(master.feishu_status.state, FeishuConnectionState::Disabled);
        assert!(Path::new(&master.workspace).join("AGENTS.md").is_file());
        assert!(Path::new(&master.workspace).join("CLAUDE.md").is_file());
        assert!(Path::new(&master.workspace).join("MEMORY.md").is_file());

        agents.shutdown().await.unwrap();
        db.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn create_update_memory_thread_and_delete_sub_bot() {
        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().to_path_buf()).await.unwrap();
        let agents = Agents::new(db.clone());
        let supervisor = BotsSupervisor::new(db.clone(), agents.clone());

        let created = supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "req-1".into(),
                action: BotAction::Create {
                    input: BotUpsertInput {
                        name: "调研助理".into(),
                        avatar: "🔍".into(),
                        description: "负责信息搜集与周报整理".into(),
                        system_prompt: "始终给出带引用来源的结构化结论。".into(),
                        agent: AgentKind::Claude,
                        account_id: None,
                        model: Some("claude-sonnet-4-5".into()),
                        effort: None,
                        source_binding: None,
                        custom_workspace: None,
                        allow_cross_workspace: false,
                        feishu: Some(BotFeishuInput {
                            enabled: false,
                            domain: FeishuDomain::Feishu,
                            app_id: "cli_abc".into(),
                            app_secret: Some("secret_xyz".into()),
                            group_trigger: FeishuGroupTrigger::Mention,
                            streaming_card: true,
                        }),
                    },
                },
            })
            .await
            .unwrap();

        let sub = created.bot.unwrap();
        assert_eq!(sub.kind, BotKind::Sub);
        assert!(sub.feishu.has_app_secret);
        assert!(!sub.allow_cross_workspace);

        // Write and read MEMORY.md
        supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "req-mem".into(),
                action: BotAction::MemoryWrite {
                    bot_id: sub.id.clone(),
                    content: "# 记忆\n- 偏好中文简报\n".into(),
                },
            })
            .await
            .unwrap();
        let mem = supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "req-mem2".into(),
                action: BotAction::MemoryRead {
                    bot_id: sub.id.clone(),
                },
            })
            .await
            .unwrap();
        assert!(mem.memory.unwrap().content.contains("偏好中文简报"));

        // Updating bot preserves MEMORY.md & app_secret when app_secret is omitted.
        let updated = supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "req-upd".into(),
                action: BotAction::Update {
                    bot_id: sub.id.clone(),
                    input: BotUpsertInput {
                        name: "飞书研报Bot".into(),
                        avatar: "📊".into(),
                        description: "更新后的说明".into(),
                        system_prompt: "新的人设指令".into(),
                        agent: AgentKind::Codex,
                        account_id: None,
                        model: Some("gpt-5.4".into()),
                        effort: Some("medium".into()),
                        source_binding: None,
                        custom_workspace: None,
                        allow_cross_workspace: true,
                        feishu: Some(BotFeishuInput {
                            enabled: false,
                            domain: FeishuDomain::Feishu,
                            app_id: "cli_abc".into(),
                            app_secret: None,
                            group_trigger: FeishuGroupTrigger::All,
                            streaming_card: true,
                        }),
                    },
                },
            })
            .await
            .unwrap()
            .bot
            .unwrap();
        assert!(updated.feishu.has_app_secret);
        assert!(
            fs::read_to_string(Path::new(&updated.workspace).join("MEMORY.md"))
                .unwrap()
                .contains("偏好中文简报")
        );
        assert!(
            fs::read_to_string(Path::new(&updated.workspace).join("AGENTS.md"))
                .unwrap()
                .contains("新的人设指令")
        );

        // Create and archive thread
        let thr = supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "req-thr".into(),
                action: BotAction::ThreadCreate {
                    bot_id: sub.id.clone(),
                    title: Some("Q4 竞品分析".into()),
                },
            })
            .await
            .unwrap()
            .thread
            .unwrap();
        assert_eq!(thr.title, "Q4 竞品分析");

        let archived = supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "req-arch".into(),
                action: BotAction::ThreadArchive {
                    bot_id: sub.id.clone(),
                    thread_id: thr.id.clone(),
                },
            })
            .await
            .unwrap();
        assert!(
            archived
                .bots
                .unwrap()
                .iter()
                .find(|b| b.id == sub.id)
                .unwrap()
                .threads
                .is_empty()
        );

        // Cannot delete master
        assert!(
            supervisor
                .handle_action(BotActionRequest {
                    kind: "bot.action".into(),
                    request_id: "req-del-master".into(),
                    action: BotAction::Delete {
                        bot_id: MASTER_BOT_ID.into()
                    },
                })
                .await
                .is_err()
        );

        // Delete sub-bot
        let after_del = supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "req-del".into(),
                action: BotAction::Delete {
                    bot_id: sub.id.clone(),
                },
            })
            .await
            .unwrap()
            .bots
            .unwrap();
        assert_eq!(after_del.len(), 1);

        agents.shutdown().await.unwrap();
        db.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn layered_scoped_memories_are_isolated_and_discoverable() {
        let dir = tempdir().unwrap();
        let db = Database::open(dir.path().to_path_buf()).await.unwrap();
        let agents = Agents::new(db.clone());
        let supervisor = BotsSupervisor::new(db.clone(), agents.clone());

        let created = supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "req-mem-bot".into(),
                action: BotAction::Create {
                    input: BotUpsertInput {
                        name: "飞书助手".into(),
                        avatar: "🤖".into(),
                        description: "分层记忆测试".into(),
                        system_prompt: "保持回复清晰".into(),
                        agent: AgentKind::Codex,
                        account_id: None,
                        model: None,
                        effort: None,
                        source_binding: None,
                        custom_workspace: None,
                        allow_cross_workspace: false,
                        feishu: Some(BotFeishuInput {
                            enabled: false,
                            domain: FeishuDomain::Feishu,
                            app_id: "cli_mem".into(),
                            app_secret: Some("sec_mem".into()),
                            group_trigger: FeishuGroupTrigger::All,
                            streaming_card: true,
                        }),
                    },
                },
            })
            .await
            .unwrap()
            .bot
            .unwrap();

        // Populate global + group A + group B + user Alice + user Bob + member(A,Alice) + member(B,Alice)
        for (req_id, key, label, content) in [
            ("w-global", "global", None, "全局习惯：始终用中文回答。"),
            ("w-chat-a", "chat:oc_group_a", Some("研发群"), "A群规范：每天18点发日报。"),
            ("w-chat-b", "chat:oc_group_b", Some("市场群"), "B群机密：仅B群可见。"),
            ("w-user-a", "user:ou_alice", Some("Alice"), "Alice偏好：先给结论再展开。"),
            ("w-user-b", "user:ou_bob", Some("Bob"), "Bob隐私：仅Bob可见。"),
            (
                "w-mem-a",
                "member:oc_group_a:ou_alice",
                None,
                "Alice在A群角色：后端负责人。",
            ),
            (
                "w-mem-b",
                "member:oc_group_b:ou_alice",
                None,
                "Alice在B群角色：外部评审。",
            ),
        ] {
            supervisor
                .handle_action(BotActionRequest {
                    kind: "bot.action".into(),
                    request_id: req_id.into(),
                    action: BotAction::MemoryEntryWrite {
                        bot_id: created.id.clone(),
                        key: key.into(),
                        content: content.into(),
                        label: label.map(str::to_owned),
                        chat_id: None,
                        chat_name: None,
                        user_id: None,
                        user_name: None,
                    },
                })
                .await
                .unwrap();
        }

        // Turn in Group A for Alice: receives global + chat A + user Alice + member(A,Alice), NO leakage from B or Bob.
        let group_turn = supervisor
            .prepare_feishu_memory_turn(FeishuMemoryTurnInput {
                bot_id: created.id.clone(),
                chat_id: "oc_group_a".into(),
                is_group: true,
                chat_name: Some("核心研发群".into()),
                sender_open_id: Some("ou_alice".into()),
                sender_name: Some("Alice Wang".into()),
                user_prompt: "请总结今天的发布进展".into(),
            })
            .await
            .unwrap();
        assert!(group_turn.thread_title_hint.starts_with("核心研发群 · "));
        assert!(!group_turn.thread_title_hint.contains("<prospero_memory_context>"));
        assert!(group_turn.augmented_prompt.contains("<prospero_memory_context>"));
        assert!(group_turn.augmented_prompt.contains("全局习惯：始终用中文回答"));
        assert!(group_turn.augmented_prompt.contains("A群规范：每天18点发日报"));
        assert!(group_turn.augmented_prompt.contains("Alice偏好：先给结论再展开"));
        assert!(group_turn.augmented_prompt.contains("Alice在A群角色：后端负责人"));
        assert!(!group_turn.augmented_prompt.contains("B群机密"));
        assert!(!group_turn.augmented_prompt.contains("Bob隐私"));
        assert!(!group_turn.augmented_prompt.contains("Alice在B群角色"));

        // P2P turn for Alice: receives global + user Alice only (no group/member memory).
        let p2p_turn = supervisor
            .prepare_feishu_memory_turn(FeishuMemoryTurnInput {
                bot_id: created.id.clone(),
                chat_id: "oc_p2p_alice".into(),
                is_group: false,
                chat_name: None,
                sender_open_id: Some("ou_alice".into()),
                sender_name: Some("Alice Wang".into()),
                user_prompt: "帮我安排明天的日程".into(),
            })
            .await
            .unwrap();
        assert!(p2p_turn.thread_title_hint.starts_with("Alice Wang · "));
        assert!(p2p_turn.augmented_prompt.contains("全局习惯：始终用中文回答"));
        assert!(p2p_turn.augmented_prompt.contains("Alice偏好：先给结论再展开"));
        assert!(!p2p_turn.augmented_prompt.contains("A群规范"));
        assert!(!p2p_turn.augmented_prompt.contains("B群机密"));
        assert!(!p2p_turn.augmented_prompt.contains("Bob隐私"));
        assert!(!p2p_turn.augmented_prompt.contains("Alice在A群角色"));

        // Discover disk-created scoped .md file automatically in memory.list.
        let disk_chat_path = Path::new(&created.workspace)
            .join("memory")
            .join("chats")
            .join("oc_disk_chat.md");
        fs::create_dir_all(disk_chat_path.parent().unwrap()).unwrap();
        fs::write(&disk_chat_path, "Agent自主写入的磁盘群记忆").unwrap();

        let listed = supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "r-list".into(),
                action: BotAction::MemoryList {
                    bot_id: created.id.clone(),
                },
            })
            .await
            .unwrap()
            .memories
            .unwrap();
        assert!(listed.iter().any(|e| e.key == "chat:oc_disk_chat" && e.has_content));
        let group_a_entry = listed.iter().find(|e| e.key == "chat:oc_group_a").unwrap();
        assert_eq!(group_a_entry.label, "研发群");
        assert_eq!(group_a_entry.chat_name.as_deref(), Some("核心研发群"));
        let member_a_entry = listed
            .iter()
            .find(|e| e.key == "member:oc_group_a:ou_alice")
            .unwrap();
        assert_eq!(member_a_entry.label, "核心研发群 · Alice Wang");

        // Delete a non-global entry removes it from list & disk.
        let after_del = supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "r-del".into(),
                action: BotAction::MemoryEntryDelete {
                    bot_id: created.id.clone(),
                    key: "chat:oc_group_b".into(),
                },
            })
            .await
            .unwrap()
            .memories
            .unwrap();
        assert!(!after_del.iter().any(|e| e.key == "chat:oc_group_b"));

        let read_entry = supervisor
            .handle_action(BotActionRequest {
                kind: "bot.action".into(),
                request_id: "r-read".into(),
                action: BotAction::MemoryEntryRead {
                    bot_id: created.id.clone(),
                    key: "member:oc_group_a:ou_alice".into(),
                },
            })
            .await
            .unwrap()
            .memory
            .unwrap();
        assert_eq!(read_entry.scope, BotMemoryScope::Member);
        assert!(read_entry.content.contains("Alice在A群角色"));

        agents.shutdown().await.unwrap();
        db.shutdown().await.unwrap();
    }
}
