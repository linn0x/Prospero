import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";

const exec = promisify(execFile);
const homes: string[] = [];
const servers: DaemonServer[] = [];

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
  const bin = path.resolve("bin/prospero");
  const { stdout } = await exec(bin, [
    "--socket", socket,
    "--token-file", tokenFile,
    ...(session ? ["--session", session] : []),
    ...args,
  ], {
    cwd: path.resolve(".."),
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
