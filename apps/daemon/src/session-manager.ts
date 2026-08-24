import { EventEmitter } from "node:events";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  ApprovalPolicy,
  Attachment,
  AgentEventBody,
  AgentKind,
  SessionInfo,
  SessionKind,
} from "@prospero/protocol";
import {
  commandFor,
  defaultKindFor,
  noopCommand,
  programCommandFor,
  requiresShellCapability,
  spawnEnv,
  structuredCapable,
} from "./agents.js";
import { PtySession } from "./pty-session.js";
import {
  RemotePtySession,
  launchPtySupervisor,
  reconnectPtySupervisors,
  type LaunchPtySupervisorInput,
} from "./pty-supervisor-client.js";
import {
  RemoteWindowsPtySession,
  launchWindowsPtySession,
  reconnectWindowsPtySessions,
} from "./windows-pty-session.js";
import * as tmux from "./tmux.js";
import {
  StructuredSession,
  titleFor,
  type QueuedChatPersistent,
  type StructuredSessionPersistentState,
} from "./structured-session.js";
import {
  RemoteStructuredSession,
  launchStructuredSupervisor,
  reconnectStructuredSupervisors,
  type LaunchStructuredSupervisorInput,
} from "./structured-supervisor-client.js";
import {
  WindowsRemoteStructuredSession,
  canFallbackToInProcessStructured,
  launchWindowsStructuredSession,
  reconnectWindowsStructuredSessions,
  type LaunchWindowsStructuredSessionInput,
} from "./windows-structured-session-client.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { DeepseekAdapter } from "./adapters/deepseek.js";
import { GrokAdapter } from "./adapters/grok.js";
import { OpencodeAdapter } from "./adapters/opencode.js";
import type {
  AdapterResumeState,
  AgentAdapter,
  AgentModelCatalog,
} from "./adapters/types.js";
import type { AccountBinding, AccountLoginSpec } from "./agent-accounts.js";
import {
  waitForPtyStartupReadiness,
  type PtyStartupReadinessOptions,
} from "./pty-startup-readiness.js";

export type SessionErrorCode =
  | "shell_not_allowed"
  | "agent_unavailable"
  | "conflict"
  | "session_not_found";

export type SessionErrorReason = "conversation_active_writer";

function isConversationActiveWriterError(error: unknown): boolean {
  return error instanceof Error && /already has an active writer/i.test(error.message);
}

export class SessionError extends Error {
  constructor(
    message: string,
    public readonly code: SessionErrorCode,
    public readonly reason?: SessionErrorReason,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export interface CreateSessionInput {
  agent: AgentKind;
  /** Codex / Claude Code 的隔离账号；省略保持旧版的本机环境。 */
  accountId?: string | undefined;
  /** 省略时按 agent 能力决定:有适配器的走 structured */
  kind?: SessionKind | undefined;
  approvalPolicy?: ApprovalPolicy | undefined;
  cwd?: string | undefined;
  command?: string | undefined;
  /** 结构化会话从第一轮起使用的协作模式。 */
  mode?: "default" | "plan" | undefined;
  /** 结构化会话从第一轮起使用的模型与推理强度。 */
  model?: string | undefined;
  effort?: string | undefined;
  agentPreset?: string | undefined;
  /** Agent 原生本机会话 ID；只允许 Claude/Codex 结构化轨。 */
  resume?: { id: string; title?: string | undefined; fork?: true | undefined } | undefined;
  cols: number;
  rows: number;
  /** 来自设备注册表:该设备是否允许 shell/custom(完整用户权限) */
  allowShell: boolean;
}

/** 终止时可保留已结束结构化会话的本地只读历史。 */
export interface KillSessionOptions {
  preserveHistory?: boolean;
}

export interface SessionManagerEvents {
  output: [sid: string, dataB64: string, seq: number];
  agentEvent: [sid: string, body: AgentEventBody, evSeq: number];
  state: [info: SessionInfo];
}

function makeAdapter(agent: AgentKind, resumeState?: AdapterResumeState): AgentAdapter {
  switch (agent) {
    case "opencode":
      return new OpencodeAdapter({ resumeState });
    case "claude":
      return new ClaudeAdapter({ resumeState });
    case "codex":
      return new CodexAdapter({ resumeState });
    case "deepseek":
      return new DeepseekAdapter({ resumeState });
    case "grok":
      return new GrokAdapter({ resumeState });
    default:
      throw new SessionError(`agent "${agent}" 暂无结构化适配器`, "agent_unavailable");
  }
}

/** 恢复 tmux 会话所需的最小元数据(tmux 只记得会话名) */
interface PtyMeta {
  id: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  accountId?: string;
  accountName?: string;
}

function parseStructuredState(value: unknown): StructuredSessionPersistentState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const agents = new Set<AgentKind>(["claude", "codex", "opencode", "grok", "deepseek"]);
  const policies = new Set<ApprovalPolicy>(["strict", "standard", "yolo"]);
  if (
    v["version"] !== 1 ||
    typeof v["id"] !== "string" ||
    typeof v["agent"] !== "string" ||
    !agents.has(v["agent"] as AgentKind) ||
    typeof v["title"] !== "string" ||
    typeof v["cwd"] !== "string" ||
    typeof v["createdAt"] !== "number" ||
    typeof v["approvalPolicy"] !== "string" ||
    !policies.has(v["approvalPolicy"] as ApprovalPolicy) ||
    !Array.isArray(v["events"])
  ) {
    return null;
  }
  const rawTotals =
    v["totals"] && typeof v["totals"] === "object"
      ? (v["totals"] as Record<string, unknown>)
      : {};
  const number = (x: unknown): number =>
    typeof x === "number" && Number.isFinite(x) ? x : 0;
  const toolOutputs = Array.isArray(v["toolOutputs"])
    ? v["toolOutputs"].filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string",
      )
    : [];
  const adapterState =
    v["adapterState"] &&
    typeof v["adapterState"] === "object" &&
    !Array.isArray(v["adapterState"])
      ? (v["adapterState"] as AdapterResumeState)
      : {};
  const imageMimes = new Set<Attachment["mimeType"]>([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);
  const messageQueue: QueuedChatPersistent[] = Array.isArray(v["messageQueue"])
    ? v["messageQueue"]
        .flatMap((raw): QueuedChatPersistent[] => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
          const item = raw as Record<string, unknown>;
          if (
            typeof item["id"] !== "string" ||
            typeof item["displayText"] !== "string" ||
            typeof item["outgoingText"] !== "string" ||
            (item["kind"] !== "queue" && item["kind"] !== "guide") ||
            typeof item["createdAt"] !== "number" ||
            !Number.isFinite(item["createdAt"]) ||
            typeof item["attachmentCount"] !== "number" ||
            !Number.isInteger(item["attachmentCount"]) ||
            item["attachmentCount"] < 0
          ) {
            return [];
          }
          const attachments = Array.isArray(item["attachments"])
            ? item["attachments"].flatMap((rawAttachment) => {
                if (
                  !rawAttachment ||
                  typeof rawAttachment !== "object" ||
                  Array.isArray(rawAttachment)
                ) {
                  return [];
                }
                const attachment = rawAttachment as Record<string, unknown>;
                if (
                  typeof attachment["mimeType"] !== "string" ||
                  !imageMimes.has(attachment["mimeType"] as Attachment["mimeType"]) ||
                  typeof attachment["path"] !== "string"
                ) {
                  return [];
                }
                const id =
                  typeof attachment["id"] === "string" && /^[A-Za-z0-9._-]+$/.test(attachment["id"])
                    ? attachment["id"]
                    : path.basename(attachment["path"]);
                if (!/^[A-Za-z0-9._-]+$/.test(id)) return [];
                return [
                  {
                    id,
                    mimeType: attachment["mimeType"] as Attachment["mimeType"],
                    path: attachment["path"],
                    ...(typeof attachment["name"] === "string"
                      ? { name: attachment["name"] }
                      : {}),
                  },
                ];
              })
            : [];
          return [
            {
              id: item["id"],
              displayText: item["displayText"],
              outgoingText: item["outgoingText"],
              kind: item["kind"],
              createdAt: item["createdAt"],
              attachmentCount: item["attachmentCount"],
              attachments,
            },
          ];
        })
        .slice(0, 50)
    : [];
  return {
    version: 1,
    id: v["id"],
    agent: v["agent"] as AgentKind,
    title: v["title"],
    cwd: v["cwd"],
    ...(typeof v["accountId"] === "string" ? { accountId: v["accountId"] } : {}),
    ...(typeof v["accountName"] === "string" ? { accountName: v["accountName"] } : {}),
    createdAt: v["createdAt"],
    approvalPolicy: v["approvalPolicy"] as ApprovalPolicy,
    events: v["events"] as AgentEventBody[],
    evSeq: Math.max(0, number(v["evSeq"])),
    preview: typeof v["preview"] === "string" ? v["preview"] : "",
    previewRaw: typeof v["previewRaw"] === "string" ? v["previewRaw"] : "",
    previewMsgId: typeof v["previewMsgId"] === "string" ? v["previewMsgId"] : "",
    totals: {
      costUsd: number(rawTotals["costUsd"]),
      inputTokens: number(rawTotals["inputTokens"]),
      outputTokens: number(rawTotals["outputTokens"]),
    },
    toolOutputs,
    adapterState,
    messageQueue,
    ...(v["terminal"] === true ? { terminal: true as const } : {}),
  };
}

