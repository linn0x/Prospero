/**
 * Daemon-side RemotePtySession facade for the native Windows Session Host.
 *
 * It deliberately has no native terminal handles: daemon shutdown can only
 * detach this facade.  The detached host owns ConPTY, xterm reducer, journal
 * and Job Object until an explicit `kill` command records its terminal fence.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentKind, SessionInfo, SessionStatus } from "@prospero/protocol";
import { fromB64 } from "@prospero/protocol";
import type { PtySessionOptions, SnapshotResult } from "./pty-session.js";
import type { PtyReplay } from "./pty-supervisor-protocol.js";
import {
  WindowsSessionHostClient,
  attachWindowsSessionHost,
} from "./windows-session-host-client.js";
import { WindowsSessionHostNativeWorker } from "./windows-session-host-native.js";
import {
  isPreHostNativeUnavailable,
  launchDetachedWindowsSessionHost,
  rollbackDetachedWindowsSessionHost,
} from "./windows-session-host-runner.js";
import {
  parseWindowsSessionHostManifest,
  type SessionHostReplayReply,
  type WindowsSessionHostManifest,
} from "./windows-session-host-protocol.js";
import type { WindowsPtyProviderBootstrap } from "./windows-pty-host.js";

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const AGENTS = new Set<AgentKind>(["shell", "claude", "codex", "opencode", "grok", "trae", "custom"]);
const RING_BYTES = 1024 * 1024;
const POLL_MS = 40;
const READ_ONLY_METHODS = ["pty.snapshot", "pty.status"] as const;

export interface WindowsPtyFacadeClient {
  acquireMutationLease(): Promise<string>;
  command(method: string, params: unknown, mutation: boolean, commandId?: string, internalMethod?: string): Promise<unknown>;
  replay(afterSeq?: number): Promise<SessionHostReplayReply>;
  dispose(): Promise<void>;
}

export class WindowsPtySessionError extends Error {
  constructor(message: string, readonly code = "windows_pty_host_unavailable") {
    super(message);
    this.name = "WindowsPtySessionError";
  }
}

export interface WindowsPtySessionRecord {
  readonly schemaVersion: 1;
  readonly implementation: "windows-pty-session";
  readonly id: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly cols: number;
  readonly rows: number;
  readonly accountId?: string;
  readonly accountName?: string;
}

export interface LaunchWindowsPtySessionInput extends PtySessionOptions {
  readonly root: string;
  readonly startupTimeoutMs?: number;
}

interface RingEntry { readonly seq: number; readonly data: Uint8Array; }

/** Output sequence is provider-owned and independent of journal command seq. */
class WindowsOutputRing {
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
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > Number.MAX_SAFE_INTEGER) return false;
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

  entriesSince(afterSeq: number): RingEntry[] | null {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > this.cursor) return null;
    const oldest = this.entries[0]?.seq ?? this.cursor + 1;
    if (afterSeq + 1 < oldest && afterSeq < this.cursor) return null;
    return this.entries.filter((entry) => entry.seq > afterSeq);
  }

  since(afterSeq: number): Uint8Array[] | null {
    return this.entriesSince(afterSeq)?.map((entry) => entry.data) ?? null;
  }
}

function validDimension(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 32767;
}

function safeText(value: unknown, allowEmpty = true): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && !value.includes("\0");
}

function safeWindowsAbsolutePath(value: unknown): value is string {
  return safeText(value, false) && !value.includes("/") && /^(?:[A-Za-z]:\\|\\\\(?![?.]))/.test(value);
}

function safeEnvironment(value: unknown): value is Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([key, entry]) =>
    key.length > 0 && !key.includes("\0") && !key.includes("=") && !key.includes("\r") && !key.includes("\n") &&
    safeText(entry),
  );
}

function assertLaunchInput(input: LaunchWindowsPtySessionInput): void {
  if (!SESSION_ID.test(input.id) || !AGENTS.has(input.agent) || !safeText(input.title) ||
    !safeWindowsAbsolutePath(input.cwd) || !safeWindowsAbsolutePath(input.file) ||
    !validDimension(input.cols) || !validDimension(input.rows) || !Array.isArray(input.args) ||
    !input.args.every((argument) => safeText(argument)) || !safeEnvironment(input.env) ||
    (input.accountId !== undefined && !safeText(input.accountId, false)) ||
    (input.accountName !== undefined && !safeText(input.accountName, false))) {
    throw new WindowsPtySessionError("Windows PTY launch input is invalid", "bad_request");
  }
}

