/** Daemon-side attachment client for a durable Windows Session Host. */
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import type { ProcessIdentity } from "@prospero/windows-native";
import {
  assertSecureWindowsPipeName,
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
  WindowsSessionHostUnavailable,
  type SessionHostCommand,
  type SessionHostHello,
  type SessionHostReplayReply,
  type SessionHostReplayRequest,
  type SessionHostReply,
  type SessionHostWelcome,
  type SessionHostWireMessage,
  type WindowsSessionHostManifest,
  type WindowsSessionHostJournalEvent,
} from "./windows-session-host-protocol.js";
import { WindowsSessionHostNativeWorker } from "./windows-session-host-native.js";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export class WindowsSessionHostClientError extends Error {
  constructor(message: string, readonly code = "session_host_unavailable") {
    super(message);
    this.name = "WindowsSessionHostClientError";
  }
}

export interface WindowsSessionHostClientNative {
  openState(path: string): Promise<void>;
  loadCredential(entropy: Uint8Array): Promise<void>;
  hmac(material: Uint8Array): Promise<string>;
  currentIdentity(): Promise<ProcessIdentity>;
  matchesIdentity(identity: ProcessIdentity): Promise<boolean>;
  close?(): Promise<void>;
}

/** Async byte transport. The production implementation is Node's pipe client. */
export interface WindowsSessionHostWireConnection {
  send(frame: Uint8Array): Promise<void>;
  receive(): Promise<SessionHostWireMessage>;
  detach(): void;
}

export interface WindowsSessionHostClientOptions {
  /** Server-declared read-only methods may be used without a mutation lease. */
  readonly readOnlyMethods?: readonly string[];
  /** Attachment must reject a manifest that selects a different state root. */
  readonly expectedStateDirectory?: string;
  /** Bounds connect + welcome so a hostile/stalled endpoint cannot pin attach. */
  readonly handshakeTimeoutMs?: number;
  /** Bounds every request/reply exchange after attachment. */
  readonly requestTimeoutMs?: number;
}

