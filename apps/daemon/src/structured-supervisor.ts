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
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import type { AgentEventBody } from "@prospero/protocol";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_EVENTS_PER_SESSION = 4_000;
const STATE_VERSION = 1;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

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
}

/** The supervisor owns this adapter's process/SDK handles, never the daemon. */
export interface SupervisorAdapter {
  start(context: SupervisorAdapterContext): Promise<void>;
  send?(text: string): Promise<void>;
  interrupt?(): Promise<void>;
  /** Explicit kill only; neither socket close nor daemon shutdown calls this. */
  kill?(): Promise<void>;
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

interface PersistedSession {
  id: string;
  status: SupervisorSessionStatus;
  /** Sequence immediately before events[0] when retention compacted history. */
  oldestSeq: number;
  lastSeq: number;
  events: SupervisorEvent[];
}

interface PersistedState {
  version: number;
  sessions: PersistedSession[];
}

interface RuntimeSession {
  persisted: PersistedSession;
  adapter: SupervisorAdapter | null;
  started: boolean;
}

interface RpcRequest {
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
    id: raw["id"],
    method: raw["method"],
    ...(raw["params"] === undefined ? {} : { params: raw["params"] }),
    ...(raw["token"] === undefined ? {} : { token: raw["token"] }),
  };
}

function write(socket: Socket, value: unknown): void {
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(`${JSON.stringify(value)}\n`);
  } catch {
    // A daemon may restart after writable was checked. Reconnection is normal.
  }
}

class SupervisorState {
  private readonly statePath: string;
  readonly sessions = new Map<string, RuntimeSession>();

