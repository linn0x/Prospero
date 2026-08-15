/** Windows PTY provider hosted behind the durable Session Host boundary. */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { OutputRing, toB64, type AgentKind, type SessionInfo, type SessionStatus } from "@prospero/protocol";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import type { ConPtySpawnOptions } from "@prospero/windows-native";
import type { SnapshotResult } from "./pty-session.js";
import type {
  WindowsSessionHostCommandHandler,
  WindowsSessionHostCommandOutcome,
  WindowsSessionHostHandlerFactory,
} from "./windows-session-host-runner.js";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as { Terminal: typeof HeadlessTerminal };
const { SerializeAddon } = require("@xterm/addon-serialize") as { SerializeAddon: typeof SerializeAddonType };

const RING_BYTES = 1024 * 1024;
const INPUT_CHUNK_BYTES = 1024;
const TERMINAL_WORKER_CLOSE_TIMEOUT_MS = 2_000;
const AGENTS = new Set<AgentKind>(["shell", "claude", "codex", "opencode", "grok", "trae", "custom"]);

export interface WindowsPtyProviderBootstrap {
  readonly schemaVersion: 1;
  readonly implementation: "windows-pty-provider";
  readonly id: string;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly cols: number;
  readonly rows: number;
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly accountId?: string;
  readonly accountName?: string;
}

interface TerminalWorkerReply {
  readonly id?: unknown;
  readonly ok?: unknown;
  readonly value?: unknown;
  readonly error?: unknown;
  readonly type?: unknown;
  readonly data?: unknown;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

function ptyFailure(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "pty_host_unavailable" });
}

function validDimension(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 32767;
}

const BOOTSTRAP_KEYS = [
  "schemaVersion", "implementation", "id", "agent", "title", "cwd", "createdAt", "cols", "rows",
  "executablePath", "arguments", "environment", "accountId", "accountName",
] as const;

function hasOnlyBootstrapKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => (BOOTSTRAP_KEYS as readonly string[]).includes(key));
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function safeWindowsAbsolutePath(value: unknown): value is string {
  // Match the native CreateProcess boundary: drive-rooted or non-device UNC,
  // never a current-drive root-relative path such as `\\work`.
  return nonEmptyText(value) && !value.includes("/") && /^(?:[A-Za-z]:\\|\\\\(?![?.]))/.test(value);
}

function safeEnvironment(value: unknown): value is Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(([key, entry]) =>
    key.length > 0 && !key.includes("\0") && !key.includes("=") && !key.includes("\r") && !key.includes("\n") &&
    typeof entry === "string" && !entry.includes("\0"),
  );
}

/** Strict decoder for the only credential-bearing detached provider state. */
export function parseWindowsPtyProviderBootstrap(value: unknown, sessionId: string): WindowsPtyProviderBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw ptyFailure("Windows PTY provider bootstrap is invalid");
  const config = value as Record<string, unknown>;
  const optionalAccount = (name: "accountId" | "accountName"): string | undefined =>
    config[name] === undefined ? undefined : nonEmptyText(config[name]) ? config[name] : undefined;
  if (
    !hasOnlyBootstrapKeys(config) || config.schemaVersion !== 1 || config.implementation !== "windows-pty-provider" || config.id !== sessionId ||
    typeof config.agent !== "string" || !AGENTS.has(config.agent as AgentKind) || !nonEmptyText(config.title) ||
    !safeWindowsAbsolutePath(config.cwd) || !Number.isSafeInteger(config.createdAt) || !validDimension(config.cols) || !validDimension(config.rows) ||
    !safeWindowsAbsolutePath(config.executablePath) || !Array.isArray(config.arguments) ||
    !config.arguments.every((argument) => typeof argument === "string" && !argument.includes("\0")) ||
    !safeEnvironment(config.environment) ||
    (config.accountId !== undefined && optionalAccount("accountId") === undefined) ||
    (config.accountName !== undefined && optionalAccount("accountName") === undefined)
  ) throw ptyFailure("Windows PTY provider bootstrap violates schema");
  const accountId = optionalAccount("accountId");
  const accountName = optionalAccount("accountName");
  return {
    schemaVersion: 1,
    implementation: "windows-pty-provider",
    id: config.id,
    agent: config.agent as AgentKind,
    title: config.title,
    cwd: config.cwd,
    createdAt: config.createdAt as number,
    cols: config.cols as number,
    rows: config.rows as number,
    executablePath: config.executablePath,
    arguments: [...config.arguments] as string[],
    environment: { ...(config.environment as Record<string, string>) },
    ...(accountId === undefined ? {} : { accountId }),
    ...(accountName === undefined ? {} : { accountName }),
  };
}

