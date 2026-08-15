/** Daemon-side reconnectable facade for a detached PTY session host. */
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentKind, SessionInfo } from "@prospero/protocol";
import { fromB64 } from "@prospero/protocol";
import type { PtySessionOptions, SnapshotResult } from "./pty-session.js";
import {
  PTY_SUPERVISOR_MANIFEST_VERSION,
  PTY_SUPERVISOR_PROTOCOL_VERSION,
  type PtyOutputEvent,
  type PtyReplay,
  type PtyStateEvent,
  type PtySupervisorEvent,
  type PtySupervisorManifest,
} from "./pty-supervisor-protocol.js";

export { PTY_SUPERVISOR_MANIFEST_VERSION, type PtySupervisorManifest } from "./pty-supervisor-protocol.js";

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const RING_BYTES = 1024 * 1024;
const STARTUP_TIMEOUT_MS = 8_000;
const ATTACH_TIMEOUT_MS = 250;
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 2_000;
const AGENTS = new Set<AgentKind>(["shell", "claude", "codex", "opencode", "grok", "trae", "custom"]);
const SESSION_STATUSES = new Set(["starting", "running", "waiting_approval", "waiting_input", "idle", "completed", "done", "died"]);

export class RemotePtySupervisorError extends Error {
  constructor(message: string, readonly code = "pty_supervisor_unavailable") {
    super(message);
  }
}

interface RpcReply {
  version?: number;
  id?: number;
  method?: string;
  ok?: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
  params?: unknown;
}

interface RingEntry {
  seq: number;
  data: Uint8Array;
}

/** A daemon-side cache: owner-assigned cursor values are never renumbered. */
class RemoteOutputRing {
  private entries: RingEntry[] = [];
  private bytes = 0;
  private cursor = 0;

  get lastSeq(): number { return this.cursor; }

  reset(cursor: number): void {
    this.entries = [];
    this.bytes = 0;
    this.cursor = cursor;
  }

  accept(seq: number, data: Uint8Array): boolean {
    if (!Number.isSafeInteger(seq) || seq < 1) return false;
    if (seq <= this.cursor) return true;
    if (seq !== this.cursor + 1) return false;
    this.cursor = seq;
    this.entries.push({ seq, data });
    this.bytes += data.byteLength;
    while (this.bytes > RING_BYTES && this.entries.length > 1) {
      const removed = this.entries.shift()!;
      this.bytes -= removed.data.byteLength;
    }
    return true;
  }

  since(lastSeq: number): Uint8Array[] | null {
    if (!Number.isSafeInteger(lastSeq) || lastSeq < 0 || lastSeq > this.cursor) return null;
    const oldest = this.entries[0]?.seq ?? this.cursor + 1;
    if (lastSeq + 1 < oldest && lastSeq < this.cursor) return null;
    return this.entries.filter((entry) => entry.seq > lastSeq).map((entry) => entry.data);
  }
}