class NodePipeConnection implements WindowsSessionHostWireConnection {
  private readonly frames: Uint8Array[] = [];
  private readonly waiters: Array<{ resolve: (message: SessionHostWireMessage) => void; reject: (error: Error) => void }> = [];
  private remainder = new Uint8Array();
  private terminalError: Error | null = null;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.onData(new Uint8Array(chunk)));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new WindowsSessionHostClientError("Windows session host pipe closed")));
  }

  static async connect(pipeName: string, timeoutMs = 5_000): Promise<NodePipeConnection> {
    assertSecureWindowsPipeName(pipeName);
    const socket = createConnection(pipeName);
    const timeout = setTimeout(() => socket.destroy(new WindowsSessionHostClientError("Windows session host pipe connection timed out")), timeoutMs);
    try { await once(socket, "connect"); }
    catch (error) {
      throw new WindowsSessionHostClientError(error instanceof Error ? error.message : "Windows session host pipe is unavailable");
    } finally { clearTimeout(timeout); }
    return new NodePipeConnection(socket);
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.terminalError || this.socket.destroyed || !this.socket.writable) throw this.terminalError ?? new WindowsSessionHostClientError("Windows session host pipe is unavailable");
    await new Promise<void>((resolve, reject) => {
      try { this.socket.write(frame, (error) => error ? reject(error) : resolve()); }
      catch (error) { reject(error); }
    });
  }

  receive(): Promise<SessionHostWireMessage> {
    const frame = this.frames.shift();
    if (frame) return Promise.resolve(decodeWireMessage(frame));
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise<SessionHostWireMessage>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  detach(): void { this.socket.destroy(); }

  private onData(chunk: Uint8Array): void {
    if (this.terminalError) return;
    const merged = new Uint8Array(this.remainder.byteLength + chunk.byteLength);
    merged.set(this.remainder);
    merged.set(chunk, this.remainder.byteLength);
    try {
      const split = splitWireFrames(merged);
      this.remainder = Uint8Array.from(split.remainder);
      for (const frame of split.frames) {
        if (frame.byteLength > MAX_FRAME_BYTES) throw new WindowsSessionHostClientError("Windows session host frame exceeds maximum");
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(decodeWireMessage(frame));
        else this.frames.push(frame);
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

function clientFailure(message: string, code = "session_host_unavailable"): WindowsSessionHostClientError {
  return new WindowsSessionHostClientError(message, code);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isStrictJournalEvent(value: unknown, manifest: WindowsSessionHostManifest): value is WindowsSessionHostJournalEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const keys = event.commandId === undefined
    ? ["schemaVersion", "sessionId", "epoch", "seq", "kind", "payload"]
    : ["schemaVersion", "sessionId", "epoch", "seq", "kind", "payload", "commandId"];
  return hasExactKeys(event, keys) && event.schemaVersion === 2 && event.sessionId === manifest.sessionId && event.epoch === manifest.epoch &&
    Number.isSafeInteger(event.seq) && (event.seq as number) > 0 &&
    (event.kind === "event" || event.kind === "command" || event.kind === "terminal") && Object.hasOwn(event, "payload") &&
    (event.commandId === undefined || (typeof event.commandId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(event.commandId)));
}

function isStrictSnapshot(value: unknown, manifest: WindowsSessionHostManifest): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (!hasExactKeys(snapshot, ["schemaVersion", "sessionId", "epoch", "lastSeq", "terminal", "commands", "state"]) ||
    snapshot.schemaVersion !== 2 || snapshot.sessionId !== manifest.sessionId || snapshot.epoch !== manifest.epoch ||
    !Number.isSafeInteger(snapshot.lastSeq) || (snapshot.lastSeq as number) < 0 || typeof snapshot.terminal !== "boolean" || !Array.isArray(snapshot.commands)) return false;
  const commandIds = new Set<string>();
  return snapshot.commands.every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const command = entry as Record<string, unknown>;
    if (!hasExactKeys(command, ["commandId", "reply"]) || typeof command.commandId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,160}$/.test(command.commandId) || commandIds.has(command.commandId) ||
      !isReply(command.reply as SessionHostWireMessage, command.commandId)) return false;
    commandIds.add(command.commandId);
    return (command.reply as SessionHostReply).seq <= (snapshot.lastSeq as number);
  });
}

function isWelcome(value: SessionHostWireMessage): value is SessionHostWelcome {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    hasExactKeys(value as unknown as Record<string, unknown>, ["version", "type", "sessionId", "epoch", "host", "proof", "terminal", "lastSeq"]) &&
    value.type === "welcome" && value.version === 2 && typeof value.sessionId === "string" &&
    typeof value.epoch === "string" && typeof value.proof === "string" && typeof value.terminal === "boolean" &&
    Number.isSafeInteger(value.lastSeq) && value.lastSeq >= 0 && isProcessIdentity(value.host);
}

function isReply(value: SessionHostWireMessage, commandId: string): value is SessionHostReply {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const reply = value as unknown as Record<string, unknown>;
  if (reply.type !== "reply" || reply.version !== 2 || reply.commandId !== commandId || typeof reply.ok !== "boolean" ||
    !Number.isSafeInteger(reply.seq) || (reply.seq as number) < 0) return false;
  if (reply.ok) return hasExactKeys(reply, ["version", "type", "commandId", "ok", "result", "seq"]);
  return hasExactKeys(reply, ["version", "type", "commandId", "ok", "error", "seq"]) && !!reply.error &&
    typeof reply.error === "object" && !Array.isArray(reply.error) &&
    hasExactKeys(reply.error as Record<string, unknown>, ["code", "message"]) &&
    typeof (reply.error as { code?: unknown }).code === "string" && typeof (reply.error as { message?: unknown }).message === "string";
}

