/**
 * Daemon-independent structured-session supervisor transport.
 *
 * A daemon is only an authenticated client here. Closing that client is never
 * interpreted as an adapter interrupt or disposal request; only session.kill
 * has that meaning. Production adapter migration is intentionally separate.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import type { AgentEventBody, SessionInfo } from "@prospero/protocol";
import {
  isStructuredSupervisorEndpoint,
  structuredSupervisorPlatformGate,
  structuredSupervisorTransport,
} from "./structured-supervisor-platform.js";

import {
  migrateSupervisorReplay,
  SupervisorEventDatabase,
  SUPERVISOR_REPLAY_LIMIT,
  type ReplaySession,
} from "./supervisor-event-database.js";

const MAX_LINE_BYTES = 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** Bump only with a backwards-compatible server/client migration plan. */
export const SUPERVISOR_PROTOCOL_VERSION = 1;

export type SupervisorSessionStatus = "created" | "running" | "killed" | "failed";

export interface SupervisorEvent {
  sessionId: string;
  /** Strictly increasing per session; this is the durable replay cursor. */
  seq: number;
  at: number;
  body: AgentEventBody;
}

export interface SupervisorAdapterContext {
  emit(body: AgentEventBody): void;
  state(info: SessionInfo): void;
}

/** The supervisor owns this adapter's process/SDK handles, never the daemon. */
export interface SupervisorAdapter {
  /** Optional v1 extension: lifecycle metadata is pushed separately from replayable agent events. */
  stateNotifications?: boolean;
  start(context: SupervisorAdapterContext): Promise<void>;
  send?(text: string): Promise<void>;
  interrupt?(): Promise<void>;
  /** Explicit kill only; neither socket close nor daemon shutdown calls this. */
  kill?(): Promise<void>;
  /**
   * Provider-neutral control plane used by the production StructuredSession
   * wrapper.  The transport deliberately treats the method and payload as
   * opaque: provider vocabularies (especially approvals) stay in the runner.
   */
  call?(method: string, params: unknown): Promise<unknown>;
}

export interface SupervisorReplay {
  events: SupervisorEvent[];
  lastSeq: number;
  /** History was retained only after this cursor; caller needs a snapshot. */
  gap: boolean;
}

export interface StructuredSupervisorOptions {
  /** Private directory, normally ~/.prospero/structured-supervisor. */
  home: string;
  socketPath?: string;
  /** Defaults to supervisor.token for the standalone transport slice. */
  tokenPath?: string;
  token?: string;
}

export interface StructuredSupervisor {
  readonly socketPath: string;
  readonly tokenPath: string;
  /** Launcher may pass this through a protected pipe/file, never argv. */
  readonly token: string;
  createSession(sessionId: string, adapter: SupervisorAdapter): Promise<void>;
  replay(sessionId: string, afterSeq: number): SupervisorReplay;
  /** Stop IPC only. Supervised adapters are deliberately left untouched. */
  close(): Promise<void>;
}

type PersistedSession = ReplaySession;

function isKilled(status: SupervisorSessionStatus): boolean { return status === "killed"; }

interface RuntimeSession {
  persisted: PersistedSession;
  adapter: SupervisorAdapter | null;
  started: boolean;
  storageFailed?: boolean;
}

interface RpcRequest {
  version: unknown;
  id: string | number;
  method: string;
  params?: unknown;
  token?: unknown;
}

interface Connection {
  socket: Socket;
  /** sessionId -> final event sequence already written to this connection */
  subscriptions: Map<string, number>;
}

export class SupervisorError extends Error {
  constructor(message: string, readonly code: string = "supervisor_error") {
    super(message);
  }
}

function safeSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID.test(value)) {
    throw new SupervisorError("sessionId 无效", "bad_request");
  }
  return value;
}

function paramsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SupervisorError("params 必须是对象", "bad_request");
  }
  return value as Record<string, unknown>;
}

function cursor(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SupervisorError("afterSeq 无效", "bad_request");
  }
  return value;
}

function tokenEqual(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestFrom(value: unknown): RpcRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if ((typeof raw["id"] !== "string" && typeof raw["id"] !== "number") || typeof raw["method"] !== "string") {
    return null;
  }
  return {
    version: raw["version"],
    id: raw["id"],
    method: raw["method"],
    ...(raw["params"] === undefined ? {} : { params: raw["params"] }),
    ...(raw["token"] === undefined ? {} : { token: raw["token"] }),
  };
}

