/**
 * WebSocket 服务:E2E 握手鉴权 → 消息路由 → 会话流转发(含背压)。
 * --dev 模式额外提供浏览器调试页(仅 loopback 可用明文协议)。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  fromB64,
  parseC2S,
  serverAcceptHandshake,
  toB64,
  utf8Decode,
  type C2SMessage,
  type S2CMessage,
  type SecureChannel,
} from "@prospero/protocol";
import { authenticate, loadIdentity, type DeviceRecord } from "./pairing.js";
import { SessionError, SessionManager } from "./session-manager.js";
import type { PtySession } from "./pty-session.js";

const DAEMON_VERSION = "0.0.1";
const HIGH_WATER = 512 * 1024; // 超过则暂停向该客户端流式发送
const LOW_WATER = 64 * 1024; //   低于则通过 ring/快照追平
const CATCHUP_MS = 250;
const PING_MS = 15_000;

interface AttachState {
  lastSentSeq: number;
  lastAckSeq: number;
  paused: boolean;
  snapshotInflight?: boolean;
}

interface Conn {
  ws: WebSocket;
  /** null = dev 明文连接(仅 --dev + loopback) */
  channel: SecureChannel | null;
  device: DeviceRecord | null;
  attachments: Map<string, AttachState>;
  alive: boolean;
}

export interface DaemonServerOptions {
  home: string;
  port: number;
  devMode?: boolean;
  hostName?: string | undefined;
}

export interface DaemonServer {
  port: number;
  httpServer: Server;
  manager: SessionManager;
  close(): Promise<void>;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

export async function createDaemonServer(
  opts: DaemonServerOptions,
): Promise<DaemonServer> {
  const identity = loadIdentity(opts.home);
  const manager = new SessionManager();
  const conns = new Set<Conn>();
  const devMode = opts.devMode ?? false;

  const httpServer = createServer((req, res) => handleHttp(req, res));
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  function send(conn: Conn, msg: S2CMessage): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ws.send(conn.channel ? conn.channel.seal(msg) : JSON.stringify(msg));
  }

  manager.on("output", (sid, dataB64, seq) => {
    for (const conn of conns) {
      if (!conn.device) continue;
      const att = conn.attachments.get(sid);
      if (!att || att.paused) continue;
      if (conn.ws.bufferedAmount > HIGH_WATER) {
        att.paused = true; // 慢客户端:停流,交给 catchup 定时器追平
        continue;
      }
      send(conn, { type: "term.output", sid, dataB64, seq });
      att.lastSentSeq = seq;
    }
  });

  manager.on("state", (session) => {
    for (const conn of conns) {
      if (conn.device) send(conn, { type: "session.state", session });
    }
  });

  /** 用快照把某个 attachment 拉到最新(attach 全量 / 背压追平 / gap 淘汰共用) */
  async function sendSnapshot(conn: Conn, sid: string, session: PtySession, att: AttachState): Promise<void> {
    if (att.snapshotInflight) return;
    att.snapshotInflight = true;
    att.paused = true; // 快照生成期间挡住流式输出,避免乱序
    try {
      const snap = await session.snapshot();
      send(conn, {
        type: "term.snapshot",
        sid,
        ansi: snap.ansi,
        seq: snap.seq,
        cols: snap.cols,
        rows: snap.rows,
      });
      att.lastSentSeq = snap.seq;
      att.paused = false;
    } finally {
      att.snapshotInflight = false;
    }
  }

  const catchupTimer = setInterval(() => {
    for (const conn of conns) {
      for (const [sid, att] of conn.attachments) {
        if (!att.paused || conn.ws.bufferedAmount > LOW_WATER) continue;
        const session = manager.get(sid);
        if (!session) {
          conn.attachments.delete(sid);
          continue;
        }
        const chunks = session.ring.since(att.lastSentSeq);
        if (chunks === null) {
          void sendSnapshot(conn, sid, session, att);
        } else {
          if (chunks.length > 0) {
            send(conn, {
              type: "term.output",
              sid,
              dataB64: toB64(concatBytes(chunks)),
              seq: session.ring.lastSeq,
            });
          }
          att.lastSentSeq = session.ring.lastSeq;
          att.paused = false;
        }
      }
    }
  }, CATCHUP_MS);