function parseRecord(value: unknown): WindowsPtySessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = ["schemaVersion", "implementation", "id", "agent", "title", "cwd", "createdAt", "cols", "rows", "accountId", "accountName"];
  if (!Object.keys(record).every((key) => keys.includes(key)) ||
    record.schemaVersion !== 1 || record.implementation !== "windows-pty-session" ||
    typeof record.id !== "string" || !SESSION_ID.test(record.id) || typeof record.agent !== "string" || !AGENTS.has(record.agent as AgentKind) ||
    typeof record.title !== "string" || typeof record.cwd !== "string" || !Number.isSafeInteger(record.createdAt) ||
    !validDimension(record.cols) || !validDimension(record.rows) ||
    (record.accountId !== undefined && typeof record.accountId !== "string") ||
    (record.accountName !== undefined && typeof record.accountName !== "string")) return null;
  return {
    schemaVersion: 1,
    implementation: "windows-pty-session",
    id: record.id,
    agent: record.agent as AgentKind,
    title: record.title,
    cwd: record.cwd,
    createdAt: record.createdAt as number,
    cols: record.cols as number,
    rows: record.rows as number,
    ...(typeof record.accountId === "string" ? { accountId: record.accountId } : {}),
    ...(typeof record.accountName === "string" ? { accountName: record.accountName } : {}),
  };
}

function infoFromRecord(record: WindowsPtySessionRecord, status: SessionStatus): SessionInfo {
  return {
    id: record.id,
    agent: record.agent,
    kind: "pty",
    title: record.title,
    cwd: record.cwd,
    status,
    createdAt: record.createdAt,
    cols: record.cols,
    rows: record.rows,
    ...(record.accountId ? { accountId: record.accountId } : {}),
    ...(record.accountName ? { accountName: record.accountName } : {}),
  };
}

function isPtyOutput(payload: unknown): payload is { outputSeq: number; dataB64: string } {
  return !!payload && typeof payload === "object" && !Array.isArray(payload) &&
    (payload as { provider?: unknown }).provider === "pty" && (payload as { type?: unknown }).type === "output" &&
    Number.isSafeInteger((payload as { outputSeq?: unknown }).outputSeq) && (payload as { outputSeq: number }).outputSeq > 0 &&
    typeof (payload as { dataB64?: unknown }).dataB64 === "string";
}

function snapshotFrom(value: unknown): SnapshotResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WindowsPtySessionError("Windows PTY host returned an invalid snapshot", "bad_response");
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.ansi !== "string" || !Number.isSafeInteger(snapshot.seq) || (snapshot.seq as number) < 0 ||
    !validDimension(snapshot.cols) || !validDimension(snapshot.rows)) {
    throw new WindowsPtySessionError("Windows PTY host returned an invalid snapshot", "bad_response");
  }
  return { ansi: snapshot.ansi, seq: snapshot.seq as number, cols: snapshot.cols, rows: snapshot.rows };
}

function statusFrom(value: unknown): { info: SessionInfo; lastOutputSeq: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WindowsPtySessionError("Windows PTY host returned invalid status", "bad_response");
  const status = value as Record<string, unknown>;
  if (!status.info || typeof status.info !== "object" || (status.info as { kind?: unknown }).kind !== "pty" ||
    !Number.isSafeInteger(status.lastOutputSeq) || (status.lastOutputSeq as number) < 0) {
    throw new WindowsPtySessionError("Windows PTY host returned invalid status", "bad_response");
  }
  return { info: status.info as SessionInfo, lastOutputSeq: status.lastOutputSeq as number };
}

function handlerModulePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sameDir = path.join(here, "windows-pty-host.js");
  return existsSync(sameDir) ? sameDir : path.resolve(here, "../dist/windows-pty-host.js");
}

/**
 * This is intentionally a separate class from Unix's RemotePtySession.  Its
 * facade surface is identical while its transport and persistence authority
 * are Windows-native; neither path can accidentally select the other.
 */