function write(socket: Socket, value: Record<string, unknown>): void {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(`${JSON.stringify({ version: SUPERVISOR_PROTOCOL_VERSION, ...value })}\n`);
  } catch {
    // A daemon may restart after writable was checked. Reconnection is normal.
  }
}

class SupervisorState {
  private database: SupervisorEventDatabase | null = null;
  private readonly databasePath: string;
  readonly sessions = new Map<string, RuntimeSession>();

  constructor(
    home: string,
    private readonly broadcast: (event: SupervisorEvent) => void,
    private readonly broadcastInfo: (sessionId: string, info: SessionInfo) => void,
  ) {
    this.databasePath = path.join(home, "supervisor.sqlite");
    // Metadata only: replay is loaded on demand, never parsed at process start.
    for (const persisted of this.store().sessions()) {
      this.sessions.set(persisted.id, { persisted, adapter: null, started: false });
    }
  }

  private store(): SupervisorEventDatabase {
    return this.database ??= new SupervisorEventDatabase(this.databasePath);
  }

  closePersistence(): void {
    this.database?.close();
    this.database = null;
    // If an adapter emits after IPC closes, store() reopens its journal. Closing
    // a daemon-facing endpoint is still not an adapter cancellation operation.
  }

  create(sessionId: string, adapter: SupervisorAdapter): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.adapter) throw new SupervisorError("session 已存在", "session_exists");
      if (existing.persisted.status === "killed") {
        throw new SupervisorError("session 已被显式终止", "session_killed");
      }
      // A restarted supervisor retains history before its real adapter wrapper
      // attaches. Adoption preserves the original sessionId and cursor.
      existing.adapter = adapter;
      return this.start(existing);
    }
    const runtime: RuntimeSession = {
      persisted: { id: sessionId, status: "created", oldestSeq: 0, lastSeq: 0 },
      adapter,
      started: false,
    };
    this.sessions.set(sessionId, runtime);
    this.store().saveSession(runtime.persisted);
    return this.start(runtime);
  }

  private async start(runtime: RuntimeSession): Promise<void> {
    if (runtime.started) return;
    const adapter = runtime.adapter;
    if (!adapter) throw new SupervisorError("session 没有可接管的 adapter", "adapter_missing");
    runtime.started = true;
    runtime.persisted.status = "running";
    this.store().saveSession(runtime.persisted);
    try {
      await adapter.start({
        emit: (body) => this.record(runtime, body),
        state: (info) => {
          if (info.id !== runtime.persisted.id || (isKilled(runtime.persisted.status) && info.status !== "done" && info.status !== "died")) return;
          this.broadcastInfo(runtime.persisted.id, info);
        },
      });
    } catch (error) {
      // A concurrent explicit kill remains terminal even if its adapter then
      // reports an expected cancellation/startup error.
      if (!isKilled(runtime.persisted.status)) {
        runtime.persisted.status = "failed";
        this.store().saveSession(runtime.persisted);
      }
      throw error;
    }
  }

  async send(sessionId: string, text: string): Promise<void> {
    const session = this.require(sessionId);
    this.requireWritable(session);
    if (session.persisted.status === "killed") throw new SupervisorError("session 已被显式终止", "session_killed");
    if (!session.adapter?.send) throw new SupervisorError("adapter 不支持 send", "unsupported");
    await session.adapter.send(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.require(sessionId);
    if (!session.adapter?.interrupt) throw new SupervisorError("adapter 不支持 interrupt", "unsupported");
    await session.adapter.interrupt();
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.require(sessionId);
    if (session.persisted.status === "killed") return;
    // Persist the termination fence before touching native work. An adapter
    // can still emit during (or even after) cancellation; those late events
    // must not revive a session or leak into a subsequent daemon attachment.
    const killed: PersistedSession = { ...session.persisted, status: "killed" };
    this.store().saveSession(killed);
    session.persisted = killed;
    await session.adapter?.kill?.();
  }

  async call(sessionId: string, method: string, params: unknown): Promise<unknown> {
    const session = this.require(sessionId);
    this.requireWritable(session);
    if (session.persisted.status === "killed") {
      throw new SupervisorError("session 已被显式终止", "session_killed");
    }
    if (!session.adapter?.call) throw new SupervisorError("adapter 不支持 control call", "unsupported");
    return session.adapter.call(method, params);
  }

  status(sessionId: string): { status: SupervisorSessionStatus; lastSeq: number } {
    const runtime = this.require(sessionId);
    return { status: runtime.storageFailed ? "failed" : runtime.persisted.status, lastSeq: runtime.persisted.lastSeq };
  }

  stateNotifications(sessionId: string): boolean {
    return this.require(sessionId).adapter?.stateNotifications === true;
  }

  replay(sessionId: string, afterSeq: number): SupervisorReplay {
    const session = this.require(sessionId).persisted;
    const gap = afterSeq < session.oldestSeq;
    return {
      events: this.store().replay(session, gap ? session.oldestSeq : afterSeq),
      lastSeq: session.lastSeq,
      gap,
    };
  }

  private record(runtime: RuntimeSession, body: AgentEventBody): void {
    const persisted = runtime.persisted;
    if (persisted.status === "killed") return;
    this.requireWritable(runtime);
    const event: SupervisorEvent = {
      sessionId: persisted.id,
      seq: persisted.lastSeq + 1,
      at: Date.now(),
      body,
    };
    // Commit the event and durable cursor together, before acknowledging it.
    // No in-memory replay array and no full JSON snapshot on turn boundaries.
    try { this.store().append(event, persisted); }
    catch {
      // The session checkpoint may already contain this body. Never assign its
      // sequence to a later event if this independent replay commit failed.
      runtime.storageFailed = true;
      throw new SupervisorError("会话历史写入失败，已停止接受新操作；原始数据保留", "storage_failed");
    }
    persisted.lastSeq = event.seq;
    persisted.oldestSeq = Math.max(persisted.oldestSeq, event.seq - SUPERVISOR_REPLAY_LIMIT);
    this.broadcast(event);
  }

  private requireWritable(runtime: RuntimeSession): void {
    if (runtime.storageFailed) throw new SupervisorError("会话历史写入失败，已停止接受新操作；原始数据保留", "storage_failed");
  }

  private require(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SupervisorError("session 不存在", "session_not_found");
    return session;
  }

}

