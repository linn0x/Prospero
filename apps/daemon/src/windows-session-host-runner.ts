/**
 * Detached-owner side of the common Windows Session Host transport.
 *
 * It is intentionally provider-neutral: structured and PTY verticals supply
 * `handleCommand`, but cannot weaken the pipe handshake, durable journal, or
 * single-daemon mutation fence implemented here.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import {
  NATIVE_WINDOWS_ABI_VERSION,
  type DetachedHostLaunchOptions,
  type DetachedHostLaunchResult,
  type PipePeerIdentity,
  type ProcessIdentity,
} from "@prospero/windows-native";
import { isStrictWindowsPipePeerIdentity } from "./windows-session-host-native.js";
import {
  assertEpoch,
  assertSecureWindowsPipeName,
  assertSessionId,
  decodeWireMessage,
  encodeWireMessage,
  helloProofMaterial,
  isProcessIdentity,
  parseWindowsSessionHostManifest,
  processIdentityEquals,
  proofEquals,
  sessionEpochEntropy,
  splitWireFrames,
  welcomeProofMaterial,
  WindowsSessionHostJournal,
  WindowsSessionHostUnavailable,
  type SessionHostCommand,
  type SessionHostHello,
  type SessionHostReplayReply,
  type SessionHostReplayRequest,
  type SessionHostReply,
  type SessionHostWelcome,
  type SessionHostWireMessage,
  type WindowsSessionHostEvent,
  type WindowsSessionHostJournalEvent,
  type WindowsSessionHostManifest,
  type WindowsSessionHostSnapshot,
} from "./windows-session-host-protocol.js";
import { WindowsSessionHostNativeWorker } from "./windows-session-host-native.js";
import { emittedSiblingPath } from "./runtime-module-path.js";

const MAX_PIPE_READ_BYTES = 1024 * 1024;
const COMPACTION_EVENT_LIMIT = 128;
const DEFAULT_LEASE_MS = 15_000;
const TRANSPORT_STOP_TIMEOUT_MS = 2_000;

export interface WindowsSessionHostRunnerNative {
  openState(path: string): Promise<void>;
  read(fileName: string): Promise<Uint8Array | null>;
  writeAtomic(fileName: string, bytes: Uint8Array): Promise<void>;
  removeState(fileName: string): Promise<void>;
  createCredential(entropy: Uint8Array): Promise<void>;
  hmac(material: Uint8Array): Promise<string>;
  currentIdentity(): Promise<ProcessIdentity>;
  /** Native-only provider Job ownership. No PID kill fallback exists. */
  processIdentity?(pid: number): Promise<ProcessIdentity>;
  createProviderJob?(): Promise<unknown>;
  assignProviderProcess?(process: ProcessIdentity): Promise<void>;
  /** Exact PID+FILETIME membership audit; it never assigns a process. */
  isProviderProcessInJob?(process: ProcessIdentity): Promise<boolean>;
  terminateProviderJob?(): Promise<void>;
  closeProviderJob?(): Promise<void>;
  createPipe(pipeName: string): Promise<void>;
  acceptPipe(): Promise<void>;
  readPipe(maxBytes: number): Promise<{ data: Uint8Array; peer: PipePeerIdentity | null }>;
  writePipe(bytes: Uint8Array): Promise<number>;
  closePipeConnection(): Promise<void>;
  closePipeServer(): Promise<void>;
  /** Interrupts a blocking accept/read from a separate native worker. */
  cancelActivePipeIo?(): Promise<void>;
  close?(): Promise<void>;
}

export interface WindowsSessionHostCommandContext {
  readonly commandId: string;
  readonly method: string;
  readonly params: unknown;
}

export type WindowsSessionHostCommandOutcome =
  | { readonly ok: true; readonly result: unknown; readonly terminal?: boolean; readonly snapshotState?: unknown; readonly terminalStateReady?: boolean; readonly afterReply?: () => Promise<void> }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly terminal?: boolean; readonly snapshotState?: unknown; readonly terminalStateReady?: boolean; readonly afterReply?: () => Promise<void> };

export interface WindowsSessionHostCommandHandler {
  handleCommand(context: WindowsSessionHostCommandContext): Promise<WindowsSessionHostCommandOutcome>;
  /** Optional reducer state written during journal compaction. */
  snapshotState?(): Promise<unknown> | unknown;
  /**
   * Releases provider-owned resources when a detached host cannot finish
   * booting or its transport is deliberately stopped.  In particular, a PTY
   * provider uses this to close its ConPTY and Job Object rather than leaving
   * the host process exit as the only cleanup path.
   */
  dispose?(): Promise<void> | void;
}

/** Provider output durable even while no daemon is currently attached. */
export interface WindowsSessionHostAppendEventOptions {
  /** Appends a terminal record; all subsequent command/event writes fence. */
  readonly terminal?: boolean;
  /** Optional provider reducer state to retain during terminal compaction. */
  readonly snapshotState?: unknown;
}

export interface StartWindowsSessionHostOptions {
  readonly sessionId: string;
  readonly epoch: string;
  readonly pipeName: string;
  readonly stateDirectory: string;
  readonly handler: WindowsSessionHostCommandHandler;
  readonly createdAt?: number;
  readonly leaseDurationMs?: number;
  /** Explicit server policy; defaults to no lease-free handler commands. */
  readonly readOnlyMethods?: readonly string[];
}

const DETACHED_BOOTSTRAP_FILE = "host.bootstrap.json";
const DETACHED_READY_FILE = "host.ready.json";
const DETACHED_FAILED_FILE = "host.failed.json";
const DETACHED_STARTUP_STAGES = [
  "opening_state",
  "claiming_bootstrap",
  "creating_provider_job",
  "resolving_owner",
  "assigning_owner_job",
  "auditing_owner_job",
  "importing_handler",
  "starting_common_host",
  "starting_handler",
  "publishing_ready",
] as const;
type DetachedStartupStage = typeof DETACHED_STARTUP_STAGES[number];
const PROVIDER_BOOTSTRAP_FILE = "provider.bootstrap.json";
const PROVIDER_RECORD_FILE = "provider.record.json";
const DETACHED_RUNNER_ENV = "PROSPERO_WINDOWS_SESSION_HOST_STATE_DIRECTORY";
const DETACHED_TEST_DIAGNOSTIC_ENV = "PROSPERO_WINDOWS_SESSION_HOST_TEST_DIAGNOSTIC";
const SIGNED_SESSION_HOST_TEST_ENV = "PROSPERO_WINDOWS_SIGNED_SESSION_HOST_TEST";
const DETACHED_HOST_ROLLBACK_EXIT_CODE = 0xC000013A;
const DETACHED_HOST_ROLLBACK_TIMEOUT_MS = 5_000;

export interface DetachedRunnerBootstrap {
  readonly schemaVersion: 2;
  readonly implementation: "windows-session-host-runner";
  readonly sessionId: string;
  readonly epoch: string;
  readonly pipeName: string;
  readonly stateDirectory: string;
  readonly handlerModule: string;
  readonly createdAt: number;
  readonly leaseDurationMs?: number;
  readonly readOnlyMethods?: readonly string[];
  /** Vertical-specific JSON held in secure state until one host consumes it. */
  readonly handlerOptions?: unknown;
}

export interface LaunchDetachedWindowsSessionHostOptions {
  readonly sessionId: string;
  readonly epoch: string;
  readonly pipeName: string;
  readonly stateDirectory: string;
  /** Absolute file URL implementing `createWindowsSessionHostHandler`. */
  readonly handlerModule: string;
  readonly createdAt?: number;
  readonly leaseDurationMs?: number;
  readonly readOnlyMethods?: readonly string[];
  /** Vertical-specific bootstrap, never exposed through manifest/environment. */
  readonly handlerOptions?: unknown;
  /**
   * Opaque, ACL-protected bootstrap consumed exactly once by the provider
   * factory.  It never crosses argv or the host environment.
   */
  readonly providerBootstrap?: Uint8Array;
  /** Immutable provider metadata retained for daemon restart discovery. */
  readonly providerRecord?: Uint8Array;
  /** Test/deployment override; defaults to the compiled common runner entry. */
  readonly runnerEntryPath?: string;
  /** Bounded manifest publication wait, primarily a deterministic test seam. */
  readonly manifestTimeoutMs?: number;
}

