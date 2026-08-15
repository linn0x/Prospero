/**
 * Per-session detached structured-agent supervisor.
 *
 * This file is deliberately a tiny executable boundary.  It receives only a
 * path to a 0600 bootstrap file in its environment; capability tokens and
 * account credentials are read from private files and never appear in argv or
 * stdout/stderr.  The daemon is consequently just an IPC client.
 */
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ApprovalPolicy,
  AgentKind,
  AgentQuestionAnswer,
  Attachment,
  ChatDelivery,
  ChatSuggestionKind,
  PermissionReply,
} from "@prospero/protocol";
import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { GrokAdapter } from "./adapters/grok.js";
import { OpencodeAdapter } from "./adapters/opencode.js";
import type { AdapterResumeState, AgentAdapter } from "./adapters/types.js";
import { StructuredSession, type StructuredSessionPersistentState } from "./structured-session.js";
import { SUPERVISOR_PROTOCOL_VERSION, startStructuredSupervisor, type SupervisorAdapter } from "./structured-supervisor.js";
import {
  hasPrivateSupervisorDirectoryMode,
  hasPrivateSupervisorFileMode,
  isStructuredSupervisorEndpoint,
  structuredSupervisorPlatformGate,
  structuredSupervisorTransport,
  type StructuredSupervisorTransport,
} from "./structured-supervisor-platform.js";
import {
  createStructuredSupervisorHostLease,
  STRUCTURED_RUNTIME_LEASE_HEARTBEAT_MS,
} from "./structured-supervisor-runtime-lease.js";

export const SUPERVISOR_MANIFEST_VERSION = 1;

export interface StructuredSupervisorManifest {
  version: 1;
  protocolVersion: number;
  implementation: "supervisor";
  sessionId: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  createdAt: number;
  approvalPolicy: ApprovalPolicy;
  socket: string;
  transport?: StructuredSupervisorTransport;
  tokenFile: string;
  /** Private owner directory; socket may use a short endpoint under /tmp. */
  sessionDir?: string;
  supervisorPid?: number;
  lifecycleEpoch: string;
  status?: string;
  updatedAt?: number;
  accountId?: string;
  accountName?: string;
}

interface RunnerConfig {
  version: 1;
  sessionId: string;
  agent: AgentKind;
  title: string;
  cwd: string;
  createdAt: number;
  approvalPolicy?: ApprovalPolicy;
  sessionDir: string;
  attachmentRoot: string;
  socketPath: string;
  transport: StructuredSupervisorTransport;
  lifecycleEpoch: string;
  /** Atomically-created /tmp parent, removed only by this runner on exit. */
  socketDir?: string;
  environment: Record<string, string>;
  codexAppServerArgs?: string[];
  accountId?: string;
  accountName?: string;
  initialAdapterState?: AdapterResumeState;
}

