/**
 * Claude Code 结构化适配器集成测试(跑真实 SDK/CLI)。
 * 未安装 claude 或未登录时跳过。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { StructuredSession } from "../src/structured-session.js";
import { SessionManager } from "../src/session-manager.js";

function hasClaude(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const describeIf = hasClaude() ? describe : describe.skip;
const cwd = mkdtempSync(path.join(os.tmpdir(), "prospero-claude-"));
let manager: SessionManager | null = null;
let session: StructuredSession | null = null;

afterEach(async () => {
  manager?.disposeAll();
  manager = null;
  await session?.dispose();
  session = null;
});

/**
 * 直接构造会话以便注入适配器选项。
 * 审批测试要禁掉 Bash:否则模型可能改用 `cat > file` 完成写入,而 Claude Code 2.x
 * 的安全命令分类器会自动放行部分 Bash 调用 → 测试随模型选路而偶发失败。
 */
async function startClaudeSession(
  events: AgentEventBody[],
  disallowedTools?: string[],
): Promise<StructuredSession> {
  const s = new StructuredSession({
    id: `test-${String(Date.now())}`,
    agent: "claude",
    title: "claude · test",
    cwd,
    adapter: new ClaudeAdapter(disallowedTools ? { disallowedTools } : {}),
  });
  s.on("event", (body) => events.push(body));
  await s.start();
  return s;
}

async function waitFor(
  pred: () => boolean,
  what: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`超时等待:${what}`);
}

describeIf("Claude Code 结构化会话", () => {
  it("发消息 → 文本增量 → turn.end", async () => {
    manager = new SessionManager();
    const events: AgentEventBody[] = [];
    manager.on("agentEvent", (_sid, body) => events.push(body));

    const info = await manager.create({
      agent: "claude",
      cwd,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    expect(info.kind).toBe("structured");

    const session = manager.requireStructured(info.id);
    await session.send("Reply with exactly the word PONG and nothing else.");

    await waitFor(
      () => events.some((e) => e.kind === "turn.end"),
      `turn.end;errors=${JSON.stringify(events.filter((e) => e.kind === "agent.error"))}`,
    );

    const text = events
      .filter((e): e is Extract<AgentEventBody, { kind: "text.delta" }> => e.kind === "text.delta")
      .map((e) => e.delta)
      .join("");
    expect(text.toUpperCase()).toContain("PONG");

    const turn = events.find((e) => e.kind === "turn.end");
    expect(turn).toBeDefined();
  }, 180_000);

  // 注意:Claude Code 2.x 的安全命令分类器会自动放行只读/无害操作(如 echo、
  // cwd 内的 Read),不会走 canUseTool。要验证审批链路必须用写操作。
  it("写操作触发审批,拒绝后 agent 感知到拒绝", async () => {
    const events: AgentEventBody[] = [];
    session = await startClaudeSession(events, ["Bash"]);
    await session.send(
      "Create a file named denied.txt containing the word HELLO in the current directory.",
    );

    await waitFor(
      () => events.some((e) => e.kind === "permission.request"),
      "permission.request",
    );
    const req = events.find(
      (e): e is Extract<AgentEventBody, { kind: "permission.request" }> =>
        e.kind === "permission.request",
    )!;
    // 审批卡片要有可读的动作与资源
    expect(req.action.length).toBeGreaterThan(0);
    expect(req.summary.length).toBeGreaterThan(0);

    // 会话状态应变为待审批
    expect(session.info().status).toBe("waiting_approval");
    expect(session.info().pendingPermissions).toBe(1);

    await session.respondPermission(req.reqId, "reject");
    await waitFor(
      () => events.some((e) => e.kind === "permission.resolved"),
      "permission.resolved",
    );
    expect(session.info().pendingPermissions).toBe(0);

    // 拒绝要真正回传给 agent:对应的工具调用应标记为失败
    await waitFor(
      () =>
        events.some(
          (e) => e.kind === "tool.end" && e.state === "failed",
        ),
      "tool.end(failed)",
    );
    await waitFor(() => events.some((e) => e.kind === "turn.end"), "turn.end after reject");
    expect(existsSync(path.join(cwd, "denied.txt"))).toBe(false);
  }, 180_000);

  it("允许后工具真正执行,文件落盘", async () => {
    const events: AgentEventBody[] = [];
    session = await startClaudeSession(events, ["Bash"]);
    await session.send(
      "Create a file named approved.txt containing exactly the word PROSPERO in the current directory.",
    );

    await waitFor(
      () => events.some((e) => e.kind === "permission.request"),
      "permission.request",
    );
    const req = events.find(
      (e): e is Extract<AgentEventBody, { kind: "permission.request" }> =>
        e.kind === "permission.request",
    )!;
    await session.respondPermission(req.reqId, "once");

    await waitFor(
      () => events.some((e) => e.kind === "tool.end" && e.state === "success"),
      "tool.end(success)",
    );
    await waitFor(() => events.some((e) => e.kind === "turn.end"), "turn.end");
    expect(readFileSync(path.join(cwd, "approved.txt"), "utf8")).toContain("PROSPERO");
  }, 180_000);
});
