mod platform;
mod preferences;
mod remote;
mod service;
mod theme;
mod updater;

use iced::futures::SinkExt;
use iced::widget::{
    button, checkbox, column, container, markdown, qr_code, row, rule, scrollable, text,
    text_editor, text_input,
};
use iced::{Alignment, Element, Fill, Size, Subscription, Task, Theme, window};
use prospero_client::{
    Client, DecodedFsContent, DecodedTerminalEvent, DecodedTerminalPage, DecodedTerminalSnapshot,
    default_daemon_home,
};
use prospero_protocol_rs::{
    AccountView, AgentKind, AgentModeCatalogView, AgentModelCatalogView, AgentQueueView, AgentSend,
    AgentSessionCreate, ApplyTaskGraphView, AttachmentInput, CreateRunGraphView, CreateTerminal,
    DeviceView, FsEntry, GitHistoryEntry, GitStatusResult, GraphNodeInputView, Health, MessageRole,
    ModelSourceView, PairingCreate, PermissionDecision, PluginServiceList, PluginServiceStatus,
    PublicPluginDiscoveryResult, QuestionAnswer, QuestionDecision, RelayUpdate, RelayView,
    ResumableConversation, ResumeInput, Run, RunSnapshot, ScheduleCreateRequest,
    ScheduleUpdateRequest, ScheduledAgentTask, ScheduledAgentTaskStatus, SessionHead, SessionKind,
    SessionLifecycle, SessionPage, SessionQuery, SessionStatus, SkillView, TaskStatus,
    TerminalQuery, TerminalSize, TimelineBody, TimelineQuery, TimelineRecord, UsageResultView,
    WorktreeAsset, WorktreeAssetState,
};
use prospero_terminal_view::TerminalModel;
use theme::Mode;

