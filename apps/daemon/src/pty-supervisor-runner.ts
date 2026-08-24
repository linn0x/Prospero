/**
 * Detached owner for one PTY/TUI session. Its only bootstrap input is a 0600
 * file path; the daemon never owns the node-pty handle after launch.
 */
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PtySession, type PtySessionOptions } from "./pty-session.js";
import {
  PTY_SUPERVISOR_MANIFEST_VERSION,
  PTY_SUPERVISOR_PROTOCOL_VERSION,
  startPtySupervisor,
  type PtySupervisorManifest,
} from "./pty-supervisor-protocol.js";

interface RunnerConfig extends PtySessionOptions {
  version: 1;
  sessionDir: string;
  socketPath: string;
  socketDir?: string;
}

const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const AGENTS = new Set(["shell", "claude", "codex", "opencode", "grok", "trae", "custom"]);
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 2_000;

function privateWrite(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

function readConfig(): RunnerConfig {
  const file = process.env["PROSPERO_PTY_SUPERVISOR_CONFIG"];
  if (!file) throw new Error("missing PTY host bootstrap path");
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("unsafe PTY host bootstrap");
  }
  const raw = readFileSync(file, "utf8");
  // It may contain account environment variables. It must not survive process
  // startup or appear in argv/logs.
  rmSync(file, { force: true });
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid PTY host bootstrap");
  const config = value as Partial<RunnerConfig>;
  if (
    config.version !== 1 || typeof config.id !== "string" || !SESSION_ID.test(config.id) ||
    typeof config.agent !== "string" || !AGENTS.has(config.agent) ||
    typeof config.title !== "string" || typeof config.cwd !== "string" ||
    !Number.isSafeInteger(config.createdAt) ||
    typeof config.cols !== "number" || !Number.isInteger(config.cols) || config.cols < 1 || config.cols > 10_000 ||
    typeof config.rows !== "number" || !Number.isInteger(config.rows) || config.rows < 1 || config.rows > 10_000 ||
    typeof config.file !== "string" || !Array.isArray(config.args) ||
    !config.args.every((arg) => typeof arg === "string") ||
    !config.env || typeof config.env !== "object" || Array.isArray(config.env) ||
    !Object.values(config.env).every((value) => typeof value === "string") ||
    typeof config.sessionDir !== "string" || !path.isAbsolute(config.sessionDir) ||
    typeof config.socketPath !== "string" || !path.isAbsolute(config.socketPath) ||
    (config.socketDir !== undefined && (
      typeof config.socketDir !== "string" || !path.isAbsolute(config.socketDir) ||
      path.dirname(config.socketPath) !== config.socketDir
    ))
  ) {
    throw new Error("invalid PTY host bootstrap");
  }
  return config as RunnerConfig;
}

function manifestFile(config: RunnerConfig): string {
  return path.join(config.sessionDir, "manifest.json");
}

function updateManifest(config: RunnerConfig, patch: Partial<PtySupervisorManifest>): void {
  const file = manifestFile(config);
  let current: PtySupervisorManifest | null = null;
  try { current = JSON.parse(readFileSync(file, "utf8")) as PtySupervisorManifest; } catch { /* launcher owns immutable seed */ }
  privateWrite(file, {
    ...(current ?? {
      version: PTY_SUPERVISOR_MANIFEST_VERSION,
      protocolVersion: PTY_SUPERVISOR_PROTOCOL_VERSION,
      implementation: "pty-supervisor" as const,
      sessionId: config.id,
      agent: config.agent,
      title: config.title,
      cwd: config.cwd,
      createdAt: config.createdAt,
      cols: config.cols,
      rows: config.rows,
      socket: config.socketPath,
      tokenFile: "token" as const,
      sessionDir: config.sessionDir,
      lifecycleEpoch: "unknown",
      ownerState: "active" as const,
    }),
    ...patch,
    updatedAt: Date.now(),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(groupId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function waitForProcessGroupExit(groupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(groupId) && Date.now() < deadline) await delay(20);
  return !processGroupAlive(groupId);
}

/**
 * Explicit kill is an owner operation, not a best-effort PTY detach.  The
 * runner stays alive long enough to escalate the exact forkpty process group,
 * including helpers started by the terminal program.
 */
async function terminatePtyTree(session: PtySession): Promise<boolean> {
  session.kill();
  if (process.platform === "win32") return false;
  const groupId = session.pid;
  if (!Number.isSafeInteger(groupId) || groupId <= 1 || !processGroupAlive(groupId)) return true;
  signalProcessGroup(groupId, "SIGTERM");
  if (await waitForProcessGroupExit(groupId, TERM_GRACE_MS)) return true;
  signalProcessGroup(groupId, "SIGKILL");
  return waitForProcessGroupExit(groupId, KILL_GRACE_MS);
}

function removeSocketDirectory(config: RunnerConfig): void {
  if (!config.socketDir) return;
  try {
    const metadata = lstatSync(config.socketDir);
    if (metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o700) {
      rmdirSync(config.socketDir);
    }
  } catch {
    // Retain changed/non-empty directories instead of widening cleanup scope.
  }
}

export async function runPtySupervisor(): Promise<void> {
  const config = readConfig();
  const tokenPath = path.join(config.sessionDir, "token");
  const tokenMetadata = existsSync(tokenPath) ? lstatSync(tokenPath) : null;
  if (!tokenMetadata || !tokenMetadata.isFile() || tokenMetadata.isSymbolicLink() || (tokenMetadata.mode & 0o777) !== 0o600) {
    throw new Error("missing or unsafe PTY host token");
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error("empty PTY host token");

  const session = new PtySession(config);
  let supervisor: Awaited<ReturnType<typeof startPtySupervisor>> | null = null;
  let closePromise: Promise<void> | null = null;
  const closeOwner = (explicitKill: boolean): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (explicitKill) {
        // This is the sole RPC/signal path that ends the PTY tree. Daemon
        // disconnects only close their client socket and never reach here.
        updateManifest(config, { ownerState: "killed", status: "done" });
      }
      // Stop accepting new control traffic only after the kill response has
      // flushed (the protocol invokes this callback from socket.write()).
      await (supervisor?.close() ?? Promise.resolve());
      if (explicitKill) {
        const terminated = await terminatePtyTree(session);
        if (!terminated) {
          // Do not leave a misleading "done" audit if the exact owner group
          // resisted both signals. A later daemon must keep it read-only.
          updateManifest(config, { ownerState: "failed", status: "died" });
        }
      }
      await session.dispose();
      removeSocketDirectory(config);
    })();
    void closePromise.finally(() => process.exit(0));
    return closePromise;
  };
  session.on("state", (info) => updateManifest(config, { status: info.status }));
  supervisor = await startPtySupervisor({
    socketPath: config.socketPath,
    token,
    session,
    onExplicitKill: () => { void closeOwner(true); },
  });
  updateManifest(config, { supervisorPid: process.pid, ownerState: "active", status: session.info().status });

  // A daemon restart merely closes its client socket and never signals this
  // process. A real signal is therefore an owner shutdown (including launch
  // rollback), and must terminate the PTY tree rather than orphan it.
  const terminateOwner = () => { void closeOwner(true); };
  process.once("SIGTERM", terminateOwner);
  process.once("SIGINT", terminateOwner);
}

void runPtySupervisor().catch((error) => {
  // The launcher normally uses ignored stdio; this remains useful for an
  // operator-run runner and deliberately prints only the error message, not
  // its protected bootstrap/environment contents.
  process.stderr.write(`PTY host failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