function isReplay(value: SessionHostWireMessage): value is SessionHostReplayReply {
  const candidate = value as Partial<SessionHostReplayReply>;
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    hasExactKeys(value as unknown as Record<string, unknown>, ["version", "type", "sessionId", "epoch", "afterSeq", "lastSeq", "gap", "terminal", "snapshot", "events"]) &&
    candidate.type === "replay" && candidate.version === 2 && typeof candidate.sessionId === "string" &&
    typeof candidate.epoch === "string" && typeof candidate.afterSeq === "number" && Number.isSafeInteger(candidate.afterSeq) && candidate.afterSeq >= 0 &&
    typeof candidate.lastSeq === "number" && Number.isSafeInteger(candidate.lastSeq) && candidate.lastSeq >= 0 && typeof candidate.gap === "boolean" &&
    typeof candidate.terminal === "boolean" && Array.isArray(candidate.events);
}

function validateReplayContinuity(reply: SessionHostReplayReply, afterSeq: number, manifest: WindowsSessionHostManifest): void {
  let expected = afterSeq;
  if (reply.gap) {
    const snapshot = reply.snapshot;
    if (!snapshot || !isStrictSnapshot(snapshot, manifest) ||
      !Number.isSafeInteger(snapshot.lastSeq) || snapshot.lastSeq <= afterSeq) {
      throw clientFailure("Windows session host replay gap lacks a valid snapshot");
    }
    expected = snapshot.lastSeq;
  } else if (reply.snapshot !== null) {
    throw clientFailure("Windows session host replay supplied an unexpected snapshot");
  }
  for (const event of reply.events as readonly WindowsSessionHostJournalEvent[]) {
    if (!isStrictJournalEvent(event, manifest) || event.seq !== expected + 1) {
      throw clientFailure("Windows session host replay sequence is discontinuous");
    }
    expected = event.seq;
  }
  if (expected !== reply.lastSeq) throw clientFailure("Windows session host replay lastSeq is inconsistent");
}

/**
 * The daemon has no launch method. `attach` only validates and connects to an
 * existing owner; any untrusted/unknown state stays unavailable rather than
 * spawning a replacement that could duplicate a running session.
 */
