/** 控制 socket 暴露的 M2 编排方法；传输层之外保持纯业务语义，便于直接测试。 */
import { createHash } from "node:crypto";
import type { AgentKind, ApprovalPolicy, SessionKind } from "@prospero/protocol";
import { ControlSocketError } from "../control-socket.js";
import { AutomationError, AutomationService } from "./automation.js";
import { CollaborationError, CollaborationService } from "./collaboration.js";
import { DispatchError, DispatchService, type WorktreeMode } from "./dispatch.js";
import {
  OrchestrationError,
  OrchestrationStore,
  type GraphNodeInput,
} from "./store.js";

const AGENTS = new Set<AgentKind>([
  "shell", "claude", "codex", "opencode", "grok", "trae", "custom",
]);
const AUTOMATION_AGENTS = new Set<AgentKind>(["claude", "codex", "opencode", "grok", "trae"]);
const SESSION_KINDS = new Set<SessionKind>(["pty", "structured"]);
const POLICIES = new Set<ApprovalPolicy>(["strict", "standard", "yolo"]);
type MailType = "note" | "ask" | "reply" | "report";
type SendMailType = Extract<MailType, "note" | "report">;
const SEND_MESSAGE_TYPES = new Set<SendMailType>(["note", "report"]);
const GATE_STATUSES = new Set(["pending", "resolved", "cancelled"]);

type Params = Record<string, unknown>;

function object(value: unknown): Params {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ControlSocketError("参数必须是 JSON 对象", "bad_params");
  }
  return value as Params;
}

function text(params: Params, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ControlSocketError(`缺少或无效参数: ${name}`, "bad_params");
  }
  return value;
}

function optionalText(params: Params, name: string): string | null {
  const value = params[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ControlSocketError(`无效参数: ${name}`, "bad_params");
  }
  return value;
}

function operationId(params: Params): string | null {
  const value = optionalText(params, "operationId");
  if (value !== null && value.length > 200) {
    throw new ControlSocketError("operationId 过长", "bad_params");
  }
  return value;
}

function textList(params: Params, name: string): string[] {
  const value = params[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new ControlSocketError(`无效参数: ${name}`, "bad_params");
  }
  return value as string[];
}

function nonnegativeInteger(params: Params, name: string): number {
  const value = params[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ControlSocketError(`无效参数: ${name}`, "bad_params");
  }
  return value;
}

