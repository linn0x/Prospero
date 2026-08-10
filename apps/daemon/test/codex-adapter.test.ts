/**
 * Codex app-server 适配器集成测试。未安装 codex 时跳过。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventBody, ApprovalPolicy } from "@prospero/protocol";
import { CodexAdapter } from "../src/adapters/codex.js";
import { StructuredSession } from "../src/structured-session.js";
import { SessionManager } from "../src/session-manager.js";

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
  it("协商实验能力后带模型/协作模式发消息 → turn.end", async () => {
    const events: AgentEventBody[] = [];
    session = await startSession(events);
    // 读取模型会让后续 turn/start 带 collaborationMode；未在 initialize 声明
    // experimentalApi 时，Codex 正是在这一刻拒绝手机发出的第一条消息。
    expect((await session.models()).models.length).toBeGreaterThan(0);
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

  it("daemon 重启后用持久化 threadId 恢复原生 Codex 会话", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "prospero-codex-resume-"));
    const first = new SessionManager({ home });
    const firstEvents: AgentEventBody[] = [];
    first.on("agentEvent", (_sid, body) => firstEvents.push(body));
    let second: SessionManager | null = null;
    try {
      const created = await first.create({
        agent: "codex",
        kind: "structured",
        cwd,
        cols: 80,
        rows: 24,
        allowShell: false,
      });
      await first.chatSend(created.id, "Reply with exactly the word PERSISTED and nothing else.");
      await waitFor(
        () => firstEvents.some((event) => event.kind === "turn.end"),
        "持久化测试首轮 turn.end",
      );
      first.flushPersistence();
      await first.disposeAll();

      second = new SessionManager({ home });
      const restored = await second.restoreStructured();
      expect(restored).toHaveLength(1);
      expect(restored[0]?.id).toBe(created.id);
      expect(
        restored[0]?.status,
        JSON.stringify(second.requireStructured(created.id).snapshot().events),
      ).toBe("completed");
      await second.kill(created.id);
    } finally {
      await first.disposeAll();
      await second?.disposeAll();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});

/** 不启动真实 Codex,直接把 app-server 请求喂给适配器。 */
function approvalHarness(policy: () => ApprovalPolicy): {
  adapter: CodexAdapter;
  events: AgentEventBody[];
  writes: Record<string, unknown>[];
  request(message: { id: number; method: string; params: Record<string, unknown> }): void;
} {
  const adapter = new CodexAdapter();
  const events: AgentEventBody[] = [];
  const writes: Record<string, unknown>[] = [];
  const internals = adapter as unknown as {
    ctx: {
      cwd: string;
      approvalPolicy: () => ApprovalPolicy;
      emit: (body: AgentEventBody) => void;
    };
    write: (message: Record<string, unknown>) => void;
    onServerRequest: (message: {
      id: number;
      method: string;
      params: Record<string, unknown>;
    }) => void;
  };
  internals.ctx = { cwd, approvalPolicy: policy, emit: (body) => events.push(body) };
  internals.write = (message) => writes.push(message);
  return { adapter, events, writes, request: (message) => internals.onServerRequest(message) };
}

describe("Codex 审批策略(桩数据)", () => {
  it("YOLO 自动批准命令,同时保留审计事件", () => {
    const h = approvalHarness(() => "yolo");
    h.request({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: { itemId: "cmd-1", command: "npm test" },
    });

    expect(h.events).toEqual([
      expect.objectContaining({
        kind: "permission.auto",
        reqId: "cmd-1",
        policy: "yolo",
        summary: "运行命令:npm test",
      }),
    ]);
    expect(h.writes).toEqual([{ id: 41, result: { decision: "approved" } }]);
  });

  it("YOLO 的 turn/start 同时关闭审批并解除 sandbox", async () => {
    let policy: ApprovalPolicy = "yolo";
    const h = approvalHarness(() => policy);
    (h.adapter as unknown as { threadId: string }).threadId = "thread-yolo";

    await h.adapter.send("检查 Docker");
    expect(h.writes[0]).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-yolo",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    });

    policy = "strict";
    await h.adapter.send("安全轮次");
    expect(h.writes[1]).toMatchObject({
      method: "turn/start",
      params: {
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd] },
      },
    });
  });

  it("把 daemon 已解析的 Skill 作为 app-server 原生 input 发送", async () => {
    const h = approvalHarness(() => "standard");
    (h.adapter as unknown as { threadId: string }).threadId = "thread-skill";

    await h.adapter.send("请按 $review-flow 执行", undefined, [
      {
        name: "review-flow",
        description: "review",
        path: "/tmp/review-flow/SKILL.md",
        contents: "skill body",
      },
    ]);
    expect(h.writes[0]).toMatchObject({
      method: "turn/start",
      params: {
        input: [
          { type: "text", text: "请按 $review-flow 执行" },
          { type: "skill", name: "review-flow", path: "/tmp/review-flow/SKILL.md" },
        ],
      },
    });
  });

  it("strict 与 standard 对改文件请求仍等待人工批准", () => {
    for (const policy of ["strict", "standard"] as const) {
      const h = approvalHarness(() => policy);
      h.request({
        id: 42,
        method: "item/fileChange/requestApproval",
        params: { itemId: `file-${policy}`, reason: "src/app.ts" },
      });

      expect(h.events).toEqual([
        expect.objectContaining({
          kind: "permission.request",
          reqId: `file-${policy}`,
        }),
      ]);
      expect(h.writes).toEqual([]);
    }
  });
});

