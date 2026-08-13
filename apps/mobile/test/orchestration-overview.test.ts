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

function snapshot(runs: OrchestrationRun[], gates: OrchestrationGate[] = []): OrchestrationSnapshot {
  return { runs, gates, tasks: [], dispatches: [] };
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
});