export interface SessionManagerOptions {
  /** 结构化会话事件与原生恢复 ID 的持久化目录。 */
  home?: string | undefined;
  /** tmux 托管:agent 跑在 tmux 里,daemon 重启后进程与画面都还在 */
  tmux?: { home: string } | undefined;
  /** 测试注入；生产环境使用上面的各官方适配器。 */
  adapterFactory?: ((agent: AgentKind, state?: AdapterResumeState) => AgentAdapter) | undefined;
  /** 每个会话各自注入的本地环境（编排 CLI 的身份和控制 socket 在这里进入）。 */
  sessionEnv?: ((sessionId: string) => Record<string, string>) | undefined;
  /** 账号目录由 daemon 的元数据层解析；SessionManager 只负责注入会话。 */
  accountResolver?: ((accountId: string, agent: "claude" | "codex") => AccountBinding) | undefined;
  /**
   * Production Unix defaults to detached per-session supervisors when a home
   * exists. Tests that inject adapters and unsupported platforms stay safely
   * in-process; this flag is also an explicit operator rollback.
   */
  supervisor?: boolean | undefined;
  /** Test seam for the detached launcher; production uses the real launcher. */
  supervisorLauncher?: ((input: LaunchStructuredSupervisorInput) => Promise<RemoteStructuredSession>) | undefined;
  /** Windows-only native Session Host seam; production uses the N-API launcher. */
  windowsStructuredLauncher?: ((input: LaunchWindowsStructuredSessionInput) => Promise<WindowsRemoteStructuredSession>) | undefined;
  /** Immutable daemon-start executable for newly launched structured owners. */
  supervisorRunnerPath?: string | undefined;
  /** Detached PTY owners; production daemon opts in, direct unit tests do not. */
  ptySupervisor?: boolean | undefined;
  /** Test seam for detached PTY host launch. */
  ptySupervisorLauncher?: ((input: LaunchPtySupervisorInput) => Promise<RemotePtySession>) | undefined;
  /** Windows uses the N-API Session Host by default; false is an explicit direct-PTY rollback. */
  windowsPtySessionHost?: boolean | undefined;
  /** One explicit Windows host feature gate for both PTY and structured sessions. */
  windowsSessionHost?: boolean | undefined;
}

/** Public recovery provenance: hosted owners are durable, direct ones are daemon-local. */
export type SessionHosting = "hosted" | "direct" | "unavailable";

/** 恢复前由编排层判定应封存的会话；避免 adapter 先接回并 drain 旧队列。 */
export interface RestoreStructuredOptions {
  preserveHistoryWhen?: (state: StructuredSessionPersistentState) => boolean;
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly ptySessions = new Map<string, PtySession | RemotePtySession | RemoteWindowsPtySession>();
  private readonly structuredSessions = new Map<string, StructuredSession | RemoteStructuredSession | WindowsRemoteStructuredSession>();
  private readonly tmuxConfigFile: string | null;
  private readonly tmuxBin: string | null;