export class WindowsSessionHostClient {
  private connection: WindowsSessionHostWireConnection | null = null;
  private leaseId: string | null = null;
  private busy = false;
  private attached = false;
  /** Last journal event actually consumed by this daemon, never welcome metadata. */
  private lastSeq = 0;
  private announcedLastSeq = 0;
  private terminal = false;
  private readonly readOnlyMethods: ReadonlySet<string>;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    readonly manifest: WindowsSessionHostManifest,
    private readonly native: WindowsSessionHostClientNative,
    private readonly connect: (pipeName: string) => Promise<WindowsSessionHostWireConnection> = NodePipeConnection.connect,
    options: WindowsSessionHostClientOptions = {},
  ) {
    this.readOnlyMethods = new Set(options.readOnlyMethods ?? []);
    this.handshakeTimeoutMs = this.timeout(options.handshakeTimeoutMs ?? 5_000, "handshake timeout");
    this.requestTimeoutMs = this.timeout(options.requestTimeoutMs ?? 10_000, "request timeout");
  }

  static async attach(
    rawManifest: unknown,
    native: WindowsSessionHostClientNative,
    connect?: (pipeName: string) => Promise<WindowsSessionHostWireConnection>,
    options?: WindowsSessionHostClientOptions,
  ): Promise<WindowsSessionHostClient> {
    const manifest = parseWindowsSessionHostManifest(rawManifest);
    if (options?.expectedStateDirectory !== undefined && options.expectedStateDirectory !== manifest.stateDirectory) {
      throw new WindowsSessionHostUnavailable("invalid_manifest", "Windows session host manifest state directory does not match the expected attachment root");
    }
    if (manifest.status === "failed") throw new WindowsSessionHostUnavailable("native_unavailable", "Windows session host manifest is terminally failed; replacement is forbidden");
    const client = new WindowsSessionHostClient(manifest, native, connect, options);
    try { await client.connectAndVerify(); return client; }
    catch (error) { client.detach(); throw error; }
  }

  get isTerminal(): boolean { return this.terminal; }
  get cursor(): number { return this.lastSeq; }

  async acquireMutationLease(): Promise<string> {
    const reply = await this.command("lease.acquire", { requestedAt: Date.now() }, true, undefined, "lease.acquire");
    if (!reply || typeof reply !== "object" || typeof (reply as { leaseId?: unknown }).leaseId !== "string") {
      throw clientFailure("Windows session host returned an invalid mutation lease");
    }
    this.leaseId = (reply as { leaseId: string }).leaseId;
    return this.leaseId;
  }

  async command(method: string, params: unknown, _clientMutationHint: boolean, commandId = randomUUID(), internalMethod?: string): Promise<unknown> {
    if (!this.attached || !this.connection) throw clientFailure("Windows session host is detached");
    const serverMethod = internalMethod ?? method;
    const requiresLease = serverMethod !== "lease.acquire" && !this.readOnlyMethods.has(serverMethod);
    if (requiresLease && !this.leaseId) throw clientFailure("Windows session host mutation lease is required", "lease_required");
    if (this.busy) throw clientFailure("Windows session host connection accepts one command at a time", "connection_busy");
    this.busy = true;
    try {
      const request: SessionHostCommand = {
        version: 2, type: "command", sessionId: this.manifest.sessionId, epoch: this.manifest.epoch,
        // This field remains wire-compatible for older daemons, but the host
        // ignores it when deciding whether handler execution needs a lease.
        commandId, mutation: requiresLease, method: serverMethod, params,
        ...(requiresLease ? { leaseId: this.leaseId! } : {}),
      };
      await this.connection.send(encodeWireMessage(request));
      const reply = await this.receive(this.requestTimeoutMs, "Windows session host command timed out");
      if (!isReply(reply, commandId)) throw clientFailure("Windows session host reply is invalid");
      // A reply announces the durable watermark but does not prove this
      // daemon consumed every intervening event.  Only strict replay moves
      // the consumption cursor.
      this.announcedLastSeq = Math.max(this.announcedLastSeq, reply.seq);
      if (!reply.ok) throw clientFailure(reply.error?.message ?? "Windows session host rejected command", reply.error?.code ?? "command_rejected");
      return reply.result;
    } finally { this.busy = false; }
  }

  async replay(afterSeq = this.lastSeq): Promise<SessionHostReplayReply> {
    if (!this.attached || !this.connection) throw clientFailure("Windows session host is detached");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw clientFailure("Windows session host cursor is invalid", "bad_cursor");
    if (this.busy) throw clientFailure("Windows session host connection accepts one command at a time", "connection_busy");
    this.busy = true;
    try {
      const request: SessionHostReplayRequest = {
        version: 2, type: "replay", sessionId: this.manifest.sessionId, epoch: this.manifest.epoch, afterSeq,
      };
      await this.connection.send(encodeWireMessage(request));
      const reply = await this.receive(this.requestTimeoutMs, "Windows session host replay timed out");
      if (!isReplay(reply) || reply.sessionId !== this.manifest.sessionId || reply.epoch !== this.manifest.epoch || reply.afterSeq !== afterSeq) {
        throw clientFailure("Windows session host replay is invalid");
      }
      validateReplayContinuity(reply, afterSeq, this.manifest);
      this.lastSeq = reply.lastSeq;
      this.announcedLastSeq = Math.max(this.announcedLastSeq, reply.lastSeq);
      this.terminal = reply.terminal;
      return reply;
    } finally { this.busy = false; }
  }

  /** Detach is intentionally the only daemon-shutdown behavior. */
  detach(): void {
    this.connection?.detach();
    this.connection = null;
    this.attached = false;
    this.leaseId = null;
  }

  /** Release the daemon socket, worker-owned state handle, and DPAPI key. */
  async dispose(): Promise<void> {
    this.detach();
    await this.native.close?.();
  }

  async close(): Promise<void> { await this.dispose(); }

  private async connectAndVerify(): Promise<void> {
    await this.native.openState(this.manifest.stateDirectory);
    await this.native.loadCredential(sessionEpochEntropy(this.manifest.sessionId, this.manifest.epoch));
    const daemon = await this.native.currentIdentity();
    if (!await this.native.matchesIdentity(this.manifest.owner)) {
      throw new WindowsSessionHostUnavailable("identity_mismatch", "Windows session host owner PID/FILETIME does not match before pipe connect");
    }
    const nonce = randomBytes(24).toString("base64");
    const helloUnsigned = { sessionId: this.manifest.sessionId, epoch: this.manifest.epoch, daemon, nonce };
    const hello: SessionHostHello = {
      version: 2, type: "hello", ...helloUnsigned,
      proof: await this.native.hmac(helloProofMaterial(helloUnsigned)),
    };
    const pendingConnection = this.connect(this.manifest.pipeName);
    try { this.connection = await this.withTimeout(pendingConnection, this.handshakeTimeoutMs, "Windows session host pipe connection timed out"); }
    catch (error) {
      void pendingConnection.then((connection) => connection.detach(), () => undefined);
      throw error;
    }
    await this.withTimeout(this.connection.send(encodeWireMessage(hello)), this.handshakeTimeoutMs, "Windows session host hello send timed out");
    const welcome = await this.receive(this.handshakeTimeoutMs, "Windows session host welcome timed out");
    if (!isWelcome(welcome) || welcome.sessionId !== this.manifest.sessionId || welcome.epoch !== this.manifest.epoch ||
      !processIdentityEquals(welcome.host, this.manifest.owner)) {
      throw new WindowsSessionHostUnavailable("identity_mismatch", "Windows session host owner identity does not match manifest");
    }
    if (!await this.native.matchesIdentity(welcome.host)) {
      throw new WindowsSessionHostUnavailable("identity_mismatch", "Windows session host owner PID/FILETIME no longer matches");
    }
    const expected = await this.native.hmac(welcomeProofMaterial({
      sessionId: welcome.sessionId, epoch: welcome.epoch, host: welcome.host, terminal: welcome.terminal, lastSeq: welcome.lastSeq,
    }, nonce));
    if (!proofEquals(expected, welcome.proof)) {
      throw new WindowsSessionHostUnavailable("acl_unverified", "Windows session host handshake proof is invalid");
    }
    // Welcome metadata advertises availability only; it has not been replayed
    // into this daemon yet, so it must never advance the consumption cursor.
    this.announcedLastSeq = welcome.lastSeq;
    this.terminal = welcome.terminal;
    this.attached = true;
  }

  private async receive(timeoutMs: number, message: string): Promise<SessionHostWireMessage> {
    if (!this.connection) throw clientFailure("Windows session host is detached");
    try { return await this.withTimeout(this.connection.receive(), timeoutMs, message); }
    catch (error) {
      this.detach();
      throw error;
    }
  }

  private timeout(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) throw clientFailure(`Windows session host ${name} is invalid`, "invalid_timeout");
    return value;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(clientFailure(message, "timeout")), timeoutMs);
    });
    try { return await Promise.race([promise, timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}

/** Production attach helper: it creates no host and is fail-closed off Windows. */
export async function attachWindowsSessionHost(rawManifest: unknown, options: WindowsSessionHostClientOptions = {}): Promise<WindowsSessionHostClient> {
  const native = await WindowsSessionHostNativeWorker.create();
  try { return await WindowsSessionHostClient.attach(rawManifest, native, undefined, options); }
  catch (error) { await native.close(); throw error; }
}
