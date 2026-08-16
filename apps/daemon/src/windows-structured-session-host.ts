/**
 * Structured vertical for the native Windows Session Host.
 *
 * This module runs only in the detached owner.  The daemon never imports an
 * adapter here; it talks to this owner through the common authenticated pipe
 * and consumes the host journal through its Remote facade.
 */
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
import { DeepseekAdapter } from "./adapters/deepseek.js";
import { GrokAdapter } from "./adapters/grok.js";
import { OpencodeAdapter } from "./adapters/opencode.js";
import type { AdapterResumeState, AgentAdapter } from "./adapters/types.js";
import { StructuredSession } from "./structured-session.js";
import type {
  WindowsSessionHostCommandContext,
  WindowsSessionHostCommandOutcome,
  WindowsSessionHostCommandHandler,
  WindowsSessionHostHandlerFactory,
  WindowsSessionHostProviderJob,
} from "./windows-session-host-runner.js";

export interface WindowsStructuredHostBootstrap {
  readonly version: 1;
  readonly agent: AgentKind;
  readonly title: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly environment: Record<string, string>;
  readonly codexAppServerArgs?: readonly string[];
  readonly accountId?: string;
  readonly accountName?: string;
  readonly initialAdapterState?: AdapterResumeState;
}

const STRUCTURED_READ_ONLY_METHODS = new Set([
  "structured.info",
  "structured.snapshot",
  "structured.transportSnapshot",
  "structured.models",
  "structured.modes",
  "structured.toolOutput",
  "structured.persistentState",
  "structured.usage",
  "structured.subagentSnapshot",
  "structured.complete",
]);
const MAX_TERMINAL_STRUCTURED_STATE_BYTES = 4 * 1024 * 1024;

export const WINDOWS_STRUCTURED_READ_ONLY_METHODS = [...STRUCTURED_READ_ONLY_METHODS];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function bootstrap(value: unknown): WindowsStructuredHostBootstrap {
  const keys = ["version", "agent", "title", "cwd", "createdAt", "approvalPolicy", "environment", "codexAppServerArgs", "accountId", "accountName", "initialAdapterState"];
  if (!isRecord(value) || !Object.keys(value).every((key) => keys.includes(key)) || value["version"] !== 1 || typeof value["agent"] !== "string" ||
    typeof value["title"] !== "string" || typeof value["cwd"] !== "string" ||
    typeof value["createdAt"] !== "number" || !Number.isFinite(value["createdAt"]) ||
    !isRecord(value["environment"]) ||
    (value["approvalPolicy"] !== undefined && value["approvalPolicy"] !== "strict" && value["approvalPolicy"] !== "standard" && value["approvalPolicy"] !== "yolo") ||
    (value["accountId"] !== undefined && typeof value["accountId"] !== "string") ||
    (value["accountName"] !== undefined && typeof value["accountName"] !== "string") ||
    (value["initialAdapterState"] !== undefined && !isRecord(value["initialAdapterState"]))) {
    throw new Error("invalid Windows structured Session Host bootstrap");
  }
  const agent = value["agent"] as AgentKind;
  if (agent !== "claude" && agent !== "codex" && agent !== "opencode" && agent !== "grok" && agent !== "deepseek") {
    throw new Error("Windows structured Session Host adapter is unavailable");
  }
  if (!Object.values(value["environment"]).every((entry) => typeof entry === "string") ||
    (value["codexAppServerArgs"] !== undefined && (!Array.isArray(value["codexAppServerArgs"]) ||
      !value["codexAppServerArgs"].every((entry) => typeof entry === "string")))) {
    throw new Error("invalid Windows structured Session Host environment");
  }
  return value as unknown as WindowsStructuredHostBootstrap;
}

function adapterFor(agent: AgentKind, state?: AdapterResumeState): AgentAdapter {
  switch (agent) {
    case "claude": return new ClaudeAdapter({ resumeState: state });
    case "codex": return new CodexAdapter({ resumeState: state });
    case "deepseek": return new DeepseekAdapter({ resumeState: state });
    case "opencode": return new OpencodeAdapter({ resumeState: state });
    case "grok": return new GrokAdapter({ resumeState: state });
    default: throw new Error("Windows structured Session Host adapter is unavailable");
  }
}

function params(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid structured command parameters");
  return value;
}

function snapshot(session: StructuredSession): unknown {
  return { structured: session.persistentState(), info: session.info() };
}

