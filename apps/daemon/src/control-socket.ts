/**
 * 面向本机 agent 的控制 socket。
 *
 * 手机上的 WebSocket 需要完整的 E2E 握手；同一台机器里的 worker 只需要一个
 * 小而明确的 RPC 边界。这里使用 Unix domain socket + NDJSON：每个请求一行、
 * 每个响应一行，连接可以短暂也可以复用。socket 与 token 文件都只允许当前用户读写。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import path from "node:path";

const MAX_LINE_BYTES = 1024 * 1024;

/** 普通本地控制 RPC 的默认上限；长操作必须由调用方显式覆盖。 */
export const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 15_000;

export type ControlRequestId = string | number;

export interface ControlRequest {
  id: ControlRequestId;
  method: string;
  params?: unknown;
  token?: string;
}

export interface ControlResponse {
  id: ControlRequestId | null;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export class ControlSocketError extends Error {
  constructor(
    message: string,
    readonly code: string = "control_error",
  ) {
    super(message);
  }
}

export interface ControlSocketOptions {
  home: string;
  token: string;
  /** signal 会在 client 断开时触发，用于取消 check --wait / ask 等长请求。 */
  handle(method: string, params: unknown, signal: AbortSignal): Promise<unknown> | unknown;
}

export interface ControlSocketServer {
  readonly path: string;
  readonly tokenPath: string;
  close(): Promise<void>;
}

export function controlSocketPath(home: string): string {
  if (process.platform !== "win32") return path.join(home, "control.sock");
  const digest = createHash("sha256")
    .update(path.resolve(home).toLowerCase())
    .digest("hex")
    .slice(0, 32);
  return `\\\\.\\pipe\\prospero-${digest}`;
}

function tokenEqual(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requestFrom(value: unknown): ControlRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    (typeof raw["id"] !== "string" && typeof raw["id"] !== "number") ||
    typeof raw["method"] !== "string" ||
    raw["method"].trim() === ""
  ) {
    return null;
  }
  return {
    id: raw["id"],
    method: raw["method"],
    ...(raw["params"] !== undefined ? { params: raw["params"] } : {}),
    ...(typeof raw["token"] === "string" ? { token: raw["token"] } : {}),
  };
}

function write(socket: Socket, response: ControlResponse): void {
  // `close` 与异步 write 之间存在竞争：短命 CLI 已经离开时，下一次写入
  // 会在 Socket 上发出 EPIPE。它只表示调用方不再需要响应，绝不能带崩 daemon。
  if (socket.destroyed || !socket.writable) return;
  try {
    socket.write(`${JSON.stringify(response)}\n`);
  } catch {
    // Node 也可能在 destroyed 状态刚变化时同步抛错；同样按断开处理。
  }
}

/** 启动 socket，并同步写下给 CLI 读取的 0600 token 文件。 */
export async function startControlSocket(opts: ControlSocketOptions): Promise<ControlSocketServer> {
  mkdirSync(opts.home, { recursive: true, mode: 0o700 });
  chmodSync(opts.home, 0o700);
  const socketPath = controlSocketPath(opts.home);
  const legacySocketPath = path.join(opts.home, "control.sock");
  const tokenPath = path.join(opts.home, "control.token");

  // Unix socket 不能复用旧路径；daemon 异常退出时留下的是 socket 文件。若路径
  // 被普通文件占住，宁可报错也不覆盖同目录中可能由用户放进去的内容。
  if (process.platform === "win32") {
    try {
      if (!lstatSync(legacySocketPath).isSocket()) {
        throw new ControlSocketError(`${legacySocketPath} 已被非 socket 文件占用`, "socket_path_occupied");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } else {
    try {
      if (!lstatSync(socketPath).isSocket()) {
        throw new ControlSocketError(`${socketPath} 已被非 socket 文件占用`, "socket_path_occupied");
      }
      rmSync(socketPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  writeFileSync(tokenPath, `${opts.token}\n`, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);

  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    // write() 的 EPIPE 是异步从 Socket 发出的，try/catch 接不住。每条本地
    // client 连接都必须消费它；close 回调会清理 clients，并会中止长请求。
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    let closedForSize = false;

    socket.on("data", (chunk: string) => {
      if (closedForSize) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
        closedForSize = true;
        write(socket, {
          id: null,
          ok: false,
          error: { code: "request_too_large", message: "控制请求过大" },
        });
        socket.end();
        return;
      }

      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line === "") continue;
        void handleLine(socket, line, opts);
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    rmSync(tokenPath, { force: true });
    throw error;
  }
  if (process.platform !== "win32") chmodSync(socketPath, 0o600);

  return {
    path: socketPath,
    tokenPath,
    close: async () => {
      // 一个半写请求的本地 client 不能让 daemon 关机永远卡在 server.close()。
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") rmSync(socketPath, { force: true });
      rmSync(tokenPath, { force: true });
    },
  };
}

async function handleLine(socket: Socket, line: string, opts: ControlSocketOptions): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    write(socket, {
      id: null,
      ok: false,
      error: { code: "bad_request", message: "控制请求不是有效 JSON" },
    });
    return;
  }
  const request = requestFrom(parsed);
  if (!request) {
    write(socket, {
      id: null,
      ok: false,
      error: { code: "bad_request", message: "控制请求缺少 id 或 method" },
    });
    return;
  }
  if (!tokenEqual(opts.token, request.token)) {
    write(socket, {
      id: request.id,
      ok: false,
      error: { code: "unauthorized", message: "控制口令无效" },
    });
    return;
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  socket.once("close", abort);
  try {
    const result = await opts.handle(request.method, request.params, controller.signal);
    write(socket, { id: request.id, ok: true, result });
  } catch (error) {
    const known = error instanceof ControlSocketError;
    write(socket, {
      id: request.id,
      ok: false,
      error: {
        code: known ? error.code : "internal_error",
        message: known ? error.message : "控制请求执行失败",
      },
    });
  } finally {
    socket.off("close", abort);
  }
}

export interface ControlClientOptions {
  socketPath: string;
  token: string;
  timeoutMs?: number;
}

/** CLI 使用的单请求 client。保持短连接能让 worker 退出时没有悬挂句柄。 */
export async function controlRequest<T>(
  opts: ControlClientOptions,
  method: string,
  params?: unknown,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(opts.socketPath);
    let buffer = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      fn();
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(() => reject(new ControlSocketError("等待 daemon 控制响应超时", "timeout")));
      }, timeoutMs);
      timer.unref?.();
    }

    socket.setEncoding("utf8");
    socket.once("connect", () => {
      const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      socket.write(
        `${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }), token: opts.token })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const response = JSON.parse(line) as ControlResponse;
        if (response.ok) finish(() => resolve(response.result as T));
        else {
          const detail = response.error ?? { code: "control_error", message: "控制请求失败" };
          finish(() => reject(new ControlSocketError(detail.message, detail.code)));
        }
      } catch {
        finish(() => reject(new ControlSocketError("daemon 返回了无效控制响应", "bad_response")));
      }
    });
    socket.once("error", (error) => {
      finish(() => reject(new ControlSocketError(error.message, "connection_failed")));
    });
  });
}
