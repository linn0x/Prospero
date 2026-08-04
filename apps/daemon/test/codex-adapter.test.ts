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
