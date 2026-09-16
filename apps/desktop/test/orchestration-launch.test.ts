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
      agent: "deepseek",
      cwd: "/repos/selected",
      accountId: "stale-account",
    }, "run-1", "operation-3")).not.toHaveProperty("accountId");
  });

  it("uses the selected OpenCode profile account for workers and automation", () => {
    expect(workerStartParams({
      agent: "opencode",
      cwd: "/repos/chat-profile",
      accountId: "chat-account",
    }, "task-2", "operation-4")).toMatchObject({
      taskId: "task-2",
      agent: "opencode",
      accountId: "chat-account",
    });
    expect(automationStartParams({
      agent: "opencode",
      cwd: "/repos/chat-profile",
      accountId: "chat-account",
    }, "run-2", "operation-5")).toMatchObject({
      runId: "run-2",
      agent: "opencode",
      accountId: "chat-account",
    });
  });
});