const RUNNER_CONFIG_KEYS = new Set([
  "version", "sessionId", "agent", "title", "cwd", "createdAt", "approvalPolicy",
  "sessionDir", "attachmentRoot", "socketPath", "transport", "lifecycleEpoch", "socketDir",
  "environment", "codexAppServerArgs", "accountId", "accountName", "initialAdapterState",
]);
const LEGACY_RUNNER_CONFIG_KEYS = new Set([...RUNNER_CONFIG_KEYS].filter(
  (key) => key !== "transport" && key !== "lifecycleEpoch",
));
const MANIFEST_KEYS = new Set([
  "version", "protocolVersion", "implementation", "sessionId", "agent", "title", "cwd", "createdAt",
  "approvalPolicy", "socket", "transport", "tokenFile", "sessionDir", "supervisorPid", "lifecycleEpoch",
  "status", "updatedAt", "accountId", "accountName",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function stringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function privateDirectory(dir: string): boolean {
  try {
    const metadata = lstatSync(dir);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && hasPrivateSupervisorDirectoryMode(metadata.mode);
  } catch {
    return false;
  }
}

function validConfigShape(value: Record<string, unknown>, allowLegacyTransport: boolean): boolean {
  const allowed = allowLegacyTransport ? LEGACY_RUNNER_CONFIG_KEYS : RUNNER_CONFIG_KEYS;
  if (!hasOnlyKeys(value, allowed)) return false;
  return value["version"] === 1 &&
    typeof value["sessionId"] === "string" && typeof value["agent"] === "string" &&
    typeof value["title"] === "string" && typeof value["cwd"] === "string" &&
    typeof value["createdAt"] === "number" && Number.isFinite(value["createdAt"]) &&
    (value["approvalPolicy"] === undefined || typeof value["approvalPolicy"] === "string") &&
    typeof value["sessionDir"] === "string" && path.isAbsolute(value["sessionDir"] as string) &&
    typeof value["attachmentRoot"] === "string" && typeof value["socketPath"] === "string" &&
    (value["socketDir"] === undefined || typeof value["socketDir"] === "string") &&
    stringRecord(value["environment"]) &&
    (value["codexAppServerArgs"] === undefined || stringArray(value["codexAppServerArgs"])) &&
    (value["accountId"] === undefined || typeof value["accountId"] === "string") &&
    (value["accountName"] === undefined || typeof value["accountName"] === "string") &&
    (value["initialAdapterState"] === undefined || isRecord(value["initialAdapterState"]));
}

function readLegacyManifest(sessionDir: string): StructuredSupervisorManifest | null {
  const file = path.join(sessionDir, "manifest.json");
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !hasPrivateSupervisorFileMode(metadata.mode)) return null;
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(raw) || !hasOnlyKeys(raw, MANIFEST_KEYS)) return null;
    if (
      raw["version"] !== SUPERVISOR_MANIFEST_VERSION || raw["protocolVersion"] !== SUPERVISOR_PROTOCOL_VERSION ||
      raw["implementation"] !== "supervisor" || typeof raw["sessionId"] !== "string" ||
      typeof raw["agent"] !== "string" || typeof raw["title"] !== "string" || typeof raw["cwd"] !== "string" ||
      typeof raw["createdAt"] !== "number" || !Number.isFinite(raw["createdAt"]) ||
      typeof raw["approvalPolicy"] !== "string" || typeof raw["socket"] !== "string" ||
      // Real schema-1 launchers predate transport entirely.  Only omission or
      // the one Unix value is admissible; null and every other explicit value
      // remain fail-closed before endpoint inference below.
      (raw["transport"] !== undefined && raw["transport"] !== "unix_socket") || raw["tokenFile"] !== "token" ||
      typeof raw["sessionDir"] !== "string" || raw["sessionDir"] !== sessionDir ||
      typeof raw["lifecycleEpoch"] !== "string" || raw["lifecycleEpoch"].length === 0 ||
      (raw["supervisorPid"] !== undefined &&
        (typeof raw["supervisorPid"] !== "number" || !Number.isSafeInteger(raw["supervisorPid"]) || raw["supervisorPid"] <= 1)) ||
      (raw["status"] !== undefined && typeof raw["status"] !== "string") ||
      (raw["updatedAt"] !== undefined && (typeof raw["updatedAt"] !== "number" || !Number.isFinite(raw["updatedAt"]))) ||
      (raw["accountId"] !== undefined && typeof raw["accountId"] !== "string") ||
      (raw["accountName"] !== undefined && typeof raw["accountName"] !== "string")
    ) return null;
    return raw as unknown as StructuredSupervisorManifest;
  } catch {
    return null;
  }
}

/**
 * The original Unix launcher wrote schema-1 bootstrap data before transport
 * and lifecycleEpoch were added. Recover exactly those two values only after
 * binding the private bootstrap to its own private manifest. This is not a
 * general old-schema migration: any added field or identity disagreement is
 * rejected before the child reaches an IPC listener.
 */
