import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  controlSocketPath,
  controlRequest,
  ControlSocketError,
  startControlSocket,
  type ControlSocketServer,
} from "../src/control-socket.js";

const homes: string[] = [];
const servers: ControlSocketServer[] = [];

function home(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-control-"));
  homes.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("control socket", () => {
  it("uses a Windows named pipe path on Windows", () => {
    const socket = controlSocketPath("C:\\Users\\test\\.prospero");
    if (process.platform === "win32") expect(socket).toMatch(/^\\\\\.\\pipe\\prospero-/);
    else expect(socket).toBe(path.join("C:\\Users\\test\\.prospero", "control.sock"));
  });

  it("以 NDJSON 路由请求、检查 token，并把 token/socket 写成私有文件", async () => {
    const server = await startControlSocket({
      home: home(),
      token: "secret",
      handle: (method, params) => ({ method, params }),
    });
    servers.push(server);

    const result = await controlRequest<{ method: string; params: { hello: string } }>(
      { socketPath: server.path, token: "secret" },
      "echo",
      { hello: "world" },
    );
    expect(result).toEqual({ method: "echo", params: { hello: "world" } });
    if (process.platform !== "win32") {
      expect(statSync(server.path).mode & 0o777).toBe(0o600);
      expect(statSync(server.tokenPath).mode & 0o777).toBe(0o600);
    } else {
      expect(readFileSync(server.tokenPath, "utf8")).toBe("secret\n");
    }

    await expect(
      controlRequest({ socketPath: server.path, token: "wrong" }, "echo"),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("坏 JSON 只返回错误，不会拖垮之后的请求", async () => {
    const server = await startControlSocket({
      home: home(),
      token: "secret",
      handle: () => "ok",
    });
    servers.push(server);

    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(server.path);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write("{not json}\n"));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.includes("\n")) {
          socket.destroy();
          resolve(buffer.trim());
        }
      });
      socket.once("error", reject);
    });
    expect(JSON.parse(response)).toMatchObject({ ok: false, error: { code: "bad_request" } });
    await expect(controlRequest({ socketPath: server.path, token: "secret" }, "health"))
      .resolves.toBe("ok");
  });

  it("client 把服务端的领域错误保留为可读错误码", async () => {
    const server = await startControlSocket({
      home: home(),
      token: "secret",
      handle: () => {
        throw new ControlSocketError("不能派发", "task_not_ready");
      },
    });
    servers.push(server);
    await expect(controlRequest({ socketPath: server.path, token: "secret" }, "worker.start"))
      .rejects.toMatchObject({ code: "task_not_ready", message: "不能派发" });
  });

  it("不会把同名普通文件当作陈旧 socket 删除", async () => {
    const dir = home();
    const occupied = path.join(dir, "control.sock");
    writeFileSync(occupied, "do not remove");
    await expect(startControlSocket({ home: dir, token: "secret", handle: () => null }))
      .rejects.toMatchObject({ code: "socket_path_occupied" });
    expect(readFileSync(occupied, "utf8")).toBe("do not remove");
  });
});