  private readonly metaFile: string | null;
  private readonly structuredFile: string | null;
  private readonly adapterFactory: (agent: AgentKind, state?: AdapterResumeState) => AgentAdapter;
  private readonly sessionEnv: (sessionId: string) => Record<string, string>;
  private readonly accountResolver:
    | ((accountId: string, agent: "claude" | "codex") => AccountBinding)
    | undefined;
  private readonly structuredSupervisorRoot: string | null;
  /** Native secure-state directories must be direct children of an existing root. */
  private readonly windowsStructuredRoot: string | null;
  private readonly ptySupervisorRoot: string | null;
  private readonly windowsPtySessionHostRoot: string | null;
  private readonly useStructuredSupervisor: boolean;
  private readonly useWindowsStructuredHost: boolean;
  private readonly supervisorLauncher: (input: LaunchStructuredSupervisorInput) => Promise<RemoteStructuredSession>;
  private readonly windowsStructuredLauncher: (input: LaunchWindowsStructuredSessionInput) => Promise<WindowsRemoteStructuredSession>;
  private readonly supervisorRunnerPath: string | undefined;
  private readonly usePtySupervisor: boolean;
  private readonly useWindowsPtySessionHost: boolean;
  /** Becomes true only after an actual native host attach succeeds. */
  private windowsPtySessionHostDurable = false;
  private readonly ptySupervisorLauncher: (input: LaunchPtySupervisorInput) => Promise<RemotePtySession>;
  private persistTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  /** 串行化 structured-sessions.json 的异步写,避免并发写同一 .tmp 互相覆盖。 */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(opts: SessionManagerOptions = {}) {
    super();
    // 没装 tmux 就静默退回直接 spawn —— 托管是增强,不该变成硬依赖
    this.tmuxBin = opts.tmux ? tmux.tmuxPath() : null;
    this.tmuxConfigFile = this.tmuxBin && opts.tmux ? tmux.writeConfig(opts.tmux.home) : null;
    if (this.tmuxBin && this.tmuxConfigFile) {
      // `tmux -f` is ignored after a server already exists. Reload only the
      // safe server capabilities; per-session input/UI options are targeted
      // after each attach below.
      tmux.reloadConfig(this.tmuxBin);
    }
    this.metaFile = opts.tmux ? path.join(opts.tmux.home, "pty-sessions.json") : null;
    const home = opts.home ?? opts.tmux?.home;
    this.structuredFile = home ? path.join(home, "structured-sessions.json") : null;
    this.structuredSupervisorRoot = home ? path.join(home, "structured-supervisor") : null;
    this.windowsStructuredRoot = home ?? null;
    this.ptySupervisorRoot = home ? path.join(home, "pty-supervisor") : null;
    this.windowsPtySessionHostRoot = home ? path.join(home, "windows-session-host") : null;
    this.adapterFactory = opts.adapterFactory ?? makeAdapter;
    this.sessionEnv = opts.sessionEnv ?? (() => ({}));
    this.accountResolver = opts.accountResolver;
    this.supervisorLauncher = opts.supervisorLauncher ?? launchStructuredSupervisor;
    this.windowsStructuredLauncher = opts.windowsStructuredLauncher ?? launchWindowsStructuredSession;
    this.supervisorRunnerPath = opts.supervisorRunnerPath;
    this.ptySupervisorLauncher = opts.ptySupervisorLauncher ?? launchPtySupervisor;
    // An injected adapter is the test seam. It cannot safely cross a process
    // boundary, so retain the long-standing in-process behavior there. The
    // daemon opts in explicitly; direct SessionManager construction remains a
    // deterministic in-process test/library fallback.
    this.useStructuredSupervisor =
      !!opts.supervisorLauncher || (
        opts.supervisor === true && !opts.adapterFactory && !!this.structuredSupervisorRoot && process.platform !== "win32"
      );
    this.useWindowsStructuredHost =
      process.platform === "win32" && opts.windowsSessionHost !== false && !!this.windowsStructuredRoot && !opts.adapterFactory &&
      (opts.supervisor === true || !!opts.windowsStructuredLauncher);
    // tmux remains an explicit compatibility path. A PTY host already owns
    // both the terminal state and its process; stacking tmux beneath it only
    // obscures explicit kill semantics.
    this.usePtySupervisor =
      // Windows has neither a peer-authenticated Named Pipe transport nor a
      // Job Object/process-tree implementation here.  Keep detached PTY
      // ownership fail-closed even when a test seam happens to be supplied.
      process.platform !== "win32" && !this.tmuxEnabled && (
        !!opts.ptySupervisorLauncher || (
          opts.ptySupervisor === true && !!this.ptySupervisorRoot
        )
      );
    this.useWindowsPtySessionHost =
      process.platform === "win32" && opts.windowsSessionHost !== false && opts.windowsPtySessionHost !== false && !!this.windowsPtySessionHostRoot && !this.tmuxEnabled;
  }

  /**
   * 重新接管上一轮 daemon 留下的 tmux 会话。
   * tmux 只记得会话名,agent/title/cwd 这些是我们自己存的;两边取交集 ——
   * 元数据里有但 tmux 没有的是已经结束的,tmux 有但元数据没有的不归我们管。
   */
  async restoreFromTmux(): Promise<SessionInfo[]> {
    if (!this.tmuxEnabled || !this.metaFile) return [];
    const alive = new Set(tmux.listSessions());
    if (alive.size === 0) {
      this.persistMeta();
      return [];
    }
    const restored: SessionInfo[] = [];
    for (const meta of this.loadMeta()) {
      if (!alive.has(meta.id) || this.ptySessions.has(meta.id)) continue;
      try {
        // `new-session -A` 存在即 attach,所以恢复和新建走同一条命令
        const account = meta.accountId
          ? this.resolveAccount(meta.agent, meta.accountId)
          : undefined;
        restored.push(
          await this.spawnPty(
            meta.id,
            meta.agent,
            meta.title,
            meta.cwd,
            meta.cols,
            meta.rows,
            undefined,
            account,
          ),
        );
      } catch {
        // 单个恢复失败不该拖垮启动
      }
    }
    this.persistMeta();
    return restored;
  }

