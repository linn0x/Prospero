import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import { sessionBranchUnavailable } from "../src/lib/session-branch";

const source: SessionInfo = { id: "source", agent: "codex", kind: "structured", status: "idle", cwd: "/project", title: "Source", createdAt: 1, cols: 80, rows: 24 };

describe("native conversation branches", () => {
  it.each(["claude", "codex"] as const)("allows an idle %s chat and a running terminal picker", (agent) => {
    expect(sessionBranchUnavailable({ ...source, agent })).toBeUndefined();
    expect(sessionBranchUnavailable({ ...source, agent, kind: "pty", status: "running" })).toBeUndefined();
  });
  it.each(["running", "starting", "waiting_approval", "waiting_input", "died"] as const)("rejects a structured chat in %s", (status) => {
    expect(sessionBranchUnavailable({ ...source, status })).toBeDefined();
  });
  it("rejects unsupported sources and missing workspaces", () => {
    expect(sessionBranchUnavailable({ ...source, agent: "shell" })).toBeDefined();
    expect(sessionBranchUnavailable({ ...source, cwd: "" })).toBeDefined();
    expect(sessionBranchUnavailable(undefined)).toBeDefined();
  });
});
