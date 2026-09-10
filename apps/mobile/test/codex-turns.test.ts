import { describe, expect, it } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import { applyEvents, foldCodexTurns, itemsForAgent, type ChatDisplayItem } from "../src/lib/chat-model";

const reply = (id: string, delta: string, phase?: "commentary" | "final_answer"): AgentEventBody =>
  ({ kind: "text.delta", msgId: id, textId: id, delta, ...(phase ? { phase } : {}) });
const round = (n: number): AgentEventBody[] => [
  { kind: "user.message", msgId: `u${n}`, text: `question ${n}` },
  reply(`p${n}`, "progress", "commentary"),
  { kind: "reasoning.delta", msgId: `r${n}`, delta: "reasoning summary" },
  { kind: "tool.start", msgId: `t${n}`, callId: `c${n}`, tool: "edit", summary: "editing" },
  { kind: "tool.end", callId: `c${n}`, state: "success", summary: "edited" },
  reply(`f${n}`, `answer ${n}`, "final_answer"),
  { kind: "turn.end", msgId: `f${n}`, turnId: `t${n}`, finish: "completed", diffs: [
    { path: `out${n}.txt`, patch: "+result", additions: 1, deletions: 0 },
  ] },
];
const keys = (items: ChatDisplayItem[]) => items.map((item) => item.key);

describe("Codex per-turn disclosure", () => {
  it("shows final answers and complete diffs, while independently revealing one turn's activity", () => {
    const items = applyEvents([], [...round(1), ...round(2)]);
    const collapsed = foldCodexTurns(items);
    expect(keys(collapsed)).toEqual(["u:u1", "turn:u:u1", "a:f1", "d:f1", "u:u2", "turn:u:u2", "a:f2", "d:f2"]);
    const capsule = collapsed.find((item) => item.type === "turn-activity")!;
    if (capsule.type !== "turn-activity") throw new Error("missing capsule");
    const expanded = foldCodexTurns(items, { [capsule.stateKey]: true });
    expect(keys(expanded)).toContain("a:p1");
    expect(keys(expanded)).toContain("a:r1");
    expect(keys(expanded)).toContain("t:c1");
    expect(keys(expanded)).not.toContain("a:p2");
    expect(keys(expanded).filter((key) => key === "a:f1")).toHaveLength(1);
    expect(collapsed.find((item) => item.type === "turn-diff-summary")).toMatchObject({ files: [{ diff: { patch: "+result" } }] });
  });

  it("automatically collapses when a running turn completes and retains steering messages in that turn", () => {
    const events = round(1);
    events.splice(3, 0, { kind: "user.message", msgId: "steer", text: "also check this" });
    const running = foldCodexTurns(applyEvents([], events.slice(0, -1)));
    const pill = running.find((item) => item.type === "turn-activity")!;
    expect(pill).toMatchObject({ completed: false, expanded: true });
    if (pill.type !== "turn-activity") throw new Error("missing capsule");
    const done = foldCodexTurns(applyEvents([], events), { [pill.stateKey]: true });
    expect(done.find((item) => item.type === "turn-activity")).toMatchObject({ key: pill.key, expanded: false, completed: true });
    expect(keys(done)).toContain("u:steer");
    expect(done.filter((item) => item.type === "turn-activity")).toHaveLength(1);
  });

  it("keeps unresolved approvals, questions, failures, and interrupted outcomes visible", () => {
    const events: AgentEventBody[] = [
      { kind: "user.message", msgId: "u", text: "work" }, reply("p", "progress", "commentary"),
      { kind: "permission.request", reqId: "p", action: "run", resources: [], summary: "approve" },
      { kind: "question.request", reqId: "q", questions: [{ id: "q", header: "Question", question: "which?", options: [], multiSelect: false, allowOther: true }] },
      { kind: "tool.end", callId: "failed", state: "failed", summary: "command failed" },
      { kind: "turn.end", msgId: "p", turnId: "t", finish: "interrupted" },
      ...round(2),
    ];
    const view = foldCodexTurns(applyEvents([], events));
    expect(keys(view)).toEqual(expect.arrayContaining(["p:p", "q:q", "t:failed", "end:t:status", "a:f2"]));
    expect(view.find((item) => item.key === "end:t:status")).toMatchObject({ finish: { reason: "interrupted" } });
    expect(view.filter((item) => item.type === "turn-activity")).toHaveLength(2);
  });

  it("separates child agent history and supports older Codex events without phases", () => {
    const old: AgentEventBody[] = [
      { kind: "user.message", msgId: "u", text: "work" }, reply("p", "progress"), reply("f", "legacy final"),
      { kind: "turn.end", msgId: "f" },
    ];
    const events = [...old, ...round(2).map((event) => ({ ...event, agentId: "child" }))];
    const items = applyEvents([], events);
    expect(keys(foldCodexTurns(itemsForAgent(items)))).toEqual(["u:u", "turn:u:u", "a:f"]);
    expect(keys(foldCodexTurns(itemsForAgent(items, "child")))).toContain("a:child:f2");
  });

  it("replaces corrected text without duplication and prefers explicit final messages", () => {
    const events = round(1);
    events.splice(-1, 0, { ...reply("f1", "corrected final", "final_answer"), replace: true } as AgentEventBody,
      reply("post", "postscript progress", "commentary"));
    const view = foldCodexTurns(applyEvents([], events));
    expect(view.find((item) => item.key === "a:f1")).toMatchObject({ text: "corrected final", phase: "final_answer" });
    expect(keys(view)).not.toContain("a:post");
  });

  it("does not count denied changes and replaces intermediate diffs with the native aggregate", () => {
    const events: AgentEventBody[] = [
      { kind: "tool.start", msgId: "t", callId: "c", tool: "edit", summary: "edit", diff: { path: "denied.txt", patch: "+x", additions: 1, deletions: 0 } },
      { kind: "tool.end", callId: "c", state: "failed", summary: "declined" },
      { kind: "turn.end", msgId: "t", turnId: "t", diffs: [] },
    ];
    expect(applyEvents([], events).some((item) => item.type === "turn-diff-summary")).toBe(false);
    const all = applyEvents([], round(1));
    expect(applyEvents(all, [round(1).at(-1)!]).filter((item) => item.type === "turn-end")).toHaveLength(1);
  });
});
