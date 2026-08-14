import type {
  OrchestrationDispatch,
  OrchestrationGate,
  OrchestrationRun,
  OrchestrationSnapshot,
  OrchestrationTask,
} from "@prospero/protocol";
import type { ConnStatus } from "@/lib/store";

export const GOAL_RUN_SUMMARY_LIMIT = 3;
export const ORCHESTRATION_ACTION_MIN_HIT_TARGET = 44;

export type OrchestrationNoticeTone = "quiet" | "warning" | "danger";

export interface OrchestrationConnectionNotice {
  text: string;
  tone: OrchestrationNoticeTone;
  canRetry: boolean;
}

/** Keeps each transient transport state distinct instead of treating failures as loading. */
export function orchestrationConnectionNotice(
  status: ConnStatus,
  lastError: string | null,
  hostName: string | undefined,
): OrchestrationConnectionNotice | null {
  const target = hostName ?? "电脑";
  switch (status) {
    case "connected":
      return null;
    case "idle":
      return { text: `${target} 尚未连接`, tone: "quiet", canRetry: false };
    case "connecting":
      return { text: `正在连接 ${target}…`, tone: "warning", canRetry: false };
    case "reconnecting":
      return { text: `正在重连 ${target}…`, tone: "warning", canRetry: false };
    case "failed":
      return {
        text: lastError ? `连接失败：${lastError}` : "连接失败。请检查网络后重试。",
        tone: "danger",
        canRetry: true,
      };
  }
}

export interface GoalRunOverview {
  visibleRuns: OrchestrationRun[];
  activeRunCount: number;
  truncatedRunCount: number;
  pendingGateCount: number;
  truncatedPendingGateCount: number;
  /** The first hidden Run that contains a pending Gate, if any. */
  firstTruncatedGateRunId: string | null;
}

export interface OrchestrationRunGroups {
  active: OrchestrationRun[];
  history: OrchestrationRun[];
  all: OrchestrationRun[];
}

export type OrchestrationRunGuideKind =
  | "gate"
  | "failed"
  | "running"
  | "ready"
  | "waiting"
  | "complete";

export interface OrchestrationRunGuide {
  /** One intentional next step, ordered gate → failed → running → ready → waiting → complete. */
  kind: OrchestrationRunGuideKind;
  text: string;
  gateId: string | null;
  taskId: string | null;
}

export interface OrchestrationRunCurrentState {
  done: number;
  total: number;
  ready: number;
  running: number;
  failed: number;
  blocked: number;
  waiting: number;
  cancelled: number;
  pendingGateCount: number;
  /** Pending tasks whose prerequisite was explicitly cancelled, never silently made ready. */
  waitingOnCancelledDependency: number;
  /** Active attempts only; succeeded/failed/abandoned attempts remain dispatch history. */
  currentDispatches: OrchestrationDispatch[];
  readyTaskIds: ReadonlySet<string>;
  pendingGates: OrchestrationGate[];
  canComplete: boolean;
  guide: OrchestrationRunGuide;
}

function newestFirstDispatch(
  left: OrchestrationDispatch,
  right: OrchestrationDispatch,
): number {
  return right.startedAt - left.startedAt || right.id.localeCompare(left.id);
}

/**
 * Returns the selected Run's actionable state without duplicating daemon state.
 *
 * A Dispatch is current only while it is `starting` or `running`; settled attempts
 * intentionally do not keep a retried task in the running state. Dependencies are
 * ready only when every prerequisite is `done`, which deliberately leaves a task
 * waiting when a prerequisite was cancelled or is missing from a stale snapshot.
 */
