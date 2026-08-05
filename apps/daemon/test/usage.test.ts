import os from "node:os";
import { describe, expect, it } from "vitest";
import type { AgentEventBody, PermissionReply } from "@prospero/protocol";
import { StructuredSession } from "../src/structured-session.js";
import type { AdapterContext, AgentAdapter, UsageReport } from "../src/adapters/types.js";

function makeAdapter(usage?: () => Promise<UsageReport | null>): AgentAdapter {
  return {
    start: async (_c: AdapterContext) => {},
    send: async (_t: string) => {},
    respondPermission: async (_r: string, _p: PermissionReply) => {},
    interrupt: async () => {},
    dispose: async () => {},
    ...(usage ? { usage } : {}),
  };
}

async function session(adapter: AgentAdapter): Promise<StructuredSession> {
  const s = new StructuredSession({
    id: "u",
    agent: "claude",
    title: "u",
    cwd: os.tmpdir(),
    adapter,
  });
  s.on("event", (_b: AgentEventBody) => {});
  await s.start();
  return s;
}

describe("用量与限流", () => {
  it("没有任何用量时返回 null(会话还没跑过)", async () => {
    const s = await session(makeAdapter());
    expect(await s.usage()).toBeNull();
  });

  it("适配器不实现 usage,但会话有 token 累计时仍要报出来", async () => {
    // codex / opencode / grok 都不暴露套餐限流,却都在 turn.end 上报 token。
    // 曾经因为"没有窗口"就整个判为不可用,用量明明有却看不到。
    const s = await session(makeAdapter());
    s["record"]({
      kind: "turn.end",
      msgId: "m1",
      costUsd: 0.02,
      inputTokens: 1200,
      outputTokens: 340,
    });
    const r = await s.usage();
    expect(r).not.toBeNull();
    expect(r?.costUsd).toBeCloseTo(0.02);
    expect(r?.inputTokens).toBe(1200);
    expect(r?.windows).toEqual([]);
  });

  it("适配器抛错时也返回 null —— 用量取不到不该影响会话", async () => {
    // SDK 上那个方法叫 ..._DO_NOT_RELY_ON_THIS_API_YET,随时可能改名或消失,
    // 所以它坏掉必须是"没有数据",而不是把会话一起拖下水
    const s = await session(makeAdapter(() => Promise.reject(new Error("后端换实现了"))));
    expect(await s.usage()).toBeNull();
  });

  it("正常返回时原样透出", async () => {
    const s = await session(
      makeAdapter(() =>
        Promise.resolve({
          subscription: "max",
          costUsd: 1.25,
          windows: [{ label: "5 小时", utilization: 93, resetsAt: "2026-08-05T09:00:00Z" }],
        }),
      ),
    );
    const r = await s.usage();
    expect(r?.subscription).toBe("max");
    expect(r?.costUsd).toBe(1.25);
    expect(r?.windows[0]).toMatchObject({ label: "5 小时", utilization: 93 });
  });

  it("没有套餐限流时窗口为空,但仍算取到了数据", async () => {
    // API key / Bedrock / Vertex 的会话就是这样 —— 有花费,没有窗口
    const s = await session(
      makeAdapter(() => Promise.resolve({ subscription: null, costUsd: 0.4, windows: [] })),
    );
    const r = await s.usage();
    expect(r).not.toBeNull();
    expect(r?.windows).toEqual([]);
    expect(r?.subscription).toBeNull();
  });
});
