import { describe, expect, it } from "vitest";
import type { OrchestrationState, Run, Task } from "../src/orchestration/model.js";
import {
  noRunStatus,
  projectRunList,
  projectRunStatus,
  selectRunForSession,
} from "../src/orchestration/status-projection.js";

function run(id: string, status: Run["status"], updatedAt: number, coordinatorSessionId = "coord"): Run {
  return {
    id,
    objective: `${id} objective`,
    status,
    coordinatorSessionId,
    graphRevision: 3,
    automation: null,
    coordinatorPrompt: null,
    createdAt: updatedAt - 10,
    updatedAt,
  };
}

function task(input: Pick<Task, "id" | "runId" | "status"> & Partial<Pick<Task, "deps" | "title">>): Task {
  return {
    id: input.id,
    runId: input.runId,
    title: input.title ?? input.id,
    spec: "PRIVATE SPEC MUST NOT APPEAR",
    deps: input.deps ?? [],
    parentId: null,
    status: input.status,
    result: "PRIVATE RESULT MUST NOT APPEAR",
    createdAt: 10,
    updatedAt: 20,
  };
}

function snapshot(): OrchestrationState {
  const active = run("run-active", "active", 20);
  const history = run("run-history", "completed", 100);
  const gated = task({ id: "task-gated", runId: active.id, status: "blocked" });
  const failed = task({ id: "task-failed", runId: active.id, status: "failed" });
  const running = task({ id: "task-running", runId: active.id, status: "dispatched" });
  const ready = task({ id: "task-ready", runId: active.id, status: "pending", title: "可派发" });
  const waiting = task({ id: "task-waiting", runId: active.id, status: "pending", deps: ["task-failed"] });
  return {
    version: 2,
    runs: { [active.id]: active, [history.id]: history },
    tasks: {
      [gated.id]: gated,
      [failed.id]: failed,
      [running.id]: running,
      [ready.id]: ready,
      [waiting.id]: waiting,
    },
    dispatches: {
      "dispatch-running": {
        id: "dispatch-running",
        runId: active.id,
        taskId: running.id,
        sessionId: "worker-session",
        worktreePath: "/private/worktree",
        state: "running",
        startedAt: 30,
        settledAt: null,
        outcome: null,
      },
    },
    messages: {
      "message-private": {
        id: "message-private",
        runId: active.id,
        from: "worker-session",
        to: "coord",
        type: "report",
        subject: "PRIVATE MESSAGE",
        body: "PRIVATE MESSAGE",
        threadId: null,
        taskId: null,
        createdAt: 30,
        readAt: null,
        answeredAt: null,
      },
    },
    gates: {
      "gate-pending": {
        id: "gate-pending",
        runId: active.id,
        taskId: gated.id,
        question: "选择发布策略？",
        options: ["A", "B"],
        status: "pending",
        decision: null,
        createdAt: 40,
        resolvedAt: null,
      },
    },
    operations: {},
    worktreeAssets: {},
  };
}

describe("orchestration status projection", () => {
  it("chooses the active associated Run before a newer historical Run", () => {
    const state = snapshot();
    expect(selectRunForSession(state, "coord")?.id).toBe("run-active");
    expect(selectRunForSession(state, "worker-session")?.id).toBe("run-active");
    expect(selectRunForSession(state, null)).toBeNull();
  });

  it("projects compact state and emits only highest-priority Gate actions", () => {
    const state = snapshot();
    const compact = projectRunStatus(state, state.runs["run-active"]!);

    expect(compact.taskCounts).toEqual({
      pending: 2, dispatched: 1, blocked: 1, done: 0, failed: 1, cancelled: 0, ready: 1,
    });
    expect(compact.readyTasks).toEqual([{ id: "task-ready", title: "可派发", deps: [] }]);
    expect(compact.activeWorkers).toEqual([
      expect.objectContaining({ taskId: "task-running", sessionId: "worker-session", state: "running" }),
    ]);
    expect(compact.pendingGates).toEqual([
      expect.objectContaining({ id: "gate-pending", taskId: "task-gated" }),
    ]);
    expect(compact.nextActions).toEqual([
      expect.objectContaining({ priority: "gate", command: expect.stringContaining("gate resolve") }),
    ]);

    const serialized = JSON.stringify(compact);
    expect(serialized).not.toContain("PRIVATE SPEC");
    expect(serialized).not.toContain("PRIVATE RESULT");
    expect(serialized).not.toContain("PRIVATE MESSAGE");
    expect(serialized).not.toContain("/private/worktree");
  });

  it("falls through failed, running, ready, waiting, then complete actions", () => {
    const state = snapshot();
    const active = state.runs["run-active"]!;
    delete state.gates["gate-pending"];
    expect(projectRunStatus(state, active).nextActions[0]).toMatchObject({ priority: "failed" });

    state.tasks["task-failed"]!.status = "done";
    expect(projectRunStatus(state, active).nextActions[0]).toMatchObject({ priority: "running" });

    delete state.dispatches["dispatch-running"];
    state.tasks["task-running"]!.status = "done";
    expect(projectRunStatus(state, active).nextActions[0]).toMatchObject({ priority: "ready" });

    state.tasks["task-ready"]!.status = "done";
    state.tasks["task-waiting"]!.status = "blocked";
    expect(projectRunStatus(state, active).nextActions[0]).toMatchObject({ priority: "waiting" });

    state.tasks["task-waiting"]!.status = "cancelled";
    state.tasks["task-gated"]!.status = "cancelled";
    expect(projectRunStatus(state, active).nextActions[0]).toMatchObject({ priority: "complete" });
  });

  it("lists compact Runs and gives an executable empty-state hint", () => {
    const state = snapshot();
    expect(projectRunList(state).runs).toEqual([
      expect.objectContaining({ id: "run-history", activeWorkerCount: 0, pendingGateCount: 0 }),
      expect.objectContaining({ id: "run-active", activeWorkerCount: 1, pendingGateCount: 1 }),
    ]);
    expect(noRunStatus("coord", "missing")).toMatchObject({
      run: null,
      nextActions: [expect.objectContaining({ command: "prospero status --all" })],
    });
  });
});