/**
 * The terminal reducer is written before the Job tears down this host. It is
 * deliberately the same full, bounded StructuredSession state used by normal
 * durable recovery, with an explicit terminal bit even when adapter disposal
 * reported an error.
 */
function terminalSnapshot(session: StructuredSession): unknown {
  const state = {
    structured: { ...session.persistentState(), terminal: true as const },
    info: { ...session.info(), status: "done" as const, busySince: undefined },
  };
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_TERMINAL_STRUCTURED_STATE_BYTES) {
    throw new Error("Windows structured Session Host terminal state exceeds its durable bound");
  }
  return state;
}

async function terminateHostJob(job: WindowsSessionHostProviderJob): Promise<void> {
  let failure: unknown;
  try { await job.terminate(); }
  catch (error) { failure = error; }
  try { await job.close(); }
  catch (error) { failure ??= error; }
  if (failure) throw failure;
}

/**
 * All commands that can reach a provider deliberately throw on a provider
 * failure.  The common runner then writes its durable unknown-outcome fence;
 * returning a normal error there would allow an unsafe retry after reconnect.
 */
async function call(
  session: StructuredSession,
  job: WindowsSessionHostProviderJob,
  context: WindowsSessionHostCommandContext,
): Promise<unknown> {
  const value = params(context.params);
  switch (context.method) {
    case "structured.info": return session.info();
    case "structured.snapshot": return session.snapshot();
    case "structured.transportSnapshot": return session.transportSnapshot();
    case "structured.complete": return session.complete(value["kind"] as ChatSuggestionKind, String(value["query"] ?? ""));
    case "structured.models": return session.models();
    case "structured.modes": return session.modes();
    case "structured.toolOutput": return session.toolOutput(String(value["callId"] ?? ""));
    case "structured.persistentState": return session.persistentState();
    case "structured.usage": return session.usage();
    case "structured.subagentSnapshot": return session.subagentSnapshot(String(value["subagentId"] ?? ""));
    case "structured.attachmentChunk": {
      const chunk = await session.attachmentChunk(
        String(value["msgId"] ?? ""), String(value["attachmentId"] ?? ""),
        Number(value["offset"] ?? 0), Number(value["length"] ?? 0),
      );
      return chunk ? { ...chunk, dataB64: chunk.data.toString("base64") } : null;
    }
    case "structured.send": {
      await session.send(
        String(value["text"] ?? ""), value["attachments"] as Attachment[] | undefined,
        value["delivery"] as ChatDelivery | undefined,
      );
      return { info: session.info() };
    }
    case "structured.setApprovalPolicy":
      await session.setApprovalPolicy(value["policy"] as ApprovalPolicy);
      return { info: session.info() };
    case "structured.setModel": return session.setModel(String(value["model"] ?? ""), value["effort"] as string | undefined);
    case "structured.setMode": return session.setMode(String(value["mode"] ?? ""));
    case "structured.compact": await session.compact(); return { info: session.info() };
    case "structured.removeQueued": return session.removeQueued(String(value["queueId"] ?? ""));
    case "structured.guideQueued": return session.guideQueued(String(value["queueId"] ?? ""));
    case "structured.respondPermission":
      await session.respondPermission(String(value["reqId"] ?? ""), value["reply"] as PermissionReply);
      return { info: session.info() };
    case "structured.respondQuestion":
      await session.respondQuestion(
        String(value["reqId"] ?? ""), (value["answers"] as AgentQuestionAnswer[] | undefined) ?? [], value["cancelled"] === true,
      );
      return { info: session.info() };
    case "structured.sendToSubagent":
      await session.sendToSubagent(String(value["subagentId"] ?? ""), String(value["text"] ?? ""));
      return { info: session.info() };
    case "structured.interrupt": await session.interrupt(); return { info: session.info() };
    default: throw new Error("unsupported structured Session Host command");
  }
}

async function kill(
  session: StructuredSession,
  job: WindowsSessionHostProviderJob,
): Promise<WindowsSessionHostCommandOutcome> {
  // The runner already durably recorded kill intent. Dispose while the host
  // remains alive so it can build the full terminal reducer. The destructive
  // Job action runs only after common-runner terminal commit and reply attempt.
  let disposeFailure: unknown;
  try { await session.dispose(); }
  catch (error) { disposeFailure = error; }
  let state: unknown;
  try { state = terminalSnapshot(session); }
  catch (error) {
    return {
      ok: false,
      code: "terminal_state_unavailable",
      message: error instanceof Error ? error.message : "structured Session Host terminal state is unavailable",
      terminal: true,
      // No incomplete snapshot may be committed as a successful terminal
      // facade. The runner sees this marker, returns no success, and closes
      // the host Job through afterReply immediately.
      terminalStateReady: false,
      afterReply: () => terminateHostJob(job),
    };
  }
  if (!disposeFailure) {
    return {
      ok: true, result: { killed: true, info: session.info() }, terminal: true,
      snapshotState: state, afterReply: () => terminateHostJob(job),
    };
  }
  return {
    ok: false,
    code: "kill_dispose_failed",
    message: disposeFailure instanceof Error ? disposeFailure.message : "structured Session Host disposal failed",
    terminal: true,
    snapshotState: state,
    afterReply: () => terminateHostJob(job),
  };
}