export interface WindowsSessionHostHandlerFactory {
  createWindowsSessionHostHandler(context: Readonly<{
    sessionId: string;
    epoch: string;
    stateDirectory: string;
    /** Durable provider output, serialized with all command outcomes. */
    appendEvent(payload: unknown, options?: WindowsSessionHostAppendEventOptions): Promise<WindowsSessionHostJournalEvent>;
    /** Alias for appendEvent for streaming PTY/structured implementations. */
    emit(payload: unknown, options?: WindowsSessionHostAppendEventOptions): Promise<WindowsSessionHostJournalEvent>;
    /**
     * Returns the already-active host-owned KILL_ON_JOB_CLOSE Job. The host
     * joined it before this factory was imported, so all provider descendants
     * inherit it with no spawn-to-assign escape window.
     */
    createProviderJob(): Promise<WindowsSessionHostProviderJob>;
    /** Opaque bootstrap configuration held only in secure native state. */
    handlerOptions?: unknown;
    /** Atomically consumes the provider's one-use opaque bootstrap payload. */
    consumeProviderBootstrap(): Promise<Uint8Array>;
  }>): Promise<WindowsSessionHostCommandHandler> | WindowsSessionHostCommandHandler;
}

export interface WindowsSessionHostProviderJob {
  /** Audits a provider's exact identity and inherited Job membership only. */
  registerProcess(process: { pid?: number | undefined }): Promise<void>;
  readonly registeredProcessCount: number;
  terminate(): Promise<void>;
  close(): Promise<void>;
}

interface MutationLease {
  readonly id: string;
  readonly daemon: ProcessIdentity;
  expiresAt: number;
}

interface AuthenticatedConnection {
  readonly daemon: ProcessIdentity;
  readonly peer: PipePeerIdentity;
}

interface CommandLedgerEntry {
  readonly commandId: string;
  readonly reply: SessionHostReply;
}

/** Resolves factory-time output only after the common runner owns the journal. */
class DeferredAppendEventSink {
  private runner: WindowsSessionHostRunner | null = null;
  private failure: Error | null = null;
  private readonly ready: Promise<WindowsSessionHostRunner>;
  private resolveReady!: (runner: WindowsSessionHostRunner) => void;
  private rejectReady!: (error: Error) => void;

  constructor() {
    this.ready = new Promise<WindowsSessionHostRunner>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Factory/startup failure can settle this before any provider append has
    // observed it. Keep the original promise rejection for callers while
    // preventing an intentionally fenced startup from becoming unhandled.
    void this.ready.catch(() => undefined);
  }

  bind(runner: WindowsSessionHostRunner): void {
    if (this.runner || this.failure) throw runnerFailure("Windows session host append sink was already settled", "native_unavailable");
    this.runner = runner;
    this.resolveReady(runner);
  }

  fail(error: Error): void {
    if (this.runner || this.failure) return;
    this.failure = error;
    this.rejectReady(error);
  }

  async appendEvent(payload: unknown, options?: WindowsSessionHostAppendEventOptions): Promise<WindowsSessionHostJournalEvent> {
    const runner = this.runner ?? await this.ready;
    return runner.appendEvent(payload, options);
  }
}

/** Handler calls are gated until an asynchronous detached factory has settled. */
class DeferredCommandHandler implements WindowsSessionHostCommandHandler {
  private handler: WindowsSessionHostCommandHandler | null = null;
  private readonly ready: Promise<WindowsSessionHostCommandHandler>;
  private resolveReady!: (handler: WindowsSessionHostCommandHandler) => void;
  private rejectReady!: (error: Error) => void;

  constructor() {
    this.ready = new Promise<WindowsSessionHostCommandHandler>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // startWindowsSessionHostWithNative may fail before a pipe command ever
    // waits for this deferred handler.
    void this.ready.catch(() => undefined);
  }

  bind(handler: WindowsSessionHostCommandHandler): void {
    if (this.handler) throw runnerFailure("Windows session host handler was already bound", "native_unavailable");
    this.handler = handler;
    this.resolveReady(handler);
  }

  fail(error: Error): void { this.rejectReady(error); }

  async handleCommand(context: WindowsSessionHostCommandContext): Promise<WindowsSessionHostCommandOutcome> {
    return (this.handler ?? await this.ready).handleCommand(context);
  }

  snapshotState(): Promise<unknown> | unknown {
    // Recovery may compact a crash tail before the factory has loaded. The
    // validated journal prefix remains authoritative; defer provider state
    // rather than deadlocking detached startup on a factory await.
    return this.handler?.snapshotState?.() ?? null;
  }

  async dispose(): Promise<void> {
    await this.handler?.dispose?.();
  }
}

/**
 * The provider tree is owned by one native Job for the lifetime of a host.
 * Keeping this wrapper here prevents a vertical from ever receiving a raw
 * handle it could substitute with a PID-oriented kill operation.
 */
class NativeWindowsSessionHostProviderJob implements WindowsSessionHostProviderJob {
  private closed = false;
  private registered = 0;

  constructor(private readonly native: Pick<WindowsSessionHostRunnerNative,
    "processIdentity" | "isProviderProcessInJob" | "terminateProviderJob" | "closeProviderJob">) {}

  get registeredProcessCount(): number { return this.registered; }

  async registerProcess(process: { pid?: number | undefined }): Promise<void> {
    if (this.closed) throw new WindowsSessionHostUnavailable("terminal_fence", "Windows provider Job Object is closed");
    const pid = process.pid;
    if (!Number.isSafeInteger(pid) || !pid || pid < 2) {
      throw new WindowsSessionHostUnavailable("native_unavailable", "Windows provider process has no valid PID");
    }
    if (!this.native.processIdentity || !this.native.isProviderProcessInJob) {
      throw new WindowsSessionHostUnavailable("native_capability_missing", "Windows native provider Job membership audit is unavailable");
    }
    try {
      const identity = await this.native.processIdentity(pid);
      if (!await this.native.isProviderProcessInJob(identity)) {
        throw new Error("provider process is not a member of the host Job");
      }
      this.registered++;
    } catch (error) {
      throw new WindowsSessionHostUnavailable(
        "provider_job_incompatible",
        `provider_job_incompatible: ${error instanceof Error ? error.message : "native Job membership audit failed"}`,
      );
    }
  }

  async terminate(): Promise<void> {
    if (this.closed) return;
    if (!this.native.terminateProviderJob) {
      throw new WindowsSessionHostUnavailable("native_capability_missing", "Windows native Job termination API is unavailable");
    }
    await this.native.terminateProviderJob();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.native.closeProviderJob) {
      throw new WindowsSessionHostUnavailable("native_capability_missing", "Windows native Job close API is unavailable");
    }
    await this.native.closeProviderJob();
    this.closed = true;
  }
}

