import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import type {
  DaemonSnapshot,
  DesktopSettings,
  DesktopSnapshot,
  DeviceInfo,
  JsonObject,
  SessionInfo,
  WorkflowTemplate,
} from "../shared/types";

type PersistedDesktopState = {
  projects?: string[];
  settings?: Partial<DesktopSettings>;
  sessionTitles?: Record<string, string>;
  projectAliases?: Record<string, string>;
  pinnedProjectPaths?: string[];
  pinnedSessionIds?: string[];
  unreadSessionIds?: string[];
  workflowTemplates?: WorkflowTemplate[];
};

const SAFE_PERSISTED_SESSION_ID = /^[A-Za-z0-9._:-]{1,160}$/;

const DEFAULT_SETTINGS: DesktopSettings = {
  startDaemonOnLaunch: true,
  minimizeToTray: true,
  launchAtLogin: false,
  theme: "system",
  workspaceSort: "recent",
  terminalFontFamily: "Cascadia Mono, Consolas, monospace",
  terminalFontSize: 13,
  daemonBind: "0.0.0.0",
};

function objectValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readJson(path: string): JsonObject {
  try {
    return objectValue(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function records(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.map(objectValue);
  return Object.values(objectValue(value)).map(objectValue);
}

function normalizeProject(path: string): string {
  const normalized = normalize(resolve(path.trim()));
  return normalized.length > 3 ? normalized.replace(/[\\/]+$/, "") : normalized;
}

export class StateStore extends EventEmitter {
  readonly home: string;
  private readonly desktopStatePath: string;
  private projects: string[] = [];
  private accounts: JsonObject[] = [];
  private settings: DesktopSettings = { ...DEFAULT_SETTINGS };
  private sessionTitles: Record<string, string> = {};
  private projectAliases: Record<string, string> = {};
  private pinnedProjectPaths: string[] = [];
  private pinnedSessionIds: string[] = [];
  private unreadSessionIds: string[] = [];
  private workflowTemplates: WorkflowTemplate[] = [];
  private managedPid: number | undefined;
  private starting = false;
  private startupProgress = 0;
  private startupStage = "";
  private lastError: string | undefined;
  private logs = "";
  private readonly legacyDesktopStatePath: string;

  constructor() {
    super();
    this.home = resolve(process.env["PROSPERO_HOME"] || resolve(homedir(), ".prospero"));
    // 这个客户端现在是跨平台的,文件名不再带 windows-。已经在用的机器上还躺着
    // 旧名字的状态(项目列表、置顶、模板),读的时候要认它,否则升级一次等于清空。
    // 写永远只写新名字,旧文件自然淘汰。
    this.desktopStatePath = resolve(this.home, "desktop.json");
    this.legacyDesktopStatePath = resolve(this.home, "windows-desktop.json");
    mkdirSync(this.home, { recursive: true });
    this.loadDesktopState();
    this.loadLogTail();
  }

  snapshot(): DesktopSnapshot {
    const config = readJson(resolve(this.home, "config.json"));
    const status = readJson(resolve(this.home, "status.json"));
    const rawPid = numberValue(status["pid"]);
    const running = isProcessAlive(rawPid);
    const port = numberValue(status["port"], numberValue(config["port"], 7423));
    const bind = stringValue(status["bind"], stringValue(config["bind"], "0.0.0.0"));
    const persistence = objectValue(status["persistence"]);
    const sessions = arrayValue(status["sessions"]).map((entry): SessionInfo => {
      const value = objectValue(entry);
      const id = stringValue(value["id"]);
      const displayTitle = this.sessionTitles[id];
      return {
        id,
        agent: stringValue(value["agent"], "shell"),
        kind: stringValue(value["kind"], "pty"),
        title: displayTitle || stringValue(value["title"], "未命名会话"),
        ...(displayTitle ? { displayTitle } : {}),
        cwd: stringValue(value["cwd"]),
        status: stringValue(value["status"], "unknown"),
        preview: displayTitle || stringValue(value["preview"]),
        createdAt: numberValue(value["createdAt"]),
        pendingPermissions: numberValue(value["pendingPermissions"]),
        pendingQuestions: numberValue(value["pendingQuestions"]),
        approvalPolicy: stringValue(value["approvalPolicy"]),
        subagents: Array.isArray(value["subagents"])
          ? (value["subagents"] as NonNullable<SessionInfo["subagents"]>)
          : [],
      };
    });

    for (const session of sessions) {
      if (session.cwd && isAbsolute(session.cwd) && existsSync(session.cwd)) this.addProjectInMemory(session.cwd);
    }

    const devicesRoot = readJson(resolve(this.home, "devices.json"));
    const devices = arrayValue(devicesRoot["devices"]).map((entry): DeviceInfo => {
      const value = objectValue(entry);
      const allowShell = booleanValue(value["allowShell"]);
      return {
        name: stringValue(value["name"], "未命名设备"),
        allowShell,
        allowOrchestration: booleanValue(value["allowOrchestration"], allowShell),
        bound: typeof value["clientPubKey"] === "string",
        lastSeenAt: numberValue(value["lastSeenAt"]),
      };
    });

    const orchestration = readJson(resolve(this.home, "orchestration.json"));
    const daemon: DaemonSnapshot = {
      running,
      managed: running && rawPid === this.managedPid,
      starting: this.starting,
      startupProgress: this.startupProgress,
      startupStage: this.startupStage,
      port,
      bind,
      state: running ? "running" : this.starting ? "starting" : this.lastError ? "error" : "stopped",
      persistence: {
        pty: booleanValue(persistence["pty"]),
        structured: booleanValue(persistence["structured"]),
      },
      relay: objectValue(status["relay"] ?? config["relay"]),
      sessions,
      ...(running ? { pid: rawPid } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };

    return {
      daemon,
      projects: [...this.projects],
      projectAliases: { ...this.projectAliases },
      pinnedProjectPaths: [...this.pinnedProjectPaths],
      pinnedSessionIds: [...this.pinnedSessionIds],
      unreadSessionIds: [...this.unreadSessionIds],
      workflowTemplates: this.workflowTemplates.map((template) => ({ ...template, nodes: template.nodes.map((node) => ({ ...node, dependencyIndexes: [...node.dependencyIndexes], skills: [...node.skills] })) })),
      devices,
      accounts: [...this.accounts],
      orchestration: {
        runs: records(orchestration["runs"]),
        tasks: records(orchestration["tasks"]),
        dispatches: records(orchestration["dispatches"]),
        gates: records(orchestration["gates"]),
        worktreeAssets: records(orchestration["worktreeAssets"]),
      },
      logs: this.logs,
      settings: { ...this.settings },
    };
  }

  setManagedState(pid: number | undefined, starting: boolean, error?: string): void {
    const wasStarting = this.starting;
    this.managedPid = pid;
    this.starting = starting;
    this.lastError = error;
    if (starting && !wasStarting) {
      this.startupProgress = 3;
      this.startupStage = "准备启动";
    } else if (!starting) {
      this.startupProgress = pid && !error ? 100 : 0;
      this.startupStage = error ? "启动失败" : pid ? "daemon 已就绪" : "";
    }
    this.changed();
  }

  setStartupProgress(progress: number, stage: string, pid?: number): void {
    if (pid !== undefined) this.managedPid = pid;
    this.starting = true;
    this.startupProgress = Math.max(0, Math.min(100, Math.round(progress)));
    this.startupStage = stage.trim().slice(0, 120);
    this.lastError = undefined;
    this.changed();
  }

  rememberProject(path: string): DesktopSnapshot {
    if (!isAbsolute(path) || !existsSync(path)) throw new Error("项目文件夹不存在");
    this.addProjectInMemory(normalizeProject(path), true);
    this.saveDesktopState();
    this.changed();
    return this.snapshot();
  }

  forgetProject(path: string): DesktopSnapshot {
    const normalized = normalizeProject(path);
    if (!this.projects.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error("项目不在桌面端列表中");
    this.projects = this.projects.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase());
    delete this.projectAliases[normalized.toLocaleLowerCase()];
    this.pinnedProjectPaths = this.pinnedProjectPaths.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase());
    this.saveDesktopState();
    this.changed();
    return this.snapshot();
  }

  renameProject(path: string, name: string): DesktopSnapshot {
    const normalized = normalizeProject(path);
    if (!this.projects.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error("项目不在桌面端列表中");
    const alias = name.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!alias) throw new Error("工作区名称不能为空");
    this.projectAliases[normalized.toLocaleLowerCase()] = alias;
    this.saveDesktopState();
    this.changed();
    return this.snapshot();
  }

  setProjectPinned(path: string, pinned: boolean): DesktopSnapshot {
    const normalized = normalizeProject(path);
    if (!this.projects.some((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase())) throw new Error("工作区不存在");
    this.pinnedProjectPaths = pinned
      ? [...new Set([...this.pinnedProjectPaths, normalized])]
      : this.pinnedProjectPaths.filter((item) => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase());
    this.saveDesktopState();
    this.changed();
    return this.snapshot();
  }

  setSessionPinned(sessionId: string, pinned: boolean): DesktopSnapshot {
    if (!SAFE_PERSISTED_SESSION_ID.test(sessionId) || !this.snapshot().daemon.sessions.some((session) => session.id === sessionId)) throw new Error("会话不存在");
    this.pinnedSessionIds = pinned
      ? [...new Set([...this.pinnedSessionIds, sessionId])]
      : this.pinnedSessionIds.filter((id) => id !== sessionId);
    this.saveDesktopState();
    this.changed();
    return this.snapshot();
  }

  setSessionUnread(sessionId: string, unread: boolean): DesktopSnapshot {
    if (!SAFE_PERSISTED_SESSION_ID.test(sessionId) || !this.snapshot().daemon.sessions.some((session) => session.id === sessionId)) throw new Error("会话不存在");
    this.unreadSessionIds = unread
      ? [...new Set([...this.unreadSessionIds, sessionId])]
      : this.unreadSessionIds.filter((id) => id !== sessionId);
    this.saveDesktopState();
    this.changed();
    return this.snapshot();
  }

  saveWorkflowTemplate(template: WorkflowTemplate): DesktopSnapshot {
    if (!SAFE_PERSISTED_SESSION_ID.test(template.id)) throw new Error("模板 ID 无效");
    const name = template.name.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!name) throw new Error("模板名称不能为空");
    const description = template.description.trim().slice(0, 500);
    if (!Array.isArray(template.nodes) || template.nodes.length === 0 || template.nodes.length > 100) throw new Error("模板任务数量无效");
    const nodes = template.nodes.map((node, index) => {
      const title = node.title.trim().slice(0, 200);
      const spec = node.spec.trim().slice(0, 4_000);
      if (!title || !spec) throw new Error(`模板任务 ${String(index + 1)} 无效`);
      const dependencyIndexes = [...new Set(node.dependencyIndexes.filter((value) => Number.isInteger(value) && value >= 0 && value < template.nodes.length && value !== index))];
      const skills = [...new Set(node.skills.map((skill) => skill.trim()).filter(Boolean))].slice(0, 5);
      return { title, spec, dependencyIndexes, skills };
    });
    const now = Date.now();
    const existing = this.workflowTemplates.find((item) => item.id === template.id);
    const normalized: WorkflowTemplate = { id: template.id, name, description, nodes, createdAt: existing?.createdAt ?? template.createdAt ?? now, updatedAt: now };
    this.workflowTemplates = existing ? this.workflowTemplates.map((item) => item.id === normalized.id ? normalized : item) : [normalized, ...this.workflowTemplates];
    this.saveDesktopState();
    this.changed();
    return this.snapshot();
  }

  deleteWorkflowTemplate(templateId: string): DesktopSnapshot {
    if (!this.workflowTemplates.some((template) => template.id === templateId)) throw new Error("模板不存在");
    this.workflowTemplates = this.workflowTemplates.filter((template) => template.id !== templateId);
    this.saveDesktopState();
    this.changed();
    return this.snapshot();
  }

  renameSession(sessionId: string, title: string): DesktopSnapshot {
    if (!this.snapshot().daemon.sessions.some((session) => session.id === sessionId)) throw new Error("会话不存在");
    const normalized = title.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!normalized) throw new Error("会话名称不能为空");
    this.sessionTitles[sessionId] = normalized;
    this.saveDesktopState();
    this.changed();
    return this.snapshot();
  }

  forgetSessionTitle(sessionId: string): void {
    if (!(sessionId in this.sessionTitles)) return;
    delete this.sessionTitles[sessionId];
    this.saveDesktopState();
    this.changed();
  }

  updateSettings(patch: Partial<DesktopSettings>): DesktopSnapshot {
    const next = { ...this.settings };
    if (typeof patch.startDaemonOnLaunch === "boolean") next.startDaemonOnLaunch = patch.startDaemonOnLaunch;
    if (typeof patch.minimizeToTray === "boolean") next.minimizeToTray = patch.minimizeToTray;
    if (typeof patch.launchAtLogin === "boolean") next.launchAtLogin = patch.launchAtLogin;
    if (patch.theme === "system" || patch.theme === "dark" || patch.theme === "light") next.theme = patch.theme;
    if (patch.workspaceSort === "recent" || patch.workspaceSort === "name") next.workspaceSort = patch.workspaceSort;
    if (typeof patch.terminalFontFamily === "string" && patch.terminalFontFamily.trim()) next.terminalFontFamily = patch.terminalFontFamily.trim().slice(0, 200);
    if (typeof patch.terminalFontSize === "number" && patch.terminalFontSize >= 9 && patch.terminalFontSize <= 32) next.terminalFontSize = patch.terminalFontSize;
    // 只接受点分四段的 IPv4:这个值会直接变成 daemon 的 --bind 参数,
    // 而 daemon 拿到一个不在本机的地址会启动失败,错误只出现在日志里。
    if (typeof patch.daemonBind === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(patch.daemonBind.trim())) next.daemonBind = patch.daemonBind.trim();
    this.settings = next;
    this.saveDesktopState();
    this.changed();
    return this.snapshot();
  }

  setAccounts(accounts: unknown): void {
    this.accounts = records(accounts).map((account) => {
      const { apiKey: _apiKey, credential: _credential, token: _token, ...safe } = account;
      return safe;
    });
    this.changed();
  }

  appendLog(value: string): void {
    if (!value) return;
    const safe = value.replace(/(hostSecret|controlToken|token|ticket|authorization)(\s*[:=]\s*)([^\s,}\]]+)/gi, "$1$2[REDACTED]");
    this.logs = `${this.logs}${safe}`.split(/\r?\n/).slice(-500).join("\n");
    try {
      writeFileSync(resolve(this.home, "desktop.log"), this.logs, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Logging must never take down the desktop host.
    }
    this.changed();
  }

  clearLogs(): DesktopSnapshot {
    this.logs = "";
    try { writeFileSync(resolve(this.home, "desktop.log"), "", { encoding: "utf8", mode: 0o600 }); } catch { /* ignored */ }
    this.changed();
    return this.snapshot();
  }

  controlCredentials(): { port: number; token: string } {
    const status = readJson(resolve(this.home, "status.json"));
    const pid = numberValue(status["pid"]);
    const token = stringValue(status["controlToken"]);
    if (!isProcessAlive(pid) || !token) throw new Error("daemon 尚未提供本机控制接口");
    return { port: numberValue(status["port"], 7423), token };
  }

  projectName(path: string): string {
    return basename(path) || path;
  }

  isKnownPath(path: string): boolean {
    if (!isAbsolute(path)) return false;
    const candidate = normalizeProject(path).toLocaleLowerCase();
    const snapshot = this.snapshot();
    const known = [
      ...snapshot.projects,
      ...snapshot.daemon.sessions.map((session) => session.cwd),
      ...snapshot.orchestration.worktreeAssets.map((asset) => stringValue(asset["path"])),
    ].filter(Boolean).map((item) => normalizeProject(item).toLocaleLowerCase());
    return known.includes(candidate);
  }

  private addProjectInMemory(path: string, front = false): void {
    const normalized = normalizeProject(path);
    const existing = this.projects.findIndex((item) => item.toLocaleLowerCase() === normalized.toLocaleLowerCase());
    if (existing >= 0) this.projects.splice(existing, 1);
    front ? this.projects.unshift(normalized) : this.projects.push(normalized);
  }

  private loadDesktopState(): void {
    // 新名字优先;它不存在(或是空对象)时回落到改名前的文件。
    const current = readJson(this.desktopStatePath) as PersistedDesktopState;
    const raw = Object.keys(current).length > 0
      ? current
      : readJson(this.legacyDesktopStatePath) as PersistedDesktopState;
    for (const path of Array.isArray(raw.projects) ? raw.projects : []) {
      if (typeof path === "string" && isAbsolute(path) && existsSync(path)) this.addProjectInMemory(path);
    }
    const stored = objectValue(raw.settings);
    this.sessionTitles = Object.fromEntries(
      Object.entries(objectValue(raw.sessionTitles))
        .filter(([id, title]) => SAFE_PERSISTED_SESSION_ID.test(id) && typeof title === "string" && title.trim())
        .map(([id, title]) => [id, String(title).trim().slice(0, 120)]),
    );
    this.projectAliases = Object.fromEntries(
      Object.entries(objectValue(raw.projectAliases))
        .filter(([path, alias]) => isAbsolute(path) && typeof alias === "string" && alias.trim())
        .map(([path, alias]) => [normalizeProject(path).toLocaleLowerCase(), String(alias).trim().slice(0, 80)]),
    );
    this.pinnedSessionIds = arrayValue(raw.pinnedSessionIds).filter((value): value is string => typeof value === "string" && SAFE_PERSISTED_SESSION_ID.test(value));
    this.pinnedProjectPaths = arrayValue(raw.pinnedProjectPaths).filter((value): value is string => typeof value === "string" && isAbsolute(value)).map(normalizeProject);
    this.unreadSessionIds = arrayValue(raw.unreadSessionIds).filter((value): value is string => typeof value === "string" && SAFE_PERSISTED_SESSION_ID.test(value));
    this.workflowTemplates = arrayValue(raw.workflowTemplates).map(objectValue).flatMap((value): WorkflowTemplate[] => {
      const id = stringValue(value["id"]); const name = stringValue(value["name"]); const nodes = arrayValue(value["nodes"]).map(objectValue);
      if (!SAFE_PERSISTED_SESSION_ID.test(id) || !name.trim() || nodes.length === 0 || nodes.length > 100) return [];
      return [{
        id,
        name: name.trim().slice(0, 120),
        description: stringValue(value["description"]).trim().slice(0, 500),
        nodes: nodes.map((node) => ({
          title: stringValue(node["title"]).trim().slice(0, 200),
          spec: stringValue(node["spec"]).trim().slice(0, 4_000),
          dependencyIndexes: arrayValue(node["dependencyIndexes"]).filter((item): item is number => Number.isInteger(item) && Number(item) >= 0).map(Number),
          skills: arrayValue(node["skills"]).filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 5),
        })).filter((node) => node.title && node.spec),
        createdAt: numberValue(value["createdAt"], Date.now()),
        updatedAt: numberValue(value["updatedAt"], Date.now()),
      }];
    }).filter((template) => template.nodes.length > 0);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      theme: stored["theme"] === "dark" || stored["theme"] === "light" ? stored["theme"] : "system",
      workspaceSort: stored["workspaceSort"] === "name" ? "name" : "recent",
    } as DesktopSettings;
  }

  private saveDesktopState(): void {
    mkdirSync(dirname(this.desktopStatePath), { recursive: true });
    writeFileSync(this.desktopStatePath, JSON.stringify({ projects: this.projects, settings: this.settings, sessionTitles: this.sessionTitles, projectAliases: this.projectAliases, pinnedProjectPaths: this.pinnedProjectPaths, pinnedSessionIds: this.pinnedSessionIds, unreadSessionIds: this.unreadSessionIds, workflowTemplates: this.workflowTemplates }, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  private loadLogTail(): void {
    for (const name of ["desktop.log", "windows-desktop.log"]) {
      try {
        this.logs = readFileSync(resolve(this.home, name), "utf8").split(/\r?\n/).slice(-500).join("\n");
        return;
      } catch { /* 换下一个名字 */ }
    }
    this.logs = "";
  }

  private changed(): void {
    this.emit("changed", this.snapshot());
  }
}
