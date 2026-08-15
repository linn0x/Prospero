import { createRequire } from "node:module";
import { createConnection, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bindingPath = join(packageRoot, "build", "Release", "prospero_windows_native.node");

type RawBinding = {
  getCurrentProcessIdentity(): { pid: number; creationTime100ns: string };
  getProcessIdentity(pid: number): { pid: number; creationTime100ns: string };
  matchesProcessIdentity(identity: { pid: number; creationTime100ns: string }): boolean;
  createSecureNamedPipeServer(options: {
    pipeName: string;
    maxInstances: number;
    inboundBufferBytes: number;
    outboundBufferBytes: number;
  }): bigint;
  closeSecureNamedPipeServer(server: bigint): void;
  dpapiProtectCurrentUser(plaintext: Uint8Array, sessionEpochEntropy: Uint8Array): Uint8Array;
  dpapiUnprotectCurrentUser(ciphertext: Uint8Array, sessionEpochEntropy: Uint8Array): Uint8Array;
  openSecureStateDirectory(options: { path: string }): bigint;
  writeSecureStateFileAtomically(directory: bigint, fileName: string, data: Uint8Array): void;
  readSecureStateFile(directory: bigint, fileName: string): Uint8Array;
  listSecureStateEntries(directory: bigint): readonly string[];
  removeSecureStateFile(directory: bigint, fileName: string): void;
  closeSecureStateDirectory(directory: bigint): void;
};

const binding = (process.platform === "win32" ? require(bindingPath) : undefined) as RawBinding;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CANCELLATION_TIMEOUT_MS = 5_000;

function waitForWorkerMessage(worker: Worker, expected: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for pipe worker ${expected}`)), timeoutMs);
    const onError = (error: Error) => finish(error);
    const onExit = (code: number) => finish(new Error(`Pipe worker exited before ${expected} (${code})`));
    const onMessage = (message: Record<string, unknown>) => {
      if (message.type === "error") {
        finish(new Error(`${message.name}: ${message.message}`));
      } else if (message.type === expected) {
        finish(undefined, message);
      }
    };
    const finish = (error?: Error, message?: Record<string, unknown>) => {
      clearTimeout(timeout);
      worker.off("error", onError);
      worker.off("exit", onExit);
      worker.off("message", onMessage);
      if (error) reject(error);
      else resolve(message!);
    };
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.on("message", onMessage);
  });
}

function waitForWorker(worker: Worker, expected: "ready" | "complete"): Promise<Record<string, unknown>> {
  return waitForWorkerMessage(worker, expected);
}

async function connectPipe(pipeName: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(pipeName);
    const fail = (error: Error) => {
      socket.off("connect", connected);
      reject(error);
    };
    const connected = () => {
      socket.off("error", fail);
      socket.on("error", () => {});
      resolve(socket);
    };
    socket.once("error", fail);
    socket.once("connect", connected);
  });
}

async function terminateWorker(worker: Worker | undefined): Promise<void> {
  if (worker) await worker.terminate();
}

type NativePipeWorkerMessage = Record<string, unknown> & { type: string };
type NativePipeWorkerTerminal =
  | (NativePipeWorkerMessage & { type: "complete" })
  | (NativePipeWorkerMessage & { type: "error" });
type PipeRoundTripResult =
  | { readonly kind: "response"; readonly data: Buffer }
  | { readonly kind: "error"; readonly error: Error };

/**
 * A socket EPIPE is only a symptom when the native worker closed its endpoint.
 * Keep one observer for ready and terminal messages so the test always waits
 * for, and reports, the server's phase/code before considering client I/O.
 */
function observeNativePipeWorker(worker: Worker, timeoutMs = 10_000): {
  readonly ready: Promise<NativePipeWorkerMessage>;
  readonly terminal: Promise<NativePipeWorkerTerminal>;
} {
  let resolveReady!: (message: NativePipeWorkerMessage) => void;
  let rejectReady!: (error: Error) => void;
  let resolveTerminal!: (message: NativePipeWorkerTerminal) => void;
  const ready = new Promise<NativePipeWorkerMessage>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const terminal = new Promise<NativePipeWorkerTerminal>((resolve) => {
    resolveTerminal = resolve;
  });
  let sawReady = false;
  let terminalMessage: NativePipeWorkerTerminal | undefined;
  let timeout: ReturnType<typeof setTimeout>;
  const settleTerminal = (message: NativePipeWorkerTerminal) => {
    if (terminalMessage) return;
    terminalMessage = message;
    clearTimeout(timeout);
    resolveTerminal(message);
  };
  timeout = setTimeout(() => {
    const error = new Error("Timed out waiting for native pipe worker terminal result");
    if (!sawReady) rejectReady(error);
    settleTerminal({ type: "error", phase: "timeout", name: error.name, message: error.message });
  }, timeoutMs);
  worker.on("message", (value: unknown) => {
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") return;
    const message = value as NativePipeWorkerMessage;
    if (message.type === "ready" && !sawReady) {
      sawReady = true;
      resolveReady(message);
      return;
    }
    if (message.type === "complete" || message.type === "error") {
      if (!sawReady) {
        rejectReady(new Error(`Native pipe worker ended before ready: ${String(message.message ?? message.type)}`));
      }
      settleTerminal(message as NativePipeWorkerTerminal);
    }
  });
  worker.once("error", (error) => {
    if (!sawReady) rejectReady(error);
    settleTerminal({ type: "error", phase: "worker-error", name: error.name, message: error.message });
  });
  worker.once("exit", (code) => {
    if (!terminalMessage) {
      const error = new Error(`Native pipe worker exited before terminal result (${code})`);
      if (!sawReady) rejectReady(error);
      settleTerminal({ type: "error", phase: "worker-exit", name: error.name, message: error.message, exitCode: code });
    }
  });
  return { ready, terminal };
}

function readPipeRoundTrip(pipeName: string): Promise<PipeRoundTripResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PipeRoundTripResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const socket = createConnection(pipeName);
    socket.on("error", (error) => finish({ kind: "error", error }));
    socket.once("connect", () => {
      socket.write(Buffer.from("pipe-round-trip"));
    });
    socket.once("data", (data) => {
      finish({ kind: "response", data });
      socket.end();
    });
    socket.once("end", () => {
      finish({ kind: "error", error: new Error("Named pipe ended before roundtrip response") });
    });
    socket.once("close", () => {
      finish({ kind: "error", error: new Error("Named pipe closed before roundtrip response") });
    });
  });
}

function nativePipeWorkerFailure(terminal: NativePipeWorkerTerminal): Error | undefined {
  if (terminal.type !== "error") return undefined;
  const phase = typeof terminal.phase === "string" ? terminal.phase : "unknown";
  const code = typeof terminal.code === "string" ? ` (${terminal.code})` : "";
  const name = typeof terminal.name === "string" ? terminal.name : "NativePipeError";
  const message = typeof terminal.message === "string" ? terminal.message : "native pipe worker failed";
  return new Error(`${name} at ${phase}${code}: ${message}`);
}

describe.runIf(process.platform === "win32")("Windows identity, secure pipe, DPAPI, and state addon", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("reports and strictly matches a live PID plus decimal FILETIME", () => {
    const current = binding.getCurrentProcessIdentity();
    expect(current.pid).toBe(process.pid);
    expect(current.creationTime100ns).toMatch(/^[1-9]\d*$/);
    expect(binding.getProcessIdentity(process.pid)).toEqual(current);
    expect(binding.matchesProcessIdentity(current)).toBe(true);
    expect(binding.matchesProcessIdentity({ ...current, creationTime100ns: "1" })).toBe(false);
    const missingPid = 0xffff_ffff;
    expect(() => binding.getProcessIdentity(missingPid)).toThrow(/not found/i);
    expect(binding.matchesProcessIdentity({ pid: missingPid, creationTime100ns: "1" })).toBe(false);
  });

  it("binds current-user DPAPI ciphertext to non-empty session/epoch entropy", () => {
    const entropy = encoder.encode("session=smoke-test;epoch=7");
    const plaintext = encoder.encode("capability-is-never-logged");
    const ciphertext = binding.dpapiProtectCurrentUser(plaintext, entropy);
    expect(ciphertext).not.toEqual(plaintext);
    expect(decoder.decode(binding.dpapiUnprotectCurrentUser(ciphertext, entropy))).toBe(
      "capability-is-never-logged",
    );
    expect(() => binding.dpapiUnprotectCurrentUser(ciphertext, encoder.encode("session=other;epoch=7")))
      .toThrow(/security validation|operation failed|native/i);
    expect(() => binding.dpapiProtectCurrentUser(plaintext, new Uint8Array())).toThrow(/invalid argument/i);
    expect(() => (binding as unknown as { dpapiProtectCurrentUser(data: Uint8Array): Uint8Array })
      .dpapiProtectCurrentUser(plaintext)).toThrow(/invalid argument/i);
  });

  it("keeps state operations in a reparse-free current-user-only directory", () => {
    const directoryPath = mkdtempSync(join(tmpdir(), "prospero-native-state-"));
    directories.push(directoryPath);
    const missingParent = join(directoryPath, "must-not-create");
    expect(() => binding.openSecureStateDirectory({ path: join(missingParent, "state") }))
      .toThrow(/not found/i);
    expect(existsSync(missingParent)).toBe(false);
    const directory = binding.openSecureStateDirectory({ path: join(directoryPath, "state") });
    try {
      binding.writeSecureStateFileAtomically(directory, "manifest.json", encoder.encode('{"epoch":7}'));
      expect(decoder.decode(binding.readSecureStateFile(directory, "manifest.json"))).toBe('{"epoch":7}');
      expect(binding.listSecureStateEntries(directory)).toEqual(["manifest.json"]);
      expect(() => binding.writeSecureStateFileAtomically(directory, "../escape", encoder.encode("x")))
        .toThrow(/invalid argument/i);
      expect(() => binding.readSecureStateFile(directory, "state:ads")).toThrow(/invalid argument/i);
      expect(() => binding.readSecureStateFile(directory, "COM\u00b9.json")).toThrow(/invalid argument/i);
      expect(() => binding.readSecureStateFile(directory, "LPT\u00b2")).toThrow(/invalid argument/i);
      binding.removeSecureStateFile(directory, "manifest.json");
      expect(binding.listSecureStateEntries(directory)).toEqual([]);
    } finally {
      binding.closeSecureStateDirectory(directory);
    }
  });

  it("uses an explicit current-logon-SID DACL and verifies the accepted client identity", async () => {
    const pipeName = `\\\\.\\pipe\\prospero-native-smoke-${process.pid}-${randomUUID()}`;
    let worker: Worker | undefined;
    try {
      worker = new Worker(new URL("./fixtures/native-pipe-server.mjs", import.meta.url), {
        workerData: { bindingPath, pipeName },
      });
      const observer = observeNativePipeWorker(worker);
      await observer.ready;
      const [roundTrip, terminal] = await Promise.all([readPipeRoundTrip(pipeName), observer.terminal]);
      const workerFailure = nativePipeWorkerFailure(terminal);
      if (workerFailure) throw workerFailure;
      expect(roundTrip.kind).toBe("response");
      if (roundTrip.kind !== "response") throw roundTrip.error;
      expect(roundTrip.data.toString("utf8")).toBe("pipe-round-trip");
      const peer = terminal.peer as {
        process: { pid: number; creationTime100ns: string };
        userSid: string;
        sessionId: number;
      };
      expect(terminal.preReadPeerRejected).toBe(true);
      expect(terminal.preReadWriteRejected).toBe(true);
      expect(peer.process.pid).toBe(process.pid);
      expect(peer.process.creationTime100ns).toMatch(/^[1-9]\d*$/);
      expect(peer.userSid).toMatch(/^S-1-\d+(?:-\d+)+$/i);
      expect(peer.sessionId).toBeGreaterThanOrEqual(0);
      expect(peer.sessionId).toBeLessThanOrEqual(0xffff_ffff);
    } finally {
      await terminateWorker(worker);
    }
  });

  it("reports the server worker's native phase before a client pipe close", async () => {
    const pipeName = `\\\\.\\pipe\\prospero-native-diagnostic-${process.pid}-${randomUUID()}`;
    let worker: Worker | undefined;
    try {
      worker = new Worker(new URL("./fixtures/native-pipe-server.mjs", import.meta.url), {
        workerData: { bindingPath, pipeName, failAfterPhase: "read" },
      });
      const observer = observeNativePipeWorker(worker);
      await observer.ready;
      const [roundTrip, terminal] = await Promise.all([readPipeRoundTrip(pipeName), observer.terminal]);
      expect(roundTrip.kind).toBe("error");
      expect(terminal).toMatchObject({
        type: "error",
        phase: "read",
        name: "Error",
        message: "injected native pipe worker failure after read",
      });
      expect(nativePipeWorkerFailure(terminal)?.message).toContain("at read");
    } finally {
      await terminateWorker(worker);
    }
  });

  it("uses a second addon-loaded worker to close an idle ConnectNamedPipe by its opaque handle", async () => {
    const pipeName = `\\\\.\\pipe\\prospero-native-cancel-accept-${process.pid}-${randomUUID()}`;
    const fixture = new URL("./fixtures/native-pipe-cancellation-worker.mjs", import.meta.url);
    let primary: Worker | undefined;
    let control: Worker | undefined;
    try {
      primary = new Worker(fixture, { workerData: { bindingPath, pipeName, role: "primary", scenario: "idle-accept" } });
      control = new Worker(fixture, { workerData: { bindingPath, role: "control" } });
      const server = await waitForWorkerMessage(primary, "server-ready", CANCELLATION_TIMEOUT_MS);
      await waitForWorkerMessage(control, "control-ready", CANCELLATION_TIMEOUT_MS);
      await expect(waitForWorkerMessage(primary, "blocking", CANCELLATION_TIMEOUT_MS)).resolves.toMatchObject({ operation: "accept" });
      const controlComplete = waitForWorkerMessage(control, "control-complete", CANCELLATION_TIMEOUT_MS);
      const unblocked = waitForWorkerMessage(primary, "unblocked", CANCELLATION_TIMEOUT_MS);
      control.postMessage({ action: "close-server", handle: server.server });
      const [cancelled, result] = await Promise.all([controlComplete, unblocked]);
      expect(cancelled.action).toBe("close-server");
      expect(result).toMatchObject({ operation: "accept", code: "PROSPERO_NATIVE_NOT_FOUND", ownerClose: "control-only" });
    } finally {
      await Promise.all([terminateWorker(primary), terminateWorker(control)]);
    }
  });

  it("uses a second addon-loaded worker to disconnect an active ReadFile before the owner performs its one close", async () => {
    const pipeName = `\\\\.\\pipe\\prospero-native-cancel-read-${process.pid}-${randomUUID()}`;
    const fixture = new URL("./fixtures/native-pipe-cancellation-worker.mjs", import.meta.url);
    let primary: Worker | undefined;
    let control: Worker | undefined;
    let client: Socket | undefined;
    try {
      primary = new Worker(fixture, { workerData: { bindingPath, pipeName, role: "primary", scenario: "active-read" } });
      control = new Worker(fixture, { workerData: { bindingPath, role: "control" } });
      await waitForWorkerMessage(primary, "server-ready", CANCELLATION_TIMEOUT_MS);
      await waitForWorkerMessage(control, "control-ready", CANCELLATION_TIMEOUT_MS);
      const connectionReady = waitForWorkerMessage(primary, "connection-ready", CANCELLATION_TIMEOUT_MS);
      client = await connectPipe(pipeName);
      const connection = await connectionReady;
      await expect(waitForWorkerMessage(primary, "blocking", CANCELLATION_TIMEOUT_MS)).resolves.toMatchObject({ operation: "read" });
      const controlComplete = waitForWorkerMessage(control, "control-complete", CANCELLATION_TIMEOUT_MS);
      const unblocked = waitForWorkerMessage(primary, "unblocked", CANCELLATION_TIMEOUT_MS);
      control.postMessage({ action: "disconnect-connection", handle: connection.connection });
      const [cancelled, result] = await Promise.all([controlComplete, unblocked]);
      expect(cancelled.action).toBe("disconnect-connection");
      expect(result).toMatchObject({ operation: "read", code: "PROSPERO_NATIVE_NOT_FOUND", ownerClose: "primary-after-disconnect" });
    } finally {
      client?.destroy();
      await Promise.all([terminateWorker(primary), terminateWorker(control)]);
    }
  });

  it("derives TokenUser internally and rejects caller-selected SID or invalid pipe names", () => {
    const pipeName = `\\\\.\\pipe\\prospero-native-negative-${process.pid}-${randomUUID()}`;
    expect(() => binding.createSecureNamedPipeServer({
      pipeName,
      allowedUserSid: "S-1-5-18",
      maxInstances: 1,
      inboundBufferBytes: 4096,
      outboundBufferBytes: 4096,
    } as unknown as Parameters<RawBinding["createSecureNamedPipeServer"]>[0])).toThrow(/invalid argument/i);
    expect(() => binding.createSecureNamedPipeServer({
      pipeName: "\\\\remote-host\\pipe\\prospero-native-negative",
      maxInstances: 1,
      inboundBufferBytes: 4096,
      outboundBufferBytes: 4096,
    })).toThrow(/invalid argument/i);
    expect(() => binding.createSecureNamedPipeServer({
      pipeName: `\\\\.\\pipe\\${"x".repeat(257)}`,
      maxInstances: 1,
      inboundBufferBytes: 4096,
      outboundBufferBytes: 4096,
    })).toThrow(/invalid argument/i);
    expect(() => binding.createSecureNamedPipeServer({
      pipeName: "\\\\.\\pipe\\prospero/escape",
      maxInstances: 1,
      inboundBufferBytes: 4096,
      outboundBufferBytes: 4096,
    })).toThrow(/invalid argument/i);
  });
});