export function orchestrationRunCurrentState(
  run: OrchestrationRun,
  snapshot: OrchestrationSnapshot,
): OrchestrationRunCurrentState {
  const tasks = snapshot.tasks.filter((task) => task.runId === run.id);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const pendingGates = snapshot.gates
    .filter((gate) => gate.runId === run.id && gate.status === "pending")
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const activeDispatchesByTask = new Map<string, OrchestrationDispatch>();

  for (const dispatch of snapshot.dispatches) {
    if (
      dispatch.runId !== run.id ||
      (dispatch.state !== "starting" && dispatch.state !== "running")
    ) continue;
    const previous = activeDispatchesByTask.get(dispatch.taskId);
    if (!previous || newestFirstDispatch(dispatch, previous) < 0) {
      activeDispatchesByTask.set(dispatch.taskId, dispatch);
    }
  }

  const currentDispatches = [...activeDispatchesByTask.values()].sort(newestFirstDispatch);
  const done = tasks.filter((task) => task.status === "done").length;
  const failed = tasks.filter((task) => task.status === "failed").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const cancelled = tasks.filter((task) => task.status === "cancelled").length;
  const pending = tasks.filter((task) => task.status === "pending");
  const readyTasks = pending.filter((task) =>
    task.deps.every((dependencyId) => taskById.get(dependencyId)?.status === "done"),
  );
  const readyIds = new Set(readyTasks.map((task) => task.id));
  const waitingTasks = pending.filter((task) => !readyIds.has(task.id));
  const waitingOnCancelledDependency = waitingTasks.filter((task) =>
    task.deps.some((dependencyId) => taskById.get(dependencyId)?.status === "cancelled"),
  ).length;
  const waiting = waitingTasks.length + blocked;
  const readOnly = run.status !== "active";
  const automationRunning = run.automation?.state === "running";
  const canComplete = !readOnly &&
    pendingGates.length === 0 &&
    currentDispatches.length === 0 &&
    !automationRunning &&
    tasks.every((task) => task.status === "done" || task.status === "cancelled");

  let guide: OrchestrationRunGuide;
  if (readOnly) {
    guide = {
      kind: "complete",
      text: run.status === "completed" ? "此 Run 已完成，只读。" : "此 Run 已放弃，只读。",
      gateId: null,
      taskId: null,
    };
  } else if (pendingGates.length > 0) {
    const gate = pendingGates[0]!;
    guide = {
      kind: "gate",
      text: `先处理 ${String(pendingGates.length)} 个待决 Gate。`,
      gateId: gate.id,
      taskId: gate.taskId,
    };
  } else if (failed > 0) {
    guide = {
      kind: "failed",
      text: `${String(failed)} 个任务失败，请重试、取消或调整任务图。`,
      gateId: null,
      taskId: tasks.find((task) => task.status === "failed")?.id ?? null,
    };
  } else if (currentDispatches.length > 0 || automationRunning) {
    guide = {
      kind: "running",
      text: currentDispatches.length > 0
        ? `${String(currentDispatches.length)} 个 worker 正在运行，等待显式交付。`
        : "自动执行正在运行，等待下一次调度。",
      gateId: null,
      taskId: currentDispatches[0]?.taskId ?? null,
    };
  } else if (readyTasks.length > 0) {
    guide = {
      kind: "ready",
      text: run.coordinatorSessionId === null
        ? `${String(readyTasks.length)} 个任务已就绪，等待你手工派发。`
        : `${String(readyTasks.length)} 个任务已就绪，等待协调者派发。`,
      gateId: null,
      taskId: readyTasks[0]?.id ?? null,
    };
  } else if (waiting > 0) {
    guide = {
      kind: "waiting",
      text: waitingOnCancelledDependency > 0
        ? `${String(waitingOnCancelledDependency)} 个任务的依赖已取消，请调整依赖后再继续。`
        : blocked > 0
          ? `${String(blocked)} 个任务被阻塞，等待决策或协调者处理。`
          : `${String(waitingTasks.length)} 个任务等待前置依赖完成。`,
      gateId: null,
      taskId: waitingTasks[0]?.id ?? tasks.find((task) => task.status === "blocked")?.id ?? null,
    };
  } else {
    guide = {
      kind: "complete",
      text: canComplete ? "所有任务已结束，可以标记此 Run 完成。" : "当前没有待处理任务。",
      gateId: null,
      taskId: null,
    };
  }

  return {
    done,
    total: tasks.length,
    ready: readyTasks.length,
    running: currentDispatches.length,
    failed,
    blocked,
    waiting,
    cancelled,
    pendingGateCount: pendingGates.length,
    waitingOnCancelledDependency,
    currentDispatches,
    readyTaskIds: readyIds,
    pendingGates,
    canComplete,
    guide,
  };
}

