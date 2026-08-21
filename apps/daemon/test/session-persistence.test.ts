import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventBody, PermissionReply } from "@prospero/protocol";
import type {
  AdapterContext,
  AdapterResumeState,
  AgentAdapter,
} from "../src/adapters/types.js";
import { SessionManager } from "../src/session-manager.js";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";
import { killSession, tmuxPath } from "../src/tmux.js";

/** 轮询等谓词成立;写盘已异步化,不能在同一 tick 里同步读到结果。 */
async function waitFor(pred: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`超时等待:${what}`);
}

const temps: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-persist-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakePersistentAdapter implements AgentAdapter {
  private ctx: AdapterContext | null = null;

  constructor(private readonly restored: AdapterResumeState | undefined) {}

  async start(ctx: AdapterContext): Promise<void> {
    this.ctx = ctx;
    ctx.persistState?.({ nativeId: this.restored?.["nativeId"] ?? "native-session-1" });
  }

  async send(text: string): Promise<void> {
    this.ctx?.emit({ kind: "text.delta", msgId: "a1", textId: "a1", delta: `echo:${text}` });
    this.ctx?.recordOutput?.("tool-1", "完整工具输出");
    this.ctx?.emit({ kind: "turn.end", msgId: "a1", inputTokens: 2, outputTokens: 3 });
  }

  askPermission(): void {
    this.ctx?.emit({
      kind: "permission.request",
      reqId: "pending-1",
      action: "测试",
      resources: ["/tmp/demo"],
      summary: "等待审批",
    });
  }

  async respondPermission(_reqId: string, _reply: PermissionReply): Promise<void> {}
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {
    this.ctx = null;
  }
}

/** 模拟交付 Store 已落盘、尚未来得及 preserveHistory kill 的崩溃现场。 */
async function seedRecoverableQueuedState(home: string): Promise<string> {
  const first = new SessionManager({
    home,
    adapterFactory: (_agent, state) => new FakePersistentAdapter(state),
  });
  const created = await first.create({
    agent: "codex",
    kind: "structured",
    cwd: home,
    cols: 80,
    rows: 24,
    allowShell: false,
  });
  await first.flushPersistence();
  await first.disposeAll();

  const stateFile = path.join(home, "structured-sessions.json");
  const states = JSON.parse(readFileSync(stateFile, "utf8")) as Array<Record<string, unknown>>;
  states[0]!["messageQueue"] = [{
    id: "queued-after-delivery",
    displayText: "绝不能在重启后写入 worktree",
    outgoingText: "绝不能在重启后写入 worktree",
    kind: "queue",
    createdAt: 1,
    attachmentCount: 0,
    attachments: [],
  }];
  writeFileSync(stateFile, JSON.stringify(states));
  return created.id;
}

