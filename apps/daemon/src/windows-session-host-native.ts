/** Main-thread proxy for the dedicated Windows-native blocking-I/O worker. */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import {
  NATIVE_REQUIRED_CAPABILITIES,
  NATIVE_WINDOWS_ABI_VERSION,
  type DetachedHostLaunchOptions,
  type DetachedHostLaunchResult,
  type JobObjectHandle,
  type NativeCapabilityReport,
  type PipePeerIdentity,
  type ProcessIdentity,
} from "@prospero/windows-native";
import type { WindowsSessionHostStateStore } from "./windows-session-host-protocol.js";
import { isProcessIdentity, WindowsSessionHostUnavailable } from "./windows-session-host-protocol.js";
import { emittedSiblingUrl } from "./runtime-module-path.js";

interface WorkerReply {
  readonly id?: unknown;
  readonly ok?: unknown;
  readonly value?: unknown;
  readonly error?: unknown;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const NATIVE_CLOSE_TIMEOUT_MS = 2_000;
const TEST_DIAGNOSTIC_ENV = "PROSPERO_WINDOWS_SESSION_HOST_TEST_DIAGNOSTIC";

function writeNativeTestDiagnostic(stage: string, error?: unknown): void {
  const diagnosticPath = process.env[TEST_DIAGNOSTIC_ENV];
  if (typeof diagnosticPath !== "string" || diagnosticPath.length === 0) return;
  const message = error instanceof Error
    ? error.message.replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 320)
    : undefined;
  try {
    writeFileSync(diagnosticPath, JSON.stringify({ version: 1, stage, ...(message ? { message } : {}) }));
  } catch { /* CI-only diagnostic must not change native startup behavior */ }
}

/** TokenSessionId is a Win32 DWORD, not a 16-bit terminal-session field. */
export const WINDOWS_DWORD_MAX = 0xffff_ffff;

/**
 * Native peer identity is untrusted worker-message data until this validation
 * succeeds. Keep the full DWORD range: valid RDP/session identifiers are not
 * limited to 16 bits.
 */
export function isStrictWindowsPipePeerIdentity(value: unknown): value is PipePeerIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const peer = value as Partial<PipePeerIdentity>;
  return isProcessIdentity(peer.process) && typeof peer.userSid === "string" && /^S-1-\d+(?:-\d+)+$/.test(peer.userSid) &&
    typeof peer.sessionId === "number" && Number.isSafeInteger(peer.sessionId) &&
    peer.sessionId >= 0 && peer.sessionId <= WINDOWS_DWORD_MAX;
}

async function withinNativeCloseBound<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(nativeFailure("Windows native worker shutdown timed out")), NATIVE_CLOSE_TIMEOUT_MS);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** A second worker which can interrupt the primary worker's blocked pipe I/O. */
class WindowsSessionHostPipeCanceller {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  private constructor(private readonly worker: Worker) {
    worker.on("message", (message: unknown) => this.onMessage(message));
    worker.on("error", (error) => this.rejectAll(nativeFailure(`Windows pipe cancellation worker failed: ${error.message}`)));
    worker.on("exit", (code) => {
      if (!this.closed) this.rejectAll(nativeFailure(`Windows pipe cancellation worker exited (${code})`));
    });
  }

  static async create(): Promise<WindowsSessionHostPipeCanceller> {
    writeNativeTestDiagnostic("canceller_spawning");
    const worker = new Worker(emittedSiblingUrl(import.meta.url, "windows-session-host-native-cancel-worker.js"));
    writeNativeTestDiagnostic("canceller_spawned");
    const canceller = new WindowsSessionHostPipeCanceller(worker);
    try {
      writeNativeTestDiagnostic("canceller_initializing");
      const initialized = await canceller.call("initialize");
      if (!initialized || typeof initialized !== "object" || !reportIsTrusted((initialized as { report?: unknown }).report)) {
        throw new WindowsSessionHostUnavailable("native_capability_missing", "Windows pipe cancellation worker did not expose a trusted complete capability report");
      }
      writeNativeTestDiagnostic("canceller_initialized");
      return canceller;
    } catch (error) {
      writeNativeTestDiagnostic("canceller_failed", error);
      await canceller.close();
      throw error;
    }
  }