/**
 * A stale Unix socket is safe to unlink only after a connection attempt has
 * proved that no listener owns it. Never unlink an unknown live supervisor:
 * doing so would create two owners for the same persisted session.
 */
async function removeVerifiedStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  if (!lstatSync(socketPath).isSocket()) {
    throw new SupervisorError(`${socketPath} 已被非 socket 文件占用`, "socket_path_occupied");
  }
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      reject(new SupervisorError(`${socketPath} 已有运行中的 supervisor`, "socket_path_occupied"));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT" || error.code === "ECONNRESET") {
        rmSync(socketPath, { force: true });
        resolve();
        return;
      }
      reject(error);
    });
  });
}

/** Start the private Unix-socket endpoint used by daemon clients. */
export async function startStructuredSupervisor(
  opts: StructuredSupervisorOptions,
): Promise<StructuredSupervisor> {
  const platformGate = structuredSupervisorPlatformGate();
  if (platformGate) throw new SupervisorError(platformGate, "unsupported_platform");
  const transport = structuredSupervisorTransport();
  if (!transport) throw new SupervisorError("structured supervisor transport is unavailable", "unsupported_platform");
  mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  chmodSync(opts.home, 0o700);
  const socketPath = opts.socketPath ?? path.join(opts.home, "supervisor.sock");
  if (!isStructuredSupervisorEndpoint(socketPath, transport)) {
    throw new SupervisorError("structured supervisor endpoint 与当前平台不兼容", "bad_request");
  }
  const tokenPath = opts.tokenPath ?? path.join(opts.home, "supervisor.token");
  const token = opts.token ?? randomBytes(32).toString("base64url");

  await removeVerifiedStaleSocket(socketPath);
  try { await migrateSupervisorReplay(opts.home); }
  catch { throw new SupervisorError("supervisor 历史迁移失败，原始数据保留", "state_invalid"); }

  const connections = new Set<Connection>();
  const state = new SupervisorState(opts.home, (event) => {
    for (const connection of connections) {
      const sent = connection.subscriptions.get(event.sessionId);
      if (sent === undefined || event.seq <= sent) continue;
      write(connection.socket, { method: "session.event", params: event });
      connection.subscriptions.set(event.sessionId, event.seq);
    }
  }, (sessionId, info) => {
    for (const connection of connections) {
      if (connection.subscriptions.has(sessionId)) write(connection.socket, { method: "session.info", params: { sessionId, info } });
    }
  });
  const server = createServer((socket) => {
    const connection: Connection = { socket, subscriptions: new Map() };
    connections.add(connection);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.once("close", () => connections.delete(connection));
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        write(socket, { id: null, ok: false, error: { code: "request_too_large", message: "请求过大" } });
        socket.end();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void handleLine(connection, line, token, state);
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    state.closePersistence();
    throw error;
  }
  try {
    chmodSync(socketPath, 0o600);
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(socketPath, { force: true });
    state.closePersistence();
    throw error;
  }

  return {
    socketPath,
    tokenPath,
    token,
    createSession: (sessionId, adapter) => state.create(safeSessionId(sessionId), adapter),
    replay: (sessionId, afterSeq) => state.replay(safeSessionId(sessionId), cursor(afterSeq)),
    close: async () => {
      for (const connection of connections) connection.socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketPath, { force: true });
      state.closePersistence();
    },
  };
}

