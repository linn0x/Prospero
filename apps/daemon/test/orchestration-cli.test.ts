import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { startControlSocket, type ControlSocketServer } from "../src/control-socket.js";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";

const exec = promisify(execFile);
const homes: string[] = [];
const servers: Array<DaemonServer | ControlSocketServer> = [];
const prosperoBin = process.platform === "win32"
  ? process.execPath
  : path.resolve("bin/prospero");
const prosperoPrefix = process.platform === "win32"
  ? [path.resolve("dist/orchestration-cli.js")]
  : [];

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-orchestration-cli-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function cli(
  socket: string,
  tokenFile: string,
  args: string[],
  session?: string,
): Promise<unknown> {
  const { stdout } = await exec(prosperoBin, [
    ...prosperoPrefix,
    "--socket", socket,
    "--token-file", tokenFile,
    ...(session ? ["--session", session] : []),
    ...args,
  ], {
    cwd: path.resolve(".."),
    // 测试本身可能正跑在 Prospero agent 会话里；未显式传 session 时不能继承
    // 外层协调者 ID，否则手工 Run 会被误判成协调者 Run。
    env: {
      ...process.env,
      PROSPERO_SESSION_ID: session ?? "",
      PATH: [path.dirname(process.execPath), process.env["PATH"] ?? ""].join(path.delimiter),
    },
  });
  return JSON.parse(stdout) as unknown;
}

