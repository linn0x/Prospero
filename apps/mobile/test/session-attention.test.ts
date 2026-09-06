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
  completionBaselineHostKey,
  deviceAttentionMotion,
  readCompletedSessions,
  sessionHasUnreadCompletion,
  sessionNeedsLocatorMotion,
  sessionRequiresApproval,
  sessionCompletionFingerprint,
  sessionCompletionReadKey,
  unreadCompletedSessionCount,
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

  it("baselines historical completions and only raises later completions", () => {
    const historical = session("historical", "completed", { preview: "old" });
    const reads = readCompletedSessions("pc", { historical }, {});

    expect(completionBaselineHostKey("pc/desk")).toBe("pc%2Fdesk");
    expect(unreadCompletedSessionCount("pc", { historical }, reads)).toBe(0);
    expect(deviceAttentionMotion("pc", { historical }, reads, true)).toBeNull();

    const newlyCompleted = session("new", "completed", { preview: "new" });
    expect(unreadCompletedSessionCount("pc", { historical, newlyCompleted }, reads)).toBe(1);
    expect(deviceAttentionMotion("pc", { historical, newlyCompleted }, reads, true))
      .toBe("unread-completed");
    expect(deviceAttentionMotion("pc", { historical, newlyCompleted }, reads, false)).toBeNull();
  });

  it("marks every completion read while keeping approval and locator predicates precise", () => {
    const first = session("first", "completed", { preview: "first" });
    const second = session("second", "completed", { preview: "second" });
    const approval = session("approval", "idle", { pendingPermissions: 1 });
    const question = session("question", "waiting_input", { pendingQuestions: 1 });

    expect(unreadCompletedSessionCount("pc", { first, second }, {})).toBe(2);
    const reads = readCompletedSessions("pc", { first, second }, {});
    expect(unreadCompletedSessionCount("pc", { first, second }, reads)).toBe(0);
    expect(sessionRequiresApproval(approval)).toBe(true);
    expect(sessionRequiresApproval(question)).toBe(false);
    expect(sessionHasUnreadCompletion("pc", first, reads, true)).toBe(false);
    expect(sessionNeedsLocatorMotion("pc", first, reads, true)).toBe(false);
    expect(sessionNeedsLocatorMotion("pc", second, {}, false)).toBe(false);
    expect(sessionNeedsLocatorMotion("pc", approval, reads, true)).toBe(true);
    expect(sessionNeedsLocatorMotion("pc", question, reads, true)).toBe(false);
  });

  it("only wiggles unread completions and stops after opening marks the revision read", () => {
    const completed = session("done", "completed", { preview: "new result" });

    expect(sessionNeedsLocatorMotion("pc", completed, {}, true)).toBe(true);
    const reads = readCompletedSessions("pc", { completed }, {});
    expect(sessionNeedsLocatorMotion("pc", completed, reads, true)).toBe(false);
    expect(sessionNeedsLocatorMotion("pc", completed, {}, false)).toBe(false);
  });
});