class PtySupervisorRpc {
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeout: NodeJS.Timeout | undefined;
  }>();

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly onEvent: (event: PtySupervisorEvent) => void,
    private readonly onDisconnect: () => void,
  ) {}

  async request<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const startedAt = Date.now();
    await this.connect(timeoutMs);
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) throw new RemotePtySupervisorError("PTY host socket unavailable");
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      const remaining = timeoutMs === undefined ? undefined : Math.max(1, timeoutMs - (Date.now() - startedAt));
      const timeout = remaining === undefined ? undefined : setTimeout(() => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.reject(new RemotePtySupervisorError("PTY host request timed out", "startup_timeout"));
        this.socket?.destroy();
      }, remaining);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
    });
    try {
      socket.write(`${JSON.stringify({
        version: PTY_SUPERVISOR_PROTOCOL_VERSION, id, method, params, token: this.token,
      })}\n`);
    } catch (error) {
      const entry = this.pending.get(id);
      if (entry) {
        this.pending.delete(id);
        if (entry.timeout) clearTimeout(entry.timeout);
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private async connect(timeoutMs?: number): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    const connection = (async () => {
      const socket = createConnection(this.socketPath);
      try {
        await withTimeout(once(socket, "connect").then(() => undefined), timeoutMs, "PTY host connection timed out");
      } catch (error) {
        socket.destroy();
        throw error;
      }
      this.socket = socket;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => this.onData(chunk));
      socket.on("error", (error) => { this.rejectAll(error); this.onDisconnect(); });
      socket.on("close", () => {
        this.rejectAll(new RemotePtySupervisorError("PTY host socket closed"));
        this.onDisconnect();
      });
    })();
    this.connecting = connection;
    try { await connection; }
    finally {
      if (this.connecting === connection) this.connecting = null;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: RpcReply;
      try { message = JSON.parse(line) as RpcReply; } catch { continue; }
      if (message.version !== PTY_SUPERVISOR_PROTOCOL_VERSION) {
        const error = new RemotePtySupervisorError("PTY host protocol mismatch", "unsupported_version");
        this.rejectAll(error);
        this.socket?.destroy();
        return;
      }
      if (message.method === "session.event" && message.params) {
        this.onEvent(message.params as PtySupervisorEvent);
        continue;
      }
      if (typeof message.id !== "number") continue;
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      if (entry.timeout) clearTimeout(entry.timeout);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new RemotePtySupervisorError(message.error?.message ?? "PTY host request failed", message.error?.code));
    }
  }

  private rejectAll(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, message: string): Promise<T> {
  if (timeoutMs === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RemotePtySupervisorError(message, "startup_timeout")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function privateWrite(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

function privateMode(file: string): boolean {
  try {
    const metadata = lstatSync(file);
    return metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o600;
  } catch { return false; }
}

function privateSocket(file: string): boolean {
  try {
    const metadata = lstatSync(file);
    return metadata.isSocket() && (metadata.mode & 0o777) === 0o600;
  } catch { return false; }
}

function privateDirectory(file: string): boolean {
  try {
    const metadata = lstatSync(file);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o700;
  } catch { return false; }
}

/** Legacy roots may be 0755, but must never be a symlink or writable by peers. */
function safeSupervisorRoot(file: string): boolean {
  try {
    const metadata = lstatSync(file);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o022) === 0;
  } catch { return false; }
}

function ensurePrivateDirectory(file: string): void {
  mkdirSync(file, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(file);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new RemotePtySupervisorError("PTY host directory is not a private directory", "unsafe_path");
  }
  chmodSync(file, 0o700);
  if (!privateDirectory(file)) throw new RemotePtySupervisorError("PTY host directory has unsafe mode", "unsafe_path");
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function readPtySupervisorManifest(file: string): PtySupervisorManifest | null {
  if (!privateMode(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const manifest = value as Partial<PtySupervisorManifest>;
    if (
      manifest.version !== PTY_SUPERVISOR_MANIFEST_VERSION ||
      manifest.protocolVersion !== PTY_SUPERVISOR_PROTOCOL_VERSION ||
      manifest.implementation !== "pty-supervisor" ||
      typeof manifest.sessionId !== "string" || !SESSION_ID.test(manifest.sessionId) ||
      typeof manifest.agent !== "string" || !AGENTS.has(manifest.agent as AgentKind) ||
      typeof manifest.title !== "string" || typeof manifest.cwd !== "string" ||
      !Number.isSafeInteger(manifest.createdAt) ||
      typeof manifest.cols !== "number" || !Number.isInteger(manifest.cols) || manifest.cols < 1 || manifest.cols > 10_000 ||
      typeof manifest.rows !== "number" || !Number.isInteger(manifest.rows) || manifest.rows < 1 || manifest.rows > 10_000 ||
      typeof manifest.socket !== "string" || !path.isAbsolute(manifest.socket) ||
      manifest.tokenFile !== "token" || typeof manifest.lifecycleEpoch !== "string" || manifest.lifecycleEpoch.length === 0 ||
      (manifest.ownerState !== "active" && manifest.ownerState !== "killed" && manifest.ownerState !== "failed") ||
      (manifest.status !== undefined && (typeof manifest.status !== "string" || !SESSION_STATUSES.has(manifest.status))) ||
      (manifest.sessionDir !== undefined && (typeof manifest.sessionDir !== "string" || !path.isAbsolute(manifest.sessionDir))) ||
      (manifest.supervisorPid !== undefined && (!Number.isSafeInteger(manifest.supervisorPid) || manifest.supervisorPid <= 1)) ||
      (manifest.updatedAt !== undefined && !Number.isSafeInteger(manifest.updatedAt))
    ) return null;
    return manifest as PtySupervisorManifest;
  } catch { return null; }
}

function initialInfo(manifest: PtySupervisorManifest, available: boolean): SessionInfo {
  return {
    id: manifest.sessionId,
    agent: manifest.agent,
    kind: "pty",
    title: manifest.title,
    cwd: manifest.cwd,
    status: available ? "starting" : (manifest.status === "done" ? "done" : "died"),
    createdAt: manifest.createdAt,
    cols: manifest.cols,
    rows: manifest.rows,
    ...(manifest.accountId ? { accountId: manifest.accountId } : {}),
    ...(manifest.accountName ? { accountName: manifest.accountName } : {}),
  };
}

/** Same terminal surface used by WS, backed by authenticated host RPC. */
export class RemotePtySession extends EventEmitter {
  readonly id: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly accountId: string | undefined;
  readonly accountName: string | undefined;
  readonly ring = new RemoteOutputRing();
  private rpc: PtySupervisorRpc | null = null;
  private infoValue: SessionInfo;
  private disconnected = false;
  private repairing = false;

  private constructor(private readonly manifest: PtySupervisorManifest, readonly hosting: "supervisor" | "unavailable") {
    super();
    this.id = manifest.sessionId;
    this.agent = manifest.agent;
    this.title = manifest.title;
    this.cwd = manifest.cwd;
    this.createdAt = manifest.createdAt;
    this.accountId = manifest.accountId;
    this.accountName = manifest.accountName;
    this.infoValue = initialInfo(manifest, hosting === "supervisor");
  }

  static async attach(manifest: PtySupervisorManifest, timeoutMs?: number): Promise<RemotePtySession> {
    const session = new RemotePtySession(manifest, "supervisor");
    try {
      await session.reconnect(timeoutMs);
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  static unavailable(manifest: PtySupervisorManifest): RemotePtySession {
    return new RemotePtySession(manifest, "unavailable");
  }

  info(): SessionInfo { return { ...this.infoValue }; }

  async reconnect(timeoutMs?: number): Promise<void> {
    if (this.hosting === "unavailable") throw new RemotePtySupervisorError("PTY host is unavailable");
    const previous = this.rpc;
    // Clear the old capability before reading the token again.  If the token
    // file was replaced/unsafe, callers must not be able to reconnect through
    // the old in-memory RPC object after this method rejects.
    this.rpc = null;
    this.disconnected = true;
    previous?.close();
    const token = this.token();
    let rpc: PtySupervisorRpc;
    rpc = new PtySupervisorRpc(this.manifest.socket, token, (event) => this.acceptEvent(event), () => {
      if (this.rpc === rpc) this.disconnected = true;
    });
    this.rpc = rpc;
    this.disconnected = false;
    try {
      const replay = await rpc.request<PtyReplay>("session.subscribe", { sessionId: this.id, afterSeq: this.ring.lastSeq }, timeoutMs);
      this.acceptReplay(replay);
      const status = await rpc.request<{ info: SessionInfo; lastSeq: number }>("session.status", { sessionId: this.id }, timeoutMs);
      if (!Number.isSafeInteger(status.lastSeq) || status.lastSeq < 0) {
        throw new RemotePtySupervisorError("PTY host returned an invalid output cursor", "bad_response");
      }
      if (this.ring.lastSeq < status.lastSeq) this.ring.reset(status.lastSeq);
      this.setInfo(status.info);
    } catch (error) {
      if (this.rpc === rpc) {
        this.rpc = null;
        this.disconnected = true;
        rpc.close();
      }
      throw error;
    }
  }

  async snapshot(): Promise<SnapshotResult> {
    return this.request("session.snapshot", {});
  }

  /** Explicit replay endpoint for callers that need a durable output cursor. */
  async subscribe(afterSeq = this.ring.lastSeq): Promise<PtyReplay> {
    const replay = await this.request<PtyReplay>("session.subscribe", { afterSeq });
    this.acceptReplay(replay);
    return replay;
  }

  async status(): Promise<SessionInfo> {
    const result = await this.request<{ info: SessionInfo; lastSeq: number }>("session.status", {});
    this.setInfo(result.info);
    return this.info();
  }

  async writeInput(text: string): Promise<void> {
    await this.request("session.input", { text });
  }

  async resize(cols: number, rows: number): Promise<void> {
    const result = await this.request<{ info?: SessionInfo }>("session.resize", { cols, rows });
    if (result.info) this.setInfo(result.info);
  }

  async interrupt(): Promise<void> {
    await this.request("session.interrupt", {});
  }

  /** The only facade method allowed to terminate the detached owner. */
  async kill(): Promise<void> {
    await this.request("session.kill", {});
    this.setInfo({ ...this.infoValue, status: "done" });
    this.rpc?.close();
    this.disconnected = true;
  }

  /** Daemon shutdown only detaches the facade. */
  async dispose(): Promise<void> {
    this.rpc?.close();
    this.rpc = null;
    this.disconnected = true;
  }

  private token(): string {
    const file = path.join(this.ownerDir(), this.manifest.tokenFile);
    if (!privateMode(file)) throw new RemotePtySupervisorError("PTY host token is missing or has unsafe mode");
    const token = readFileSync(file, "utf8").trim();
    if (!token) throw new RemotePtySupervisorError("PTY host token is empty");
    return token;
  }

  private ownerDir(): string { return this.manifest.sessionDir ?? path.dirname(this.manifest.socket); }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.rpc || this.disconnected) throw new RemotePtySupervisorError("PTY host client is disconnected");
    return this.rpc.request<T>(method, { sessionId: this.id, ...params });
  }

  private acceptReplay(replay: PtyReplay): void {
    if (
      !replay || replay.sessionId !== this.id || !Array.isArray(replay.events) ||
      !Number.isSafeInteger(replay.lastSeq) || replay.lastSeq < 0 || typeof replay.gap !== "boolean" ||
      !replay.info || replay.info.id !== this.id || replay.info.kind !== "pty"
    ) {
      throw new RemotePtySupervisorError("PTY host returned an invalid replay", "bad_response");
    }
    if (replay.gap) {
      // The xterm snapshot is authoritative once the host evicted output.
      // Preserve cursor so WS asks for a snapshot rather than claiming a gap
      // is replayable from this newly attached daemon cache.
      this.ring.reset(replay.lastSeq);
    } else {
      for (const event of replay.events) {
        if (!this.acceptOutput(event) || event.seq > replay.lastSeq) {
          this.ring.reset(replay.lastSeq);
          break;
        }
      }
      // A response that claims a cursor but omits a frame is treated exactly
      // like a retained-history gap.  This preserves the WS snapshot fallback
      // instead of incorrectly asserting that a partial replay is complete.
      if (this.ring.lastSeq < replay.lastSeq) this.ring.reset(replay.lastSeq);
    }
    this.setInfo(replay.info);
  }

  private acceptEvent(event: PtySupervisorEvent): void {
    if (!event || event.sessionId !== this.id) return;
    if (event.kind === "state") {
      const info = (event as PtyStateEvent).info;
      if (!info || info.id !== this.id || info.kind !== "pty") {
        void this.repairGap();
        return;
      }
      this.setInfo(info);
      return;
    }
    if (!this.acceptOutput(event as PtyOutputEvent)) {
      void this.repairGap();
    }
  }

  private acceptOutput(event: PtyOutputEvent): boolean {
    if (event.sessionId !== this.id || typeof event.dataB64 !== "string") return true;
    let data: Uint8Array;
    try { data = fromB64(event.dataB64); } catch { return false; }
    const before = this.ring.lastSeq;
    const accepted = this.ring.accept(event.seq, data);
    if (accepted && event.seq === before + 1) this.emit("output", event.dataB64, event.seq);
    return accepted;
  }

  private async repairGap(): Promise<void> {
    if (this.repairing || this.disconnected) return;
    this.repairing = true;
    try { await this.reconnect(); } catch { this.disconnected = true; }
    finally { this.repairing = false; }
  }

  private setInfo(info: SessionInfo): void {
    this.infoValue = { ...info };
    this.emit("state", this.info());
  }
}

export interface LaunchPtySupervisorInput extends PtySessionOptions {
  root: string;
  createdAt: number;
  startupTimeoutMs?: number;
}

function runnerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sameDir = path.join(here, "pty-supervisor-runner.js");
  if (existsSync(sameDir)) return sameDir;
  return path.resolve(here, "../dist/pty-supervisor-runner.js");
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function processGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): void {
  try { process.kill(-groupId, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForProcessGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(groupId) && Date.now() < deadline) await delay(20);
  return !processGroupAlive(groupId);
}

function removeLaunchSocket(socketPath: string, socketDir: string): void {
  if (path.dirname(socketPath) !== socketDir) return;
  try { if (lstatSync(socketPath).isSocket()) rmSync(socketPath, { force: true }); } catch { /* absent is fine */ }
  try {
    const metadata = lstatSync(socketDir);
    if (metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o700) rmdirSync(socketDir);
  } catch { /* retain non-empty/changed directory */ }
}

interface PtyGroupTermination {
  exited: boolean;
  errors: Error[];
}

function cleanupError(stage: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new RemotePtySupervisorError(`${stage}: ${detail}`, "cleanup_failed");
}

/**
 * Rollback is authorized only to address the exact detached group returned by
 * this launch.  It never consults a manifest PID, avoiding stale-PID attacks
 * and accidental termination of a reconnected owner.
 */
async function terminateNewPtySupervisorGroup(
  groupId: number | undefined,
  spawnAttempted: boolean,
): Promise<PtyGroupTermination> {
  if (!spawnAttempted) return { exited: true, errors: [] };
  if (!groupId || !Number.isSafeInteger(groupId) || groupId <= 1) {
    return {
      exited: false,
      errors: [new RemotePtySupervisorError("new PTY host process group was not identified during launch rollback", "cleanup_failed")],
    };
  }
  if (!processGroupAlive(groupId)) return { exited: true, errors: [] };

  const errors: Error[] = [];
  try { signalProcessGroup(groupId, "SIGTERM"); }
  catch (error) { errors.push(cleanupError("failed to SIGTERM new PTY host process group", error)); }
  try {
    if (await waitForProcessGroupExit(groupId, TERM_GRACE_MS)) return { exited: true, errors };
  } catch (error) {
    errors.push(cleanupError("failed while waiting for new PTY host after SIGTERM", error));
  }
  try { signalProcessGroup(groupId, "SIGKILL"); }
  catch (error) { errors.push(cleanupError("failed to SIGKILL new PTY host process group", error)); }
  try {
    if (await waitForProcessGroupExit(groupId, KILL_GRACE_MS)) return { exited: true, errors };
  } catch (error) {
    errors.push(cleanupError("failed while waiting for new PTY host after SIGKILL", error));
  }
  if (!processGroupAlive(groupId)) return { exited: true, errors };
  errors.push(new RemotePtySupervisorError("new PTY host process group did not exit during launch rollback", "cleanup_failed"));
  return { exited: false, errors };
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const spawned = () => {
      child.off("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      child.off("spawn", spawned);
      reject(error);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

export interface FailedPtySupervisorLaunch {
  groupId: number | undefined;
  spawnAttempted: boolean;
  bootstrap: string | undefined;
  socketPath: string;
  socketDir: string;
  manifestFile: string;
  manifest: PtySupervisorManifest;
}

export interface FailedPtySupervisorLaunchRollback {
  groupExited: boolean;
  errors: Error[];
}

/**
 * Remove credentials regardless of other cleanup failures.  Runtime endpoints
 * are removed only after the exact launch group is confirmed gone; otherwise
 * the manifest is retained as failed/read-only history rather than risking a
 * live owner's socket.
 */
export async function rollbackFailedPtySupervisorLaunch(
  failedLaunch: FailedPtySupervisorLaunch,
): Promise<FailedPtySupervisorLaunchRollback> {
  const errors: Error[] = [];
  let groupExited = false;
  try {
    const termination = await terminateNewPtySupervisorGroup(failedLaunch.groupId, failedLaunch.spawnAttempted);
    groupExited = termination.exited;
    errors.push(...termination.errors);
  } catch (error) {
    errors.push(cleanupError("failed to terminate new PTY host process group", error));
  }
  if (failedLaunch.bootstrap) {
    try { rmSync(failedLaunch.bootstrap, { force: true }); }
    catch (error) { errors.push(cleanupError("failed to remove PTY host bootstrap", error)); }
  }
  if (groupExited) {
    try { removeLaunchSocket(failedLaunch.socketPath, failedLaunch.socketDir); }
    catch (error) { errors.push(cleanupError("failed to remove PTY host launch socket", error)); }
  } else {
    errors.push(new RemotePtySupervisorError(
      "new PTY host process group was not confirmed exited; retained launch socket/runtime directory",
      "cleanup_failed",
    ));
  }
  try {
    const latest = readPtySupervisorManifest(failedLaunch.manifestFile) ?? failedLaunch.manifest;
    privateWrite(failedLaunch.manifestFile, {
      ...latest,
      ...(latest.supervisorPid === undefined && failedLaunch.groupId ? { supervisorPid: failedLaunch.groupId } : {}),
      ownerState: "failed",
      status: "died",
      updatedAt: Date.now(),
    });
  } catch (error) {
    errors.push(cleanupError("failed to preserve failed PTY host manifest", error));
  }
  return { groupExited, errors };
}

function addRollbackDiagnostics(original: unknown, rollback: FailedPtySupervisorLaunchRollback): Error {
  const primary = original instanceof Error ? original : new Error(String(original));
  if (rollback.errors.length === 0) return primary;
  Object.defineProperty(primary, "rollbackErrors", {
    configurable: true,
    value: new AggregateError(rollback.errors, "PTY host launch rollback encountered cleanup failures"),
  });
  return primary;
}

/** Launch exactly one detached owner. Existing manifests are never replaced. */
export async function launchPtySupervisor(input: LaunchPtySupervisorInput): Promise<RemotePtySession> {
  if (process.platform === "win32") throw new RemotePtySupervisorError("detached PTY host requires Windows process-tree review", "unsupported_platform");
  if (!SESSION_ID.test(input.id)) throw new RemotePtySupervisorError("invalid PTY session id", "bad_request");
  const timeout = input.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RemotePtySupervisorError("invalid PTY host startup timeout", "bad_request");
  ensurePrivateDirectory(input.root);
  const sessionDir = path.join(input.root, input.id);
  if (existsSync(sessionDir)) throw new RemotePtySupervisorError("PTY host session directory already exists", "session_exists");
  ensurePrivateDirectory(sessionDir);
  const token = randomBytes(32).toString("base64url");
  const tokenPath = path.join(sessionDir, "token");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const socketDir = mkdtempSync("/tmp/prospero-pty-host-");
  chmodSync(socketDir, 0o700);
  const socket = path.join(socketDir, "s.sock");
  const manifest: PtySupervisorManifest = {
    version: PTY_SUPERVISOR_MANIFEST_VERSION,
    protocolVersion: PTY_SUPERVISOR_PROTOCOL_VERSION,
    implementation: "pty-supervisor",
    sessionId: input.id,
    agent: input.agent,
    title: input.title,
    cwd: input.cwd,
    createdAt: input.createdAt,
    cols: input.cols,
    rows: input.rows,
    socket,
    tokenFile: "token",
    sessionDir,
    lifecycleEpoch: randomUUID(),
    ownerState: "active",
    status: "starting",
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.accountName ? { accountName: input.accountName } : {}),
  };
  const manifestFile = path.join(sessionDir, "manifest.json");
  let bootstrap: string | undefined;
  let groupId: number | undefined;
  let spawnAttempted = false;
  try {
    privateWrite(manifestFile, manifest);
    bootstrap = path.join(sessionDir, `.bootstrap-${randomBytes(8).toString("hex")}.json`);
    privateWrite(bootstrap, {
      ...input,
      version: 1,
      sessionDir,
      socketPath: socket,
      socketDir,
    });
    const child = spawn(process.execPath, [runnerPath()], {
      detached: true,
      stdio: "ignore",
      cwd: sessionDir,
      // Credentials only pass through the protected bootstrap, never argv or
      // the host process environment inherited by unrelated children.
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        TMPDIR: process.env["TMPDIR"] ?? "/tmp",
        LANG: process.env["LANG"] ?? "en_US.UTF-8",
        LC_ALL: process.env["LC_ALL"] ?? "",
        SHELL: process.env["SHELL"] ?? "/bin/sh",
        USER: process.env["USER"] ?? "",
        PROSPERO_PTY_SUPERVISOR_CONFIG: bootstrap,
      },
    });
    spawnAttempted = true;
    child.once("exit", () => {
      try { rmSync(bootstrap!, { force: true }); }
      catch { /* rollback retains diagnostics if launch did not succeed */ }
    });
    await waitForSpawn(child);
    if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 1) throw new RemotePtySupervisorError("PTY host spawn returned no process id", "spawn_failed");
    groupId = child.pid;
    child.unref();
    // Preserve a runner state transition that may have raced the detached
    // spawn; the launcher only contributes the process-group identifier.
    privateWrite(manifestFile, {
      ...(readPtySupervisorManifest(manifestFile) ?? manifest),
      supervisorPid: groupId,
      updatedAt: Date.now(),
    });
    const ready = readPtySupervisorManifest(manifestFile);
    if (!ready) throw new RemotePtySupervisorError("failed to write PTY host manifest");
    const deadline = Date.now() + timeout;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try { return await RemotePtySession.attach(ready, Math.min(ATTACH_TIMEOUT_MS, Math.max(1, deadline - Date.now()))); }
      catch (error) { lastError = error; await delay(Math.min(40, Math.max(1, deadline - Date.now()))); }
    }
    throw new RemotePtySupervisorError(`PTY host did not become ready: ${lastError instanceof Error ? lastError.message : "unknown error"}`, "startup_timeout");
  } catch (error) {
    const rollback = await rollbackFailedPtySupervisorLaunch({
      groupId, spawnAttempted, bootstrap, socketPath: socket, socketDir, manifestFile, manifest,
    });
    throw addRollbackDiagnostics(error, rollback);
  }
}

/** Scan manifests only. A stale owner becomes read-only; it is never replaced. */
export async function reconnectPtySupervisors(root: string): Promise<RemotePtySession[]> {
  if (process.platform === "win32" || !existsSync(root) || !safeSupervisorRoot(root)) return [];
  const sessions: RemotePtySession[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    if (!privateDirectory(dir)) continue;
    const manifest = readPtySupervisorManifest(path.join(dir, "manifest.json"));
    if (!manifest || manifest.sessionId !== entry.name) continue;
    const scoped = { ...manifest, sessionDir: dir };
    if (
      manifest.ownerState !== "active" || !processAlive(manifest.supervisorPid) ||
      !privateMode(path.join(dir, "token")) || !privateSocket(manifest.socket)
    ) {
      sessions.push(RemotePtySession.unavailable(scoped));
      continue;
    }
    try { sessions.push(await RemotePtySession.attach(scoped)); }
    catch { sessions.push(RemotePtySession.unavailable(scoped)); }
  }
  return sessions;
}
