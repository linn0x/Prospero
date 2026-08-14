/**
 * Per-session detached structured-agent supervisor.
 *
 * This file is deliberately a tiny executable boundary.  It receives only a
 * path to a 0600 bootstrap file in its environment; capability tokens and
 * account credentials are read from private files and never appear in argv or
 * stdout/stderr.  The daemon is consequently just an IPC client.
 */
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
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
import { startStructuredSupervisor, type SupervisorAdapter } from "./structured-supervisor.js";

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
  tokenFile: string;
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
  environment: Record<string, string>;
  codexAppServerArgs?: string[];
  accountId?: string;
  accountName?: string;
  initialAdapterState?: AdapterResumeState;
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
  const file = process.env["PROSPERO_STRUCTURED_SUPERVISOR_CONFIG"];
  if (!file) throw new Error("missing structured supervisor bootstrap path");
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("unsafe structured supervisor bootstrap");
  }
  const stat = readFileSync(file, "utf8");
  // Delete the transient bootstrap immediately after it has entered this
  // process.  It contains account environment data but is never logged.
  rmSync(file, { force: true });
  const parsed: unknown = JSON.parse(stat);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid supervisor bootstrap");
  const v = parsed as Partial<RunnerConfig>;
  if (
    v.version !== 1 || typeof v.sessionId !== "string" || typeof v.agent !== "string" ||
    typeof v.title !== "string" || typeof v.cwd !== "string" || typeof v.createdAt !== "number" ||
    typeof v.sessionDir !== "string" || typeof v.attachmentRoot !== "string" || typeof v.socketPath !== "string" ||
    !v.environment || typeof v.environment !== "object" || Array.isArray(v.environment)
  ) {
    throw new Error("invalid supervisor bootstrap");
  }
  return v as RunnerConfig;
}

function manifestPath(config: RunnerConfig): string {
  return path.join(config.sessionDir, "manifest.json");
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
      tokenFile: "token",
      lifecycleEpoch: "unknown",
    }),
    ...patch,
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
  const tokenPath = path.join(config.sessionDir, "token");
  if (!existsSync(tokenPath)) throw new Error("missing supervisor capability token");
  if ((statSync(tokenPath).mode & 0o777) !== 0o600) throw new Error("unsafe supervisor capability token");
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
      setTimeout(() => {
        void supervisor?.close().finally(() => process.exit(0));
      }, 25).unref();
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
    void supervisor?.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

void runStructuredSupervisor().catch(() => process.exit(1));
