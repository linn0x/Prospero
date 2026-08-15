import { createRequire } from "node:module";
import { createConnection, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SecurePipeRoundTripState } from "./secure-pipe-roundtrip-state.js";
import { observeWorkerMessages, type WorkerMessage } from "./worker-message-observer.js";

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
const PIPE_ROUND_TRIP_TIMEOUT_MS = 10_000;
const PIPE_ROUND_TRIP_REQUEST = Buffer.from("pipe-round-trip");
const PIPE_ROUND_TRIP_ACK = Buffer.from("pipe-round-trip-ack");

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

type NativePipeWorkerMessage = WorkerMessage;
type NativePipeWorkerTerminal =
  | (NativePipeWorkerMessage & { type: "complete" })
  | (NativePipeWorkerMessage & { type: "error" });
type PipeRoundTripResult =
  | { readonly kind: "response"; readonly data: Uint8Array; readonly orderlyEpipe?: boolean }
  | { readonly kind: "error"; readonly error: Error };

function socketFailure(stage: string, cause?: unknown): Error {
  const socketError = cause && typeof cause === "object" ? cause as NodeJS.ErrnoException : undefined;
  const code = typeof socketError?.code === "string" ? socketError.code : undefined;
  const detail = cause instanceof Error ? `: ${cause.message}` : "";
  const error = new Error(`Named pipe ${stage}${code ? ` (${code})` : ""}${detail}`);
  if (code) Object.assign(error, { code });
  return error;
}

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

function readPipeRoundTrip(
  pipeName: string,
  terminal: Promise<NativePipeWorkerTerminal>,
  timeoutMs = PIPE_ROUND_TRIP_TIMEOUT_MS,
): Promise<PipeRoundTripResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(pipeName);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const state = new SecurePipeRoundTripState(PIPE_ROUND_TRIP_REQUEST);
    let acknowledgementStarted = false;
    const onConnect = () => {
      try {
        socket.write(PIPE_ROUND_TRIP_REQUEST, (error) => {
          if (error) finish({ kind: "error", error });
        });
      } catch (error) {
        finish({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    const onData = (data: Buffer) => {
      const shouldEndAcknowledgement = state.receiveEcho(data);
      settleState();
      if (!shouldEndAcknowledgement || acknowledgementStarted || settled) return;
      acknowledgementStarted = true;
      try {
        // Half-close the client write side.  `end`'s callback has no error
        // parameter; write failures arrive only through the socket `error`
        // event, which the state machine classifies below.
        socket.end(PIPE_ROUND_TRIP_ACK, () => {
          state.acknowledgementFinished();
          settleState();
        });
      } catch (error) {
        finish({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    const onError = (error: Error) => {
      state.socketError(error);
      settleState();
    };
    const onEnd = () => {
      state.socketEnded();
      settleState();
    };
    const onClose = () => {
      state.socketClosed();
      settleState();
    };
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
    };
    const finish = (result: PipeRoundTripResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!socket.destroyed) socket.destroy();
      resolve(result);
    };
    const settleState = () => {
      const outcome = state.outcome;
      if (outcome.kind === "response") finish(outcome);
      else if (outcome.kind === "error") finish(outcome);
    };
    timeout = setTimeout(
      () => {
        state.timedOut(timeoutMs);
        settleState();
      },
      timeoutMs,
    );
    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onClose);
    void terminal.then((message) => {
      state.serverTerminal(message);
      settleState();
    });
  });
}

/** Read the echo then deliberately abort before the required ACK. */
function readPipeResponseThenDisconnect(pipeName: string, timeoutMs = PIPE_ROUND_TRIP_TIMEOUT_MS): Promise<PipeRoundTripResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(pipeName);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let response = Buffer.alloc(0);
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onClose);
    };
    const finish = (result: PipeRoundTripResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!socket.destroyed) socket.destroy();
      resolve(result);
    };
    const onConnect = () => {
      try {
        socket.write(PIPE_ROUND_TRIP_REQUEST, (error) => {
          if (error) finish({ kind: "error", error: socketFailure("request write failed", error) });
        });
      } catch (error) {
        finish({ kind: "error", error: socketFailure("request write threw", error) });
      }
    };
    const onData = (data: Buffer) => {
      response = Buffer.concat([response, data]);
      if (response.byteLength > PIPE_ROUND_TRIP_REQUEST.byteLength ||
        !PIPE_ROUND_TRIP_REQUEST.subarray(0, response.byteLength).equals(response)) {
        finish({ kind: "error", error: socketFailure("returned an invalid roundtrip response") });
        return;
      }
      if (response.byteLength === PIPE_ROUND_TRIP_REQUEST.byteLength) finish({ kind: "response", data: response });
    };
    const onError = (error: Error) => finish({ kind: "error", error: socketFailure("socket error", error) });
    const onEnd = () => finish({ kind: "error", error: socketFailure("ended before the roundtrip response") });
    const onClose = () => finish({ kind: "error", error: socketFailure("closed before the roundtrip response") });
    timeout = setTimeout(
      () => finish({ kind: "error", error: socketFailure(`roundtrip timed out after ${timeoutMs}ms`) }),
      timeoutMs,
    );
    socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.once("close", onClose);
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