function recoverLegacyConfig(value: Record<string, unknown>, bootstrapFile: string): RunnerConfig | null {
  if (process.platform === "win32" || !validConfigShape(value, true)) return null;
  const sessionDir = value["sessionDir"] as string;
  const socketPath = value["socketPath"] as string;
  if (
    path.dirname(bootstrapFile) !== sessionDir || !privateDirectory(sessionDir) ||
    value["attachmentRoot"] !== path.join(sessionDir, "attachments") ||
    (value["socketDir"] !== undefined && path.dirname(socketPath) !== value["socketDir"])
  ) return null;
  const manifest = readLegacyManifest(sessionDir);
  if (!manifest ||
    manifest.sessionId !== value["sessionId"] || manifest.cwd !== value["cwd"] || manifest.socket !== socketPath ||
    manifest.agent !== value["agent"] || manifest.title !== value["title"] || manifest.createdAt !== value["createdAt"] ||
    manifest.approvalPolicy !== (value["approvalPolicy"] ?? "standard") ||
    manifest.accountId !== value["accountId"] || manifest.accountName !== value["accountName"] ||
    !isStructuredSupervisorEndpoint(socketPath, "unix_socket")
  ) return null;
  return {
    ...value,
    transport: "unix_socket",
    lifecycleEpoch: manifest.lifecycleEpoch,
  } as unknown as RunnerConfig;
}

function adapterFor(agent: AgentKind, state?: AdapterResumeState): AgentAdapter {
  switch (agent) {
    case "opencode": return new OpencodeAdapter({ resumeState: state });
    case "claude": return new ClaudeAdapter({ resumeState: state });
    case "codex": return new CodexAdapter({ resumeState: state });
    case "grok": return new GrokAdapter({ resumeState: state });
    default: throw new Error(`agent ${agent} has no structured adapter`);
  }
}

function privateWrite(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function readConfig(): RunnerConfig {
  const platformGate = structuredSupervisorPlatformGate();
  if (platformGate) throw new Error(platformGate);
  const transport = structuredSupervisorTransport();
  if (!transport) throw new Error("structured supervisor transport is unavailable");
  const file = process.env["PROSPERO_STRUCTURED_SUPERVISOR_CONFIG"];
  if (!file) throw new Error("missing structured supervisor bootstrap path");
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !hasPrivateSupervisorFileMode(metadata.mode)) {
    throw new Error("unsafe structured supervisor bootstrap");
  }
  const stat = readFileSync(file, "utf8");
  // Delete the transient bootstrap immediately after it has entered this
  // process.  It contains account environment data but is never logged.
  rmSync(file, { force: true });
  const parsed: unknown = JSON.parse(stat);
  if (!isRecord(parsed)) throw new Error("invalid supervisor bootstrap");
  const v = parsed;
  const current = validConfigShape(v, false) &&
    v["transport"] === "unix_socket" && typeof v["lifecycleEpoch"] === "string" && v["lifecycleEpoch"].length > 0 &&
    path.dirname(file) === v["sessionDir"] && privateDirectory(v["sessionDir"] as string) &&
    v["attachmentRoot"] === path.join(v["sessionDir"] as string, "attachments") &&
    (v["socketDir"] === undefined || path.dirname(v["socketPath"] as string) === v["socketDir"])
      ? v as unknown as RunnerConfig
      : recoverLegacyConfig(v, file);
  if (!current) throw new Error("invalid supervisor bootstrap");
  if (current.transport !== transport || !isStructuredSupervisorEndpoint(current.socketPath, current.transport)) {
    throw new Error("supervisor bootstrap endpoint is incompatible with this platform");
  }
  return current;
}

function manifestPath(config: RunnerConfig): string {
  return path.join(config.sessionDir, "manifest.json");
}

function removeSocketDirectory(config: RunnerConfig): void {
  if (!config.socketDir) return;
  try {
    const metadata = lstatSync(config.socketDir);
    if (metadata.isDirectory() && !metadata.isSymbolicLink() && hasPrivateSupervisorDirectoryMode(metadata.mode)) {
      rmdirSync(config.socketDir);
    }
  } catch {
    // The socket was already closed. Retain a changed/non-empty directory
    // rather than deleting anything beyond the exact launch-owned endpoint.
  }
}

