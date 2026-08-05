import { EventEmitter } from "node:events";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
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
  requiresShellCapability,
  spawnEnv,
  structuredCapable,
} from "./agents.js";
import { PtySession } from "./pty-session.js";
import * as tmux from "./tmux.js";
import { StructuredSession, titleFor } from "./structured-session.js";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { GrokAdapter } from "./adapters/grok.js";
import { OpencodeAdapter } from "./adapters/opencode.js";
import type { AgentAdapter } from "./adapters/types.js";

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
  /** 省略时按 agent 能力决定:有适配器的走 structured */
  kind?: SessionKind | undefined;
  cwd?: string | undefined;
  command?: string | undefined;
  cols: number;
  rows: number;
  /** 来自设备注册表:该设备是否允许 shell/custom(完整用户权限) */
  allowShell: boolean;
}

export interface SessionManagerEvents {
  output: [sid: string, dataB64: string, seq: number];
  agentEvent: [sid: string, body: AgentEventBody, evSeq: number];
  state: [info: SessionInfo];
}

function makeAdapter(agent: AgentKind): AgentAdapter {
  switch (agent) {
    case "opencode":
      return new OpencodeAdapter();
    case "claude":
      return new ClaudeAdapter();
    case "codex":
      return new CodexAdapter();
    case "grok":
      return new GrokAdapter();
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
}

export interface SessionManagerOptions {
  /** tmux 托管:agent 跑在 tmux 里,daemon 重启后进程与画面都还在 */
  tmux?: { home: string } | undefined;
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly ptySessions = new Map<string, PtySession>();
  private readonly structuredSessions = new Map<string, StructuredSession>();
  private readonly tmuxConfigFile: string | null;
  private readonly tmuxBin: string | null;

  private readonly metaFile: string | null;

  constructor(opts: SessionManagerOptions = {}) {
    super();
    // 没装 tmux 就静默退回直接 spawn —— 托管是增强,不该变成硬依赖
    this.tmuxBin = opts.tmux ? tmux.tmuxPath() : null;
    this.tmuxConfigFile = this.tmuxBin && opts.tmux ? tmux.writeConfig(opts.tmux.home) : null;
    this.metaFile = opts.tmux ? path.join(opts.tmux.home, "pty-sessions.json") : null;
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
        restored.push(this.spawnPty(meta.id, meta.agent, meta.title, meta.cwd, meta.cols, meta.rows, undefined));
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
      };
    });
    try {
      writeFileSync(this.metaFile, JSON.stringify(meta, null, 2));
      chmodSync(this.metaFile, 0o600);
    } catch {
      // 记不下来只影响下次恢复,不影响当前会话
    }
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
    if (kind === "structured" && !structuredCapable(input.agent)) {
      throw new SessionError(`agent "${input.agent}" 暂无结构化适配器`, "agent_unavailable");
    }
    return kind === "structured"
      ? this.createStructured(input.agent, cwd)
      : this.createPty(input, cwd);
  }

  private createPty(input: CreateSessionInput, cwd: string): SessionInfo {
    let spec;
    try {
      spec = commandFor(input.agent, input.command);
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
  ): SessionInfo {
    const base = spec ?? { file: "/bin/true", args: [] };
    const launch =
      this.tmuxBin && this.tmuxConfigFile
        ? tmux.wrapSpawn(base, {
            id,
            cwd,
            cols,
            rows,
            configFile: this.tmuxConfigFile,
            tmux: this.tmuxBin,
          })
        : base;
    let session: PtySession;
    try {
      session = new PtySession({
        id, agent, title, cwd, cols, rows,
        file: launch.file,
        args: launch.args,
        env: spawnEnv(),
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

  private async createStructured(agent: AgentKind, cwd: string): Promise<SessionInfo> {
    const id = randomUUID();
    const session = new StructuredSession({
      id,
      agent,
      title: titleFor(agent, cwd),
      cwd,
      adapter: makeAdapter(agent),
    });
    session.on("event", (body, evSeq) => this.emit("agentEvent", id, body, evSeq));
    session.on("state", (info) => this.emit("state", info));
    this.structuredSessions.set(id, session);
    try {
      await session.start();
    } catch (e) {
      this.structuredSessions.delete(id);
      await session.dispose().catch(() => {});
      throw new SessionError(
        `无法启动 ${agent} 会话:${e instanceof Error ? e.message : String(e)}`,
        "agent_unavailable",
      );
    }
    this.emit("state", session.info());
    return session.info();
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

  /** 转发一条用户消息(可带附件) */
  async chatSend(sid: string, text: string, attachments?: Attachment[]): Promise<void> {
    const s = this.structuredSessions.get(sid);
    if (!s) throw new SessionError(`no structured session: ${sid}`, "session_not_found");
    await s.send(text, attachments);
  }

  /** 改某个结构化会话的审批策略 */
  setApprovalPolicy(sid: string, policy: ApprovalPolicy): void {
    const s = this.structuredSessions.get(sid);
    if (!s) throw new SessionError(`no structured session: ${sid}`, "session_not_found");
    s.setApprovalPolicy(policy);
  }

  async interrupt(sid: string): Promise<void> {
    const structured = this.structuredSessions.get(sid);
    if (structured) {
      await structured.interrupt();
      return;
    }
    this.requirePty(sid).interrupt();
  }

  /** 终止并移除会话 */
  async kill(sid: string): Promise<void> {
    const structured = this.structuredSessions.get(sid);
    if (structured) {
      const info = structured.info();
      await structured.dispose();
      this.structuredSessions.delete(sid);
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
  disposeAll(): void {
    for (const s of this.ptySessions.values()) s.dispose();
    this.ptySessions.clear();
    for (const s of this.structuredSessions.values()) void s.dispose();
    this.structuredSessions.clear();
  }
}
