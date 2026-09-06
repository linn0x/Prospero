import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@prospero/protocol";

import { emptyRuntime, useApp } from "../src/lib/store";

function session(id: string, preview: string): SessionInfo {
  return {
    id,
    agent: "codex",
    kind: "structured",
    title: id,
    cwd: "/tmp/project",
    status: "running",
    preview,
    createdAt: 1,
    cols: 80,
    rows: 24,
  };
}

describe("session update batching", () => {
  afterEach(() => {
    vi.useRealTimers();
    useApp.setState({ hosts: [], runtimes: {}, homeSettings: useApp.getState().homeSettings });
  });

  it("coalesces repeated updates for one session and keeps the latest value", () => {
    vi.useFakeTimers();
    useApp.setState({
      runtimes: { mac: { ...emptyRuntime, status: "connected" } },
    });

    useApp.getState().queueSessionUpdate("mac", session("s1", "first"));
    useApp.getState().queueSessionUpdate("mac", session("s1", "latest"));
    expect(useApp.getState().runtimes.mac.sessions.s1).toBeUndefined();

    vi.advanceTimersByTime(15);
    expect(useApp.getState().runtimes.mac.sessions.s1).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(useApp.getState().runtimes.mac.sessions.s1?.preview).toBe("latest");
  });

  it("keeps different hosts and sessions in the same frame", () => {
    vi.useFakeTimers();
    useApp.getState().queueSessionUpdate("mac", session("s1", "mac"));
    useApp.getState().queueSessionUpdate("pc", session("s2", "pc"));
    vi.advanceTimersByTime(16);

    expect(useApp.getState().runtimes.mac.sessions.s1?.preview).toBe("mac");
    expect(useApp.getState().runtimes.pc.sessions.s2?.preview).toBe("pc");
  });
});
