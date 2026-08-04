import { describe, expect, it } from "vitest";
import {
  AgentEventBodySchema,
  ProtocolError,
  parseC2S,
  parseS2C,
  type AgentEventBody,
} from "../src/index.js";

describe("结构化轨协议", () => {
  it("接受 chat.send 与 permission.respond", () => {
    expect(parseC2S({ type: "chat.send", sid: "s1", text: "hi" })).toMatchObject({
      text: "hi",
    });
    expect(
      parseC2S({ type: "permission.respond", sid: "s1", reqId: "p1", reply: "always" }),
    ).toMatchObject({ reply: "always" });
    // reply 必须是三选一
    expect(() =>
      parseC2S({ type: "permission.respond", sid: "s1", reqId: "p1", reply: "yes" }),
    ).toThrowError(ProtocolError);
    // 空文本拒绝
    expect(() => parseC2S({ type: "chat.send", sid: "s1", text: "" })).toThrowError(
      ProtocolError,
    );
  });

  it("session.create 可指定 kind,省略则由 daemon 决定", () => {
    expect(
      parseC2S({ type: "session.create", agent: "opencode", kind: "structured", cols: 80, rows: 24 }),
    ).toMatchObject({ kind: "structured" });
    expect(
      parseC2S({ type: "session.create", agent: "opencode", cols: 80, rows: 24 }),
    ).not.toHaveProperty("kind");
    expect(() =>
      parseC2S({ type: "session.create", agent: "opencode", kind: "chat", cols: 80, rows: 24 }),
    ).toThrowError(ProtocolError);
  });

  it("每种 agent 事件体都能往返校验", () => {
    const bodies: AgentEventBody[] = [
      { kind: "user.message", msgId: "m1", text: "hello" },
      { kind: "text.delta", msgId: "m2", textId: "t1", delta: "PON" },
      { kind: "reasoning.delta", msgId: "m2", delta: "thinking…" },
      { kind: "tool.start", msgId: "m2", callId: "c1", tool: "bash", summary: "ls -la" },
      { kind: "tool.end", callId: "c1", state: "success", summary: "3 files" },
      {
        kind: "permission.request",
        reqId: "p1",
        action: "bash",
        resources: ["rm -rf build"],
        summary: "运行命令",
      },
      { kind: "permission.resolved", reqId: "p1", reply: "once" },
      { kind: "turn.end", msgId: "m2", finish: "stop", costUsd: 0.01, outputTokens: 12 },
      { kind: "agent.error", message: "provider auth failed" },
    ];
    for (const b of bodies) {
      expect(AgentEventBodySchema.parse(b)).toEqual(b);
      expect(parseS2C({ type: "agent.event", sid: "s1", evSeq: 1, body: b })).toMatchObject({
        body: { kind: b.kind },
      });
    }
  });

  it("chat.snapshot 承载事件历史", () => {
    const snap = parseS2C({
      type: "chat.snapshot",
      sid: "s1",
      evSeq: 3,
      events: [
        { kind: "user.message", msgId: "m1", text: "hi" },
        { kind: "text.delta", msgId: "m2", textId: "t1", delta: "yo" },
        { kind: "turn.end", msgId: "m2" },
      ],
    });
    expect(snap).toMatchObject({ type: "chat.snapshot", evSeq: 3 });
    expect((snap as { events: unknown[] }).events).toHaveLength(3);
  });

  it("拒绝未知 kind 与缺字段", () => {
    expect(() => AgentEventBodySchema.parse({ kind: "nope" })).toThrow();
    expect(() =>
      parseS2C({ type: "agent.event", sid: "s1", evSeq: 1, body: { kind: "tool.end", callId: "c" } }),
    ).toThrowError(ProtocolError);
  });

  it("SessionInfo 带 kind 与待审批计数", () => {
    const ok = parseS2C({
      type: "session.state",
      session: {
        id: "s1",
        agent: "opencode",
        kind: "structured",
        title: "opencode · repo",
        cwd: "/tmp",
        status: "waiting_approval",
        createdAt: 1,
        cols: 80,
        rows: 24,
        pendingPermissions: 1,
      },
    });
    expect(ok).toMatchObject({ session: { kind: "structured", pendingPermissions: 1 } });
  });
});
