import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  AgentEventBody,
  AgentKind,
  SessionInfo,
  SessionKind,
} from "@prospero/protocol";
import { commandFor, requiresShellCapability, spawnEnv, structuredCapable } from "./agents.js";
import { PtySession } from "./pty-session.js";
import { StructuredSession, titleFor } from "./structured-session.js";
import { ClaudeAdapter } from "./adapters/claude.js";
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
    default:
      throw new SessionError(`agent "${agent}" 暂无结构化适配器`, "agent_unavailable");
  }
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly ptySessions = new Map<string, PtySession>();
  private readonly structuredSessions = new Map<string, StructuredSession>();

  /** 结构化会话需要异步启动后端,故整体为 async */
  async create(input: CreateSessionInput): Promise<SessionInfo> {
    if (requiresShellCapability(input.agent) && !input.allowShell) {
      throw new SessionError(
        `device is not allowed to start "${input.agent}" sessions`,
        "shell_not_allowed",
      );
    }
    const cwd = input.cwd ?? os.homedir();
    const kind: SessionKind =
      input.kind ?? (structuredCapable(input.agent) ? "structured" : "pty");
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
    let session: PtySession;
    try {
      session = new PtySession({
        id,
        agent: input.agent,
        title: `${input.agent} · ${path.basename(cwd)}`,
        cwd,
        cols: input.cols,
        rows: input.rows,
        file: spec.file,
        args: spec.args,
        env: spawnEnv(),
      });
    } catch (e) {
      // node-pty 对不存在的可执行文件同步抛 posix_spawnp failed
      throw new SessionError(
        `failed to spawn "${spec.file}" — is ${input.agent} installed? (${e instanceof Error ? e.message : String(e)})`,
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
    this.ptySessions.delete(sid);
    this.emit("state", {
      ...info,
      status: info.status === "done" ? "done" : "died",
    });
  }

  disposeAll(): void {
    for (const s of this.ptySessions.values()) s.dispose();
    this.ptySessions.clear();
    for (const s of this.structuredSessions.values()) void s.dispose();
    this.structuredSessions.clear();
  }
}
