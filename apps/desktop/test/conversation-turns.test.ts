import { describe, expect, it } from "vitest";
import { ChatEventAccumulator } from "../src/renderer/src/chat-events";
import { conversationTurns } from "../src/renderer/src/chat/conversation-turns";
import { resultFiles } from "../src/renderer/src/chat/result-files";
import { array, record } from "../src/renderer/src/state";

describe("per-turn conversation", () => {
  it("keeps steering in the current turn and separates completed outcomes from process", () => {
    const accumulator = new ChatEventAccumulator();
    const running = accumulator.reset([
      { kind: "user.message", text: "first" },
      { kind: "text.delta", msgId: "progress", delta: "reading", phase: "commentary" },
      { kind: "reasoning.delta", msgId: "r", delta: "checking" },
      { kind: "user.message", text: "also check tests" },
      { kind: "text.delta", msgId: "answer", delta: "## Done", phase: "final_answer" },
    ]);
    const before = conversationTurns(running.items, running.resolutions);
    expect(before).toHaveLength(1);
    expect(array(before[0]!.event.users)).toHaveLength(2);
    expect(before[0]!.event.completed).toBe(false);
    const done = accumulator.append([{ kind: "turn.end", msgId: "answer" }, { kind: "user.message", text: "next" }])!;
    const turns = conversationTurns(done.items, done.resolutions);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.key).toBe(before[0]!.key);
    expect(turns[0]!.ordinal).toBeLessThan(turns[1]!.ordinal);
    expect(turns[0]!.event.completed).toBe(true);
    expect(turns[0]!.event.finalText).toBe("## Done");
    expect(array(turns[0]!.event.activity).map(record).map(event => event.kind)).toEqual(["assistant.text", "reasoning"]);
  });

  it("keeps pending requests and failures visible, folding resolved requests", () => {
    const snapshot = new ChatEventAccumulator().reset([
      { kind: "permission.request", reqId: "resolved" },
      { kind: "permission.resolved", reqId: "resolved" },
      { kind: "permission.request", reqId: "pending" },
      { kind: "question.request", reqId: "q" },
      { kind: "tool.end", callId: "bad", state: "error" },
      { kind: "agent.error", message: "failure" },
      { kind: "turn.end", finish: "failed" },
    ]);
    const event = conversationTurns(snapshot.items, snapshot.resolutions)[0]!.event;
    expect(array(event.activity).map(record).map(item => item.reqId)).toEqual(["resolved"]);
    expect(array(event.outcomes).map(record).map(item => item.kind)).toEqual(["permission.request", "question.request", "tool.end", "agent.error"]);
    expect(event.finish).toBe("failed");
    expect(event.finalText).toBe("");
  });

  it("uses authoritative turn diffs and never counts permission previews or failed writes", () => {
    const patch = { path: "a.ts", additions: 1, deletions: 0, patch: "+ok" };
    const accumulator = new ChatEventAccumulator();
    const snapshot = accumulator.reset([
      { kind: "permission.request", reqId: "p", diff: { ...patch, path: "proposal.ts" } },
      { kind: "tool.end", callId: "bad", state: "failed", diff: { ...patch, path: "failed.ts" } },
      { kind: "tool.end", callId: "good", state: "success", diff: patch },
    ]);
    expect(conversationTurns(snapshot.items, snapshot.resolutions)[0]!.event.diffs).toEqual([patch]);
    const done = accumulator.append([{ kind: "turn.end", diffs: [] }])!;
    expect(conversationTurns(done.items, done.resolutions)[0]!.event.diffs).toEqual([]);
  });

  it("supports older streams without phases and stopped turns without final text", () => {
    const snapshot = new ChatEventAccumulator().reset([
      { kind: "text.delta", msgId: "a", delta: "progress" },
      { kind: "text.delta", msgId: "b", delta: "answer" },
      { kind: "turn.end", msgId: "b" },
      { kind: "text.delta", msgId: "c", delta: "working", phase: "commentary" },
      { kind: "turn.end", finish: "interrupted" },
    ]);
    const turns = conversationTurns(snapshot.items, snapshot.resolutions);
    expect(turns[0]!.event.finalText).toBe("answer");
    expect(turns[1]!.event.finalText).toBe("");
    expect(turns[1]!.event.finish).toBe("interrupted");
  });
});

describe("result file references", () => {
  it("recognizes Windows paths, images, reference links and line numbers with deduplication", () => {
    expect(resultFiles('[Report](<D:/work/demo/report final.md>)\n\n[Source](src/app.ts:12)\n\n![image](output/chart.png)\n\n[again][report]\n\n[report]: <D:/work/demo/report final.md>', 'D:\\work\\demo'))
      .toEqual([{ path: "report final.md" }, { path: "src/app.ts", line: 12 }, { path: "output/chart.png" }]);
  });
  it("ignores code examples, remote links, unsafe schemes and paths outside the project", () => {
    expect(resultFiles('```md\n[example](fake.md)\n```\n\n[web](https://example.com) [outside](../private.txt) [drive](D:/elsewhere/file.md) [script](javascript:alert) [encoded](%2e%2e/private.txt)', 'D:/work/demo')).toEqual([]);
  });
});
