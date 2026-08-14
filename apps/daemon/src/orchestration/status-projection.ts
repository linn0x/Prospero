/**
 * Session-local `prospero status` is deliberately a projection of the full
 * persisted snapshot. Keeping it pure makes the selection and action order
 * straightforward to test without changing the protocol or store.
 */
import type { Dispatch, Gate, OrchestrationState, Run, Task, TaskStatus } from "./model.js";
import { isReady } from "./model.js";

export type NextActionPriority = "gate" | "failed" | "running" | "ready" | "waiting" | "complete";

export interface NextAction {
  priority: NextActionPriority;
  command: string;
  gateId?: string;
  taskId?: string;
}

export interface CompactRun {
  id: string;
  objective: string;
  status: Run["status"];
  graphRevision: number;
  coordinatorSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  automation: null | {
    state: NonNullable<Run["automation"]>["state"];
    agent: NonNullable<Run["automation"]>["agent"];
    workspace: NonNullable<Run["automation"]>["workspace"];
  };
}

export interface CompactTaskCounts extends Record<TaskStatus, number> {
  ready: number;
}

export interface CompactReadyTask {
  id: string;
  title: string;
  deps: string[];
}

export interface CompactWorker {
  id: string;
  taskId: string;
  taskTitle: string | null;
  sessionId: string;
  state: Extract<Dispatch["state"], "starting" | "running">;
  startedAt: number;
}

export interface CompactGate {
  id: string;
  taskId: string | null;
  taskTitle: string | null;
  question: string;
  options: string[];
  createdAt: number;
}

export interface CompactRunStatus {
  run: CompactRun;
  taskCounts: CompactTaskCounts;
  readyTasks: CompactReadyTask[];
  activeWorkers: CompactWorker[];
  pendingGates: CompactGate[];
  nextActions: NextAction[];
}

export interface CompactRunListItem extends CompactRun {
  taskCounts: CompactTaskCounts;
  activeWorkerCount: number;
  pendingGateCount: number;
}

export interface CompactRunList {
  runs: CompactRunListItem[];
}

