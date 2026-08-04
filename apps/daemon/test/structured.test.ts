/**
 * 结构化轨集成测试:跑真实的 opencode serve 后端。
 * 未安装 opencode 时自动跳过(CI/他机友好)。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentEventBody, SessionInfo } from "@prospero/protocol";
import { SessionManager } from "../src/session-manager.js";
import { stopOpencodeServer } from "../src/adapters/opencode.js";

function hasOpencode(): boolean {
  try {
    execFileSync("opencode", ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const available = hasOpencode();
const describeIf = available ? describe : describe.skip;

const cwd = mkdtempSync(path.join(os.tmpdir(), "prospero-oc-"));
let manager: SessionManager;

beforeAll(() => {
  manager = new SessionManager();
});

afterAll(async () => {
  manager?.disposeAll();
  stopOpencodeServer();
});

describeIf("opencode 结构化会话", () => {
  it("创建 → 发消息 → 收到文本增量与 turn.end", async () => {
    const events: AgentEventBody[] = [];
    manager.on("agentEvent", (_sid, body) => events.push(body));

    const info = await manager.create({
      agent: "opencode",
      cwd,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    expect(info.kind).toBe("structured");
    expect(info.agent).toBe("opencode");

    const session = manager.requireStructured(info.id);
    await session.send("Reply with exactly the word PONG and nothing else.");

    // 用户消息立刻进日志(attach 快照能看到自己发过什么)
    expect(events.some((e) => e.kind === "user.message")).toBe(true);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !events.some((e) => e.kind === "turn.end")) {
      await new Promise((r) => setTimeout(r, 250));
    }

    const errors = events.filter((e) => e.kind === "agent.error");
    expect(
      events.some((e) => e.kind === "turn.end"),
      `未收到 turn.end;errors=${JSON.stringify(errors)}`,
    ).toBe(true);

    const text = events
      .filter((e): e is Extract<AgentEventBody, { kind: "text.delta" }> => e.kind === "text.delta")
      .map((e) => e.delta)
      .join("");
    expect(text.toUpperCase()).toContain("PONG");
  }, 150_000);

  it("快照与增量续传一致", async () => {
    const info = await manager.create({
      agent: "opencode",
      cwd,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    const session = manager.requireStructured(info.id);
    await session.send("hi");

    const snap = session.snapshot();
    expect(snap.events.length).toBeGreaterThan(0);
    expect(snap.evSeq).toBe(snap.events.length);

    // 从 0 续传应等价于全量
    expect(session.since(0)).toEqual(snap.events);
    // 从最新续传应为空
    expect(session.since(snap.evSeq)).toEqual([]);
    // 超前的 seq 视为不可信 → null(触发全量快照)
    expect(session.since(snap.evSeq + 5)).toBeNull();
  }, 90_000);

  it("会话列表区分 kind,PTY 与结构化互不串台", async () => {
    const structured = await manager.create({
      agent: "opencode",
      cwd,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    const pty = await manager.create({
      agent: "custom",
      command: "sleep 5",
      cwd,
      cols: 80,
      rows: 24,
      allowShell: true,
    });

    const list: SessionInfo[] = manager.list();
    expect(list.find((s) => s.id === structured.id)?.kind).toBe("structured");
    expect(list.find((s) => s.id === pty.id)?.kind).toBe("pty");

    // 结构化会话不接受终端输入,PTY 会话不接受聊天消息
    expect(() => manager.requirePty(structured.id)).toThrowError(/结构化会话/);
    expect(() => manager.requireStructured(pty.id)).toThrowError(/终端会话/);

    await manager.kill(pty.id);
  }, 90_000);
});

describe("适配器能力查询", () => {
  it("无适配器的 agent 请求 structured 会被拒", async () => {
    const m = new SessionManager();
    await expect(
      m.create({ agent: "grok", kind: "structured", cwd, cols: 80, rows: 24, allowShell: false }),
    ).rejects.toThrow(/结构化适配器/);
  });
});