type NativeWriteError = Error & {
  readonly code?: unknown;
  readonly win32ErrorCategory?: unknown;
};

function captureNativeError(action: () => unknown): NativeWriteError {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) return error as NativeWriteError;
    throw error;
  }
  throw new Error("expected a native error");
}

function nativeErrorCode(action: () => unknown): string {
  const code = captureNativeError(action).code;
  if (typeof code === "string") return code;
  throw new Error("expected native error code");
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

  it("first-writes, round-trips, and atomically replaces state in a reparse-free current-user-only directory", () => {
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
      // Exercise the replace path too: it must remain an atomic same-directory
      // rename, rather than a delete-and-recreate fallback.
      binding.writeSecureStateFileAtomically(directory, "manifest.json", encoder.encode('{"epoch":8}'));
      expect(decoder.decode(binding.readSecureStateFile(directory, "manifest.json"))).toBe('{"epoch":8}');
      expect(binding.listSecureStateEntries(directory)).toEqual(["manifest.json"]);
      expect(nativeErrorCode(() => (binding as unknown as {
        writeSecureStateFileAtomically(directory: number, fileName: string, data: Uint8Array): void;
      }).writeSecureStateFileAtomically(Number(directory), "manifest.json", encoder.encode("x"))))
        .toBe("PROSPERO_NATIVE_INVALID_ARGUMENT");
      const rejectedName = "../state-path-must-not-appear";
      const rejectedContents = "state-bytes-must-not-appear";
      const rejectedWrite = captureNativeError(() => binding.writeSecureStateFileAtomically(
        directory, rejectedName, encoder.encode(rejectedContents),
      ));
      expect(rejectedWrite.code).toBe("PROSPERO_NATIVE_SECURE_STATE_WRITE_VALIDATE");
      expect(rejectedWrite.win32ErrorCategory).toBe("none");
      expect(rejectedWrite.message).not.toContain(rejectedName);
      expect(rejectedWrite.message).not.toContain(rejectedContents);
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
      const [roundTrip, terminal] = await Promise.all([readPipeRoundTrip(pipeName, observer.terminal), observer.terminal]);
      // Fail with the client socket's original code before an assertion can
      // hide it behind an expected/unexpected-result diff.
      if (roundTrip.kind !== "response") throw roundTrip.error;
      const workerFailure = nativePipeWorkerFailure(terminal);
      if (workerFailure) throw workerFailure;
      expect(roundTrip.kind).toBe("response");
      expect(Buffer.from(roundTrip.data).toString("utf8")).toBe("pipe-round-trip");
      expect(typeof roundTrip.orderlyEpipe).toBe("boolean");
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
      expect(terminal.acknowledged).toBe(true);
    } finally {
      await terminateWorker(worker);
    }
  });

  it("returns the echo before a client disconnect makes the server ACK read fail", async () => {
    const pipeName = `\\\\.\\pipe\\prospero-native-disconnect-${process.pid}-${randomUUID()}`;
    let worker: Worker | undefined;
    try {
      worker = new Worker(new URL("./fixtures/native-pipe-server.mjs", import.meta.url), {
        workerData: { bindingPath, pipeName },
      });
      const observer = observeNativePipeWorker(worker);
      await observer.ready;
      const [roundTrip, terminal] = await Promise.all([readPipeResponseThenDisconnect(pipeName), observer.terminal]);
      // Just as in the normal duplex test, report a concrete client socket
      // failure before any expectation can obscure it.
      if (roundTrip.kind !== "response") throw roundTrip.error;
      expect(Buffer.from(roundTrip.data).toString("utf8")).toBe("pipe-round-trip");
      expect(terminal).toMatchObject({
        type: "error",
        phase: "ack-read",
        code: "PROSPERO_NATIVE_NOT_FOUND",
      });
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
      const [roundTrip, terminal] = await Promise.all([readPipeRoundTrip(pipeName, observer.terminal), observer.terminal]);
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
      const primaryMessages = observeWorkerMessages(primary);
      // Register every startup phase before either worker is awaited. The
      // primary can post both of these while the control worker is loading.
      const serverReady = primaryMessages.waitFor("server-ready", CANCELLATION_TIMEOUT_MS);
      const acceptReady = primaryMessages.waitFor("accept-ready", CANCELLATION_TIMEOUT_MS);
      control = new Worker(fixture, { workerData: { bindingPath, role: "control" } });
      const controlMessages = observeWorkerMessages(control);
      const controlReady = controlMessages.waitFor("control-ready", CANCELLATION_TIMEOUT_MS);
      const [server] = await Promise.all([serverReady, controlReady, acceptReady]);
      await expect(acceptReady).resolves.toMatchObject({
        phase: "ready-for-accept",
      });
      const acceptStarted = primaryMessages.waitFor("accept-started", CANCELLATION_TIMEOUT_MS);
      const controlComplete = controlMessages.waitFor("control-complete", CANCELLATION_TIMEOUT_MS);
      const unblocked = primaryMessages.waitFor("unblocked", CANCELLATION_TIMEOUT_MS);
      const closeStarted = controlMessages.waitFor("close-started", CANCELLATION_TIMEOUT_MS);
      primary.postMessage({ action: "start-idle-accept" });
      await expect(acceptStarted).resolves.toMatchObject({ operation: "accept", phase: "ConnectNamedPipe" });
      control.postMessage({ action: "close-server", handle: server.server });
      const [started, cancelled, result] = await Promise.all([closeStarted, controlComplete, unblocked]);
      expect(started).toMatchObject({ action: "close-server", phase: "close-server" });
      expect(cancelled).toMatchObject({ action: "close-server", phase: "closed" });
      expect(result).toMatchObject({
        operation: "accept",
        code: "PROSPERO_NATIVE_NOT_FOUND",
        ownerClose: "control-only",
        phase: "accept-unblocked",
      });
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
      const primaryMessages = observeWorkerMessages(primary);
      const serverReady = primaryMessages.waitFor("server-ready", CANCELLATION_TIMEOUT_MS);
      control = new Worker(fixture, { workerData: { bindingPath, role: "control" } });
      const controlMessages = observeWorkerMessages(control);
      // The control worker can report ready before the primary server does;
      // retain both startup messages before awaiting either one.
      const controlReady = controlMessages.waitFor("control-ready", CANCELLATION_TIMEOUT_MS);
      await Promise.all([serverReady, controlReady]);
      const connectionReady = primaryMessages.waitFor("connection-ready", CANCELLATION_TIMEOUT_MS);
      const blocking = primaryMessages.waitFor("blocking", CANCELLATION_TIMEOUT_MS);
      client = await connectPipe(pipeName);
      const connection = await connectionReady;
      await expect(blocking).resolves.toMatchObject({ operation: "read" });
      const controlComplete = controlMessages.waitFor("control-complete", CANCELLATION_TIMEOUT_MS);
      const unblocked = primaryMessages.waitFor("unblocked", CANCELLATION_TIMEOUT_MS);
      const closeStarted = controlMessages.waitFor("close-started", CANCELLATION_TIMEOUT_MS);
      control.postMessage({ action: "disconnect-connection", handle: connection.connection });
      const [started, cancelled, result] = await Promise.all([closeStarted, controlComplete, unblocked]);
      expect(started).toMatchObject({ action: "disconnect-connection", phase: "disconnect-connection" });
      expect(cancelled).toMatchObject({ action: "disconnect-connection", phase: "closed" });
      expect(result).toMatchObject({
        operation: "read",
        code: "PROSPERO_NATIVE_NOT_FOUND",
        ownerClose: "primary-after-disconnect",
        phase: "read-unblocked",
      });
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
