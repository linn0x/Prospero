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

    const snapshot = await cli(server.controlSocket.path, server.controlSocket.tokenPath, ["status"]) as {
      runs: Record<string, unknown>;
      tasks: Record<string, unknown>;
    };
    expect(snapshot.runs[run.id]).toBeDefined();
    expect(snapshot.tasks[task.id]).toBeDefined();

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
