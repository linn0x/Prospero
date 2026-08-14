import { EventEmitter } from "node:events";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
import * as tmux from "./tmux.js";
import {
  StructuredSession,
  titleFor,
  type QueuedChatPersistent,
  type StructuredSessionPersistentState,
} from "./structured-session.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { GrokAdapter } from "./adapters/grok.js";
import { OpencodeAdapter } from "./adapters/opencode.js";
import type {
  AdapterResumeState,
  AgentAdapter,
  AgentModelCatalog,
} from "./adapters/types.js";
import type { AccountBinding, AccountLoginSpec } from "./agent-accounts.js";

export type SessionErrorCode =
  | "shell_not_allowed"
  | "agent_unavailable"
  | "session_not_found";

export class SessionError extends Error {
  constructor(
    message: string,
    public readonly code: SessionErrorCode,
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
  /** Agent 原生本机会话 ID；只允许 Claude/Codex 结构化轨。 */
  resume?: { id: string; title?: string | undefined } | undefined;
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
  const agents = new Set<AgentKind>(["claude", "codex", "opencode", "grok"]);
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
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly ptySessions = new Map<string, PtySession>();
  private readonly structuredSessions = new Map<string, StructuredSession>();
  private readonly tmuxConfigFile: string | null;
  private readonly tmuxBin: string | null;

  private readonly metaFile: string | null;
  private readonly structuredFile: string | null;
  private readonly adapterFactory: (agent: AgentKind, state?: AdapterResumeState) => AgentAdapter;
  private readonly sessionEnv: (sessionId: string) => Record<string, string>;
  private readonly accountResolver:
    | ((accountId: string, agent: "claude" | "codex") => AccountBinding)
    | undefined;
  private persistTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  constructor(opts: SessionManagerOptions = {}) {
    super();
    // 没装 tmux 就静默退回直接 spawn —— 托管是增强,不该变成硬依赖
    this.tmuxBin = opts.tmux ? tmux.tmuxPath() : null;
    this.tmuxConfigFile = this.tmuxBin && opts.tmux ? tmux.writeConfig(opts.tmux.home) : null;
    this.metaFile = opts.tmux ? path.join(opts.tmux.home, "pty-sessions.json") : null;
    const home = opts.home ?? opts.tmux?.home;
    this.structuredFile = home ? path.join(home, "structured-sessions.json") : null;
    this.adapterFactory = opts.adapterFactory ?? makeAdapter;
    this.sessionEnv = opts.sessionEnv ?? (() => ({}));
    this.accountResolver = opts.accountResolver;
  }

  /**
   * 重新接管上一轮 daemon 留下的 tmux 会话。
   * tmux 只记得会话名,agent/title/cwd 这些是我们自己存的;两边取交集 ——
   * 元数据里有但 tmux 没有的是已经结束的,tmux 有但元数据没有的不归我们管。
   */
  restoreFromTmux(): SessionInfo[] {
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
          this.spawnPty(
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
      this.persistStructuredNow();
    }, 200);
    this.persistTimer.unref?.();
  }

  private persistStructuredNow(): void {
    if (!this.structuredFile) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const tmp = `${this.structuredFile}.tmp`;
    const states = [...this.structuredSessions.values()].map((s) => s.persistentState());
    try {
      writeFileSync(tmp, JSON.stringify(states, null, 2), { mode: 0o600 });
      renameSync(tmp, this.structuredFile);
      chmodSync(this.structuredFile, 0o600);
    } catch {
      // 持久化失败不能打断正在运行的 agent；下一次事件会再次尝试。
    }
  }

  /** 测试和优雅退出使用；确保 debounce 中的最后一批事件已经落盘。 */
  flushPersistence(): void {
    this.persistMeta();
    this.persistStructuredNow();
  }