function graphNodes(params: Params): GraphNodeInput[] {
  const value = params["nodes"];
  if (!Array.isArray(value) || value.length > 200) {
    throw new ControlSocketError("nodes 必须是最多包含 200 个节点的数组", "bad_params");
  }
  return value.map((raw, index) => {
    let node: Params;
    try {
      node = object(raw);
    } catch {
      throw new ControlSocketError(`nodes[${index}] 必须是 JSON 对象`, "bad_params");
    }
    if (!Array.isArray(node["deps"])) {
      throw new ControlSocketError(`nodes[${index}].deps 必须是数组`, "bad_params");
    }
    const parentId = optionalText(node, "parentId");
    return {
      clientId: text(node, "clientId"),
      title: text(node, "title"),
      spec: text(node, "spec"),
      deps: textList(node, "deps"),
      ...(parentId !== null ? { parentId } : {}),
    };
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

function operationFingerprint(method: string, payload: unknown): string {
  return createHash("sha256")
    .update(method)
    .update("\n")
    .update(canonicalJson(payload))
    .digest("base64url");
}

function optionalBoolean(params: Params, name: string, fallback: boolean): boolean {
  const value = params[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ControlSocketError(`无效参数: ${name}`, "bad_params");
  return value;
}

function coordinatorOnly(
  store: OrchestrationStore,
  runId: string,
  actorSessionId: string | null,
): void {
  const run = store.getRun(runId);
  if (run.coordinatorSessionId !== null && run.coordinatorSessionId !== actorSessionId) {
    throw new ControlSocketError("只有此 Run 的协调者会话可以改动任务图或派发 worker", "forbidden");
  }
}

/** 人类设备是宿主所有者，可管理协调者 Run；agent 自身仍只能管理自己的 Run。 */
function ownerOrCoordinator(
  store: OrchestrationStore,
  runId: string,
  actorSessionId: string | null,
): void {
  const coordinator = store.getRun(runId).coordinatorSessionId;
  if (actorSessionId !== null && coordinator !== actorSessionId) {
    throw new ControlSocketError("只有宿主用户或此 Run 的协调者可以管理编排", "forbidden");
  }
}

function rejectMutationWhileAutomating(store: OrchestrationStore, runId: string): void {
  if (store.getRun(runId).automation?.state === "running") {
    throw new ControlSocketError("任务图正在自动执行；请先暂停，再编辑或手工派发", "forbidden");
  }
}

/** 生成供 startControlSocket 直接调用的 handler。 */
export function orchestrationControlApi(
  store: OrchestrationStore,
  dispatch: DispatchService,
  collaboration: CollaborationService,
  automation?: AutomationService,
): (method: string, params: unknown, signal: AbortSignal) => Promise<unknown> {
  const inflight = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

  const idempotent = async <T>(
    method: string,
    id: string | null,
    payload: unknown,
    execute: () => T | Promise<T>,
  ): Promise<T> => {
    if (id === null) return await execute();
    const fingerprint = operationFingerprint(method, payload);
    const completed = store.getOperation(id);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw new OrchestrationError(`operationId ${id} 已用于另一项操作`, "operation_conflict");
      }
      return structuredClone(completed.result) as T;
    }
    const pending = inflight.get(id);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new OrchestrationError(`operationId ${id} 正用于另一项操作`, "operation_conflict");
      }
      return await pending.promise as T;
    }
    const promise = Promise.resolve().then(execute);
    inflight.set(id, { fingerprint, promise });
    try {
      const result = await promise;
      store.rememberOperation(id, fingerprint, result);
      return result;
    } finally {
      inflight.delete(id);
    }
  };

  return async (method, rawParams, signal) => {
    try {
      const params = object(rawParams ?? {});
      switch (method) {
        case "run.create": {
          const input = {
            objective: text(params, "objective"),
            coordinatorSessionId: optionalText(params, "coordinatorSessionId"),
          };
          return idempotent(method, operationId(params), input, () => store.createRun(input));
        }
        case "run.list":
          return store.listRuns();
        case "run.complete": {
          const runId = text(params, "runId");
          const actorSessionId = optionalText(params, "actorSessionId");
          ownerOrCoordinator(store, runId, actorSessionId);
          return idempotent(
            method,
            operationId(params),
            { runId, actorSessionId },
            () => store.completeRun(runId),
          );
        }
        case "run.delete": {
          const runId = text(params, "runId");
          const actorSessionId = optionalText(params, "actorSessionId");
          return idempotent(
            method,
            operationId(params),
            { runId, actorSessionId },
            () => {
              ownerOrCoordinator(store, runId, actorSessionId);
              if (store.getRun(runId).automation?.state === "running") {
                automation?.pause(runId);
              }
              return store.deleteRun(runId);
            },
          );
        }
        case "task.create": {
          const runId = text(params, "runId");
          const actorSessionId = optionalText(params, "actorSessionId");
          coordinatorOnly(store, runId, actorSessionId);
          rejectMutationWhileAutomating(store, runId);
          const parentId = optionalText(params, "parentId");
          const input = {
            runId,
            title: text(params, "title"),
            spec: text(params, "spec"),
            deps: textList(params, "deps"),
            ...(parentId !== null ? { parentId } : {}),
          };
          return idempotent(
            method,
            operationId(params),
            { ...input, actorSessionId },
            () => store.createTask(input),
          );
        }
        case "task.cancel": {
          const taskId = text(params, "taskId");
          const task = store.getTask(taskId);
          const actorSessionId = optionalText(params, "actorSessionId");
          ownerOrCoordinator(store, task.runId, actorSessionId);
          const reason = optionalText(params, "reason") ?? "由用户取消";
          return idempotent(
            method,
            operationId(params),
            { taskId, reason, actorSessionId },
            () => {
              if (store.getRun(task.runId).automation?.state === "running") {
                automation?.pause(task.runId);
              }
              return store.cancelTask(taskId, reason);
            },
          );
        }
        case "task.retry": {
          const taskId = text(params, "taskId");
          const task = store.getTask(taskId);
          const actorSessionId = optionalText(params, "actorSessionId");
          ownerOrCoordinator(store, task.runId, actorSessionId);
          return idempotent(
            method,
            operationId(params),
            { taskId, actorSessionId },
            () => {
              if (store.getRun(task.runId).automation?.state === "running") {
                automation?.pause(task.runId);
              }
              return store.retryTask(taskId);
            },
          );
        }
        case "task.list": {
          const runId = optionalText(params, "runId");
          return store.listTasks(runId ?? undefined);
        }
        case "task.done": {
          const actorSessionId = optionalText(params, "actorSessionId");
          const taskId = text(params, "taskId");
          const wasDone = store.getTask(taskId).status === "done";
          const task = dispatch.completeTask(
            taskId,
            actorSessionId,
            text(params, "body"),
          );
          if (!wasDone) reportTaskOutcome(store, collaboration, task, actorSessionId, "完成");
          if (!wasDone) automation?.kick(task.runId);
          return task;
        }
        case "task.fail": {
          const actorSessionId = optionalText(params, "actorSessionId");
          const taskId = text(params, "taskId");
          const wasFailed = store.getTask(taskId).status === "failed";
          const task = dispatch.failTask(
            taskId,
            actorSessionId,
            text(params, "body"),
          );
          if (!wasFailed) reportTaskOutcome(store, collaboration, task, actorSessionId, "失败");
          if (!wasFailed) automation?.kick(task.runId);
          return task;
        }
        case "worker.start": {
          const taskId = text(params, "taskId");
          const task = store.getTask(taskId);
          coordinatorOnly(store, task.runId, optionalText(params, "actorSessionId"));
          rejectMutationWhileAutomating(store, task.runId);
          const agent = text(params, "agent");
          if (!AGENTS.has(agent as AgentKind)) {
            throw new ControlSocketError(`未知 agent: ${agent}`, "bad_params");
          }
          const worktree = text(params, "worktree");
          if (worktree !== "new" && worktree !== "none") {
            throw new ControlSocketError("worktree 必须是 new 或 none", "bad_params");
          }
          const rawKind = optionalText(params, "kind");
          if (rawKind !== null && !SESSION_KINDS.has(rawKind as SessionKind)) {
            throw new ControlSocketError("kind 必须是 pty 或 structured", "bad_params");
          }
          const rawPolicy = optionalText(params, "approvalPolicy");
          if (rawPolicy !== null && !POLICIES.has(rawPolicy as ApprovalPolicy)) {
            throw new ControlSocketError("approvalPolicy 必须是 strict、standard 或 yolo", "bad_params");
          }
          const input = {
            taskId,
            agent: agent as AgentKind,
            ...(optionalText(params, "accountId") !== null
              ? { accountId: optionalText(params, "accountId")! }
              : {}),
            worktree: worktree as WorktreeMode,
            cwd: text(params, "cwd"),
            ...(rawKind !== null ? { kind: rawKind as SessionKind } : {}),
            ...(rawPolicy !== null ? { approvalPolicy: rawPolicy as ApprovalPolicy } : {}),
          };
          return idempotent(
            method,
            operationId(params),
            { ...input, actorSessionId: optionalText(params, "actorSessionId") },
            () => dispatch.startWorker(input),
          );
        }
        case "worker.stop": {
          const taskId = text(params, "taskId");
          const task = store.getTask(taskId);
          const actorSessionId = optionalText(params, "actorSessionId");
          ownerOrCoordinator(store, task.runId, actorSessionId);
          const reason = optionalText(params, "reason") ?? "由用户停止 worker";
          return idempotent(
            method,
            operationId(params),
            { taskId, reason, actorSessionId },
            async () => {
              if (store.getRun(task.runId).automation?.state === "running") {
                automation?.pause(task.runId);
              }
              return await dispatch.stopWorker(taskId, reason);
            },
          );
        }
        case "graph.create": {
          const input = {
            objective: text(params, "objective"),
            nodes: graphNodes(params),
            coordinatorSessionId: optionalText(params, "coordinatorSessionId"),
          };
          const op = operationId(params);
          if (op === null) throw new ControlSocketError("缺少 operationId", "bad_params");
          return idempotent(method, op, input, () => store.createRunGraph(input));
        }
        case "graph.apply": {
          const runId = text(params, "runId");
          const actorSessionId = optionalText(params, "actorSessionId");
          coordinatorOnly(store, runId, actorSessionId);
          rejectMutationWhileAutomating(store, runId);
          const deleteTaskIds = textList(params, "deleteTaskIds");
          if (deleteTaskIds.length > 200) {
            throw new ControlSocketError("一次最多删除 200 个节点", "bad_params");
          }
          const input = {
            runId,
            baseRevision: nonnegativeInteger(params, "baseRevision"),
            nodes: graphNodes(params),
            deleteTaskIds,
          };
          const op = operationId(params);
          if (op === null) throw new ControlSocketError("缺少 operationId", "bad_params");
          return idempotent(
            method,
            op,
            { ...input, actorSessionId },
            () => store.applyTaskGraph(input),
          );
        }
        case "automation.start": {
          if (!automation) throw new ControlSocketError("daemon 尚未启用自动调度器", "method_not_found");
          const runId = text(params, "runId");
          coordinatorOnly(store, runId, optionalText(params, "actorSessionId"));
          const agent = text(params, "agent");
          if (!AUTOMATION_AGENTS.has(agent as AgentKind)) {
            throw new ControlSocketError(`自动执行不支持 agent: ${agent}`, "bad_params");
          }
          const approvalPolicy = text(params, "approvalPolicy");
          if (!POLICIES.has(approvalPolicy as ApprovalPolicy)) {
            throw new ControlSocketError("approvalPolicy 必须是 strict、standard 或 yolo", "bad_params");
          }
          const workspace = text(params, "workspace");
          if (workspace !== "run" && workspace !== "current") {
            throw new ControlSocketError("workspace 必须是 run 或 current", "bad_params");
          }
          const input = {
            runId,
            agent: agent as AgentKind,
            ...(optionalText(params, "accountId") !== null
              ? { accountId: optionalText(params, "accountId")! }
              : {}),
            approvalPolicy: approvalPolicy as ApprovalPolicy,
            workspace: workspace as "run" | "current",
            cwd: text(params, "cwd"),
          };
          return idempotent(
            method,
            operationId(params),
            { ...input, actorSessionId: optionalText(params, "actorSessionId") },
            () => automation.start(input),
          );
        }
        case "automation.pause": {
          if (!automation) throw new ControlSocketError("daemon 尚未启用自动调度器", "method_not_found");
          const runId = text(params, "runId");
          coordinatorOnly(store, runId, optionalText(params, "actorSessionId"));
          return idempotent(
            method,
            operationId(params),
            { runId, actorSessionId: optionalText(params, "actorSessionId") },
            () => automation.pause(runId),
          );
        }
        case "mail.send": {
          const type = text(params, "type");
          if (!SEND_MESSAGE_TYPES.has(type as SendMailType)) {
            throw new ControlSocketError(`未知消息类型: ${type}`, "bad_params");
          }
          const threadId = optionalText(params, "threadId");
          const taskId = optionalText(params, "taskId");
          return collaboration.send({
            runId: text(params, "runId"),
            from: text(params, "from"),
            to: text(params, "to"),
            type: type as SendMailType,
            subject: text(params, "subject"),
            body: text(params, "body"),
            ...(threadId !== null ? { threadId } : {}),
            ...(taskId !== null ? { taskId } : {}),
          });
        }
        case "mail.check": {
          const runId = optionalText(params, "runId");
          return collaboration.check({
            recipient: text(params, "recipient"),
            ...(runId !== null ? { runId } : {}),
            wait: optionalBoolean(params, "wait", false),
            signal,
          });
        }
        case "mail.ask": {
          const taskId = optionalText(params, "taskId");
          return collaboration.ask({
            runId: text(params, "runId"),
            from: text(params, "from"),
            to: text(params, "to"),
            subject: text(params, "subject"),
            body: text(params, "body"),
            ...(taskId !== null ? { taskId } : {}),
            wait: optionalBoolean(params, "wait", true),
            signal,
          });
        }
        case "mail.reply": {
          const taskId = optionalText(params, "taskId");
          return collaboration.reply({
            runId: text(params, "runId"),
            from: text(params, "from"),
            to: text(params, "to"),
            threadId: text(params, "threadId"),
            subject: text(params, "subject"),
            body: text(params, "body"),
            ...(taskId !== null ? { taskId } : {}),
          });
        }
        case "gate.create": {
          const runId = text(params, "runId");
          coordinatorOnly(store, runId, optionalText(params, "actorSessionId"));
          const taskId = optionalText(params, "taskId");
          return store.createGate({
            runId,
            ...(taskId !== null ? { taskId } : {}),
            question: text(params, "question"),
            options: textList(params, "options"),
          });
        }
        case "gate.resolve": {
          const gate = store.getGate(text(params, "gateId"));
          coordinatorOnly(store, gate.runId, optionalText(params, "actorSessionId"));
          return store.resolveGate(gate.id, text(params, "decision"));
        }
        case "gate.list": {
          const runId = optionalText(params, "runId");
          const status = optionalText(params, "status");
          if (status !== null && !GATE_STATUSES.has(status)) {
            throw new ControlSocketError("status 必须是 pending、resolved 或 cancelled", "bad_params");
          }
          return status === null
            ? store.listGates(runId ?? undefined)
            : store.listGates(runId ?? undefined, status as "pending" | "resolved" | "cancelled");
        }
        case "orchestration.snapshot":
          return store.snapshot();
        default:
          throw new ControlSocketError(`未知控制方法: ${method}`, "method_not_found");
      }
    } catch (error) {
      if (error instanceof ControlSocketError) throw error;
      if (
        error instanceof OrchestrationError ||
        error instanceof DispatchError ||
        error instanceof AutomationError ||
        error instanceof CollaborationError
      ) {
        throw new ControlSocketError(error.message, error.code);
      }
      throw error;
    }
  };
}

function reportTaskOutcome(
  store: OrchestrationStore,
  collaboration: CollaborationService,
  task: { runId: string; id: string; title: string; result: string | null },
  actorSessionId: string | null,
  outcome: "完成" | "失败",
): void {
  const coordinator = store.getRun(task.runId).coordinatorSessionId;
  if (!coordinator || !actorSessionId || coordinator === actorSessionId) return;
  collaboration.send({
    runId: task.runId,
    from: actorSessionId,
    to: coordinator,
    type: "report",
    subject: `任务${outcome}: ${task.title}`,
    body: task.result ?? "",
    taskId: task.id,
  });
}
