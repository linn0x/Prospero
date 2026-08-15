/**
 * Authenticated transport owned by one detached PTY host.
 *
 * This is intentionally separate from structured-supervisor: PTY output has
 * a byte-ring cursor and a terminal snapshot, whereas structured sessions
 * have an event log.  A daemon socket closing is only an unsubscribe.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import type { AgentKind, RingChunk, SessionInfo, SessionStatus } from "@prospero/protocol";
import { toB64 } from "@prospero/protocol";
import type { PtySession, SnapshotResult } from "./pty-session.js";

export const PTY_SUPERVISOR_PROTOCOL_VERSION = 1;
export const PTY_SUPERVISOR_MANIFEST_VERSION = 1;
const MAX_LINE_BYTES = 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export interface PtyOutputEvent {
  sessionId: string;
  kind: "output";
  seq: number;
  dataB64: string;
}

export interface PtyStateEvent {
  sessionId: string;
  kind: "state";
  info: SessionInfo;
}

export type PtySupervisorEvent = PtyOutputEvent | PtyStateEvent;

export interface PtyReplay {
  sessionId: string;
  events: PtyOutputEvent[];
  lastSeq: number;
  gap: boolean;
  info: SessionInfo;
}

export interface PtySupervisorOptions {
  socketPath: string;
  token: string;
  session: PtySession;
  /** Called only after the explicit RPC kill response has been queued. */
  onExplicitKill(): void;
}

/** Private durable attachment record. It contains no credentials. */
export interface PtySupervisorManifest {
  version: 1;
  protocolVersion: number;
  implementation: "pty-supervisor";
  sessionId: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  createdAt: number;
  cols: number;
  rows: number;
  socket: string;
  tokenFile: "token";
  sessionDir?: string;
  supervisorPid?: number;
  lifecycleEpoch: string;
  ownerState: "active" | "killed" | "failed";
  status?: SessionStatus;
  updatedAt?: number;
  accountId?: string;
  accountName?: string;
}

export interface PtySupervisor {
  close(): Promise<void>;
}

export class PtySupervisorError extends Error {
  constructor(message: string, readonly code = "pty_supervisor_error") {
    super(message);
  }
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
  /** last output cursor written for this host session */
  outputSeq: number | null;
}

function safeSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID.test(value)) {
    throw new PtySupervisorError("sessionId is invalid", "bad_request");
  }
  return value;
}

function paramsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PtySupervisorError("params must be an object", "bad_request");
  }
  return value as Record<string, unknown>;
}

function outputCursor(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PtySupervisorError("afterSeq is invalid", "bad_request");
  }
  return value as number;
}

function dimension(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    throw new PtySupervisorError(`${name} is invalid`, "bad_request");
  }
  return value as number;
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
    version: raw["version"], id: raw["id"], method: raw["method"],
    ...(raw["params"] === undefined ? {} : { params: raw["params"] }),
    ...(raw["token"] === undefined ? {} : { token: raw["token"] }),
  };
}

function write(socket: Socket, value: Record<string, unknown>, flushed?: () => void): void {
  if (socket.destroyed || !socket.writable) {
    flushed?.();
    return;
  }
  try {
    // The explicit-kill owner teardown is tied to this callback.  It is
    // therefore ordered after the response entered Node's socket write queue,
    // instead of relying on an arbitrary timer that can race a daemon restart.
    socket.write(`${JSON.stringify({ version: PTY_SUPERVISOR_PROTOCOL_VERSION, ...value })}\n`, flushed);
  } catch {
    // A daemon restart may race a broadcast. Reconnecting is normal.
    flushed?.();
  }
}

function eventForChunk(sessionId: string, chunk: RingChunk): PtyOutputEvent {
  return { sessionId, kind: "output", seq: chunk.seq, dataB64: toB64(chunk.data) };
}

/** Never unlink a live peer's socket while starting a new owner. */
export async function removeVerifiedStalePtySocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  if (!lstatSync(socketPath).isSocket()) {
    throw new PtySupervisorError(`${socketPath} is occupied by a non-socket`, "socket_path_occupied");
  }
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      reject(new PtySupervisorError(`${socketPath} already has a live host`, "socket_path_occupied"));
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