export async function createWindowsStructuredSessionHostHandler(
  context: Parameters<WindowsSessionHostHandlerFactory["createWindowsSessionHostHandler"]>[0],
  adapter?: AgentAdapter,
): Promise<WindowsSessionHostCommandHandler> {
  const config = bootstrap(context.handlerOptions);
  const job = await context.createProviderJob();
  const selectedAdapter = adapter ?? adapterFor(config.agent, config.initialAdapterState);
  const session = new StructuredSession({
    id: context.sessionId,
    agent: config.agent,
    title: config.title,
    cwd: config.cwd,
    adapter: selectedAdapter,
    environment: config.environment,
    ...(config.codexAppServerArgs ? { codexAppServerArgs: [...config.codexAppServerArgs] } : {}),
    ...(config.accountId ? { accountId: config.accountId } : {}),
    ...(config.accountName ? { accountName: config.accountName } : {}),
    ...(config.approvalPolicy ? { approvalPolicy: config.approvalPolicy } : {}),
    registerProviderProcess: async (process) => {
      // The host is already in the Job before adapter construction. This is
      // an identity/membership audit only; it must never assign a child after
      // spawn and reopen the containment race it is checking for.
      await job.registerProcess(process);
    },
    // Attachment mutation needs an additional secure native directory API;
    // callers may still use text-only durable structured sessions meanwhile.
    attachmentRoot: path.join(context.stateDirectory, "attachments"),
  });
  let journalFailure: Error | null = null;
  const durableEvent = (payload: unknown): void => {
    void context.emit(payload, { snapshotState: snapshot(session) }).catch(async (error) => {
      journalFailure = error instanceof Error ? error : new Error(String(error));
      // A provider event that cannot receive a durable sequence is unsafe to
      // replay.  Close the Job and leave a clearly fenced, inspectable owner.
      await job.terminate().catch(() => {});
      await job.close().catch(() => {});
    });
  };
  session.on("event", (body, evSeq) => durableEvent({ type: "structured.event", body, evSeq }));
  session.on("state", (info) => durableEvent({ type: "structured.state", info }));
  session.on("persist", () => durableEvent({ type: "structured.persist" }));

  await session.start();
  durableEvent({ type: "structured.started", info: session.info() });

  return {
    async handleCommand(command) {
      if (journalFailure) {
        return {
          ok: false,
          code: "reconciliation_required",
          message: "Windows structured Session Host lost a durable provider event; reconciliation is required",
          terminal: true,
          snapshotState: snapshot(session),
        };
      }
      if (command.method === "structured.send" && isRecord(command.params) && Array.isArray(command.params["attachments"]) && command.params["attachments"].length > 0) {
        // The N-API secure-state API deliberately exposes only one-file
        // primitives today. Do not silently route attachments through Node
        // filesystem paths and pretend that host custody is durable/ACL-safe.
        return {
          ok: false,
          code: "native_capability_missing",
          message: "Windows durable structured attachments require native secure attachment custody",
          snapshotState: snapshot(session),
        };
      }
      if (command.method === "structured.kill") {
        return kill(session, job);
      }
      try {
        return { ok: true, result: await call(session, job, command), snapshotState: snapshot(session) };
      } catch (error) {
        if (STRUCTURED_READ_ONLY_METHODS.has(command.method)) {
          return {
            ok: false,
            code: "read_failed",
            message: error instanceof Error ? error.message : "structured Session Host read failed",
            snapshotState: snapshot(session),
          };
        }
        // Throwing deliberately reaches WindowsSessionHostRunner's
        // unknown_command_outcome fence, which survives a same-command retry.
        throw error;
      }
    },
    snapshotState: () => snapshot(session),
  };
}

/** Dynamic detached-runner entry point. */
export const createWindowsSessionHostHandler = createWindowsStructuredSessionHostHandler;
