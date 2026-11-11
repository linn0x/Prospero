import type {
  AbandonRun, ApplyTaskGraph, CancelTask, CleanupWorktree, CompleteRun, CreateRun,
  CreateRunGraph, CreateTask, SettleDispatch, StartAutomation, StartWorker, StopWorker,
} from "@prospero/protocol/rust-daemon";
import type { RustClient } from "./rust-client";
import { createLegacyDesktopProjection } from "./orchestration-projection";
import type { JsonObject } from "../shared/types";

const PROJECTED_RUN_LIMIT = 100;
const PROJECTED_TASK_LIMIT = 2_000;
const PROJECTED_DISPATCH_LIMIT = 2_000;
const PROJECTED_GATE_LIMIT = 1_000;
const PROJECTED_WORKTREE_LIMIT = 1_000;
export const ORCHESTRATION_FETCH_CONCURRENCY = 6;
export const ORCHESTRATION_RUN_CACHE_LIMIT = 256;
const ACTIVE_RUN_CACHE_TTL_MS = 5_000;
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "stopped",
  "abandoned",
  "done",
]);

type RunTask = Awaited<ReturnType<RustClient["listTasks"]>>[number] & { runtime?: JsonObject };
type HydratedRunSlice = {
  signature: string;
  terminal: boolean;
  cachedAt: number;
  tasks: RunTask[];
  dispatches: Awaited<ReturnType<RustClient["listDispatches"]>>;
  gates: Awaited<ReturnType<RustClient["listGates"]>>;
  worktreeAssets: Awaited<ReturnType<RustClient["listWorktreeAssets"]>>;
};

const runHydrationCacheByClient = new WeakMap<object, Map<string, HydratedRunSlice>>();

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function runCacheSignature(run: { id: string; status: string; updatedAt: number } & Record<string, unknown>): string {
  return `${run.id}\0${run.status}\0${String(run.updatedAt ?? "")}\0${String(run["graphRevision"] ?? "")}`;
}

function getClientRunCache(client: RustClient): Map<string, HydratedRunSlice> {
  let cache = runHydrationCacheByClient.get(client);
  if (!cache) {
    cache = new Map<string, HydratedRunSlice>();
    runHydrationCacheByClient.set(client, cache);
  }
  return cache;
}

function readCachedRunSlice(
  cache: Map<string, HydratedRunSlice>,
  run: { id: string; status: string; updatedAt: number } & Record<string, unknown>,
  now: number,
): HydratedRunSlice | undefined {
  const cached = cache.get(run.id);
  if (!cached) return undefined;
  if (cached.signature !== runCacheSignature(run)) return undefined;
  if (!cached.terminal && now - cached.cachedAt > ACTIVE_RUN_CACHE_TTL_MS) return undefined;
  cache.delete(run.id);
  cache.set(run.id, cached);
  return cached;
}