  /**
   * Reconnect only to a manifest's existing owner. A dead/stale manifest is
   * retained as read-only failed history; this scan never starts a replacement
   * command, preventing duplicate agents after daemon restart.
   */
  async restorePtySupervisors(): Promise<SessionInfo[]> {
    if (this.useWindowsPtySessionHost && this.windowsPtySessionHostRoot) {
      const restored: SessionInfo[] = [];
      for (const session of await reconnectWindowsPtySessions(this.windowsPtySessionHostRoot)) {
        if (this.ptySessions.has(session.id)) continue;
        this.wirePtySession(session);
        this.ptySessions.set(session.id, session);
        if (session.hosting === "windows-session-host") this.windowsPtySessionHostDurable = true;
        restored.push(session.info());
        this.emit("state", session.info());
      }
      return restored;
    }
    if (!this.ptySupervisorRoot) return [];
    const restored: SessionInfo[] = [];
    for (const session of await reconnectPtySupervisors(this.ptySupervisorRoot)) {
      if (this.ptySessions.has(session.id)) continue;
      this.wirePtySession(session);
      this.ptySessions.set(session.id, session);
      restored.push(session.info());
      this.emit("state", session.info());
    }
    return restored;
  }

  private loadMeta(): PtyMeta[] {
    if (!this.metaFile) return [];
    try {
      const raw = readFileSync(this.metaFile, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PtyMeta[]) : [];
    } catch {
      return [];
    }
  }

  private persistMeta(): void {
    if (!this.metaFile) return;
    const meta: PtyMeta[] = [...this.ptySessions.values()].map((s) => {
      const info = s.info();
      return {
        id: info.id,
        agent: info.agent,
        title: info.title,
        cwd: info.cwd,
        cols: info.cols,
        rows: info.rows,
        ...(info.accountId ? { accountId: info.accountId } : {}),
        ...(info.accountName ? { accountName: info.accountName } : {}),
      };
    });
    try {
      writeFileSync(this.metaFile, JSON.stringify(meta, null, 2));
      chmodSync(this.metaFile, 0o600);
    } catch {
      // 记不下来只影响下次恢复,不影响当前会话
    }
  }