fn main() -> iced::Result {
    if let Some(command) = service::requested_command() {
        match service::run(command) {
            Ok(output) => println!("{output}"),
            Err(error) => {
                eprintln!("prospero service command failed: {error}");
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    if std::env::args()
        .any(|argument| matches!(argument.as_str(), "--self-check" | "--self-check-full"))
    {
        return self_check();
    }
    iced::application(Desktop::boot, Desktop::update, Desktop::view)
        .title("Prospero")
        .window(window_settings())
        .theme(Desktop::theme)
        .style(Desktop::style)
        .subscription(Desktop::subscription)
        .run()
}

fn window_settings() -> window::Settings {
    window::Settings {
        size: Size::new(1280.0, 860.0),
        min_size: Some(Size::new(700.0, 600.0)),
        transparent: false,
        blur: cfg!(target_os = "linux"),
        #[cfg(target_os = "macos")]
        platform_specific: window::settings::PlatformSpecific {
            title_hidden: true,
            titlebar_transparent: true,
            fullsize_content_view: true,
        },
        ..Default::default()
    }
}

fn self_check() -> iced::Result {
    let executor = match tokio::runtime::Runtime::new() {
        Ok(executor) => executor,
        Err(error) => {
            eprintln!("prospero-desktop self-check failed: {error}");
            std::process::exit(1);
        }
    };
    let runtime = executor.block_on(async {
        let home = default_daemon_home();
        let client = Client::from_home(&home).map_err(|error| error.to_string())?;
        let pid = client.pid();
        let health = client.health().await.map_err(|error| error.to_string())?;
        let page = client
            .sessions(SessionQuery {
                limit: Some(100),
                ..Default::default()
            })
            .await
            .map_err(|error| error.to_string())?;
        let management = if std::env::args().any(|argument| argument == "--self-check-full") {
            Some((load_management().await?, load_remote().await?))
        } else {
            None
        };
        Ok::<_, String>((home, pid, health, page, management))
    });
    match runtime {
        Ok((home, pid, health, page, management)) => {
            println!(
                "{{\"ok\":true,\"home\":{},\"pid\":{},\"apiVersion\":{},\"backend\":{},\"sessions\":{},\"hasMore\":{},\"management\":{}}}",
                json_string(&home.display().to_string()),
                pid,
                health.api_version,
                json_string(&health.backend),
                page.items.len(),
                page.has_more,
                management.as_ref().map_or_else(
                    || "null".to_owned(),
                    |(value, remote)| format!(
                        "{{\"schedules\":{},\"plugins\":{},\"services\":{},\"accounts\":{},\"sources\":{},\"devices\":{},\"relay\":{}}}",
                        value.schedules.len(), value.plugins.items.len(),
                        value.plugin_services.items.len(), value.accounts.len(), value.sources.len(),
                        remote.devices.len(), json_string(&format!("{:?}", remote.relay.runtime.state)),
                    ),
                )
            );
            Ok(())
        }
        Err(error) => {
            eprintln!("prospero-desktop self-check failed: {error}");
            std::process::exit(1);
        }
    }
}

fn json_string(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() + 2);
    encoded.push('"');
    for character in value.chars() {
        match character {
            '\\' => encoded.push_str("\\\\"),
            '"' => encoded.push_str("\\\""),
            '\n' => encoded.push_str("\\n"),
            '\r' => encoded.push_str("\\r"),
            '\t' => encoded.push_str("\\t"),
            value if value.is_control() => {
                use std::fmt::Write;
                let _ = write!(encoded, "\\u{:04x}", value as u32);
            }
            value => encoded.push(value),
        }
    }
    encoded.push('"');
    encoded
}

#[derive(Debug)]
struct Desktop {
    mode: Mode,
    status: LoadState,
    sessions: Vec<SessionHead>,
    health: Option<Health>,
    selected_session: Option<String>,
    timeline: Vec<TimelineEntry>,
    timeline_loading: bool,
    timeline_error: Option<String>,
    material: platform::MaterialStatus,
    theme_override: bool,
    terminal: Option<TerminalState>,
    chat_input: String,
    chat_attachments: Vec<AttachmentInput>,
    chat_error: Option<String>,
    project: Option<ProjectState>,
    page: Page,
    orchestration: OrchestrationState,
    management: ManagementState,
    remote: RemoteState,
    operations: OperationsState,
    preferences: preferences::Preferences,
    update: UpdateState,
    session_search: String,
    session_lifecycle: Option<SessionLifecycle>,
    session_next_cursor: Option<String>,
    session_has_more: bool,
    session_total: i64,
    session_loading: bool,
    session_error: Option<String>,
    local_archive_view: bool,
    create_session: Option<CreateSessionState>,
    pending_session_close: bool,
    agent_controls: Option<AgentControlsState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Page {
    Workspaces,
    Orchestration,
    Schedules,
    Accounts,
    Remote,
    Operations,
}

#[derive(Debug, Default)]
struct OrchestrationState {
    runs: Vec<Run>,
    selected_run: Option<String>,
    snapshot: Option<RunSnapshot>,
    worktrees: Vec<WorktreeAsset>,
    run_form: Option<RunForm>,
    task_form: Option<TaskForm>,
    pending_task_delete: Option<(String, String)>,
    pending_worktree_cleanup: Option<String>,
    loading: bool,
    error: Option<String>,
}

#[derive(Debug, Default)]
struct OperationsState {
    workspace: String,
    skills: Vec<SkillView>,
    usage: Option<UsageResultView>,
    diagnostics: String,
    loading: bool,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct RunForm {
    objective: String,
    task_lines: String,
    skills: String,
}

impl Default for RunForm {
    fn default() -> Self {
        Self {
            objective: String::new(),
            task_lines: "分析需求\n实现功能\n验证与交付".into(),
            skills: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct TaskForm {
    id: Option<String>,
    title: String,
    spec: String,
    skills: String,
    deps: String,
}

#[derive(Debug)]
struct ManagementState {
    schedules: Vec<ScheduledAgentTask>,
    plugins: PublicPluginDiscoveryResult,
    plugin_services: PluginServiceList,
    accounts: Vec<AccountView>,
    sources: Vec<ModelSourceView>,
    loading: bool,
    error: Option<String>,
    schedule_form: Option<ScheduleForm>,
    pending_schedule_delete: Option<(String, String)>,
    account_form: Option<AccountForm>,
    pending_account_action: Option<(String, String, String)>,
    source_form: Option<ModelSourceForm>,
    pending_source_delete: Option<(String, String, i64)>,
}

impl Default for ManagementState {
    fn default() -> Self {
        Self {
            schedules: Vec::new(),
            plugins: PublicPluginDiscoveryResult {
                items: Vec::new(),
                errors: Vec::new(),
            },
            plugin_services: PluginServiceList {
                items: Vec::new(),
                errors: Vec::new(),
            },
            accounts: Vec::new(),
            sources: Vec::new(),
            loading: false,
            error: None,
            schedule_form: None,
            pending_schedule_delete: None,
            account_form: None,
            pending_account_action: None,
            source_form: None,
            pending_source_delete: None,
        }
    }
}

#[derive(Debug, Clone)]
struct AccountForm {
    id: Option<String>,
    name: String,
    agent: AgentKind,
    api: bool,
    base_url: String,
    model: String,
    api_key: String,
}

#[derive(Debug, Clone)]
struct ModelSourceForm {
    name: String,
    protocol: String,
    base_url: String,
    credential_name: String,
    api_key: String,
    route_name: String,
    model: String,
}

impl Default for ModelSourceForm {
    fn default() -> Self {
        Self {
            name: String::new(),
            protocol: "anthropic".into(),
            base_url: "https://api.anthropic.com".into(),
            credential_name: "Default".into(),
            api_key: String::new(),
            route_name: String::new(),
            model: String::new(),
        }
    }
}

impl Default for AccountForm {
    fn default() -> Self {
        Self {
            id: None,
            name: String::new(),
            agent: AgentKind::Claude,
            api: false,
            base_url: "https://api.anthropic.com".into(),
            model: String::new(),
            api_key: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct ScheduleForm {
    id: Option<String>,
    name: String,
    prompt: String,
    rrule: String,
    cwd: String,
    agent: AgentKind,
}

impl Default for ScheduleForm {
    fn default() -> Self {
        Self {
            id: None,
            name: String::new(),
            prompt: String::new(),
            rrule: "FREQ=DAILY;INTERVAL=1".into(),
            cwd: std::env::current_dir()
                .ok()
                .and_then(|path| path.to_str().map(str::to_owned))
                .unwrap_or_default(),
            agent: AgentKind::Claude,
        }
    }
}

impl From<&ScheduledAgentTask> for ScheduleForm {
    fn from(schedule: &ScheduledAgentTask) -> Self {
        Self {
            id: Some(schedule.id.clone()),
            name: schedule.name.clone(),
            prompt: schedule.prompt.clone(),
            rrule: schedule.rrule.clone(),
            cwd: schedule.cwd.clone(),
            agent: schedule.agent,
        }
    }
}

#[derive(Debug)]
struct RemoteState {
    devices: Vec<DeviceView>,
    relay: Option<RelayView>,
    pairing_name: String,
    allow_shell: bool,
    allow_orchestration: bool,
    relay_url: String,
    pairing_uri: Option<String>,
    pairing_qr: Option<qr_code::Data>,
    pending_revoke: Option<DeviceView>,
    pending_rotate: bool,
    hosts: Vec<remote::RemoteHost>,
    import_value: String,
    selected_host: Option<String>,
    connection: String,
    transport: Option<String>,
    workspace_roots: bool,
    command_sender: Option<iced::futures::channel::mpsc::Sender<remote::Command>>,
    sessions: Vec<remote::RemoteSession>,
    workspaces: Vec<remote::RemoteWorkspace>,
    listing: Option<remote::WorkspaceListing>,
    shell_cwd: String,
    terminal: Option<RemoteTerminalState>,
    chat: Option<RemoteChatState>,
    pending_workspace_open: Option<(String, bool)>,
    pending_host_remove: Option<remote::RemoteHost>,
    loading: bool,
    error: Option<String>,
}

#[derive(Debug)]
struct RemoteTerminalState {
    session_id: String,
    model: TerminalModel,
    seq: i64,
    input: String,
}

#[derive(Debug)]
struct RemoteChatState {
    session_id: String,
    events: Vec<serde_json::Value>,
    seq: i64,
    input: String,
    attachments: Vec<AttachmentInput>,
}

#[derive(Debug, Clone)]
struct CreateSessionState {
    title: String,
    workspace: String,
    agent: AgentKind,
    kind: SessionKind,
    resume_query: String,
    resume_results: Vec<ResumableConversation>,
    selected_resume: Option<ResumableConversation>,
    resume_loading: bool,
    error: Option<String>,
}

#[derive(Debug, Clone)]
struct AgentControlsState {
    session_id: String,
    modes: Option<AgentModeCatalogView>,
    models: Option<AgentModelCatalogView>,
    queue: AgentQueueView,
    approval_policy: String,
    error: Option<String>,
}

impl Default for CreateSessionState {
    fn default() -> Self {
        Self {
            title: String::new(),
            workspace: std::env::current_dir()
                .ok()
                .and_then(|path| path.to_str().map(str::to_owned))
                .unwrap_or_default(),
            agent: AgentKind::Claude,
            kind: SessionKind::Structured,
            resume_query: String::new(),
            resume_results: Vec::new(),
            selected_resume: None,
            resume_loading: false,
            error: None,
        }
    }
}

impl Default for RemoteState {
    fn default() -> Self {
        Self {
            devices: Vec::new(),
            relay: None,
            pairing_name: "iPhone".into(),
            allow_shell: true,
            allow_orchestration: true,
            relay_url: String::new(),
            pairing_uri: None,
            pairing_qr: None,
            pending_revoke: None,
            pending_rotate: false,
            hosts: Vec::new(),
            import_value: String::new(),
            selected_host: None,
            connection: "offline".into(),
            transport: None,
            workspace_roots: false,
            command_sender: None,
            sessions: Vec::new(),
            workspaces: Vec::new(),
            listing: None,
            shell_cwd: String::new(),
            terminal: None,
            chat: None,
            pending_workspace_open: None,
            pending_host_remove: None,
            loading: false,
            error: None,
        }
    }
}

#[derive(Debug, Clone)]
struct TimelineEntry {
    record: TimelineRecord,
    text: String,
    markdown: Vec<markdown::Item>,
}

#[derive(Debug)]
struct TerminalState {
    session_id: String,
    model: TerminalModel,
    seq: i64,
    exited: bool,
    exit_code: Option<u32>,
    input: String,
    error: Option<String>,
}

struct ProjectState {
    entries: Vec<FsEntry>,
    git: Option<GitStatusResult>,
    history: Vec<GitHistoryEntry>,
    selected_path: Option<String>,
    preview: Option<DecodedFsContent>,
    draft: text_editor::Content,
    editing: bool,
    diff: Option<String>,
    commit_message: String,
    pending_discard: Option<String>,
    loading: bool,
    error: Option<String>,
}

impl Default for ProjectState {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            git: None,
            history: Vec::new(),
            selected_path: None,
            preview: None,
            draft: text_editor::Content::new(),
            editing: false,
            diff: None,
            commit_message: String::new(),
            pending_discard: None,
            loading: false,
            error: None,
        }
    }
}

impl std::fmt::Debug for ProjectState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProjectState")
            .field("entries", &self.entries.len())
            .field("selected_path", &self.selected_path)
            .field("loading", &self.loading)
            .field("error", &self.error)
            .finish()
    }
}

type ProjectLoadResult =
    Result<(String, Vec<FsEntry>, GitStatusResult, Vec<GitHistoryEntry>), String>;
type ConversationLoadResult = Result<(AgentKind, String, Vec<ResumableConversation>), String>;

#[derive(Debug, Clone)]
enum LoadState {
    Loading,
    Ready,
    Failed(String),
}

#[derive(Debug, Clone, Default)]
enum UpdateState {
    #[default]
    Checking,
    Current,
    Available(updater::Release),
    Downloading(updater::Release),
    Downloaded(String),
    Failed(String),
    Dismissed,
}

#[derive(Debug, Clone)]
enum Message {
    Loaded(Box<Result<(Health, SessionPage), String>>),
    Reload,
    ToggleTheme,
    MaterialApplied(platform::MaterialStatus),
    WindowClosed,
    Capture,
    CapturedMaybe(Option<window::Screenshot>),
    ScreenshotSaved(Result<String, String>),
    SelectSession(String),
    TimelineLoaded(Box<Result<(String, Vec<TimelineEntry>), String>>),
    BackToSessions,
    SystemThemeChanged(iced::theme::Mode),
    LinkClicked(markdown::Uri),
    TerminalLoaded(Box<Result<(String, DecodedTerminalSnapshot), String>>),
    TerminalPolled(Box<Result<(String, DecodedTerminalPage), String>>),
    TerminalInputChanged(String),
    TerminalSubmit,
    TerminalInputSent(Result<String, String>),
    ChatInputChanged(String),
    ChatAttach,
    ChatAttached(Result<Vec<AttachmentInput>, String>),
    ChatRemoveAttachment(usize),
    ChatSubmit,
    ChatSent(Result<String, String>),
    RefreshTimeline,
    PermissionRespond {
        request_id: String,
        allow: bool,
    },
    QuestionRespond {
        request_id: String,
        question_id: String,
        value: String,
    },
    InteractionSent(Result<String, String>),
    ProjectLoaded(Box<ProjectLoadResult>),
    ProjectFileSelected(String),
    ProjectFileLoaded(Box<Result<(String, DecodedFsContent), String>>),
    ProjectToggleEdit,
    ProjectEdit(text_editor::Action),
    ProjectSave,
    ProjectSaved(Box<Result<(String, DecodedFsContent), String>>),
    ProjectDiffSelected {
        path: String,
        staged: bool,
    },
    ProjectDiffLoaded(Box<Result<(String, String), String>>),
    GitStage {
        paths: Vec<String>,
        unstage: bool,
    },
    GitDiscardRequest(String),
    GitDiscardConfirm,
    GitDiscardCancel,
    GitCommitInputChanged(String),
    GitCommit,
    ProjectMutationFinished(Result<String, String>),
    Navigate(Page),
    RunsLoaded(Box<Result<Vec<Run>, String>>),
    SelectRun(String),
    RunLoaded(Box<Result<(RunSnapshot, Vec<WorktreeAsset>), String>>),
    RunCreateOpen,
    RunFormCancel,
    RunObjectiveChanged(String),
    RunTaskLinesChanged(String),
    RunSkillsChanged(String),
    RunCreateSubmit,
    RunGraphMutated(Box<Result<String, String>>),
    TaskCreateOpen,
    TaskEditOpen(String),
    TaskFormCancel,
    TaskTitleChanged(String),
    TaskSpecChanged(String),
    TaskSkillsChanged(String),
    TaskDepsChanged(String),
    TaskSave,
    TaskDeleteRequest {
        id: String,
        title: String,
    },
    TaskDeleteConfirm,
    TaskDeleteCancel,
    WorktreeInspect(String),
    WorktreeCleanupRequest(String),
    WorktreeCleanupConfirm,
    WorktreeCleanupCancel,
    WorktreeMutated(Box<Result<String, String>>),
    OperationsWorkspaceChanged(String),
    OperationsRefresh,
    OperationsLoaded(Box<Result<OperationsSnapshot, String>>),
    ServiceInstall,
    ServiceStart,
    ServiceActionFinished(Result<String, String>),
    PauseAutomation(String),
    RetryTask {
        run_id: String,
        task_id: String,
    },
    CancelTask {
        run_id: String,
        task_id: String,
    },
    ResolveGate {
        run_id: String,
        gate_id: String,
        decision: String,
    },
    OrchestrationMutated(Result<String, String>),
    ManagementLoaded(Box<Result<ManagementSnapshot, String>>),
    SchedulePause(String),
    ScheduleResume(String),
    ScheduleRun(String),
    ScheduleMutated(Result<(), String>),
    ScheduleCreateOpen,
    ScheduleEditOpen(Box<ScheduledAgentTask>),
    ScheduleFormCancel,
    ScheduleNameChanged(String),
    SchedulePromptChanged(String),
    ScheduleRruleChanged(String),
    ScheduleCwdChanged(String),
    ScheduleAgentChanged(AgentKind),
    ScheduleSave,
    ScheduleDeleteRequest {
        id: String,
        name: String,
    },
    ScheduleDeleteConfirm,
    ScheduleDeleteCancel,
    AccountCreateOpen {
        api: bool,
    },
    AccountEditOpen(Box<AccountView>),
    AccountFormCancel,
    AccountNameChanged(String),
    AccountAgentChanged(AgentKind),
    AccountBaseUrlChanged(String),
    AccountModelChanged(String),
    AccountApiKeyChanged(String),
    AccountSave,
    AccountSetDefault(String),
    AccountLogin(String),
    AccountActionRequest {
        id: String,
        name: String,
        action: String,
    },
    AccountActionConfirm,
    AccountActionCancel,
    AccountMutated(Box<Result<AccountMutation, String>>),
    SourceCreateOpen,
    SourceFormCancel,
    SourceNameChanged(String),
    SourceProtocolChanged(String),
    SourceBaseUrlChanged(String),
    SourceCredentialNameChanged(String),
    SourceApiKeyChanged(String),
    SourceRouteNameChanged(String),
    SourceModelChanged(String),
    SourceCreateSubmit,
    SourceToggle {
        id: String,
        revision: i64,
        enabled: bool,
    },
    SourceBind {
        id: String,
        route_id: String,
        revision: i64,
    },
    SourceDeleteRequest {
        id: String,
        name: String,
        revision: i64,
    },
    SourceDeleteConfirm,
    SourceDeleteCancel,
    SourceMutated(Box<Result<ModelSourceMutation, String>>),
    PluginAction {
        plugin: String,
        service: String,
        action: String,
    },
    PluginMutated(Result<(), String>),
    RemoteLoaded(Box<Result<RemoteSnapshot, String>>),
    PairingNameChanged(String),
    PairingShellChanged(bool),
    PairingOrchestrationChanged(bool),
    PairingCreate,
    PairingCreated(Box<Result<(Vec<DeviceView>, String), String>>),
    PairingDismiss,
    DeviceRevokeRequest(DeviceView),
    DeviceRevokeConfirm,
    DeviceRevokeCancel,
    DeviceRevoked(Result<(), String>),
    RelayUrlChanged(String),
    RelayEnable,
    RelayDisable,
    RelayRotateRequest,
    RelayRotateConfirm,
    RelayRotateCancel,
    RelayMutated(Box<Result<RelayView, String>>),
    RemoteHostsLoaded(Result<Vec<remote::RemoteHost>, String>),
    RemoteWorkspacesLoaded(Result<Vec<remote::RemoteWorkspace>, String>),
    RemoteImportChanged(String),
    RemoteImport,
    RemoteImported(Result<remote::RemoteHost, String>),
    RemoteConnect(String),
    RemoteDisconnect,
    RemoteHostRemoveRequest(remote::RemoteHost),
    RemoteHostRemoveConfirm,
    RemoteHostRemoveCancel,
    RemoteHostRemoved(Result<String, String>),
    RemoteShellCwdChanged(String),
    RemoteBrowseHome,
    RemoteBrowseComputer,
    RemoteBrowseEnter(String),
    RemoteBrowseUp,
    RemoteWorkspaceUse,
    RemoteWorkspaceSaved(Result<Vec<remote::RemoteWorkspace>, String>),
    RemoteWorkspaceOpen {
        id: String,
        fresh: bool,
    },
    RemoteWorkspaceRemove(String),
    RemoteShellCreate,
    RemoteAgentCreate(AgentKind),
    RemoteSessionSelect(String),
    RemoteTerminalInputChanged(String),
    RemoteTerminalSubmit,
    RemoteTerminalResize(u16, u16),
    RemoteChatInputChanged(String),
    RemoteChatAttach,
    RemoteChatAttached(Result<Vec<AttachmentInput>, String>),
    RemoteChatRemoveAttachment(usize),
    RemoteChatSubmit,
    RemoteChatInterrupt,
    RemotePermission {
        request_id: String,
        reply: String,
    },
    RemoteQuestion {
        request_id: String,
        question_id: String,
        value: String,
    },
    RemoteSessionKill(String),
    RemoteCommandSent(Result<(), String>),
    RemoteEvent(remote::Event),
    UpdateChecked(Result<Option<updater::Release>, String>),
    UpdateDownload,
    UpdateDismiss,
    UpdateDownloaded(Result<String, String>),
    SessionSearchChanged(String),
    SessionLifecycleChanged(Option<SessionLifecycle>),
    SessionLoadMore,
    SessionPageLoaded(Box<Result<SessionLoad, String>>),
    SessionArchiveToggle(String),
    SessionLocalArchive,
    SessionLocalArchiveLoaded(Box<Result<Vec<SessionHead>, String>>),
    SessionCreateOpen,
    SessionCreateCancel,
    SessionTitleChanged(String),
    SessionWorkspaceChanged(String),
    SessionAgentChanged(AgentKind),
    SessionKindChanged(SessionKind),
    SessionResumeQueryChanged(String),
    SessionResumeSearch,
    SessionResumeLoaded(Box<ConversationLoadResult>),
    SessionResumeSelected(String),
    SessionCreateSubmit,
    SessionCreated(Result<SessionHead, String>),
    SessionClose,
    SessionCloseConfirm,
    SessionCloseCancel,
    SessionClosed(Result<(), String>),
    AgentControlsLoaded(Box<Result<AgentControlsState, String>>),
    AgentSetMode(String),
    AgentSetModel(String),
    AgentSetEffort(String),
    AgentSetApproval(String),
    AgentCompact,
    AgentQueueAction {
        id: String,
        action: String,
    },
    AgentControlMutated(Result<String, String>),
}

#[derive(Debug, Clone)]
struct ManagementSnapshot {
    schedules: Vec<ScheduledAgentTask>,
    plugins: PublicPluginDiscoveryResult,
    plugin_services: PluginServiceList,
    accounts: Vec<AccountView>,
    sources: Vec<ModelSourceView>,
}

#[derive(Debug, Clone)]
struct RemoteSnapshot {
    devices: Vec<DeviceView>,
    relay: RelayView,
}

#[derive(Debug, Clone)]
struct AccountMutation {
    accounts: Vec<AccountView>,
    session_id: Option<String>,
}

#[derive(Debug, Clone)]
struct ModelSourceMutation {
    sources: Vec<ModelSourceView>,
    accounts: Option<Vec<AccountView>>,
}

#[derive(Debug, Clone)]
struct SessionLoad {
    query: String,
    lifecycle: Option<SessionLifecycle>,
    append: bool,
    page: SessionPage,
}

#[derive(Debug, Clone)]
struct OperationsSnapshot {
    workspace: String,
    skills: Vec<SkillView>,
    usage: UsageResultView,
    diagnostics: String,
}

impl Desktop {
    fn boot() -> (Self, Task<Message>) {
        let preferences = preferences::Preferences::load();
        (
            Self {
                mode: Mode::Dark,
                status: LoadState::Loading,
                sessions: Vec::new(),
                health: None,
                selected_session: None,
                timeline: Vec::new(),
                timeline_loading: false,
                timeline_error: None,
                material: platform::MaterialStatus::Fallback,
                theme_override: false,
                terminal: None,
                chat_input: String::new(),
                chat_attachments: Vec::new(),
                chat_error: None,
                project: None,
                page: Page::Workspaces,
                orchestration: OrchestrationState::default(),
                management: ManagementState::default(),
                remote: RemoteState::default(),
                operations: OperationsState::default(),
                preferences,
                update: UpdateState::Checking,
                session_search: String::new(),
                session_lifecycle: Some(SessionLifecycle::Active),
                session_next_cursor: None,
                session_has_more: false,
                session_total: 0,
                session_loading: false,
                session_error: None,
                local_archive_view: false,
                create_session: None,
                pending_session_close: false,
                agent_controls: None,
            },
            Task::batch([
                iced::system::theme().map(Message::SystemThemeChanged),
                Task::perform(load(), |result| Message::Loaded(Box::new(result))),
                Task::perform(check_update(), Message::UpdateChecked),
                Task::perform(capture_after_startup(), |_| Message::Capture),
            ]),
        )
    }

    fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Loaded(result) => match *result {
                Ok((health, page)) => {
                    self.health = Some(health);
                    self.sessions = page.items;
                    self.session_next_cursor = page.next_cursor;
                    self.session_has_more = page.has_more;
                    self.session_total = page.total;
                    self.session_loading = false;
                    self.status = LoadState::Ready;
                }
                Err(error) => self.status = LoadState::Failed(error),
            },
            Message::Reload => {
                self.status = LoadState::Loading;
                return Task::perform(load(), |result| Message::Loaded(Box::new(result)));
            }
            Message::ToggleTheme => {
                self.mode = self.preferences.toggle_theme(self.mode);
                self.theme_override = true;
                let dark = self.mode == Mode::Dark;
                return window::latest()
                    .and_then(move |id| platform::install_material(id, dark))
                    .map(Message::MaterialApplied);
            }
            Message::MaterialApplied(status) => self.material = status,
            Message::WindowClosed => return iced::exit(),
            Message::Capture => {
                if std::env::var_os("PROSPERO_NATIVE_SCREENSHOT").is_some() {
                    return window::latest()
                        .then(|id| match id {
                            Some(id) => window::screenshot(id).map(Some),
                            None => Task::done(None),
                        })
                        .map(Message::CapturedMaybe);
                }
            }
            Message::CapturedMaybe(screenshot) => {
                let Some(screenshot) = screenshot else {
                    eprintln!("native screenshot failed: no window");
                    return iced::exit();
                };
                return Task::perform(save_screenshot(screenshot), Message::ScreenshotSaved);
            }
            Message::ScreenshotSaved(result) => match result {
                Ok(path) => {
                    println!("native screenshot: {path}");
                    return iced::exit();
                }
                Err(error) => eprintln!("native screenshot failed: {error}"),
            },
            Message::SelectSession(session_id) => {
                self.selected_session = Some(session_id.clone());
                self.timeline.clear();
                self.terminal = None;
                self.agent_controls = None;
                self.timeline_loading = true;
                self.timeline_error = None;
                self.project = Some(ProjectState {
                    loading: true,
                    ..Default::default()
                });
                let project_task = Task::perform(load_project(session_id.clone()), |result| {
                    Message::ProjectLoaded(Box::new(result))
                });
                if self
                    .sessions
                    .iter()
                    .any(|session| session.id == session_id && session.kind == SessionKind::Pty)
                {
                    return Task::batch([
                        project_task,
                        Task::perform(load_terminal(session_id), |result| {
                            Message::TerminalLoaded(Box::new(result))
                        }),
                    ]);
                }
                let timeline_id = session_id.clone();
                let controls_id = session_id.clone();
                return Task::batch([
                    project_task,
                    Task::perform(load_timeline(timeline_id), |result| {
                        Message::TimelineLoaded(Box::new(result))
                    }),
                    Task::perform(load_agent_controls(controls_id), |result| {
                        Message::AgentControlsLoaded(Box::new(result))
                    }),
                ]);
            }
            Message::TimelineLoaded(result) => match *result {
                Ok((session_id, timeline))
                    if self.selected_session.as_deref() == Some(&session_id) =>
                {
                    self.timeline = timeline;
                    self.timeline_loading = false;
                }
                Ok(_) => {}
                Err(error) => {
                    self.timeline_loading = false;
                    self.timeline_error = Some(error);
                }
            },
            Message::BackToSessions => {
                self.selected_session = None;
                self.timeline.clear();
                self.timeline_error = None;
                self.terminal = None;
                self.agent_controls = None;
                self.project = None;
            }
            Message::SystemThemeChanged(mode) => {
                if !self.theme_override {
                    let system = match mode {
                        iced::theme::Mode::Light => Mode::Light,
                        iced::theme::Mode::Dark | iced::theme::Mode::None => Mode::Dark,
                    };
                    self.mode = self.preferences.mode(system);
                }
            }
            Message::LinkClicked(uri) => drop(uri),
            Message::TerminalLoaded(result) => match *result {
                Ok((session_id, snapshot))
                    if self.selected_session.as_deref() == Some(&session_id) =>
                {
                    let mut model = TerminalModel::new(snapshot.size);
                    model.feed(&snapshot.bytes);
                    self.terminal = Some(TerminalState {
                        session_id: session_id.clone(),
                        model,
                        seq: snapshot.seq,
                        exited: false,
                        exit_code: None,
                        input: String::new(),
                        error: None,
                    });
                    self.timeline_loading = false;
                    return poll_terminal(session_id, snapshot.seq);
                }
                Ok(_) => {}
                Err(error) => {
                    self.timeline_loading = false;
                    self.timeline_error = Some(error);
                }
            },
            Message::TerminalPolled(result) => match *result {
                Ok((session_id, page)) if self.selected_session.as_deref() == Some(&session_id) => {
                    if let Some(terminal) = self.terminal.as_mut() {
                        if page.resync_required {
                            return Task::perform(load_terminal(session_id), |result| {
                                Message::TerminalLoaded(Box::new(result))
                            });
                        }
                        for event in page.events {
                            match event {
                                DecodedTerminalEvent::Output(bytes) => terminal.model.feed(&bytes),
                                DecodedTerminalEvent::Resize(size) => terminal.model.resize(size),
                            }
                        }
                        terminal.seq = page.next_seq.max(page.latest_seq);
                        terminal.exited = page.exited;
                        terminal.exit_code = page.exit_code;
                        terminal.error = None;
                        if !terminal.exited {
                            return poll_terminal(session_id, terminal.seq);
                        }
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    if let Some(terminal) = self.terminal.as_mut() {
                        terminal.error = Some(error);
                    }
                }
            },
            Message::TerminalInputChanged(value) => {
                if let Some(terminal) = self.terminal.as_mut() {
                    terminal.input = value;
                }
            }
            Message::TerminalSubmit => {
                if let Some(terminal) = self.terminal.as_mut() {
                    let input = std::mem::take(&mut terminal.input);
                    if !input.is_empty() && !terminal.exited {
                        let session_id = terminal.session_id.clone();
                        return Task::perform(
                            send_terminal_input(session_id, input),
                            Message::TerminalInputSent,
                        );
                    }
                }
            }
            Message::TerminalInputSent(result) => {
                if let Err(error) = result
                    && let Some(terminal) = self.terminal.as_mut()
                {
                    terminal.error = Some(error);
                }
            }
            Message::ChatInputChanged(value) => self.chat_input = value,
            Message::ChatAttach => {
                let remaining = 6usize.saturating_sub(self.chat_attachments.len());
                return Task::perform(select_attachments(remaining), Message::ChatAttached);
            }
            Message::ChatAttached(result) => match result {
                Ok(attachments) => {
                    let total = self
                        .chat_attachments
                        .iter()
                        .chain(&attachments)
                        .map(|attachment| attachment.data_b64.len())
                        .sum::<usize>();
                    if total > 14 * 1024 * 1024 {
                        self.chat_error = Some("图片总大小超出限制".into());
                    } else {
                        self.chat_attachments.extend(attachments);
                        self.chat_error = None;
                    }
                }
                Err(error) => self.chat_error = Some(error),
            },
            Message::ChatRemoveAttachment(index) => {
                if index < self.chat_attachments.len() {
                    self.chat_attachments.remove(index);
                }
            }
            Message::ChatSubmit => {
                if let Some(session_id) = self.selected_session.clone() {
                    let text = std::mem::take(&mut self.chat_input);
                    let attachments = std::mem::take(&mut self.chat_attachments);
                    if !text.trim().is_empty() || !attachments.is_empty() {
                        self.chat_error = None;
                        return Task::perform(
                            send_chat(session_id, text, attachments),
                            Message::ChatSent,
                        );
                    }
                }
            }
            Message::ChatSent(result) | Message::InteractionSent(result) => match result {
                Ok(session_id) => {
                    self.timeline_loading = true;
                    return Task::perform(load_timeline(session_id), |result| {
                        Message::TimelineLoaded(Box::new(result))
                    });
                }
                Err(error) => self.chat_error = Some(error),
            },
            Message::RefreshTimeline => {
                if !self.timeline_loading
                    && self.terminal.is_none()
                    && let Some(session_id) = self.selected_session.clone()
                {
                    self.timeline_loading = true;
                    return Task::perform(load_timeline(session_id), |result| {
                        Message::TimelineLoaded(Box::new(result))
                    });
                }
            }
            Message::PermissionRespond { request_id, allow } => {
                if let Some(session_id) = self.selected_session.clone() {
                    return Task::perform(
                        respond_permission(session_id, request_id, allow),
                        Message::InteractionSent,
                    );
                }
            }
            Message::QuestionRespond {
                request_id,
                question_id,
                value,
            } => {
                if let Some(session_id) = self.selected_session.clone() {
                    return Task::perform(
                        respond_question(session_id, request_id, question_id, value),
                        Message::InteractionSent,
                    );
                }
            }
            Message::ProjectLoaded(result) => match *result {
                Ok((session_id, entries, git, history))
                    if self.selected_session.as_deref() == Some(&session_id) =>
                {
                    self.project = Some(ProjectState {
                        entries,
                        git: Some(git),
                        history,
                        loading: false,
                        ..Default::default()
                    });
                }
                Ok(_) => {}
                Err(error) => {
                    self.project = Some(ProjectState {
                        error: Some(error),
                        ..Default::default()
                    });
                }
            },
            Message::ProjectFileSelected(path) => {
                if let Some(session_id) = self.selected_session.clone()
                    && let Some(project) = self.project.as_mut()
                {
                    project.selected_path = Some(path.clone());
                    project.loading = true;
                    return Task::perform(load_project_file(session_id, path), |result| {
                        Message::ProjectFileLoaded(Box::new(result))
                    });
                }
            }
            Message::ProjectFileLoaded(result) => match *result {
                Ok((path, preview)) => {
                    if let Some(project) = self.project.as_mut()
                        && project.selected_path.as_deref() == Some(&path)
                    {
                        project.preview = Some(preview);
                        project.draft = text_editor::Content::with_text(&String::from_utf8_lossy(
                            &project.preview.as_ref().unwrap().bytes,
                        ));
                        project.editing = false;
                        project.diff = None;
                        project.loading = false;
                    }
                }
                Err(error) => {
                    if let Some(project) = self.project.as_mut() {
                        project.error = Some(error);
                        project.loading = false;
                    }
                }
            },
            Message::ProjectEdit(action) => {
                if let Some(project) = self.project.as_mut() {
                    project.draft.perform(action);
                    project.editing = true;
                }
            }
            Message::ProjectToggleEdit => {
                if let Some(project) = self.project.as_mut() {
                    project.editing = !project.editing;
                }
            }
            Message::ProjectSave => {
                if let Some(session_id) = self.selected_session.clone()
                    && let Some(project) = self.project.as_ref()
                    && let Some(preview) = project.preview.as_ref()
                    && !preview.binary
                    && !preview.truncated
                {
                    return Task::perform(
                        save_project_file(
                            session_id,
                            preview.path.clone(),
                            project.draft.text(),
                            preview.version.clone(),
                        ),
                        |result| Message::ProjectSaved(Box::new(result)),
                    );
                }
            }
            Message::ProjectSaved(result) => match *result {
                Ok((_path, preview)) => {
                    if let Some(project) = self.project.as_mut() {
                        project.draft = text_editor::Content::with_text(&String::from_utf8_lossy(
                            &preview.bytes,
                        ));
                        project.preview = Some(preview);
                        project.editing = false;
                        project.error = None;
                    }
                    if let Some(session_id) = self.selected_session.clone() {
                        return refresh_project(session_id);
                    }
                }
                Err(error) => {
                    if let Some(project) = self.project.as_mut() {
                        project.error = Some(error);
                    }
                }
            },
            Message::ProjectDiffSelected { path, staged } => {
                if let Some(session_id) = self.selected_session.clone()
                    && let Some(project) = self.project.as_mut()
                {
                    project.selected_path = Some(path.clone());
                    project.loading = true;
                    return Task::perform(load_project_diff(session_id, path, staged), |result| {
                        Message::ProjectDiffLoaded(Box::new(result))
                    });
                }
            }
            Message::ProjectDiffLoaded(result) => match *result {
                Ok((path, diff)) => {
                    if let Some(project) = self.project.as_mut() {
                        project.selected_path = Some(path);
                        project.diff = Some(diff);
                        project.preview = None;
                        project.editing = false;
                        project.loading = false;
                    }
                }
                Err(error) => {
                    if let Some(project) = self.project.as_mut() {
                        project.error = Some(error);
                        project.loading = false;
                    }
                }
            },
            Message::GitStage { paths, unstage } => {
                if let Some(session_id) = self.selected_session.clone() {
                    return Task::perform(
                        mutate_git_stage(session_id, paths, unstage),
                        Message::ProjectMutationFinished,
                    );
                }
            }
            Message::GitDiscardRequest(path) => {
                if let Some(project) = self.project.as_mut() {
                    project.pending_discard = Some(path);
                }
            }
            Message::GitDiscardConfirm => {
                if let Some(session_id) = self.selected_session.clone()
                    && let Some(path) = self
                        .project
                        .as_mut()
                        .and_then(|project| project.pending_discard.take())
                {
                    return Task::perform(
                        mutate_git_discard(session_id, path),
                        Message::ProjectMutationFinished,
                    );
                }
            }
            Message::GitDiscardCancel => {
                if let Some(project) = self.project.as_mut() {
                    project.pending_discard = None;
                }
            }
            Message::GitCommitInputChanged(value) => {
                if let Some(project) = self.project.as_mut() {
                    project.commit_message = value;
                }
            }
            Message::GitCommit => {
                if let Some(session_id) = self.selected_session.clone()
                    && let Some(project) = self.project.as_mut()
                {
                    let message = std::mem::take(&mut project.commit_message);
                    if !message.trim().is_empty() {
                        return Task::perform(
                            mutate_git_commit(session_id, message),
                            Message::ProjectMutationFinished,
                        );
                    }
                }
            }
            Message::ProjectMutationFinished(result) => match result {
                Ok(session_id) => return refresh_project(session_id),
                Err(error) => {
                    if let Some(project) = self.project.as_mut() {
                        project.error = Some(error);
                    }
                }
            },
            Message::Navigate(page) => {
                self.page = page;
                if page == Page::Orchestration && self.orchestration.runs.is_empty() {
                    self.orchestration.loading = true;
                    return Task::perform(load_runs(), |result| {
                        Message::RunsLoaded(Box::new(result))
                    });
                }
                if matches!(page, Page::Schedules | Page::Accounts)
                    && self.management.schedules.is_empty()
                    && self.management.accounts.is_empty()
                {
                    self.management.loading = true;
                    return Task::perform(load_management(), |result| {
                        Message::ManagementLoaded(Box::new(result))
                    });
                }
                if page == Page::Remote {
                    self.remote.loading = true;
                    return Task::batch([
                        Task::perform(load_remote(), |result| {
                            Message::RemoteLoaded(Box::new(result))
                        }),
                        Task::perform(remote::list_hosts(), Message::RemoteHostsLoaded),
                        Task::perform(remote::list_workspaces(), Message::RemoteWorkspacesLoaded),
                    ]);
                }
                if page == Page::Operations {
                    self.operations.loading = true;
                    let workspace = operations_workspace(self);
                    return Task::perform(load_operations(workspace), |result| {
                        Message::OperationsLoaded(Box::new(result))
                    });
                }
            }
            Message::RunsLoaded(result) => match *result {
                Ok(runs) => {
                    self.orchestration.runs = runs;
                    self.orchestration.loading = false;
                    self.orchestration.error = None;
                }
                Err(error) => {
                    self.orchestration.loading = false;
                    self.orchestration.error = Some(error);
                }
            },
            Message::SelectRun(run_id) => {
                self.orchestration.selected_run = Some(run_id.clone());
                self.orchestration.loading = true;
                return Task::perform(load_run(run_id), |result| {
                    Message::RunLoaded(Box::new(result))
                });
            }
            Message::RunLoaded(result) => match *result {
                Ok((snapshot, worktrees))
                    if self.orchestration.selected_run.as_deref() == Some(&snapshot.run.id) =>
                {
                    self.orchestration.snapshot = Some(snapshot);
                    self.orchestration.worktrees = worktrees;
                    self.orchestration.loading = false;
                    self.orchestration.error = None;
                }
                Ok(_) => {}
                Err(error) => {
                    self.orchestration.loading = false;
                    self.orchestration.error = Some(error);
                }
            },
            Message::RunCreateOpen => {
                self.orchestration.run_form = Some(RunForm::default());
                self.orchestration.task_form = None;
            }
            Message::RunFormCancel => self.orchestration.run_form = None,
            Message::RunObjectiveChanged(value) => {
                if let Some(form) = self.orchestration.run_form.as_mut() {
                    form.objective = value;
                }
            }
            Message::RunTaskLinesChanged(value) => {
                if let Some(form) = self.orchestration.run_form.as_mut() {
                    form.task_lines = value;
                }
            }
            Message::RunSkillsChanged(value) => {
                if let Some(form) = self.orchestration.run_form.as_mut() {
                    form.skills = value;
                }
            }
            Message::RunCreateSubmit => {
                if let Some(form) = self.orchestration.run_form.clone() {
                    self.orchestration.loading = true;
                    return Task::perform(create_run_graph(form), |result| {
                        Message::RunGraphMutated(Box::new(result))
                    });
                }
            }
            Message::TaskCreateOpen => {
                self.orchestration.task_form = Some(TaskForm {
                    id: None,
                    title: String::new(),
                    spec: String::new(),
                    skills: String::new(),
                    deps: String::new(),
                });
                self.orchestration.run_form = None;
            }
            Message::TaskEditOpen(id) => {
                if let Some(task) = self
                    .orchestration
                    .snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.tasks.iter().find(|task| task.id == id))
                {
                    self.orchestration.task_form = Some(TaskForm {
                        id: Some(task.id.clone()),
                        title: task.title.clone(),
                        spec: task.spec.clone(),
                        skills: task.skills.join(", "),
                        deps: task.deps.join(", "),
                    });
                }
            }
            Message::TaskFormCancel => self.orchestration.task_form = None,
            Message::TaskTitleChanged(value) => {
                if let Some(form) = self.orchestration.task_form.as_mut() {
                    form.title = value;
                }
            }
            Message::TaskSpecChanged(value) => {
                if let Some(form) = self.orchestration.task_form.as_mut() {
                    form.spec = value;
                }
            }
            Message::TaskSkillsChanged(value) => {
                if let Some(form) = self.orchestration.task_form.as_mut() {
                    form.skills = value;
                }
            }
            Message::TaskDepsChanged(value) => {
                if let Some(form) = self.orchestration.task_form.as_mut() {
                    form.deps = value;
                }
            }
            Message::TaskSave => {
                if let (Some(snapshot), Some(form)) = (
                    self.orchestration.snapshot.as_ref(),
                    self.orchestration.task_form.clone(),
                ) {
                    self.orchestration.loading = true;
                    return Task::perform(
                        save_task_graph(snapshot.run.clone(), form, Vec::new()),
                        |result| Message::RunGraphMutated(Box::new(result)),
                    );
                }
            }
            Message::TaskDeleteRequest { id, title } => {
                self.orchestration.pending_task_delete = Some((id, title));
            }
            Message::TaskDeleteCancel => self.orchestration.pending_task_delete = None,
            Message::TaskDeleteConfirm => {
                if let (Some(snapshot), Some((id, _))) = (
                    self.orchestration.snapshot.as_ref(),
                    self.orchestration.pending_task_delete.take(),
                ) {
                    self.orchestration.loading = true;
                    return Task::perform(
                        save_task_graph(
                            snapshot.run.clone(),
                            TaskForm {
                                id: None,
                                title: String::new(),
                                spec: String::new(),
                                skills: String::new(),
                                deps: String::new(),
                            },
                            vec![id],
                        ),
                        |result| Message::RunGraphMutated(Box::new(result)),
                    );
                }
            }
            Message::RunGraphMutated(result) => match *result {
                Ok(run_id) => {
                    self.orchestration.run_form = None;
                    self.orchestration.task_form = None;
                    self.orchestration.selected_run = Some(run_id.clone());
                    return Task::batch([
                        Task::perform(load_runs(), |result| Message::RunsLoaded(Box::new(result))),
                        Task::perform(load_run(run_id), |result| {
                            Message::RunLoaded(Box::new(result))
                        }),
                    ]);
                }
                Err(error) => {
                    self.orchestration.loading = false;
                    self.orchestration.error = Some(error);
                }
            },
            Message::WorktreeInspect(asset_id) => {
                if let Some(run_id) = self.orchestration.selected_run.clone() {
                    self.orchestration.loading = true;
                    return Task::perform(worktree_inspect(run_id, asset_id), |result| {
                        Message::WorktreeMutated(Box::new(result))
                    });
                }
            }
            Message::WorktreeCleanupRequest(asset_id) => {
                self.orchestration.pending_worktree_cleanup = Some(asset_id);
            }
            Message::WorktreeCleanupCancel => {
                self.orchestration.pending_worktree_cleanup = None;
            }
            Message::WorktreeCleanupConfirm => {
                if let (Some(run_id), Some(asset_id)) = (
                    self.orchestration.selected_run.clone(),
                    self.orchestration.pending_worktree_cleanup.take(),
                ) {
                    self.orchestration.loading = true;
                    return Task::perform(worktree_cleanup(run_id, asset_id), |result| {
                        Message::WorktreeMutated(Box::new(result))
                    });
                }
            }
            Message::WorktreeMutated(result) => match *result {
                Ok(run_id) => {
                    return Task::perform(load_run(run_id), |result| {
                        Message::RunLoaded(Box::new(result))
                    });
                }
                Err(error) => {
                    self.orchestration.loading = false;
                    self.orchestration.error = Some(error);
                }
            },
            Message::OperationsWorkspaceChanged(value) => self.operations.workspace = value,
            Message::OperationsRefresh => {
                self.operations.loading = true;
                self.operations.error = None;
                return Task::perform(
                    load_operations(self.operations.workspace.clone()),
                    |result| Message::OperationsLoaded(Box::new(result)),
                );
            }
            Message::OperationsLoaded(result) => match *result {
                Ok(snapshot) => {
                    self.operations.workspace = snapshot.workspace;
                    self.operations.skills = snapshot.skills;
                    self.operations.usage = Some(snapshot.usage);
                    self.operations.diagnostics = snapshot.diagnostics;
                    self.operations.loading = false;
                    self.operations.error = None;
                }
                Err(error) => {
                    self.operations.loading = false;
                    self.operations.error = Some(error);
                }
            },
            Message::ServiceInstall => {
                self.operations.loading = true;
                return Task::perform(
                    run_service(service::CommandKind::Install),
                    Message::ServiceActionFinished,
                );
            }
            Message::ServiceStart => {
                self.operations.loading = true;
                return Task::perform(
                    run_service(service::CommandKind::Start),
                    Message::ServiceActionFinished,
                );
            }
            Message::ServiceActionFinished(result) => match result {
                Ok(message) => {
                    self.operations.diagnostics = message;
                    return self.update(Message::OperationsRefresh);
                }
                Err(error) => {
                    self.operations.loading = false;
                    self.operations.error = Some(error);
                }
            },
            Message::PauseAutomation(run_id) => {
                return Task::perform(pause_automation(run_id), Message::OrchestrationMutated);
            }
            Message::RetryTask { run_id, task_id } => {
                return Task::perform(retry_task(run_id, task_id), Message::OrchestrationMutated);
            }
            Message::CancelTask { run_id, task_id } => {
                return Task::perform(cancel_task(run_id, task_id), Message::OrchestrationMutated);
            }
            Message::ResolveGate {
                run_id,
                gate_id,
                decision,
            } => {
                return Task::perform(
                    resolve_gate(run_id, gate_id, decision),
                    Message::OrchestrationMutated,
                );
            }
            Message::OrchestrationMutated(result) => match result {
                Ok(run_id) => {
                    self.orchestration.loading = true;
                    return Task::perform(load_run(run_id), |result| {
                        Message::RunLoaded(Box::new(result))
                    });
                }
                Err(error) => self.orchestration.error = Some(error),
            },
            Message::ManagementLoaded(result) => match *result {
                Ok(snapshot) => {
                    self.management.schedules = snapshot.schedules;
                    self.management.plugins = snapshot.plugins;
                    self.management.plugin_services = snapshot.plugin_services;
                    self.management.accounts = snapshot.accounts;
                    self.management.sources = snapshot.sources;
                    self.management.loading = false;
                    self.management.error = None;
                }
                Err(error) => {
                    self.management.loading = false;
                    self.management.error = Some(error);
                }
            },
            Message::SchedulePause(id) => {
                return Task::perform(mutate_schedule(id, "pause"), Message::ScheduleMutated);
            }
            Message::ScheduleResume(id) => {
                return Task::perform(mutate_schedule(id, "resume"), Message::ScheduleMutated);
            }
            Message::ScheduleRun(id) => {
                return Task::perform(mutate_schedule(id, "run"), Message::ScheduleMutated);
            }
            Message::ScheduleCreateOpen => {
                self.management.schedule_form = Some(ScheduleForm::default());
            }
            Message::ScheduleEditOpen(schedule) => {
                self.management.schedule_form = Some(ScheduleForm::from(schedule.as_ref()));
            }
            Message::ScheduleFormCancel => self.management.schedule_form = None,
            Message::ScheduleNameChanged(value) => {
                if let Some(form) = self.management.schedule_form.as_mut() {
                    form.name = value;
                }
            }
            Message::SchedulePromptChanged(value) => {
                if let Some(form) = self.management.schedule_form.as_mut() {
                    form.prompt = value;
                }
            }
            Message::ScheduleRruleChanged(value) => {
                if let Some(form) = self.management.schedule_form.as_mut() {
                    form.rrule = value;
                }
            }
            Message::ScheduleCwdChanged(value) => {
                if let Some(form) = self.management.schedule_form.as_mut() {
                    form.cwd = value;
                }
            }
            Message::ScheduleAgentChanged(agent) => {
                if let Some(form) = self.management.schedule_form.as_mut() {
                    form.agent = agent;
                }
            }
            Message::ScheduleSave => {
                if let Some(form) = self.management.schedule_form.clone() {
                    self.management.loading = true;
                    return Task::perform(save_schedule(form), Message::ScheduleMutated);
                }
            }
            Message::ScheduleDeleteRequest { id, name } => {
                self.management.pending_schedule_delete = Some((id, name));
            }
            Message::ScheduleDeleteCancel => self.management.pending_schedule_delete = None,
            Message::ScheduleDeleteConfirm => {
                if let Some((id, _)) = self.management.pending_schedule_delete.take() {
                    self.management.loading = true;
                    return Task::perform(delete_schedule(id), Message::ScheduleMutated);
                }
            }
            Message::ScheduleMutated(result) | Message::PluginMutated(result) => match result {
                Ok(()) => {
                    self.management.schedule_form = None;
                    self.management.loading = true;
                    return Task::perform(load_management(), |result| {
                        Message::ManagementLoaded(Box::new(result))
                    });
                }
                Err(error) => self.management.error = Some(error),
            },
            Message::AccountCreateOpen { api } => {
                self.management.account_form = Some(AccountForm {
                    api,
                    ..Default::default()
                });
            }
            Message::AccountEditOpen(account) => {
                let profile = account.api_profile.as_ref();
                self.management.account_form = Some(AccountForm {
                    id: Some(account.id.clone()),
                    name: account.name.clone(),
                    agent: account.agent,
                    api: profile.is_some(),
                    base_url: profile
                        .and_then(|value| value.get("baseUrl"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    model: profile
                        .and_then(|value| value.get("model"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    api_key: String::new(),
                });
            }
            Message::AccountFormCancel => self.management.account_form = None,
            Message::AccountNameChanged(value) => {
                if let Some(form) = self.management.account_form.as_mut() {
                    form.name = value;
                }
            }
            Message::AccountAgentChanged(agent) => {
                if let Some(form) = self.management.account_form.as_mut() {
                    form.agent = agent;
                }
            }
            Message::AccountBaseUrlChanged(value) => {
                if let Some(form) = self.management.account_form.as_mut() {
                    form.base_url = value;
                }
            }
            Message::AccountModelChanged(value) => {
                if let Some(form) = self.management.account_form.as_mut() {
                    form.model = value;
                }
            }
            Message::AccountApiKeyChanged(value) => {
                if let Some(form) = self.management.account_form.as_mut() {
                    form.api_key = value;
                }
            }
            Message::AccountSave => {
                if let Some(mut form) = self.management.account_form.take() {
                    self.management.loading = true;
                    return Task::perform(
                        save_account(std::mem::take(&mut form.api_key), form),
                        |result| Message::AccountMutated(Box::new(result)),
                    );
                }
            }
            Message::AccountSetDefault(id) => {
                self.management.loading = true;
                return Task::perform(account_simple(id, "default"), |result| {
                    Message::AccountMutated(Box::new(result))
                });
            }
            Message::AccountLogin(id) => {
                self.management.loading = true;
                return Task::perform(account_simple(id, "login"), |result| {
                    Message::AccountMutated(Box::new(result))
                });
            }
            Message::AccountActionRequest { id, name, action } => {
                self.management.pending_account_action = Some((id, name, action));
            }
            Message::AccountActionCancel => self.management.pending_account_action = None,
            Message::AccountActionConfirm => {
                if let Some((id, _, action)) = self.management.pending_account_action.take() {
                    self.management.loading = true;
                    return Task::perform(account_simple(id, action), |result| {
                        Message::AccountMutated(Box::new(result))
                    });
                }
            }
            Message::AccountMutated(result) => match *result {
                Ok(mutation) => {
                    self.management.accounts = mutation.accounts;
                    self.management.loading = false;
                    self.management.error = None;
                    if mutation.session_id.is_some() {
                        self.page = Page::Workspaces;
                        return Task::perform(load(), |result| Message::Loaded(Box::new(result)));
                    }
                }
                Err(error) => {
                    self.management.loading = false;
                    self.management.error = Some(error);
                }
            },
            Message::SourceCreateOpen => {
                self.management.source_form = Some(ModelSourceForm::default());
            }
            Message::SourceFormCancel => self.management.source_form = None,
            Message::SourceNameChanged(value) => {
                if let Some(form) = self.management.source_form.as_mut() {
                    form.name = value;
                }
            }
            Message::SourceProtocolChanged(value) => {
                if let Some(form) = self.management.source_form.as_mut() {
                    form.protocol = value.clone();
                    form.base_url = if value == "anthropic" {
                        "https://api.anthropic.com".into()
                    } else {
                        "https://api.openai.com/v1".into()
                    };
                }
            }
            Message::SourceBaseUrlChanged(value) => {
                if let Some(form) = self.management.source_form.as_mut() {
                    form.base_url = value;
                }
            }
            Message::SourceCredentialNameChanged(value) => {
                if let Some(form) = self.management.source_form.as_mut() {
                    form.credential_name = value;
                }
            }
            Message::SourceApiKeyChanged(value) => {
                if let Some(form) = self.management.source_form.as_mut() {
                    form.api_key = value;
                }
            }
            Message::SourceRouteNameChanged(value) => {
                if let Some(form) = self.management.source_form.as_mut() {
                    form.route_name = value;
                }
            }
            Message::SourceModelChanged(value) => {
                if let Some(form) = self.management.source_form.as_mut() {
                    form.model = value;
                }
            }
            Message::SourceCreateSubmit => {
                if let Some(mut form) = self.management.source_form.take() {
                    self.management.loading = true;
                    return Task::perform(
                        create_model_source(std::mem::take(&mut form.api_key), form),
                        |result| Message::SourceMutated(Box::new(result)),
                    );
                }
            }
            Message::SourceToggle {
                id,
                revision,
                enabled,
            } => {
                self.management.loading = true;
                return Task::perform(
                    model_source_action(serde_json::json!({
                        "kind": "update", "sourceId": id, "revision": revision, "enabled": enabled
                    })),
                    |result| Message::SourceMutated(Box::new(result)),
                );
            }
            Message::SourceBind {
                id,
                route_id,
                revision,
            } => {
                self.management.loading = true;
                return Task::perform(
                    model_source_action(serde_json::json!({
                        "kind": "bind", "sourceId": id, "routeId": route_id, "revision": revision
                    })),
                    |result| Message::SourceMutated(Box::new(result)),
                );
            }
            Message::SourceDeleteRequest { id, name, revision } => {
                self.management.pending_source_delete = Some((id, name, revision));
            }
            Message::SourceDeleteCancel => self.management.pending_source_delete = None,
            Message::SourceDeleteConfirm => {
                if let Some((id, _, revision)) = self.management.pending_source_delete.take() {
                    self.management.loading = true;
                    return Task::perform(
                        model_source_action(serde_json::json!({
                            "kind": "delete", "sourceId": id, "revision": revision
                        })),
                        |result| Message::SourceMutated(Box::new(result)),
                    );
                }
            }
            Message::SourceMutated(result) => match *result {
                Ok(mutation) => {
                    self.management.sources = mutation.sources;
                    if let Some(accounts) = mutation.accounts {
                        self.management.accounts = accounts;
                    }
                    self.management.source_form = None;
                    self.management.loading = false;
                    self.management.error = None;
                }
                Err(error) => {
                    self.management.loading = false;
                    self.management.error = Some(error);
                }
            },
            Message::PluginAction {
                plugin,
                service,
                action,
            } => {
                return Task::perform(
                    mutate_plugin(plugin, service, action),
                    Message::PluginMutated,
                );
            }
            Message::RemoteLoaded(result) => match *result {
                Ok(snapshot) => {
                    self.remote.devices = snapshot.devices;
                    self.remote.relay_url =
                        snapshot.relay.configured_url.clone().unwrap_or_default();
                    self.remote.relay = Some(snapshot.relay);
                    self.remote.loading = false;
                    self.remote.error = None;
                }
                Err(error) => {
                    self.remote.loading = false;
                    self.remote.error = Some(error);
                }
            },
            Message::PairingNameChanged(value) => self.remote.pairing_name = value,
            Message::PairingShellChanged(value) => {
                self.remote.allow_shell = value;
                if !value {
                    self.remote.allow_orchestration = false;
                }
            }
            Message::PairingOrchestrationChanged(value) => {
                if self.remote.allow_shell {
                    self.remote.allow_orchestration = value;
                }
            }
            Message::PairingCreate => {
                self.remote.loading = true;
                self.remote.pairing_uri = None;
                self.remote.pairing_qr = None;
                return Task::perform(
                    create_pairing(
                        self.remote.pairing_name.clone(),
                        self.remote.allow_shell,
                        self.remote.allow_orchestration,
                    ),
                    |result| Message::PairingCreated(Box::new(result)),
                );
            }
            Message::PairingCreated(result) => match *result {
                Ok((devices, uri)) => {
                    self.remote.devices = devices;
                    self.remote.pairing_qr = qr_code::Data::new(uri.as_bytes()).ok();
                    self.remote.pairing_uri = Some(uri);
                    self.remote.loading = false;
                    self.remote.error = None;
                }
                Err(error) => {
                    self.remote.loading = false;
                    self.remote.error = Some(error);
                }
            },
            Message::PairingDismiss => {
                self.remote.pairing_uri = None;
                self.remote.pairing_qr = None;
            }
            Message::DeviceRevokeRequest(device) => self.remote.pending_revoke = Some(device),
            Message::DeviceRevokeConfirm => {
                if let Some(device) = self.remote.pending_revoke.take() {
                    self.remote.loading = true;
                    return Task::perform(revoke_device(device.id), Message::DeviceRevoked);
                }
            }
            Message::DeviceRevokeCancel => self.remote.pending_revoke = None,
            Message::DeviceRevoked(result) => match result {
                Ok(()) => {
                    return Task::perform(load_remote(), |result| {
                        Message::RemoteLoaded(Box::new(result))
                    });
                }
                Err(error) => {
                    self.remote.loading = false;
                    self.remote.error = Some(error);
                }
            },
            Message::RelayUrlChanged(value) => self.remote.relay_url = value,
            Message::RelayEnable => {
                self.remote.loading = true;
                return Task::perform(
                    update_relay(Some(true), Some(self.remote.relay_url.clone()), false),
                    |result| Message::RelayMutated(Box::new(result)),
                );
            }
            Message::RelayDisable => {
                self.remote.loading = true;
                return Task::perform(update_relay(Some(false), None, false), |result| {
                    Message::RelayMutated(Box::new(result))
                });
            }
            Message::RelayRotateRequest => self.remote.pending_rotate = true,
            Message::RelayRotateConfirm => {
                self.remote.pending_rotate = false;
                self.remote.loading = true;
                return Task::perform(update_relay(None, None, true), |result| {
                    Message::RelayMutated(Box::new(result))
                });
            }
            Message::RelayRotateCancel => self.remote.pending_rotate = false,
            Message::RelayMutated(result) => match *result {
                Ok(relay) => {
                    self.remote.relay = Some(relay);
                    return Task::perform(load_remote(), |result| {
                        Message::RemoteLoaded(Box::new(result))
                    });
                }
                Err(error) => {
                    self.remote.loading = false;
                    self.remote.error = Some(error);
                }
            },
            Message::RemoteHostsLoaded(result) => match result {
                Ok(hosts) => self.remote.hosts = hosts,
                Err(error) => self.remote.error = Some(error),
            },
            Message::RemoteWorkspacesLoaded(result) => match result {
                Ok(workspaces) => self.remote.workspaces = workspaces,
                Err(error) => self.remote.error = Some(error),
            },
            Message::RemoteImportChanged(value) => self.remote.import_value = value,
            Message::RemoteImport => {
                let value = self.remote.import_value.trim().to_owned();
                if !value.is_empty() {
                    self.remote.loading = true;
                    return Task::perform(remote::import_pairing(value), Message::RemoteImported);
                }
            }
            Message::RemoteImported(result) => match result {
                Ok(host) => {
                    self.remote.import_value.clear();
                    self.remote.selected_host = Some(host.id.clone());
                    self.remote.hosts.retain(|item| item.id != host.id);
                    self.remote.hosts.push(host.clone());
                    self.remote.loading = false;
                    self.remote.error = None;
                    if let Some(sender) = self.remote.command_sender.clone() {
                        return send_remote_command(sender, remote::Command::Connect(host.id));
                    }
                    return Task::perform(remote::list_hosts(), Message::RemoteHostsLoaded);
                }
                Err(error) => {
                    self.remote.loading = false;
                    self.remote.error = Some(error);
                }
            },
            Message::RemoteConnect(id) => {
                self.remote.selected_host = Some(id.clone());
                self.remote.connection = "connecting".into();
                self.remote.error = None;
                self.remote.sessions.clear();
                self.remote.listing = None;
                self.remote.terminal = None;
                if let Some(sender) = self.remote.command_sender.clone() {
                    return send_remote_command(sender, remote::Command::Connect(id));
                }
            }
            Message::RemoteBrowseHome => {
                if let Some(sender) = self.remote.command_sender.clone() {
                    return send_remote_command(
                        sender,
                        remote::Command::ListWorkspace {
                            root: "home".into(),
                            path: String::new(),
                        },
                    );
                }
            }
            Message::RemoteBrowseComputer => {
                if let Some(sender) = self.remote.command_sender.clone() {
                    return send_remote_command(
                        sender,
                        remote::Command::ListWorkspace {
                            root: "computer".into(),
                            path: String::new(),
                        },
                    );
                }
            }
            Message::RemoteBrowseEnter(name) => {
                if let (Some(sender), Some(listing)) = (
                    self.remote.command_sender.clone(),
                    self.remote.listing.as_ref(),
                ) && safe_remote_child(&name)
                {
                    let root = listing.root.clone().unwrap_or_else(|| "home".into());
                    let path = if root == "computer" {
                        String::new()
                    } else if listing.path.is_empty() {
                        name.clone()
                    } else {
                        format!("{}/{}", listing.path, name)
                    };
                    let root = if root == "computer" { name } else { root };
                    return send_remote_command(
                        sender,
                        remote::Command::ListWorkspace { root, path },
                    );
                }
            }
            Message::RemoteBrowseUp => {
                if let (Some(sender), Some(listing)) = (
                    self.remote.command_sender.clone(),
                    self.remote.listing.as_ref(),
                ) {
                    let (root, path) = if listing.path.is_empty()
                        && listing.root.as_deref().is_some_and(|root| root != "home")
                    {
                        ("computer".to_owned(), String::new())
                    } else {
                        let mut parts = listing
                            .path
                            .split('/')
                            .filter(|part| !part.is_empty())
                            .collect::<Vec<_>>();
                        parts.pop();
                        (
                            listing.root.clone().unwrap_or_else(|| "home".into()),
                            parts.join("/"),
                        )
                    };
                    return send_remote_command(
                        sender,
                        remote::Command::ListWorkspace { root, path },
                    );
                }
            }
            Message::RemoteWorkspaceUse => {
                if let (Some(host), Some(listing)) = (
                    self.remote
                        .selected_host
                        .as_deref()
                        .and_then(|id| self.remote.hosts.iter().find(|host| host.id == id))
                        .cloned(),
                    self.remote.listing.clone(),
                ) {
                    self.remote.shell_cwd = listing.cwd.clone();
                    return Task::perform(
                        remote::save_workspace(host, listing),
                        Message::RemoteWorkspaceSaved,
                    );
                }
            }
            Message::RemoteWorkspaceSaved(result) => match result {
                Ok(workspaces) => self.remote.workspaces = workspaces,
                Err(error) => self.remote.error = Some(error),
            },
            Message::RemoteWorkspaceOpen { id, fresh } => {
                if let Some(workspace) = self
                    .remote
                    .workspaces
                    .iter()
                    .find(|workspace| workspace.id == id)
                    .cloned()
                {
                    self.remote.shell_cwd = workspace.cwd.clone();
                    if self.remote.selected_host.as_deref() != Some(&workspace.host_id)
                        || self.remote.connection != "connected"
                    {
                        self.remote.pending_workspace_open = Some((workspace.cwd, fresh));
                        self.remote.selected_host = Some(workspace.host_id.clone());
                        if let Some(sender) = self.remote.command_sender.clone() {
                            return send_remote_command(
                                sender,
                                remote::Command::Connect(workspace.host_id),
                            );
                        }
                    } else if fresh && let Some(sender) = self.remote.command_sender.clone() {
                        return send_remote_command(
                            sender,
                            remote::Command::CreateShell {
                                cwd: workspace.cwd,
                                request_id: uuid::Uuid::new_v4().to_string(),
                            },
                        );
                    } else if let Some(session) = self
                        .remote
                        .sessions
                        .iter()
                        .find(|session| {
                            session.kind == SessionKind::Pty && session.cwd == workspace.cwd
                        })
                        .cloned()
                    {
                        return self.update(Message::RemoteSessionSelect(session.id));
                    } else if let Some(sender) = self.remote.command_sender.clone() {
                        return send_remote_command(
                            sender,
                            remote::Command::CreateShell {
                                cwd: workspace.cwd,
                                request_id: uuid::Uuid::new_v4().to_string(),
                            },
                        );
                    }
                }
            }
            Message::RemoteWorkspaceRemove(id) => {
                return Task::perform(remote::remove_workspace(id), Message::RemoteWorkspaceSaved);
            }
            Message::RemoteDisconnect => {
                self.remote.connection = "offline".into();
                self.remote.sessions.clear();
                self.remote.terminal = None;
                self.remote.chat = None;
                self.remote.listing = None;
                self.remote.pending_workspace_open = None;
                self.remote.workspace_roots = false;
                if let Some(sender) = self.remote.command_sender.clone() {
                    return send_remote_command(sender, remote::Command::Disconnect);
                }
            }
            Message::RemoteHostRemoveRequest(host) => {
                self.remote.pending_host_remove = Some(host);
            }
            Message::RemoteHostRemoveCancel => self.remote.pending_host_remove = None,
            Message::RemoteHostRemoveConfirm => {
                if let Some(host) = self.remote.pending_host_remove.take() {
                    self.remote.loading = true;
                    return Task::perform(remote::remove_host(host.id), Message::RemoteHostRemoved);
                }
            }
            Message::RemoteHostRemoved(result) => match result {
                Ok(id) => {
                    self.remote.loading = false;
                    let selected = self.remote.selected_host.as_deref() == Some(&id);
                    self.remote.hosts.retain(|host| host.id != id);
                    self.remote
                        .workspaces
                        .retain(|workspace| workspace.host_id != id);
                    if selected {
                        self.remote.selected_host = None;
                        self.remote.sessions.clear();
                        self.remote.terminal = None;
                        self.remote.chat = None;
                    }
                    if let Some(sender) = self.remote.command_sender.clone()
                        && selected
                    {
                        return send_remote_command(sender, remote::Command::Disconnect);
                    }
                }
                Err(error) => {
                    self.remote.loading = false;
                    self.remote.error = Some(error);
                }
            },
            Message::RemoteShellCwdChanged(value) => self.remote.shell_cwd = value,
            Message::RemoteShellCreate => {
                if let Some(sender) = self.remote.command_sender.clone() {
                    let cwd = self.remote.shell_cwd.trim().to_owned();
                    if !cwd.is_empty() {
                        return send_remote_command(
                            sender,
                            remote::Command::CreateShell {
                                cwd,
                                request_id: uuid::Uuid::new_v4().to_string(),
                            },
                        );
                    }
                }
            }
            Message::RemoteAgentCreate(agent) => {
                if let Some(sender) = self.remote.command_sender.clone() {
                    let cwd = self.remote.shell_cwd.trim().to_owned();
                    if !cwd.is_empty() && resumable_agent(agent) {
                        return send_remote_command(
                            sender,
                            remote::Command::CreateAgent {
                                cwd,
                                agent,
                                request_id: uuid::Uuid::new_v4().to_string(),
                            },
                        );
                    }
                }
            }
            Message::RemoteSessionSelect(sid) => {
                if let Some(session) = self.remote.sessions.iter().find(|item| item.id == sid) {
                    let previous = remote_selected_session(&self.remote);
                    if session.kind == SessionKind::Pty {
                        self.remote.chat = None;
                        self.remote.terminal = Some(RemoteTerminalState {
                            session_id: sid.clone(),
                            model: TerminalModel::new(TerminalSize {
                                cols: session.cols,
                                rows: session.rows,
                            }),
                            seq: 0,
                            input: String::new(),
                        });
                    } else {
                        self.remote.terminal = None;
                        self.remote.chat = Some(RemoteChatState {
                            session_id: sid.clone(),
                            events: Vec::new(),
                            seq: 0,
                            input: String::new(),
                            attachments: Vec::new(),
                        });
                    }
                    if let Some(sender) = self.remote.command_sender.clone() {
                        return send_remote_command(
                            sender,
                            remote::Command::Attach {
                                sid,
                                last_seq: None,
                                previous,
                            },
                        );
                    }
                }
            }
            Message::RemoteTerminalInputChanged(value) => {
                if let Some(terminal) = self.remote.terminal.as_mut() {
                    terminal.input = value;
                }
            }
            Message::RemoteTerminalSubmit => {
                if let (Some(sender), Some(terminal)) = (
                    self.remote.command_sender.clone(),
                    self.remote.terminal.as_mut(),
                ) {
                    let mut bytes = std::mem::take(&mut terminal.input).into_bytes();
                    bytes.push(b'\r');
                    return send_remote_command(
                        sender,
                        remote::Command::Input {
                            sid: terminal.session_id.clone(),
                            data_b64: base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                bytes,
                            ),
                        },
                    );
                }
            }
            Message::RemoteTerminalResize(cols, rows) => {
                if let (Some(sender), Some(terminal)) = (
                    self.remote.command_sender.clone(),
                    self.remote.terminal.as_mut(),
                ) {
                    terminal.model.resize(TerminalSize { cols, rows });
                    return send_remote_command(
                        sender,
                        remote::Command::Resize {
                            sid: terminal.session_id.clone(),
                            cols,
                            rows,
                        },
                    );
                }
            }
            Message::RemoteChatInputChanged(value) => {
                if let Some(chat) = self.remote.chat.as_mut() {
                    chat.input = value;
                }
            }
            Message::RemoteChatAttach => {
                let remaining = self
                    .remote
                    .chat
                    .as_ref()
                    .map_or(0, |chat| 6usize.saturating_sub(chat.attachments.len()));
                return Task::perform(select_attachments(remaining), Message::RemoteChatAttached);
            }
            Message::RemoteChatAttached(result) => match result {
                Ok(attachments) => {
                    if let Some(chat) = self.remote.chat.as_mut() {
                        let total = chat
                            .attachments
                            .iter()
                            .chain(&attachments)
                            .map(|attachment| attachment.data_b64.len())
                            .sum::<usize>();
                        if total <= 14 * 1024 * 1024 {
                            chat.attachments.extend(attachments);
                            self.remote.error = None;
                        } else {
                            self.remote.error = Some("图片总大小超出限制".into());
                        }
                    }
                }
                Err(error) => self.remote.error = Some(error),
            },
            Message::RemoteChatRemoveAttachment(index) => {
                if let Some(chat) = self.remote.chat.as_mut()
                    && index < chat.attachments.len()
                {
                    chat.attachments.remove(index);
                }
            }
            Message::RemoteChatSubmit => {
                if let (Some(sender), Some(chat)) = (
                    self.remote.command_sender.clone(),
                    self.remote.chat.as_mut(),
                ) {
                    let text = std::mem::take(&mut chat.input);
                    let attachments = std::mem::take(&mut chat.attachments);
                    if !text.trim().is_empty() || !attachments.is_empty() {
                        return send_remote_command(
                            sender,
                            remote::Command::ChatSend {
                                sid: chat.session_id.clone(),
                                text,
                                attachments,
                            },
                        );
                    }
                }
            }
            Message::RemoteChatInterrupt => {
                if let (Some(sender), Some(chat)) = (
                    self.remote.command_sender.clone(),
                    self.remote.chat.as_ref(),
                ) {
                    return send_remote_command(
                        sender,
                        remote::Command::Interrupt(chat.session_id.clone()),
                    );
                }
            }
            Message::RemotePermission { request_id, reply } => {
                if let (Some(sender), Some(chat)) = (
                    self.remote.command_sender.clone(),
                    self.remote.chat.as_ref(),
                ) {
                    return send_remote_command(
                        sender,
                        remote::Command::Permission {
                            sid: chat.session_id.clone(),
                            request_id,
                            reply,
                        },
                    );
                }
            }
            Message::RemoteQuestion {
                request_id,
                question_id,
                value,
            } => {
                if let (Some(sender), Some(chat)) = (
                    self.remote.command_sender.clone(),
                    self.remote.chat.as_ref(),
                ) {
                    return send_remote_command(
                        sender,
                        remote::Command::Question {
                            sid: chat.session_id.clone(),
                            request_id,
                            question_id,
                            value,
                        },
                    );
                }
            }
            Message::RemoteSessionKill(sid) => {
                self.remote.sessions.retain(|session| session.id != sid);
                if self
                    .remote
                    .terminal
                    .as_ref()
                    .map(|terminal| &terminal.session_id)
                    == Some(&sid)
                {
                    self.remote.terminal = None;
                }
                if self.remote.chat.as_ref().map(|chat| &chat.session_id) == Some(&sid) {
                    self.remote.chat = None;
                }
                if let Some(sender) = self.remote.command_sender.clone() {
                    return send_remote_command(sender, remote::Command::Kill(sid));
                }
            }
            Message::RemoteCommandSent(result) => {
                if let Err(error) = result {
                    self.remote.error = Some(error);
                }
            }
            Message::RemoteEvent(event) => return self.handle_remote_event(event),
            Message::UpdateChecked(result) => {
                self.update = match result {
                    Ok(Some(release)) => UpdateState::Available(release),
                    Ok(None) => UpdateState::Current,
                    Err(error) => UpdateState::Failed(error),
                };
            }
            Message::UpdateDownload => {
                if let UpdateState::Available(release) = &self.update {
                    let release = release.clone();
                    self.update = UpdateState::Downloading(release.clone());
                    return Task::perform(download_update(release), Message::UpdateDownloaded);
                }
            }
            Message::UpdateDismiss => self.update = UpdateState::Dismissed,
            Message::UpdateDownloaded(result) => {
                self.update = match result {
                    Ok(path) => UpdateState::Downloaded(path),
                    Err(error) => UpdateState::Failed(error),
                };
            }
            Message::SessionSearchChanged(value) => {
                self.session_search = value.clone();
                self.local_archive_view = false;
                self.session_loading = true;
                return Task::perform(
                    load_session_page(value, self.session_lifecycle, None, false),
                    |result| Message::SessionPageLoaded(Box::new(result)),
                );
            }
            Message::SessionLifecycleChanged(lifecycle) => {
                self.local_archive_view = false;
                self.session_lifecycle = lifecycle;
                self.session_loading = true;
                return Task::perform(
                    load_session_page(self.session_search.clone(), lifecycle, None, false),
                    |result| Message::SessionPageLoaded(Box::new(result)),
                );
            }
            Message::SessionLoadMore => {
                if let Some(cursor) = self.session_next_cursor.clone() {
                    self.session_loading = true;
                    return Task::perform(
                        load_session_page(
                            self.session_search.clone(),
                            self.session_lifecycle,
                            Some(cursor),
                            true,
                        ),
                        |result| Message::SessionPageLoaded(Box::new(result)),
                    );
                }
            }
            Message::SessionLocalArchive => {
                self.local_archive_view = true;
                self.session_loading = true;
                self.session_search.clear();
                return Task::perform(
                    load_local_archive(self.preferences.archived_session_ids.clone()),
                    |result| Message::SessionLocalArchiveLoaded(Box::new(result)),
                );
            }
            Message::SessionLocalArchiveLoaded(result) => match *result {
                Ok(sessions) if self.local_archive_view => {
                    self.session_total = sessions.len() as i64;
                    self.sessions = sessions;
                    self.session_next_cursor = None;
                    self.session_has_more = false;
                    self.session_loading = false;
                    self.status = LoadState::Ready;
                }
                Ok(_) => {}
                Err(error) => {
                    self.session_loading = false;
                    self.session_error = Some(error);
                }
            },
            Message::SessionPageLoaded(result) => match *result {
                Ok(loaded)
                    if loaded.query == self.session_search
                        && loaded.lifecycle == self.session_lifecycle =>
                {
                    if loaded.append {
                        for session in loaded.page.items {
                            if !self.sessions.iter().any(|item| item.id == session.id) {
                                self.sessions.push(session);
                            }
                        }
                    } else {
                        self.sessions = loaded.page.items;
                    }
                    self.session_next_cursor = loaded.page.next_cursor;
                    self.session_has_more = loaded.page.has_more;
                    self.session_total = loaded.page.total;
                    self.session_loading = false;
                    self.status = LoadState::Ready;
                }
                Ok(_) => {}
                Err(error) => {
                    self.session_loading = false;
                    self.status = LoadState::Failed(error);
                }
            },
            Message::SessionArchiveToggle(id) => {
                let archived = self
                    .preferences
                    .archived_session_ids
                    .iter()
                    .any(|value| value == &id);
                self.session_error = self.preferences.set_session_archived(&id, !archived).err();
                if self.local_archive_view && archived && self.session_error.is_none() {
                    self.sessions.retain(|session| session.id != id);
                    self.session_total = self.sessions.len() as i64;
                }
            }
            Message::SessionCreateOpen => {
                self.create_session = Some(CreateSessionState {
                    resume_loading: true,
                    ..CreateSessionState::default()
                });
                return Task::perform(
                    search_conversations(AgentKind::Claude, String::new()),
                    |result| Message::SessionResumeLoaded(Box::new(result)),
                );
            }
            Message::SessionCreateCancel => self.create_session = None,
            Message::SessionTitleChanged(value) => {
                if let Some(state) = self.create_session.as_mut() {
                    state.title = value;
                }
            }
            Message::SessionWorkspaceChanged(value) => {
                if let Some(state) = self.create_session.as_mut() {
                    state.workspace = value;
                }
            }
            Message::SessionAgentChanged(agent) => {
                if let Some(state) = self.create_session.as_mut() {
                    state.agent = agent;
                    state.selected_resume = None;
                    state.resume_results.clear();
                    if matches!(agent, AgentKind::Shell | AgentKind::Grok | AgentKind::Trae) {
                        state.kind = SessionKind::Pty;
                    }
                    if resumable_agent(agent) && state.kind == SessionKind::Structured {
                        state.resume_loading = true;
                        let query = state.resume_query.clone();
                        return Task::perform(search_conversations(agent, query), |result| {
                            Message::SessionResumeLoaded(Box::new(result))
                        });
                    }
                    state.resume_loading = false;
                }
            }
            Message::SessionKindChanged(kind) => {
                if let Some(state) = self.create_session.as_mut() {
                    state.kind = kind;
                    state.selected_resume = None;
                    if kind == SessionKind::Structured && resumable_agent(state.agent) {
                        state.resume_loading = true;
                        let agent = state.agent;
                        let query = state.resume_query.clone();
                        return Task::perform(search_conversations(agent, query), |result| {
                            Message::SessionResumeLoaded(Box::new(result))
                        });
                    }
                    state.resume_loading = false;
                    state.resume_results.clear();
                }
            }
            Message::SessionResumeQueryChanged(value) => {
                if let Some(state) = self.create_session.as_mut() {
                    state.resume_query = value;
                    state.selected_resume = None;
                }
            }
            Message::SessionResumeSearch => {
                if let Some(state) = self.create_session.as_mut()
                    && resumable_agent(state.agent)
                    && state.kind == SessionKind::Structured
                {
                    state.resume_loading = true;
                    state.error = None;
                    let agent = state.agent;
                    let query = state.resume_query.clone();
                    return Task::perform(search_conversations(agent, query), |result| {
                        Message::SessionResumeLoaded(Box::new(result))
                    });
                }
            }
            Message::SessionResumeLoaded(result) => match *result {
                Ok((agent, query, conversations)) => {
                    if let Some(state) = self.create_session.as_mut()
                        && state.agent == agent
                        && state.resume_query == query
                    {
                        state.resume_results = conversations;
                        state.resume_loading = false;
                    }
                }
                Err(error) => {
                    if let Some(state) = self.create_session.as_mut() {
                        state.resume_loading = false;
                        state.error = Some(error);
                    }
                }
            },
            Message::SessionResumeSelected(id) => {
                if let Some(state) = self.create_session.as_mut() {
                    let selected = state
                        .resume_results
                        .iter()
                        .find(|conversation| conversation.id == id)
                        .cloned();
                    state.selected_resume = if state.selected_resume.as_ref().map(|item| &item.id)
                        == selected.as_ref().map(|item| &item.id)
                    {
                        None
                    } else {
                        selected
                    };
                    if let Some(conversation) = &state.selected_resume {
                        state.title = conversation.title.clone();
                        state.workspace = conversation.cwd.clone();
                    }
                }
            }
            Message::SessionCreateSubmit => {
                if let Some(state) = self.create_session.clone() {
                    return Task::perform(create_session(state), Message::SessionCreated);
                }
            }
            Message::SessionCreated(result) => match result {
                Ok(session) => {
                    self.create_session = None;
                    let id = session.id.clone();
                    self.sessions.insert(0, session);
                    return self.update(Message::SelectSession(id));
                }
                Err(error) => {
                    if let Some(state) = self.create_session.as_mut() {
                        state.error = Some(error);
                    }
                }
            },
            Message::SessionClose => self.pending_session_close = true,
            Message::SessionCloseCancel => self.pending_session_close = false,
            Message::SessionCloseConfirm => {
                self.pending_session_close = false;
                if let Some(session) = self
                    .selected_session
                    .as_deref()
                    .and_then(|id| self.sessions.iter().find(|session| session.id == id))
                    .cloned()
                {
                    return Task::perform(close_session(session), Message::SessionClosed);
                }
            }
            Message::SessionClosed(result) => match result {
                Ok(()) => {
                    self.selected_session = None;
                    self.terminal = None;
                    self.timeline.clear();
                    self.project = None;
                    return Task::perform(load(), |result| Message::Loaded(Box::new(result)));
                }
                Err(error) => self.chat_error = Some(error),
            },
            Message::AgentControlsLoaded(result) => match *result {
                Ok(controls) if self.selected_session.as_deref() == Some(&controls.session_id) => {
                    self.agent_controls = Some(controls);
                }
                Ok(_) => {}
                Err(error) => self.chat_error = Some(error),
            },
            Message::AgentSetMode(mode) => {
                if let Some(id) = self.selected_session.clone() {
                    return Task::perform(
                        agent_control(id, "mode", Some(mode)),
                        Message::AgentControlMutated,
                    );
                }
            }
            Message::AgentSetModel(model) => {
                if let Some(id) = self.selected_session.clone() {
                    return Task::perform(
                        agent_control(id, "model", Some(model)),
                        Message::AgentControlMutated,
                    );
                }
            }
            Message::AgentSetApproval(policy) => {
                if let Some(controls) = self.agent_controls.as_mut() {
                    controls.approval_policy = policy.clone();
                }
                if let Some(id) = self.selected_session.clone() {
                    return Task::perform(
                        agent_control(id, "approval", Some(policy)),
                        Message::AgentControlMutated,
                    );
                }
            }
            Message::AgentSetEffort(effort) => {
                if let Some(id) = self.selected_session.clone()
                    && let Some(model) = self
                        .agent_controls
                        .as_ref()
                        .and_then(|controls| controls.models.as_ref())
                        .and_then(|models| models.current_model.clone())
                {
                    return Task::perform(
                        agent_set_model(id, model, Some(effort)),
                        Message::AgentControlMutated,
                    );
                }
            }
            Message::AgentCompact => {
                if let Some(id) = self.selected_session.clone() {
                    return Task::perform(
                        agent_control(id, "compact", None),
                        Message::AgentControlMutated,
                    );
                }
            }
            Message::AgentQueueAction { id, action } => {
                if let Some(session_id) = self.selected_session.clone() {
                    return Task::perform(
                        agent_queue_action(session_id, id, action),
                        Message::AgentControlMutated,
                    );
                }
            }
            Message::AgentControlMutated(result) => match result {
                Ok(session_id) => {
                    return Task::perform(load_agent_controls(session_id), |result| {
                        Message::AgentControlsLoaded(Box::new(result))
                    });
                }
                Err(error) => self.chat_error = Some(error),
            },
        }
        Task::none()
    }

    fn handle_remote_event(&mut self, event: remote::Event) -> Task<Message> {
        match event {
            remote::Event::Ready(sender) => {
                self.remote.command_sender = Some(sender.clone());
                if let Some(host_id) = self.remote.selected_host.clone() {
                    return send_remote_command(sender, remote::Command::Connect(host_id));
                }
            }
            remote::Event::Connecting(host_id) => {
                if self.remote.selected_host.as_deref() == Some(&host_id) {
                    self.remote.connection = "connecting".into();
                }
            }
            remote::Event::Connected {
                host_id,
                sessions,
                transport,
                workspace_roots,
            } => {
                if self.remote.selected_host.as_deref() == Some(&host_id) {
                    self.remote.connection = "connected".into();
                    self.remote.transport = Some(transport);
                    self.remote.workspace_roots = workspace_roots;
                    self.remote.sessions = sessions;
                    self.remote.error = None;
                    let refresh = Task::perform(remote::list_hosts(), Message::RemoteHostsLoaded);
                    if let Some(sender) = self.remote.command_sender.clone() {
                        let command =
                            if let Some((cwd, fresh)) = self.remote.pending_workspace_open.take() {
                                if fresh {
                                    remote::Command::CreateShell {
                                        cwd,
                                        request_id: uuid::Uuid::new_v4().to_string(),
                                    }
                                } else if let Some(session) =
                                    self.remote.sessions.iter().find(|item| {
                                        item.kind == SessionKind::Pty && item.cwd == cwd
                                    })
                                {
                                    let sid = session.id.clone();
                                    self.remote.terminal = Some(RemoteTerminalState {
                                        session_id: sid.clone(),
                                        model: TerminalModel::new(TerminalSize {
                                            cols: session.cols,
                                            rows: session.rows,
                                        }),
                                        seq: 0,
                                        input: String::new(),
                                    });
                                    remote::Command::Attach {
                                        sid,
                                        last_seq: None,
                                        previous: None,
                                    }
                                } else {
                                    remote::Command::CreateShell {
                                        cwd,
                                        request_id: uuid::Uuid::new_v4().to_string(),
                                    }
                                }
                            } else if let Some(terminal) = self.remote.terminal.as_ref() {
                                remote::Command::Attach {
                                    sid: terminal.session_id.clone(),
                                    last_seq: Some(terminal.seq),
                                    previous: None,
                                }
                            } else if let Some(chat) = self.remote.chat.as_ref() {
                                remote::Command::Attach {
                                    sid: chat.session_id.clone(),
                                    last_seq: Some(chat.seq),
                                    previous: None,
                                }
                            } else {
                                remote::Command::ListWorkspace {
                                    root: "home".into(),
                                    path: String::new(),
                                }
                            };
                        return Task::batch([refresh, send_remote_command(sender, command)]);
                    }
                    return refresh;
                }
            }
            remote::Event::Message(value) => {
                let kind = value.get("type").and_then(serde_json::Value::as_str);
                match kind {
                    Some("session.state") => {
                        if let Some(session) = value
                            .get("session")
                            .cloned()
                            .and_then(|value| serde_json::from_value(value).ok())
                        {
                            upsert_remote_session(&mut self.remote.sessions, session);
                        }
                    }
                    Some("session.create.result")
                        if value.get("ok") == Some(&serde_json::Value::Bool(true)) =>
                    {
                        if let Some(session) = value.get("session").cloned().and_then(|value| {
                            serde_json::from_value::<remote::RemoteSession>(value).ok()
                        }) {
                            let sid = session.id.clone();
                            upsert_remote_session(&mut self.remote.sessions, session.clone());
                            if session.kind == SessionKind::Pty {
                                self.remote.chat = None;
                                self.remote.terminal = Some(RemoteTerminalState {
                                    session_id: sid.clone(),
                                    model: TerminalModel::new(TerminalSize {
                                        cols: session.cols,
                                        rows: session.rows,
                                    }),
                                    seq: 0,
                                    input: String::new(),
                                });
                            } else {
                                self.remote.terminal = None;
                                self.remote.chat = Some(RemoteChatState {
                                    session_id: sid.clone(),
                                    events: Vec::new(),
                                    seq: 0,
                                    input: String::new(),
                                    attachments: Vec::new(),
                                });
                            }
                            if let Some(sender) = self.remote.command_sender.clone() {
                                return send_remote_command(
                                    sender,
                                    remote::Command::Attach {
                                        sid,
                                        last_seq: None,
                                        previous: None,
                                    },
                                );
                            }
                        }
                    }
                    Some("session.create.result") => {
                        self.remote.error = value
                            .get("error")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned);
                    }
                    Some("term.snapshot") | Some("term.output") => {
                        if let Some(terminal) = self.remote.terminal.as_mut()
                            && value.get("sid").and_then(serde_json::Value::as_str)
                                == Some(&terminal.session_id)
                        {
                            let bytes = value
                                .get("dataB64")
                                .and_then(serde_json::Value::as_str)
                                .and_then(|value| {
                                    base64::Engine::decode(
                                        &base64::engine::general_purpose::STANDARD,
                                        value,
                                    )
                                    .ok()
                                })
                                .unwrap_or_default();
                            let seq = value
                                .get("seq")
                                .and_then(serde_json::Value::as_i64)
                                .unwrap_or(terminal.seq);
                            if kind == Some("term.snapshot") {
                                let size = TerminalSize {
                                    cols: value
                                        .get("cols")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or(100)
                                        as u16,
                                    rows: value
                                        .get("rows")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or(30)
                                        as u16,
                                };
                                terminal.model.reset(size, &bytes);
                            } else {
                                terminal.model.feed(&bytes);
                            }
                            terminal.seq = terminal.seq.max(seq);
                        }
                    }
                    Some("chat.snapshot") => {
                        if let Some(chat) = self.remote.chat.as_mut()
                            && value.get("sid").and_then(serde_json::Value::as_str)
                                == Some(&chat.session_id)
                        {
                            chat.events = value
                                .get("events")
                                .and_then(serde_json::Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            chat.seq = value
                                .get("evSeq")
                                .and_then(serde_json::Value::as_i64)
                                .unwrap_or_default();
                        }
                    }
                    Some("agent.event") => {
                        if let Some(chat) = self.remote.chat.as_mut()
                            && value.get("sid").and_then(serde_json::Value::as_str)
                                == Some(&chat.session_id)
                            && let Some(body) = value.get("body").cloned()
                        {
                            merge_remote_chat_event(&mut chat.events, body);
                            chat.seq = value
                                .get("evSeq")
                                .and_then(serde_json::Value::as_i64)
                                .unwrap_or(chat.seq);
                        }
                    }
                    Some("error") => {
                        self.remote.error = value
                            .get("message")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned);
                    }
                    Some("workspace.listing") => {
                        if let Ok(listing) =
                            serde_json::from_value::<remote::WorkspaceListing>(value)
                        {
                            self.remote.error = listing.error.clone();
                            self.remote.listing = Some(listing);
                        }
                    }
                    _ => {}
                }
            }
            remote::Event::Disconnected {
                host_id,
                error,
                retrying,
            } => {
                if self.remote.selected_host.as_deref() == Some(&host_id) {
                    self.remote.connection =
                        if retrying { "reconnecting" } else { "offline" }.into();
                    self.remote.error = Some(error);
                }
            }
        }
        Task::none()
    }

    fn subscription(&self) -> Subscription<Message> {
        let mut subscriptions = vec![
            window::close_events().map(|_| Message::WindowClosed),
            iced::system::theme_changes().map(Message::SystemThemeChanged),
            Subscription::run(remote::subscription).map(Message::RemoteEvent),
        ];
        if self.selected_session.is_some() && self.terminal.is_none() {
            subscriptions.push(
                iced::time::every(std::time::Duration::from_millis(750))
                    .map(|_| Message::RefreshTimeline),
            );
        }
        Subscription::batch(subscriptions)
    }

    fn theme(&self) -> Theme {
        self.mode.iced()
    }

    fn style(&self, _: &Theme) -> iced::theme::Style {
        iced::theme::Style {
            background_color: self.mode.tokens().background,
            text_color: self.mode.tokens().text,
        }
    }

    fn view(&self) -> Element<'_, Message> {
        let content = match self.page {
            Page::Workspaces => self.content(),
            Page::Orchestration => self.orchestration_view(),
            Page::Schedules => self.schedules_view(),
            Page::Accounts => self.accounts_view(),
            Page::Remote => self.remote_view(),
            Page::Operations => self.operations_view(),
        };
        let main = row![self.sidebar(), content].height(Fill);
        if self.page == Page::Workspaces && self.selected_session.is_some() {
            row![main, self.project_dock()].height(Fill).into()
        } else {
            main.into()
        }
    }

    fn project_dock(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let Some(project) = &self.project else {
            return container(text("Project").color(tokens.muted))
                .width(360)
                .padding(16)
                .into();
        };
        let mut list = column![text("项目文件").size(theme::TEXT_LEAD)].spacing(5);
        if let Some(git) = &project.git {
            list = list.push(
                text(format!(
                    "{} · {} changed · ↑{} ↓{}",
                    git.branch.as_deref().unwrap_or("detached"),
                    git.files.len(),
                    git.ahead,
                    git.behind
                ))
                .size(theme::TEXT_CAPTION)
                .color(tokens.muted),
            );
            for file in &git.files {
                let staged = !file.untracked && file.index != " ";
                let changed = file.untracked || file.worktree != " ";
                let mut actions = row![
                    button(text(format!(
                        "{} {}",
                        if file.untracked {
                            "U"
                        } else if staged {
                            &file.index
                        } else {
                            &file.worktree
                        },
                        file.path
                    )))
                    .on_press(Message::ProjectDiffSelected {
                        path: file.path.clone(),
                        staged
                    })
                    .width(Fill),
                ]
                .spacing(4);
                if staged {
                    actions = actions.push(button("−").on_press(Message::GitStage {
                        paths: vec![file.path.clone()],
                        unstage: true,
                    }));
                } else if changed {
                    actions = actions.push(button("+").on_press(Message::GitStage {
                        paths: vec![file.path.clone()],
                        unstage: false,
                    }));
                    if !file.untracked {
                        actions = actions.push(
                            button("丢弃").on_press(Message::GitDiscardRequest(file.path.clone())),
                        );
                    }
                }
                list = list.push(actions);
            }
            list = list.push(
                row![
                    text_input("提交说明", &project.commit_message)
                        .on_input(Message::GitCommitInputChanged)
                        .on_submit(Message::GitCommit)
                        .width(Fill),
                    button("提交").on_press(Message::GitCommit),
                ]
                .spacing(5),
            );
            for entry in project.history.iter().take(5) {
                list = list.push(
                    text(format!("{}  {}", entry.hash, entry.subject))
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.muted),
                );
            }
        }
        for entry in &project.entries {
            let label = if entry.kind == "dir" {
                format!("▸ {}", entry.name)
            } else {
                entry.name.clone()
            };
            let mut item = button(text(label).size(theme::TEXT_SMALL))
                .width(Fill)
                .style(theme::navigation(
                    self.mode,
                    project.selected_path.as_deref() == Some(&entry.name),
                ));
            if entry.kind == "file" {
                item = item.on_press(Message::ProjectFileSelected(entry.name.clone()));
            }
            list = list.push(item);
        }
        if project.loading {
            list = list.push(
                text("正在读取…")
                    .size(theme::TEXT_CAPTION)
                    .color(tokens.muted),
            );
        }
        if let Some(error) = &project.error {
            list = list.push(text(error).size(theme::TEXT_CAPTION).color(tokens.danger));
        }
        if let Some(path) = &project.pending_discard {
            list = list.push(
                column![
                    text(format!("确认丢弃 {path} 的未提交修改？"))
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.danger),
                    row![
                        button("取消").on_press(Message::GitDiscardCancel),
                        button("确认丢弃").on_press(Message::GitDiscardConfirm),
                    ]
                    .spacing(5),
                ]
                .spacing(5),
            );
        }
        let preview: Element<'_, Message> = if let Some(diff) = &project.diff {
            container(
                scrollable(
                    text(diff)
                        .font(iced::Font::MONOSPACE)
                        .size(theme::TEXT_CAPTION),
                )
                .height(Fill),
            )
            .height(Fill)
            .padding(10)
            .style(theme::panel(self.mode))
            .into()
        } else {
            match &project.preview {
                Some(preview) if preview.binary => {
                    text("二进制文件无法预览").color(tokens.muted).into()
                }
                Some(preview) => {
                    let source = String::from_utf8_lossy(&preview.bytes);
                    let body: Element<'_, Message> = if project.editing {
                        text_editor(&project.draft)
                            .on_action(Message::ProjectEdit)
                            .height(Fill)
                            .font(iced::Font::MONOSPACE)
                            .into()
                    } else {
                        scrollable(
                            text(source.into_owned())
                                .font(iced::Font::MONOSPACE)
                                .size(theme::TEXT_CAPTION),
                        )
                        .height(Fill)
                        .into()
                    };
                    container(
                        column![
                            row![
                                text(&preview.path).size(theme::TEXT_CAPTION).width(Fill),
                                button(if project.editing { "保存" } else { "编辑" }).on_press(
                                    if project.editing {
                                        Message::ProjectSave
                                    } else {
                                        Message::ProjectToggleEdit
                                    }
                                ),
                            ]
                            .align_y(Alignment::Center),
                            body,
                        ]
                        .spacing(6),
                    )
                    .height(Fill)
                    .padding(10)
                    .style(theme::panel(self.mode))
                    .into()
                }
                None => text("选择文件查看内容").color(tokens.muted).into(),
            }
        };
        container(column![scrollable(list).height(260), preview].spacing(12))
            .width(360)
            .height(Fill)
            .padding([24, 14])
            .style(theme::sidebar(self.mode))
            .into()
    }

    fn orchestration_view(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let mut runs = column![
            row![
                text("Runs").size(theme::TEXT_LEAD).width(Fill),
                button("新建").on_press(Message::RunCreateOpen),
            ]
            .align_y(Alignment::Center)
        ]
        .spacing(5);
        for run in self.orchestration.runs.iter().take(100) {
            runs = runs.push(
                button(
                    column![
                        text(&run.objective).size(theme::TEXT_SMALL),
                        text(format!("{:?}", run.status))
                            .size(theme::TEXT_CAPTION)
                            .color(tokens.muted),
                    ]
                    .spacing(2),
                )
                .width(Fill)
                .on_press(Message::SelectRun(run.id.clone()))
                .style(theme::navigation(
                    self.mode,
                    self.orchestration.selected_run.as_deref() == Some(&run.id),
                )),
            );
        }
        let detail: Element<'_, Message> = if let Some(form) = &self.orchestration.run_form {
            container(
                column![
                    text("新建编排 Run").size(theme::TEXT_LEAD),
                    text_input("目标", &form.objective).on_input(Message::RunObjectiveChanged),
                    text_input("每行一个任务", &form.task_lines)
                        .on_input(Message::RunTaskLinesChanged),
                    text_input("Skills，逗号分隔（可选）", &form.skills)
                        .on_input(Message::RunSkillsChanged),
                    text("任务按输入顺序串联依赖；创建后可逐项编辑。")
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.muted),
                    row![
                        button("取消").on_press(Message::RunFormCancel),
                        button("创建任务图").on_press(Message::RunCreateSubmit),
                    ]
                    .spacing(6),
                ]
                .spacing(9),
            )
            .padding(14)
            .style(theme::panel(self.mode))
            .into()
        } else if self.orchestration.loading {
            container(text("正在加载编排…").color(tokens.muted))
                .center(Fill)
                .into()
        } else if let Some(error) = &self.orchestration.error {
            container(text(error).color(tokens.danger))
                .center(Fill)
                .into()
        } else if let Some(snapshot) = &self.orchestration.snapshot {
            let mut graph = column![
                row![
                    text(&snapshot.run.objective).size(20).width(Fill),
                    button("新增任务").on_press_maybe(
                        matches!(snapshot.run.status, prospero_protocol_rs::RunStatus::Active)
                            .then_some(Message::TaskCreateOpen)
                    ),
                    button("暂停自动化").on_press_maybe(snapshot.run.automation.as_ref().and_then(
                        |automation| {
                            matches!(
                                automation.state,
                                prospero_protocol_rs::AutomationState::Running
                            )
                            .then(|| Message::PauseAutomation(snapshot.run.id.clone()))
                        }
                    )),
                ]
                .align_y(Alignment::Center),
                text(format!(
                    "{:?} · graph revision {} · {} tasks · {} dispatches · {} gates · {} worktrees",
                    snapshot.run.status,
                    snapshot.run.graph_revision,
                    snapshot.tasks.len(),
                    snapshot.dispatches.len(),
                    snapshot.gates.len(),
                    self.orchestration.worktrees.len(),
                ))
                .size(theme::TEXT_CAPTION)
                .color(tokens.muted),
            ]
            .spacing(9);
            if let Some(form) = &self.orchestration.task_form {
                graph = graph.push(
                    container(
                        column![
                            text(if form.id.is_some() {
                                "编辑任务"
                            } else {
                                "新增任务"
                            })
                            .size(theme::TEXT_LEAD),
                            text_input("任务标题", &form.title).on_input(Message::TaskTitleChanged),
                            text_input("任务要求", &form.spec).on_input(Message::TaskSpecChanged),
                            text_input("Skills，逗号分隔", &form.skills)
                                .on_input(Message::TaskSkillsChanged),
                            text_input("依赖任务 ID，逗号分隔", &form.deps)
                                .on_input(Message::TaskDepsChanged),
                            row![
                                button("取消").on_press(Message::TaskFormCancel),
                                button("保存").on_press(Message::TaskSave),
                            ]
                            .spacing(6),
                        ]
                        .spacing(7),
                    )
                    .padding(10)
                    .width(Fill)
                    .style(theme::panel(self.mode)),
                );
            }
            for task in &snapshot.tasks {
                let color = match task.status {
                    TaskStatus::Done => tokens.success,
                    TaskStatus::Failed | TaskStatus::Cancelled => tokens.danger,
                    TaskStatus::Blocked => tokens.warning,
                    TaskStatus::Dispatched => tokens.accent,
                    _ => tokens.muted,
                };
                graph = graph.push(
                    container(
                        column![
                            row![
                                text(&task.title).size(theme::TEXT_BODY).width(Fill),
                                text(task.status.label())
                                    .size(theme::TEXT_CAPTION)
                                    .color(color),
                            ],
                            text(if task.deps.is_empty() {
                                "无依赖".to_owned()
                            } else {
                                format!("依赖: {}", task.deps.join(", "))
                            })
                            .size(theme::TEXT_CAPTION)
                            .color(tokens.muted),
                            text(&task.spec).size(theme::TEXT_SMALL),
                            row![
                                button("编辑").on_press_maybe(
                                    matches!(task.status, TaskStatus::Pending)
                                        .then(|| Message::TaskEditOpen(task.id.clone()))
                                ),
                                button("删除").on_press_maybe(
                                    matches!(task.status, TaskStatus::Pending).then(|| {
                                        Message::TaskDeleteRequest {
                                            id: task.id.clone(),
                                            title: task.title.clone(),
                                        }
                                    })
                                ),
                                button("重试").on_press_maybe(
                                    matches!(
                                        task.status,
                                        TaskStatus::Failed | TaskStatus::Cancelled
                                    )
                                    .then(|| {
                                        Message::RetryTask {
                                            run_id: snapshot.run.id.clone(),
                                            task_id: task.id.clone(),
                                        }
                                    }),
                                ),
                                button("取消").on_press_maybe(
                                    matches!(
                                        task.status,
                                        TaskStatus::Pending
                                            | TaskStatus::Dispatched
                                            | TaskStatus::Blocked
                                    )
                                    .then(|| {
                                        Message::CancelTask {
                                            run_id: snapshot.run.id.clone(),
                                            task_id: task.id.clone(),
                                        }
                                    }),
                                ),
                            ]
                            .spacing(6),
                        ]
                        .spacing(5),
                    )
                    .padding(10)
                    .width(Fill)
                    .style(theme::panel(self.mode)),
                );
            }
            if let Some((_, title)) = &self.orchestration.pending_task_delete {
                graph = graph.push(
                    container(
                        row![
                            text(format!("确认删除待执行任务「{title}」？"))
                                .color(tokens.danger)
                                .width(Fill),
                            button("取消").on_press(Message::TaskDeleteCancel),
                            button("确认删除").on_press(Message::TaskDeleteConfirm),
                        ]
                        .spacing(6),
                    )
                    .padding(10)
                    .width(Fill)
                    .style(theme::panel(self.mode)),
                );
            }
            for gate in snapshot
                .gates
                .iter()
                .filter(|gate| matches!(gate.status, prospero_protocol_rs::GateStatus::Pending))
            {
                let mut options = row![].spacing(6);
                for option in &gate.options {
                    options = options.push(button(text(option)).on_press(Message::ResolveGate {
                        run_id: snapshot.run.id.clone(),
                        gate_id: gate.id.clone(),
                        decision: option.clone(),
                    }));
                }
                graph = graph.push(
                    container(column![text(&gate.question), options].spacing(6))
                        .padding(10)
                        .width(Fill)
                        .style(theme::panel(self.mode)),
                );
            }
            if !self.orchestration.worktrees.is_empty() {
                graph = graph.push(text("Worktrees").size(theme::TEXT_LEAD));
            }
            for asset in &self.orchestration.worktrees {
                let safe = asset.last_inspection.as_ref().is_some_and(|inspection| {
                    matches!(
                        inspection.state,
                        WorktreeAssetState::SafeToClean | WorktreeAssetState::Equivalent
                    )
                });
                graph = graph.push(
                    container(
                        column![
                            row![
                                text(asset.branch.as_deref().unwrap_or("worktree"))
                                    .size(theme::TEXT_BODY)
                                    .width(Fill),
                                text(format!("{:?}", asset.state))
                                    .size(theme::TEXT_CAPTION)
                                    .color(if safe { tokens.success } else { tokens.warning }),
                            ],
                            text(&asset.path)
                                .size(theme::TEXT_CAPTION)
                                .color(tokens.muted),
                            row![
                                button("安全检查")
                                    .on_press(Message::WorktreeInspect(asset.id.clone())),
                                button("清理").on_press_maybe(
                                    safe.then(|| Message::WorktreeCleanupRequest(asset.id.clone()))
                                ),
                            ]
                            .spacing(6),
                        ]
                        .spacing(5),
                    )
                    .padding(10)
                    .width(Fill)
                    .style(theme::panel(self.mode)),
                );
            }
            if let Some(asset_id) = &self.orchestration.pending_worktree_cleanup {
                graph = graph.push(
                    container(
                        column![
                            text("确认清理已通过检查的 worktree？分支会保留。")
                                .color(tokens.danger),
                            text(asset_id).size(theme::TEXT_CAPTION).color(tokens.muted),
                            row![
                                button("取消").on_press(Message::WorktreeCleanupCancel),
                                button("确认清理").on_press(Message::WorktreeCleanupConfirm),
                            ]
                            .spacing(6),
                        ]
                        .spacing(5),
                    )
                    .padding(10)
                    .width(Fill)
                    .style(theme::panel(self.mode)),
                );
            }
            scrollable(graph).height(Fill).into()
        } else {
            container(text("选择一个 Run").color(tokens.muted))
                .center(Fill)
                .into()
        };
        row![
            container(scrollable(runs).height(Fill))
                .width(235)
                .height(Fill)
                .padding(10)
                .style(theme::sidebar(self.mode)),
            container(detail).width(Fill).height(Fill).padding([24, 28]),
        ]
        .height(Fill)
        .into()
    }

    fn schedules_view(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let mut content = column![
            row![
                text("定时任务与插件服务").size(22).width(Fill),
                button("新建调度").on_press(Message::ScheduleCreateOpen),
            ]
            .align_y(Alignment::Center)
        ]
        .spacing(10);
        if self.management.loading {
            content = content.push(text("正在读取运行配置…").color(tokens.muted));
        }
        if let Some(error) = &self.management.error {
            content = content.push(text(error).color(tokens.danger));
        }
        content = content.push(text("Schedules").size(theme::TEXT_LEAD));
        if let Some(form) = &self.management.schedule_form {
            let mut agents = row![].spacing(5);
            for agent in [AgentKind::Claude, AgentKind::Codex, AgentKind::Deepseek] {
                agents = agents.push(
                    button(text(format!("{agent:?}")))
                        .on_press(Message::ScheduleAgentChanged(agent))
                        .style(theme::navigation(self.mode, form.agent == agent)),
                );
            }
            content = content.push(
                container(
                    column![
                        text(if form.id.is_some() {
                            "编辑调度"
                        } else {
                            "新建调度"
                        })
                        .size(theme::TEXT_LEAD),
                        text_input("名称", &form.name).on_input(Message::ScheduleNameChanged),
                        text_input("执行提示词", &form.prompt)
                            .on_input(Message::SchedulePromptChanged),
                        text_input("RRULE，例如 FREQ=DAILY;INTERVAL=1", &form.rrule)
                            .on_input(Message::ScheduleRruleChanged),
                        text_input("工作区绝对路径", &form.cwd)
                            .on_input(Message::ScheduleCwdChanged),
                        agents,
                        row![
                            button("取消").on_press(Message::ScheduleFormCancel),
                            button("保存").on_press(Message::ScheduleSave),
                        ]
                        .spacing(6),
                    ]
                    .spacing(8),
                )
                .padding(12)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        for schedule in &self.management.schedules {
            let enabled = matches!(schedule.status, ScheduledAgentTaskStatus::Enabled);
            content = content.push(
                container(
                    column![
                        row![
                            text(&schedule.name).size(theme::TEXT_BODY).width(Fill),
                            text(if enabled { "ENABLED" } else { "PAUSED" })
                                .size(theme::TEXT_CAPTION)
                                .color(if enabled {
                                    tokens.success
                                } else {
                                    tokens.muted
                                }),
                        ],
                        text(format!("{} · {}", schedule.rrule, schedule.cwd))
                            .size(theme::TEXT_CAPTION)
                            .color(tokens.muted),
                        row![
                            button(if enabled { "暂停" } else { "恢复" }).on_press(if enabled {
                                Message::SchedulePause(schedule.id.clone())
                            } else {
                                Message::ScheduleResume(schedule.id.clone())
                            }),
                            button("立即运行").on_press(Message::ScheduleRun(schedule.id.clone())),
                            button("编辑")
                                .on_press(Message::ScheduleEditOpen(Box::new(schedule.clone()))),
                            button("删除").on_press(Message::ScheduleDeleteRequest {
                                id: schedule.id.clone(),
                                name: schedule.name.clone(),
                            }),
                        ]
                        .spacing(6),
                    ]
                    .spacing(6),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        if let Some((_, name)) = &self.management.pending_schedule_delete {
            content = content.push(
                container(
                    row![
                        text(format!("确认删除调度“{name}”？"))
                            .color(tokens.danger)
                            .width(Fill),
                        button("取消").on_press(Message::ScheduleDeleteCancel),
                        button("确认删除").on_press(Message::ScheduleDeleteConfirm),
                    ]
                    .spacing(6)
                    .align_y(Alignment::Center),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        content = content.push(text("Plugin services").size(theme::TEXT_LEAD));
        for service in &self.management.plugin_services.items {
            let running = matches!(service.status, PluginServiceStatus::Running);
            content = content.push(
                container(
                    column![
                        row![
                            text(format!("{} / {}", service.plugin_id, service.service_id))
                                .size(theme::TEXT_BODY)
                                .width(Fill),
                            text(format!("{:?} · {:?}", service.status, service.health))
                                .size(theme::TEXT_CAPTION)
                                .color(if running {
                                    tokens.success
                                } else {
                                    tokens.muted
                                }),
                        ],
                        row![
                            button(if running { "停止" } else { "启动" }).on_press(
                                Message::PluginAction {
                                    plugin: service.plugin_id.clone(),
                                    service: service.service_id.clone(),
                                    action: if running { "stop" } else { "start" }.into(),
                                },
                            ),
                            button("重启").on_press(Message::PluginAction {
                                plugin: service.plugin_id.clone(),
                                service: service.service_id.clone(),
                                action: "restart".into(),
                            }),
                            button("健康检查").on_press(Message::PluginAction {
                                plugin: service.plugin_id.clone(),
                                service: service.service_id.clone(),
                                action: "health".into(),
                            }),
                        ]
                        .spacing(6),
                    ]
                    .spacing(6),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        container(scrollable(content).height(Fill))
            .width(Fill)
            .height(Fill)
            .padding([24, 28])
            .into()
    }

    fn accounts_view(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let mut content = column![
            row![
                text("账号与模型源").size(22).width(Fill),
                button("新建托管账号").on_press(Message::AccountCreateOpen { api: false }),
                button("新建 API Profile").on_press(Message::AccountCreateOpen { api: true }),
            ]
            .spacing(6)
            .align_y(Alignment::Center)
        ]
        .spacing(10);
        if self.management.loading {
            content = content.push(text("正在读取账号…").color(tokens.muted));
        }
        if let Some(error) = &self.management.error {
            content = content.push(text(error).color(tokens.danger));
        }
        if let Some(form) = &self.management.account_form {
            let mut agents = row![].spacing(5);
            for agent in [AgentKind::Claude, AgentKind::Codex, AgentKind::Opencode] {
                agents = agents.push(
                    button(text(format!("{agent:?}")))
                        .on_press(Message::AccountAgentChanged(agent))
                        .style(theme::navigation(self.mode, form.agent == agent)),
                );
            }
            let mut fields = column![
                text(if form.id.is_some() {
                    "编辑账号"
                } else if form.api {
                    "新建 API Profile"
                } else {
                    "新建托管账号"
                })
                .size(theme::TEXT_LEAD),
                text_input("账号名称", &form.name).on_input(Message::AccountNameChanged),
                agents,
            ]
            .spacing(8);
            if form.api {
                fields = fields
                    .push(
                        text_input("API Base URL", &form.base_url)
                            .on_input(Message::AccountBaseUrlChanged),
                    )
                    .push(text_input("模型", &form.model).on_input(Message::AccountModelChanged))
                    .push(
                        text_input("API Key（留空则保留现有凭据）", &form.api_key)
                            .secure(true)
                            .on_input(Message::AccountApiKeyChanged),
                    );
            }
            fields = fields.push(
                row![
                    button("取消").on_press(Message::AccountFormCancel),
                    button("保存").on_press(Message::AccountSave),
                ]
                .spacing(6),
            );
            content = content.push(
                container(fields)
                    .padding(12)
                    .width(Fill)
                    .style(theme::panel(self.mode)),
            );
        }
        for account in &self.management.accounts {
            let source = account
                .model_source
                .as_ref()
                .map(|source| format!("{} / {}", source.source_name, source.route_name))
                .unwrap_or_else(|| "本机运行时".to_owned());
            content = content.push(
                container(
                    column![
                        row![
                            text(&account.name).size(theme::TEXT_BODY).width(Fill),
                            text(&account.status)
                                .size(theme::TEXT_CAPTION)
                                .color(tokens.muted),
                        ],
                        text(format!(
                            "{:?} · {} · {} active",
                            account.agent, source, account.active_sessions
                        ))
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.muted),
                        text(account.detail.as_deref().unwrap_or_default())
                            .size(theme::TEXT_CAPTION),
                        row![
                            button("编辑")
                                .on_press(Message::AccountEditOpen(Box::new(account.clone()))),
                            button("设为默认").on_press_maybe(
                                (!account.is_default)
                                    .then(|| Message::AccountSetDefault(account.id.clone()))
                            ),
                            button(if account.status == "signed_in" {
                                "退出登录"
                            } else {
                                "登录"
                            })
                            .on_press_maybe(
                                (account.managed && account.api_profile.is_none()).then(|| {
                                    if account.status == "signed_in" {
                                        Message::AccountActionRequest {
                                            id: account.id.clone(),
                                            name: account.name.clone(),
                                            action: "logout".into(),
                                        }
                                    } else {
                                        Message::AccountLogin(account.id.clone())
                                    }
                                })
                            ),
                            button("删除").on_press_maybe(
                                (account.managed && account.active_sessions == 0).then(|| {
                                    Message::AccountActionRequest {
                                        id: account.id.clone(),
                                        name: account.name.clone(),
                                        action: "delete".into(),
                                    }
                                })
                            ),
                        ]
                        .spacing(6),
                    ]
                    .spacing(5),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        if let Some((_, name, action)) = &self.management.pending_account_action {
            content = content.push(
                container(
                    row![
                        text(format!(
                            "确认{}账号“{name}”？",
                            if action == "delete" {
                                "删除"
                            } else {
                                "退出"
                            }
                        ))
                        .color(tokens.danger)
                        .width(Fill),
                        button("取消").on_press(Message::AccountActionCancel),
                        button("确认").on_press(Message::AccountActionConfirm),
                    ]
                    .spacing(6)
                    .align_y(Alignment::Center),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        content = content.push(
            row![
                text("Model sources").size(theme::TEXT_LEAD).width(Fill),
                button("新建模型源").on_press(Message::SourceCreateOpen),
            ]
            .align_y(Alignment::Center),
        );
        if let Some(form) = &self.management.source_form {
            let protocols = row![
                button("Anthropic")
                    .on_press(Message::SourceProtocolChanged("anthropic".into()))
                    .style(theme::navigation(self.mode, form.protocol == "anthropic")),
                button("OpenAI Responses")
                    .on_press(Message::SourceProtocolChanged("openai_responses".into()))
                    .style(theme::navigation(
                        self.mode,
                        form.protocol == "openai_responses"
                    )),
                button("OpenAI Chat")
                    .on_press(Message::SourceProtocolChanged(
                        "openai_chat_completions".into()
                    ))
                    .style(theme::navigation(
                        self.mode,
                        form.protocol == "openai_chat_completions"
                    )),
            ]
            .spacing(5);
            content = content.push(
                container(
                    column![
                        text("新建模型源").size(theme::TEXT_LEAD),
                        text_input("模型源名称", &form.name).on_input(Message::SourceNameChanged),
                        protocols,
                        text_input("API Base URL", &form.base_url)
                            .on_input(Message::SourceBaseUrlChanged),
                        text_input("凭据名称", &form.credential_name)
                            .on_input(Message::SourceCredentialNameChanged),
                        text_input("API Key", &form.api_key)
                            .secure(true)
                            .on_input(Message::SourceApiKeyChanged),
                        text_input("Route 名称", &form.route_name)
                            .on_input(Message::SourceRouteNameChanged),
                        text_input("模型 ID", &form.model).on_input(Message::SourceModelChanged),
                        row![
                            button("取消").on_press(Message::SourceFormCancel),
                            button("创建").on_press(Message::SourceCreateSubmit),
                        ]
                        .spacing(6),
                    ]
                    .spacing(8),
                )
                .padding(12)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        for source in &self.management.sources {
            let first_route = source.routes.first().and_then(|route| {
                route
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            });
            content = content.push(
                container(
                    column![
                        row![
                            text(&source.name).size(theme::TEXT_BODY).width(Fill),
                            text(if source.enabled {
                                "Enabled"
                            } else {
                                "Disabled"
                            })
                            .size(theme::TEXT_CAPTION)
                            .color(if source.enabled {
                                tokens.success
                            } else {
                                tokens.muted
                            }),
                        ],
                        text(format!(
                            "{} endpoints · {} credentials · {} routes",
                            source.endpoints.len(),
                            source.credentials.len(),
                            source.routes.len(),
                        ))
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.muted),
                        row![
                            button(if source.enabled { "停用" } else { "启用" }).on_press(
                                Message::SourceToggle {
                                    id: source.id.clone(),
                                    revision: source.revision,
                                    enabled: !source.enabled,
                                },
                            ),
                            button("绑定首个 Route").on_press_maybe(first_route.map(|route_id| {
                                Message::SourceBind {
                                    id: source.id.clone(),
                                    route_id,
                                    revision: source.revision,
                                }
                            })),
                            button("删除").on_press(Message::SourceDeleteRequest {
                                id: source.id.clone(),
                                name: source.name.clone(),
                                revision: source.revision,
                            }),
                        ]
                        .spacing(6),
                    ]
                    .spacing(5),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        if let Some((_, name, _)) = &self.management.pending_source_delete {
            content = content.push(
                container(
                    row![
                        text(format!("确认删除模型源“{name}”？已绑定账号会阻止删除。"))
                            .color(tokens.danger)
                            .width(Fill),
                        button("取消").on_press(Message::SourceDeleteCancel),
                        button("确认删除").on_press(Message::SourceDeleteConfirm),
                    ]
                    .spacing(6)
                    .align_y(Alignment::Center),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        container(scrollable(content).height(Fill))
            .width(Fill)
            .height(Fill)
            .padding([24, 28])
            .into()
    }

    fn remote_view(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let mut content = column![text("设备、配对与 Relay").size(22)].spacing(10);
        if self.remote.loading {
            content = content.push(text("正在同步远端配置…").color(tokens.muted));
        }
        if let Some(error) = &self.remote.error {
            content = content.push(text(error).color(tokens.danger));
        }
        content = content.push(text("连接其他电脑").size(theme::TEXT_LEAD));
        content = content.push(
            container(
                column![
                    text("配对凭据保存在系统安全存储中，不写入 Native Desktop 配置文件。")
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.muted),
                    row![
                        text_input("prospero://pair?d=…", &self.remote.import_value)
                            .on_input(Message::RemoteImportChanged)
                            .on_submit(Message::RemoteImport)
                            .secure(true)
                            .width(Fill),
                        button("导入").on_press(Message::RemoteImport),
                    ]
                    .spacing(6),
                ]
                .spacing(6),
            )
            .padding(10)
            .width(Fill)
            .style(theme::panel(self.mode)),
        );
        for host in &self.remote.hosts {
            let selected = self.remote.selected_host.as_deref() == Some(&host.id);
            let connected = selected && self.remote.connection == "connected";
            content = content.push(
                container(
                    column![
                        row![
                            text(&host.name).size(theme::TEXT_BODY).width(Fill),
                            text(if connected {
                                self.remote.transport.as_deref().unwrap_or("CONNECTED")
                            } else if selected {
                                &self.remote.connection
                            } else {
                                "offline"
                            })
                            .size(theme::TEXT_CAPTION)
                            .color(if connected {
                                tokens.success
                            } else {
                                tokens.muted
                            }),
                        ],
                        text(format!(
                            "{}:{} · Relay {}",
                            host.addrs
                                .first()
                                .map(String::as_str)
                                .unwrap_or("relay-only"),
                            host.port,
                            yes_no(host.has_relay),
                        ))
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.muted),
                        row![
                            if connected {
                                button("断开").on_press(Message::RemoteDisconnect)
                            } else {
                                button("连接").on_press(Message::RemoteConnect(host.id.clone()))
                            },
                            button("移除").on_press(Message::RemoteHostRemoveRequest(host.clone())),
                        ]
                        .spacing(6),
                    ]
                    .spacing(5),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        if let Some(host) = &self.remote.pending_host_remove {
            content = content.push(
                container(
                    row![
                        text(format!("确认移除「{}」及其系统凭据？", host.name))
                            .color(tokens.danger)
                            .width(Fill),
                        button("取消").on_press(Message::RemoteHostRemoveCancel),
                        button("确认移除").on_press(Message::RemoteHostRemoveConfirm),
                    ]
                    .spacing(6),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        if self.remote.connection == "connected" {
            content = content.push(
                row![
                    button("浏览 Home").on_press(Message::RemoteBrowseHome),
                    button("此电脑").on_press_maybe(
                        self.remote
                            .workspace_roots
                            .then_some(Message::RemoteBrowseComputer),
                    ),
                ]
                .spacing(6),
            );
            if let Some(listing) = &self.remote.listing {
                let mut browser = column![
                    row![
                        text(format!("远程目录 · {}", listing.cwd))
                            .size(theme::TEXT_BODY)
                            .width(Fill),
                        button("上一级").on_press(Message::RemoteBrowseUp),
                        button("固定工作区").on_press_maybe(
                            listing
                                .error
                                .is_none()
                                .then_some(Message::RemoteWorkspaceUse)
                        ),
                    ]
                    .spacing(6)
                    .align_y(Alignment::Center),
                ]
                .spacing(4);
                for entry in listing.entries.iter().filter(|entry| entry.kind == "dir") {
                    browser = browser.push(
                        button(text(format!("▸ {}", entry.name)).size(theme::TEXT_SMALL))
                            .on_press(Message::RemoteBrowseEnter(entry.name.clone()))
                            .width(Fill),
                    );
                }
                if let Some(error) = &listing.error {
                    browser = browser.push(text(error).color(tokens.danger));
                }
                content = content.push(
                    container(browser)
                        .padding(10)
                        .width(Fill)
                        .style(theme::panel(self.mode)),
                );
            }
            if !self.remote.workspaces.is_empty() {
                content = content.push(text("远程工作区").size(theme::TEXT_LEAD));
            }
            for workspace in self.remote.workspaces.iter().filter(|workspace| {
                self.remote.selected_host.as_deref() == Some(&workspace.host_id)
            }) {
                content = content.push(
                    container(
                        column![
                            row![
                                text(format!("{} · {}", workspace.name, workspace.host_name))
                                    .size(theme::TEXT_BODY)
                                    .width(Fill),
                                button("打开").on_press(Message::RemoteWorkspaceOpen {
                                    id: workspace.id.clone(),
                                    fresh: false,
                                }),
                                button("新 Shell").on_press(Message::RemoteWorkspaceOpen {
                                    id: workspace.id.clone(),
                                    fresh: true,
                                }),
                                button("移除")
                                    .on_press(Message::RemoteWorkspaceRemove(workspace.id.clone())),
                            ]
                            .spacing(5),
                            text(&workspace.cwd)
                                .size(theme::TEXT_CAPTION)
                                .color(tokens.muted),
                        ]
                        .spacing(3),
                    )
                    .padding(9)
                    .width(Fill)
                    .style(theme::panel(self.mode)),
                );
            }
            content = content.push(
                row![
                    text_input("远程工作区绝对路径", &self.remote.shell_cwd)
                        .on_input(Message::RemoteShellCwdChanged)
                        .on_submit(Message::RemoteShellCreate)
                        .width(Fill),
                    button("新建远程 Shell").on_press(Message::RemoteShellCreate),
                ]
                .spacing(6),
            );
            content = content.push(
                row![
                    button("新建 Claude").on_press(Message::RemoteAgentCreate(AgentKind::Claude)),
                    button("新建 Codex").on_press(Message::RemoteAgentCreate(AgentKind::Codex)),
                    button("新建 DeepSeek")
                        .on_press(Message::RemoteAgentCreate(AgentKind::Deepseek)),
                ]
                .spacing(6),
            );
            for session in &self.remote.sessions {
                content = content.push(
                    row![
                        button(
                            text(format!(
                                "{} · {:?} · {:?} · {:?}",
                                session.title, session.agent, session.kind, session.status
                            ))
                            .size(theme::TEXT_SMALL)
                        )
                        .on_press(Message::RemoteSessionSelect(session.id.clone()))
                        .width(Fill),
                        button("结束").on_press(Message::RemoteSessionKill(session.id.clone())),
                    ]
                    .spacing(5),
                );
                content = content.push(
                    text(&session.cwd)
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.muted),
                );
            }
            if let Some(terminal) = &self.remote.terminal {
                content = content.push(
                    container(
                        column![
                            row![
                                text(format!("远程终端 · {}", terminal.session_id))
                                    .size(theme::TEXT_LEAD)
                                    .width(Fill),
                                button("100×30").on_press(Message::RemoteTerminalResize(100, 30)),
                                button("160×48").on_press(Message::RemoteTerminalResize(160, 48)),
                            ]
                            .align_y(Alignment::Center),
                            container(
                                text(terminal.model.visible_text())
                                    .font(iced::Font::MONOSPACE)
                                    .size(13),
                            )
                            .padding(10)
                            .height(300)
                            .width(Fill)
                            .style(theme::terminal),
                            text_input("输入命令后按 Enter", &terminal.input)
                                .on_input(Message::RemoteTerminalInputChanged)
                                .on_submit(Message::RemoteTerminalSubmit),
                        ]
                        .spacing(7),
                    )
                    .padding(10)
                    .width(Fill)
                    .style(theme::panel(self.mode)),
                );
            }
            if let Some(chat) = &self.remote.chat {
                let mut messages = column![
                    row![
                        text(format!("远程对话 · {}", chat.session_id))
                            .size(theme::TEXT_LEAD)
                            .width(Fill),
                        button("中断").on_press(Message::RemoteChatInterrupt),
                    ]
                    .align_y(Alignment::Center)
                ]
                .spacing(6);
                for event in chat.events.iter().rev().take(120).rev() {
                    messages = messages.push(remote_event_view(event, self.mode));
                }
                let mut attachments = row![].spacing(5);
                for (index, attachment) in chat.attachments.iter().enumerate() {
                    attachments = attachments.push(
                        row![
                            text(attachment.name.as_deref().unwrap_or("图片"))
                                .size(theme::TEXT_CAPTION),
                            button("移除").on_press(Message::RemoteChatRemoveAttachment(index)),
                        ]
                        .spacing(4),
                    );
                }
                messages = messages.push(attachments).push(
                    row![
                        text_input("输入远程消息", &chat.input)
                            .on_input(Message::RemoteChatInputChanged)
                            .on_submit(Message::RemoteChatSubmit)
                            .width(Fill),
                        button("附件").on_press_maybe(
                            (chat.attachments.len() < 6).then_some(Message::RemoteChatAttach)
                        ),
                        button("发送").on_press(Message::RemoteChatSubmit),
                    ]
                    .spacing(6),
                );
                content = content.push(
                    container(messages)
                        .padding(10)
                        .width(Fill)
                        .style(theme::panel(self.mode)),
                );
            }
        }
        content = content.push(rule::horizontal(1));
        content = content.push(text("让其他设备连接本机").size(theme::TEXT_LEAD));
        if let Some(relay) = &self.remote.relay {
            content = content.push(
                container(
                    column![
                        row![
                            text(format!("Relay · {:?}", relay.runtime.state))
                                .size(theme::TEXT_LEAD)
                                .width(Fill),
                            text(format!(
                                "{} ready / {} devices",
                                relay.runtime.devices.ready, relay.runtime.devices.total
                            ))
                            .size(theme::TEXT_CAPTION)
                            .color(tokens.muted),
                        ],
                        text_input("wss://relay.example.com", &self.remote.relay_url)
                            .on_input(Message::RelayUrlChanged),
                        row![
                            if relay.runtime.enabled {
                                button("关闭 Relay").on_press(Message::RelayDisable)
                            } else {
                                button("启用 Relay").on_press(Message::RelayEnable)
                            },
                            button("轮换密钥").on_press(Message::RelayRotateRequest),
                            text(format!(
                                "{} active · {} failures",
                                relay.runtime.active_streams, relay.runtime.stream_failures
                            ))
                            .size(theme::TEXT_CAPTION)
                            .color(tokens.muted),
                        ]
                        .spacing(6),
                    ]
                    .spacing(8),
                )
                .padding(12)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        if self.remote.pending_rotate {
            content = content.push(
                container(
                    column![
                        text("轮换 Relay 密钥后，所有现有设备都必须重新配对。")
                            .color(tokens.danger),
                        row![
                            button("取消").on_press(Message::RelayRotateCancel),
                            button("确认轮换").on_press(Message::RelayRotateConfirm),
                        ]
                        .spacing(6),
                    ]
                    .spacing(8),
                )
                .padding(12)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        content = content.push(text("创建配对").size(theme::TEXT_LEAD));
        content = content.push(
            container(
                column![
                    text_input("设备名称", &self.remote.pairing_name)
                        .on_input(Message::PairingNameChanged),
                    checkbox(self.remote.allow_shell)
                        .label("允许 Shell 会话")
                        .on_toggle(Message::PairingShellChanged),
                    checkbox(self.remote.allow_orchestration)
                        .label("允许手工编排与 Worker 派发")
                        .on_toggle_maybe(
                            self.remote
                                .allow_shell
                                .then_some(Message::PairingOrchestrationChanged),
                        ),
                    button("生成一次性配对二维码").on_press(Message::PairingCreate),
                ]
                .spacing(8),
            )
            .padding(12)
            .width(Fill)
            .style(theme::panel(self.mode)),
        );
        if let Some(data) = &self.remote.pairing_qr {
            content = content.push(
                container(
                    column![
                        text("请现在扫码。关闭后不会再次显示凭据。").color(tokens.muted),
                        qr_code(data).cell_size(3.0),
                        button("完成").on_press(Message::PairingDismiss),
                    ]
                    .spacing(8)
                    .align_x(Alignment::Center),
                )
                .padding(14)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        content = content.push(text("已配对设备").size(theme::TEXT_LEAD));
        for device in &self.remote.devices {
            content = content.push(
                container(
                    column![
                        row![
                            text(&device.name).size(theme::TEXT_BODY).width(Fill),
                            text(if device.bound { "BOUND" } else { "PENDING" })
                                .size(theme::TEXT_CAPTION)
                                .color(if device.bound {
                                    tokens.success
                                } else {
                                    tokens.muted
                                }),
                        ],
                        text(format!(
                            "Shell {} · Orchestration {} · Relay {}",
                            yes_no(device.allow_shell),
                            yes_no(device.allow_orchestration),
                            yes_no(device.relay_ready),
                        ))
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.muted),
                        button("撤销").on_press(Message::DeviceRevokeRequest(device.clone())),
                    ]
                    .spacing(6),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        if let Some(device) = &self.remote.pending_revoke {
            content = content.push(
                container(
                    column![
                        text(format!("确认撤销“{}”？撤销后必须重新配对。", device.name))
                            .color(tokens.danger),
                        row![
                            button("取消").on_press(Message::DeviceRevokeCancel),
                            button("确认撤销").on_press(Message::DeviceRevokeConfirm),
                        ]
                        .spacing(6),
                    ]
                    .spacing(8),
                )
                .padding(12)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        container(scrollable(content).height(Fill))
            .width(Fill)
            .height(Fill)
            .padding([24, 28])
            .into()
    }

    fn operations_view(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let mut content = column![
            row![
                column![
                    text("Skills、用量与诊断").size(22),
                    text("读取 Rust daemon 与当前工作区的实时状态")
                        .size(theme::TEXT_SMALL)
                        .color(tokens.muted),
                ]
                .spacing(3)
                .width(Fill),
                button(if self.operations.loading {
                    "刷新中…"
                } else {
                    "刷新"
                })
                .on_press_maybe((!self.operations.loading).then_some(Message::OperationsRefresh)),
            ]
            .align_y(Alignment::Center),
            text_input("扫描 Skills 的工作区绝对路径", &self.operations.workspace)
                .on_input(Message::OperationsWorkspaceChanged)
                .on_submit(Message::OperationsRefresh),
            row![
                button("安装后台服务").on_press(Message::ServiceInstall),
                button("启动后台服务").on_press(Message::ServiceStart),
                button(if self.mode == Mode::Dark {
                    "浅色主题"
                } else {
                    "深色主题"
                })
                .on_press(Message::ToggleTheme),
            ]
            .spacing(6),
        ]
        .spacing(10);
        if let Some(error) = &self.operations.error {
            content = content.push(text(error).size(theme::TEXT_CAPTION).color(tokens.danger));
        }
        content = content.push(text("Agent 用量").size(theme::TEXT_LEAD));
        if let Some(usage) = &self.operations.usage
            && let Some(accounts) = &usage.accounts
        {
            for account in accounts {
                let tokens_used = account.input_tokens.unwrap_or_default()
                    + account.output_tokens.unwrap_or_default();
                let mut summary = format!(
                    "{:?} · {} · {} tokens",
                    account.agent,
                    account.account_name.as_deref().unwrap_or("本机环境"),
                    tokens_used
                );
                if let Some(balance) = &account.credits_balance {
                    summary.push_str(&format!(" · credits {balance}"));
                }
                content = content.push(
                    container(
                        column![
                            text(summary).size(theme::TEXT_SMALL),
                            text(account.reason.as_deref().unwrap_or(if account.available {
                                "可用"
                            } else {
                                "不可用"
                            }))
                            .size(theme::TEXT_CAPTION)
                            .color(if account.available {
                                tokens.success
                            } else {
                                tokens.muted
                            }),
                        ]
                        .spacing(3),
                    )
                    .padding(9)
                    .width(Fill)
                    .style(theme::panel(self.mode)),
                );
            }
        }
        content = content.push(
            text(format!("Skills · {}", self.operations.skills.len())).size(theme::TEXT_LEAD),
        );
        for skill in self.operations.skills.iter().take(100) {
            content = content.push(
                container(
                    column![
                        row![
                            text(&skill.name).size(theme::TEXT_BODY).width(Fill),
                            text(&skill.scope)
                                .size(theme::TEXT_CAPTION)
                                .color(tokens.accent),
                        ],
                        text(&skill.description).size(theme::TEXT_SMALL),
                        text(&skill.path)
                            .size(theme::TEXT_CAPTION)
                            .color(tokens.muted),
                    ]
                    .spacing(3),
                )
                .padding(9)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        content = content.push(text("诊断").size(theme::TEXT_LEAD));
        content = content.push(
            container(
                text(if self.operations.diagnostics.is_empty() {
                    "暂无诊断日志"
                } else {
                    &self.operations.diagnostics
                })
                .font(iced::Font::MONOSPACE)
                .size(theme::TEXT_CAPTION),
            )
            .padding(10)
            .width(Fill)
            .style(theme::terminal),
        );
        scrollable(content).height(Fill).into()
    }

    fn sidebar(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let relay = self
            .health
            .as_ref()
            .and_then(|health| health.relay.as_ref())
            .map(|relay| format!("Relay · {:?}", relay.state))
            .unwrap_or_else(|| "Relay · offline".to_owned());
        let navigation = column![
            text("Prospero").size(19).color(tokens.text),
            text("Rust Native").size(12).color(tokens.muted),
            rule::horizontal(1),
            button(text("工作台  Workspaces").size(13))
                .on_press(Message::Navigate(Page::Workspaces))
                .width(Fill)
                .height(theme::NAVIGATION_HEIGHT)
                .style(theme::navigation(self.mode, self.page == Page::Workspaces)),
            button(text("编排  Orchestration").size(13))
                .on_press(Message::Navigate(Page::Orchestration))
                .width(Fill)
                .height(theme::NAVIGATION_HEIGHT)
                .style(theme::navigation(
                    self.mode,
                    self.page == Page::Orchestration
                )),
            button(text("定时任务  Schedules").size(13))
                .on_press(Message::Navigate(Page::Schedules))
                .width(Fill)
                .height(theme::NAVIGATION_HEIGHT)
                .style(theme::navigation(self.mode, self.page == Page::Schedules)),
            button(text("账号与模型源").size(13))
                .on_press(Message::Navigate(Page::Accounts))
                .width(Fill)
                .height(theme::NAVIGATION_HEIGHT)
                .style(theme::navigation(self.mode, self.page == Page::Accounts)),
            button(text("设备与 Relay").size(13))
                .on_press(Message::Navigate(Page::Remote))
                .width(Fill)
                .height(theme::NAVIGATION_HEIGHT)
                .style(theme::navigation(self.mode, self.page == Page::Remote)),
            button(text("Skills 与诊断").size(13))
                .on_press(Message::Navigate(Page::Operations))
                .width(Fill)
                .height(theme::NAVIGATION_HEIGHT)
                .style(theme::navigation(self.mode, self.page == Page::Operations)),
        ]
        .spacing(7);
        let footer = column![
            self.update_view(),
            text(relay).size(12).color(tokens.muted),
            text(match self.material {
                platform::MaterialStatus::Native => "Glass · Native",
                platform::MaterialStatus::Fallback => "Glass · Fallback",
            })
            .size(theme::TEXT_CAPTION)
            .color(tokens.muted),
            button(if self.mode == Mode::Dark {
                "切换浅色"
            } else {
                "切换深色"
            })
            .on_press(Message::ToggleTheme)
            .style(theme::navigation(self.mode, false)),
        ]
        .spacing(8);
        container(column![navigation, iced::widget::Space::new().height(Fill), footer].spacing(16))
            .width(theme::SIDEBAR_WIDTH)
            .height(Fill)
            .padding([24, 14])
            .style(theme::sidebar(self.mode))
            .into()
    }

    fn update_view(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        match &self.update {
            UpdateState::Checking => text("正在检查更新…")
                .size(theme::TEXT_CAPTION)
                .color(tokens.muted)
                .into(),
            UpdateState::Available(release) => column![
                text(format!("可更新至 v{}", release.version))
                    .size(theme::TEXT_CAPTION)
                    .color(tokens.accent),
                text(format!(
                    "{} · {:.1} MiB",
                    release.name,
                    release.size as f64 / 1_048_576.0
                ))
                .size(theme::TEXT_CAPTION)
                .color(tokens.muted),
                row![
                    button("下载").on_press(Message::UpdateDownload),
                    button("稍后").on_press(Message::UpdateDismiss),
                ]
                .spacing(6),
            ]
            .spacing(5)
            .into(),
            UpdateState::Downloading(release) => text(format!("正在下载 v{}…", release.version))
                .size(theme::TEXT_CAPTION)
                .color(tokens.muted)
                .into(),
            UpdateState::Downloaded(path) => column![
                text("更新已下载并校验")
                    .size(theme::TEXT_CAPTION)
                    .color(tokens.success),
                text(path).size(theme::TEXT_CAPTION).color(tokens.muted),
            ]
            .spacing(4)
            .into(),
            UpdateState::Failed(error) => text(format!("更新检查失败：{error}"))
                .size(theme::TEXT_CAPTION)
                .color(tokens.muted)
                .into(),
            UpdateState::Current | UpdateState::Dismissed => iced::widget::Space::new().into(),
        }
    }

    fn content(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let title = row![
            column![
                text("工作台").size(22),
                text("连接独立运行的 Rust daemon")
                    .size(theme::TEXT_SMALL)
                    .color(tokens.muted),
            ]
            .spacing(3),
            iced::widget::Space::new().width(Fill),
            button("新建会话").on_press(Message::SessionCreateOpen),
            button("刷新").on_press(Message::Reload),
        ]
        .align_y(Alignment::Center);
        let body: Element<'_, Message> = if self.create_session.is_some() {
            self.create_session_view()
        } else {
            match &self.status {
                LoadState::Loading => container(text("正在连接 Rust daemon…").color(tokens.muted))
                    .center(Fill)
                    .into(),
                LoadState::Failed(error) => container(
                    column![
                        text("Rust daemon 未连接").size(18),
                        text(error).size(13).color(tokens.danger),
                        text(default_daemon_home().display().to_string())
                            .size(12)
                            .color(tokens.muted),
                        button("重试").on_press(Message::Reload),
                    ]
                    .spacing(10)
                    .align_x(Alignment::Center),
                )
                .center(Fill)
                .into(),
                LoadState::Ready if self.terminal.is_some() => self.terminal_view(),
                LoadState::Ready if self.selected_session.is_some() => self.timeline_view(),
                LoadState::Ready => self.session_list(),
            }
        };
        container(column![title, body].spacing(18))
            .width(Fill)
            .height(Fill)
            .padding([24, 28])
            .into()
    }

    fn session_list(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let summary = self.health.as_ref().map(|health| {
            format!(
                "Rust daemon · PID {} · {} 个活动 runtime",
                Client::from_home(&default_daemon_home())
                    .map(|client| client.pid())
                    .unwrap_or_default(),
                health.active_runtime_sessions
            )
        });
        let mut content = column![
            text(summary.unwrap_or_else(|| "Rust daemon".to_owned()))
                .size(12)
                .color(tokens.muted),
            text_input("搜索会话名称或工作区", &self.session_search)
                .on_input(Message::SessionSearchChanged),
            row![
                button("活动")
                    .on_press(Message::SessionLifecycleChanged(Some(
                        SessionLifecycle::Active
                    )))
                    .style(theme::navigation(
                        self.mode,
                        self.session_lifecycle == Some(SessionLifecycle::Active)
                            && !self.local_archive_view
                    )),
                button("历史")
                    .on_press(Message::SessionLifecycleChanged(Some(
                        SessionLifecycle::Archived
                    )))
                    .style(theme::navigation(
                        self.mode,
                        self.session_lifecycle == Some(SessionLifecycle::Archived)
                            && !self.local_archive_view
                    )),
                button("全部")
                    .on_press(Message::SessionLifecycleChanged(None))
                    .style(theme::navigation(
                        self.mode,
                        self.session_lifecycle.is_none() && !self.local_archive_view
                    )),
                button("本地归档")
                    .on_press(Message::SessionLocalArchive)
                    .style(theme::navigation(self.mode, self.local_archive_view)),
                iced::widget::Space::new().width(Fill),
                text(format!("{} / {}", self.sessions.len(), self.session_total))
                    .size(theme::TEXT_CAPTION)
                    .color(tokens.muted),
            ]
            .spacing(5)
            .align_y(Alignment::Center),
        ]
        .spacing(9);
        let query = self.session_search.trim().to_lowercase();
        let sessions = self
            .sessions
            .iter()
            .filter(|session| {
                (self.local_archive_view
                    || !query.is_empty()
                    || !self
                        .preferences
                        .archived_session_ids
                        .iter()
                        .any(|id| id == &session.id))
                    && (query.is_empty()
                        || session.title.to_lowercase().contains(&query)
                        || session.workspace.to_lowercase().contains(&query))
            })
            .collect::<Vec<_>>();
        if let Some(error) = &self.session_error {
            content = content.push(text(error).size(theme::TEXT_CAPTION).color(tokens.danger));
        }
        if sessions.is_empty() {
            content = content.push(
                container(
                    column![
                        text("还没有 Rust 会话").size(18),
                        text("已有 daemon 数据保持不变；这里会按页加载会话。")
                            .size(13)
                            .color(tokens.muted)
                    ]
                    .spacing(6),
                )
                .padding(24)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        } else {
            for session in sessions {
                let archived = self
                    .preferences
                    .archived_session_ids
                    .iter()
                    .any(|id| id == &session.id);
                let status = match session.status {
                    SessionStatus::Running | SessionStatus::Starting => tokens.success,
                    SessionStatus::WaitingPermission | SessionStatus::WaitingInput => {
                        tokens.warning
                    }
                    SessionStatus::Failed => tokens.danger,
                    _ => tokens.muted,
                };
                content = content.push(
                    container(
                        row![
                            button(
                                column![
                                    text(&session.title).size(theme::TEXT_BODY),
                                    text(&session.workspace)
                                        .size(theme::TEXT_CAPTION)
                                        .color(tokens.muted)
                                ]
                                .spacing(3)
                            )
                            .on_press(Message::SelectSession(session.id.clone()))
                            .width(Fill)
                            .style(theme::navigation(self.mode, false)),
                            text(session_status(session.status))
                                .size(theme::TEXT_CAPTION)
                                .color(status),
                            button(if archived { "取消归档" } else { "归档" })
                                .on_press(Message::SessionArchiveToggle(session.id.clone())),
                        ]
                        .align_y(Alignment::Center),
                    )
                    .padding([9, 12])
                    .width(Fill)
                    .style(theme::panel(self.mode)),
                );
            }
        }
        if self.session_has_more {
            content = content.push(
                button(if self.session_loading {
                    "正在加载…"
                } else {
                    "加载更多"
                })
                .on_press_maybe((!self.session_loading).then_some(Message::SessionLoadMore)),
            );
        }
        scrollable(content).height(Fill).into()
    }

    fn create_session_view(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let state = self.create_session.as_ref().expect("create session state");
        let agents = [
            AgentKind::Claude,
            AgentKind::Codex,
            AgentKind::Deepseek,
            AgentKind::Opencode,
            AgentKind::Grok,
            AgentKind::Trae,
            AgentKind::Shell,
            AgentKind::Custom,
        ];
        let mut agent_buttons = row![].spacing(5);
        for agent in agents {
            agent_buttons = agent_buttons.push(
                button(text(format!("{agent:?}")))
                    .on_press(Message::SessionAgentChanged(agent))
                    .style(theme::navigation(self.mode, state.agent == agent)),
            );
        }
        let pty_only = matches!(
            state.agent,
            AgentKind::Shell | AgentKind::Grok | AgentKind::Trae
        );
        let kind_buttons = row![
            button("对话 Structured")
                .on_press_maybe(
                    (!pty_only).then_some(Message::SessionKindChanged(SessionKind::Structured))
                )
                .style(theme::navigation(
                    self.mode,
                    state.kind == SessionKind::Structured
                )),
            button("终端 PTY")
                .on_press(Message::SessionKindChanged(SessionKind::Pty))
                .style(theme::navigation(self.mode, state.kind == SessionKind::Pty)),
        ]
        .spacing(6);
        let mut form = column![
            text("新建会话").size(theme::TEXT_LEAD),
            text_input("会话名称", &state.title).on_input(Message::SessionTitleChanged),
            text_input("工作区绝对路径", &state.workspace)
                .on_input(Message::SessionWorkspaceChanged),
            text("Agent").size(theme::TEXT_CAPTION).color(tokens.muted),
            agent_buttons,
            text("会话类型")
                .size(theme::TEXT_CAPTION)
                .color(tokens.muted),
            kind_buttons,
        ]
        .spacing(10);
        if state.kind == SessionKind::Structured && resumable_agent(state.agent) {
            form = form.push(
                column![
                    text("接回本机对话")
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.muted),
                    row![
                        text_input("搜索标题、提示词或目录", &state.resume_query)
                            .on_input(Message::SessionResumeQueryChanged)
                            .on_submit(Message::SessionResumeSearch)
                            .width(Fill),
                        button(if state.resume_loading {
                            "搜索中…"
                        } else {
                            "搜索"
                        })
                        .on_press_maybe(
                            (!state.resume_loading).then_some(Message::SessionResumeSearch)
                        ),
                    ]
                    .spacing(6),
                ]
                .spacing(5),
            );
            if !state.resume_loading && state.resume_results.is_empty() {
                form = form.push(
                    text("没有找到可恢复的本机对话")
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.muted),
                );
            }
            for conversation in state.resume_results.iter().take(8) {
                let selected =
                    state.selected_resume.as_ref().map(|item| &item.id) == Some(&conversation.id);
                let detail = conversation.preview.as_deref().unwrap_or(&conversation.cwd);
                form = form.push(
                    button(
                        column![
                            text(&conversation.title).size(theme::TEXT_SMALL),
                            text(detail).size(theme::TEXT_CAPTION).color(tokens.muted),
                            text(&conversation.cwd)
                                .size(theme::TEXT_CAPTION)
                                .color(tokens.muted),
                        ]
                        .spacing(2)
                        .width(Fill),
                    )
                    .on_press(Message::SessionResumeSelected(conversation.id.clone()))
                    .width(Fill)
                    .style(theme::navigation(self.mode, selected)),
                );
            }
            if state.agent == AgentKind::Codex && state.selected_resume.is_some() {
                form = form.push(
                    text("将接回原 Codex thread；若它仍被其他客户端占用，请先在那里结束任务。")
                        .size(theme::TEXT_CAPTION)
                        .color(tokens.warning),
                );
            }
        }
        form = form.push(
            row![
                button("取消").on_press(Message::SessionCreateCancel),
                button(if state.selected_resume.is_some() {
                    "恢复并打开"
                } else {
                    "创建"
                })
                .on_press(Message::SessionCreateSubmit),
            ]
            .spacing(6),
        );
        if let Some(error) = &state.error {
            form = form.push(text(error).size(theme::TEXT_CAPTION).color(tokens.danger));
        }
        container(scrollable(form))
            .padding(16)
            .width(Fill)
            .height(Fill)
            .style(theme::panel(self.mode))
            .into()
    }

    fn timeline_view(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let session = self
            .selected_session
            .as_deref()
            .and_then(|id| self.sessions.iter().find(|session| session.id == id));
        let locally_archived = session.is_some_and(|session| {
            self.preferences
                .archived_session_ids
                .iter()
                .any(|id| id == &session.id)
        });
        let mut content = column![
            row![
                button("‹ 会话").on_press(Message::BackToSessions),
                column![
                    text(session.map(|value| value.title.as_str()).unwrap_or("会话"))
                        .size(theme::TEXT_LEAD),
                    text(
                        session
                            .map(|value| value.workspace.as_str())
                            .unwrap_or_default()
                    )
                    .size(12)
                    .color(tokens.muted),
                ]
                .spacing(2),
                iced::widget::Space::new().width(Fill),
                button(if locally_archived {
                    "取消归档"
                } else {
                    "归档"
                })
                .on_press_maybe(
                    session.map(|session| Message::SessionArchiveToggle(session.id.clone()))
                ),
                button("关闭会话").on_press(Message::SessionClose),
            ]
            .spacing(12)
            .align_y(Alignment::Center),
        ]
        .spacing(12);
        if self.timeline_loading {
            content = content.push(text("正在加载 timeline…").color(tokens.muted));
        } else if let Some(error) = &self.timeline_error {
            content = content.push(text(error).color(tokens.danger));
        } else if self.timeline.is_empty() {
            content = content.push(text("这个会话还没有记录").color(tokens.muted));
        } else {
            for entry in &self.timeline {
                content = content.push(self.timeline_card(entry));
            }
        }
        let mut attachments = row![].spacing(5);
        for (index, attachment) in self.chat_attachments.iter().enumerate() {
            attachments = attachments.push(
                row![
                    text(attachment.name.as_deref().unwrap_or("图片")).size(theme::TEXT_CAPTION),
                    button("移除").on_press(Message::ChatRemoveAttachment(index)),
                ]
                .spacing(4),
            );
        }
        let composer = row![
            text_input("输入消息", &self.chat_input)
                .on_input(Message::ChatInputChanged)
                .on_submit(Message::ChatSubmit)
                .padding(10)
                .size(theme::TEXT_CHAT)
                .width(Fill),
            button("附件")
                .on_press_maybe((self.chat_attachments.len() < 6).then_some(Message::ChatAttach),),
            button("发送").on_press(Message::ChatSubmit),
        ]
        .spacing(8)
        .align_y(Alignment::Center);
        let mut layout = column![scrollable(content).height(Fill), attachments, composer]
            .spacing(10)
            .height(Fill);
        if let Some(error) = &self.chat_error {
            layout = layout.push(text(error).size(theme::TEXT_CAPTION).color(tokens.danger));
        }
        if let Some(controls) = &self.agent_controls {
            let mut actions = row![
                button("手动审批")
                    .on_press(Message::AgentSetApproval("manual".into()))
                    .style(theme::navigation(
                        self.mode,
                        controls.approval_policy == "manual"
                    )),
                button("自动批准")
                    .on_press(Message::AgentSetApproval("auto".into()))
                    .style(theme::navigation(
                        self.mode,
                        controls.approval_policy == "auto"
                    )),
                button("压缩上下文").on_press(Message::AgentCompact),
            ]
            .spacing(5);
            if let Some(modes) = &controls.modes {
                for mode in &modes.modes {
                    actions = actions.push(
                        button(text(&mode.label))
                            .on_press(Message::AgentSetMode(mode.id.clone()))
                            .style(theme::navigation(self.mode, mode.id == modes.current_mode)),
                    );
                }
            }
            if let Some(models) = &controls.models {
                for model in models.models.iter().take(6) {
                    actions = actions.push(
                        button(text(&model.label))
                            .on_press(Message::AgentSetModel(model.id.clone()))
                            .style(theme::navigation(
                                self.mode,
                                models.current_model.as_deref() == Some(&model.id),
                            )),
                    );
                }
                if let Some(current) = models
                    .current_model
                    .as_deref()
                    .and_then(|id| models.models.iter().find(|model| model.id == id))
                {
                    for effort in &current.supported_efforts {
                        actions = actions.push(
                            button(text(format!("Effort {effort}")))
                                .on_press(Message::AgentSetEffort(effort.clone()))
                                .style(theme::navigation(
                                    self.mode,
                                    models.current_effort.as_deref() == Some(effort),
                                )),
                        );
                    }
                }
            }
            let mut queue = column![actions].spacing(5);
            for message in &controls.queue.items {
                queue = queue.push(
                    row![
                        text(&message.text).size(theme::TEXT_CAPTION).width(Fill),
                        button("现在引导").on_press(Message::AgentQueueAction {
                            id: message.id.clone(),
                            action: "guide".into(),
                        }),
                        button("取消").on_press(Message::AgentQueueAction {
                            id: message.id.clone(),
                            action: "remove".into(),
                        }),
                    ]
                    .spacing(5)
                    .align_y(Alignment::Center),
                );
            }
            if let Some(error) = &controls.error {
                queue = queue.push(text(error).size(theme::TEXT_CAPTION).color(tokens.danger));
            }
            layout = layout.push(
                container(queue)
                    .padding(8)
                    .width(Fill)
                    .style(theme::panel(self.mode)),
            );
        }
        if self.pending_session_close {
            layout = layout.push(
                container(
                    row![
                        text("关闭会结束当前 Agent 或终端进程，历史记录仍保留。")
                            .color(tokens.danger)
                            .width(Fill),
                        button("取消").on_press(Message::SessionCloseCancel),
                        button("确认关闭").on_press(Message::SessionCloseConfirm),
                    ]
                    .spacing(6)
                    .align_y(Alignment::Center),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        layout.into()
    }

    fn terminal_view(&self) -> Element<'_, Message> {
        let tokens = self.mode.tokens();
        let terminal = self.terminal.as_ref().expect("terminal view");
        let session = self
            .sessions
            .iter()
            .find(|session| session.id == terminal.session_id);
        let locally_archived = session.is_some_and(|session| {
            self.preferences
                .archived_session_ids
                .iter()
                .any(|id| id == &session.id)
        });
        let status = if terminal.exited {
            format!(
                "Exited · {}",
                terminal
                    .exit_code
                    .map_or_else(|| "signal".to_owned(), |value| value.to_string())
            )
        } else {
            "Live".to_owned()
        };
        let output = container(
            scrollable(
                text(terminal.model.visible_text())
                    .font(iced::Font::MONOSPACE)
                    .size(13)
                    .color(iced::Color::from_rgb8(192, 202, 245)),
            )
            .height(Fill),
        )
        .padding(12)
        .width(Fill)
        .height(Fill)
        .style(theme::terminal);
        let input = text_input("输入命令后按 Enter", &terminal.input)
            .on_input(Message::TerminalInputChanged)
            .on_submit(Message::TerminalSubmit)
            .padding(9)
            .size(theme::TEXT_BODY);
        let mut content = column![
            row![
                button("‹ 会话").on_press(Message::BackToSessions),
                column![
                    text(session.map(|value| value.title.as_str()).unwrap_or("终端"))
                        .size(theme::TEXT_LEAD),
                    text(status).size(theme::TEXT_CAPTION).color(tokens.muted),
                ]
                .spacing(2),
                iced::widget::Space::new().width(Fill),
                button(if locally_archived {
                    "取消归档"
                } else {
                    "归档"
                })
                .on_press_maybe(
                    session.map(|session| Message::SessionArchiveToggle(session.id.clone()))
                ),
                button("关闭会话").on_press(Message::SessionClose),
            ]
            .spacing(12)
            .align_y(Alignment::Center),
            output,
            input,
        ]
        .spacing(10)
        .height(Fill);
        if let Some(error) = &terminal.error {
            content = content.push(text(error).size(theme::TEXT_CAPTION).color(tokens.danger));
        }
        if self.pending_session_close {
            content = content.push(
                container(
                    row![
                        text("关闭会结束当前终端进程，历史记录仍保留。")
                            .color(tokens.danger)
                            .width(Fill),
                        button("取消").on_press(Message::SessionCloseCancel),
                        button("确认关闭").on_press(Message::SessionCloseConfirm),
                    ]
                    .spacing(6)
                    .align_y(Alignment::Center),
                )
                .padding(10)
                .width(Fill)
                .style(theme::panel(self.mode)),
            );
        }
        content.into()
    }

    fn timeline_card<'a>(&self, entry: &'a TimelineEntry) -> Element<'a, Message> {
        let tokens = self.mode.tokens();
        let (label, accent, markdown_body) = match &entry.record.body {
            TimelineBody::Message {
                role: MessageRole::User,
                ..
            } => ("你", tokens.accent, true),
            TimelineBody::Message {
                role: MessageRole::Assistant,
                final_answer,
                ..
            } => (
                if *final_answer { "回答" } else { "过程" },
                tokens.success,
                true,
            ),
            TimelineBody::Reasoning => ("思考", tokens.muted, false),
            TimelineBody::Tool { .. } => ("工具", tokens.warning, false),
            TimelineBody::PermissionRequest { resolved, .. } => (
                if *resolved {
                    "审批已处理"
                } else {
                    "等待审批"
                },
                tokens.warning,
                false,
            ),
            TimelineBody::Question { resolved, .. } => (
                if *resolved {
                    "问题已处理"
                } else {
                    "等待回答"
                },
                tokens.warning,
                false,
            ),
            TimelineBody::TurnEnd { .. } => ("本轮完成", tokens.success, false),
            TimelineBody::Subagent { .. } => ("子 Agent", tokens.accent, false),
            TimelineBody::Error => ("错误", tokens.danger, false),
        };
        let body: Element<'a, Message> = if markdown_body {
            markdown::view(
                &entry.markdown,
                markdown::Settings::with_text_size(theme::TEXT_BODY, self.theme()),
            )
            .map(Message::LinkClicked)
        } else {
            text(if entry.text.is_empty() {
                &entry.record.preview
            } else {
                &entry.text
            })
            .size(theme::TEXT_CHAT)
            .color(tokens.text)
            .into()
        };
        let mut card =
            column![text(label).size(theme::TEXT_CAPTION).color(accent), body].spacing(7);
        match &entry.record.body {
            TimelineBody::PermissionRequest {
                request_id,
                resolved: false,
                ..
            } => {
                card = card.push(
                    row![
                        button("允许").on_press(Message::PermissionRespond {
                            request_id: request_id.clone(),
                            allow: true,
                        }),
                        button("拒绝").on_press(Message::PermissionRespond {
                            request_id: request_id.clone(),
                            allow: false,
                        }),
                    ]
                    .spacing(8),
                );
            }
            TimelineBody::Question {
                request_id,
                questions,
                resolved: false,
                ..
            } => {
                for question in questions {
                    let mut options = row![].spacing(8);
                    for option in &question.options {
                        options = options.push(button(text(&option.label)).on_press(
                            Message::QuestionRespond {
                                request_id: request_id.clone(),
                                question_id: question.id.clone(),
                                value: option.label.clone(),
                            },
                        ));
                    }
                    card = card.push(options);
                }
            }
            _ => {}
        }
        container(card)
            .padding([12, 14])
            .width(Fill)
            .style(theme::panel(self.mode))
            .into()
    }
}

async fn save_screenshot(screenshot: window::Screenshot) -> Result<String, String> {
    let path = std::env::var_os("PROSPERO_NATIVE_SCREENSHOT")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "screenshot path is not configured".to_owned())?;
    let file = std::fs::File::create(&path).map_err(|error| error.to_string())?;
    let mut encoder = png::Encoder::new(file, screenshot.size.width, screenshot.size.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
    writer
        .write_image_data(&screenshot.rgba)
        .map_err(|error| error.to_string())?;
    writer.finish().map_err(|error| error.to_string())?;
    Ok(path.display().to_string())
}

async fn capture_after_startup() {
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
}

async fn load() -> Result<(Health, SessionPage), String> {
    let client = service::attach_or_start().await?;
    let health = client.health().await.map_err(|error| error.to_string())?;
    let page = client
        .sessions(SessionQuery {
            limit: Some(50),
            lifecycle: Some(SessionLifecycle::Active),
            ..Default::default()
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok((health, page))
}

async fn load_session_page(
    query: String,
    lifecycle: Option<SessionLifecycle>,
    cursor: Option<String>,
    append: bool,
) -> Result<SessionLoad, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let normalized = query.trim().to_owned();
    let page = client
        .sessions(SessionQuery {
            cursor,
            limit: Some(50),
            lifecycle,
            workspace: None,
            text: (!normalized.is_empty()).then(|| normalized.clone()),
        })
        .await
        .map_err(|error| error.to_string())?;
    Ok(SessionLoad {
        query,
        lifecycle,
        append,
        page,
    })
}

async fn load_local_archive(ids: Vec<String>) -> Result<Vec<SessionHead>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .lookup_sessions(ids)
        .await
        .map(|result| result.items)
        .map_err(|error| error.to_string())
}

fn operations_workspace(desktop: &Desktop) -> String {
    if !desktop.operations.workspace.trim().is_empty() {
        return desktop.operations.workspace.clone();
    }
    desktop
        .selected_session
        .as_deref()
        .and_then(|id| desktop.sessions.iter().find(|session| session.id == id))
        .or_else(|| desktop.sessions.first())
        .map(|session| session.workspace.clone())
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .and_then(|path| path.to_str().map(str::to_owned))
        })
        .unwrap_or_default()
}

async fn load_operations(workspace: String) -> Result<OperationsSnapshot, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let skills = client.skills(workspace.clone());
    let usage = client.usage(None);
    let diagnostics = service::diagnostics();
    let (skills, usage, diagnostics) = tokio::join!(skills, usage, diagnostics);
    Ok(OperationsSnapshot {
        workspace,
        skills: skills.map_err(|error| error.to_string())?.items,
        usage: usage.map_err(|error| error.to_string())?,
        diagnostics: diagnostics?,
    })
}

async fn run_service(command: service::CommandKind) -> Result<String, String> {
    tokio::task::spawn_blocking(move || service::run(command))
        .await
        .map_err(|error| error.to_string())?
}

async fn create_session(state: CreateSessionState) -> Result<SessionHead, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let title = if state.title.trim().is_empty() {
        format!("{:?}", state.agent)
    } else {
        state.title.trim().to_owned()
    };
    let workspace = state.workspace.trim().to_owned();
    if workspace.is_empty() {
        return Err("工作区路径不能为空".into());
    }
    if state.kind == SessionKind::Pty {
        client
            .create_terminal(&CreateTerminal {
                title,
                workspace,
                size: TerminalSize {
                    cols: 100,
                    rows: 30,
                },
                agent: Some(state.agent),
                command: None,
                account_id: None,
                model: None,
                effort: None,
            })
            .await
            .map_err(|error| error.to_string())
    } else {
        client
            .create_agent(&AgentSessionCreate {
                agent: state.agent,
                title,
                workspace,
                auto_approve: false,
                mode: None,
                model: None,
                effort: None,
                agent_preset: None,
                account_id: None,
                resume: state.selected_resume.map(|conversation| ResumeInput {
                    id: conversation.id,
                    title: Some(conversation.title),
                    fork: None,
                }),
            })
            .await
            .map_err(|error| error.to_string())
    }
}

async fn search_conversations(
    agent: AgentKind,
    query: String,
) -> Result<(AgentKind, String, Vec<ResumableConversation>), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let conversations = client
        .conversations(agent, None, query.trim().to_owned(), 20)
        .await
        .map_err(|error| error.to_string())?
        .conversations;
    Ok((agent, query, conversations))
}

async fn close_session(session: SessionHead) -> Result<(), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    if session.kind == SessionKind::Pty {
        client.close_terminal(&session.id).await
    } else {
        client.close_agent(&session.id).await
    }
    .map_err(|error| error.to_string())
}

async fn load_agent_controls(session_id: String) -> Result<AgentControlsState, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let (modes, models, queue, projection) = tokio::join!(
        client.agent_modes(&session_id),
        client.agent_models(&session_id),
        client.agent_queue(&session_id),
        client.agent_controls(),
    );
    let approval_policy = projection
        .ok()
        .and_then(|projection| {
            projection
                .controls
                .into_iter()
                .find(|control| control.session_id == session_id)
        })
        .map(|control| control.approval_policy)
        .unwrap_or_else(|| "manual".into());
    Ok(AgentControlsState {
        session_id,
        modes: modes.ok(),
        models: models.ok(),
        queue: queue.map_err(|error| error.to_string())?,
        approval_policy,
        error: None,
    })
}

async fn agent_control(
    session_id: String,
    action: &'static str,
    value: Option<String>,
) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    match action {
        "mode" => {
            client
                .set_agent_mode(&session_id, value.as_deref().unwrap_or_default())
                .await
                .map_err(|error| error.to_string())?;
        }
        "model" => {
            client
                .set_agent_model(&session_id, value.unwrap_or_default(), None)
                .await
                .map_err(|error| error.to_string())?;
        }
        "approval" => {
            client
                .set_approval_policy(&session_id, value.as_deref().unwrap_or_default())
                .await
                .map_err(|error| error.to_string())?;
        }
        "compact" => {
            client
                .compact_agent(&session_id)
                .await
                .map_err(|error| error.to_string())?;
        }
        _ => return Err("invalid agent control".into()),
    }
    Ok(session_id)
}

async fn agent_set_model(
    session_id: String,
    model: String,
    effort: Option<String>,
) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .set_agent_model(&session_id, model, effort)
        .await
        .map_err(|error| error.to_string())?;
    Ok(session_id)
}

async fn agent_queue_action(
    session_id: String,
    queue_id: String,
    action: String,
) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .agent_queue_action(&session_id, &queue_id, &action)
        .await
        .map_err(|error| error.to_string())?;
    Ok(session_id)
}

async fn load_timeline(session_id: String) -> Result<(String, Vec<TimelineEntry>), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let page = client
        .timeline(
            &session_id,
            TimelineQuery {
                before: None,
                after: None,
                limit: Some(40),
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::with_capacity(page.items.len());
    for record in page.items {
        let text = if record.bytes > 0 {
            client
                .timeline_text(&session_id, &record.id, Some(0), Some(record.generation))
                .await
                .map(|body| body.text)
                .unwrap_or_else(|_| record.preview.clone())
        } else {
            record.preview.clone()
        };
        let markdown = markdown::parse(&text).collect();
        entries.push(TimelineEntry {
            record,
            text,
            markdown,
        });
    }
    Ok((session_id, entries))
}

async fn load_terminal(session_id: String) -> Result<(String, DecodedTerminalSnapshot), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let snapshot = client
        .terminal_snapshot_decoded(&session_id)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "terminal snapshot is unavailable".to_owned())?;
    Ok((session_id, snapshot))
}

fn poll_terminal(session_id: String, after_seq: i64) -> Task<Message> {
    Task::perform(
        async move {
            let client =
                Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
            let page = client
                .terminal_output_decoded(
                    &session_id,
                    TerminalQuery {
                        after_seq: Some(after_seq),
                        wait_ms: Some(3000),
                    },
                )
                .await
                .map_err(|error| error.to_string())?;
            Ok::<_, String>((session_id, page))
        },
        |result| Message::TerminalPolled(Box::new(result)),
    )
}

fn send_remote_command(
    mut sender: iced::futures::channel::mpsc::Sender<remote::Command>,
    command: remote::Command,
) -> Task<Message> {
    Task::perform(
        async move {
            sender
                .send(command)
                .await
                .map_err(|_| "远程连接任务已停止".to_owned())
        },
        Message::RemoteCommandSent,
    )
}

fn upsert_remote_session(
    sessions: &mut Vec<remote::RemoteSession>,
    session: remote::RemoteSession,
) {
    if let Some(existing) = sessions.iter_mut().find(|item| item.id == session.id) {
        *existing = session;
    } else {
        sessions.push(session);
        sessions.sort_by_key(|session| std::cmp::Reverse(session.created_at));
    }
}

fn remote_selected_session(state: &RemoteState) -> Option<String> {
    state
        .terminal
        .as_ref()
        .map(|terminal| terminal.session_id.clone())
        .or_else(|| state.chat.as_ref().map(|chat| chat.session_id.clone()))
}

fn merge_remote_chat_event(events: &mut Vec<serde_json::Value>, incoming: serde_json::Value) {
    let kind = incoming
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    let key = match kind {
        "text.delta" => incoming.get("textId"),
        "tool.start" | "tool.end" => incoming.get("callId"),
        "permission.request" | "permission.resolved" => incoming.get("reqId"),
        "question.request" | "question.resolved" => incoming.get("reqId"),
        "subagent.started" => incoming.get("subagent").and_then(|value| value.get("id")),
        "subagent.updated" => incoming.get("subagentId"),
        "trajectory.record" => incoming.get("recordId"),
        _ => incoming.get("msgId"),
    }
    .and_then(serde_json::Value::as_str);
    if kind == "text.delta"
        && incoming.get("replace") != Some(&serde_json::Value::Bool(true))
        && let Some(key) = key
        && let Some(existing) = events.iter_mut().rev().find(|event| {
            event.get("kind").and_then(serde_json::Value::as_str) == Some(kind)
                && event.get("textId").and_then(serde_json::Value::as_str) == Some(key)
        })
    {
        let delta = incoming
            .get("delta")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let merged = format!(
            "{}{}",
            existing
                .get("delta")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
            delta
        );
        existing["delta"] = serde_json::Value::String(merged);
        return;
    }
    if let Some(key) = key
        && matches!(
            kind,
            "tool.start"
                | "tool.end"
                | "permission.request"
                | "permission.resolved"
                | "question.request"
                | "question.resolved"
                | "subagent.started"
                | "subagent.updated"
                | "trajectory.record"
        )
        && let Some(index) = events
            .iter()
            .position(|event| remote_event_key(event) == Some(key))
    {
        events[index] = incoming;
        return;
    }
    events.push(incoming);
    if events.len() > 2_000 {
        events.drain(..events.len() - 2_000);
    }
}

fn remote_event_key(value: &serde_json::Value) -> Option<&str> {
    value
        .get("textId")
        .or_else(|| value.get("callId"))
        .or_else(|| value.get("reqId"))
        .or_else(|| value.get("recordId"))
        .or_else(|| value.get("subagentId"))
        .or_else(|| value.get("subagent").and_then(|item| item.get("id")))
        .and_then(serde_json::Value::as_str)
}

fn remote_event_text(value: &serde_json::Value) -> String {
    match value.get("kind").and_then(serde_json::Value::as_str) {
        Some("user.message") => value.get("text"),
        Some("text.delta" | "reasoning.delta") => value.get("delta"),
        Some("tool.start" | "tool.end" | "permission.request") => value.get("summary"),
        Some("question.request") => value
            .get("questions")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| item.get("question")),
        Some("turn.end") => value.get("finish"),
        Some("agent.error") => value.get("message"),
        _ => None,
    }
    .and_then(serde_json::Value::as_str)
    .unwrap_or_default()
    .to_owned()
}

fn remote_event_view(value: &serde_json::Value, mode: Mode) -> Element<'_, Message> {
    let tokens = mode.tokens();
    let kind = value
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("event");
    let body = remote_event_text(value);
    let body = if body.is_empty() {
        "事件已更新".to_owned()
    } else {
        body
    };
    let mut card = column![
        text(kind).size(theme::TEXT_CAPTION).color(tokens.accent),
        text(body).size(theme::TEXT_SMALL),
    ]
    .spacing(4);
    if kind == "permission.request"
        && let Some(request_id) = value.get("reqId").and_then(serde_json::Value::as_str)
    {
        card = card.push(
            row![
                button("允许一次").on_press(Message::RemotePermission {
                    request_id: request_id.to_owned(),
                    reply: "once".into(),
                }),
                button("拒绝").on_press(Message::RemotePermission {
                    request_id: request_id.to_owned(),
                    reply: "reject".into(),
                }),
            ]
            .spacing(5),
        );
    }
    if kind == "question.request"
        && let (Some(request_id), Some(question)) = (
            value.get("reqId").and_then(serde_json::Value::as_str),
            value
                .get("questions")
                .and_then(serde_json::Value::as_array)
                .and_then(|items| items.first()),
        )
        && let Some(question_id) = question.get("id").and_then(serde_json::Value::as_str)
        && let Some(options) = question
            .get("options")
            .and_then(serde_json::Value::as_array)
    {
        let mut choices = row![].spacing(5);
        for option in options.iter().take(10) {
            if let Some(label) = option.get("label").and_then(serde_json::Value::as_str) {
                choices = choices.push(button(text(label)).on_press(Message::RemoteQuestion {
                    request_id: request_id.to_owned(),
                    question_id: question_id.to_owned(),
                    value: label.to_owned(),
                }));
            }
        }
        card = card.push(choices);
    }
    container(card)
        .padding(9)
        .width(Fill)
        .style(theme::panel(mode))
        .into()
}

fn safe_remote_child(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.chars().count() <= 255
        && !value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}

async fn send_terminal_input(session_id: String, input: String) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let mut bytes = input.into_bytes();
    bytes.push(b'\r');
    client
        .terminal_input(&session_id, &bytes)
        .await
        .map_err(|error| error.to_string())?;
    Ok(session_id)
}

async fn select_attachments(limit: usize) -> Result<Vec<AttachmentInput>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let files = rfd::AsyncFileDialog::new()
        .add_filter("Images", &["jpg", "jpeg", "png", "gif", "webp"])
        .pick_files()
        .await
        .unwrap_or_default();
    if files.len() > limit {
        return Err(format!("最多还能添加 {limit} 张图片"));
    }
    let mut attachments = Vec::with_capacity(files.len());
    for file in files {
        let path = file.path();
        let metadata = tokio::fs::metadata(path)
            .await
            .map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > 5 * 1024 * 1024 {
            return Err(format!("图片超过 5 MiB：{}", path.display()));
        }
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|error| error.to_string())?;
        let mime_type = detect_image_mime(&bytes)
            .ok_or_else(|| format!("文件内容不是支持的图片：{}", path.display()))?;
        attachments.push(AttachmentInput {
            mime_type: mime_type.into(),
            data_b64: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_owned),
        });
    }
    Ok(attachments)
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

async fn send_chat(
    session_id: String,
    text: String,
    attachments: Vec<AttachmentInput>,
) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .agent_send(
            &session_id,
            &AgentSend {
                text,
                delivery: None,
                attachments,
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(session_id)
}

async fn respond_permission(
    session_id: String,
    request_id: String,
    allow: bool,
) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .agent_permission(&session_id, &PermissionDecision { request_id, allow })
        .await
        .map_err(|error| error.to_string())?;
    Ok(session_id)
}

async fn respond_question(
    session_id: String,
    request_id: String,
    question_id: String,
    value: String,
) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .agent_question(
            &session_id,
            &QuestionDecision {
                request_id,
                answers: vec![QuestionAnswer {
                    question_id,
                    values: vec![value],
                }],
                cancelled: false,
            },
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(session_id)
}

async fn load_project(
    session_id: String,
) -> Result<(String, Vec<FsEntry>, GitStatusResult, Vec<GitHistoryEntry>), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let (listing, git, history) = tokio::try_join!(
        client.fs_list(&session_id, ""),
        client.git_status(&session_id),
        client.git_history(&session_id)
    )
    .map_err(|error| error.to_string())?;
    Ok((session_id, listing.entries, git, history.entries))
}

async fn load_project_file(
    session_id: String,
    path: String,
) -> Result<(String, DecodedFsContent), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let preview = client
        .fs_read_decoded(&session_id, &path)
        .await
        .map_err(|error| error.to_string())?;
    Ok((path, preview))
}

async fn save_project_file(
    session_id: String,
    path: String,
    content: String,
    version: String,
) -> Result<(String, DecodedFsContent), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .fs_write(
            &session_id,
            path.clone(),
            content.as_bytes(),
            Some(version),
            false,
        )
        .await
        .map_err(|error| error.to_string())?;
    let preview = client
        .fs_read_decoded(&session_id, &path)
        .await
        .map_err(|error| error.to_string())?;
    Ok((path, preview))
}

async fn load_project_diff(
    session_id: String,
    path: String,
    staged: bool,
) -> Result<(String, String), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let diff = client
        .git_diff(&session_id, &path, staged)
        .await
        .map_err(|error| error.to_string())?;
    Ok((path, diff.patch))
}

fn refresh_project(session_id: String) -> Task<Message> {
    Task::perform(load_project(session_id), |result| {
        Message::ProjectLoaded(Box::new(result))
    })
}

async fn mutate_git_stage(
    session_id: String,
    paths: Vec<String>,
    unstage: bool,
) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .git_stage(&session_id, paths, unstage)
        .await
        .map_err(|error| error.to_string())?;
    Ok(session_id)
}

async fn mutate_git_discard(session_id: String, path: String) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .git_discard(&session_id, path)
        .await
        .map_err(|error| error.to_string())?;
    Ok(session_id)
}

async fn mutate_git_commit(session_id: String, message: String) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .git_commit(&session_id, message)
        .await
        .map_err(|error| error.to_string())?;
    Ok(session_id)
}

async fn load_runs() -> Result<Vec<Run>, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let mut runs = client.runs().await.map_err(|error| error.to_string())?;
    runs.sort_by(|left, right| {
        let left_active = matches!(left.status, prospero_protocol_rs::RunStatus::Active);
        let right_active = matches!(right.status, prospero_protocol_rs::RunStatus::Active);
        right_active
            .cmp(&left_active)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    runs.truncate(100);
    Ok(runs)
}

async fn load_run(run_id: String) -> Result<(RunSnapshot, Vec<WorktreeAsset>), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let (snapshot, worktrees) =
        tokio::try_join!(client.run_snapshot(&run_id), client.worktrees(&run_id))
            .map_err(|error| error.to_string())?;
    Ok((snapshot, worktrees))
}

fn comma_list(value: &str, limit: usize) -> Vec<String> {
    let mut values = Vec::new();
    for value in value
        .split([',', '\n'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !values.iter().any(|existing| existing == value) {
            values.push(value.to_owned());
        }
        if values.len() == limit {
            break;
        }
    }
    values
}

async fn create_run_graph(form: RunForm) -> Result<String, String> {
    let objective = form.objective.trim().to_owned();
    let titles = form
        .task_lines
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .take(200)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if objective.is_empty() || titles.is_empty() {
        return Err("目标和至少一个任务不能为空".into());
    }
    let skills = comma_list(&form.skills, 5);
    let nodes = titles
        .into_iter()
        .enumerate()
        .map(|(index, title)| GraphNodeInputView {
            client_id: format!("task-{}", index + 1),
            spec: title.clone(),
            title,
            skills: skills.clone(),
            deps: if index == 0 {
                Vec::new()
            } else {
                vec![format!("task-{index}")]
            },
            parent_id: None,
        })
        .collect();
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .create_run_graph(&CreateRunGraphView {
            objective,
            nodes,
            coordinator_session_id: None,
            operation_id: uuid::Uuid::new_v4().to_string(),
        })
        .await
        .map(|result| result.run.id)
        .map_err(|error| error.to_string())
}

async fn save_task_graph(
    run: Run,
    form: TaskForm,
    delete_task_ids: Vec<String>,
) -> Result<String, String> {
    let nodes = if delete_task_ids.is_empty() {
        if form.title.trim().is_empty() || form.spec.trim().is_empty() {
            return Err("任务标题和要求不能为空".into());
        }
        vec![GraphNodeInputView {
            client_id: form
                .id
                .unwrap_or_else(|| format!("new-{}", uuid::Uuid::new_v4().simple())),
            title: form.title.trim().to_owned(),
            spec: form.spec.trim().to_owned(),
            skills: comma_list(&form.skills, 5),
            deps: comma_list(&form.deps, 200),
            parent_id: None,
        }]
    } else {
        Vec::new()
    };
    let run_id = run.id.clone();
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .apply_task_graph(&ApplyTaskGraphView {
            run_id: run.id,
            base_revision: run.graph_revision,
            nodes,
            delete_task_ids,
            operation_id: Some(uuid::Uuid::new_v4().to_string()),
        })
        .await
        .map(|_| run_id)
        .map_err(|error| error.to_string())
}

async fn worktree_inspect(run_id: String, asset_id: String) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .inspect_worktree(&asset_id, None)
        .await
        .map_err(|error| error.to_string())?;
    Ok(run_id)
}

async fn worktree_cleanup(run_id: String, asset_id: String) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .cleanup_worktree(&asset_id, None, false)
        .await
        .map_err(|error| error.to_string())?;
    Ok(run_id)
}

async fn pause_automation(run_id: String) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .pause_automation(&run_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(run_id)
}

async fn retry_task(run_id: String, task_id: String) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .retry_task(&task_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(run_id)
}

async fn cancel_task(run_id: String, task_id: String) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .cancel_task(&task_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(run_id)
}

async fn resolve_gate(run_id: String, gate_id: String, decision: String) -> Result<String, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .resolve_gate(&gate_id, decision)
        .await
        .map_err(|error| error.to_string())?;
    Ok(run_id)
}

async fn load_management() -> Result<ManagementSnapshot, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let (schedules, plugins, plugin_services, accounts, sources) = tokio::try_join!(
        client.schedules(),
        client.plugins(),
        client.plugin_services(),
        client.accounts(),
        client.model_sources(),
    )
    .map_err(|error| error.to_string())?;
    Ok(ManagementSnapshot {
        schedules,
        plugins,
        plugin_services,
        accounts: accounts.accounts,
        sources: sources.sources.unwrap_or_default(),
    })
}

async fn load_remote() -> Result<RemoteSnapshot, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let (devices, relay) =
        tokio::try_join!(client.devices(), client.relay()).map_err(|error| error.to_string())?;
    Ok(RemoteSnapshot {
        devices: devices.items,
        relay,
    })
}

async fn create_pairing(
    name: String,
    allow_shell: bool,
    allow_orchestration: bool,
) -> Result<(Vec<DeviceView>, String), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let created = client
        .create_pairing(&PairingCreate {
            name,
            allow_shell,
            allow_orchestration,
        })
        .await
        .map_err(|error| error.to_string())?;
    let devices = client.devices().await.map_err(|error| error.to_string())?;
    Ok((devices.items, created.uri))
}

async fn revoke_device(id: String) -> Result<(), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .revoke_device(&id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn update_relay(
    enabled: Option<bool>,
    url: Option<String>,
    rotate_key: bool,
) -> Result<RelayView, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .update_relay(&RelayUpdate {
            enabled,
            url,
            rotate_key,
        })
        .await
        .map_err(|error| error.to_string())
}

async fn check_update() -> Result<Option<updater::Release>, String> {
    updater::check().await
}

async fn download_update(release: updater::Release) -> Result<String, String> {
    updater::download(release)
        .await
        .map(|path| path.display().to_string())
}

fn yes_no(value: bool) -> &'static str {
    if value { "Yes" } else { "No" }
}

async fn mutate_schedule(id: String, action: &str) -> Result<(), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    match action {
        "pause" => {
            client
                .pause_schedule(&id)
                .await
                .map_err(|error| error.to_string())?;
        }
        "resume" => {
            client
                .resume_schedule(&id)
                .await
                .map_err(|error| error.to_string())?;
        }
        "run" => {
            client
                .run_schedule(&id)
                .await
                .map_err(|error| error.to_string())?;
        }
        _ => return Err("invalid schedule action".into()),
    }
    Ok(())
}

async fn save_schedule(form: ScheduleForm) -> Result<(), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    if form.name.trim().is_empty()
        || form.prompt.trim().is_empty()
        || form.rrule.trim().is_empty()
        || form.cwd.trim().is_empty()
    {
        return Err("名称、提示词、RRULE 和工作区不能为空".into());
    }
    if let Some(id) = form.id {
        client
            .update_schedule(&ScheduleUpdateRequest {
                id,
                name: form.name.trim().to_owned(),
                prompt: form.prompt.trim().to_owned(),
                rrule: form.rrule.trim().to_owned(),
                agent: form.agent,
                approval_policy: "standard".into(),
                cwd: form.cwd.trim().to_owned(),
            })
            .await
            .map_err(|error| error.to_string())?;
    } else {
        client
            .create_schedule(&ScheduleCreateRequest {
                name: form.name.trim().to_owned(),
                prompt: form.prompt.trim().to_owned(),
                rrule: form.rrule.trim().to_owned(),
                agent: form.agent,
                approval_policy: "standard".into(),
                cwd: form.cwd.trim().to_owned(),
            })
            .await
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

async fn delete_schedule(id: String) -> Result<(), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let deleted = client
        .delete_schedule(&id)
        .await
        .map_err(|error| error.to_string())?;
    if deleted.deleted {
        Ok(())
    } else {
        Err("调度未删除".into())
    }
}

async fn save_account(api_key: String, form: AccountForm) -> Result<AccountMutation, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let name = form.name.trim();
    if name.is_empty() {
        return Err("账号名称不能为空".into());
    }
    let action = if let Some(account_id) = form.id {
        if form.api {
            let base_url = form.base_url.trim();
            let model = form.model.trim();
            if base_url.is_empty() || model.is_empty() {
                return Err("API 地址和模型不能为空".into());
            }
            serde_json::json!({
                "type": "agent.account.api.configure",
                "accountId": account_id,
                "name": name,
                "baseUrl": base_url,
                "model": model,
                "apiKey": (!api_key.trim().is_empty()).then(|| api_key.trim()),
            })
        } else {
            serde_json::json!({
                "type": "agent.account.rename",
                "accountId": account_id,
                "name": name,
            })
        }
    } else if form.api {
        let base_url = form.base_url.trim();
        let model = form.model.trim();
        let api_key = api_key.trim();
        if base_url.is_empty() || model.is_empty() || api_key.is_empty() {
            return Err("API 地址、模型和 API Key 不能为空".into());
        }
        let (provider, protocol) = if form.agent == AgentKind::Claude {
            ("anthropic_compatible", "anthropic")
        } else {
            ("openai_compatible", "openai_responses")
        };
        serde_json::json!({
            "type": "agent.account.api.create",
            "agent": agent_name(form.agent),
            "name": name,
            "provider": provider,
            "protocol": protocol,
            "baseUrl": base_url,
            "model": model,
            "apiKey": api_key,
        })
    } else {
        serde_json::json!({
            "type": "agent.account.create",
            "agent": agent_name(form.agent),
            "name": name,
        })
    };
    account_result(
        client
            .account_action(action)
            .await
            .map_err(|error| error.to_string())?,
    )
}

async fn account_simple(id: String, action: impl AsRef<str>) -> Result<AccountMutation, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let action = match action.as_ref() {
        "default" => serde_json::json!({"type": "agent.account.default", "accountId": id}),
        "login" => {
            serde_json::json!({"type": "agent.account.login", "accountId": id, "cols": 120, "rows": 40})
        }
        "logout" => serde_json::json!({"type": "agent.account.logout", "accountId": id}),
        "delete" => serde_json::json!({"type": "agent.account.delete", "accountId": id}),
        _ => return Err("invalid account action".into()),
    };
    account_result(
        client
            .account_action(action)
            .await
            .map_err(|error| error.to_string())?,
    )
}

fn account_result(
    result: prospero_protocol_rs::AccountListResult,
) -> Result<AccountMutation, String> {
    if !result.ok {
        return Err("账号操作失败".into());
    }
    Ok(AccountMutation {
        accounts: result.accounts,
        session_id: result.session_id,
    })
}

async fn create_model_source(
    api_key: String,
    form: ModelSourceForm,
) -> Result<ModelSourceMutation, String> {
    let name = form.name.trim();
    let base_url = form.base_url.trim();
    let credential_name = form.credential_name.trim();
    let route_name = form.route_name.trim();
    let model = form.model.trim();
    let api_key = api_key.trim();
    if [name, base_url, credential_name, route_name, model, api_key]
        .iter()
        .any(|value| value.is_empty())
    {
        return Err("请填写完整的模型源、Endpoint、凭据和 Route".into());
    }
    model_source_action(serde_json::json!({
        "kind": "create",
        "operationId": uuid::Uuid::new_v4().to_string(),
        "name": name,
        "endpoints": [{"protocol": form.protocol, "baseUrl": base_url}],
        "credential": {"name": credential_name, "apiKey": api_key},
        "routes": [{
            "name": route_name, "model": model, "protocol": form.protocol, "enabled": true
        }],
    }))
    .await
}

async fn model_source_action(action: serde_json::Value) -> Result<ModelSourceMutation, String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    let result = client
        .model_source_action(action)
        .await
        .map_err(|error| error.to_string())?;
    if !result.ok {
        return Err(result
            .error
            .and_then(|error| {
                error
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "模型源操作失败".into()));
    }
    Ok(ModelSourceMutation {
        sources: result.sources.unwrap_or_default(),
        accounts: result.accounts,
    })
}

fn agent_name(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::Codex => "codex",
        AgentKind::Claude => "claude",
        AgentKind::Opencode => "opencode",
        AgentKind::Deepseek => "deepseek",
        AgentKind::Grok => "grok",
        AgentKind::Trae => "trae",
        AgentKind::Shell => "shell",
        AgentKind::Custom => "custom",
    }
}

fn resumable_agent(agent: AgentKind) -> bool {
    matches!(
        agent,
        AgentKind::Claude | AgentKind::Codex | AgentKind::Deepseek
    )
}

async fn mutate_plugin(plugin: String, service: String, action: String) -> Result<(), String> {
    let client = Client::from_home(&default_daemon_home()).map_err(|error| error.to_string())?;
    client
        .plugin_service_action(&plugin, &service, &action)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn session_status(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Idle => "Idle",
        SessionStatus::Starting => "Starting",
        SessionStatus::Running => "Running",
        SessionStatus::WaitingPermission => "Approval",
        SessionStatus::WaitingInput => "Input",
        SessionStatus::Completed => "Completed",
        SessionStatus::Failed => "Failed",
    }
}

#[cfg(test)]
mod tests {
    use super::detect_image_mime;

    #[test]
    fn detects_supported_image_signatures() {
        assert_eq!(
            detect_image_mime(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            Some("image/png")
        );
        assert_eq!(detect_image_mime(&[0xff, 0xd8, 0xff]), Some("image/jpeg"));
        assert_eq!(detect_image_mime(b"GIF89a"), Some("image/gif"));
        assert_eq!(
            detect_image_mime(b"RIFF\x00\x00\x00\x00WEBP"),
            Some("image/webp")
        );
    }

    #[test]
    fn rejects_extension_only_and_short_files() {
        assert_eq!(detect_image_mime(b"not an image.png"), None);
        assert_eq!(detect_image_mime(b"RIFFWEBP"), None);
    }
}