function writeCachedRunSlice(cache: Map<string, HydratedRunSlice>, runId: string, slice: HydratedRunSlice): void {
  cache.delete(runId);
  cache.set(runId, slice);
  while (cache.size > ORCHESTRATION_RUN_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown, fallback?: string): string | null {
  if (typeof value !== "string" || !value.trim()) return fallback ?? null;
  return value;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((item) => item.length) : [];
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function prioritizedRuns<T extends { id: string; status: string; createdAt: number; updatedAt: number }>(runs: T[]): T[] {
  return [...runs].sort((left, right) => {
    const active = Number(right.status === "active") - Number(left.status === "active");
    if (active !== 0) return active;
    const updated = timestamp(right.updatedAt ?? right.createdAt) - timestamp(left.updatedAt ?? left.createdAt);
    return updated || left.id.localeCompare(right.id);
  });
}

async function hydrateRunSlice(
  client: RustClient,
  run: Awaited<ReturnType<RustClient["listRuns"]>>[number],
  signal: AbortSignal,
): Promise<{ slice: HydratedRunSlice; cacheable: boolean }> {
  signal.throwIfAborted();
  let hadError = false;
  const safeLoad = async <T>(loader: () => Promise<T[]>): Promise<T[]> => {
    try {
      return await loader();
    } catch (error) {
      signal.throwIfAborted();
      hadError = true;
      void error;
      return [];
    }
  };
  const [rawTasks, dispatches, gates, worktreeAssets] = await Promise.all([
    safeLoad(() => client.listTasks(run.id, signal)),
    safeLoad(() => client.listDispatches(run.id, signal)),
    safeLoad(() => client.listGates(run.id, signal)),
    safeLoad(() => client.listWorktreeAssets(run.id, signal)),
  ]);
  const runtimeByTask = new Map<string, JsonObject>();
  if (rawTasks.length > 0 && typeof client.taskActivities === "function") {
    const pages: Array<typeof rawTasks> = [];
    for (let offset = 0; offset < rawTasks.length; offset += 200) {
      pages.push(rawTasks.slice(offset, offset + 200));
    }
    await Promise.all(
      pages.map(async page => {
        try {
          const activity = await client.taskActivities(run.id, page.map(task => task.id), signal);
          for (const item of activity.activities) {
            runtimeByTask.set(item.task.id, {
              execution: item.execution,
              latestOperation: item.latestOperation,
              structuredError: item.structuredError,
              reservedResources: item.reservedResources,
              quarantinedResources: item.quarantinedResources,
              executionUnknown: item.executionUnknown,
              observedAt: item.observedAt,
            });
          }
        } catch (error) {
          signal.throwIfAborted();
          hadError = true;
          const message = error instanceof Error ? error.message : String(error);
          for (const task of page) runtimeByTask.set(task.id, { observationError: message });
        }
      }),
    );
  }
  const tasks: RunTask[] = rawTasks.map(task => {
    const runtime = runtimeByTask.get(task.id);
    return runtime !== undefined ? { ...task, runtime } : { ...task };
  });
  const recordRun = run as typeof run & Record<string, unknown>;
  return {
    cacheable: !hadError,
    slice: {
      signature: runCacheSignature(recordRun),
      terminal: isTerminalRunStatus(run.status),
      cachedAt: Date.now(),
      tasks,
      dispatches,
      gates,
      worktreeAssets,
    },
  };
}

/**
 * Fetch a bounded orchestration window and fold it into the legacy desktop
 * projection shape (320/400 truncation, `automation: null`, `worktreePath`).
 * `eventSeq` is the orchestration event-stream head at read time, purely for
 * the projection's revision field.
 */
export async function readOrchestrationWindow(
  client: RustClient,
  signal: AbortSignal,
  eventSeq: number,
): Promise<JsonObject> {
  const runs = await client.listRuns(signal);
  const projectedRuns = prioritizedRuns(runs).slice(0, PROJECTED_RUN_LIMIT);
  const cache = getClientRunCache(client);
  const now = Date.now();
  const slices = new Array<HydratedRunSlice>(projectedRuns.length);
  const uncachedIndices: number[] = [];

  for (let index = 0; index < projectedRuns.length; index += 1) {
    const run = projectedRuns[index]!;
    const cached = readCachedRunSlice(cache, run as typeof run & Record<string, unknown>, now);
    if (cached) slices[index] = cached;
    else uncachedIndices.push(index);
  }

  if (uncachedIndices.length > 0) {
    let cursor = 0;
    const workerCount = Math.min(ORCHESTRATION_FETCH_CONCURRENCY, uncachedIndices.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (cursor < uncachedIndices.length) {
          signal.throwIfAborted();
          const targetIndex = uncachedIndices[cursor]!;
          cursor += 1;
          const run = projectedRuns[targetIndex]!;
          const { slice, cacheable } = await hydrateRunSlice(client, run, signal);
          slices[targetIndex] = slice;
          if (cacheable) writeCachedRunSlice(cache, run.id, slice);
        }
      }),
    );
  }

  const tasks: RunTask[] = [];
  const dispatches: Awaited<ReturnType<RustClient["listDispatches"]>> = [];
  const gates: Awaited<ReturnType<RustClient["listGates"]>> = [];
  const worktreeAssets: Awaited<ReturnType<RustClient["listWorktreeAssets"]>> = [];

  for (const slice of slices) {
    if (!slice) continue;
    if (tasks.length < PROJECTED_TASK_LIMIT && slice.tasks.length) {
      tasks.push(...slice.tasks.slice(0, PROJECTED_TASK_LIMIT - tasks.length));
    }
    if (dispatches.length < PROJECTED_DISPATCH_LIMIT && slice.dispatches.length) {
      dispatches.push(...slice.dispatches.slice(0, PROJECTED_DISPATCH_LIMIT - dispatches.length));
    }
    if (gates.length < PROJECTED_GATE_LIMIT && slice.gates.length) {
      gates.push(...slice.gates.slice(0, PROJECTED_GATE_LIMIT - gates.length));
    }
    if (worktreeAssets.length < PROJECTED_WORKTREE_LIMIT && slice.worktreeAssets.length) {
      worktreeAssets.push(...slice.worktreeAssets.slice(0, PROJECTED_WORKTREE_LIMIT - worktreeAssets.length));
    }
  }

  return createLegacyDesktopProjection(
    { eventSeq, runs: projectedRuns, tasks, dispatches, gates, worktreeAssets },
  );
}