async function handleLine(
  connection: Connection,
  line: string,
  token: string,
  state: SupervisorState,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    write(connection.socket, { id: null, ok: false, error: { code: "bad_request", message: "不是有效 JSON" } });
    return;
  }
  const request = requestFrom(raw);
  if (!request) {
    write(connection.socket, { id: null, ok: false, error: { code: "bad_request", message: "缺少 id 或 method" } });
    return;
  }
  if (request.version !== SUPERVISOR_PROTOCOL_VERSION) {
    write(connection.socket, {
      id: request.id,
      ok: false,
      error: { code: "unsupported_version", message: "supervisor 协议版本不兼容" },
    });
    return;
  }
  if (!tokenEqual(token, request.token)) {
    write(connection.socket, { id: request.id, ok: false, error: { code: "unauthorized", message: "supervisor token 无效" } });
    return;
  }
  try {
    const result = await route(connection, request, state);
    write(connection.socket, { id: request.id, ok: true, result });
  } catch (error) {
    const known = error instanceof SupervisorError;
    // supervisor 以 detached + stdio:"ignore" 运行,console 输出无处可去:这条
    // 响应是原始错误唯一的出口。丢掉它,daemon 日志里就只剩一句通用文案,
    // 现场永久消失 —— 排查 respondQuestion 之类的失败时完全无从下手。
    write(connection.socket, {
      id: request.id,
      ok: false,
      error: {
        code: known ? error.code : "internal_error",
        message: known
          ? error.message
          : `supervisor 请求失败(${request.method}): ${
              error instanceof Error ? error.message : String(error)
            }`,
      },
    });
  }
}

async function route(connection: Connection, request: RpcRequest, state: SupervisorState): Promise<unknown> {
  const params = paramsObject(request.params ?? {});
  const sessionId = safeSessionId(params["sessionId"]);
  switch (request.method) {
    case "session.subscribe": {
      const replay = params["tailOnly"] === true
        ? { events: [], lastSeq: state.status(sessionId).lastSeq, gap: false }
        : state.replay(sessionId, cursor(params["afterSeq"]));
      // Register before the response so the next event has exactly one cursor.
      connection.subscriptions.set(sessionId, replay.lastSeq);
      return { sessionId, ...replay, stateNotifications: state.stateNotifications(sessionId) };
    }
    case "session.send": {
      if (typeof params["text"] !== "string") throw new SupervisorError("text 必须是字符串", "bad_request");
      await state.send(sessionId, params["text"]);
      return state.status(sessionId);
    }
    case "session.interrupt":
      await state.interrupt(sessionId);
      return state.status(sessionId);
    case "session.kill":
      await state.kill(sessionId);
      return state.status(sessionId);
    case "session.call": {
      if (typeof params["method"] !== "string") {
        throw new SupervisorError("method 必须是字符串", "bad_request");
      }
      return state.call(sessionId, params["method"], params["params"] ?? {});
    }
    case "session.status":
      return state.status(sessionId);
    default:
      throw new SupervisorError(`未知 supervisor method: ${request.method}`, "method_not_found");
  }
}
