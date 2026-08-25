import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/session-manager.js";

const homes: string[] = [];

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "p-usage-sel-"));
  homes.push(value);
  return value;
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/// 选中的会话要用来查额度,而收工的会话其 supervisor 早已断开 —— 挑中它,
/// 那次 usage.get 就会抛 supervisor_unavailable,一路掉进 ws-server 的兜底分支,
/// 手机上看到的是 "bad_message: internal error"。这条选择规则是那条链的源头。
interface Seam {
  structuredSessions: Map<string, {
    id: string;
    agent: string;
    accountId?: string;
    info(): { status: string };
  }>;
}

function fake(id: string, agent: string, status: string, accountId?: string) {
  return { id, agent, ...(accountId ? { accountId } : {}), info: () => ({ status }) };
}

describe("查额度时挑哪个会话", () => {
  it("同一账号下,活着的会话优先于已收工的", () => {
    const manager = new SessionManager({ home: home() });
    const seam = manager as unknown as Seam;
    // 编排跑完之后的典型现场:一堆 done 的 worker 会话排在活跃会话后面。
    seam.structuredSessions.set("live", fake("live", "codex", "idle"));
    seam.structuredSessions.set("worker-done", fake("worker-done", "codex", "done"));
    seam.structuredSessions.set("worker-died", fake("worker-died", "codex", "died"));

    expect(manager.structuredPerAgent().map((s) => s.id)).toEqual(["live"]);
  });

  it("全都收工时仍要给出一个,不能把账号整个丢掉", () => {
    const manager = new SessionManager({ home: home() });
    const seam = manager as unknown as Seam;
    seam.structuredSessions.set("a", fake("a", "codex", "done"));
    seam.structuredSessions.set("b", fake("b", "codex", "died"));

    expect(manager.structuredPerAgent()).toHaveLength(1);
  });

  it("不同账号各自挑各自的", () => {
    const manager = new SessionManager({ home: home() });
    const seam = manager as unknown as Seam;
    seam.structuredSessions.set("x-done", fake("x-done", "codex", "done", "acct-x"));
    seam.structuredSessions.set("y-live", fake("y-live", "codex", "running", "acct-y"));
    seam.structuredSessions.set("x-live", fake("x-live", "codex", "running", "acct-x"));

    expect(manager.structuredPerAgent().map((s) => s.id).sort()).toEqual(["x-live", "y-live"]);
  });
});