describe("结构化会话持久化", () => {
  it("worker 交付后终止原生会话但保留只读历史，重启后也不会复活队列", async () => {
    const home = tempHome();
    const first = new SessionManager({
      home,
      adapterFactory: (_agent, state) => {
        const adapter = new FakePersistentAdapter(state);
        // 第一轮刻意不结束，让第二条消息留在队列中；这正是 worker task.done
        // 之后旧结构化会话过去会继续消费并写回原 worktree 的场景。
        adapter.send = async () => {};
        return adapter;
      },
    });
    const created = await first.create({
      agent: "codex",
      kind: "structured",
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    await first.chatSend(created.id, "交付前仍在运行");
    await first.chatSend(created.id, "不得在交付后继续消费");
    expect(first.infoOf(created.id).messageQueue).toHaveLength(1);
    await first.kill(created.id, { preserveHistory: true });
    expect(first.infoOf(created.id).status).toBe("done");
    await expect(first.chatSend(created.id, "不得继续写 worktree"))
      .rejects.toThrow("历史只读");
    // preserveHistory kill 自己就必须同步写 terminal 快照；这里刻意不手动 flush，
    // 模拟 kill 返回后 daemon 立刻崩溃。
    expect(JSON.parse(readFileSync(path.join(home, "structured-sessions.json"), "utf8")))
      .toEqual([expect.objectContaining({
        id: created.id,
        terminal: true,
        messageQueue: [expect.objectContaining({ displayText: "不得在交付后继续消费" })],
      })]);
    await first.disposeAll();

    let starts = 0;
    const second = new SessionManager({
      home,
      adapterFactory: (_agent, state) => {
        const adapter = new FakePersistentAdapter(state);
        const start = adapter.start.bind(adapter);
        adapter.start = async (context) => {
          starts += 1;
          await start(context);
        };
        return adapter;
      },
    });
    const restored = await second.restoreStructured();
    expect(restored).toEqual([expect.objectContaining({ id: created.id, status: "done" })]);
    expect(starts).toBe(0);
    await expect(second.chatSend(created.id, "不得重启"))
      .rejects.toThrow("历史只读");
    await second.disposeAll();
  });

  it("preserveHistory 在原生 adapter 释放卡住时也立即写出终态", async () => {
    const home = tempHome();
    let releaseDispose: (() => void) | null = null;
    const manager = new SessionManager({
      home,
      adapterFactory: (_agent, state) => {
        const adapter = new FakePersistentAdapter(state);
        adapter.dispose = async () => new Promise<void>((resolve) => {
          releaseDispose = resolve;
        });
        return adapter;
      },
    });
    const created = await manager.create({
      agent: "codex",
      kind: "structured",
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: false,
    });

    // 不 await：模拟 worker 自己正在承载的 control RPC 令 adapter.dispose 等待。
    // 写盘已异步化,但仍在 dispose 挂起时独立完成 —— 轮询等终态快照落盘。
    const killing = manager.kill(created.id, { preserveHistory: true });
    expect(releaseDispose).not.toBeNull();
    await waitFor(() => {
      try {
        const parsed = JSON.parse(
          readFileSync(path.join(home, "structured-sessions.json"), "utf8"),
        ) as Array<Record<string, unknown>>;
        return parsed.length === 1 && parsed[0]?.id === created.id && parsed[0]?.terminal === true;
      } catch {
        return false;
      }
    }, "preserveHistory 终态快照落盘");

    releaseDispose?.();
    await killing;
    await manager.disposeAll();
  });

  it("恢复阶段可先封存已结算 worker，不启动 adapter 或消费旧队列", async () => {
    const home = tempHome();
    // 模拟 store 先落下 dispatch succeeded/failed、进程在 kill 之前崩溃：磁盘的
    // structured state 仍非 terminal，却已有一条本来会在恢复时 drain 的排队消息。
    const sessionId = await seedRecoverableQueuedState(home);

    let starts = 0;
    let sends = 0;
    const second = new SessionManager({
      home,
      adapterFactory: (_agent, state) => {
        const adapter = new FakePersistentAdapter(state);
        const start = adapter.start.bind(adapter);
        adapter.start = async (context) => {
          starts += 1;
          await start(context);
        };
        adapter.send = async () => {
          sends += 1;
        };
        return adapter;
      },
    });
    const restored = await second.restoreStructured({
      preserveHistoryWhen: (state) => state.id === sessionId,
    });

    expect(restored).toEqual([expect.objectContaining({ id: sessionId, status: "done" })]);
    expect(starts).toBe(0);
    expect(sends).toBe(0);
    expect(second.infoOf(sessionId).messageQueue).toEqual([
      expect.objectContaining({ text: "绝不能在重启后写入 worktree" }),
    ]);
    expect(JSON.parse(readFileSync(path.join(home, "structured-sessions.json"), "utf8")))
      .toEqual([expect.objectContaining({ id: sessionId, terminal: true })]);
    await expect(second.chatSend(sessionId, "不得在恢复时重连"))
      .rejects.toThrow("历史只读");
    await second.disposeAll();
  });

  it("adapter.start 期间才结算的 worker 在 drainQueue 前也会封存", async () => {
    const home = tempHome();
    const sessionId = await seedRecoverableQueuedState(home);
    let settled = false;
    let starts = 0;
    let sends = 0;
    let enterStart: (() => void) | null = null;
    let releaseStart: (() => void) | null = null;
    const enteredStart = new Promise<void>((resolve) => { enterStart = resolve; });
    const second = new SessionManager({
      home,
      adapterFactory: (_agent, state) => {
        const adapter = new FakePersistentAdapter(state);
        const start = adapter.start.bind(adapter);
        adapter.start = async (context) => {
          starts += 1;
          enterStart?.();
          await new Promise<void>((resolve) => { releaseStart = resolve; });
          await start(context);
        };
        adapter.send = async () => { sends += 1; };
        return adapter;
      },
    });

    const restoring = second.restoreStructured({ preserveHistoryWhen: () => settled });
    await enteredStart;
    // control socket 在 adapter.start 的 await 期间收到了旧 worker 的 task.done/fail。
    settled = true;
    releaseStart?.();
    const restored = await restoring;

    expect(restored).toEqual([expect.objectContaining({ id: sessionId, status: "done" })]);
    expect(starts).toBe(1);
    expect(sends).toBe(0);
    expect(second.infoOf(sessionId).messageQueue).toEqual([
      expect.objectContaining({ text: "绝不能在重启后写入 worktree" }),
    ]);
    expect(JSON.parse(readFileSync(path.join(home, "structured-sessions.json"), "utf8")))
      .toEqual([expect.objectContaining({ id: sessionId, terminal: true })]);
    await second.disposeAll();
  });

  it("创建时把 Plan、模型与选中的本机原生会话 ID 交给适配器", async () => {
    const home = tempHome();
    let received: AdapterResumeState | undefined;
    const manager = new SessionManager({
      home,
      adapterFactory: (_agent, state) => {
        received = state;
        return new FakePersistentAdapter(state);
      },
    });
    const info = await manager.create({
      agent: "claude",
      kind: "structured",
      cwd: home,
      mode: "plan",
      model: "claude-opus-test",
      effort: "high",
      resume: { id: "claude-native-session", title: "继续修复手机端" },
      cols: 80,
      rows: 24,
      allowShell: false,
    });

    expect(received).toEqual({
      mode: "plan",
      model: "claude-opus-test",
      effort: "high",
      sessionId: "claude-native-session",
    });
    expect(info.title).toBe("继续修复手机端");
    expect(manager.requireStructured(info.id).persistentState().adapterState).toMatchObject({
      mode: "plan",
      model: "claude-opus-test",
      effort: "high",
      sessionId: "claude-native-session",
    });
    await manager.disposeAll();
  });

  it("重启后恢复同一个 ID、事件、策略、工具输出和原生会话游标", async () => {
    const home = tempHome();
    const firstStates: (AdapterResumeState | undefined)[] = [];
    let firstAdapter: FakePersistentAdapter | null = null;
    const first = new SessionManager({
      home,
      adapterFactory: (_agent, state) => {
        firstStates.push(state);
        firstAdapter = new FakePersistentAdapter(state);
        return firstAdapter;
      },
    });

    const created = await first.create({
      agent: "codex",
      kind: "structured",
      approvalPolicy: "yolo",
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    await first.chatSend(created.id, "hello");
    firstAdapter?.askPermission();
    await first.chatSend(created.id, "queued after restart");
    await first.flushPersistence();

    const disk = JSON.parse(
      readFileSync(path.join(home, "structured-sessions.json"), "utf8"),
    ) as unknown[];
    expect(disk).toHaveLength(1);
    expect(disk[0]).toMatchObject({
      messageQueue: [
        expect.objectContaining({ displayText: "queued after restart", kind: "queue" }),
      ],
    });
    expect(firstStates).toEqual([undefined]);
    await first.disposeAll();

    const restoredStates: (AdapterResumeState | undefined)[] = [];
    const second = new SessionManager({
      home,
      adapterFactory: (_agent, state) => {
        restoredStates.push(state);
        return new FakePersistentAdapter(state);
      },
    });
    const restored = await second.restoreStructured();

    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).toBe(created.id);
    expect(restored[0]?.approvalPolicy).toBe("yolo");
    expect(restoredStates).toEqual([{ nativeId: "native-session-1" }]);

    const session = second.requireStructured(created.id);
    const snapshot = session.snapshot();
    expect(
      snapshot.events.some(
        (e): e is Extract<AgentEventBody, { kind: "user.message" }> =>
          e.kind === "user.message" && e.text === "hello",
      ),
    ).toBe(true);
    expect(
      snapshot.events.some(
        (e) => e.kind === "permission.resolved" && e.reqId === "pending-1" && e.reply === "reject",
      ),
    ).toBe(true);
    expect(session.toolOutput("tool-1")?.output).toBe("完整工具输出");
    expect(
      snapshot.events.some(
        (e) => e.kind === "user.message" && e.text === "queued after restart",
      ),
    ).toBe(true);

    await second.kill(created.id);
    await second.flushPersistence();
    expect(
      JSON.parse(readFileSync(path.join(home, "structured-sessions.json"), "utf8")),
    ).toEqual([]);
    await second.disposeAll();
  });

  it("PTY 进程跨完整 daemon 重启后由 tmux 重新接管", async () => {
    if (!tmuxPath()) return;
    const home = tempHome();
    let first: DaemonServer | null = null;
    let second: DaemonServer | null = null;
    let firstClosed = false;
    let sid = "";
    try {
      first = await createDaemonServer({ home, port: 0, useTmux: true });
      const created = await first.manager.create({
        agent: "custom",
        command: "printf 'PERSIST_PTY\\n'; sleep 30",
        cwd: home,
        cols: 80,
        rows: 24,
        allowShell: true,
      });
      sid = created.id;
      await first.close();
      firstClosed = true;

      second = await createDaemonServer({ home, port: 0, useTmux: true });
      expect(second.restoredSessions).toBe(1);
      expect(second.manager.infoOf(sid).kind).toBe("pty");
      await second.manager.kill(sid);
      sid = "";
    } finally {
      if (!firstClosed) await first?.close();
      await second?.close();
      if (sid) killSession(sid);
    }
  });
});
