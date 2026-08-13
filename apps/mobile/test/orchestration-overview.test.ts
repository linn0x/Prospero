import { describe, expect, it } from "vitest";
import type {
  OrchestrationGate,
  OrchestrationRun,
  OrchestrationSnapshot,
} from "@prospero/protocol";
import {
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
});
