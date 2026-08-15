/**
 * Dedicated owner of one ConPTY + provider Job Object.
 *
 * The Session Host's native pipe worker can block in ConnectNamedPipe.  Keep
 * terminal draining in this separate worker so a daemon that is disconnected
 * (or merely idle) can never stop ConPTY output from reaching the durable
 * host reducer.
 */
import { parentPort } from "node:worker_threads";
import {
  loadWindowsNative,
  type ConPtyHandle,
  type ConPtySpawnOptions,
  type JobObjectHandle,
  type NativeWindowsBinding,
} from "@prospero/windows-native";

if (!parentPort) throw new Error("Windows PTY terminal worker requires a parent port");

interface Request {
  readonly id: number;
  readonly op: string;
  readonly args?: Record<string, unknown>;
}

let native: NativeWindowsBinding | null = null;
let terminal: ConPtyHandle | null = null;
let job: JobObjectHandle | null = null;
let drainTimer: NodeJS.Timeout | null = null;
let closed = false;

function binding(): NativeWindowsBinding {
  if (!native) native = loadWindowsNative();
  return native;
}

function activeTerminal(): ConPtyHandle {
  if (terminal === null) throw new Error("ConPTY is not active");
  return terminal;
}

function activeJob(): JobObjectHandle {
  if (job === null) throw new Error("ConPTY Job Object is not active");
  return job;
}

function dimensions(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 32767) {
    throw new Error(`${name} is invalid`);
  }
  return value as number;
}

function bytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${name} must be Uint8Array`);
  return value;
}

function startDrain(): void {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    if (terminal === null || closed) return;
    try {
      const data = binding().readConPty(terminal, 64 * 1024);
      if (data.byteLength > 0) parentPort!.postMessage({ type: "output", data });
    } catch (error) {
      // A broken ConPTY output pipe is expected after explicit Job teardown;
      // report only while a terminal remains owned so the host can fence it.
      if (terminal !== null) parentPort!.postMessage({ type: "terminal-error", error: error instanceof Error ? error.message : String(error) });
    }
  }, 8);
  drainTimer.unref?.();
}

function stopDrain(): void {
  if (!drainTimer) return;
  clearInterval(drainTimer);
  drainTimer = null;
}

function closeProvider(terminate: boolean): void {
  stopDrain();
  const currentTerminal = terminal;
  const currentJob = job;
  terminal = null;
  job = null;
  // The durable host records its terminal fence before asking us to enter
  // this path.  TerminateJobObject owns the complete provider tree; closing
  // ConPTY afterward follows the native anti-deadlock ordering.
  try {
    if (terminate && currentJob !== null) binding().terminateJobObject(currentJob, 0xC000013A);
  } finally {
    try { if (currentTerminal !== null) binding().closeConPty(currentTerminal); }
    finally { if (currentJob !== null) binding().closeJobObject(currentJob); }
  }
}

// A normal detached-host shutdown may occur without a final RPC (for example
// after a bootstrap/factory failure). Explicitly close the provider Job on
// worker/process teardown; KILL_ON_JOB_CLOSE then contains ConPTY and every
// provider descendant. Forced host termination also closes this kernel handle,
// but this hook covers orderly exits deterministically.
process.once("exit", () => {
  try { closeProvider(true); } catch { /* process teardown cannot recover */ }
});

parentPort.once("close", () => {
  closed = true;
  try { closeProvider(true); } catch { /* parent loss still closes OS handles */ }
});

function request(op: string, args: Record<string, unknown>): unknown {
  switch (op) {
    case "start": {
      if (terminal !== null || job !== null) throw new Error("ConPTY is already active");
      const input = args["options"] as Partial<ConPtySpawnOptions> | undefined;
      if (!input || typeof input.executablePath !== "string" || !Array.isArray(input.arguments) ||
        !input.arguments.every((value) => typeof value === "string")) {
        throw new Error("ConPTY launch options are invalid");
      }
      const providerJob = binding().createJobObject({ killOnClose: true });
      try {
        const spawned = binding().spawnConPty({
          executablePath: input.executablePath,
          arguments: input.arguments,
          columns: dimensions(input.columns, "columns"),
          rows: dimensions(input.rows, "rows"),
          ...(typeof input.workingDirectory === "string" ? { workingDirectory: input.workingDirectory } : {}),
          ...(input.environment && typeof input.environment === "object" ? { environment: input.environment } : {}),
          job: providerJob,
        });
        job = providerJob;
        terminal = spawned;
        startDrain();
      } catch (error) {
        try { binding().terminateJobObject(providerJob, 1); } catch { /* no child may have started */ }
        try { binding().closeJobObject(providerJob); } catch { /* primary failure wins */ }
        throw error;
      }
      return undefined;
    }
    case "input": {
      const payload = bytes(args["data"], "ConPTY input");
      let offset = 0;
      while (offset < payload.byteLength) {
        const written = binding().writeConPty(activeTerminal(), payload.slice(offset));
        if (written <= 0) throw new Error("ConPTY input write made no progress");
        offset += written;
      }
      return undefined;
    }
    case "resize":
      binding().resizeConPty(activeTerminal(), dimensions(args["cols"], "cols"), dimensions(args["rows"], "rows"));
      return undefined;
    case "interrupt":
      binding().writeConPty(activeTerminal(), new TextEncoder().encode("\u0003"));
      return undefined;
    case "kill":
      closeProvider(true);
      return undefined;
    case "close":
      closeProvider(true);
      closed = true;
      return undefined;
    default:
      throw new Error(`unknown Windows PTY terminal operation: ${op}`);
  }
}

function reply(id: number, ok: boolean, value?: unknown, error?: unknown): void {
  parentPort!.postMessage(ok ? { id, ok, value } : { id, ok, error: String(error) });
}

parentPort.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const requestMessage = message as Partial<Request>;
  if (typeof requestMessage.id !== "number" || !Number.isSafeInteger(requestMessage.id) || typeof requestMessage.op !== "string") return;
  try { reply(requestMessage.id, true, request(requestMessage.op, requestMessage.args ?? {})); }
  catch (error) { reply(requestMessage.id, false, undefined, error instanceof Error ? error.message : error); }
});
