/**
 * Grok 适配器测试。
 *
 * 事件解析用桩数据验证(不依赖登录);端到端一轮对话需要 `grok login`,
 * 未登录时自动跳过 —— 未登录环境下 grok 只会返回 auth 错误。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import { GrokAdapter } from "../src/adapters/grok.js";
import { defaultKindFor, structuredCapable } from "../src/agents.js";
import { StructuredSession } from "../src/structured-session.js";

/**
 * 只排除 "Not signed in" 是不够的:未登录时 grok 也可能什么都不输出,
 * 于是判定为"已登录"、跑下去、再超时失败。要求输出真的有内容才算可用。
 */
function grokSignedIn(): boolean {
  try {
    const out = execFileSync("grok", ["-p", "hi", "--output-format", "json"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return out.trim().length > 0 && !out.includes("Not signed in");
  } catch {
    return false;
  }
}

const cwd = mkdtempSync(path.join(os.tmpdir(), "prospero-grok-"));
let session: StructuredSession | null = null;

afterEach(async () => {
  await session?.dispose();
  session = null;
});

/** 直接驱动私有解析入口:桩数据免登录 */
function feed(adapter: GrokAdapter, lines: string[]): AgentEventBody[] {
  const events: AgentEventBody[] = [];
  const ctx = { cwd, emit: (b: AgentEventBody) => events.push(b) };
  void adapter.start(ctx);
  events.length = 0; // 丢掉启动时的自动批准提示
  const anyAdapter = adapter as unknown as { flushLine(line: string): void };
  for (const l of lines) anyAdapter.flushLine(l);
  return events;
}

describe("Grok 轨道选择", () => {
  it("有适配器但默认走 PTY(headless 无法逐条审批)", () => {
    expect(structuredCapable("grok")).toBe(true);
    expect(defaultKindFor("grok")).toBe("pty");
    // 有逐条审批能力的 agent 默认才是对话形态
    expect(defaultKindFor("claude")).toBe("structured");
    expect(defaultKindFor("codex")).toBe("structured");
    expect(defaultKindFor("opencode")).toBe("structured");
    expect(defaultKindFor("shell")).toBe("pty");
  });

  it("结构化会话开头明确告知自动批准", async () => {
    const events: AgentEventBody[] = [];
    const adapter = new GrokAdapter();
    await adapter.start({ cwd, emit: (b) => events.push(b) });
    expect(events[0]).toMatchObject({ kind: "agent.error" });
    expect((events[0] as { message: string }).message).toContain("自动批准");
  });
});

describe("Grok 事件解析", () => {
  it("ACP 风格 session/update 文本增量", () => {
    const events = feed(new GrokAdapter(), [
      JSON.stringify({
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PO" } },
      }),
      JSON.stringify({
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NG" } },
      }),
    ]);
    expect(events.map((e) => (e.kind === "text.delta" ? e.delta : ""))).toEqual(["PO", "NG"]);
  });

  // 下面这几条是从已登录的 grok 真实抓包来的,不再是猜的形状
  it("真实 streaming-json:文本增量在 data 字段", () => {
    const events = feed(new GrokAdapter(), [
      JSON.stringify({ type: "text", data: "P" }),
      JSON.stringify({ type: "text", data: "ONG" }),
    ]);
    expect(events.map((e) => (e.kind === "text.delta" ? e.delta : ""))).toEqual(["P", "ONG"]);
  });

  it("真实 streaming-json:thought 是推理增量", () => {
    const events = feed(new GrokAdapter(), [
      JSON.stringify({ type: "thought", data: "思考中" }),
    ]);
    expect(events[0]).toMatchObject({ kind: "reasoning.delta", delta: "思考中" });
  });

  it("旧猜测的 text 字段仍兼容(万一版本间有差异)", () => {
    const events = feed(new GrokAdapter(), [JSON.stringify({ type: "text", text: "hello" })]);
    expect(events[0]).toMatchObject({ kind: "text.delta", delta: "hello" });
  });

  it("工具调用与结果", () => {
    const events = feed(new GrokAdapter(), [
      JSON.stringify({
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "bash",
          rawInput: { command: "ls" },
        },
      }),
      JSON.stringify({
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c1",
          status: "completed",
          content: "a.txt",
        },
      }),
    ]);
    expect(events[0]).toMatchObject({ kind: "tool.start", tool: "bash", callId: "c1" });
    expect(events[1]).toMatchObject({ kind: "tool.end", state: "success", callId: "c1" });
  });

  it("进行中的工具更新不提前收尾", () => {
    const events = feed(new GrokAdapter(), [
      JSON.stringify({
        update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "in_progress" },
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("错误事件被转成 agent.error", () => {
    const events = feed(new GrokAdapter(), [
      JSON.stringify({ type: "error", message: "Not signed in." }),
    ]);
    expect(events[0]).toMatchObject({ kind: "agent.error" });
    expect((events[0] as { message: string }).message).toContain("Not signed in");
  });

  it("非 JSON 行按纯文本处理(plain 输出兜底)", () => {
    const events = feed(new GrokAdapter(), ["just some text"]);
    expect(events[0]).toMatchObject({ kind: "text.delta", delta: "just some text" });
  });

  it("未知事件被忽略,不产生噪声", () => {
    const events = feed(new GrokAdapter(), [
      JSON.stringify({ update: { sessionUpdate: "some_future_event", x: 1 } }),
      JSON.stringify({ type: "result" }),
    ]);
    expect(events).toEqual([]);
  });
});

const describeIfSignedIn = grokSignedIn() ? describe : describe.skip;

describeIfSignedIn("Grok 端到端(需 grok login)", () => {
  it("一轮对话产生文本与 turn.end", async () => {
    const events: AgentEventBody[] = [];
    session = new StructuredSession({
      id: `grok-${String(Date.now())}`,
      agent: "grok",
      title: "grok · test",
      cwd,
      adapter: new GrokAdapter(),
    });
    session.on("event", (b) => events.push(b));
    await session.start();
    await session.send("Reply with exactly the word PONG and nothing else.");

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !events.some((e) => e.kind === "turn.end")) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(events.some((e) => e.kind === "turn.end")).toBe(true);
    const text = events
      .filter((e): e is Extract<AgentEventBody, { kind: "text.delta" }> => e.kind === "text.delta")
      .map((e) => e.delta)
      .join("");
    expect(text.toUpperCase()).toContain("PONG");
  }, 180_000);
});