export class RemoteWindowsPtySession extends EventEmitter {
  readonly id: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly accountId: string | undefined;
  readonly accountName: string | undefined;
  readonly ring = new WindowsOutputRing();
  private infoValue: SessionInfo;
  private queue: Promise<void> = Promise.resolve();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;
  private disposed = false;

  private constructor(
    readonly manifest: WindowsSessionHostManifest,
    private readonly record: WindowsPtySessionRecord,
    private readonly client: WindowsPtyFacadeClient | null,
    readonly hosting: "windows-session-host" | "unavailable",
  ) {
    super();
    this.id = record.id;
    this.agent = record.agent;
    this.title = record.title;
    this.cwd = record.cwd;
    this.createdAt = record.createdAt;
    this.accountId = record.accountId;
    this.accountName = record.accountName;
    this.infoValue = infoFromRecord(record, hosting === "windows-session-host" ? "starting" : manifest.status === "terminal" ? "done" : "died");
  }

  static async attach(manifest: WindowsSessionHostManifest, record: WindowsPtySessionRecord): Promise<RemoteWindowsPtySession> {
    const client = await attachWindowsSessionHost(manifest, {
      expectedStateDirectory: manifest.stateDirectory,
      readOnlyMethods: READ_ONLY_METHODS,
    });
    return this.attachWithClient(manifest, record, client);
  }

