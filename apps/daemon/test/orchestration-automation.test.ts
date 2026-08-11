import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionInfo } from "@prospero/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationService } from "../src/orchestration/automation.js";
import {
  DispatchService,
  type WorkerSessionManager,
} from "../src/orchestration/dispatch.js";
import { OrchestrationStore } from "../src/orchestration/store.js";
import type { CreateSessionInput } from "../src/session-manager.js";

class FakeSessions implements WorkerSessionManager {
  readonly creates: CreateSessionInput[] = [];
  readonly messages: Array<{ sid: string; text: string }> = [];

  async create(input: CreateSessionInput): Promise<SessionInfo> {
    this.creates.push(input);
    return {
      id: `worker-${this.creates.length}`,
      agent: input.agent,
      kind: input.kind ?? "structured",
      title: "worker",
      cwd: input.cwd ?? "/tmp",
      status: "idle",
      createdAt: Date.now(),
      cols: input.cols,
      rows: input.rows,
    };
  }

  async chatSend(sid: string, text: string): Promise<void> {
    this.messages.push({ sid, text });
  }

  requirePty(): { writeInput(text: string): void } {
    return { writeInput: () => {} };
  }

  async kill(): Promise<void> {}
}

const roots: string[] = [];
function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "prospero-auto-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function graph(): {
  store: OrchestrationStore;
  dispatch: DispatchService;
  automation: AutomationService;
  sessions: FakeSessions;
  runId: string;
  firstId: string;
  secondId: string;
} {
  const store = new OrchestrationStore();
  const created = store.createRunGraph({
    objective: "自动完成依赖链",
    nodes: [
      { clientId: "first", title: "第一步", spec: "完成第一步", deps: [] },
      { clientId: "second", title: "第二步", spec: "使用第一步成果", deps: ["first"] },
    ],
  });
  const sessions = new FakeSessions();
  const dispatch = new DispatchService(store, sessions);
  return {
    store,
    dispatch,
    automation: new AutomationService(store, dispatch),
    sessions,
    runId: created.run.id,
    firstId: created.idMap["first"]!,
    secondId: created.idMap["second"]!,
  };
}

describe("静态 DAG 自动执行", () => {
  it("只在 worker 显式交付后派下游，全部完成后关闭 Run", async () => {
    const ctx = graph();
    const cwd = temporaryRoot();
    await ctx.automation.start({
      runId: ctx.runId,
      agent: "codex",
      approvalPolicy: "standard",
      workspace: "current",
      cwd,
    });

    expect(ctx.store.getTask(ctx.firstId).status).toBe("dispatched");
    expect(ctx.store.getTask(ctx.secondId).status).toBe("pending");
    expect(ctx.sessions.creates).toHaveLength(1);

    // 仅再次 tick 不等于完成，不能凭 session idle 猜结果。
    await ctx.automation.advance(ctx.runId);
    expect(ctx.sessions.creates).toHaveLength(1);

    ctx.dispatch.completeTask(ctx.firstId, "worker-1", "第一步已验收");
    await ctx.automation.advance(ctx.runId);
    expect(ctx.store.getTask(ctx.secondId).status).toBe("dispatched");
    expect(ctx.sessions.creates).toHaveLength(2);

    ctx.dispatch.completeTask(ctx.secondId, "worker-2", "全部完成");
    await ctx.automation.advance(ctx.runId);
    expect(ctx.store.getRun(ctx.runId)).toMatchObject({
      status: "completed",
      automation: { state: "completed", lastError: null },
    });
  });

  it("暂停只阻止后续派发，恢复后从下一个 ready 节点继续", async () => {
    const ctx = graph();
    const cwd = temporaryRoot();
    const input = {
      runId: ctx.runId,
      agent: "claude" as const,
      approvalPolicy: "strict" as const,
      workspace: "current" as const,
      cwd,
    };
    await ctx.automation.start(input);
    ctx.automation.pause(ctx.runId);
    ctx.dispatch.completeTask(ctx.firstId, "worker-1", "完成");
    await ctx.automation.advance(ctx.runId);
    expect(ctx.sessions.creates).toHaveLength(1);
    expect(ctx.store.getTask(ctx.secondId).status).toBe("pending");

    await ctx.automation.start(input);
    expect(ctx.sessions.creates).toHaveLength(2);
    expect(ctx.sessions.creates[1]).toMatchObject({ agent: "claude", cwd: realpathSync(cwd) });
  });

  it("默认可为整张 Run 创建一个共享隔离 worktree", async () => {
    const ctx = graph();
    const root = temporaryRoot();
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "prospero@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Prospero Test"], { cwd: repo });
    writeFileSync(path.join(repo, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repo });

    await ctx.automation.start({
      runId: ctx.runId,
      agent: "codex",
      approvalPolicy: "standard",
      workspace: "run",
      cwd: repo,
    });

    const config = ctx.store.getRun(ctx.runId).automation!;
    expect(config.workspacePath).not.toBe(repo);
    expect(config.branch).toMatch(new RegExp(`^prospero/${ctx.runId}/auto-`));
    expect(ctx.sessions.creates[0]?.cwd).toBe(config.workspacePath);
    expect(
      execFileSync("git", ["branch", "--show-current"], { cwd: config.workspacePath, encoding: "utf8" }).trim(),
    ).toBe(config.branch);
  });
});
