/**
 * 编排的数据模型与状态机。
 *
 * 一条原则贯穿全文件:**状态只认显式转移,绝不猜**。
 *
 * 调研 Orca 的实现时,它有一条"agent 空闲了就当任务做完了"的推断路径
 * (靠 hook 上报 + 扫终端标题),那是误报的主要来源 —— agent 停下来的原因
 * 可能是做完了,也可能是卡住了、在等审批、或者纯粹跑崩了。
 *
 * 我们有适配器给的精确 SessionStatus,但那也只当**提示**:它只用来告诉协调者
 * "这个 worker 不动了,去看一眼",绝不自动把 Task 判成 done。
 * 任务完成必须由 worker 显式 `task done` 或协调者显式验收。
 */

export type RunStatus = "active" | "completed" | "abandoned";

export interface Run {
  id: string;
  objective: string;
  status: RunStatus;
  /** 发起编排的那个会话;它就是协调者 */
  coordinatorSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 落盘的任务状态。
 *
 * 注意没有 `ready` —— 它是**派生**的(pending 且 deps 全 done),
 * 存下来就会有两份真相,依赖一变就不一致。见 isReady()。
 */
export type TaskStatus =
  | "pending"
  | "dispatched"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export interface Task {
  id: string;
  runId: string;
  title: string;
  spec: string;
  deps: string[];
  parentId: string | null;
  status: TaskStatus;
  /** worker 交付时给的摘要;失败时是原因 */
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DispatchState =
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "abandoned";

export interface Dispatch {
  id: string;
  runId: string;
  taskId: string;
  /** Prospero 会话 id。它是持久的,daemon 重启后依然指向同一个 agent */
  sessionId: string;
  worktreePath: string | null;
  state: DispatchState;
  startedAt: number;
  settledAt: number | null;
  outcome: string | null;
}

export type MessageType = "note" | "ask" | "reply" | "report";

export interface Message {
  id: string;
  runId: string;
  /** 会话 id,或 "human" */
  from: string;
  to: string;
  type: MessageType;
  subject: string;
  body: string;
  /** ask/reply 靠它串成一问一答 */
  threadId: string | null;
  taskId: string | null;
  createdAt: number;
  readAt: number | null;
  answeredAt: number | null;
}

export type GateStatus = "pending" | "resolved" | "cancelled";

export interface Gate {
  id: string;
  runId: string;
  taskId: string | null;
  question: string;
  options: string[];
  status: GateStatus;
  decision: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface OrchestrationState {
  version: 1;
  runs: Record<string, Run>;
  tasks: Record<string, Task>;
  dispatches: Record<string, Dispatch>;
  messages: Record<string, Message>;
  gates: Record<string, Gate>;
}

export function emptyState(): OrchestrationState {
  return { version: 1, runs: {}, tasks: {}, dispatches: {}, messages: {}, gates: {} };
}

// ── 状态机 ──────────────────────────────────────────────────────────────

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  // 派发出去,或者被门挡住,或者还没开始就取消
  pending: ["dispatched", "blocked", "cancelled"],
  // 干完了/干砸了;也可能 worker 没了要退回重派
  dispatched: ["done", "failed", "blocked", "pending", "cancelled"],
  // 门解开后退回 pending 重新排队,而不是直接 dispatched ——
  // 因为挡着的这段时间里,依赖和 worker 都可能已经变了
  blocked: ["pending", "cancelled"],
  // 终态里只有 failed 能重试;done 要改就新建任务,别改历史
  done: [],
  failed: ["pending"],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return (TASK_TRANSITIONS[from] ?? []).includes(to);
}

export class TransitionError extends Error {
  constructor(readonly from: TaskStatus, readonly to: TaskStatus) {
    super(`任务状态不能从 ${from} 变成 ${to}`);
    this.name = "TransitionError";
  }
}

/** 终态:不会再自己动了 */
export function isTerminal(status: TaskStatus): boolean {
  return status === "done" || status === "cancelled";
}

/**
 * 可以派了吗 —— 派生值,不落盘。
 *
 * 依赖里只要有一个没 done 就不算。特意**不**把 cancelled 当成"过了":
 * 依赖被取消意味着这条链的前提没了,应该由人或协调者显式改依赖,
 * 而不是让任务悄悄溜过去在半截地基上开工。
 */
export function isReady(task: Task, all: ReadonlyMap<string, Task>): boolean {
  if (task.status !== "pending") return false;
  return task.deps.every((dep) => all.get(dep)?.status === "done");
}

/**
 * 依赖成环检测。
 *
 * 协调者是个 LLM,它**会**写出环来。让环在建任务那一刻就报错,
 * 好过等到调度时发现一堆任务永远 ready 不了却没人说得清为什么。
 */
export function findCycle(tasks: ReadonlyMap<string, Task>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const state = color.get(id) ?? WHITE;
    if (state === BLACK) return null;
    if (state === GRAY) return [...stack.slice(stack.indexOf(id)), id];
    const task = tasks.get(id);
    if (!task) return null;
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of task.deps) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    color.set(id, BLACK);
    return null;
  };

  for (const id of tasks.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}