export interface NoRunStatus {
  run: null;
  sessionId: string | null;
  hint: string;
  nextActions: Array<Pick<NextAction, "priority" | "command">>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function compactRun(run: Run): CompactRun {
  return {
    id: run.id,
    objective: run.objective,
    status: run.status,
    graphRevision: run.graphRevision,
    coordinatorSessionId: run.coordinatorSessionId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    automation: run.automation
      ? {
        state: run.automation.state,
        agent: run.automation.agent,
        workspace: run.automation.workspace,
      }
      : null,
  };
}

function tasksFor(snapshot: OrchestrationState, runId: string): Task[] {
  return Object.values(snapshot.tasks)
    .filter((task) => task.runId === runId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function dispatchesFor(snapshot: OrchestrationState, runId: string): Dispatch[] {
  return Object.values(snapshot.dispatches)
    .filter((dispatch) => dispatch.runId === runId)
    .sort((a, b) => a.startedAt - b.startedAt);
}

function pendingGatesFor(snapshot: OrchestrationState, runId: string): Gate[] {
  return Object.values(snapshot.gates)
    .filter((gate) => gate.runId === runId && gate.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt);
}

function allTasks(snapshot: OrchestrationState): Map<string, Task> {
  return new Map(Object.values(snapshot.tasks).map((task) => [task.id, task]));
}

function countTasks(tasks: readonly Task[], taskMap: ReadonlyMap<string, Task>): CompactTaskCounts {
  const counts: CompactTaskCounts = {
    pending: 0,
    dispatched: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    ready: 0,
  };
  for (const task of tasks) {
    counts[task.status] += 1;
    if (isReady(task, taskMap)) counts.ready += 1;
  }
  return counts;
}

/**
 * A session can own a Run as coordinator or as a worker. Active association
 * wins; historical Runs are then ordered by their most recent update.
 */
export function selectRunForSession(snapshot: OrchestrationState, sessionId: string | null): Run | null {
  if (!sessionId) return null;
  const workerRunIds = new Set(
    Object.values(snapshot.dispatches)
      .filter((dispatch) => dispatch.sessionId === sessionId)
      .map((dispatch) => dispatch.runId),
  );
  return Object.values(snapshot.runs)
    .filter((run) => run.coordinatorSessionId === sessionId || workerRunIds.has(run.id))
    .sort((a, b) => {
      const activeFirst = Number(b.status === "active") - Number(a.status === "active");
      return activeFirst || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
    })[0] ?? null;
}

function makeNextActions(input: {
  run: Run;
  tasks: Task[];
  readyTasks: Task[];
  activeWorkers: CompactWorker[];
  pendingGates: CompactGate[];
}): NextAction[] {
  const { run, tasks, readyTasks, activeWorkers, pendingGates } = input;
  // Only emit the highest priority set. This prevents a pending Gate from
  // being hidden by lower-priority retry/start commands, while retaining all
  // commands at the current priority.
  if (pendingGates.length > 0) {
    return pendingGates.map((gate) => ({
      priority: "gate",
      gateId: gate.id,
      command: `prospero gate resolve --id ${shellQuote(gate.id)} --decision '<decision>'`,
    }));
  }

  const failed = tasks.filter((task) => task.status === "failed");
  if (failed.length > 0) {
    return failed.map((task) => ({
      priority: "failed",
      taskId: task.id,
      command: `prospero task retry --id ${shellQuote(task.id)}`,
    }));
  }

  if (activeWorkers.length > 0) {
    return activeWorkers.map((worker) => ({
      priority: "running",
      taskId: worker.taskId,
      command: `prospero worker stop --task ${shellQuote(worker.taskId)} --reason '<reason>'`,
    }));
  }

  if (readyTasks.length > 0) {
    const agent = run.automation?.agent ?? "codex";
    return readyTasks.map((task) => ({
      priority: "ready",
      taskId: task.id,
      command: `prospero worker start --task ${shellQuote(task.id)} --agent ${agent} --worktree none --cwd "$PWD"`,
    }));
  }

  if (tasks.some((task) => task.status === "pending" || task.status === "blocked" || task.status === "dispatched")) {
    return [{ priority: "waiting", command: `prospero status --run ${shellQuote(run.id)}` }];
  }

  return run.status === "active"
    ? [{ priority: "complete", command: `prospero run complete --id ${shellQuote(run.id)}` }]
    : [];
}

export function projectRunStatus(snapshot: OrchestrationState, run: Run): CompactRunStatus {
  const tasks = tasksFor(snapshot, run.id);
  const taskMap = allTasks(snapshot);
  const readyTasks = tasks.filter((task) => isReady(task, taskMap));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const activeWorkers = dispatchesFor(snapshot, run.id)
    .filter((dispatch): dispatch is Dispatch & { state: "starting" | "running" } =>
      dispatch.state === "starting" || dispatch.state === "running",
    )
    .map((dispatch) => ({
      id: dispatch.id,
      taskId: dispatch.taskId,
      taskTitle: tasksById.get(dispatch.taskId)?.title ?? null,
      sessionId: dispatch.sessionId,
      state: dispatch.state,
      startedAt: dispatch.startedAt,
    }));
  const pendingGates = pendingGatesFor(snapshot, run.id).map((gate) => ({
    id: gate.id,
    taskId: gate.taskId,
    taskTitle: gate.taskId ? tasksById.get(gate.taskId)?.title ?? null : null,
    question: gate.question,
    options: [...gate.options],
    createdAt: gate.createdAt,
  }));

  return {
    run: compactRun(run),
    taskCounts: countTasks(tasks, taskMap),
    readyTasks: readyTasks.map((task) => ({ id: task.id, title: task.title, deps: [...task.deps] })),
    activeWorkers,
    pendingGates,
    nextActions: makeNextActions({ run, tasks, readyTasks, activeWorkers, pendingGates }),
  };
}

export function projectRunList(snapshot: OrchestrationState): CompactRunList {
  const taskMap = allTasks(snapshot);
  return {
    runs: Object.values(snapshot.runs)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .map((run) => {
        const tasks = tasksFor(snapshot, run.id);
        return {
          ...compactRun(run),
          taskCounts: countTasks(tasks, taskMap),
          activeWorkerCount: dispatchesFor(snapshot, run.id)
            .filter((dispatch) => dispatch.state === "starting" || dispatch.state === "running").length,
          pendingGateCount: pendingGatesFor(snapshot, run.id).length,
        };
      }),
  };
}

export function noRunStatus(sessionId: string | null, requestedRunId?: string): NoRunStatus {
  if (requestedRunId) {
    return {
      run: null,
      sessionId,
      hint: `找不到 Run ${requestedRunId}；先查看精简列表，再选择有效的 --run。`,
      nextActions: [{ priority: "waiting", command: "prospero status --all" }],
    };
  }
  if (!sessionId) {
    return {
      run: null,
      sessionId: null,
      hint: "未提供 PROSPERO_SESSION_ID；用 --session <id> 进入关联 Run，或先查看全部 Run。",
      nextActions: [{ priority: "waiting", command: "prospero status --all" }],
    };
  }
  return {
    run: null,
    sessionId,
    hint: `会话 ${sessionId} 没有关联 Run；查看全部 Run，或创建新的 Run。`,
    nextActions: [
      { priority: "waiting", command: "prospero status --all" },
      { priority: "complete", command: "prospero run create --objective '<objective>'" },
    ],
  };
}
