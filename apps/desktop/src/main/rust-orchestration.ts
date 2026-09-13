import type {
  AbandonRun, ApplyTaskGraph, CancelTask, CleanupWorktree, CompleteRun, CreateRun,
  CreateRunGraph, CreateTask, SettleDispatch, StartWorker, StopWorker,
} from "@prospero/protocol/rust-daemon";
import type { RustClient } from "./rust-client";
import { createLegacyDesktopProjection } from "./orchestration-projection";
import type { JsonObject } from "../shared/types";

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

/**
 * Fetch every orchestration collection and fold it into the legacy desktop
 * projection shape (320/400 truncation, `automation: null`, `worktreePath`).
 * `eventSeq` is the orchestration event-stream head at read time, purely for
 * the projection's revision field.
 */
export async function readOrchestrationWindow(
  client: RustClient,
  signal: AbortSignal,
  eventSeq: number,
): Promise<JsonObject> {
  const [runs, tasks, dispatches, gates, worktreeAssets] = await Promise.all([
    client.listRuns(signal),
    client.listTasks(undefined, signal),
    client.listDispatches(undefined, signal),
    client.listGates(undefined, signal),
    client.listWorktreeAssets(undefined, signal),
  ]);
  return createLegacyDesktopProjection(
    { eventSeq, runs, tasks, dispatches, gates, worktreeAssets },
  );
}

/**
 * Map one desktop `orchestration:action` RPC onto Rust `/v1` routes. The
 * supported method set mirrors `ORCHESTRATION_METHODS` in index.ts; automation
 * and non-Claude workers stay explicitly unbridged in Rust mode.
 */
export async function orchestrationAction(
  client: RustClient,
  method: string,
  rawParams: unknown,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<JsonObject> {
  const params = record(rawParams);
  switch (method) {
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
    case "run.delete": {
      // Never force: active dispatches must be settled/stopped first so the
      // daemon's 400 surfaces in the desktop instead of silently deleting work.
      return client.deleteRun(required(params, "runId"), signal) as Promise<JsonObject>;
    }
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
        approvalPolicy: workerApprovalPolicy(params),
        accountId: workerAccountId(params),
        operationId: optionalText(params["operationId"]),
      };
      return client.startWorker(input, signal, timeoutMs) as Promise<JsonObject>;
    }
    case "worker.stop": {
      const input: StopWorker = {
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
    case "automation.start":
    case "automation.pause":
      throw new Error("自动执行 DAG 尚未接入 Rust daemon");
    default:
      throw new Error("此功能尚未接入 Rust daemon");
  }
}

/** Manual worker delivery: Rust mode has no prospero CLI, so the operator
 * records the worker result through the desktop. */
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

function workerAgent(params: JsonObject): "claude" {
  const agent = params["agent"] ?? "claude";
  if (agent !== "claude") throw new Error("Rust 模式当前只接入 Claude worker");
  return "claude";
}

function workerApprovalPolicy(params: JsonObject): "strict" | "standard" | "yolo" | null {
  const policy = params["approvalPolicy"];
  if (policy === undefined || policy === null || policy === "") return null;
  if (policy !== "strict" && policy !== "standard" && policy !== "yolo") throw new Error("审批策略无效");
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