function updateManifest(config: RunnerConfig, patch: Partial<StructuredSupervisorManifest>): void {
  const file = manifestPath(config);
  let current: StructuredSupervisorManifest | null = null;
  try {
    current = JSON.parse(readFileSync(file, "utf8")) as StructuredSupervisorManifest;
  } catch {
    // The launcher writes the authoritative immutable fields before spawn. A
    // partial manifest is still better than making an active session invisible.
  }
  privateWrite(file, {
    ...(current ?? {
      version: SUPERVISOR_MANIFEST_VERSION,
      protocolVersion: 1,
      implementation: "supervisor" as const,
      sessionId: config.sessionId,
      agent: config.agent,
      title: config.title,
      cwd: config.cwd,
      createdAt: config.createdAt,
      approvalPolicy: config.approvalPolicy ?? "standard",
      socket: config.socketPath,
      transport: config.transport,
      tokenFile: "token",
      sessionDir: config.sessionDir,
      lifecycleEpoch: config.lifecycleEpoch,
    }),
    ...patch,
    // A recovered schema-1 manifest intentionally omitted transport. Once
    // bound to this Unix-only runner, persist the inferred authoritative value
    // so subsequent daemon attaches no longer rely on legacy inference.
    transport: config.transport,
    lifecycleEpoch: config.lifecycleEpoch,
    updatedAt: Date.now(),
  });
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid control parameters");
  return value as Record<string, unknown>;
}

/** Calls are explicitly enumerated so IPC cannot become arbitrary code execution. */
async function control(session: StructuredSession, method: string, raw: unknown): Promise<unknown> {
  const params = ensureObject(raw);
  switch (method) {
    case "info": return session.info();
    case "snapshot": return session.snapshot();
    case "transportSnapshot": return session.transportSnapshot();
    case "send":
      if (typeof params["text"] !== "string") throw new Error("text must be a string");
      await session.send(params["text"], params["attachments"] as Attachment[] | undefined, params["delivery"] as ChatDelivery | undefined);
      return { info: session.info() };
    case "setApprovalPolicy":
      await session.setApprovalPolicy(params["policy"] as ApprovalPolicy);
      return { info: session.info() };
    case "complete": return session.complete(params["kind"] as ChatSuggestionKind, String(params["query"] ?? ""));
    case "models": return session.models();
    case "setModel": return session.setModel(String(params["model"] ?? ""), params["effort"] as string | undefined);
    case "modes": return session.modes();
    case "setMode": return session.setMode(String(params["mode"] ?? ""));
    case "compact": await session.compact(); return { info: session.info() };
    case "toolOutput": return session.toolOutput(String(params["callId"] ?? ""));
    case "attachmentChunk": {
      const chunk = await session.attachmentChunk(
        String(params["msgId"] ?? ""), String(params["attachmentId"] ?? ""),
        Number(params["offset"] ?? 0), Number(params["length"] ?? 0),
      );
      return chunk ? { ...chunk, dataB64: chunk.data.toString("base64") } : null;
    }
    case "removeQueued": return session.removeQueued(String(params["queueId"] ?? ""));
    case "guideQueued": return session.guideQueued(String(params["queueId"] ?? ""));
    case "usage": return session.usage();
    case "respondPermission":
      await session.respondPermission(String(params["reqId"] ?? ""), params["reply"] as PermissionReply);
      return { info: session.info() };
    case "respondQuestion":
      await session.respondQuestion(
        String(params["reqId"] ?? ""),
        (params["answers"] as AgentQuestionAnswer[] | undefined) ?? [], params["cancelled"] === true,
      );
      return { info: session.info() };
    case "sendToSubagent":
      await session.sendToSubagent(String(params["subagentId"] ?? ""), String(params["text"] ?? ""));
      return { info: session.info() };
    case "subagentSnapshot": return session.subagentSnapshot(String(params["subagentId"] ?? ""));
    default: throw new Error(`unsupported structured control method: ${method}`);
  }
}