  async disconnectConnection(handle: bigint): Promise<void> { await this.call("disconnectConnection", { handle }); }
  async closeServer(handle: bigint): Promise<void> { await this.call("closeServer", { handle }); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(nativeFailure("Windows pipe cancellation worker closed"));
    await withinNativeCloseBound(this.worker.terminate());
  }

  private call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(nativeFailure("Windows pipe cancellation worker is closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, op, args }); }
      catch (error) {
        this.pending.delete(id);
        reject(nativeFailure(error instanceof Error ? error.message : "Windows pipe cancellation worker send failed"));
      }
    });
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const reply = message as WorkerReply;
    if (typeof reply.id !== "number") return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.ok === true) pending.resolve(reply.value);
    else pending.reject(nativeFailure(typeof reply.error === "string" ? reply.error : "Windows pipe cancellation failed"));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function nativeFailure(message: string): WindowsSessionHostUnavailable {
  return new WindowsSessionHostUnavailable("native_unavailable", message);
}

function reportIsTrusted(value: unknown): value is NativeCapabilityReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<NativeCapabilityReport>;
  return report.signatureVerified === true && report.abiVersion === NATIVE_WINDOWS_ABI_VERSION &&
    report.platform === "win32" && NATIVE_REQUIRED_CAPABILITIES.every((name) => report.capabilities?.[name] === true);
}

/**
 * Every method maps to one request in `windows-session-host-native-worker`.
 * The worker is the only realm that loads the verified addon or can block on
 * pipe/state/identity APIs. This proxy itself is deliberately async-only.
 */
export class WindowsSessionHostNativeWorker implements WindowsSessionHostStateStore {
  private readonly worker: Worker;
  private readonly canceller: WindowsSessionHostPipeCanceller;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private activeServer: bigint | null = null;
  private activeConnection: bigint | null = null;

  private constructor(worker: Worker, canceller: WindowsSessionHostPipeCanceller) {
    this.worker = worker;
    this.canceller = canceller;
    worker.on("message", (message: unknown) => this.onMessage(message));
    worker.on("error", (error) => this.rejectAll(nativeFailure(`Windows native worker failed: ${error.message}`)));
    worker.on("exit", (code) => {
      // A clean unexpected exit is just as unsafe as a crash: pending pipe,
      // DPAPI, or identity operations must never wait forever or be retried
      // against an unknown native-owner outcome.
      if (!this.closed) this.rejectAll(nativeFailure(`Windows native worker exited (${code})`));
    });
  }

  static async create(): Promise<WindowsSessionHostNativeWorker> {
    if (process.platform !== "win32") throw nativeFailure("Windows session host is unavailable outside win32");
    writeNativeTestDiagnostic("primary_spawning");
    const worker = new Worker(emittedSiblingUrl(import.meta.url, "windows-session-host-native-worker.js"));
    writeNativeTestDiagnostic("primary_spawned");
    let canceller: WindowsSessionHostPipeCanceller | null = null;
    let bridge: WindowsSessionHostNativeWorker | null = null;
    try {
      writeNativeTestDiagnostic("canceller_creating");
      canceller = await WindowsSessionHostPipeCanceller.create();
      writeNativeTestDiagnostic("bridge_creating");
      bridge = new WindowsSessionHostNativeWorker(worker, canceller);
      writeNativeTestDiagnostic("primary_initializing");
      const initialized = await bridge.call("initialize");
      if (!initialized || typeof initialized !== "object" || !reportIsTrusted((initialized as { report?: unknown }).report)) {
        throw new WindowsSessionHostUnavailable("native_capability_missing", "Windows native worker did not expose a trusted complete capability report");
      }
      writeNativeTestDiagnostic("primary_initialized");
      return bridge;
    } catch (error) {
      writeNativeTestDiagnostic("native_create_failed", error);
      if (bridge) await bridge.close();
      else {
        await worker.terminate();
        await canceller?.close();
      }
      throw error;
    }
  }

