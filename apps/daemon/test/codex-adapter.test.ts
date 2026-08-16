/**
 * Codex app-server 适配器集成测试。未安装 codex 时跳过。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventBody, ApprovalPolicy } from "@prospero/protocol";
import { CodexAdapter } from "../src/adapters/codex.js";
import { StructuredSession } from "../src/structured-session.js";
import { SessionManager } from "../src/session-manager.js";
import type { AdapterContext } from "../src/adapters/types.js";

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

async function startSession(
  events: AgentEventBody[],
  sessionCwd = cwd,
): Promise<StructuredSession> {
  const s = new StructuredSession({
    id: `codex-test-${String(Date.now())}`,
    agent: "codex",
    title: "codex · test",
    cwd: sessionCwd,
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

/** 真实后端在一轮中可能连续请求多次审批；每个 reqId 只能回复一次。 */
async function approveAll(
  target: StructuredSession,
  events: AgentEventBody[],
  done: () => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const answered = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return;
    for (const event of events) {
      if (event.kind !== "permission.request" || answered.has(event.reqId)) continue;
      answered.add(event.reqId);
      await target.respondPermission(event.reqId, "once");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`超时;已到达:${events.map((event) => event.kind).join(" → ") || "(无)"}`);
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

  it("v2 批准后在隔离临时 worktree 真正写入，而不是被 Codex declined", async () => {
    const worktree = mkdtempSync(path.join(os.tmpdir(), "prospero-codex-approval-worktree-"));
    const target = path.join(worktree, "approved-by-v2.txt");
    const events: AgentEventBody[] = [];
    try {
      // 这个仓库仅为 app-server 回归创建；绝不使用调用测试者的工作目录。
      execFileSync("git", ["init", "--quiet"], { cwd: worktree, timeout: 15_000 });
      session = await startSession(events, worktree);
      await session.send(
        "Create approved-by-v2.txt in the current directory with exactly the text V2_APPROVED. " +
          "Use your file-editing tool, do not use a shell command, and then stop.",
      );

      await waitFor(
        () => events.some((event) => event.kind === "permission.request"),
        `permission.request;errors=${JSON.stringify(events.filter((event) => event.kind === "agent.error"))}`,
      );
      await approveAll(session, events, () => events.some((event) => event.kind === "turn.end"));

      expect(readFileSync(target, "utf8").trim()).toBe("V2_APPROVED");
      expect(events.some((event) => event.kind === "tool.end" && event.state === "success")).toBe(true);
    } finally {
      await session?.dispose();
      session = null;
      rmSync(worktree, { recursive: true, force: true });
    }
  }, 180_000);

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

  describe("Codex 本机任务接回", () => {
    it("原任务已有 writer 时上抛冲突，不自动创建副本", async () => {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const adapter = new CodexAdapter({ resumeState: { threadId: "busy-thread" } });
    const internals = adapter as unknown as {
      startAppServer(): Promise<void>;
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    internals.startAppServer = async () => {};
    internals.request = async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/resume") {
        throw new Error("codex thread/resume 失败: thread busy-thread already has an active writer");
      }
        if (method === "thread/list") return { data: [] };
        throw new Error(`unexpected method ${method}`);
    };

    const context: AdapterContext = {
        cwd,
        approvalPolicy: () => "standard",
        emit: () => {},
        persistState: () => {},
      };
      await expect(adapter.start(context)).rejects.toThrow("already has an active writer");
      expect(calls.map((call) => call.method)).toEqual(["thread/resume"]);
    });

    it("用户确认后直接 thread/fork 创建独立副本", async () => {
      const persisted: Array<Record<string, unknown>> = [];
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const adapter = new CodexAdapter({
        resumeState: { threadId: "busy-thread", forkThread: true },
      });
      const internals = adapter as unknown as {
        startAppServer(): Promise<void>;
        request(method: string, params: Record<string, unknown>): Promise<unknown>;
      };
      internals.startAppServer = async () => {};
      internals.request = async (method, params) => {
        calls.push({ method, params });
        if (method === "thread/fork") return { thread: { id: "forked-thread" } };
        if (method === "thread/list") return { data: [] };
        throw new Error(`unexpected method ${method}`);
      };

      await adapter.start({
        cwd,
        approvalPolicy: () => "standard",
        emit: () => {},
        persistState: (state) => persisted.push(state),
      });

      expect(calls[0]?.method).toBe("thread/fork");
      expect(calls[0]?.params).toMatchObject({
        threadId: "busy-thread",
        cwd,
      deferGoalContinuation: true,
    });
      expect(persisted.at(-1)?.["threadId"]).toBe("forked-thread");
    });

    it("SessionManager 将 active writer 映射为手机可识别的冲突", async () => {
      const manager = new SessionManager({
        adapterFactory: (_agent, state) => {
          const adapter = new CodexAdapter({ resumeState: state });
          const internals = adapter as unknown as {
            startAppServer(): Promise<void>;
            request(method: string): Promise<unknown>;
          };
          internals.startAppServer = async () => {};
          internals.request = async (method) => {
            if (method === "thread/resume") {
              throw new Error("thread busy-thread already has an active writer");
            }
            throw new Error(`unexpected method ${method}`);
          };
          return adapter;
        },
      });

      await expect(manager.create({
        agent: "codex",
        kind: "structured",
        cwd,
        resume: { id: "busy-thread" },
        cols: 80,
        rows: 24,
        allowShell: false,
      })).rejects.toMatchObject({
        code: "conflict",
        reason: "conversation_active_writer",
      });
      await manager.disposeAll();
    });
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
    expect(h.writes).toEqual([{ id: 41, result: { decision: "accept" } }]);
  });

  it("YOLO 对 v2 permissions 也走 method-aware 的最小授权响应并保留审计", () => {
    const h = approvalHarness(() => "yolo");
    h.request({
      id: 43,
      method: "item/permissions/requestApproval",
      params: {
        itemId: "permission-yolo-1",
        reason: "需要联网",
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
    });

    expect(h.writes).toEqual([{
      id: 43,
      result: { permissions: { network: { enabled: true } }, scope: "turn" },
    }]);
    expect(h.events).toEqual([expect.objectContaining({
      kind: "permission.auto",
      reqId: "permission-yolo-1",
      policy: "yolo",
    })]);
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

describe("Codex app-server 审批响应兼容性(桩数据)", () => {
  it("v2 command 与 fileChange 将 once/always/reject 映射为各自的新 decision", async () => {
    const h = approvalHarness(() => "strict");
    const cases = [
      {
        id: 101,
        method: "item/commandExecution/requestApproval",
        reqId: "command-once",
        reply: "once",
        expected: "accept",
      },
      {
        id: 102,
        method: "item/commandExecution/requestApproval",
        reqId: "command-always",
        reply: "always",
        expected: "acceptForSession",
      },
      {
        id: 103,
        method: "item/commandExecution/requestApproval",
        reqId: "command-reject",
        reply: "reject",
        expected: "decline",
      },
      {
        id: 104,
        method: "item/fileChange/requestApproval",
        reqId: "file-once",
        reply: "once",
        expected: "accept",
      },
      {
        id: 105,
        method: "item/fileChange/requestApproval",
        reqId: "file-always",
        reply: "always",
        expected: "acceptForSession",
      },
      {
        id: 106,
        method: "item/fileChange/requestApproval",
        reqId: "file-reject",
        reply: "reject",
        expected: "decline",
      },
    ] as const;

    for (const testCase of cases) {
      h.request({
        id: testCase.id,
        method: testCase.method,
        params: {
          itemId: testCase.reqId,
          ...(testCase.method === "item/commandExecution/requestApproval"
            ? { command: "echo v2" }
            : { reason: "src/v2.ts" }),
        },
      });
      await h.adapter.respondPermission(testCase.reqId, testCase.reply);
    }

    expect(h.writes).toEqual(cases.map((testCase) => ({
      id: testCase.id,
      result: { decision: testCase.expected },
    })));
  });

  it("v2 permissions 只回显请求的非 null profile，并按 reply 选择 scope 或零权限拒绝", async () => {
    const h = approvalHarness(() => "strict");
    const fileSystem = {
      read: ["/tmp/prospero-read"],
      write: ["/tmp/prospero-write"],
      entries: [{ path: "/tmp/prospero-write", access: "write" }],
    };
    const cases = [
      {
        id: 111,
        reqId: "permissions-once",
        reply: "once",
        permissions: {
          network: { enabled: true },
          fileSystem: null,
          unexpected: "must not be echoed",
        },
        expected: { permissions: { network: { enabled: true } }, scope: "turn" },
      },
      {
        id: 112,
        reqId: "permissions-always",
        reply: "always",
        permissions: { network: null, fileSystem },
        expected: { permissions: { fileSystem }, scope: "session" },
      },
      {
        id: 113,
        reqId: "permissions-reject",
        reply: "reject",
        permissions: { network: { enabled: true }, fileSystem },
        expected: { permissions: {}, scope: "turn" },
      },
    ] as const;

    for (const testCase of cases) {
      h.request({
        id: testCase.id,
        method: "item/permissions/requestApproval",
        params: {
          itemId: testCase.reqId,
          reason: "需要额外权限",
          permissions: testCase.permissions,
        },
      });
      await h.adapter.respondPermission(testCase.reqId, testCase.reply);
    }

    expect(h.writes).toEqual(cases.map((testCase) => ({
      id: testCase.id,
      result: testCase.expected,
    })));
  });

  it("legacy execCommandApproval/applyPatchApproval 保持旧 ReviewDecision", async () => {
    const h = approvalHarness(() => "strict");
    h.request({
      id: 121,
      method: "execCommandApproval",
      params: { callId: "legacy-command-once", command: ["echo", "legacy"] },
    });
    h.request({
      id: 122,
      method: "execCommandApproval",
      params: { callId: "legacy-command-always", command: ["echo", "legacy"] },
    });
    h.request({
      id: 123,
      method: "applyPatchApproval",
      params: { callId: "legacy-patch-reject", reason: "src/legacy.ts" },
    });

    await h.adapter.respondPermission("legacy-command-once", "once");
    await h.adapter.respondPermission("legacy-command-always", "always");
    await h.adapter.respondPermission("legacy-patch-reject", "reject");

    expect(h.writes).toEqual([
      { id: 121, result: { decision: "approved" } },
      { id: 122, result: { decision: "approved_for_session" } },
      {
        id: 123,
        result: { decision: { denied: { rejection: "用户在手机上拒绝了此操作" } } },
      },
    ]);
  });

  it("忽略未知或已经处理过的 reqId，避免重复回复同一个 JSON-RPC callback", async () => {
    const h = approvalHarness(() => "strict");
    await h.adapter.respondPermission("unknown", "once");

    h.request({
      id: 131,
      method: "item/fileChange/requestApproval",
      params: { itemId: "only-once", reason: "src/once.ts" },
    });
    await h.adapter.respondPermission("only-once", "once");
    await h.adapter.respondPermission("only-once", "reject");

    expect(h.writes).toEqual([{ id: 131, result: { decision: "accept" } }]);
    expect(h.events.filter((event) => event.kind === "permission.resolved")).toHaveLength(1);
  });
});

describe("Codex 原生 Plan、提问与子 Agent(桩数据)", () => {
  it("中断请求携带官方协议要求的当前 turnId", async () => {
    const h = approvalHarness(() => "standard");
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const internals = h.adapter as unknown as {
      threadId: string;
      currentTurns: Map<string, string>;
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    internals.threadId = "main-thread";
    internals.currentTurns.set("main-thread", "turn-running");
    internals.request = async (method, params) => {
      calls.push({ method, params });
      return {};
    };

    await h.adapter.interrupt();
    expect(calls).toEqual([{
      method: "turn/interrupt",
      params: { threadId: "main-thread", turnId: "turn-running" },
    }]);

    internals.currentTurns.clear();
    await h.adapter.interrupt();
    expect(calls).toHaveLength(1);
  });

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

  it("child id 先到、thread 身份后到时会补全 Codex 原生 Agent 名称", () => {
    const h = approvalHarness(() => "standard");
    const internals = h.adapter as unknown as {
      threadId: string;
      onNotification(message: Record<string, unknown>): void;
    };
    internals.threadId = "main-thread";
    internals.onNotification({
      method: "item/started",
      params: {
        threadId: "main-thread",
        item: {
          id: "collab-1",
          type: "collabAgentToolCall",
          receiverThreadIds: ["late-child"],
          prompt: "检查 UI",
        },
      },
    });
    internals.onNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "late-child",
          parentThreadId: "main-thread",
          agentNickname: "visual-reviewer",
          agentRole: "reviewer",
          status: { type: "active", activeFlags: [] },
          canAcceptDirectInput: true,
        },
      },
    });

    const identities = h.events.filter(
      (event): event is Extract<AgentEventBody, { kind: "subagent.started" }> =>
        event.kind === "subagent.started" && event.subagent.id === "late-child",
    );
    expect(identities).toHaveLength(2);
    expect(identities.at(-1)?.subagent).toMatchObject({
      name: "visual-reviewer",
      role: "reviewer",
      task: "检查 UI",
    });
  });

  it("发现历史子线程时只接受 parentThreadId 精确匹配的原生子来源", async () => {
    const h = approvalHarness(() => "standard");
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const internals = h.adapter as unknown as {
      threadId: string;
      discoverSubagents(): Promise<void>;
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    internals.threadId = "main-thread";
    internals.request = async (method, params) => {
      calls.push({ method, params });
      if (params["cursor"] === "page-2") {
        return {
          data: [{
            id: "child-2",
            parentThreadId: "main-thread",
            agentNickname: "Laplace",
            status: { type: "idle" },
          }],
        };
      }
      return {
        data: [
          { id: "main-thread", parentThreadId: null, name: "父线程" },
          { id: "foreign-child", parentThreadId: "other-thread", agentNickname: "Wrong" },
          {
            id: "child-1",
            parentThreadId: "main-thread",
            agentNickname: "Peirce",
            agentRole: "reviewer",
            status: { type: "active", activeFlags: [] },
          },
        ],
        nextCursor: "page-2",
      };
    };

    await internals.discoverSubagents();
    const identities = h.events.flatMap((event) =>
      event.kind === "subagent.started" ? [event.subagent] : [],
    );
    expect(identities.map((child) => child.id)).toEqual(["child-1", "child-2"]);
    expect(identities.map((child) => child.name)).toEqual(["Peirce", "Laplace"]);
    expect(calls[0]?.params["sourceKinds"]).toEqual(expect.arrayContaining(["subAgent"]));
    expect(calls[1]?.params["cursor"]).toBe("page-2");
  });

  it("thread/read 把子 Agent 的对话、推理与工具过程映射成统一事件", async () => {
    const h = approvalHarness(() => "standard");
    const internals = h.adapter as unknown as {
      threadId: string;
      onNotification(message: Record<string, unknown>): void;
      request(method: string, params: Record<string, unknown>): Promise<unknown>;
    };
    internals.threadId = "main-thread";
    internals.onNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          parentThreadId: "main-thread",
          agentNickname: "Curie",
          status: { type: "idle" },
        },
      },
    });
    internals.request = async (method, params) => {
      expect(method).toBe("thread/read");
      expect(params).toEqual({ threadId: "child-thread", includeTurns: true });
      return {
        thread: {
          id: "child-thread",
          parentThreadId: "main-thread",
          turns: [{
            id: "turn-1",
            status: "completed",
            error: null,
            items: [
              { type: "userMessage", id: "user-1", content: [{ type: "text", text: "检查 UI" }] },
              { type: "reasoning", id: "reason-1", summary: ["先读组件"], content: [] },
              {
                type: "commandExecution",
                id: "cmd-1",
                command: "npm test",
                status: "completed",
                aggregatedOutput: "12 tests passed",
              },
              {
                type: "fileChange",
                id: "edit-1",
                status: "completed",
                changes: [{ path: "src/View.tsx", diff: "@@ -1 +1 @@\n-old\n+new" }],
              },
              { type: "agentMessage", id: "answer-1", text: "检查完成" },
            ],
          }],
        },
      };
    };

    const events = await h.adapter.readSubagentHistory?.("child-thread");
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "user.message", text: "检查 UI", agentId: "child-thread" }),
      expect.objectContaining({ kind: "reasoning.delta", delta: "先读组件" }),
      expect.objectContaining({ kind: "tool.start", callId: "cmd-1", tool: "bash" }),
      expect.objectContaining({ kind: "tool.end", callId: "cmd-1", summary: "12 tests passed" }),
      expect.objectContaining({ kind: "tool.start", callId: "edit-1", diff: expect.objectContaining({ path: "src/View.tsx" }) }),
      expect.objectContaining({ kind: "text.delta", msgId: "answer-1", delta: "检查完成" }),
      expect.objectContaining({ kind: "turn.end", msgId: "answer-1", finish: "completed" }),
    ]));
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