  constructor(
    home: string,
    private readonly broadcast: (event: SupervisorEvent) => void,
  ) {
    this.statePath = path.join(home, "state.json");
    this.load();
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
      persisted: { id: sessionId, status: "created", oldestSeq: 0, lastSeq: 0, events: [] },
      adapter,
      started: false,
    };
    this.sessions.set(sessionId, runtime);
    this.persist();
    return this.start(runtime);
  }

  private async start(runtime: RuntimeSession): Promise<void> {
    if (runtime.started) return;
    const adapter = runtime.adapter;
    if (!adapter) throw new SupervisorError("session 没有可接管的 adapter", "adapter_missing");
    runtime.started = true;
    runtime.persisted.status = "running";
    this.persist();
    try {
      await adapter.start({ emit: (body) => this.record(runtime, body) });
    } catch (error) {
      runtime.persisted.status = "failed";
      this.persist();
      throw error;
    }
  }

  async send(sessionId: string, text: string): Promise<void> {
    const session = this.require(sessionId);
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
    await session.adapter?.kill?.();
    session.persisted.status = "killed";
    this.persist();
  }

  status(sessionId: string): { status: SupervisorSessionStatus; lastSeq: number } {
    const session = this.require(sessionId).persisted;
    return { status: session.status, lastSeq: session.lastSeq };
  }

  replay(sessionId: string, afterSeq: number): SupervisorReplay {
    const session = this.require(sessionId).persisted;
    const gap = afterSeq < session.oldestSeq;
    return {
      events: gap ? [...session.events] : session.events.filter((event) => event.seq > afterSeq),
      lastSeq: session.lastSeq,
      gap,
    };
  }

  private record(runtime: RuntimeSession, body: AgentEventBody): void {
    const persisted = runtime.persisted;
    const event: SupervisorEvent = {
      sessionId: persisted.id,
      seq: persisted.lastSeq + 1,
      at: Date.now(),
      body,
    };
    persisted.lastSeq = event.seq;
    persisted.events.push(event);
    while (persisted.events.length > MAX_EVENTS_PER_SESSION) {
      const removed = persisted.events.shift();
      if (removed) persisted.oldestSeq = removed.seq;
    }
    // Durably replace state before any client gets a notification. This is the
    // no-loss side of the reconnect contract.
    this.persist();
    this.broadcast(event);
  }

  private require(sessionId: string): RuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SupervisorError("session 不存在", "session_not_found");
    return session;
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch {
      throw new SupervisorError("supervisor state.json 损坏，拒绝覆盖", "state_invalid");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SupervisorError("supervisor state.json 无效，拒绝覆盖", "state_invalid");
    }
    const state = parsed as Partial<PersistedState>;
    if (state.version !== STATE_VERSION || !Array.isArray(state.sessions)) {
      throw new SupervisorError("supervisor state 版本不兼容", "state_invalid");
    }
    for (const candidate of state.sessions) {
      if (!candidate || typeof candidate !== "object" || !SESSION_ID.test(candidate.id)) continue;
      if (!Array.isArray(candidate.events) || typeof candidate.lastSeq !== "number" || typeof candidate.oldestSeq !== "number") continue;
      if (!isStatus(candidate.status)) continue;
      const events = candidate.events.filter(isSupervisorEvent);
      this.sessions.set(candidate.id, {
        persisted: {
          id: candidate.id,
          status: candidate.status,
          oldestSeq: candidate.oldestSeq,
          lastSeq: candidate.lastSeq,
          events,
        },
        adapter: null,
        started: false,
      });
    }
  }

  private persist(): void {
    const state: PersistedState = {
      version: STATE_VERSION,
      sessions: [...this.sessions.values()].map((runtime) => runtime.persisted),
    };
    const temp = `${this.statePath}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.statePath);
    chmodSync(this.statePath, 0o600);
  }
}

function isStatus(value: unknown): value is SupervisorSessionStatus {
  return value === "created" || value === "running" || value === "killed" || value === "failed";
}

function isSupervisorEvent(value: unknown): value is SupervisorEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<SupervisorEvent>;
  return (
    typeof event.sessionId === "string" &&
    SESSION_ID.test(event.sessionId) &&
    typeof event.seq === "number" &&
    Number.isSafeInteger(event.seq) &&
    event.seq > 0 &&
    typeof event.at === "number" &&
    !!event.body &&
    typeof event.body === "object"
  );
}

/** Start the private Unix-socket endpoint used by daemon clients. */
export async function startStructuredSupervisor(
  opts: StructuredSupervisorOptions,
): Promise<StructuredSupervisor> {
  mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  chmodSync(opts.home, 0o700);
  if (process.platform === "win32") {
    throw new SupervisorError("structured supervisor 纵切暂只支持 Unix socket", "unsupported_platform");
  }
  const socketPath = opts.socketPath ?? path.join(opts.home, "supervisor.sock");
  const tokenPath = path.join(opts.home, "supervisor.token");
  const token = opts.token ?? randomBytes(32).toString("base64url");
  if (existsSync(socketPath)) {
    if (!lstatSync(socketPath).isSocket()) {
      throw new SupervisorError(`${socketPath} 已被非 socket 文件占用`, "socket_path_occupied");
    }
    rmSync(socketPath, { force: true });
  }
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);

  const connections = new Set<Connection>();
  const state = new SupervisorState(opts.home, (event) => {
    for (const connection of connections) {
      const sent = connection.subscriptions.get(event.sessionId);
      if (sent === undefined || event.seq <= sent) continue;
      write(connection.socket, { method: "session.event", params: event });
      connection.subscriptions.set(event.sessionId, event.seq);
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);

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
  if (!tokenEqual(token, request.token)) {
    write(connection.socket, { id: request.id, ok: false, error: { code: "unauthorized", message: "supervisor token 无效" } });
    return;
  }
  try {
    const result = await route(connection, request, state);
    write(connection.socket, { id: request.id, ok: true, result });
  } catch (error) {
    const known = error instanceof SupervisorError;
    write(connection.socket, {
      id: request.id,
      ok: false,
      error: {
        code: known ? error.code : "internal_error",
        message: known ? error.message : "supervisor 请求失败",
      },
    });
  }
}

async function route(connection: Connection, request: RpcRequest, state: SupervisorState): Promise<unknown> {
  const params = paramsObject(request.params ?? {});
  const sessionId = safeSessionId(params["sessionId"]);
  switch (request.method) {
    case "session.subscribe": {
      const replay = state.replay(sessionId, cursor(params["afterSeq"]));
      // Register before the response so the next event has exactly one cursor.
      connection.subscriptions.set(sessionId, replay.lastSeq);
      return { sessionId, ...replay };
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
    case "session.status":
      return state.status(sessionId);
    default:
      throw new SupervisorError(`未知 supervisor method: ${request.method}`, "method_not_found");
  }
}