function runnerFailure(message: string, code = "session_host_rejected"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isDetachedStartupStage(value: unknown): value is DetachedStartupStage {
  return typeof value === "string" && (DETACHED_STARTUP_STAGES as readonly string[]).includes(value);
}

async function writeDetachedStartupFailure(
  native: Pick<WindowsSessionHostRunnerNative, "writeAtomic">,
  error: unknown,
  stage: DetachedStartupStage,
): Promise<void> {
  const code = (error as { code?: unknown } | null)?.code === "provider_job_incompatible"
    ? "provider_job_incompatible"
    : "native_unavailable";
  // Persist only a closed enum and normalized code. Arbitrary provider/native
  // error text can contain paths or configuration and must never cross this
  // secure-state diagnostic boundary.
  await native.writeAtomic(DETACHED_FAILED_FILE, new TextEncoder().encode(JSON.stringify({
    version: 1,
    code,
    stage,
  }))).catch(() => {});
}

function writeDetachedTestDiagnostic(
  environment: NodeJS.ProcessEnv,
  stage: string,
): void {
  const diagnosticPath = environment[DETACHED_TEST_DIAGNOSTIC_ENV];
  if (typeof diagnosticPath !== "string" || diagnosticPath.length === 0) return;
  try { writeFileSync(diagnosticPath, JSON.stringify({ version: 1, stage })); }
  catch { /* CI-only sibling diagnostic must not change startup behavior */ }
}

function validCommandId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

function validNonceProof(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length <= 512;
}

function strictPeer(value: PipePeerIdentity | null): value is PipePeerIdentity {
  if (!isObject(value) || !hasOnlyKeys(value, ["process", "userSid", "sessionId"])) return false;
  return isStrictWindowsPipePeerIdentity(value);
}

function strictHello(value: SessionHostWireMessage, manifest: WindowsSessionHostManifest): SessionHostHello {
  if (!isObject(value) || !hasOnlyKeys(value, ["version", "type", "sessionId", "epoch", "daemon", "nonce", "proof"]) ||
    value.type !== "hello" || value.version !== 2 || value.sessionId !== manifest.sessionId ||
    value.epoch !== manifest.epoch || !isProcessIdentity(value.daemon) || !validNonceProof(value.nonce) || !validNonceProof(value.proof)) {
    throw runnerFailure("Windows session host hello is invalid", "bad_hello");
  }
  return value as unknown as SessionHostHello;
}

function strictCommand(value: SessionHostWireMessage, manifest: WindowsSessionHostManifest): SessionHostCommand {
  if (!isObject(value) || !hasOnlyKeys(value, ["version", "type", "sessionId", "epoch", "commandId", "leaseId", "mutation", "method", "params"]) ||
    value.type !== "command" || value.version !== 2 || value.sessionId !== manifest.sessionId ||
    value.epoch !== manifest.epoch || !validCommandId(value.commandId) || typeof value.mutation !== "boolean" ||
    typeof value.method !== "string" || value.method.length === 0 || value.method.length > 160 ||
    (value.leaseId !== undefined && !validCommandId(value.leaseId))) {
    throw runnerFailure("Windows session host command is invalid", "bad_command");
  }
  return value as unknown as SessionHostCommand;
}

function strictReplay(value: SessionHostWireMessage, manifest: WindowsSessionHostManifest): SessionHostReplayRequest {
  if (!isObject(value) || !hasOnlyKeys(value, ["version", "type", "sessionId", "epoch", "afterSeq"]) ||
    value.type !== "replay" || value.version !== 2 || value.sessionId !== manifest.sessionId ||
    value.epoch !== manifest.epoch || typeof value.afterSeq !== "number" || !Number.isSafeInteger(value.afterSeq) || value.afterSeq < 0) {
    throw runnerFailure("Windows session host replay request is invalid", "bad_replay");
  }
  return value as unknown as SessionHostReplayRequest;
}

function resultFromRecord(record: WindowsSessionHostJournalEvent): CommandLedgerEntry | null {
  if ((record.kind !== "command" && record.kind !== "terminal") || !record.commandId || !isObject(record.payload)) return null;
  const payload = record.payload;
  if (typeof payload.ok !== "boolean") return null;
  const reply: SessionHostReply = {
    version: 2, type: "reply", commandId: record.commandId, ok: payload.ok,
    seq: record.seq,
    ...(payload.ok ? { result: payload.result } : {
      error: {
        code: typeof payload.code === "string" ? payload.code : "command_failed",
        message: typeof payload.message === "string" ? payload.message : "Windows session host command failed",
      },
    }),
  };
  return { commandId: record.commandId, reply };
}

/**
 * Stateful host core, exportable independently of the actual pipe loop for
 * mock-native process tests. It never performs host launch or owner recovery.
 */
export class WindowsSessionHostRunner {
  private readonly journal: WindowsSessionHostJournal;
  private readonly commandLedger = new Map<string, SessionHostReply>();
  /** A crash after kill intent but before terminal result must never retry it. */
  private readonly killRequested = new Set<string>();
  /**
   * Job termination is destructive to this host, so a vertical supplies it
   * only after its terminal record is durable. The transport invokes it after
   * attempting the synchronous reply; a failed reply still finalizes it.
   */
  private readonly terminalFinalizers = new Map<string, () => Promise<void>>();
  private readonly terminalFinalizing = new Set<string>();
  private connection: AuthenticatedConnection | null = null;
  private lease: MutationLease | null = null;
  private snapshot: WindowsSessionHostSnapshot | null = null;
  private events: WindowsSessionHostJournalEvent[] = [];
  private lastSeq = 0;
  private terminal = false;
  private loaded = false;
  private compactionDeferred = false;
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly readOnlyMethods: ReadonlySet<string>;

  constructor(
    readonly manifest: WindowsSessionHostManifest,
    private readonly native: Pick<WindowsSessionHostRunnerNative, "hmac"> & {
      read(fileName: string): Promise<Uint8Array | null>;
      writeAtomic(fileName: string, bytes: Uint8Array): Promise<void>;
    },
    private readonly handler: WindowsSessionHostCommandHandler,
    private readonly leaseDurationMs = DEFAULT_LEASE_MS,
    readOnlyMethods: readonly string[] = [],
  ) {
    if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000 || leaseDurationMs > 60_000) {
      throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows session host lease duration is invalid");
    }
    if (!readOnlyMethods.every((method) => typeof method === "string" && method.length > 0 && method.length <= 160)) {
      throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows session host read-only method policy is invalid");
    }
    this.readOnlyMethods = new Set(readOnlyMethods);
    this.journal = new WindowsSessionHostJournal(native, manifest.sessionId, manifest.epoch);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const recovered = await this.journal.load();
    this.snapshot = recovered.snapshot;
    this.events = [...recovered.events];
    this.lastSeq = recovered.lastSeq;
    this.terminal = recovered.terminal || this.manifest.status === "terminal";
    for (const command of recovered.snapshot?.commands ?? []) this.commandLedger.set(command.commandId, command.reply);
    for (const event of recovered.events) {
      const entry = resultFromRecord(event);
      if (entry) this.commandLedger.set(entry.commandId, entry.reply);
      if (event.commandId && isObject(event.payload) && event.payload.type === "structured.kill_requested") {
        this.killRequested.add(event.commandId);
        this.terminal = true;
      }
    }
    this.loaded = true;
    // A cut-off final frame carries no CRC-protected outcome. Snapshot the
    // validated prefix before accepting any new mutation; never replay it.
    if (recovered.crashTail) await this.compact();
  }

  async acceptHello(value: SessionHostWireMessage, peer: PipePeerIdentity | null): Promise<SessionHostWelcome> {
    await this.load();
    const hello = strictHello(value, this.manifest);
    if (!strictPeer(peer) || !processIdentityEquals(peer.process, hello.daemon)) {
      throw new WindowsSessionHostUnavailable("identity_mismatch", "Native pipe peer PID/FILETIME does not match daemon hello");
    }
    const expected = await this.native.hmac(helloProofMaterial({
      sessionId: hello.sessionId, epoch: hello.epoch, daemon: hello.daemon, nonce: hello.nonce,
    }));
    if (!proofEquals(expected, hello.proof)) {
      throw new WindowsSessionHostUnavailable("acl_unverified", "Windows session host capability proof is invalid");
    }
    this.connection = { daemon: hello.daemon, peer };
    const unsigned = {
      sessionId: this.manifest.sessionId, epoch: this.manifest.epoch, host: this.manifest.owner,
      terminal: this.terminal, lastSeq: this.lastSeq,
    };
    return {
      version: 2, type: "welcome", ...unsigned,
      proof: await this.native.hmac(welcomeProofMaterial(unsigned, hello.nonce)),
    };
  }

  async command(value: SessionHostWireMessage): Promise<SessionHostReply> {
    return this.serialize(() => this.commandUnlocked(value));
  }

  /**
   * Called by the pipe loop after it has either written the exact reply or
   * learned that the connection is gone. Terminal state is already durable at
   * this point, so a lost reply is recovered from the command ledger rather
   * than becoming permission to leave a provider tree alive.
   */
  async replyDelivered(commandId: string): Promise<void> {
    await this.finalizeTerminal(commandId);
  }

  /**
   * Durable host-side output API.  It shares the command serialization chain,
   * so PTY/structured output cannot overtake a command result or reuse a
   * sequence.  A terminal event is an explicit one-way fence.
   */
  async appendEvent(payload: unknown, options: WindowsSessionHostAppendEventOptions = {}): Promise<WindowsSessionHostJournalEvent> {
    return this.serialize(() => this.appendEventUnlocked(payload, options));
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release!: () => void;
    this.mutationChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }

  async replay(value: SessionHostWireMessage): Promise<SessionHostReplayReply> {
    await this.load();
    this.requireConnection();
    const request = strictReplay(value, this.manifest);
    if (request.afterSeq > this.lastSeq) {
      throw runnerFailure("Windows session host replay cursor is beyond the durable watermark", "bad_cursor");
    }
    const snapshotSeq = this.snapshot?.lastSeq ?? 0;
    const gap = request.afterSeq < snapshotSeq;
    return {
      version: 2, type: "replay", sessionId: this.manifest.sessionId, epoch: this.manifest.epoch,
      afterSeq: request.afterSeq, lastSeq: this.lastSeq, gap, terminal: this.terminal,
      snapshot: gap ? this.snapshot : null,
      events: this.events.filter((event) => event.seq > request.afterSeq),
    };
  }

  detachConnection(): void {
    // A daemon socket loss deliberately does not kill the host or clear lease.
    // Its bounded expiry prevents a second daemon from mutating concurrently.
    this.connection = null;
  }

  private async commandUnlocked(value: SessionHostWireMessage): Promise<SessionHostReply> {
    await this.load();
    const connection = this.requireConnection();
    let command: SessionHostCommand;
    try { command = strictCommand(value, this.manifest); }
    catch (error) {
      const commandId = isObject(value) && validCommandId(value.commandId) ? value.commandId : "invalid";
      const known = error as Partial<{ code: string; message: string }>;
      return this.reject(commandId, known.code ?? "bad_command", known.message ?? "Windows session host command is invalid");
    }
    const prior = this.commandLedger.get(command.commandId);
    if (prior) return prior;
    if (this.killRequested.has(command.commandId)) {
      return this.reject(command.commandId, "reconciliation_required", "Windows Session Host has a durable kill intent with no terminal result; reconciliation is required");
    }
    // A terminal owner is immutable, not opaque.  Daemons reconnecting after
    // an explicit kill must replay/read its final durable state without first
    // acquiring a mutation lease; only the server-declared read-only surface
    // remains available.
    if (this.terminal && !this.readOnlyMethods.has(command.method)) {
      return this.reject(command.commandId, "terminal_fence", "Windows session host has an explicit terminal fence");
    }
    if (command.method === "lease.acquire") return this.acquireLease(command, connection);
    // The client-provided `mutation` bit is compatibility metadata only.
    // Every handler command needs the single daemon lease unless this runner's
    // explicit server-side policy lists it as read-only.
    if (!this.readOnlyMethods.has(command.method)) {
      try { this.requireLease(command, connection); }
      catch (error) {
        const known = error as Partial<{ code: string; message: string }>;
        return this.reject(command.commandId, known.code ?? "lease_required", known.message ?? "Windows session host mutation lease is required");
      }
    }
    if (command.method === "structured.kill") {
      // The intent is durable before any provider cancellation/Job action.
      // If this append fails, nothing below is allowed to touch the tree.
      let intent: WindowsSessionHostJournalEvent;
      try {
        intent = await this.journal.append({
          kind: "event", commandId: command.commandId,
          payload: { type: "structured.kill_requested" },
        });
      } catch {
        return this.fenceUnknownOutcome(command.commandId);
      }
      this.killRequested.add(command.commandId);
      this.events.push(intent);
      this.lastSeq = intent.seq;
    }
    let outcome: WindowsSessionHostCommandOutcome;
    try {
      outcome = await this.handler.handleCommand({ commandId: command.commandId, method: command.method, params: command.params });
    } catch {
      // An uncaught provider exception has unknown external outcome. Fence the
      // owner instead of rerunning the same command after a daemon restart.
      outcome = { ok: false, code: "unknown_command_outcome", message: "Windows session host command outcome is unknown", terminal: true };
    }
    if (command.method === "structured.kill" && outcome.terminal !== true) {
      // A rejected/failed kill after its intent is durable is itself an
      // unresolved tree state. Fence the owner for reconciliation.
      outcome = { ...outcome, terminal: true };
    }
    if (outcome.terminal === true && outcome.afterReply) {
      // Retain containment before any terminal append/compaction. If either
      // write fails, this callback is still the fail-closed cleanup path.
      this.terminalFinalizers.set(command.commandId, outcome.afterReply);
    }
    if (outcome.terminal === true && outcome.terminalStateReady === false) {
      await this.finalizeTerminal(command.commandId);
      return this.fenceUnknownOutcome(command.commandId);
    }
    let record: WindowsSessionHostJournalEvent;
    try {
      record = await this.journal.append({
        kind: outcome.terminal ? "terminal" : "command", commandId: command.commandId,
        payload: outcome.ok ? { ok: true, result: outcome.result } : { ok: false, code: outcome.code, message: outcome.message },
      });
    } catch {
      // The handler may have completed an external effect. Without a durable
      // result we can never safely execute this command again in this owner.
      await this.finalizeTerminal(command.commandId);
      return this.fenceUnknownOutcome(command.commandId);
    }
    const reply: SessionHostReply = outcome.ok
      ? { version: 2, type: "reply", commandId: command.commandId, ok: true, result: outcome.result, seq: record.seq }
      : { version: 2, type: "reply", commandId: command.commandId, ok: false, error: { code: outcome.code, message: outcome.message }, seq: record.seq };
    this.commandLedger.set(command.commandId, reply);
    this.events.push(record);
    this.lastSeq = record.seq;
    this.terminal ||= outcome.terminal === true;
    if (outcome.terminal === true) {
      try {
        // Terminal compaction and the terminal manifest are part of the
        // durable commit, not a best-effort optimization. A Job finalizer may
        // kill this host immediately after reply, so recovery needs this one
        // bounded, complete reducer image first.
        await this.commitTerminal(outcome.snapshotState);
      } catch {
        // There is no successful terminal reply without its durable state.
        // Fail closed by starting Job containment immediately; the retry is
        // scheduled if native close itself transiently fails.
        await this.finalizeTerminal(command.commandId);
        return this.fenceUnknownOutcome(command.commandId);
      }
    } else {
      await this.maybeCompact(outcome.snapshotState, false);
    }
    return reply;
  }

  private async appendEventUnlocked(payload: unknown, options: WindowsSessionHostAppendEventOptions): Promise<WindowsSessionHostJournalEvent> {
    await this.load();
    if (this.terminal) {
      throw new WindowsSessionHostUnavailable("terminal_fence", "Windows session host has an explicit terminal fence");
    }
    let record: WindowsSessionHostJournalEvent;
    try {
      record = await this.journal.append({ kind: options.terminal ? "terminal" : "event", payload });
    } catch {
      // An output or interaction may already have been externally observed.
      // Continuing without a durable cursor could duplicate it after attach.
      this.terminal = true;
      throw new WindowsSessionHostUnavailable("terminal_fence", "Windows session host event outcome is not durable; owner is fenced");
    }
    this.events.push(record);
    this.lastSeq = record.seq;
    this.terminal ||= options.terminal === true;
    await this.maybeCompact(options.snapshotState, options.terminal === true);
    return record;
  }

  private async acquireLease(command: SessionHostCommand, connection: AuthenticatedConnection): Promise<SessionHostReply> {
    if (command.leaseId !== undefined) return this.reject(command.commandId, "bad_lease", "Mutation lease acquire is malformed");
    const now = Date.now();
    if (this.lease && this.lease.expiresAt <= now) this.lease = null;
    if (this.lease && !processIdentityEquals(this.lease.daemon, connection.daemon)) {
      return this.reject(command.commandId, "lease_held", "A different daemon holds the mutation lease");
    }
    if (!this.lease) this.lease = { id: randomUUID(), daemon: connection.daemon, expiresAt: now + this.leaseDurationMs };
    else this.lease.expiresAt = now + this.leaseDurationMs;
    let record: WindowsSessionHostJournalEvent;
    try {
      record = await this.journal.append({ kind: "command", commandId: command.commandId, payload: { ok: true, result: { leaseId: this.lease.id } } });
    } catch {
      return this.fenceUnknownOutcome(command.commandId);
    }
    const reply: SessionHostReply = { version: 2, type: "reply", commandId: command.commandId, ok: true, result: { leaseId: this.lease.id }, seq: record.seq };
    this.commandLedger.set(command.commandId, reply);
    this.events.push(record);
    this.lastSeq = record.seq;
    return reply;
  }

  private requireLease(command: SessionHostCommand, connection: AuthenticatedConnection): void {
    const now = Date.now();
    if (!this.lease || this.lease.expiresAt <= now) {
      this.lease = null;
      throw runnerFailure("Windows session host mutation lease is absent or expired", "lease_required");
    }
    if (command.leaseId !== this.lease.id || !processIdentityEquals(this.lease.daemon, connection.daemon)) {
      throw runnerFailure("Windows session host mutation lease belongs to a different daemon", "lease_held");
    }
    this.lease.expiresAt = now + this.leaseDurationMs;
  }

  private reject(commandId: string, code: string, message: string): SessionHostReply {
    return { version: 2, type: "reply", commandId, ok: false, error: { code, message }, seq: this.lastSeq };
  }

  private fenceUnknownOutcome(commandId: string): SessionHostReply {
    this.terminal = true;
    const reply = this.reject(commandId, "unknown_command_outcome", "Windows session host durable outcome is unavailable; owner is fenced");
    this.commandLedger.set(commandId, reply);
    return reply;
  }

  private requireConnection(): AuthenticatedConnection {
    if (!this.connection) throw runnerFailure("Windows session host has no authenticated daemon connection", "not_authenticated");
    return this.connection;
  }

  private async compact(overrideState?: unknown): Promise<void> {
    const state = overrideState === undefined ? await this.handler.snapshotState?.() : overrideState;
    const commands = [...this.commandLedger.entries()].map(([commandId, reply]) => ({ commandId, reply }));
    this.snapshot = await this.journal.compact(state ?? null, commands);
    this.events = [];
    this.lastSeq = this.snapshot.lastSeq;
    this.compactionDeferred = false;
  }

  private async commitTerminal(overrideState?: unknown): Promise<void> {
    await this.compact(overrideState);
    const manifest = parseWindowsSessionHostManifest({
      ...this.manifest,
      status: "terminal",
      updatedAt: Date.now(),
    });
    await this.native.writeAtomic("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  }

  /**
   * Compaction is an optimization only.  Once append returned, PSJ2 already
   * owns the result; a snapshot write failure must not make a caller replay an
   * output or terminal action.  Future mutations/restart can retry safely.
   */
  private async maybeCompact(overrideState: unknown, force: boolean): Promise<void> {
    if (!force && this.events.length < COMPACTION_EVENT_LIMIT && !this.compactionDeferred) return;
    if (force) {
      await this.compact(overrideState);
      return;
    }
    try { await this.compact(overrideState); }
    catch { this.compactionDeferred = true; }
  }

  private async finalizeTerminal(commandId: string): Promise<void> {
    const finalizer = this.terminalFinalizers.get(commandId);
    if (!finalizer || this.terminalFinalizing.has(commandId)) return;
    this.terminalFinalizing.add(commandId);
    this.terminalFinalizers.delete(commandId);
    try {
      await finalizer();
    } catch {
      // Terminal manifest + snapshot already fence all mutations. Keep the
      // still-live owner trying to close its Job; there is intentionally no
      // PID/taskkill escape hatch or replacement owner.
      this.terminalFinalizers.set(commandId, finalizer);
      const retry = setTimeout(() => {
        this.terminalFinalizing.delete(commandId);
        void this.finalizeTerminal(commandId);
      }, 100);
      retry.unref?.();
      return;
    }
    this.terminalFinalizing.delete(commandId);
  }
}

export interface RunningWindowsSessionHost {
  readonly manifest: WindowsSessionHostManifest;
  readonly runner: WindowsSessionHostRunner;
  /** Stops only transport worker/pipe; callers choose explicit terminal command. */
  closeTransport(): Promise<void>;
}

interface StartableRunningWindowsSessionHost extends RunningWindowsSessionHost {
  /** Begins the blocking native accept loop exactly once. */
  startTransport(): void;
}

/**
 * Starts a new owner only when explicitly called by a vertical's creation
 * flow. Recovery must use `WindowsSessionHostClient.attach`, never this API.
 */
export async function startWindowsSessionHost(options: StartWindowsSessionHostOptions): Promise<RunningWindowsSessionHost> {
  if (process.env[DETACHED_RUNNER_ENV] !== options.stateDirectory) {
    throw new WindowsSessionHostUnavailable("native_unavailable", "Windows session host may only start inside the native detached runner; daemon-side replacement is forbidden");
  }
  const native = await WindowsSessionHostNativeWorker.create();
  return startWindowsSessionHostWithNative(options, native);
}

async function startWindowsSessionHostWithNative(
  options: StartWindowsSessionHostOptions,
  native: WindowsSessionHostRunnerNative,
  closeOnFailure = true,
  deferTransport = false,
): Promise<StartableRunningWindowsSessionHost> {
  assertSessionId(options.sessionId);
  assertEpoch(options.epoch);
  assertSecureWindowsPipeName(options.pipeName);
  if (typeof options.stateDirectory !== "string" || options.stateDirectory.length === 0) {
    throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows session host state directory is invalid");
  }
  try {
    await native.openState(options.stateDirectory);
    if (await native.read("manifest.json") !== null) {
      throw new WindowsSessionHostUnavailable("native_unavailable", "Windows session host manifest already exists; replacement spawn is forbidden");
    }
    const entropy = sessionEpochEntropy(options.sessionId, options.epoch);
    await native.createCredential(entropy);
    const owner = await native.currentIdentity();
    await native.createPipe(options.pipeName);
    const now = options.createdAt ?? Date.now();
    const manifest = parseWindowsSessionHostManifest({
      schemaVersion: 2, protocolVersion: 2, implementation: "windows-session-host",
      sessionId: options.sessionId, epoch: options.epoch, pipeName: options.pipeName, stateDirectory: options.stateDirectory,
      aclProfile: "current-logon-token-v1", owner, nativeAbiVersion: NATIVE_WINDOWS_ABI_VERSION,
      credentialFile: "credential.dpapi", journalFile: "journal.psj2", snapshotFile: "snapshot.psj2.json",
      status: "active", createdAt: now, updatedAt: now,
    });
    // Atomic native state write verifies directory ACL/reparse safety. The
    // manifest intentionally has no raw secret and no SID trust input.
    await native.writeAtomic("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
    const runner = new WindowsSessionHostRunner(manifest, native, options.handler, options.leaseDurationMs, options.readOnlyMethods);
    await runner.load();
    let stopping = false;
    let serving: Promise<void> | null = null;
    let closePromise: Promise<void> | null = null;
    const running: StartableRunningWindowsSessionHost = {
      manifest,
      runner,
      startTransport: () => {
        if (stopping || serving !== null) return;
        serving = serveWindowsSessionHostPipe(native, runner, () => stopping);
      },
      closeTransport: async () => {
        if (closePromise) return closePromise;
        stopping = true;
        closePromise = stopWindowsSessionHostTransport(native, serving ?? Promise.resolve(), options.pipeName);
        return closePromise;
      },
    };
    if (!deferTransport) running.startTransport();
    return running;
  } catch (error) {
    if (closeOnFailure) await native.close?.();
    throw error;
  }
}

function parseDetachedBootstrap(value: unknown, expectedStateDirectory: string): DetachedRunnerBootstrap {
  if (!isObject(value) || !hasOnlyKeys(value, [
    "schemaVersion", "implementation", "sessionId", "epoch", "pipeName", "stateDirectory", "handlerModule", "createdAt", "leaseDurationMs", "readOnlyMethods", "handlerOptions",
  ]) || value.schemaVersion !== 2 || value.implementation !== "windows-session-host-runner" ||
    typeof value.sessionId !== "string" || typeof value.epoch !== "string" || typeof value.pipeName !== "string" ||
    value.stateDirectory !== expectedStateDirectory || typeof value.handlerModule !== "string" ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.leaseDurationMs !== undefined && (typeof value.leaseDurationMs !== "number" || !Number.isSafeInteger(value.leaseDurationMs) || value.leaseDurationMs < 1_000 || value.leaseDurationMs > 60_000)) ||
    (value.readOnlyMethods !== undefined && (!Array.isArray(value.readOnlyMethods) || !value.readOnlyMethods.every((method) => typeof method === "string")))) {
    throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows detached runner bootstrap is invalid");
  }
  assertSessionId(value.sessionId);
  assertEpoch(value.epoch);
  assertSecureWindowsPipeName(value.pipeName);
  let url: URL;
  try { url = new URL(value.handlerModule); } catch { throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows detached runner handler module is invalid"); }
  if (url.protocol !== "file:" || !isAbsolute(fileURLToPath(url))) {
    throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows detached runner handler module must be an absolute file URL");
  }
  return value as unknown as DetachedRunnerBootstrap;
}

/** Atomically consume the one-use detached launch record from secure state. */
export async function consumeDetachedWindowsSessionHostBootstrap(
  native: Pick<WindowsSessionHostRunnerNative, "read" | "removeState">,
  stateDirectory: string,
): Promise<DetachedRunnerBootstrap> {
  const bytes = await native.read(DETACHED_BOOTSTRAP_FILE);
  if (bytes === null) throw new WindowsSessionHostUnavailable("native_unavailable", "Windows detached runner bootstrap is missing");
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows detached runner bootstrap JSON is invalid"); }
  const bootstrap = parseDetachedBootstrap(raw, stateDirectory);
  if (await native.read("manifest.json") !== null) {
    throw new WindowsSessionHostUnavailable("native_unavailable", "Windows detached host manifest already exists; replacement spawn is forbidden");
  }
  // Secure-state removal is the one-time claim. Any later entry sees missing
  // bootstrap (or an already-published manifest) and must not spawn.
  await native.removeState(DETACHED_BOOTSTRAP_FILE);
  return bootstrap;
}

export interface WindowsSessionHostNativeFactory {
  create(): Promise<WindowsSessionHostRunnerNative & { close(): Promise<void> }>;
}

/** Native surface used by launch/rollback tests as well as production. */
export interface WindowsSessionHostDetachedLaunchNative extends Pick<
  WindowsSessionHostRunnerNative,
  "openState" | "read" | "writeAtomic" | "removeState"
> {
  launchDetachedHost(options: DetachedHostLaunchOptions): Promise<DetachedHostLaunchResult>;
  /** Exact PID+FILETIME termination followed by a bounded native wait. */
  terminateIdentityAndWait(identity: ProcessIdentity, exitCode?: number, timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Only this tag authorizes SessionManager's non-durable direct-PTY fallback. */
interface PreHostNativeUnavailable {
  readonly preHostNativeUnavailable: true;
}

export function isPreHostNativeUnavailable(error: unknown): error is Error & PreHostNativeUnavailable {
  return error instanceof Error && (error as Partial<PreHostNativeUnavailable>).preHostNativeUnavailable === true;
}

function markPreHostNativeUnavailable(error: unknown): Error & PreHostNativeUnavailable {
  const failure = error instanceof Error ? error : new Error("Windows native binding is unavailable");
  Object.defineProperty(failure, "preHostNativeUnavailable", { value: true, enumerable: false });
  return failure as Error & PreHostNativeUnavailable;
}

/**
 * Entry used only by the separately launched host process. Bootstrap data is
 * read through the native ACL/reparse-safe state API and contains no secret;
 * the host creates its DPAPI credential after it owns the detached process.
 */
export async function runDetachedWindowsSessionHostFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  nativeFactory: WindowsSessionHostNativeFactory = WindowsSessionHostNativeWorker,
): Promise<RunningWindowsSessionHost> {
  const stateDirectory = environment[DETACHED_RUNNER_ENV];
  if (typeof stateDirectory !== "string" || stateDirectory.length === 0) {
    throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows detached runner state directory is missing");
  }
  const native = await nativeFactory.create();
  writeDetachedTestDiagnostic(environment, "runner_native_created");
  let stage: DetachedStartupStage = "opening_state";
  let stateOpened = false;
  try {
    await native.openState(stateDirectory);
    writeDetachedTestDiagnostic(environment, "runner_state_opened");
    stateOpened = true;
    stage = "claiming_bootstrap";
    const bootstrap = await consumeDetachedWindowsSessionHostBootstrap(native, stateDirectory);
    writeDetachedTestDiagnostic(environment, "runner_bootstrap_claimed");
    // This is deliberately before importing a vertical handler, constructing
    // an adapter, creating a pipe, or starting a session. Once the detached
    // owner joins this KILL_ON_JOB_CLOSE Job, every ordinary child and
    // grandchild inherits it. No provider needs a post-spawn assignment.
    if (!native.createProviderJob || !native.assignProviderProcess || !native.isProviderProcessInJob) {
      throw new WindowsSessionHostUnavailable("native_capability_missing", "Windows native host-in-Job APIs are unavailable");
    }
    stage = "creating_provider_job";
    await native.createProviderJob();
    writeDetachedTestDiagnostic(environment, "runner_job_created");
    let providerJob: NativeWindowsSessionHostProviderJob | null = null;
    try {
      stage = "resolving_owner";
      const owner = await native.currentIdentity();
      writeDetachedTestDiagnostic(environment, "runner_owner_resolved");
      stage = "assigning_owner_job";
      await native.assignProviderProcess(owner);
      writeDetachedTestDiagnostic(environment, "runner_owner_assigned");
      stage = "auditing_owner_job";
      if (!await native.isProviderProcessInJob(owner)) {
        throw new WindowsSessionHostUnavailable("provider_job_incompatible", "Windows detached Session Host did not join its own Job");
      }
      writeDetachedTestDiagnostic(environment, "runner_job_audited");
      providerJob = new NativeWindowsSessionHostProviderJob(native);
    } catch (error) {
      // Record the stage before closing a partially assigned KILL_ON_JOB_CLOSE
      // Job: if self-assignment succeeded, the close terminates this process.
      await writeDetachedStartupFailure(native, error, stage);
      // If self-assignment raced only partway through, close is itself the
      // KILL_ON_JOB_CLOSE containment action. There is no PID fallback.
      await native.closeProviderJob?.().catch(() => {});
      throw error;
    }
    stage = "importing_handler";
    const factory = (await import(bootstrap.handlerModule)) as Partial<WindowsSessionHostHandlerFactory>;
    writeDetachedTestDiagnostic(environment, "runner_handler_imported");
    if (typeof factory.createWindowsSessionHostHandler !== "function") {
      throw new WindowsSessionHostUnavailable("native_unavailable", "Windows detached runner handler factory is unavailable");
    }
    const deferredHandler = new DeferredCommandHandler();
    const sink = new DeferredAppendEventSink();
    const createProviderJob = async (): Promise<WindowsSessionHostProviderJob> => {
      if (!providerJob) {
        throw new WindowsSessionHostUnavailable("native_unavailable", "Windows detached Session Host Job is unavailable");
      }
      return providerJob;
    };
    // Start provider construction concurrently with common runner creation.
    // A factory may await appendEvent immediately; the deferred sink waits for
    // the runner without making the startup path await that factory first.
    const consumeProviderBootstrap = async (): Promise<Uint8Array> => {
      const bytes = await native.read(PROVIDER_BOOTSTRAP_FILE);
      if (bytes === null) {
        throw new WindowsSessionHostUnavailable("native_unavailable", "Windows detached provider bootstrap is missing or was already consumed");
      }
      await native.removeState(PROVIDER_BOOTSTRAP_FILE);
      return bytes;
    };
    let handlerFailure: Error | null = null;
    let factoryHandler: WindowsSessionHostCommandHandler | null = null;
    stage = "starting_handler";
    const handlerPromise: Promise<WindowsSessionHostCommandHandler | null> = Promise.resolve()
      .then(() => factory.createWindowsSessionHostHandler!({
        sessionId: bootstrap.sessionId, epoch: bootstrap.epoch, stateDirectory,
        appendEvent: (payload, options) => sink.appendEvent(payload, options),
        emit: (payload, options) => sink.appendEvent(payload, options),
        createProviderJob,
        consumeProviderBootstrap,
        ...(bootstrap.handlerOptions === undefined ? {} : { handlerOptions: bootstrap.handlerOptions }),
      }))
      .then((handler) => {
        writeDetachedTestDiagnostic(environment, "runner_handler_created");
        factoryHandler = handler;
        return handler;
      })
      // Convert this concurrent startup failure into data immediately. The
      // surrounding startup path will close the host Job, but a detached
      // factory rejection must never temporarily become unhandled.
      .catch((error): null => {
        handlerFailure = error instanceof Error ? error : new Error(String(error));
        return null;
      });
    let running: StartableRunningWindowsSessionHost | null = null;
    try {
      stage = "starting_common_host";
      writeDetachedTestDiagnostic(environment, "runner_common_starting");
      running = await startWindowsSessionHostWithNative({
        sessionId: bootstrap.sessionId, epoch: bootstrap.epoch, pipeName: bootstrap.pipeName, stateDirectory,
        handler: deferredHandler, createdAt: bootstrap.createdAt,
        ...(bootstrap.leaseDurationMs === undefined ? {} : { leaseDurationMs: bootstrap.leaseDurationMs }),
        ...(bootstrap.readOnlyMethods === undefined ? {} : { readOnlyMethods: bootstrap.readOnlyMethods }),
      }, native, false, true);
      writeDetachedTestDiagnostic(environment, "runner_common_started");
      sink.bind(running.runner);
      stage = "starting_handler";
      const handler = await handlerPromise;
      if (!handler || typeof handler.handleCommand !== "function") {
        throw handlerFailure ?? new WindowsSessionHostUnavailable("native_unavailable", "Windows detached runner handler is invalid");
      }
      deferredHandler.bind(handler);
      writeDetachedTestDiagnostic(environment, "runner_handler_bound");
      stage = "publishing_ready";
      await native.writeAtomic(DETACHED_READY_FILE, new TextEncoder().encode(JSON.stringify({ version: 1, ready: true })));
      writeDetachedTestDiagnostic(environment, "runner_ready_published");
      running.startTransport();
      return running;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await writeDetachedStartupFailure(native, failure, stage);
      deferredHandler.fail(failure);
      sink.fail(failure);
      // startWindowsSessionHostWithNative can fail while an asynchronous
      // provider factory is still creating ConPTY/its Job. Dispose both an
      // already-resolved handler and one that resolves after this catch.
      const handlerForCleanup = factoryHandler as WindowsSessionHostCommandHandler | null;
      if (handlerForCleanup?.dispose) await Promise.resolve(handlerForCleanup.dispose()).catch(() => {});
      void handlerPromise.then((handler) => handler?.dispose?.()).catch(() => {});
      // Do this while the state worker is still open. closeTransport() closes
      // that worker as its final containment action.
      await native.removeState(PROVIDER_BOOTSTRAP_FILE).catch(() => {});
      if (running) {
        // The provider can own a live ConPTY/Job before its factory's promise
        // rejects.  Dispose it before closing transport so startup failure
        // never leaves a provider tree attached to an orphaned host.
        await deferredHandler.dispose().catch(() => {});
        try {
          await native.writeAtomic("manifest.json", new TextEncoder().encode(JSON.stringify({
            ...running.manifest,
            status: "failed",
            updatedAt: Date.now(),
          })));
        } catch { /* native close below is still mandatory */ }
        await running.closeTransport().catch(() => {});
      }
      // The factory runs asynchronously and may have allocated the Job while
      // this lexical startup path was awaiting runner creation.
      await providerJob?.close().catch(() => {});
      throw failure;
    }
  } catch (error) {
    if (stateOpened) await writeDetachedStartupFailure(native, error, stage);
    await native.close();
    throw error;
  }
}

function runnerEnvironment(
  stateDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  // Keep provider/API credentials out of the detached host environment, but
  // retain the Windows runtime/profile locations required by Authenticode,
  // DPAPI, PowerShell and Node when the daemon is running as a service user.
  const inherited = [
    "SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH", "PATHEXT",
    "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "LOCALAPPDATA", "APPDATA", "ProgramData", "ProgramFiles",
    "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles",
    "CommonProgramFiles(x86)", "CommonProgramW6432",
  ] as const;
  const sourceEntries = Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const runtimeEnvironment: Record<string, string> = {};
  for (const canonicalName of inherited) {
    // A worker-thread environment copy is case-sensitive even on Windows,
    // while the OS environment is not. Canonicalize exactly one match and
    // fail closed by omitting ambiguous case variants.
    const matches = sourceEntries.filter(([name]) => name.toLowerCase() === canonicalName.toLowerCase());
    if (matches.length === 1) runtimeEnvironment[canonicalName] = matches[0]![1];
  }
  return {
    ...runtimeEnvironment,
    ...(sourceEntries.filter(([name, value]) => name.toLowerCase() === SIGNED_SESSION_HOST_TEST_ENV.toLowerCase() && value === "1").length === 1
      ? {
          [SIGNED_SESSION_HOST_TEST_ENV]: "1",
          [DETACHED_TEST_DIAGNOSTIC_ENV]: `${stateDirectory}.entry-diagnostic.json`,
        }
      : {}),
    [DETACHED_RUNNER_ENV]: stateDirectory,
  };
}

async function waitForDetachedManifest(
  native: Pick<WindowsSessionHostDetachedLaunchNative, "read">,
  expected: { sessionId: string; epoch: string; process: ProcessIdentity; testDiagnosticPath?: string },
  timeoutMs = 8_000,
): Promise<WindowsSessionHostManifest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const failed = await native.read(DETACHED_FAILED_FILE);
    if (failed !== null) {
      try {
        const value: unknown = JSON.parse(new TextDecoder().decode(failed));
        if (isObject(value) && value.version === 1) {
          const suffix = isDetachedStartupStage(value.stage) ? ` during ${value.stage}` : "";
          if (value.code === "provider_job_incompatible") {
            throw new WindowsSessionHostUnavailable("provider_job_incompatible", `Windows provider is incompatible with the required Session Job${suffix}`);
          }
          if (value.code === "native_unavailable") {
            throw new WindowsSessionHostUnavailable("native_unavailable", `Windows detached host failed before becoming ready${suffix}`);
          }
        }
      } catch (error) {
        if (error instanceof WindowsSessionHostUnavailable) throw error;
      }
      throw new WindowsSessionHostUnavailable("native_unavailable", "Windows detached host failed before becoming ready");
    }
    const bytes = await native.read("manifest.json");
    if (bytes !== null) {
      let value: unknown;
      try { value = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows detached host manifest JSON is invalid"); }
      const manifest = parseWindowsSessionHostManifest(value);
      if (manifest.sessionId !== expected.sessionId || manifest.epoch !== expected.epoch || !processIdentityEquals(manifest.owner, expected.process)) {
        throw new WindowsSessionHostUnavailable("identity_mismatch", "Windows detached host manifest owner does not match native launch identity");
      }
      if (await native.read(DETACHED_READY_FILE) !== null) return manifest;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  // CreateProcessW has already succeeded. This is an ambiguous post-launch
  // failure, not a missing native binding and therefore never a direct-PTY
  // downgrade signal.
  const bootstrapClaimed = await native.read(DETACHED_BOOTSTRAP_FILE) === null;
  const manifestPublished = await native.read("manifest.json") !== null;
  const readyPublished = await native.read(DETACHED_READY_FILE) !== null;
  const stage = !bootstrapClaimed
    ? "before_bootstrap_claim"
    : !manifestPublished
      ? "after_bootstrap_claim"
      : !readyPublished
        ? "after_manifest_publish"
        : "after_ready_publish";
  let diagnostic = "";
  if (expected.testDiagnosticPath) {
    try {
      const value: unknown = JSON.parse(readFileSync(expected.testDiagnosticPath, "utf8"));
      if (isObject(value) && typeof value.stage === "string" && /^[a-z_]{1,64}$/.test(value.stage)) {
        const message = typeof value.message === "string" ? value.message.slice(0, 320) : "";
        diagnostic = `; test_entry=${value.stage}${message ? `:${message}` : ""}`;
      }
    } catch { /* CI-only sibling diagnostic is advisory */ }
  }
  throw new WindowsSessionHostUnavailable("launch_failed", `Windows detached host did not publish a verified manifest (${stage}${diagnostic})`);
}

async function removeDetachedBootstrapState(
  native: Pick<WindowsSessionHostDetachedLaunchNative, "removeState">,
  includeRecord: boolean,
): Promise<void> {
  const names = [DETACHED_BOOTSTRAP_FILE, PROVIDER_BOOTSTRAP_FILE] as const;
  await Promise.all(names.map(async (name) => { await native.removeState(name).catch(() => {}); }));
  if (includeRecord) await native.removeState(PROVIDER_RECORD_FILE).catch(() => {});
}

/**
 * Closes an owner only after native PID+FILETIME revalidation.  In particular,
 * this intentionally has no taskkill/kill(PID) fallback: a false result means
 * the original process is already gone or the PID has been reused.
 */
async function rollbackLaunchedDetachedHost(
  native: WindowsSessionHostDetachedLaunchNative,
  owner: ProcessIdentity,
): Promise<void> {
  try {
    await native.terminateIdentityAndWait(
      owner,
      DETACHED_HOST_ROLLBACK_EXIT_CODE,
      DETACHED_HOST_ROLLBACK_TIMEOUT_MS,
    );
  } finally {
    // Never retain a credential-bearing bootstrap after the owning launch has
    // entered rollback, including a native wait/termination error. The host
    // cannot be allowed to resume from an ambiguous launch state later.
    await removeDetachedBootstrapState(native, false);
  }
}

/** Roll back a successfully manifested owner after a daemon-side attach failure. */
export async function rollbackDetachedWindowsSessionHost(
  manifest: WindowsSessionHostManifest,
): Promise<void> {
  let native: WindowsSessionHostDetachedLaunchNative;
  try {
    native = await WindowsSessionHostNativeWorker.create();
  } catch (error) {
    throw new WindowsSessionHostUnavailable(
      "launch_failed",
      `Windows detached host rollback could not open the native boundary: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  return rollbackDetachedWindowsSessionHostWithNative(manifest, native);
}

/** Test seam for facade-attach rollback; it retains the same exact-identity rule. */
export async function rollbackDetachedWindowsSessionHostWithNative(
  manifest: WindowsSessionHostManifest,
  native: WindowsSessionHostDetachedLaunchNative,
): Promise<void> {
  try {
    await native.openState(manifest.stateDirectory);
    await rollbackLaunchedDetachedHost(native, manifest.owner);
    // This is the owner we just launched and exactly terminated, not a
    // replacement attempt for a stale manifest. Make restart discovery
    // accurately expose it as unavailable/read-only.
    await native.writeAtomic("manifest.json", new TextEncoder().encode(JSON.stringify({
      ...manifest,
      status: "failed",
      updatedAt: Date.now(),
    })));
  } finally {
    await native.close();
  }
}

/**
 * Explicit creation only. It refuses an existing manifest and never serves as
 * recovery fallback, so uncertain owner state cannot cause a duplicate spawn.
 */
export async function launchDetachedWindowsSessionHost(
  options: LaunchDetachedWindowsSessionHostOptions,
): Promise<WindowsSessionHostManifest> {
  let native: WindowsSessionHostDetachedLaunchNative;
  try {
    native = await WindowsSessionHostNativeWorker.create();
  } catch (error) {
    // This is the one and only direct-PTY fallback case: no host spawn was
    // attempted because the verified native binding could not be established.
    throw markPreHostNativeUnavailable(error);
  }
  return launchDetachedWindowsSessionHostWithNative(options, native);
}

/** Test seam for transactional launch behavior; production uses the wrapper above. */
export async function launchDetachedWindowsSessionHostWithNative(
  options: LaunchDetachedWindowsSessionHostOptions,
  native: WindowsSessionHostDetachedLaunchNative,
): Promise<WindowsSessionHostManifest> {
  assertSessionId(options.sessionId);
  assertEpoch(options.epoch);
  assertSecureWindowsPipeName(options.pipeName);
  if (typeof options.stateDirectory !== "string" || options.stateDirectory.length === 0) {
    throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows detached host state directory is invalid");
  }
  if (options.manifestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.manifestTimeoutMs) || options.manifestTimeoutMs < 1 || options.manifestTimeoutMs > 60_000)) {
    throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows detached host manifest timeout is invalid");
  }
  const bootstrap = parseDetachedBootstrap({
    schemaVersion: 2, implementation: "windows-session-host-runner", sessionId: options.sessionId, epoch: options.epoch,
    pipeName: options.pipeName, stateDirectory: options.stateDirectory, handlerModule: options.handlerModule,
    createdAt: options.createdAt ?? Date.now(), leaseDurationMs: options.leaseDurationMs, readOnlyMethods: options.readOnlyMethods,
    ...(options.handlerOptions === undefined ? {} : { handlerOptions: options.handlerOptions }),
  }, options.stateDirectory);
  let launchedOwner: ProcessIdentity | null = null;
  try {
    await native.openState(options.stateDirectory);
    if (await native.read("manifest.json") !== null) {
      throw new WindowsSessionHostUnavailable("native_unavailable", "Windows detached host manifest already exists; replacement spawn is forbidden");
    }
    if (await native.read(DETACHED_BOOTSTRAP_FILE) !== null) {
      throw new WindowsSessionHostUnavailable("native_unavailable", "Windows detached host bootstrap already exists; replacement spawn is forbidden");
    }
    for (const [name, value, label] of [
      [PROVIDER_BOOTSTRAP_FILE, options.providerBootstrap, "bootstrap"],
      [PROVIDER_RECORD_FILE, options.providerRecord, "record"],
    ] as const) {
      if (value === undefined) continue;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw new WindowsSessionHostUnavailable("invalid_manifest", `Windows detached provider ${label} is invalid`);
      }
      if (await native.read(name) !== null) {
        throw new WindowsSessionHostUnavailable("native_unavailable", `Windows detached provider ${label} already exists; replacement spawn is forbidden`);
      }
      await native.writeAtomic(name, value);
    }
    await native.writeAtomic(DETACHED_BOOTSTRAP_FILE, new TextEncoder().encode(JSON.stringify(bootstrap)));
    const entry = options.runnerEntryPath ?? emittedSiblingPath(import.meta.url, "windows-session-host-runner-entry.js");
    if (!isAbsolute(entry)) throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows detached runner entry must be absolute");
    const environment = runnerEnvironment(options.stateDirectory);
    const launch = await native.launchDetachedHost({
      executablePath: process.execPath,
      arguments: [entry],
      environment,
    });
    if (launch.status !== "launched") {
      // The native boundary proved CreateProcessW never succeeded. Unlike a
      // timeout after launch, no provider can exist, so this remains a safe
      // pre-host direct fallback and all launch records are rolled back below.
      throw markPreHostNativeUnavailable(new WindowsSessionHostUnavailable(
        "native_unavailable",
        "Windows parent Job prevents detached host launch",
      ));
    }
    launchedOwner = launch.process;
    return await waitForDetachedManifest(
      native,
      {
        sessionId: options.sessionId,
        epoch: options.epoch,
        process: launch.process,
        ...(environment[DETACHED_TEST_DIAGNOSTIC_ENV]
          ? { testDiagnosticPath: environment[DETACHED_TEST_DIAGNOSTIC_ENV] }
          : {}),
      },
      options.manifestTimeoutMs,
    );
  } catch (error) {
    if (launchedOwner) {
      // Manifest timeout, invalid data, or an owner identity mismatch all
      // occur after CreateProcessW. Roll back exactly the process returned by
      // that call and wait for it before clearing credential-bearing state.
      // Never relabel this as native_unavailable: a direct PTY here could
      // duplicate a still-running provider.
      try {
        await rollbackLaunchedDetachedHost(native, launchedOwner);
      } catch (rollbackError) {
        throw new WindowsSessionHostUnavailable(
          "launch_failed",
          `Windows detached host post-launch rollback failed: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`,
        );
      }
      if (error instanceof WindowsSessionHostUnavailable && error.code === "native_unavailable") {
        throw new WindowsSessionHostUnavailable(
          "launch_failed",
          `Windows detached host post-launch verification failed: ${error.message}`,
        );
      }
    } else {
      // No CreateProcessW success: this launch attempt is transactional and
      // none of its bootstrap/record state may survive.
      await removeDetachedBootstrapState(native, true);
    }
    throw error;
  } finally {
    await native.close();
  }
}

async function writeAll(native: WindowsSessionHostRunnerNative, frame: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < frame.byteLength) {
    const written = await native.writePipe(frame.slice(offset));
    if (written <= 0) throw runnerFailure("Windows native pipe write made no progress", "pipe_write_failed");
    offset += written;
  }
}

async function wakeIdlePipe(pipeName: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = createConnection(pipeName);
    const timeout = setTimeout(() => { socket.destroy(); resolve(); }, 1_000);
    const done = () => { clearTimeout(timeout); socket.destroy(); resolve(); };
    socket.once("error", done);
    socket.once("connect", () => { socket.end("\n", done); });
  });
}

async function withinStopBound<T>(operation: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(runnerFailure(`Windows session host ${stage} timed out`, "transport_stop_timeout")), TRANSPORT_STOP_TIMEOUT_MS);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * Stop transport without queueing a close behind blocking native I/O.  The
 * production proxy uses a second worker to call DisconnectNamedPipe or close
 * an idle server; the tiny wake connection remains a compatibility fallback
 * for injected legacy test/native implementations.
 */
export async function stopWindowsSessionHostTransport(
  native: WindowsSessionHostRunnerNative,
  serving: Promise<void>,
  pipeName: string,
): Promise<void> {
  let failure: unknown;
  try {
    try {
      if (native.cancelActivePipeIo) await withinStopBound(native.cancelActivePipeIo(), "pipe cancellation");
      else await withinStopBound(wakeIdlePipe(pipeName), "idle pipe wake");
    } catch (error) { failure ??= error; }
    // Never await an untrusted/native blocked call forever. If cancellation
    // failed, this bounded wait falls through to worker containment below.
    try { await withinStopBound(serving, "serve loop shutdown"); }
    catch (error) { failure ??= error; }
  } finally {
    // A close error must never skip credential/worker teardown. The concrete
    // worker's close path itself terminates its workers after a bounded
    // cancellation attempt, containing a stuck native queue.
    try { await withinStopBound(native.closePipeServer(), "pipe server close"); }
    catch (error) { failure ??= error; }
    try {
      if (native.close) await withinStopBound(native.close(), "native worker close");
    } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
}

export async function serveWindowsSessionHostPipe(
  native: WindowsSessionHostRunnerNative,
  runner: WindowsSessionHostRunner,
  shouldStop: () => boolean,
): Promise<void> {
  // Deliberately no throw escaping this detached owner: a bad client closes
  // only its connection, while unexpected native failure leaves manifest/state
  // for fail-closed inspection rather than triggering an automatic respawn.
  while (!shouldStop()) {
    let accepted = false;
    try {
      await native.acceptPipe();
      accepted = true;
      let buffer = new Uint8Array();
      let authenticated = false;
      for (;;) {
        const { data, peer } = await native.readPipe(MAX_PIPE_READ_BYTES);
        if (data.byteLength === 0) break;
        const merged = new Uint8Array(buffer.byteLength + data.byteLength);
        merged.set(buffer); merged.set(data, buffer.byteLength);
        const split = splitWireFrames(merged);
        buffer = Uint8Array.from(split.remainder);
        for (const frame of split.frames) {
          const message = decodeWireMessage(frame);
          if (!authenticated) {
            const welcome = await runner.acceptHello(message, peer);
            await writeAll(native, encodeWireMessage(welcome));
            authenticated = true;
          } else if (message.type === "command") {
            const reply = await runner.command(message);
            // A terminal reply is a synchronization point: attempt the full
            // pipe write first, then finalize its Job even if that write
            // failed because the daemon died. The durable command ledger is
            // the only accepted evidence for a later client-side success.
            try { await writeAll(native, encodeWireMessage(reply)); }
            finally { await runner.replyDelivered(reply.commandId); }
          } else if (message.type === "replay") {
            const replay = await runner.replay(message);
            await writeAll(native, encodeWireMessage(replay));
          } else {
            throw runnerFailure("Windows session host wire message is unexpected", "bad_message");
          }
        }
      }
    } catch {
      // Connection-local failure: no kill, no replacement, no lease release.
    } finally {
      runner.detachConnection();
      try { await native.closePipeConnection(); } catch { /* no active connection */ }
    }
    // A failed native accept is not a recoverable transport condition. Do not
    // spin after close/error and do not spawn another host. A failed request on
    // an accepted connection is isolated and the next daemon may attach.
    if (!accepted || shouldStop()) return;
  }
}
