import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@prospero/protocol";

const { getItem, setItem } = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem, setItem },
}));

import {
  deviceAttentionMotion,
  sessionCompletionFingerprint,
  sessionCompletionReadKey,
} from "../src/lib/session-attention";

function session(
  id: string,
  status: SessionInfo["status"],
  patch: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    id,
    agent: "codex",
    kind: "structured",
    title: id,
    cwd: "/work",
    status,
    createdAt: 1,
    cols: 80,
    rows: 24,
    ...patch,
  };
}

describe("session attention", () => {
  beforeEach(() => {
    getItem.mockReset();
    setItem.mockReset();
  });

  it("prioritizes approval, then active work, then an unread completion", () => {
    const completed = session("completed", "completed", { preview: "ready" });
    const reads = {
      [sessionCompletionReadKey("pc", completed.id)]: "a different completion",
    };

    expect(deviceAttentionMotion("pc", { completed }, reads)).toBe("unread-completed");
    expect(deviceAttentionMotion("pc", {
      completed,
      working: session("working", "running"),
    }, reads)).toBe("working");
    expect(deviceAttentionMotion("pc", {
      completed,
      working: session("working", "running"),
      approval: session("approval", "waiting_approval", { pendingPermissions: 1 }),
    }, reads)).toBe("approval");
  });

  it("does not animate a completion after its exact revision has been read", () => {
    const completed = session("completed", "completed", {
      preview: "ready",
      totals: { costUsd: 0.01, inputTokens: 10, outputTokens: 20 },
    });
    const fingerprint = sessionCompletionFingerprint(completed);
    expect(fingerprint).not.toBeNull();
    expect(deviceAttentionMotion("pc", { completed }, {
      [sessionCompletionReadKey("pc", completed.id)]: fingerprint!,
    })).toBeNull();

    const nextCompletion = { ...completed, preview: "new reply" };
    expect(deviceAttentionMotion("pc", { completed: nextCompletion }, {
      [sessionCompletionReadKey("pc", completed.id)]: fingerprint!,
    })).toBe("unread-completed");
  });

  it("waits for read-state hydration before showing completion attention", () => {
    expect(deviceAttentionMotion("pc", {
      completed: session("completed", "completed"),
    }, null)).toBeNull();
  });
});
