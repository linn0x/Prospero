import { describe, expect, it } from "vitest";
import {
  automationStartParams,
  workerStartParams,
} from "../src/renderer/src/orchestration-launch";

describe("Electron orchestration launch selection", () => {
  it("uses the selected worker agent, project, and Codex account", () => {
    expect(workerStartParams({
      agent: "codex",
      cwd: "/repos/selected",
      accountId: "codex-work",
    }, "task-1", "operation-1")).toMatchObject({
      taskId: "task-1",
      agent: "codex",
      cwd: "/repos/selected",
      accountId: "codex-work",
    });
  });

  it("uses the selected Claude account for automatic DAG execution", () => {
    expect(automationStartParams({
      agent: "claude",
      cwd: "/repos/another-project",
      accountId: "claude-api",
    }, "run-1", "operation-2")).toEqual({
      operationId: "operation-2",
      runId: "run-1",
      agent: "claude",
      cwd: "/repos/another-project",
      accountId: "claude-api",
      approvalPolicy: "standard",
      workspace: "run",
    });
  });

  it("does not leak a stale account into agents without account environments", () => {
    expect(automationStartParams({
      agent: "opencode",
      cwd: "/repos/selected",
      accountId: "stale-account",
    }, "run-1", "operation-3")).not.toHaveProperty("accountId");
  });
});
