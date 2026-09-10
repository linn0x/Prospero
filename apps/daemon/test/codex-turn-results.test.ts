import { describe, expect, it } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import { CodexAdapter } from "../src/adapters/codex.js";
import { codexFileChanges, codexTurnDiffs } from "../src/adapters/codex-turn-diff.js";
import { compactAgentSnapshotEvents } from "../src/structured-session.js";

function harness() {
  const adapter = new CodexAdapter();
  const events: AgentEventBody[] = [];
  const internal = adapter as unknown as {
    ctx: { emit: (event: AgentEventBody) => void };
    threadId: string;
    onNotification(message: { method: string; params: Record<string, unknown> }): void;
  };
  internal.ctx = { emit: (event) => events.push(event) };
  internal.threadId = "main";
  return { events, send: (method: string, params: Record<string, unknown>) => internal.onNotification({ method, params: { threadId: "main", ...params } }) };
}
const patch = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n'
  + 'diff --git "a/old file.txt" "b/old file.txt"\n--- "a/old file.txt"\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n';

describe("Codex native turn results", () => {
  it("preserves all changed paths including spaces and deleted files", () => {
    expect(codexTurnDiffs(patch)).toMatchObject([
      { path: "a.txt", additions: 1, deletions: 1 }, { path: "old file.txt", additions: 0, deletions: 1 },
    ]);
    expect(codexFileChanges({ changes: [{ path: "a", diff: "+a" }, { path: "b", diff: "-b" }] })).toHaveLength(2);
  });
  it("uses authoritative final text and phase, without repeating unchanged streamed text", () => {
    const h = harness();
    h.send("turn/started", { turn: { id: "t1" } });
    h.send("item/agentMessage/delta", { itemId: "answer", delta: "Final answer" });
    h.send("item/completed", { item: { id: "answer", type: "agentMessage", text: "Final answer", phase: "final_answer" } });
    h.send("item/completed", { item: { id: "progress", type: "agentMessage", text: "Follow-up progress", phase: "commentary" } });
    h.send("turn/completed", { turn: { id: "t1", status: "completed" } });
    expect(h.events[1]).toMatchObject({ kind: "text.delta", delta: "", phase: "final_answer" });
    expect(h.events.at(-1)).toMatchObject({ kind: "turn.end", msgId: "answer", turnId: "t1" });
    h.send("turn/started", { turn: { id: "t2" } });
    h.send("turn/completed", { turn: { id: "t2", status: "interrupted" } });
    expect(h.events.at(-1)).toMatchObject({ msgId: "t2", turnId: "t2", finish: "interrupted" });
  });
  it("replaces a corrected plan and preserves its replacement through snapshot compaction", () => {
    const h = harness();
    h.send("turn/started", { turn: { id: "t" } });
    h.send("item/plan/delta", { itemId: "plan", delta: "draft" });
    h.send("item/completed", { item: { id: "plan", type: "plan", text: "corrected plan" } });
    const compact = compactAgentSnapshotEvents(h.events);
    expect(compact).toEqual([expect.objectContaining({ kind: "text.delta", delta: "corrected plan", replace: true, phase: "final_answer" })]);
  });
  it("uses the last aggregate diff snapshot, then clears it before the next turn", () => {
    const h = harness();
    h.send("turn/started", { turn: { id: "t1" } });
    h.send("item/started", { item: { id: "edit", type: "fileChange" } });
    h.send("item/completed", { item: { id: "edit", type: "fileChange", status: "completed", changes: [{ path: "intermediate.txt", diff: "+x" }] } });
    h.send("turn/diff/updated", { turnId: "t1", diff: patch });
    h.send("turn/completed", { turn: { id: "t1", status: "completed" } });
    expect(h.events.at(-1)).toMatchObject({ diffs: [{ path: "a.txt" }, { path: "old file.txt" }] });
    h.send("turn/started", { turn: { id: "t2" } });
    h.send("turn/diff/updated", { turnId: "t2", diff: "" });
    h.send("turn/completed", { turn: { id: "t2", status: "completed" } });
    expect(h.events.at(-1)).toMatchObject({ diffs: [] });
  });
  it("uses every successful fileChange when the provider does not send an aggregate", () => {
    const h = harness();
    h.send("turn/started", { turn: { id: "t" } });
    h.send("item/started", { item: { id: "edit", type: "fileChange" } });
    h.send("item/completed", { item: { id: "edit", type: "fileChange", status: "completed", changes: [{ path: "a", diff: "+a" }, { path: "b", diff: "+b" }] } });
    h.send("turn/completed", { turn: { id: "t", status: "completed" } });
    expect(h.events.at(-1)).toMatchObject({ diffs: [{ path: "a" }, { path: "b" }] });
  });
});