  async openState(path: string): Promise<void> { await this.call("openState", { path }); }
  async read(fileName: string): Promise<Uint8Array | null> {
    const value = await this.call("state.read", { name: fileName });
    if (value === null) return null;
    if (!(value instanceof Uint8Array)) throw nativeFailure("Windows native state read returned invalid bytes");
    return value;
  }
  async list(): Promise<readonly string[]> {
    const value = await this.call("state.list");
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      throw nativeFailure("Windows native state list returned invalid entries");
    }
    return value;
  }
  async writeAtomic(fileName: string, bytes: Uint8Array): Promise<void> {
    await this.call("state.write", { name: fileName, bytes });
  }
  async removeState(fileName: string): Promise<void> { await this.call("state.remove", { name: fileName }); }

  async createCredential(entropy: Uint8Array): Promise<void> {
    const secret = randomBytes(32);
    try { await this.call("credential.create", { secret, entropy }); }
    finally { secret.fill(0); }
  }
  async loadCredential(entropy: Uint8Array): Promise<void> { await this.call("credential.load", { entropy }); }
  async hmac(material: Uint8Array): Promise<string> {
    const result = await this.call("credential.hmac", { material });
    if (typeof result !== "string") throw nativeFailure("Windows native HMAC result is invalid");
    return result;
  }
  async currentIdentity(): Promise<ProcessIdentity> { return this.identityResult(await this.call("identity.current")); }
  async processIdentity(pid: number): Promise<ProcessIdentity> { return this.identityResult(await this.call("identity.process", { pid })); }
  async matchesIdentity(identity: ProcessIdentity): Promise<boolean> {
    const result = await this.call("identity.matches", { identity });
    if (typeof result !== "boolean") throw nativeFailure("Windows native identity result is invalid");
    return result;
  }
  async createProviderJob(): Promise<JobObjectHandle> {
    const result = await this.call("job.create");
    return this.jobHandle(result, "Windows native provider Job Object handle is invalid");
  }
  async assignProviderProcess(process: ProcessIdentity): Promise<void> {
    await this.call("job.assign", { process });
  }
  async isProviderProcessInJob(process: ProcessIdentity): Promise<boolean> {
    const result = await this.call("job.contains", { process });
    if (typeof result !== "boolean") throw nativeFailure("Windows native Job membership result is invalid");
    return result;
  }
  async terminateProviderJob(): Promise<void> { await this.call("job.terminate"); }
  async closeProviderJob(): Promise<void> { await this.call("job.close"); }
  /**
   * The sole detached-host rollback primitive. Native code reopens the PID,
   * checks FILETIME, terminates that exact handle, and waits for its exit.
   */
  async terminateIdentityAndWait(
    identity: ProcessIdentity,
    exitCode = 0xC000013A,
    timeoutMs = 5_000,
  ): Promise<boolean> {
    const result = await this.call("identity.terminate", { identity, exitCode, timeoutMs });
    if (typeof result !== "boolean") throw nativeFailure("Windows native exact termination result is invalid");
    return result;
  }

  async createPipe(pipeName: string): Promise<void> {
    const handle = await this.call("pipe.create", { pipeName });
    this.activeServer = this.pipeHandle(handle, "Windows native pipe server handle is invalid");
  }
  async launchDetachedHost(options: DetachedHostLaunchOptions): Promise<DetachedHostLaunchResult> {
    const result = await this.call("detached.launch", options as unknown as Record<string, unknown>);
    if (!result || typeof result !== "object" || (result as { status?: unknown }).status === undefined) {
      throw nativeFailure("Windows native detached host result is invalid");
    }
    const launch = result as DetachedHostLaunchResult;
    if (launch.status === "launched") this.identityResult(launch.process);
    else if (launch.status !== "parent_job_prevents_detach") throw nativeFailure("Windows native detached host result is invalid");
    return launch;
  }
  async acceptPipe(): Promise<void> {
    const handle = await this.call("pipe.accept");
    this.activeConnection = this.pipeHandle(handle, "Windows native pipe connection handle is invalid");
  }
  async readPipe(maxBytes: number): Promise<{ data: Uint8Array; peer: PipePeerIdentity | null }> {
    const result = await this.call("pipe.read", { maxBytes });
    if (!result || typeof result !== "object") throw nativeFailure("Windows native pipe read result is invalid");
    const value = result as { data?: unknown; peer?: unknown };
    if (!(value.data instanceof Uint8Array) || (value.peer !== null && !this.isPeer(value.peer))) {
      throw nativeFailure("Windows native pipe peer identity is invalid");
    }
    return { data: value.data, peer: value.peer as PipePeerIdentity | null };
  }
  async writePipe(bytes: Uint8Array): Promise<number> {
    const result = await this.call("pipe.write", { bytes });
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0 || result > bytes.byteLength) {
      throw nativeFailure("Windows native pipe write result is invalid");
    }
    return result;
  }
  async closePipeConnection(): Promise<void> {
    try { await this.call("pipe.closeConnection"); }
    finally { this.activeConnection = null; }
  }
  async closePipeServer(): Promise<void> {
    try { await this.call("pipe.closeServer"); }
    finally { this.activeServer = null; }
  }

  /**
   * Cancels the exact native call currently blocked in the primary worker.
   * A server close is followed by an in-worker token drop because that native
   * registry entry was consumed by the control worker's close.
   */
  async cancelActivePipeIo(): Promise<void> {
    if (this.activeConnection !== null) {
      await this.canceller.disconnectConnection(this.activeConnection);
      return;
    }
    if (this.activeServer !== null) {
      await this.canceller.closeServer(this.activeServer);
      await this.call("pipe.forgetCancelledServer");
      this.activeServer = null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try { await withinNativeCloseBound(this.cancelActivePipeIo()); } catch { /* terminate below is the final containment boundary */ }
    try { await withinNativeCloseBound(this.call("close")); } catch { /* termination below owns cleanup */ }
    this.closed = true;
    this.rejectAll(nativeFailure("Windows native worker closed"));
    this.activeConnection = null;
    this.activeServer = null;
    await Promise.allSettled([
      withinNativeCloseBound(this.worker.terminate()),
      withinNativeCloseBound(this.canceller.close()),
    ]);
  }

  private async call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) throw nativeFailure("Windows native worker is closed");
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, op, args }); }
      catch (error) {
        this.pending.delete(id);
        reject(nativeFailure(error instanceof Error ? error.message : "Windows native worker send failed"));
      }
    });
  }

  private jobHandle(value: unknown, message: string): JobObjectHandle {
    if (typeof value !== "bigint" || value <= 0n) throw nativeFailure(message);
    return value as JobObjectHandle;
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const reply = message as WorkerReply;
    if (typeof reply.id !== "number") return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.ok === true) pending.resolve(reply.value);
    else pending.reject(nativeFailure(typeof reply.error === "string" ? reply.error : "Windows native operation failed"));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private identityResult(value: unknown): ProcessIdentity {
    if (!value || typeof value !== "object") throw nativeFailure("Windows native identity is invalid");
    const identity = value as Partial<ProcessIdentity>;
    if (typeof identity.pid !== "number" || !Number.isSafeInteger(identity.pid) || identity.pid < 2 ||
      typeof identity.creationTime100ns !== "string" || !/^[1-9][0-9]{0,19}$/.test(identity.creationTime100ns)) {
      throw nativeFailure("Windows native identity is invalid");
    }
    return identity as ProcessIdentity;
  }

  private isPeer(value: unknown): value is PipePeerIdentity {
    return isStrictWindowsPipePeerIdentity(value);
  }

  private pipeHandle(value: unknown, message: string): bigint {
    if (typeof value !== "bigint" || value <= 0n) throw nativeFailure(message);
    return value;
  }
}