  const pingTimer = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }, PING_MS);

  function sendHelloOk(conn: Conn): void {
    send(conn, {
      type: "hello.ok",
      host: {
        name: opts.hostName ?? os.hostname(),
        daemonVersion: DAEMON_VERSION,
        protocolVersion: PROTOCOL_VERSION,
      },
      sessions: manager.list(),
    });
  }

  function handleHello(conn: Conn, text: string, req: IncomingMessage): void {
    if (devMode && isLoopback(req)) {
      let plain: unknown = null;
      try {
        plain = JSON.parse(text);
      } catch {
        // 不是明文 JSON,走加密握手
      }
      if (
        plain !== null &&
        typeof plain === "object" &&
        (plain as { type?: unknown }).type === "hello"
      ) {
        conn.channel = null;
        conn.device = {
          name: "dev-local",
          token: "dev",
          allowShell: true,
          createdAt: Date.now(),
        };
        console.log("[prosperod] dev 明文连接(loopback)");
        sendHelloOk(conn);
        return;
      }
    }
    const { hello, channel } = serverAcceptHandshake(text, identity.secretKey);
    const device = authenticate(opts.home, hello);
    if (!device) {
      conn.channel = channel;
      send(conn, {
        type: "error",
        code: "auth_failed",
        message: "invalid token, or device key changed",
      });
      conn.channel = null;
      conn.ws.close(4001, "auth failed");
      return;
    }
    conn.channel = channel;
    conn.device = device;
    console.log(`[prosperod] 设备已连接: ${device.name}`);
    sendHelloOk(conn);
  }

  async function route(conn: Conn, msg: C2SMessage): Promise<void> {
    const device = conn.device;
    if (!device) return;
    switch (msg.type) {
      case "hello":
        send(conn, { type: "error", code: "bad_message", message: "already authenticated" });
        return;
      case "session.create": {
        const session = manager.create({
          agent: msg.agent,
          cwd: msg.cwd,
          command: msg.command,
          cols: msg.cols,
          rows: msg.rows,
          allowShell: device.allowShell,
        });
        // 创建者自动 attach(空画面快照,锚定 seq 基线)
        const att: AttachState = { lastSentSeq: 0, lastAckSeq: 0, paused: false };
        conn.attachments.set(session.id, att);
        await sendSnapshot(conn, session.id, session, att);
        return;
      }
      case "session.attach": {
        const session = manager.require(msg.sid);
        const att: AttachState = {
          lastSentSeq: msg.lastSeq ?? 0,
          lastAckSeq: msg.lastSeq ?? 0,
          paused: false,
        };
        conn.attachments.set(msg.sid, att);
        if (msg.lastSeq !== undefined) {
          const chunks = session.ring.since(msg.lastSeq);
          if (chunks !== null) {
            // gap 可补:增量续传(同步路径,无 await,不会与流式输出乱序)
            if (chunks.length > 0) {
              send(conn, {
                type: "term.output",
                sid: msg.sid,
                dataB64: toB64(concatBytes(chunks)),
                seq: session.ring.lastSeq,
              });
            }
            att.lastSentSeq = session.ring.lastSeq;
            return;
          }
        }
        await sendSnapshot(conn, msg.sid, session, att);
        return;
      }
      case "term.input":
        manager.require(msg.sid).writeInput(utf8Decode(fromB64(msg.dataB64)));
        return;
      case "term.resize":
        manager.require(msg.sid).resize(msg.cols, msg.rows);
        return;
      case "term.ack": {
        const att = conn.attachments.get(msg.sid);
        if (att) att.lastAckSeq = msg.seq;
        return;
      }
      case "session.interrupt":
        manager.require(msg.sid).interrupt();
        return;
      case "session.kill":
        manager.kill(msg.sid);
        return;
      case "permission.respond":
        return; // M2 结构化轨
    }
  }

  async function onMessage(conn: Conn, raw: RawData, req: IncomingMessage): Promise<void> {
    const text = rawToString(raw);
    try {
      if (conn.device === null) {
        handleHello(conn, text, req);
        return;
      }
      const msg = conn.channel
        ? parseC2S(conn.channel.open(text))
        : parseC2S(JSON.parse(text));
      await route(conn, msg);
    } catch (e) {
      if (conn.device === null) {
        // 握手阶段的任何失败直接断开(无法安全回话)
        conn.ws.close(4003, e instanceof ProtocolError ? e.code : "handshake error");
        return;
      }
      if (e instanceof ProtocolError && e.code === "crypto") {
        conn.ws.close(4003, "crypto"); // 计数器错位/篡改,通道不可信
        return;
      }
      if (e instanceof ProtocolError) {
        send(conn, { type: "error", code: "bad_message", message: e.message });
        return;
      }
      if (e instanceof SessionError) {
        send(conn, { type: "error", code: e.code, message: e.message });
        return;
      }
      console.error("[prosperod] internal error:", e);
      send(conn, { type: "error", code: "bad_message", message: "internal error" });
    }
  }

  wss.on("connection", (ws, req) => {
    const conn: Conn = {
      ws,
      channel: null,
      device: null,
      attachments: new Map(),
      alive: true,
    };
    conns.add(conn);
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("message", (raw) => {
      void onMessage(conn, raw, req);
    });
    ws.on("close", () => {
      conns.delete(conn);
    });
    ws.on("error", () => {
      // close 事件随后触发
    });
  });

  // ---- dev 静态资源(仅 --dev):调试页 + xterm 资产,先于 App 验证协议 ----
  const req2 = createRequire(import.meta.url);
  const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (!devMode) {
      res.writeHead(404).end("prosperod");
      return;
    }
    try {
      if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(path.join(pkgRoot, "dev-client.html")));
      } else if (req.url === "/assets/xterm.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(readFileSync(req2.resolve("@xterm/xterm")));
      } else if (req.url === "/assets/xterm.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end(
          readFileSync(
            path.join(path.dirname(req2.resolve("@xterm/xterm")), "../css/xterm.css"),
          ),
        );
      } else if (req.url === "/assets/fit.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(readFileSync(req2.resolve("@xterm/addon-fit")));
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, "0.0.0.0", () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;

  return {
    port,
    httpServer,
    manager,
    close: async () => {
      clearInterval(catchupTimer);
      clearInterval(pingTimer);
      for (const conn of conns) conn.ws.terminate();
      wss.close();
      manager.disposeAll();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
