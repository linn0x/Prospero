import { describe, expect, it } from "vitest";
import type { DesktopSnapshot, SessionInfo } from "../src/shared/types";
import { attentionSummary, pendingRequests } from "../src/renderer/src/attention/attention-state";
import { sessionTabLabels, sessionTabName } from "../src/renderer/src/workspace/session-tab-labels";
const session = (patch: Partial<SessionInfo> = {}): SessionInfo => ({ id: "a", agent: "claude", title: "claude · project", cwd: "/work/project", status: "idle", ...patch });
const snapshot = (sessions: SessionInfo[]): DesktopSnapshot => ({ daemon: { running: true, sessions }, orchestration: { runs: [{ id: "r", status: "active", objective: "Full objective", cwd: "/work/project" }, { id: "closed", status: "completed" }], tasks: [{ id: "t", runId: "r", title: "Full task title", status: "failed" }, { id: "old", runId: "closed", status: "failed" }], gates: [{ id: "g", taskId: "t", runId: "r", status: "pending", question: "Full question" }], worktreeAssets: [] }, projectAliases: { "/work/project": "Alias" } } as unknown as DesktopSnapshot);
describe("attention summary", () => {
  it("counts every request even when one session needs both approval and a reply", () => {
    const result = attentionSummary(snapshot([session({pendingPermissions: 2, pendingQuestions: 3}),session({id: "ended", status: "exited", pendingPermissions: 8})]));
    expect(result.counts).toEqual({approvals: 3, questions: 3, issues: 1});
    expect(result.total).toBe(7);
    expect(result.approvalSessions.map(s => s.id)).toEqual(["a"]);
    expect(result.questionSessions.map(s => s.id)).toEqual(["a"]);
    expect(result.context(result.gates[0]!)).toEqual({title: "Full task title", project: "Alias"});
    expect(result.gates[0]!.question).toBe("Full question");
  });
  it("infers pending work from waiting state and normalizes malformed counts", () => {
    expect(pendingRequests(session({status: "waiting_input", pendingQuestions: NaN}), "questions")).toBe(1);
    expect(pendingRequests(session({pendingPermissions: -2}), "approvals")).toBe(0);
    expect(pendingRequests(session({pendingQuestions: 2.7}), "questions")).toBe(2);
  });
});
describe("session tab names", () => {
  it("removes generated agent prefixes but preserves user titles", () => {
    expect(sessionTabName(session())).toBe("project");
    expect(sessionTabName(session({title: "Claude"}))).toBe("project");
    expect(sessionTabName(session({displayTitle: "Claude · my custom title"}))).toBe("Claude · my custom title");
    expect(sessionTabName(session({title: "Claude performance investigation"}))).toBe("Claude performance investigation");
  });
  it("keeps same-name sessions distinguishable across tab reorder", () => {
    const a = session(), b = session({id: "b"});
    expect(sessionTabLabels([a,b])).toEqual(sessionTabLabels([b,a]));
    expect([...sessionTabLabels([a,b]).values()]).toEqual(["project · 1", "project · 2"]);
  });
});