/** A narrow async proxy; the worker owns all synchronous native handles. */
class WindowsPtyTerminal extends EventEmitter<{ output: [Uint8Array]; terminalFailure: [Error] }> {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private failureReported = false;
  private workerCrashed = false;
  private workerExited = false;

  constructor() {
    super();
    this.worker = new Worker(new URL("./windows-pty-terminal-worker.js", import.meta.url));
    this.worker.on("message", (message: unknown) => this.onMessage(message));
    this.worker.on("error", (error) => {
      this.workerCrashed = true;
      this.reportFailure(error);
    });
    this.worker.on("exit", (code) => {
      this.workerExited = true;
      if (!this.closed) this.reportFailure(ptyFailure(`Windows PTY terminal worker exited (${code})`));
    });
  }

  async start(options: ConPtySpawnOptions): Promise<void> { await this.call("start", { options }); }
  async input(data: Uint8Array): Promise<void> { await this.call("input", { data }); }
  async resize(cols: number, rows: number): Promise<void> { await this.call("resize", { cols, rows }); }
  async interrupt(): Promise<void> { await this.call("interrupt"); }
  async kill(): Promise<void> { await this.call("kill"); }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.workerCrashed && !this.workerExited) {
      try { await this.withCloseBound(this.call("close")); } catch { /* terminate below is containment */ }
    }
    this.failAll(ptyFailure("Windows PTY terminal worker closed"));
    await this.worker.terminate();
  }

  private call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed && op !== "close") return Promise.reject(ptyFailure("Windows PTY terminal worker is closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, op, args }); }
      catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : ptyFailure("Windows PTY terminal worker send failed"));
      }
    });
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const reply = message as TerminalWorkerReply;
    if (reply.type === "output" && reply.data instanceof Uint8Array) {
      this.emit("output", reply.data);
      return;
    }
    if (reply.type === "terminal-error") {
      this.reportFailure(ptyFailure(typeof reply.error === "string" ? reply.error : "Windows ConPTY output failed"));
      return;
    }
    if (typeof reply.id !== "number") return;
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.ok === true) pending.resolve(reply.value);
    else pending.reject(ptyFailure(typeof reply.error === "string" ? reply.error : "Windows PTY terminal operation failed"));
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  /**
   * Worker failures must reach the host even when no RPC happens to be
   * pending. That lets the host durably write a died fence before the worker
   * Job handle is closed by disposal/worker exit.
   */
  private reportFailure(error: Error): void {
    this.failAll(error);
    if (this.failureReported || this.closed) return;
    this.failureReported = true;
    this.emit("terminalFailure", error);
  }

  private async withCloseBound(operation: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(ptyFailure("Windows PTY terminal worker close timed out")), TERMINAL_WORKER_CLOSE_TIMEOUT_MS);
    });
    try { await Promise.race([operation, timeout]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
}

class WindowsPtyHostHandler implements WindowsSessionHostCommandHandler {
  private readonly term: HeadlessTerminal;
  private readonly serializer: SerializeAddonType;
  private readonly ring = new OutputRing(RING_BYTES);
  private readonly decoder = new TextDecoder();
  private readonly terminal = new WindowsPtyTerminal();
  private cols: number;
  private rows: number;
  private status: SessionStatus = "starting";
  private terminalFence = false;
  private outputChain: Promise<void> = Promise.resolve();
  /** Terminal queries can cross UTF-8/output chunks, as in direct PtySession. */
  private queryCarry = "";

  constructor(
    private readonly config: WindowsPtyProviderBootstrap,
    private readonly context: Parameters<WindowsSessionHostHandlerFactory["createWindowsSessionHostHandler"]>[0],
  ) {
    this.cols = config.cols;
    this.rows = config.rows;
    this.term = new Terminal({ cols: config.cols, rows: config.rows, scrollback: 2000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.terminal.on("output", (data) => this.enqueueOutput(data));
    this.terminal.on("terminalFailure", (error) => this.fenceUnexpected(error));
  }

  async start(): Promise<void> {
    await this.terminal.start({
      executablePath: this.config.executablePath,
      arguments: this.config.arguments,
      columns: this.cols,
      rows: this.rows,
      workingDirectory: this.config.cwd,
      environment: this.config.environment,
    });
    this.status = "running";
  }

  async handleCommand(command: { method: string; params: unknown }): Promise<WindowsSessionHostCommandOutcome> {
    const params = command.params && typeof command.params === "object" && !Array.isArray(command.params)
      ? command.params as Record<string, unknown>
      : {};
    try {
      switch (command.method) {
        case "pty.snapshot":
          return { ok: true, result: await this.snapshot() };
        case "pty.status":
          return { ok: true, result: { info: this.info(), lastOutputSeq: this.ring.lastSeq } };
        case "pty.input": {
          if (typeof params.text !== "string") return this.bad("text must be a string");
          await this.input(params.text);
          return { ok: true, result: { info: this.info() } };
        }
        case "pty.resize": {
          if (!validDimension(params.cols) || !validDimension(params.rows)) return this.bad("terminal dimensions are invalid");
          await this.terminal.resize(params.cols, params.rows);
          this.cols = params.cols;
          this.rows = params.rows;
          this.term.resize(this.cols, this.rows);
          return { ok: true, result: { info: this.info() }, snapshotState: await this.snapshotState() };
        }
        case "pty.interrupt":
          await this.terminal.interrupt();
          return { ok: true, result: { info: this.info() } };
        case "pty.kill":
          return this.kill();
        default:
          return this.bad(`unknown Windows PTY command: ${command.method}`, "method_not_found");
      }
    } catch (error) {
      return { ok: false, code: "pty_host_unavailable", message: error instanceof Error ? error.message : "Windows PTY host failed", terminal: this.terminalFence, snapshotState: await this.snapshotState() };
    }
  }

  async snapshotState(): Promise<unknown> {
    const snapshot = await this.snapshot();
    return { provider: "pty", ...snapshot, info: this.info() };
  }

  async dispose(): Promise<void> {
    this.terminalFence = true;
    await this.terminal.dispose();
    this.term.dispose();
  }

  private info(): SessionInfo {
    return {
      id: this.config.id,
      agent: this.config.agent,
      kind: "pty",
      title: this.config.title,
      cwd: this.config.cwd,
      status: this.status,
      createdAt: this.config.createdAt,
      cols: this.cols,
      rows: this.rows,
      ...(this.config.accountId ? { accountId: this.config.accountId } : {}),
      ...(this.config.accountName ? { accountName: this.config.accountName } : {}),
    };
  }

  private bad(message: string, code = "bad_request"): WindowsSessionHostCommandOutcome {
    return { ok: false, code, message };
  }

  private enqueueOutput(data: Uint8Array): void {
    this.outputChain = this.outputChain.then(async () => {
      if (this.terminalFence) return;
      const text = this.decoder.decode(data, { stream: true });
      await this.writeTerm(text);
      await this.answerTerminalQueries(text);
      const outputSeq = this.ring.push(data);
      await this.context.appendEvent({ provider: "pty", type: "output", outputSeq, dataB64: toB64(data) });
    }).catch((error) => this.fenceUnexpected(error instanceof Error ? error : ptyFailure("Windows PTY output journal failed")));
  }

  private async input(text: string): Promise<void> {
    if (this.terminalFence) throw ptyFailure("Windows PTY has a terminal fence");
    const encoded = new TextEncoder().encode(text);
    for (let offset = 0; offset < encoded.byteLength; offset += INPUT_CHUNK_BYTES) {
      await this.terminal.input(encoded.slice(offset, offset + INPUT_CHUNK_BYTES));
    }
  }

  private async snapshot(): Promise<SnapshotResult> {
    await this.outputChain;
    const trailing = this.decoder.decode();
    if (trailing) {
      await this.writeTerm(trailing);
      await this.answerTerminalQueries(trailing);
    }
    await this.writeTerm("");
    return { ansi: this.serializer.serialize(), seq: this.ring.lastSeq, cols: this.cols, rows: this.rows };
  }

  private writeTerm(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  /**
   * ConPTY exposes the provider's terminal queries in its output stream.  The
   * host, not the daemon facade, must answer them after xterm consumed the
   * chunk so cursor coordinates are accurate.  This keeps Ink/crossterm TUI
   * startup behavior parity with the direct PTY fallback.
   */
  private async answerTerminalQueries(chunk: string): Promise<void> {
    const carryLength = this.queryCarry.length;
    const text = this.queryCarry + chunk;
    this.queryCarry = text.slice(-8);
    const hits: string[] = [];
    const scan = (pattern: string, response: () => string): void => {
      for (let index = text.indexOf(pattern); index !== -1; index = text.indexOf(pattern, index + 1)) {
        if (index + pattern.length > carryLength) hits.push(response());
      }
    };
    scan("\x1b[6n", () => {
      const buffer = this.term.buffer.active;
      return `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}R`;
    });
    scan("\x1b[c", () => "\x1b[?6c");
    scan("\x1b[0c", () => "\x1b[?6c");
    scan("\x1b]10;?", () => "\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
    scan("\x1b]11;?", () => "\x1b]11;rgb:0000/0000/0000\x1b\\");
    for (const response of hits) await this.input(response);
  }

  private async kill(): Promise<WindowsSessionHostCommandOutcome> {
    if (this.terminalFence) return { ok: true, result: { info: this.info() }, terminal: true, snapshotState: await this.snapshotState() };
    await this.outputChain;
    this.terminalFence = true;
    this.status = "done";
    // The terminal journal record is the persistent fence.  It must land
    // before the Job Object can terminate the provider tree.
    try {
      await this.context.appendEvent(
        { provider: "pty", type: "terminal", status: "done" },
        { terminal: true, snapshotState: await this.snapshotState() },
      );
    } catch (error) {
      // A storage failure cannot authorize the tree to keep running behind a
      // terminal facade.  Prefer a safely closed provider over an orphan;
      // the common runner will make one final durable terminal-outcome try.
      await this.terminal.dispose().catch(() => {});
      return { ok: false, code: "terminal_fence_unavailable", message: error instanceof Error ? error.message : "Windows PTY terminal fence could not be persisted", terminal: true, snapshotState: await this.snapshotState() };
    }
    try { await this.terminal.kill(); }
    catch (error) {
      return { ok: false, code: "pty_kill_failed", message: error instanceof Error ? error.message : "Windows Job Object termination failed", terminal: true, snapshotState: await this.snapshotState() };
    }
    return { ok: true, result: { info: this.info() }, terminal: true, snapshotState: await this.snapshotState() };
  }

  private fenceUnexpected(error: Error): void {
    if (this.terminalFence) return;
    this.terminalFence = true;
    this.status = "died";
    void (async () => {
      try {
        await this.context.appendEvent(
          { provider: "pty", type: "terminal", status: "died", error: error.message },
          { terminal: true, snapshotState: { provider: "pty", info: this.info(), seq: this.ring.lastSeq } },
        );
      } finally {
        // Even when the journal itself is unavailable, an output-side native
        // failure must not leave a provider tree alive without an owner that
        // can prove its cursor.  The terminal worker's Job closes the whole
        // tree using the same bounded ConPTY teardown path as explicit kill.
        await this.terminal.dispose().catch(() => {});
      }
    })();
  }
}

/** Factory loaded only by the detached Windows Session Host process. */
export async function createWindowsSessionHostHandler(
  context: Parameters<WindowsSessionHostHandlerFactory["createWindowsSessionHostHandler"]>[0],
): Promise<WindowsSessionHostCommandHandler> {
  const bytes = await context.consumeProviderBootstrap();
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw ptyFailure("Windows PTY provider bootstrap JSON is invalid"); }
  const handler = new WindowsPtyHostHandler(parseWindowsPtyProviderBootstrap(parsed, context.sessionId), context);
  try {
    await handler.start();
    return handler;
  } catch (error) {
    await handler.dispose().catch(() => {});
    throw error;
  }
}