/** Active work stays prominent; completed and abandoned Runs become history. */
export function groupOrchestrationRuns(
  runs: readonly OrchestrationRun[],
): OrchestrationRunGroups {
  const newestFirst = (left: OrchestrationRun, right: OrchestrationRun): number =>
    right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
  const active = runs.filter((run) => run.status === "active").sort(newestFirst);
  const history = runs.filter((run) => run.status !== "active").sort(newestFirst);
  return { active, history, all: [...active, ...history] };
}

/**
 * Indexes coordinator sessions for the session list and detail screen.
 * An active Run wins over historical Runs; otherwise the newest update wins.
 */
export function coordinatorRunsBySession(
  runs: readonly OrchestrationRun[],
): Map<string, OrchestrationRun> {
  const indexed = new Map<string, OrchestrationRun>();
  for (const run of runs) {
    const sessionId = run.coordinatorSessionId;
    if (!sessionId) continue;
    const previous = indexed.get(sessionId);
    const active = run.status === "active";
    const previousActive = previous?.status === "active";
    if (
      previous === undefined ||
      (active && !previousActive) ||
      (active === previousActive && run.updatedAt > previous.updatedAt)
    ) {
      indexed.set(sessionId, run);
    }
  }
  return indexed;
}

export interface GoalWorkerSessionLink {
  sessionId: string;
  taskId: string;
  taskTitle: string;
  taskStatus: OrchestrationTask["status"];
  dispatchState: OrchestrationDispatch["state"];
  startedAt: number;
}

export interface GoalSessionGroup {
  run: OrchestrationRun;
  workers: GoalWorkerSessionLink[];
}

export interface GoalSessionVisibility {
  displayedCoordinatorIds: Set<string>;
  contextualCoordinatorIds: Set<string>;
  nestedWorkerIds: Set<string>;
}

/** Keeps a Goal grouped when filtering or archive state hides only its coordinator row. */
export function goalSessionVisibility(
  groups: ReadonlyMap<string, GoalSessionGroup>,
  visibleSessionIds: ReadonlySet<string>,
  availableSessionIds: ReadonlySet<string>,
): GoalSessionVisibility {
  const displayedCoordinatorIds = new Set<string>();
  const contextualCoordinatorIds = new Set<string>();
  const nestedWorkerIds = new Set<string>();
  for (const [coordinatorSessionId, group] of groups) {
    const coordinatorVisible = visibleSessionIds.has(coordinatorSessionId);
    const visibleWorkers = group.workers.filter((worker) =>
      visibleSessionIds.has(worker.sessionId));
    const canShowContext = availableSessionIds.has(coordinatorSessionId) && visibleWorkers.length > 0;
    if (!coordinatorVisible && !canShowContext) continue;
    displayedCoordinatorIds.add(coordinatorSessionId);
    if (!coordinatorVisible) contextualCoordinatorIds.add(coordinatorSessionId);
    for (const worker of visibleWorkers) nestedWorkerIds.add(worker.sessionId);
  }
  return { displayedCoordinatorIds, contextualCoordinatorIds, nestedWorkerIds };
}

/**
 * Links independently persisted worker sessions back to their coordinator.
 * A retry remains visible as another worker session, while duplicate snapshots
 * of the same dispatch session collapse to its newest record.
 */