  private loadStructuredStates(): StructuredSessionPersistentState[] {
    if (!this.structuredFile) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.structuredFile, "utf8"));
      return Array.isArray(parsed)
        ? parsed.map(parseStructuredState).filter((x): x is StructuredSessionPersistentState => x !== null)
        : [];
    } catch {
      return [];
    }
  }

  private scheduleStructuredPersist(): void {
    if (!this.structuredFile || this.shuttingDown || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistStructuredNow();
    }, 200);
    this.persistTimer.unref?.();
  }

  private persistStructuredNow(): Promise<void> {
    // 闭包内 readonly 字段不会被 TS 收窄,先落局部变量。
    const file = this.structuredFile;
    if (!file) return Promise.resolve();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const tmp = `${file}.tmp`;
    // 串行化异步写盘,一次只落一个版本;不阻塞唯一事件循环。
    // 这里正是“tmux 越用越卡”的主因:每次结构化事件后同步全量重写
    // ~40MB 的 structured-sessions.json,写盘越久卡得越明显。
    const run = this.persistChain.then(async () => {
      try {
        // Supervisor-owned session.json is authoritative for detached sessions.
        // Keeping it out of this legacy daemon file prevents daemon shutdown
        // from overwriting/restarting a live owner on the next boot.
        const states = [...this.structuredSessions.values()]
          .filter((s): s is StructuredSession => s instanceof StructuredSession)
          .map((s) => s.persistentState());
        // 去掉 null,2 美化:文件 0600 私有,体积 40MB→~13MB,写盘和 stringify 都更快。
        await writeFile(tmp, JSON.stringify(states), { mode: 0o600 });
        await rename(tmp, file);
        await chmod(file, 0o600);
      } catch {
        // 持久化失败不能打断正在运行的 agent；下一次事件会再次尝试。
      }
    });
    this.persistChain = run.catch(() => {});
    return run;
  }

  /** 测试和优雅退出使用；确保 debounce 中的最后一批事件已经落盘。 */
  async flushPersistence(): Promise<void> {
    this.persistMeta();
    await this.persistStructuredNow();
  }

  /**
   * 恢复结构化会话。Prospero 事件日志负责 UI，adapterState 让原生 CLI
   * 接回模型上下文；单个后端失效时仍保留历史供查看和删除。
   */
  async restoreStructured(options: RestoreStructuredOptions = {}): Promise<SessionInfo[]> {
    const restored: SessionInfo[] = [];
    // Reattach first: each manifest represents the already-running owner. A
    // missing/stale/incompatible one is kept visible but read-only; scanning
    // must never invoke the launcher or replay a queued native turn.
    if (this.useWindowsStructuredHost && this.windowsStructuredRoot) {
      try {
        for (const session of await reconnectWindowsStructuredSessions(this.windowsStructuredRoot)) {
          if (this.structuredSessions.has(session.id)) continue;
          this.wireStructuredSession(session);
          this.structuredSessions.set(session.id, session);
          restored.push(session.info());
          this.emit("state", session.info());
        }
      } catch {
        // No native N-API host means legacy in-process sessions remain
        // explicitly non-durable; do not infer or recreate a durable owner.
      }
    } else if (this.structuredSupervisorRoot) {
      for (const session of await reconnectStructuredSupervisors(this.structuredSupervisorRoot)) {
        if (this.structuredSessions.has(session.id)) continue;
        this.wireStructuredSession(session);
        this.structuredSessions.set(session.id, session);
        restored.push(session.info());
        this.emit("state", session.info());
      }
    }
    for (const loaded of this.loadStructuredStates()) {
      // Store 已经落下 worker 交付、但还没来得及 kill 就崩溃时，这里先封存而
      // 不能让 session.start() 接回 native thread 并从 messageQueue 取走一条。
      const state = !loaded.terminal && options.preserveHistoryWhen?.(loaded)
        ? { ...loaded, terminal: true as const }
        : loaded;
      if (this.structuredSessions.has(state.id)) continue;
      const session = this.makeStructuredSession(state.id, state.agent, state.cwd, state.title, state);
      this.structuredSessions.set(state.id, session);
      if (state.terminal) {
        // 已交付 worker 只保留本地审计历史，不能在重启后接回 native thread。
        restored.push(session.info());
        this.emit("state", session.info());
        continue;
      }
      try {
        await session.start(() => {
          // control socket 会先于 restoreStructured 监听；adapter.start 的 await
          // 期间旧 worker 仍可能刚好报 task.done/fail。此处是 drainQueue 前的
          // 第二道闸门，必须同步封存，不能等启动末尾的 reconcile。
          if (!options.preserveHistoryWhen?.(loaded)) return;
          // `kill` 在其首个 await 前把 StructuredSession 标为 done 并同步尝试
          // 持久化 terminal snapshot；start() 随即看见 disposed 而跳过 drain。
          void this.kill(state.id, { preserveHistory: true }).catch(() => {});
        });
      } catch (e) {
        await session.markRestoreFailed(e instanceof Error ? e.message : String(e));
      }
      restored.push(session.info());
      this.emit("state", session.info());
    }
    await this.persistStructuredNow();
    return restored;
  }

  /** tmux 托管是否真正生效(装了 tmux 且开了开关) */
  get tmuxEnabled(): boolean {
    return this.tmuxBin !== null && this.tmuxConfigFile !== null;
  }

  /** Whether PTY terminal state is held by detached per-session hosts. */
  get ptySupervisorEnabled(): boolean {
    return this.usePtySupervisor || this.windowsPtySessionHostDurable;
  }

  /** 结构化会话需要异步启动后端,故整体为 async */
  async create(input: CreateSessionInput): Promise<SessionInfo> {
    if (requiresShellCapability(input.agent) && !input.allowShell) {
      throw new SessionError(
        `device is not allowed to start "${input.agent}" sessions`,
        "shell_not_allowed",
      );
    }
    const cwd = input.cwd ?? os.homedir();
    const kind: SessionKind = input.kind ?? defaultKindFor(input.agent);
    const account = input.accountId
      ? this.resolveAccount(input.agent, input.accountId)
      : undefined;
    if (kind === "structured" && !structuredCapable(input.agent)) {
      throw new SessionError(`agent "${input.agent}" 暂无结构化适配器`, "agent_unavailable");
    }
    if (input.resume && (kind !== "structured" || (input.agent !== "claude" && input.agent !== "codex" && input.agent !== "deepseek"))) {
      throw new SessionError("这个 Agent 不支持接回本机对话", "agent_unavailable");
    }
    if (input.resume?.fork === true) {
      throw new SessionError(
        "不再支持从占用中的 Codex 对话创建副本；请先关闭电脑端任务",
        "conflict",
        "conversation_active_writer",
      );
    }
    if (input.mode && (kind !== "structured" || (input.agent !== "claude" && input.agent !== "codex"))) {
      throw new SessionError("只有 Claude/Codex 对话会话支持 Plan 模式", "agent_unavailable");
    }
    if (input.model && (kind !== "structured" || (input.agent !== "claude" && input.agent !== "codex" && input.agent !== "deepseek"))) {
      throw new SessionError("这个 Agent 不支持启动模型选择", "agent_unavailable");
    }
    if (input.agentPreset && (kind !== "structured" || input.agent !== "deepseek")) {
      throw new SessionError("只有 DeepSeek Harness 支持 Agent 预设", "agent_unavailable");
    }
    if (input.effort && !input.model) {
      throw new SessionError("推理强度必须和启动模型一起指定", "agent_unavailable");
    }
    return kind === "structured"
      ? this.createStructured(
          input.agent,
          cwd,
          input.approvalPolicy,
          input.mode,
          input.model,
          input.effort,
          input.agentPreset,
          input.resume,
          account,
        )
      : await this.createPty(input, cwd, account);
  }

  private async createPty(
    input: CreateSessionInput,
    cwd: string,
    account?: AccountBinding,
  ): Promise<SessionInfo> {
    let spec;
    try {
      spec = commandFor(
        input.agent,
        input.command,
        process.platform,
        process.env,
        input.agent === "codex" ? (account?.codexAppServerArgs ?? []) : [],
      );
    } catch (e) {
      throw new SessionError(
        e instanceof Error ? e.message : String(e),
        "agent_unavailable",
      );
    }
    const id = randomUUID();
    const info = await this.spawnPty(
      id,
      input.agent,
      `${input.agent} · ${path.basename(cwd)}`,
      cwd,
      input.cols,
      input.rows,
      spec,
      account,
    );
    this.persistMeta();
    return info;
  }

  /**
   * 建 PtySession。新建与 tmux 恢复共用 —— 恢复时 spec 省略,
   * 因为 `new-session -A` 遇到已存在的会话会直接 attach 并忽略命令参数。
   */
  private async spawnPty(
    id: string,
    agent: AgentKind,
    title: string,
    cwd: string,
    cols: number,
    rows: number,
    spec: { file: string; args: string[] } | undefined,
    account?: AccountBinding,
  ): Promise<SessionInfo> {
    const base = spec ?? noopCommand();
    const sessionEnv = { ...(account?.environment ?? {}), ...this.sessionEnv(id) };
    const launch =
      this.tmuxBin && this.tmuxConfigFile
        ? tmux.wrapSpawn(base, {
            id,
            cwd,
            cols,
            rows,
            configFile: this.tmuxConfigFile,
            tmux: this.tmuxBin,
            environment: sessionEnv,
          })
        : base;
    let session: PtySession | RemotePtySession | RemoteWindowsPtySession;
    try {
      const ptyOptions = {
        id, agent, title, cwd, cols, rows,
        file: launch.file,
        args: launch.args,
        env: spawnEnv(sessionEnv),
        ...(account ? { accountId: account.id, accountName: account.name } : {}),
      };
      if (this.useWindowsPtySessionHost && this.windowsPtySessionHostRoot) {
        try {
          session = await launchWindowsPtySession({
            root: this.windowsPtySessionHostRoot,
            createdAt: Date.now(),
            ...ptyOptions,
          });
          this.windowsPtySessionHostDurable = true;
        } catch (error) {
          // The sole Windows fallback is a plainly in-process PTY when the
          // verified native binding failed before *any* detached host spawn.
          // Manifest/identity/timeout/attach failures are post-launch or
          // otherwise ambiguous and must never create a duplicate direct PTY.
          if ((error as { directPtyFallbackAllowed?: unknown } | null)?.directPtyFallbackAllowed !== true) throw error;
          console.warn("[prosperod] Windows Session Host unavailable; using non-durable direct PTY");
          session = new PtySession(ptyOptions);
        }
      } else if (this.usePtySupervisor && this.ptySupervisorRoot) {
        session = await this.ptySupervisorLauncher({
            root: this.ptySupervisorRoot,
            createdAt: Date.now(),
            ...ptyOptions,
          });
      } else {
        session = new PtySession(ptyOptions);
      }
    } catch (e) {
      // node-pty 对不存在的可执行文件同步抛 posix_spawnp failed
      throw new SessionError(
        `failed to spawn "${base.file}" — is ${agent} installed? (${e instanceof Error ? e.message : String(e)})`,
        "agent_unavailable",
      );
    }
    if (this.tmuxBin) {
      let configured = false;
      // node-pty returns as soon as the tmux client is forked; give that client
      // a bounded moment to create/attach its server-side session before
      // targeting options. Restore normally succeeds on the first attempt.
      for (let attempt = 0; attempt < 8 && !configured; attempt++) {
        configured = tmux.configureSession(id, this.tmuxBin);
        if (!configured) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!configured) {
        console.warn(`[prosperod] tmux session options were not applied to ${id}`);
      }
    }
    this.ptySessions.set(id, session);
    this.wirePtySession(session);
    this.emit("state", session.info());
    return session.info();
  }

  private wirePtySession(session: PtySession | RemotePtySession | RemoteWindowsPtySession): void {
    session.on("output", (dataB64: string, seq: number) => this.emit("output", session.id, dataB64, seq));
    session.on("state", (info: SessionInfo) => this.emit("state", info));
  }

  private async createStructured(
    agent: AgentKind,
    cwd: string,
    approvalPolicy?: ApprovalPolicy,
    mode?: "default" | "plan",
    model?: string,
    effort?: string,
    agentPreset?: string,
    resume?: { id: string; title?: string | undefined; fork?: true | undefined },
    account?: AccountBinding,
  ): Promise<SessionInfo> {
    const id = randomUUID();
    const initialAdapterState: AdapterResumeState = {
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(agentPreset && agent === "deepseek" ? { agentPreset } : {}),
      ...(resume && agent === "deepseek" ? { sessionId: resume.id } : {}),
      ...(resume && agent === "claude" ? { sessionId: resume.id } : {}),
      ...(resume && agent === "codex" ? { threadId: resume.id } : {}),
    };
    const hasInitialAdapterState = Object.keys(initialAdapterState).length > 0;
    if (this.useWindowsStructuredHost && this.windowsStructuredRoot) {
      try {
        const session = await this.windowsStructuredLauncher({
          root: this.windowsStructuredRoot,
          sessionId: id,
          agent,
          cwd,
          title: resume?.title || titleFor(agent, cwd),
          createdAt: Date.now(),
          ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
          environment: { ...(account?.environment ?? {}), ...this.sessionEnv(id) },
          ...(account?.codexAppServerArgs ? { codexAppServerArgs: account.codexAppServerArgs } : {}),
          ...(account ? { accountId: account.id, accountName: account.name } : {}),
          ...(hasInitialAdapterState ? { initialAdapterState } : {}),
        });
        this.wireStructuredSession(session);
        this.structuredSessions.set(id, session);
        this.emit("state", session.info());
        return session.info();
      } catch (error) {
        if (isConversationActiveWriterError(error)) {
          throw new SessionError(
            "这条 Codex 对话正在被电脑端使用",
            "conflict",
            "conversation_active_writer",
          );
        }
        // Missing/invalid native prebuilds deliberately retain the historical
        // in-process path, but parent-Job and provider-Job failures are a
        // security boundary and must never be silently downgraded.
        if (!canFallbackToInProcessStructured(error)) {
          throw new SessionError(
            `无法启动 Windows durable ${agent} 会话:${error instanceof Error ? error.message : String(error)}`,
            "agent_unavailable",
          );
        }
      }
    }
    if (this.useStructuredSupervisor && this.structuredSupervisorRoot) {
      try {
        const session = await this.supervisorLauncher({
          root: this.structuredSupervisorRoot,
          sessionId: id,
          agent,
          cwd,
          title: resume?.title || titleFor(agent, cwd),
          createdAt: Date.now(),
          ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
          environment: { ...(account?.environment ?? {}), ...this.sessionEnv(id) },
          ...(account?.codexAppServerArgs ? { codexAppServerArgs: account.codexAppServerArgs } : {}),
          ...(account ? { accountId: account.id, accountName: account.name } : {}),
          ...(hasInitialAdapterState ? { initialAdapterState } : {}),
          ...(this.supervisorRunnerPath ? { runnerPath: this.supervisorRunnerPath } : {}),
        });
        this.wireStructuredSession(session);
        this.structuredSessions.set(id, session);
        this.emit("state", session.info());
        return session.info();
      } catch (e) {
        if (isConversationActiveWriterError(e)) {
          throw new SessionError(
            "这条 Codex 对话正在被电脑端使用",
            "conflict",
            "conversation_active_writer",
          );
        }
        throw new SessionError(
          `无法启动 ${agent} supervisor 会话:${e instanceof Error ? e.message : String(e)}`,
          "agent_unavailable",
        );
      }
    }
    const session = this.makeStructuredSession(
      id,
      agent,
      cwd,
      resume?.title || titleFor(agent, cwd),
      undefined,
      approvalPolicy,
      hasInitialAdapterState ? initialAdapterState : undefined,
      account,
    );
    this.structuredSessions.set(id, session);
    try {
      await session.start();
    } catch (e) {
      this.structuredSessions.delete(id);
      await session.dispose().catch(() => {});
      this.scheduleStructuredPersist();
      if (isConversationActiveWriterError(e)) {
        throw new SessionError(
          "这条 Codex 对话正在被电脑端使用",
          "conflict",
          "conversation_active_writer",
        );
      }
      throw new SessionError(
        `无法启动 ${agent} 会话:${e instanceof Error ? e.message : String(e)}`,
        "agent_unavailable",
      );
    }
    this.scheduleStructuredPersist();
    this.emit("state", session.info());
    return session.info();
  }

  /**
   * 新会话创建前读取 Agent 的实时模型目录。适配器是临时的，绝不进入会话表；
   * Codex 通过 catalogOnly 跳过 thread/start，Claude SDK 则在读取后立即释放。
   */
  async launchModels(
    agent: "claude" | "codex" | "deepseek",
    accountId?: string,
  ): Promise<AgentModelCatalog> {
    const account = accountId && agent !== "deepseek" ? this.resolveAccount(agent, accountId) : undefined;
    const adapter = this.adapterFactory(agent);
    try {
      await adapter.start({
        cwd: os.homedir(),
        ...(account ? { env: account.environment } : {}),
        ...(account?.codexAppServerArgs
          ? { codexAppServerArgs: account.codexAppServerArgs }
          : {}),
        catalogOnly: true,
        approvalPolicy: () => "strict",
        emit: () => {},
        persistState: () => {},
      });
      if (!adapter.listModels) {
        throw new SessionError(`${agent} 尚不支持模型选择`, "agent_unavailable");
      }
      const catalog = await adapter.listModels();
      if (catalog.models.length === 0) {
        throw new SessionError(`${agent} 没有返回可选模型`, "agent_unavailable");
      }
      return catalog;
    } finally {
      await adapter.dispose().catch(() => {});
    }
  }

  private makeStructuredSession(
    id: string,
    agent: AgentKind,
    cwd: string,
    title: string,
    restored?: StructuredSessionPersistentState,
    approvalPolicy?: ApprovalPolicy,
    initialAdapterState?: AdapterResumeState,
    initialAccount?: AccountBinding,
  ): StructuredSession {
    const account = restored?.accountId
      ? this.resolveAccount(agent, restored.accountId)
      : initialAccount;
    const session = new StructuredSession({
      id,
      agent,
      title,
      cwd,
      adapter: this.adapterFactory(agent, restored?.adapterState ?? initialAdapterState),
      environment: { ...(account?.environment ?? {}), ...this.sessionEnv(id) },
      ...(account?.codexAppServerArgs ? { codexAppServerArgs: account.codexAppServerArgs } : {}),
      ...(account ? { accountId: account.id, accountName: account.name } : {}),
      ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
      ...(restored ? { restored } : {}),
      ...(initialAdapterState ? { initialAdapterState } : {}),
    });
    this.wireStructuredSession(session);
    return session;
  }

  private wireStructuredSession(session: StructuredSession | RemoteStructuredSession | WindowsRemoteStructuredSession): void {
    session.on("event", (body: AgentEventBody, evSeq: number) => {
      const id = session.id;
      this.emit("agentEvent", id, body, evSeq);
      this.scheduleStructuredPersist();
    });
    session.on("state", (info: SessionInfo) => {
      this.emit("state", info);
      this.scheduleStructuredPersist();
    });
    if (session instanceof StructuredSession) {
      session.on("persist", () => this.scheduleStructuredPersist());
    }
  }

  /** 用官方 CLI 打开登录终端；managed Claude 在这里生成之后要安全导入的令牌。 */
  async createAccountLogin(spec: AccountLoginSpec, cols: number, rows: number): Promise<SessionInfo> {
    const id = randomUUID();
    const info = await this.spawnPty(
      id,
      spec.binding.agent,
      `${spec.binding.name} · 登录`,
      os.homedir(),
      cols,
      rows,
      programCommandFor(spec.command.file, spec.command.args),
      spec.binding,
    );
    this.persistMeta();
    return info;
  }

  private resolveAccount(agent: AgentKind, accountId: string): AccountBinding {
    if (agent !== "claude" && agent !== "codex") {
      throw new SessionError(`agent "${agent}" 不支持账号隔离`, "agent_unavailable");
    }
    if (!this.accountResolver) {
      throw new SessionError("daemon 尚未启用账号管理", "agent_unavailable");
    }
    return this.accountResolver(accountId, agent);
  }

  getPty(sid: string): PtySession | RemotePtySession | RemoteWindowsPtySession | undefined {
    return this.ptySessions.get(sid);
  }

  getStructured(sid: string): StructuredSession | RemoteStructuredSession | WindowsRemoteStructuredSession | undefined {
    return this.structuredSessions.get(sid);
  }

  /** 会话的 cwd —— 文件面板以此为根;会话不存在返回 null */
  cwdOf(sid: string): string | null {
    return this.list().find((s) => s.id === sid)?.cwd ?? null;
  }

  requirePty(sid: string): PtySession | RemotePtySession | RemoteWindowsPtySession {
    const s = this.ptySessions.get(sid);
    if (!s) {
      throw new SessionError(
        this.structuredSessions.has(sid)
          ? `session ${sid} 是结构化会话,不接受终端输入`
          : `no such session: ${sid}`,
        "session_not_found",
      );
    }
    return s;
  }

  /**
   * PTY TUI 的首个输入必须避开其初始化清屏窗口；structured 会话没有这条路径。
   * 实现位于独立的观察器中，以便编排层可用确定性 fake 复现这一竞态。
   */
  async waitForPtyReady(sid: string, options?: PtyStartupReadinessOptions): Promise<void> {
    await waitForPtyStartupReadiness(this, sid, options);
  }

  requireStructured(sid: string): StructuredSession | RemoteStructuredSession | WindowsRemoteStructuredSession {
    const s = this.structuredSessions.get(sid);
    if (!s) {
      throw new SessionError(
        this.ptySessions.has(sid)
          ? `session ${sid} 是终端会话,不接受聊天消息`
          : `no such session: ${sid}`,
        "session_not_found",
      );
    }
    return s;
  }

  infoOf(sid: string): SessionInfo {
    const s = this.ptySessions.get(sid) ?? this.structuredSessions.get(sid);
    if (!s) throw new SessionError(`no such session: ${sid}`, "session_not_found");
    return s.info();
  }

  /**
   * Whether this daemon has an attached durable owner, an in-process direct
   * session, or a manifest that deliberately failed closed during recovery.
   */
  sessionHostingOf(sid: string): SessionHosting {
    const pty = this.ptySessions.get(sid);
    if (pty instanceof RemoteWindowsPtySession) {
      return pty.hosting === "windows-session-host" ? "hosted" : "unavailable";
    }
    if (pty instanceof RemotePtySession) return "hosted";

    const structured = this.structuredSessions.get(sid);
    if (structured instanceof WindowsRemoteStructuredSession) {
      return structured.hosting === "windows-session-host" ? "hosted" : "unavailable";
    }
    if (structured instanceof RemoteStructuredSession) return "hosted";
    if (pty || structured) return "direct";
    throw new SessionError(`no such session: ${sid}`, "session_not_found");
  }

  /**
   * Canonical Windows owner identity for Dispatch persistence. PID alone is
   * intentionally insufficient: epoch and FILETIME fence PID reuse and a
   * stale manifest/pipe can never inherit a running worker.
   */
  hostOwnerIdentityOf(sid: string): string | null {
    const pty = this.ptySessions.get(sid);
    const host = pty instanceof RemoteWindowsPtySession && pty.hosting === "windows-session-host"
      ? pty.manifest
      : (() => {
          const structured = this.structuredSessions.get(sid);
          return structured instanceof WindowsRemoteStructuredSession && structured.hosting === "windows-session-host"
            ? structured.manifest.host
            : null;
        })();
    if (!host) return null;
    return `windows-session-host:${host.epoch}:${host.owner.pid}:${host.owner.creationTime100ns}`;
  }

  list(): SessionInfo[] {
    return [
      ...[...this.ptySessions.values()].map((s) => s.info()),
      ...[...this.structuredSessions.values()].map((s) => s.info()),
    ].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 任意一个结构化会话;账号级查询(用量/限流)用它当入口 */
  anyStructured(): StructuredSession | RemoteStructuredSession | WindowsRemoteStructuredSession | null {
    return this.structuredSessions.values().next().value ?? null;
  }

  /**
   * 每个 (agent, accountId) 各挑一个结构化会话。多账号之后只按 agent
   * 合并会把两份订阅额度混在一起；旧会话没有 accountId 时仍归到 legacy。
   */
  structuredPerAgent(): Array<StructuredSession | RemoteStructuredSession | WindowsRemoteStructuredSession> {
    const byAccount = new Map<string, StructuredSession | RemoteStructuredSession | WindowsRemoteStructuredSession>();
    for (const s of this.structuredSessions.values()) {
      // 后来的覆盖先前的:新会话更可能刚从服务端拿到过限流推送
      byAccount.set(`${s.agent}\u0000${s.accountId ?? "legacy"}`, s);
    }
    return [...byAccount.values()];
  }

  /** 转发一条用户消息(可带附件) */
  async chatSend(
    sid: string,
    text: string,
    attachments?: Attachment[],
    delivery?: import("@prospero/protocol").ChatDelivery,
  ): Promise<void> {
    const s = this.structuredSessions.get(sid);
    if (!s) throw new SessionError(`no structured session: ${sid}`, "session_not_found");
    await s.send(text, attachments, delivery);
  }

  /** 改某个结构化会话的审批策略 */
  async setApprovalPolicy(sid: string, policy: ApprovalPolicy): Promise<void> {
    const s = this.structuredSessions.get(sid);
    if (!s) throw new SessionError(`no structured session: ${sid}`, "session_not_found");
    await s.setApprovalPolicy(policy);
  }

  async interrupt(sid: string): Promise<void> {
    const structured = this.structuredSessions.get(sid);
    if (structured) {
      await structured.interrupt();
      return;
    }
    await this.requirePty(sid).interrupt();
  }

  /** 终止会话；编排 worker 可保留结构化历史为只读。 */
  async kill(sid: string, options: KillSessionOptions = {}): Promise<void> {
    const structured = this.structuredSessions.get(sid);
    if (structured) {
      const info = structured.info();
      if (structured instanceof RemoteStructuredSession || structured instanceof WindowsRemoteStructuredSession) {
        // The only daemon operation allowed to terminate a detached owner.
        // disposeAll() below deliberately calls dispose() instead.
        await structured.kill();
        if (!options.preserveHistory) this.structuredSessions.delete(sid);
        this.emit("state", { ...info, status: "done" });
        return;
      }
      // dispose 在首个 await 前就同步把 StructuredSession 标为 done/read-only；
      // 因此 preserveHistory 可以在 adapter.dispose 卡住时仍立即写出终态快照。
      const disposing = structured.dispose();
      if (options.preserveHistory) {
        // 终态 worker 不能只等 200ms debounce：daemon 若在此刻崩溃，旧状态会在
        // 下次启动时被当成可恢复会话并继续消费原 worktree 的队列。
        // dispose 已在上面同步把会话标为 done,这里 await 写盘,确保落的是终态快照。
        await this.persistStructuredNow();
      } else {
        this.scheduleStructuredPersist();
      }
      await disposing;
      if (!options.preserveHistory) this.structuredSessions.delete(sid);
      this.emit("state", { ...info, status: "done" });
      return;
    }
    const pty = this.requirePty(sid);
    const info = pty.info();
    if (pty instanceof RemotePtySession || pty instanceof RemoteWindowsPtySession) await pty.kill();
    else await pty.dispose();
    // tmux 下 dispose 只是断开 client,进程还在 server 里活着 —— kill 得说到做到
    if (this.tmuxEnabled) tmux.killSession(sid);
    this.ptySessions.delete(sid);
    this.persistMeta();
    this.emit("state", {
      ...info,
      // A detached facade already records an explicit kill as `done`; retain
      // that user-visible distinction instead of turning it into an apparent
      // owner crash while removing it from this daemon's session table.
      status: pty instanceof RemotePtySession || pty instanceof RemoteWindowsPtySession ? "done" : (info.status === "done" ? "done" : "died"),
    });
  }

  /**
   * daemon 退出时只断开自己这一侧。tmux 托管下会话进程留在 tmux server 里,
   * 下次启动再 attach 回来 —— 这正是托管的意义,所以这里绝不能 killSession。
   */
  async disposeAll(): Promise<void> {
    // 先保存“仍然存在”的集合,随后 dispose 产生的 done 状态不能把它们从磁盘抹掉。
    await this.flushPersistence();
    this.shuttingDown = true;
    // create() 返回时 tmux 子进程可能还在和 server 握手。极快地点击“重启”时若
    // 立刻杀 client,session 尚未登记就会丢失；最多等 750ms 让 supervisor 接棒。
    if (this.tmuxEnabled) {
      const expected = new Set(
        [...this.ptySessions.values()]
          .filter((s) => s.info().status !== "done" && s.info().status !== "died")
          .map((s) => s.id),
      );
      const deadline = Date.now() + 750;
      while (expected.size > 0 && Date.now() < deadline) {
        for (const id of tmux.listSessions()) expected.delete(id);
        if (expected.size > 0) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
    const ptyDisposals = [...this.ptySessions.values()].map((session) => Promise.resolve(session.dispose()));
    this.ptySessions.clear();
    const disposals = [...this.structuredSessions.values()].map((s) => s.dispose());
    this.structuredSessions.clear();
    await Promise.allSettled([...ptyDisposals, ...disposals]);
  }
}
