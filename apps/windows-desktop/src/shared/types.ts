export type JsonObject = Record<string, unknown>;

export type SessionInfo = {
  id: string;
  agent: string;
  kind: "pty" | "structured" | string;
  title: string;
  displayTitle?: string;
  cwd: string;
  status: string;
  preview?: string;
  createdAt?: number;
  pendingPermissions?: number;
  pendingQuestions?: number;
  approvalPolicy?: string;
  subagents?: Array<{ id: string; name?: string; role?: string; status?: string }>;
};

export type DeviceInfo = {
  name: string;
  allowShell: boolean;
  allowOrchestration: boolean;
  bound: boolean;
  lastSeenAt?: number;
};

export type DaemonSnapshot = {
  running: boolean;
  managed: boolean;
  starting: boolean;
  startupProgress: number;
  startupStage: string;
  pid?: number;
  port: number;
  bind: string;
  state: string;
  lastError?: string;
  persistence: { pty: boolean; structured: boolean };
  relay: JsonObject;
  sessions: SessionInfo[];
};

export type DesktopSettings = {
  startDaemonOnLaunch: boolean;
  minimizeToTray: boolean;
  launchAtLogin: boolean;
  theme: "system" | "dark" | "light";
  workspaceSort: "recent" | "name";
  terminalFontFamily: string;
  terminalFontSize: number;
};

export type WorkflowTemplateNode = {
  title: string;
  spec: string;
  dependencyIndexes: number[];
  skills: string[];
};

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowTemplateNode[];
  createdAt: number;
  updatedAt: number;
};

export type SkillInfo = {
  name: string;
  description: string;
  path: string;
  scope: string;
};

export type DesktopSnapshot = {
  daemon: DaemonSnapshot;
  projects: string[];
  projectAliases: Record<string, string>;
  pinnedProjectPaths: string[];
  pinnedSessionIds: string[];
  unreadSessionIds: string[];
  workflowTemplates: WorkflowTemplate[];
  devices: DeviceInfo[];
  accounts: JsonObject[];
  orchestration: {
    runs: JsonObject[];
    tasks: JsonObject[];
    dispatches: JsonObject[];
    gates: JsonObject[];
    worktreeAssets: JsonObject[];
  };
  logs: string;
  settings: DesktopSettings;
};

export type SessionCreateInput = {
  cwd: string;
  agent: "codex" | "claude" | "deepseek" | "opencode" | "grok" | "trae" | "shell";
  kind: "structured" | "pty";
  approvalPolicy: "strict" | "standard" | "yolo";
  mode?: "default" | "plan";
  model?: string | undefined;
  effort?: string | undefined;
  command?: string;
  accountId?: string | undefined;
  cols?: number;
  rows?: number;
};

export type UsageWindow = { label: string; utilization: number; resetsAt?: string };
export type UsageDailyBucket = { date: string; tokens: number };
export type CodexAccountUsage = {
  lifetimeTokens?: number;
  creditsUnlimited?: boolean;
  creditsBalance?: string;
  spendLimit?: string;
  spendUsed?: string;
  spendRemainingPercent?: number;
  dailyUsage?: UsageDailyBucket[];
};
export type UsageAccount = {
  agent: string;
  accountId?: string;
  accountName?: string;
  source?: "subscription" | "api" | "unknown";
  available: boolean;
  subscription?: string | null;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  lifetimeTokens?: number;
  creditsUnlimited?: boolean;
  creditsBalance?: string;
  spendLimit?: string;
  spendUsed?: string;
  spendRemainingPercent?: number;
  dailyUsage?: UsageDailyBucket[];
  windows: UsageWindow[];
  reason?: string;
};
export type UsageReport = {
  available: boolean;
  subscription?: string | null;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  lifetimeTokens?: number;
  creditsUnlimited?: boolean;
  creditsBalance?: string;
  spendLimit?: string;
  spendUsed?: string;
  spendRemainingPercent?: number;
  dailyUsage?: UsageDailyBucket[];
  windows?: UsageWindow[];
  accounts?: UsageAccount[];
  reason?: string;
};
export type AgentMode = { id: string; label: string; description?: string };
export type AgentModeCatalog = { modes: AgentMode[]; currentMode?: string };
export type AgentModel = { id: string; label: string; description?: string; supportedEfforts: string[]; defaultEffort?: string; isDefault?: boolean };
export type AgentModelCatalog = { models: AgentModel[]; currentModel?: string; currentEffort?: string };
export type SkillSuggestion = { value: string; label?: string; detail?: string };

export type DesktopApi = {
  getSnapshot(): Promise<DesktopSnapshot>;
  subscribeSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
  startDaemon(): Promise<{ ok: boolean; error?: string }>;
  stopDaemon(): Promise<{ ok: boolean; error?: string }>;
  restartDaemon(): Promise<{ ok: boolean; error?: string }>;
  chooseProject(): Promise<string | null>;
  forgetProject(path: string): Promise<DesktopSnapshot>;
  renameProject(path: string, name: string): Promise<DesktopSnapshot>;
  setProjectPinned(path: string, pinned: boolean): Promise<DesktopSnapshot>;
  setSessionPinned(sessionId: string, pinned: boolean): Promise<DesktopSnapshot>;
  setSessionUnread(sessionId: string, unread: boolean): Promise<DesktopSnapshot>;
  renameSession(sessionId: string, title: string): Promise<DesktopSnapshot>;
  revealPath(path: string): Promise<{ ok: boolean; error?: string }>;
  openWindowsTerminal(path: string): Promise<{ ok: boolean; error?: string }>;
  createSession(input: SessionCreateInput): Promise<SessionInfo>;
  getSessionView(sessionId: string, query?: Record<string, number>): Promise<JsonObject | null>;
  interact(sessionId: string, message: JsonObject): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
  killSession(sessionId: string): Promise<void>;
  getToolOutput(sessionId: string, callId: string): Promise<JsonObject>;
  getSubagentEvents(sessionId: string, subagentId: string): Promise<JsonObject>;
  getUsage(sessionId?: string): Promise<UsageReport>;
  getSkillSuggestions(sessionId: string, query: string): Promise<SkillSuggestion[]>;
  listSkills(cwd: string): Promise<SkillInfo[]>;
  revealSkill(path: string, cwd: string): Promise<{ ok: boolean; error?: string }>;
  getAgentModes(sessionId: string): Promise<AgentModeCatalog>;
  setAgentMode(sessionId: string, mode: string): Promise<{ currentMode: string }>;
  getLaunchModels(agent: "codex" | "claude" | "deepseek", accountId?: string): Promise<AgentModelCatalog>;
  getAgentModels(sessionId: string): Promise<AgentModelCatalog>;
  setAgentModel(sessionId: string, model: string, effort?: string): Promise<{ currentModel: string; currentEffort?: string }>;
  orchestrationAction(method: string, params: JsonObject): Promise<JsonObject>;
  saveWorkflowTemplate(template: WorkflowTemplate): Promise<DesktopSnapshot>;
  deleteWorkflowTemplate(templateId: string): Promise<DesktopSnapshot>;
  resolveGate(gateId: string, decision: string): Promise<void>;
  accountAction(message: JsonObject): Promise<JsonObject>;
  pairDevice(input: { name: string; allowShell: boolean; allowOrchestration: boolean }): Promise<{ output: string; uri?: string }>;
  revokeDevice(name: string): Promise<{ ok: boolean; output: string }>;
  relayAction(input: { action: "status" | "enable" | "disable" | "rotate-key"; url?: string }): Promise<JsonObject>;
  updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSnapshot>;
  clearLogs(): Promise<DesktopSnapshot>;
};
