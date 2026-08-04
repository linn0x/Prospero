import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AgentKind, SessionInfo } from "@prospero/protocol";
import { commandFor, requiresShellCapability, spawnEnv } from "./agents.js";
import { PtySession } from "./pty-session.js";

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
  cwd?: string | undefined;
  command?: string | undefined;
  cols: number;
  rows: number;
  /** 来自设备注册表:该设备是否允许 shell/custom(完整用户权限) */
  allowShell: boolean;
}

export interface SessionManagerEvents {
  output: [sid: string, dataB64: string, seq: number];
  state: [info: SessionInfo];
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private readonly sessions = new Map<string, PtySession>();

  create(input: CreateSessionInput): PtySession {
    if (requiresShellCapability(input.agent) && !input.allowShell) {
      throw new SessionError(
        `device is not allowed to start "${input.agent}" sessions`,
        "shell_not_allowed",
      );
    }
    let spec;
    try {
      spec = commandFor(input.agent, input.command);
    } catch (e) {
      throw new SessionError(
        e instanceof Error ? e.message : String(e),
        "agent_unavailable",
      );
    }
    const cwd = input.cwd ?? os.homedir();
    const id = randomUUID();
    const title = `${input.agent} · ${path.basename(cwd)}`;
    let session: PtySession;
    try {
      session = new PtySession({
        id,
        agent: input.agent,
        title,
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
    this.sessions.set(id, session);
    session.on("output", (dataB64, seq) => this.emit("output", id, dataB64, seq));
    session.on("state", (info) => this.emit("state", info));
    this.emit("state", session.info());
    return session;
  }

  get(sid: string): PtySession | undefined {
    return this.sessions.get(sid);
  }

  require(sid: string): PtySession {
    const s = this.sessions.get(sid);
    if (!s) throw new SessionError(`no such session: ${sid}`, "session_not_found");
    return s;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()]
      .map((s) => s.info())
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 终止并移除会话 */
  kill(sid: string): void {
    const s = this.require(sid);
    const info = s.info();
    s.dispose();
    this.sessions.delete(sid);
    this.emit("state", {
      ...info,
      status: info.status === "done" ? "done" : "died",
    });
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }
}