  /**
   * 恢复结构化会话。Prospero 事件日志负责 UI，adapterState 让原生 CLI
   * 接回模型上下文；单个后端失效时仍保留历史供查看和删除。
   */
  async restoreStructured(): Promise<SessionInfo[]> {
    const restored: SessionInfo[] = [];
    for (const state of this.loadStructuredStates()) {
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
        await session.start();
      } catch (e) {
        await session.markRestoreFailed(e instanceof Error ? e.message : String(e));
      }
      restored.push(session.info());
      this.emit("state", session.info());
    }
    this.persistStructuredNow();
    return restored;
  }

  /** tmux 托管是否真正生效(装了 tmux 且开了开关) */
  get tmuxEnabled(): boolean {
    return this.tmuxBin !== null && this.tmuxConfigFile !== null;
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
    if (input.resume && (kind !== "structured" || (input.agent !== "claude" && input.agent !== "codex"))) {
      throw new SessionError("只有 Claude/Codex 对话会话支持接回本机对话", "agent_unavailable");
    }
    if (input.mode && (kind !== "structured" || (input.agent !== "claude" && input.agent !== "codex"))) {
      throw new SessionError("只有 Claude/Codex 对话会话支持 Plan 模式", "agent_unavailable");
    }
    if (input.model && (kind !== "structured" || (input.agent !== "claude" && input.agent !== "codex"))) {
      throw new SessionError("只有 Claude/Codex 对话会话支持启动模型选择", "agent_unavailable");
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
          input.resume,
          account,
        )
      : this.createPty(input, cwd, account);
  }

  private createPty(
    input: CreateSessionInput,
    cwd: string,
    account?: AccountBinding,
  ): SessionInfo {
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
    const info = this.spawnPty(
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
  private spawnPty(
    id: string,
    agent: AgentKind,
    title: string,
    cwd: string,
    cols: number,
    rows: number,
    spec: { file: string; args: string[] } | undefined,
    account?: AccountBinding,
  ): SessionInfo {
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
    let session: PtySession;
    try {
      session = new PtySession({
        id, agent, title, cwd, cols, rows,
        file: launch.file,
        args: launch.args,
        env: spawnEnv(sessionEnv),
        ...(account ? { accountId: account.id, accountName: account.name } : {}),
      });
    } catch (e) {
      // node-pty 对不存在的可执行文件同步抛 posix_spawnp failed
      throw new SessionError(
        `failed to spawn "${base.file}" — is ${agent} installed? (${e instanceof Error ? e.message : String(e)})`,
        "agent_unavailable",
      );
    }
    this.ptySessions.set(id, session);
    session.on("output", (dataB64, seq) => this.emit("output", id, dataB64, seq));
    session.on("state", (info) => this.emit("state", info));
    this.emit("state", session.info());
    return session.info();
  }

  private async createStructured(
    agent: AgentKind,
    cwd: string,
    approvalPolicy?: ApprovalPolicy,
    mode?: "default" | "plan",
    model?: string,
    effort?: string,
    resume?: { id: string; title?: string | undefined },
    account?: AccountBinding,
  ): Promise<SessionInfo> {
    const id = randomUUID();
    const initialAdapterState: AdapterResumeState = {
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(resume && agent === "claude" ? { sessionId: resume.id } : {}),
      ...(resume && agent === "codex" ? { threadId: resume.id } : {}),
    };
    const hasInitialAdapterState = Object.keys(initialAdapterState).length > 0;
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
    agent: "claude" | "codex",
    accountId?: string,
  ): Promise<AgentModelCatalog> {
    const account = accountId ? this.resolveAccount(agent, accountId) : undefined;
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
    session.on("event", (body, evSeq) => {
      this.emit("agentEvent", id, body, evSeq);
      this.scheduleStructuredPersist();
    });
    session.on("state", (info) => {
      this.emit("state", info);
      this.scheduleStructuredPersist();
    });
    session.on("persist", () => this.scheduleStructuredPersist());
    return session;
  }

  /** 用官方 CLI 打开登录终端；managed Claude 在这里生成之后要安全导入的令牌。 */
  createAccountLogin(spec: AccountLoginSpec, cols: number, rows: number): SessionInfo {
    const id = randomUUID();
    const info = this.spawnPty(
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

  getPty(sid: string): PtySession | undefined {
    return this.ptySessions.get(sid);
  }

  getStructured(sid: string): StructuredSession | undefined {
    return this.structuredSessions.get(sid);
  }

  /** 会话的 cwd —— 文件面板以此为根;会话不存在返回 null */
  cwdOf(sid: string): string | null {
    return this.list().find((s) => s.id === sid)?.cwd ?? null;
  }

  requirePty(sid: string): PtySession {
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

  requireStructured(sid: string): StructuredSession {
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

  list(): SessionInfo[] {
    return [
      ...[...this.ptySessions.values()].map((s) => s.info()),
      ...[...this.structuredSessions.values()].map((s) => s.info()),
    ].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 任意一个结构化会话;账号级查询(用量/限流)用它当入口 */
  anyStructured(): StructuredSession | null {
    return this.structuredSessions.values().next().value ?? null;
  }

  /**
   * 每个 (agent, accountId) 各挑一个结构化会话。多账号之后只按 agent
   * 合并会把两份订阅额度混在一起；旧会话没有 accountId 时仍归到 legacy。
   */
  structuredPerAgent(): StructuredSession[] {
    const byAccount = new Map<string, StructuredSession>();
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
    this.requirePty(sid).interrupt();
  }

  /** 终止会话；编排 worker 可保留结构化历史为只读。 */
  async kill(sid: string, options: KillSessionOptions = {}): Promise<void> {
    const structured = this.structuredSessions.get(sid);
    if (structured) {
      const info = structured.info();
      await structured.dispose();
      if (!options.preserveHistory) this.structuredSessions.delete(sid);
      this.scheduleStructuredPersist();
      this.emit("state", { ...info, status: "done" });
      return;
    }
    const pty = this.requirePty(sid);
    const info = pty.info();
    pty.dispose();
    // tmux 下 dispose 只是断开 client,进程还在 server 里活着 —— kill 得说到做到
    if (this.tmuxEnabled) tmux.killSession(sid);
    this.ptySessions.delete(sid);
    this.persistMeta();
    this.emit("state", {
      ...info,
      status: info.status === "done" ? "done" : "died",
    });
  }

  /**
   * daemon 退出时只断开自己这一侧。tmux 托管下会话进程留在 tmux server 里,
   * 下次启动再 attach 回来 —— 这正是托管的意义,所以这里绝不能 killSession。
   */
  async disposeAll(): Promise<void> {
    // 先保存“仍然存在”的集合,随后 dispose 产生的 done 状态不能把它们从磁盘抹掉。
    this.flushPersistence();
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
    for (const s of this.ptySessions.values()) s.dispose();
    this.ptySessions.clear();
    const disposals = [...this.structuredSessions.values()].map((s) => s.dispose());
    this.structuredSessions.clear();
    await Promise.allSettled(disposals);
  }
}
