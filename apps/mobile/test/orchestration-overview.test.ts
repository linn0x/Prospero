import { describe, expect, it } from "vitest";
import type {
  OrchestrationDispatch,
  OrchestrationGate,
  OrchestrationRun,
  OrchestrationSnapshot,
  OrchestrationTask,
} from "@prospero/protocol";
import {
  coordinatorRunsBySession,
  goalSessionGroups,
  goalSessionVisibility,
  groupOrchestrationRuns,
  goalRunOverview,
  orchestrationRunCurrentState,
  orchestrationConnectionNotice,
  orchestrationRoute,
  selectedRouteRunId,
} from "../src/lib/orchestration-overview";

function run(id: string, updatedAt: number, status: OrchestrationRun["status"] = "active"): OrchestrationRun {
  return {
    id,
    objective: id,
    status,
    coordinatorSessionId: `session-${id}`,
    createdAt: 1,
    updatedAt,
  };
}

function gate(id: string, runId: string, status: OrchestrationGate["status"] = "pending"): OrchestrationGate {
  return {
    id,
    runId,
    taskId: null,
    question: id,
    options: [],
    status,
    decision: null,
    createdAt: 1,
    resolvedAt: null,
  };
}

function task(
  id: string,
  status: OrchestrationTask["status"],
  deps: string[] = [],
): OrchestrationTask {
  return {
    id,
    runId: "state-run",
    title: id,
    spec: "",
    deps,
    parentId: null,
    status,
    result: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function dispatch(
  id: string,
  taskId: string,
  state: OrchestrationDispatch["state"],
  startedAt: number,
): OrchestrationDispatch {
  return {
    id,
    runId: "state-run",
    taskId,
    sessionId: `session-${id}`,
    worktreePath: null,
    state,
    startedAt,
    settledAt: state === "starting" || state === "running" ? null : startedAt + 1,
    outcome: null,
  };
}

function snapshot(
  runs: OrchestrationRun[],
  gates: OrchestrationGate[] = [],
  tasks: OrchestrationTask[] = [],
  dispatches: OrchestrationDispatch[] = [],
): OrchestrationSnapshot {
  return { runs, gates, tasks, dispatches };
}

describe("orchestration overview", () => {
  it("keeps idle, connecting, reconnecting, and failed transport states distinct", () => {
    expect(orchestrationConnectionNotice("idle", null, "Studio Mac")?.text).toBe("Studio Mac 尚未连接");
    expect(orchestrationConnectionNotice("connecting", null, "Studio Mac")?.text).toBe("正在连接 Studio Mac…");
    expect(orchestrationConnectionNotice("reconnecting", null, "Studio Mac")?.text).toBe("正在重连 Studio Mac…");
    expect(orchestrationConnectionNotice("failed", "握手超时", "Studio Mac")).toEqual({
      text: "连接失败：握手超时",
      tone: "danger",
      canRetry: true,
    });
    expect(orchestrationConnectionNotice("connected", null, "Studio Mac")).toBeNull();
  });

  it("keeps at most three summaries while putting Runs with pending Gates first", () => {
    const overview = goalRunOverview(snapshot(
      [
        run("newest-without-gate", 90),
        run("gate-one", 40),
        run("gate-two", 30),
        run("gate-three", 20),
        run("gate-four", 10),
        run("completed-gate", 100, "completed"),
      ],
      [
        gate("g1", "gate-one"),
        gate("g2", "gate-two"),
        gate("g3", "gate-three"),
        gate("g4", "gate-four"),
        gate("resolved", "newest-without-gate", "resolved"),
        gate("inactive", "completed-gate"),
      ],
    ));

    expect(overview.visibleRuns.map((item) => item.id)).toEqual([
      "gate-one",
      "gate-two",
      "gate-three",
    ]);
    expect(overview.truncatedRunCount).toBe(2);
    expect(overview.pendingGateCount).toBe(4);
    expect(overview.truncatedPendingGateCount).toBe(1);
    expect(overview.firstTruncatedGateRunId).toBe("gate-four");
  });

  it("builds a safe Run deep link and ignores stale route selections", () => {
    const runs = [run("first", 2), run("selected run", 1)];
    expect(orchestrationRoute("host /?#", "selected run")).toBe(
      "/host/host%20%2F%3F%23/orchestration?runId=selected%20run",
    );
    expect(selectedRouteRunId("selected run", runs)).toBe("selected run");
    expect(selectedRouteRunId(["first"], runs)).toBe("first");
    expect(selectedRouteRunId("deleted", runs)).toBeNull();
  });

  it("identifies coordinator sessions and prefers their active Run", () => {
    const historical = run("historical", 100, "completed");
    historical.coordinatorSessionId = "coordinator";
    const active = run("active", 20);
    active.coordinatorSessionId = "coordinator";
    const manual = run("manual", 200);
    manual.coordinatorSessionId = null;

    const indexed = coordinatorRunsBySession([historical, active, manual]);

    expect(indexed.get("coordinator")?.id).toBe("active");
    expect(indexed.has("session-manual")).toBe(false);
  });

  it("separates active Runs from folded history and keeps each group newest first", () => {
    const groups = groupOrchestrationRuns([
      run("completed-old", 10, "completed"),
      run("active-old", 20),
      run("abandoned-new", 50, "abandoned"),
      run("active-new", 40),
    ]);

    expect(groups.active.map((item) => item.id)).toEqual(["active-new", "active-old"]);
    expect(groups.history.map((item) => item.id)).toEqual([
      "abandoned-new",
      "completed-old",
    ]);
    expect(groups.all.map((item) => item.id)).toEqual([
      "active-new",
      "active-old",
      "abandoned-new",
      "completed-old",
    ]);
  });

  it("groups worker session attempts under the selected Goal coordinator", () => {
    const historical = run("historical", 100, "completed");
    historical.coordinatorSessionId = "coordinator";
    const active = run("active", 20);
    active.coordinatorSessionId = "coordinator";
    const task: OrchestrationTask = {
      id: "task-active",
      runId: active.id,
      title: "实现修复",
      spec: "",
      deps: [],
      parentId: null,
      status: "done",
      result: "完成",
      createdAt: 2,
      updatedAt: 3,
    };
    const dispatch = (sessionId: string, startedAt: number): OrchestrationDispatch => ({
      id: `dispatch-${sessionId}-${String(startedAt)}`,
      runId: active.id,
      taskId: task.id,
      sessionId,
      worktreePath: null,
      state: "succeeded",
      startedAt,
      settledAt: startedAt + 1,
      outcome: "完成",
    });
    const groups = goalSessionGroups({
      runs: [historical, active],
      tasks: [task],
      dispatches: [dispatch("worker-new", 30), dispatch("worker-old", 10)],
      gates: [],
    });

    expect(groups.get("coordinator")).toMatchObject({ run: { id: "active" } });
    expect(groups.get("coordinator")?.workers.map((worker) => worker.sessionId)).toEqual([
      "worker-old",
      "worker-new",
    ]);

    const filtered = goalSessionVisibility(
      groups,
      new Set(["worker-new"]),
      new Set(["coordinator", "worker-old", "worker-new"]),
    );
    expect([...filtered.displayedCoordinatorIds]).toEqual(["coordinator"]);
    expect([...filtered.contextualCoordinatorIds]).toEqual(["coordinator"]);
    expect([...filtered.nestedWorkerIds]).toEqual(["worker-new"]);
  });

  it("puts a pending Gate before every other next step and retains its task target", () => {
    const selected = run("state-run", 10);
    const gated = task("gated", "blocked");
    const pending = gate("gate-1", selected.id);
    pending.taskId = gated.id;
    const state = orchestrationRunCurrentState(selected, snapshot(
      [selected],
      [pending],
      [gated, task("failed", "failed"), task("active", "dispatched"), task("ready", "pending")],
      [dispatch("active", "active", "running", 2)],
    ));

    expect(state).toMatchObject({
      done: 0,
      total: 4,
      blocked: 1,
      pendingGateCount: 1,
      guide: { kind: "gate", gateId: pending.id, taskId: gated.id },
    });
  });

  it("prioritizes failed work over running and ready work", () => {
    const selected = run("state-run", 10);
    const state = orchestrationRunCurrentState(selected, snapshot(
      [selected],
      [],
      [task("failed", "failed"), task("active", "dispatched"), task("ready", "pending")],
      [dispatch("active", "active", "running", 2)],
    ));

    expect(state.failed).toBe(1);
    expect(state.running).toBe(1);
    expect(state.ready).toBe(1);
    expect(state.guide).toMatchObject({ kind: "failed", taskId: "failed" });
  });

  it("counts only current starting or running Dispatches as running", () => {
    const selected = run("state-run", 10);
    const state = orchestrationRunCurrentState(selected, snapshot(
      [selected],
      [],
      [task("active", "dispatched"), task("retried", "pending")],
      [
        dispatch("historic-failure", "retried", "failed", 30),
        dispatch("active-worker", "active", "running", 20),
      ],
    ));

    expect(state.running).toBe(1);
    expect(state.ready).toBe(1);
    expect(state.currentDispatches.map((item) => item.id)).toEqual(["active-worker"]);
    expect(state.guide.kind).toBe("running");
  });

  it("treats a settled retry attempt as history rather than active work", () => {
    const selected = run("state-run", 10);
    const state = orchestrationRunCurrentState(selected, snapshot(
      [selected],
      [],
      [task("retried", "pending")],
      [dispatch("historic-failure", "retried", "failed", 30)],
    ));

    expect(state).toMatchObject({ running: 0, ready: 1, guide: { kind: "ready" } });
    expect(state.currentDispatches).toEqual([]);
  });

  it("labels ready work as hand-dispatched only for a manual Run", () => {
    const selected = run("state-run", 10);
    selected.coordinatorSessionId = null;
    const state = orchestrationRunCurrentState(selected, snapshot(
      [selected],
      [],
      [task("ready", "pending")],
    ));

    expect(state.ready).toBe(1);
    expect(state.guide).toMatchObject({ kind: "ready", taskId: "ready" });
    expect(state.guide.text).toContain("手工派发");

    const coordinator = run("state-run", 11);
    const coordinatorState = orchestrationRunCurrentState(coordinator, snapshot(
      [coordinator],
      [],
      [task("ready", "pending")],
    ));
    expect(coordinatorState.guide.text).toContain("协调者派发");
  });

  it("keeps unmet and cancelled dependencies waiting instead of silently releasing them", () => {
    const selected = run("state-run", 10);
    const unmet = orchestrationRunCurrentState(selected, snapshot(
      [selected],
      [],
      [task("upstream", "dispatched"), task("downstream", "pending", ["upstream"])],
    ));
    const cancelled = orchestrationRunCurrentState(selected, snapshot(
      [selected],
      [],
      [task("cancelled", "cancelled"), task("downstream", "pending", ["cancelled"])],
    ));

    expect(unmet).toMatchObject({ ready: 0, waiting: 1, guide: { kind: "waiting" } });
    expect(unmet.guide.text).toContain("前置依赖");
    expect(cancelled).toMatchObject({
      ready: 0,
      waiting: 1,
      waitingOnCancelledDependency: 1,
      guide: { kind: "waiting" },
    });
    expect(cancelled.guide.text).toContain("依赖已取消");
  });

  it("marks a fully terminal active Run as completable, including cancelled tasks", () => {
    const selected = run("state-run", 10);
    const state = orchestrationRunCurrentState(selected, snapshot(
      [selected],
      [],
      [task("done", "done"), task("cancelled", "cancelled")],
    ));

    expect(state).toMatchObject({
      done: 1,
      total: 2,
      cancelled: 1,
      canComplete: true,
      guide: { kind: "complete" },
    });
  });

  it("keeps completed Runs read-only even if an old snapshot carries a pending-looking task", () => {
    const selected = run("state-run", 10, "completed");
    const state = orchestrationRunCurrentState(selected, snapshot(
      [selected],
      [],
      [task("old", "pending")],
      [dispatch("historic", "old", "succeeded", 1)],
    ));

    expect(state.canComplete).toBe(false);
    expect(state.guide).toMatchObject({ kind: "complete" });
    expect(state.guide.text).toContain("只读");
  });
});