describe("会话内 prospero CLI", () => {
  it("通过 daemon 的私有 socket 创建 Run/Task，并在关闭后清理 socket 凭证", async () => {
    const home = tempHome();
    const server = await createDaemonServer({ home, port: 0 });
    servers.push(server);

    const run = await cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "run", "create", "--objective", "把 M2 跑通",
    ]) as { id: string; coordinatorSessionId: string | null };
    expect(run.coordinatorSessionId).toBeNull();

    const task = await cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "task", "create", "--run", run.id, "--title", "验证", "--spec", "写一条测试",
    ]) as { id: string; runId: string };
    expect(task.runId).toBe(run.id);

    const compact = await cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "status", "--run", run.id,
    ]) as {
      run: { id: string };
      taskCounts: { pending: number; ready: number };
      readyTasks: Array<{ id: string }>;
    };
    expect(compact.run.id).toBe(run.id);
    expect(compact.taskCounts).toMatchObject({ pending: 1, ready: 1 });
    expect(compact.readyTasks).toEqual([expect.objectContaining({ id: task.id })]);
    expect(JSON.stringify(compact)).not.toContain("写一条测试");

    const raw = await cli(server.controlSocket.path, server.controlSocket.tokenPath, ["status", "--json"]) as {
      runs: Record<string, unknown>;
      tasks: Record<string, { spec: string }>;
    };
    expect(raw.runs[run.id]).toBeDefined();
    expect(raw.tasks[task.id]?.spec).toBe("写一条测试");

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(existsSync(path.join(home, "control.sock"))).toBe(false);
    expect(existsSync(path.join(home, "control.token"))).toBe(false);
  });

  it("check --wait 与 ask/reply 都在 daemon 内等待，不需要 agent 轮询", async () => {
    const home = tempHome();
    const server = await createDaemonServer({ home, port: 0 });
    servers.push(server);
    const run = await cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "run", "create", "--objective", "协作",
    ], "coord") as { id: string };

    const checking = cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "check", "--run", run.id, "--wait",
    ], "coord");
    const sent = await cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "send", "--run", run.id, "--to", "coord", "--type", "report",
      "--subject", "完成", "--body", "已验证",
    ], "worker") as { id: string };
    const inbox = await checking as Array<{ id: string; type: string }>;
    expect(inbox).toEqual([expect.objectContaining({ id: sent.id, type: "report" })]);

    const asking = cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "ask", "--run", run.id, "--to", "coord", "--subject", "方案", "--body", "选 A 还是 B？",
    ], "worker");
    const ask = await waitForAsk(server, run.id);
    const reply = await cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "reply", "--run", run.id, "--to", "worker", "--thread", ask.threadId,
      "--subject", "选择", "--body", "选 B",
    ], "coord") as { id: string };
    await expect(asking).resolves.toMatchObject({
      ask: { id: ask.id },
      reply: { id: reply.id, body: "选 B" },
    });
  });

  it("worker.start 只在调用方给出时转发 operationId", async () => {
    const control = await startControlSocket({
      home: tempHome(),
      token: "secret",
      handle: (method, params) => ({ method, params }),
    });
    servers.push(control);

    const withOperationId = await cli(control.path, control.tokenPath, [
      "worker", "start", "--task", "task-1", "--agent", "codex", "--operation-id", "start-attempt-1",
    ], "coord") as { method: string; params: Record<string, unknown> };
    expect(withOperationId).toMatchObject({
      method: "worker.start",
      params: { taskId: "task-1", operationId: "start-attempt-1", actorSessionId: "coord" },
    });

    const withoutOperationId = await cli(control.path, control.tokenPath, [
      "worker", "start", "--task", "task-2", "--agent", "codex",
    ], "coord") as { params: Record<string, unknown> };
    expect(withoutOperationId.params).not.toHaveProperty("operationId");
  });

  it("status 按当前会话优先选择 active Run，并支持 --all 与空态提示", async () => {
    const home = tempHome();
    const server = await createDaemonServer({ home, port: 0 });
    servers.push(server);

    const history = await cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "run", "create", "--objective", "历史 Run",
    ], "coord") as { id: string };
    await cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "run", "complete", "--id", history.id,
    ], "coord");
    const active = await cli(server.controlSocket.path, server.controlSocket.tokenPath, [
      "run", "create", "--objective", "当前 Run",
    ], "coord") as { id: string };

    const selected = await cli(server.controlSocket.path, server.controlSocket.tokenPath, ["status"], "coord") as {
      run: { id: string; status: string };
    };
    expect(selected.run).toMatchObject({ id: active.id, status: "active" });

    const all = await cli(server.controlSocket.path, server.controlSocket.tokenPath, ["status", "--all"], "coord") as {
      runs: Array<{ id: string }>;
    };
    expect(all.runs.map((run) => run.id)).toEqual(expect.arrayContaining([history.id, active.id]));

    const empty = await cli(server.controlSocket.path, server.controlSocket.tokenPath, ["status"], "other") as {
      run: null;
      hint: string;
      nextActions: Array<{ command: string }>;
    };
    expect(empty).toMatchObject({ run: null });
    expect(empty.hint).toContain("没有关联 Run");
    expect(empty.nextActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "prospero status --all" }),
    ]));
  });

  it("task 恢复命令和 worker.stop 转发 reason、operationId 与当前会话", async () => {
    const control = await startControlSocket({
      home: tempHome(),
      token: "secret",
      handle: (method, params) => ({ method, params }),
    });
    servers.push(control);

    const retry = await cli(control.path, control.tokenPath, [
      "task", "retry", "--id", "task-failed", "--operation-id", "retry-1",
    ], "coord") as { method: string; params: Record<string, unknown> };
    expect(retry).toMatchObject({
      method: "task.retry",
      params: { taskId: "task-failed", operationId: "retry-1", actorSessionId: "coord" },
    });

    const cancel = await cli(control.path, control.tokenPath, [
      "task", "cancel", "--id", "task-pending", "--reason", "范围变更", "--operation-id", "cancel-1",
    ], "coord") as { method: string; params: Record<string, unknown> };
    expect(cancel).toMatchObject({
      method: "task.cancel",
      params: {
        taskId: "task-pending", reason: "范围变更", operationId: "cancel-1", actorSessionId: "coord",
      },
    });

    const stop = await cli(control.path, control.tokenPath, [
      "worker", "stop", "--task", "task-running", "--reason", "人工接管", "--operation-id", "stop-1",
    ], "coord") as { method: string; params: Record<string, unknown> };
    expect(stop).toMatchObject({
      method: "worker.stop",
      params: {
        taskId: "task-running", reason: "人工接管", operationId: "stop-1", actorSessionId: "coord",
      },
    });
  });
});

async function waitForAsk(server: DaemonServer, runId: string): Promise<{ id: string; threadId: string }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ask = server.orchestration.store.listMessages(runId).find((message) => message.type === "ask");
    if (ask?.threadId) return { id: ask.id, threadId: ask.threadId };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("ask was not persisted");
}