describe("Codex 原生 Plan、提问与子 Agent(桩数据)", () => {
  it("把 requestUserInput 转成问题卡，并把答案回到原 JSON-RPC", async () => {
    const h = approvalHarness(() => "standard");
    (h.adapter as unknown as { threadId: string }).threadId = "main-thread";
    h.request({
      id: 71,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "child-thread",
        turnId: "turn-1",
        itemId: "question-1",
        autoResolutionMs: null,
        questions: [{
          id: "scope",
          header: "范围",
          question: "先做哪一端？",
          isOther: true,
          isSecret: false,
          options: [{ label: "iOS", description: "先完成手机端" }],
        }],
      },
    });
    expect(h.events[0]).toMatchObject({
      kind: "question.request",
      reqId: "question-1",
      agentId: "child-thread",
      questions: [{ id: "scope", allowOther: true }],
    });
    await h.adapter.respondQuestion?.("question-1", [
      { questionId: "scope", values: ["iOS"] },
    ]);
    expect(h.writes).toContainEqual({
      id: 71,
      result: { answers: { scope: { answers: ["iOS"] } } },
    });
    expect(h.events.at(-1)).toMatchObject({
      kind: "question.resolved",
      agentId: "child-thread",
    });
  });

  it("Plan 模式用 collaborationMode 原生设置并持久化", async () => {
    const h = approvalHarness(() => "standard");
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const internals = h.adapter as unknown as {
      threadId: string;
      selectedModel: string;
      selectedEffort: string;
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    internals.threadId = "main-thread";
    internals.selectedModel = "gpt-test";
    internals.selectedEffort = "high";
    internals.request = async (method, params) => {
      calls.push({ method, params });
      return {};
    };
    expect(await h.adapter.setMode?.("plan")).toEqual({ currentMode: "plan" });
    expect(calls[0]).toMatchObject({
      method: "thread/settings/update",
      params: {
        collaborationMode: {
          mode: "plan",
          settings: { model: "gpt-test", reasoning_effort: "high" },
        },
      },
    });
  });

  it("子 thread 的输出独立带 agentId，空闲时可由人开启新一轮", async () => {
    const h = approvalHarness(() => "standard");
    const internals = h.adapter as unknown as {
      threadId: string;
      onNotification(message: Record<string, unknown>): void;
    };
    internals.threadId = "main-thread";
    internals.onNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          parentThreadId: "main-thread",
          agentNickname: "reviewer",
          status: { type: "active", activeFlags: [] },
          canAcceptDirectInput: true,
          createdAt: 1,
        },
      },
    });
    internals.onNotification({
      method: "turn/started",
      params: { threadId: "child-thread", turn: { id: "child-turn" } },
    });
    internals.onNotification({
      method: "item/agentMessage/delta",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        itemId: "child-message",
        delta: "检查完成",
      },
    });
    internals.onNotification({
      method: "turn/completed",
      params: { threadId: "child-thread", turn: { id: "child-turn", status: "completed" } },
    });
    expect(h.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "subagent.started",
          subagent: expect.objectContaining({ id: "child-thread" }),
        }),
        expect.objectContaining({ kind: "text.delta", agentId: "child-thread", delta: "检查完成" }),
        expect.objectContaining({ kind: "turn.end", agentId: "child-thread" }),
      ]),
    );
    await h.adapter.sendToSubagent?.("child-thread", "再跑一次测试");
    expect(h.writes.at(-1)).toMatchObject({
      method: "turn/start",
      params: { threadId: "child-thread", input: [{ type: "text", text: "再跑一次测试" }] },
    });
  });
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
