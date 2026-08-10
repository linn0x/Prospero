/** 控制 socket 暴露的 M2 编排方法；传输层之外保持纯业务语义，便于直接测试。 */
import type { AgentKind, ApprovalPolicy, SessionKind } from "@prospero/protocol";
import { ControlSocketError } from "../control-socket.js";
import { CollaborationError, CollaborationService } from "./collaboration.js";
import { DispatchError, DispatchService, type WorktreeMode } from "./dispatch.js";
import { OrchestrationError, OrchestrationStore } from "./store.js";

const AGENTS = new Set<AgentKind>([
  "shell", "claude", "codex", "opencode", "grok", "trae", "custom",
]);
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

function textList(params: Params, name: string): string[] {
  const value = params[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new ControlSocketError(`无效参数: ${name}`, "bad_params");
  }
  return value as string[];
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

/** 生成供 startControlSocket 直接调用的 handler。 */
export function orchestrationControlApi(
  store: OrchestrationStore,
  dispatch: DispatchService,
  collaboration: CollaborationService,
): (method: string, params: unknown, signal: AbortSignal) => Promise<unknown> {
  return async (method, rawParams, signal) => {
    try {
      const params = object(rawParams ?? {});
      switch (method) {
        case "run.create": {
          return store.createRun({
            objective: text(params, "objective"),
            coordinatorSessionId: optionalText(params, "coordinatorSessionId"),
          });
        }
        case "run.list":
          return store.listRuns();
        case "task.create": {
          const runId = text(params, "runId");
          coordinatorOnly(store, runId, optionalText(params, "actorSessionId"));
          return store.createTask({
            runId,
            title: text(params, "title"),
            spec: text(params, "spec"),
            deps: textList(params, "deps"),
            parentId: optionalText(params, "parentId"),
          });
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
          return task;
        }
        case "worker.start": {
          const taskId = text(params, "taskId");
          const task = store.getTask(taskId);
          coordinatorOnly(store, task.runId, optionalText(params, "actorSessionId"));
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
          return dispatch.startWorker({
            taskId,
            agent: agent as AgentKind,
            worktree: worktree as WorktreeMode,
            cwd: text(params, "cwd"),
            ...(rawKind !== null ? { kind: rawKind as SessionKind } : {}),
            ...(rawPolicy !== null ? { approvalPolicy: rawPolicy as ApprovalPolicy } : {}),
          });
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
