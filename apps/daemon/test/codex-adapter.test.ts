/**
 * Codex app-server 适配器集成测试。未安装 codex 时跳过。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import { CodexAdapter } from "../src/adapters/codex.js";
import { StructuredSession } from "../src/structured-session.js";

function hasCodex(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const describeIf = hasCodex() ? describe : describe.skip;
const cwd = mkdtempSync(path.join(os.tmpdir(), "prospero-codex-"));
let session: StructuredSession | null = null;

afterEach(async () => {
  await session?.dispose();
  session = null;
});

async function startSession(events: AgentEventBody[]): Promise<StructuredSession> {
  const s = new StructuredSession({
    id: `codex-test-${String(Date.now())}`,
    agent: "codex",
    title: "codex · test",
    cwd,
    adapter: new CodexAdapter(),
  });
  s.on("event", (body) => events.push(body));
  await s.start();
  return s;
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`超时等待:${what}`);
}

describeIf("Codex 结构化会话", () => {
  it("发消息 → 文本增量 → turn.end 且 msgId 与文本一致", async () => {
    const events: AgentEventBody[] = [];
    session = await startSession(events);
    await session.send("Reply with exactly the word PONG and nothing else.");

    await waitFor(
      () => events.some((e) => e.kind === "turn.end"),
      `turn.end;errors=${JSON.stringify(events.filter((e) => e.kind === "agent.error"))}`,
    );

    const deltas = events.filter(
      (e): e is Extract<AgentEventBody, { kind: "text.delta" }> => e.kind === "text.delta",
    );
    expect(deltas.map((d) => d.delta).join("").toUpperCase()).toContain("PONG");

    // turn.end 必须挂到真实的文本消息上,否则客户端的用量会落到幽灵条目
    const turn = events.find(
      (e): e is Extract<AgentEventBody, { kind: "turn.end" }> => e.kind === "turn.end",
    )!;
    expect(turn.msgId).toBe(deltas[0]!.msgId);
  }, 180_000);

  it("会话可创建并正确上报为结构化", async () => {
    const events: AgentEventBody[] = [];
    session = await startSession(events);
    const info = session.info();
    expect(info.kind).toBe("structured");
    expect(info.agent).toBe("codex");
    expect(info.status).toBe("idle");
  }, 120_000);
});

/**
 * 用官方 schema(codex app-server generate-ts)里的真实形状喂事件,不依赖 codex 是否安装。
 *
 * 之前用量按 `turn/completed` 的 `params.usage` 读 —— 而那条通知的形状是
 * { threadId, turn },根本没有 usage 字段。结果 codex 的 token 永远是 0,
 * 界面上表现为"没有用量"。这类"猜字段名"的错误此前在 Grok 适配器上也发生过一次。
 */
describe("Codex 用量与限流(桩数据)", () => {
  function feed(lines: object[]): CodexAdapter {
    const a = new CodexAdapter();
    const anyA = a as unknown as { onNotification(m: Record<string, unknown>): void };
    for (const l of lines) anyA.onNotification(l as Record<string, unknown>);
    return a;
  }

  it("从 thread/tokenUsage/updated 读 token,而不是 turn/completed", async () => {
    const a = feed([
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "t1",
          turnId: "u1",
          tokenUsage: {
            last: { inputTokens: 100, outputTokens: 20 },
            total: { inputTokens: 14892, outputTokens: 6 },
            modelContextWindow: 272000,
          },
        },
      },
    ]);
    const r = await a.usage();
    expect(r?.inputTokens).toBe(14892);
    expect(r?.outputTokens).toBe(6);
  });

  it("account/rateLimits/updated 转成窗口,时长说成人话", async () => {
    const a = feed([
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 42.5, windowDurationMins: 300, resetsAt: 1785900000 },
            secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: null },
          },
        },
      },
    ]);
    const r = await a.usage();
    expect(r?.subscription).toBe("plus");
    expect(r?.windows.map((w) => w.label)).toEqual(["5 小时", "7 天"]);
    expect(r?.windows[0]?.utilization).toBeCloseTo(42.5);
    // resetsAt 是秒级时间戳,要转成 ISO
    expect(r?.windows[0]?.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r?.windows[1]?.resetsAt).toBeUndefined();
  });

  it("什么都没收到时返回 null,而不是编一个空报告", async () => {
    expect(await feed([]).usage()).toBeNull();
  });
});