  /** Mock seam: transport is already authenticated by the supplied client. */
  static async attachWithClient(
    manifest: WindowsSessionHostManifest,
    record: WindowsPtySessionRecord,
    client: WindowsPtyFacadeClient,
  ): Promise<RemoteWindowsPtySession> {
    const session = new RemoteWindowsPtySession(manifest, record, client, "windows-session-host");
    try {
      await session.serial(() => session.sync());
      session.startPolling();
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  static unavailable(manifest: WindowsSessionHostManifest, record: WindowsPtySessionRecord): RemoteWindowsPtySession {
    return new RemoteWindowsPtySession(manifest, record, null, "unavailable");
  }

  info(): SessionInfo { return { ...this.infoValue }; }

  async snapshot(): Promise<SnapshotResult> {
    return this.serial(async () => {
      const result = await this.requireClient().command("pty.snapshot", {}, false, randomUUID(), "pty.snapshot");
      const snapshot = snapshotFrom(result);
      this.ring.reset(snapshot.seq);
      this.setInfo({ ...this.infoValue, cols: snapshot.cols, rows: snapshot.rows });
      return snapshot;
    });
  }

  async subscribe(afterSeq = this.ring.lastSeq): Promise<PtyReplay> {
    return this.serial(async () => {
      await this.sync();
      const entries = this.ring.entriesSince(afterSeq);
      return {
        sessionId: this.id,
        events: (entries ?? []).map((entry) => ({ sessionId: this.id, kind: "output", seq: entry.seq, dataB64: Buffer.from(entry.data).toString("base64") })),
        lastSeq: this.ring.lastSeq,
        gap: entries === null,
        info: this.info(),
      };
    });
  }

  async status(): Promise<SessionInfo> {
    return this.serial(async () => {
      const result = statusFrom(await this.requireClient().command("pty.status", {}, false, randomUUID(), "pty.status"));
      // A status query is not a replay boundary. Keep retained output when
      // its cursor agrees; only an owner cursor ahead of this facade forces a
      // later snapshot/gap instead of pretending intervening bytes exist.
      if (result.lastOutputSeq > this.ring.lastSeq) this.ring.reset(result.lastOutputSeq);
      this.setInfo(result.info);
      return this.info();
    });
  }

  async writeInput(text: string): Promise<void> {
    await this.mutate("pty.input", { text });
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (!validDimension(cols) || !validDimension(rows)) throw new WindowsPtySessionError("terminal dimensions are invalid", "bad_request");
    await this.mutate("pty.resize", { cols, rows });
  }

  async interrupt(): Promise<void> { await this.mutate("pty.interrupt", {}); }

  /** Persisted terminal fence is written by the host before its Job is killed. */
  async kill(): Promise<void> {
    await this.serial(async () => {
      const client = this.requireClient();
      await client.acquireMutationLease();
      const result = await client.command("pty.kill", {}, true, randomUUID(), "pty.kill");
      const response = result as { info?: SessionInfo } | null;
      this.setInfo(response?.info && response.info.kind === "pty" ? response.info : { ...this.infoValue, status: "done" });
      await this.sync();
      this.stopPolling();
    });
  }

  /** Daemon shutdown is a facade detach only. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopPolling();
    await this.client?.dispose();
  }

  private async mutate(method: string, params: Record<string, unknown>): Promise<void> {
    await this.serial(async () => {
      const client = this.requireClient();
      await client.acquireMutationLease();
      const result = await client.command(method, params, true, randomUUID(), method);
      const info = (result as { info?: unknown } | null)?.info;
      if (info && typeof info === "object" && (info as SessionInfo).kind === "pty") this.setInfo(info as SessionInfo);
      await this.sync();
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async sync(): Promise<void> {
    const replay = await this.requireClient().replay();
    this.acceptReplay(replay);
  }

  private acceptReplay(replay: SessionHostReplayReply): void {
    if (replay.gap) {
      const state = replay.snapshot?.state;
      if (!state || typeof state !== "object" || Array.isArray(state) ||
        (state as { provider?: unknown }).provider !== "pty" || !Number.isSafeInteger((state as { seq?: unknown }).seq)) {
        throw new WindowsPtySessionError("Windows PTY replay gap lacks a reducer snapshot", "bad_response");
      }
      this.ring.reset((state as { seq: number }).seq);
      const info = (state as { info?: unknown }).info;
      if (info && typeof info === "object" && (info as SessionInfo).kind === "pty") this.setInfo(info as SessionInfo);
    }
    for (const event of replay.events) {
      if (isPtyOutput(event.payload)) {
        let data: Uint8Array;
        try { data = fromB64(event.payload.dataB64); }
        catch { throw new WindowsPtySessionError("Windows PTY replay contains invalid output", "bad_response"); }
        const before = this.ring.lastSeq;
        if (!this.ring.accept(event.payload.outputSeq, data)) {
          throw new WindowsPtySessionError("Windows PTY output sequence is discontinuous", "bad_response");
        }
        if (event.payload.outputSeq === before + 1) this.emit("output", event.payload.dataB64, event.payload.outputSeq);
      } else if (event.payload && typeof event.payload === "object" && (event.payload as { provider?: unknown }).provider === "pty" &&
        (event.payload as { type?: unknown }).type === "terminal") {
        const status = (event.payload as { status?: unknown }).status === "died" ? "died" : "done";
        this.setInfo({ ...this.infoValue, status });
      }
    }
    if (replay.terminal && this.infoValue.status !== "died") this.setInfo({ ...this.infoValue, status: "done" });
  }

  private requireClient(): WindowsPtyFacadeClient {
    if (this.disposed || !this.client || this.hosting !== "windows-session-host") {
      throw new WindowsPtySessionError("Windows PTY host facade is detached or unavailable");
    }
    return this.client;
  }

  private setInfo(info: SessionInfo): void {
    if (info.id !== this.id || info.kind !== "pty") throw new WindowsPtySessionError("Windows PTY host returned mismatched session status", "bad_response");
    this.infoValue = { ...info };
    this.emit("state", this.info());
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      if (this.polling || this.disposed || this.infoValue.status === "done" || this.infoValue.status === "died") return;
      this.polling = true;
      void this.serial(() => this.sync()).catch(() => {}).finally(() => { this.polling = false; });
    }, POLL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

function recordFromInput(input: LaunchWindowsPtySessionInput): WindowsPtySessionRecord {
  return {
    schemaVersion: 1,
    implementation: "windows-pty-session",
    id: input.id,
    agent: input.agent,
    title: input.title,
    cwd: input.cwd,
    createdAt: input.createdAt ?? Date.now(),
    cols: input.cols,
    rows: input.rows,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.accountName ? { accountName: input.accountName } : {}),
  };
}

/** Explicit new-owner launch. Native unavailability is reported to caller for direct-PTY downgrade. */
export async function launchWindowsPtySession(input: LaunchWindowsPtySessionInput): Promise<RemoteWindowsPtySession> {
  if (process.platform !== "win32") throw new WindowsPtySessionError("Windows Session Host is unavailable outside win32", "native_unavailable");
  assertLaunchInput(input);
  const record = recordFromInput(input);
  const stateDirectory = path.join(input.root, input.id);
  const epoch = randomUUID();
  const pipeName = `\\\\.\\pipe\\prospero-session-${input.id}-${epoch}`;
  const bootstrap: WindowsPtyProviderBootstrap = {
    schemaVersion: 1,
    implementation: "windows-pty-provider",
    id: record.id,
    agent: record.agent,
    title: record.title,
    cwd: record.cwd,
    createdAt: record.createdAt,
    cols: record.cols,
    rows: record.rows,
    executablePath: input.file,
    arguments: input.args,
    environment: input.env,
    ...(record.accountId ? { accountId: record.accountId } : {}),
    ...(record.accountName ? { accountName: record.accountName } : {}),
  };
  const bootstrapBytes = new TextEncoder().encode(JSON.stringify(bootstrap));
  try {
    let manifest: WindowsSessionHostManifest;
    try {
      manifest = await launchDetachedWindowsSessionHost({
        sessionId: input.id,
        epoch,
        pipeName,
        stateDirectory,
        handlerModule: pathToFileURL(handlerModulePath()).href,
        createdAt: record.createdAt,
        readOnlyMethods: READ_ONLY_METHODS,
        providerBootstrap: bootstrapBytes,
        providerRecord: new TextEncoder().encode(JSON.stringify(record)),
        ...(input.startupTimeoutMs === undefined ? {} : { manifestTimeoutMs: input.startupTimeoutMs }),
      });
    } catch (error) {
      // This marker can only originate before Windows CreateProcessW. All
      // other failures (including parent Job policy) remain non-fallback PTY
      // launch failures because their durable state may be ambiguous.
      if (isPreHostNativeUnavailable(error)) {
        throw Object.assign(error, { directPtyFallbackAllowed: true });
      }
      throw error;
    }
    try {
      return await RemoteWindowsPtySession.attach(manifest, record);
    } catch (error) {
      // A published manifest does not make daemon-side facade attachment
      // optional. Roll back the exact detached host owner before surfacing the
      // failure, otherwise a caller could start a duplicate direct PTY.
      try {
        await rollbackDetachedWindowsSessionHost(manifest);
      } catch (rollbackError) {
        throw new WindowsPtySessionError(
          `Windows PTY facade attach and exact host rollback failed: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`,
          "post_launch_failed",
        );
      }
      throw new WindowsPtySessionError(
        `Windows PTY facade attach failed after host launch: ${error instanceof Error ? error.message : "unknown error"}`,
        "post_launch_failed",
      );
    }
  } finally {
    // `writeAtomic` copied this into ACL-protected state synchronously in the
    // native worker. Keep the daemon-side credentials out of long-lived JS
    // buffers after the one-shot handoff.
    bootstrapBytes.fill(0);
  }
}

/** Read manifests through the native ACL/reparse-safe state boundary only. */
export async function reconnectWindowsPtySessions(root: string): Promise<RemoteWindowsPtySession[]> {
  if (process.platform !== "win32" || !existsSync(root)) return [];
  let native: WindowsSessionHostNativeWorker;
  try { native = await WindowsSessionHostNativeWorker.create(); }
  catch { return []; }
  const candidates: Array<{ manifest: WindowsSessionHostManifest; record: WindowsPtySessionRecord }> = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
      try {
        const directory = path.join(root, entry.name);
        await native.openState(directory);
        const [manifestBytes, recordBytes] = await Promise.all([native.read("manifest.json"), native.read("provider.record.json")]);
        if (!manifestBytes || !recordBytes) continue;
        const manifest = parseWindowsSessionHostManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
        const record = parseRecord(JSON.parse(new TextDecoder().decode(recordBytes)));
        if (!record || record.id !== entry.name || manifest.sessionId !== record.id || manifest.stateDirectory !== directory) continue;
        candidates.push({ manifest, record });
      } catch { /* untrusted/stale directory remains invisible rather than attachable */ }
    }
  } finally {
    await native.close();
  }
  const sessions: RemoteWindowsPtySession[] = [];
  for (const candidate of candidates) {
    if (candidate.manifest.status === "failed") {
      sessions.push(RemoteWindowsPtySession.unavailable(candidate.manifest, candidate.record));
      continue;
    }
    try { sessions.push(await RemoteWindowsPtySession.attach(candidate.manifest, candidate.record)); }
    catch { sessions.push(RemoteWindowsPtySession.unavailable(candidate.manifest, candidate.record)); }
  }
  return sessions;
}