export async function runStructuredSupervisor(): Promise<void> {
  const config = readConfig();
  // The daemon lease permits a live daemon to launch future owners; this
  // independent host lease protects an already-started owner which may lazily
  // load SDK/resources after the daemon exits or is upgraded.
  const hostLease = createStructuredSupervisorHostLease(fileURLToPath(import.meta.url));
  const hostLeaseTimer = hostLease
    ? setInterval(() => {
      try { hostLease.heartbeat(); } catch { /* PID check keeps GC conservative on heartbeat failure */ }
    }, STRUCTURED_RUNTIME_LEASE_HEARTBEAT_MS)
    : undefined;
  hostLeaseTimer?.unref();
  const releaseHostLease = (): void => {
    if (hostLeaseTimer) clearInterval(hostLeaseTimer);
    hostLease?.release();
  };
  process.once("exit", releaseHostLease);
  const tokenPath = path.join(config.sessionDir, "token");
  if (!existsSync(tokenPath)) throw new Error("missing supervisor capability token");
  const tokenMetadata = lstatSync(tokenPath);
  if (!tokenMetadata.isFile() || tokenMetadata.isSymbolicLink() || !hasPrivateSupervisorFileMode(tokenMetadata.mode)) {
    throw new Error("unsafe supervisor capability token");
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) throw new Error("empty supervisor capability token");

  const statePath = path.join(config.sessionDir, "session.json");
  const persist = (session: StructuredSession) => {
    const state: StructuredSessionPersistentState = session.persistentState();
    privateWrite(statePath, state);
    updateManifest(config, { status: session.info().status });
  };
  const session = new StructuredSession({
    id: config.sessionId,
    agent: config.agent,
    title: config.title,
    cwd: config.cwd,
    adapter: adapterFor(config.agent, config.initialAdapterState),
    environment: config.environment,
    ...(config.codexAppServerArgs ? { codexAppServerArgs: config.codexAppServerArgs } : {}),
    ...(config.accountId ? { accountId: config.accountId } : {}),
    ...(config.accountName ? { accountName: config.accountName } : {}),
    ...(config.approvalPolicy ? { approvalPolicy: config.approvalPolicy } : {}),
    attachmentRoot: config.attachmentRoot,
  });
  session.on("persist", () => persist(session));
  session.on("state", () => persist(session));

  let supervisor: Awaited<ReturnType<typeof startStructuredSupervisor>> | null = null;
  const exitAfterClose = () => {
    const current = supervisor;
    if (!current) {
      removeSocketDirectory(config);
      releaseHostLease();
      process.exit(0);
      return;
    }
    void current.close().finally(() => {
      removeSocketDirectory(config);
      releaseHostLease();
      process.exit(0);
    });
  };
  const adapter: SupervisorAdapter = {
    async start(context) {
      session.on("event", (body) => context.emit(body));
      await session.start();
      persist(session);
    },
    interrupt: () => session.interrupt(),
    async kill() {
      await session.dispose();
      persist(session);
      // Allow the kill response to flush first.  This is the only path where a
      // daemon request terminates the supervisor process group.
      setTimeout(exitAfterClose, 25).unref();
    },
    call: (method, params) => control(session, method, params),
  };

  supervisor = await startStructuredSupervisor({
    home: config.sessionDir,
    socketPath: config.socketPath,
    tokenPath,
    token,
  });
  updateManifest(config, { supervisorPid: process.pid, status: "starting" });
  await supervisor.createSession(config.sessionId, adapter);
  updateManifest(config, { status: session.info().status });

  const close = () => {
    // This is a deliberate process-level shutdown, never a daemon-client
    // disconnect.  Do not call session.dispose here: a normal daemon restart
    // never sends us a signal in the first place.
    exitAfterClose();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

void runStructuredSupervisor().catch(() => process.exit(1));
