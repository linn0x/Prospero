import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

    // 不 await：模拟 worker 自己正在承载的 control RPC 令 adapter.dispose 等待，
    // daemon 仍必须先同步落下 terminal snapshot 才能防止随后崩溃时错误恢复。
    const killing = manager.kill(created.id, { preserveHistory: true });
    expect(releaseDispose).not.toBeNull();
    expect(JSON.parse(readFileSync(path.join(home, "structured-sessions.json"), "utf8")))
      .toEqual([expect.objectContaining({ id: created.id, terminal: true })]);

    releaseDispose?.();
    await killing;
    await manager.disposeAll();
  });

  it("恢复阶段可先封存已结算 worker，不启动 adapter 或消费旧队列", async () => {
    const home = tempHome();
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
    // 模拟 store 先落下 dispatch succeeded/failed、进程在 kill 之前崩溃：
    // structured state 仍是非 terminal。
    first.flushPersistence();
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
    const restored = await second.restoreStructured({
      preserveHistoryWhen: (state) => state.id === created.id,
    });

    expect(restored).toEqual([expect.objectContaining({ id: created.id, status: "done" })]);
    expect(starts).toBe(0);
    expect(JSON.parse(readFileSync(path.join(home, "structured-sessions.json"), "utf8")))
      .toEqual([expect.objectContaining({ id: created.id, terminal: true })]);
    await expect(second.chatSend(created.id, "不得在恢复时重连"))
      .rejects.toThrow("历史只读");
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
    first.flushPersistence();

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
    second.flushPersistence();
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