export function goalSessionGroups(
  snapshot: OrchestrationSnapshot | null,
): Map<string, GoalSessionGroup> {
  const groups = new Map<string, GoalSessionGroup>();
  if (!snapshot) return groups;
  const tasks = new Map(snapshot.tasks.map((task) => [task.id, task]));
  const selectedRuns = coordinatorRunsBySession(snapshot.runs);

  for (const [coordinatorSessionId, run] of selectedRuns) {
    const workers = new Map<string, GoalWorkerSessionLink>();
    for (const dispatch of snapshot.dispatches) {
      if (dispatch.runId !== run.id || dispatch.sessionId === coordinatorSessionId) continue;
      const task = tasks.get(dispatch.taskId);
      if (!task) continue;
      const previous = workers.get(dispatch.sessionId);
      if (previous && previous.startedAt > dispatch.startedAt) continue;
      workers.set(dispatch.sessionId, {
        sessionId: dispatch.sessionId,
        taskId: task.id,
        taskTitle: task.title,
        taskStatus: task.status,
        dispatchState: dispatch.state,
        startedAt: dispatch.startedAt,
      });
    }
    groups.set(coordinatorSessionId, {
      run,
      workers: [...workers.values()].sort(
        (left, right) =>
          left.startedAt - right.startedAt || left.sessionId.localeCompare(right.sessionId),
      ),
    });
  }
  return groups;
}

/**
 * Home intentionally remains a compact summary. Pending human decisions come
 * first, then the newest remaining Runs, with deterministic ties for a stable
 * order across snapshot deliveries.
 */
export function goalRunOverview(
  snapshot: OrchestrationSnapshot | null,
  limit = GOAL_RUN_SUMMARY_LIMIT,
): GoalRunOverview {
  const activeRuns = (snapshot?.runs ?? []).filter((run) => run.status === "active");
  const activeRunIds = new Set(activeRuns.map((run) => run.id));
  const pendingGatesByRun = new Map<string, number>();
  for (const gate of snapshot?.gates ?? []) {
    if (gate.status !== "pending" || !activeRunIds.has(gate.runId)) continue;
    pendingGatesByRun.set(gate.runId, (pendingGatesByRun.get(gate.runId) ?? 0) + 1);
  }

  const orderedRuns = [...activeRuns].sort((left, right) => {
    const gateOrder = Number((pendingGatesByRun.get(right.id) ?? 0) > 0)
      - Number((pendingGatesByRun.get(left.id) ?? 0) > 0);
    if (gateOrder !== 0) return gateOrder;
    return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
  });
  const visibleRuns = orderedRuns.slice(0, Math.max(0, limit));
  const truncatedRuns = orderedRuns.slice(visibleRuns.length);
  const pendingGateCount = Array.from(pendingGatesByRun.values()).reduce(
    (total, count) => total + count,
    0,
  );
  const truncatedPendingGateCount = truncatedRuns.reduce(
    (total, run) => total + (pendingGatesByRun.get(run.id) ?? 0),
    0,
  );

  return {
    visibleRuns,
    activeRunCount: orderedRuns.length,
    truncatedRunCount: truncatedRuns.length,
    pendingGateCount,
    truncatedPendingGateCount,
    firstTruncatedGateRunId:
      truncatedRuns.find((run) => (pendingGatesByRun.get(run.id) ?? 0) > 0)?.id ?? null,
  };
}

/** Builds the one-hop deep link from the compact home summary to orchestration. */
export function orchestrationRoute(hostId: string, runId?: string | null): string {
  const path = `/host/${encodeURIComponent(hostId)}/orchestration`;
  return runId ? `${path}?runId=${encodeURIComponent(runId)}` : path;
}

/** Ignores a stale or malformed deep-link selection and preserves normal entry. */
export function selectedRouteRunId(
  value: string | string[] | undefined,
  runs: readonly OrchestrationRun[],
): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && runs.some((run) => run.id === candidate) ? candidate : null;
}