export async function orchestrationAction(
  client: RustClient,
  method: string,
  rawParams: unknown,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<JsonObject> {
  const params = record(rawParams);
  switch (method) {
    case "operation.get":
      return client.operation(required(params, "operationId"), signal) as Promise<JsonObject>;
    case "execution.get":
      return client.execution(required(params, "attemptId"), signal) as Promise<JsonObject>;
    case "task.activities":
      return client.taskActivities(required(params, "runId"), stringList(params["taskIds"]), signal) as Promise<JsonObject>;
    case "run.create": {
      const input: CreateRun = {
        objective: required(params, "objective"),
        coordinatorSessionId: optionalText(params["coordinatorSessionId"]),
      };
      return client.createRun(input, signal) as Promise<JsonObject>;
    }
    case "graph.create": {
      const input: CreateRunGraph = {
        objective: required(params, "objective"),
        nodes: graphNodes(params["nodes"]),
        coordinatorSessionId: optionalText(params["coordinatorSessionId"]),
        operationId: required(params, "operationId"),
      };
      return client.createRunGraph(input, signal) as Promise<JsonObject>;
    }
    case "graph.apply": {
      const input: ApplyTaskGraph = {
        runId: required(params, "runId"),
        baseRevision: nonnegativeInteger(params["baseRevision"], "baseRevision"),
        nodes: graphNodes(params["nodes"]),
        deleteTaskIds: stringList(params["deleteTaskIds"]),
        operationId: optionalText(params["operationId"]),
      };
      return client.applyTaskGraph(input, signal) as Promise<JsonObject>;
    }
    case "run.complete": {
      const input: CompleteRun = { allowFailedTasks: params["allowFailedTasks"] === true };
      return client.completeRun(required(params, "runId"), input, signal) as Promise<JsonObject>;
    }
    case "run.abandon": {
      const input: AbandonRun = { reason: optionalText(params["reason"]) };
      return client.abandonRun(required(params, "runId"), input, signal) as Promise<JsonObject>;
    }
    case "run.delete":
      return client.deleteRun(required(params, "runId"), { force: params["force"] === true }, signal) as Promise<JsonObject>;
    case "task.create": {
      const input: CreateTask = {
        runId: required(params, "runId"),
        title: required(params, "title"),
        spec: required(params, "spec"),
        skills: stringList(params["skills"]),
        deps: stringList(params["deps"]),
        parentId: optionalText(params["parentId"]),
      };
      return client.createTask(input, signal) as Promise<JsonObject>;
    }
    case "task.cancel": {
      const input: CancelTask = { reason: optionalText(params["reason"], "由用户取消") };
      return client.cancelTask(required(params, "taskId"), input, signal) as Promise<JsonObject>;
    }
    case "task.retry":
      return client.retryTask(required(params, "taskId"), signal) as Promise<JsonObject>;
    case "worker.start": {
      assertStructuredClaudeWorker(params);
      const worktree = text(params["worktree"]) || "new";
      if (worktree !== "new" && worktree !== "none") throw new Error("worktree 必须是 new 或 none");
      const input: StartWorker = {
        taskId: required(params, "taskId"),
        agent: workerAgent(params),
        cwd: required(params, "cwd"),
        worktree,
        kind: "structured",
        skills: stringList(params["skills"]),
        approvalPolicy: workerApprovalPolicy(params),
        accountId: workerAccountId(params),
        ...(text(params["pluginId"]) ? { pluginId: text(params["pluginId"]) } : {}),
        ...(text(params["profileId"]) ? { profileId: text(params["profileId"]) } : {}),
        operationId: optionalText(params["operationId"]),
      };
      return client.startWorker(input, signal, timeoutMs) as Promise<JsonObject>;
    }
    case "worker.stop": {
      const input: StopWorker = {
        ...(text(params["operationId"]) ? { operationId: text(params["operationId"]) } : {}),
        taskId: required(params, "taskId"),
        reason: optionalText(params["reason"]),
        finalStatus: params["finalStatus"] === "cancelled" ? "cancelled" : null,
      };
      return client.stopWorker(input, signal) as Promise<JsonObject>;
    }
    case "worktree.inspect": {
      return client.inspectWorktree(
        required(params, "assetId"),
        optionalText(params["targetRef"]),
        signal,
        timeoutMs,
      ) as Promise<JsonObject>;
    }
    case "worktree.cleanup": {
      if (params["confirm"] !== true) throw new Error("清理工作树必须显式确认");
      const input: CleanupWorktree = {
        targetRef: optionalText(params["targetRef"]),
        confirm: true,
        deleteBranch: params["deleteBranch"] === true,
      };
      return client.cleanupWorktree(required(params, "assetId"), input, signal, timeoutMs) as Promise<JsonObject>;
    }
    case "automation.start": {
      const input: StartAutomation = {
        runId: required(params, "runId"),
        agent: automationAgent(params),
        accountId: workerAccountId(params),
        approvalPolicy: requiredApprovalPolicy(params),
        workspace: params["workspace"] === "run" ? "run" : "current",
        cwd: required(params, "cwd"),
      };
      return client.startAutomation(input, signal, timeoutMs) as Promise<JsonObject>;
    }
    case "automation.pause":
      return client.pauseAutomation(required(params, "runId"), signal) as Promise<JsonObject>;
    default:
      throw new Error("此功能尚未接入 Rust daemon");
  }
}

export function settleDispatchInput(rawParams: unknown): SettleDispatch {
  const params = record(rawParams);
  const success = params["success"];
  if (success !== true && success !== false) throw new Error("交付结果无效");
  const outcome = params["outcome"];
  if (typeof outcome !== "string" || !outcome.trim()) throw new Error("请填写交付摘要");
  if (outcome.length > 20_000) throw new Error("交付摘要不能超过 20,000 个字符");
  return { success, outcome: outcome.trim() };
}

function assertStructuredClaudeWorker(params: JsonObject): void {
  if (params["kind"] !== undefined && params["kind"] !== "structured") {
    throw new Error("Rust 模式只支持结构化 worker");
  }
}

function workerAgent(params: JsonObject): "claude" | "codex" | "deepseek" | "opencode" | "pi" | "agy" {
  const agent = params["agent"] ?? "claude";
  if (agent !== "claude" && agent !== "codex" && agent !== "deepseek" && agent !== "opencode" && agent !== "pi" && agent !== "agy") throw new Error("Rust worker 当前仅支持 Claude/Codex/DeepSeek/OpenCode/Pi/Antigravity");
  return agent;
}

function automationAgent(params: JsonObject): "claude" | "codex" | "deepseek" | "opencode" | "pi" | "agy" {
  const agent = params["agent"] ?? "claude";
  if (agent !== "claude" && agent !== "codex" && agent !== "deepseek" && agent !== "opencode" && agent !== "pi" && agent !== "agy") throw new Error("Rust 自动执行当前仅支持 Claude/Codex/DeepSeek/OpenCode/Pi/Antigravity worker");
  return agent;
}

function workerApprovalPolicy(params: JsonObject): "strict" | "standard" | "yolo" | null {
  const policy = params["approvalPolicy"];
  if (policy === undefined || policy === null || policy === "") return null;
  if (policy !== "strict" && policy !== "standard" && policy !== "yolo") throw new Error("审批策略无效");
  return policy;
}

function requiredApprovalPolicy(params: JsonObject): "strict" | "standard" | "yolo" {
  const policy = workerApprovalPolicy(params);
  if (policy === null) throw new Error("审批策略无效");
  return policy;
}

function workerAccountId(params: JsonObject): string | null {
  const accountId = params["accountId"];
  if (accountId === undefined || accountId === null || !`${accountId}`.trim()) return null;
  if (typeof accountId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(accountId)) throw new Error("账号 ID 无效");
  return accountId;
}

function required(params: JsonObject, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`参数无效: ${key}`);
  return value;
}

function nonnegativeInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`参数无效: ${key}`);
  }
  return value;
}

type GraphNode = CreateRunGraph["nodes"][number];

function graphNodes(value: unknown): GraphNode[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map((raw) => {
    const node = record(raw);
    return {
      clientId: required(node, "clientId"),
      title: required(node, "title"),
      spec: required(node, "spec"),
      skills: stringList(node["skills"]),
      deps: stringList(node["deps"]),
      parentId: optionalText(node["parentId"]),
    };
  });
}
