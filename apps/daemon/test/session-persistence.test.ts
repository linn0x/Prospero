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