/** Start the private per-session Unix socket. This never owns daemon lifecycle. */
export async function startPtySupervisor(opts: PtySupervisorOptions): Promise<PtySupervisor> {
  if (process.platform === "win32") {
    throw new PtySupervisorError("detached PTY host currently requires Unix socket semantics", "unsupported_platform");
  }
  const connections = new Set<Connection>();
  const broadcastOutput = (dataB64: string, seq: number) => {
    for (const connection of connections) {
      if (connection.outputSeq === null || seq <= connection.outputSeq) continue;
      write(connection.socket, {
        method: "session.event",
        params: { sessionId: opts.session.id, kind: "output", seq, dataB64 } satisfies PtyOutputEvent,
      });
      connection.outputSeq = seq;
    }
  };
  const broadcastState = (info: SessionInfo) => {
    for (const connection of connections) {
      write(connection.socket, {
        method: "session.event",
        params: { sessionId: opts.session.id, kind: "state", info } satisfies PtyStateEvent,
      });
    }
  };
  opts.session.on("output", broadcastOutput);
  opts.session.on("state", broadcastState);

  const server = createServer((socket) => {
    const connection: Connection = { socket, outputSeq: null };
    connections.add(connection);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.once("close", () => connections.delete(connection));
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        write(socket, { id: null, ok: false, error: { code: "request_too_large", message: "request too large" } });
        socket.end();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void handleLine(connection, line, opts);
      }
    });
  });
  await removeVerifiedStalePtySocket(opts.socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(opts.socketPath, 0o600);

  return {
    close: async () => {
      opts.session.off("output", broadcastOutput);
      opts.session.off("state", broadcastState);
      for (const connection of connections) connection.socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(opts.socketPath, { force: true });
    },
  };
}

async function handleLine(connection: Connection, line: string, opts: PtySupervisorOptions): Promise<void> {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch {
    write(connection.socket, { id: null, ok: false, error: { code: "bad_request", message: "invalid JSON" } });
    return;
  }
  const request = requestFrom(raw);
  if (!request) {
    write(connection.socket, { id: null, ok: false, error: { code: "bad_request", message: "missing id or method" } });
    return;
  }
  if (request.version !== PTY_SUPERVISOR_PROTOCOL_VERSION) {
    write(connection.socket, { id: request.id, ok: false, error: { code: "unsupported_version", message: "PTY host protocol mismatch" } });
    return;
  }
  if (!tokenEqual(opts.token, request.token)) {
    write(connection.socket, { id: request.id, ok: false, error: { code: "unauthorized", message: "PTY host token is invalid" } });
    return;
  }
  try {
    const result = await route(connection, request, opts);
    write(
      connection.socket,
      { id: request.id, ok: true, result },
      request.method === "session.kill" ? opts.onExplicitKill : undefined,
    );
  } catch (error) {
    const known = error instanceof PtySupervisorError;
    write(connection.socket, {
      id: request.id, ok: false,
      error: { code: known ? error.code : "internal_error", message: known ? error.message : "PTY host request failed" },
    });
  }
}

async function route(connection: Connection, request: RpcRequest, opts: PtySupervisorOptions): Promise<unknown> {
  const params = paramsObject(request.params ?? {});
  const sessionId = safeSessionId(params["sessionId"]);
  if (sessionId !== opts.session.id) throw new PtySupervisorError("session not found", "session_not_found");
  switch (request.method) {
    case "session.subscribe": {
      const chunks = opts.session.ring.entriesSince(outputCursor(params["afterSeq"]));
      const lastSeq = opts.session.ring.lastSeq;
      // Register before replying. Every later output has exactly one cursor.
      connection.outputSeq = lastSeq;
      return {
        sessionId,
        events: chunks?.map((chunk) => eventForChunk(sessionId, chunk)) ?? [],
        lastSeq,
        gap: chunks === null,
        info: opts.session.info(),
      } satisfies PtyReplay;
    }
    case "session.snapshot":
      return opts.session.snapshot() as Promise<SnapshotResult>;
    case "session.input": {
      if (typeof params["text"] !== "string") throw new PtySupervisorError("text must be a string", "bad_request");
      opts.session.writeInput(params["text"]);
      return { info: opts.session.info() };
    }
    case "session.resize": {
      opts.session.resize(dimension(params["cols"], "cols"), dimension(params["rows"], "rows"));
      return { info: opts.session.info() };
    }
    case "session.interrupt":
      opts.session.interrupt();
      return { info: opts.session.info() };
    case "session.kill":
      opts.session.kill();
      return { info: opts.session.info() };
    case "session.status":
      return { info: opts.session.info(), lastSeq: opts.session.ring.lastSeq };
    default:
      throw new PtySupervisorError(`unknown PTY host method: ${request.method}`, "method_not_found");
  }
}
