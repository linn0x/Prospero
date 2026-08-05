/**
 * WebSocket 服务:E2E 握手鉴权 → 消息路由 → 会话流转发(含背压)。
 * --dev 模式额外提供浏览器调试页(仅 loopback 可用明文协议)。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, watch } from "node:fs";
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
  CLOSE_AUTH_FAILED,
  CLOSE_PROTOCOL,
  CLOSE_REVOKED,
  serverHandshakeAccept,
  serverHandshakeRespond,
  type ServerHandshakeState,
  toB64,
  utf8Decode,
  type C2SMessage,
  type S2CMessage,
  type SecureChannel,
  type SessionInfo,
} from "@prospero/protocol";
import { authenticate, loadDevices, loadIdentity, type DeviceRecord } from "./pairing.js";
import { Notifier, type NotifyConfig } from "./notify.js";
import { SessionError, SessionManager } from "./session-manager.js";
import { StatusFile } from "./status-file.js";
import {
  FsError,
  listDir,
  makeDir,
  readChunk,
  readForEdit,
  removeEntry,
  renameEntry,
  writeChunk,
  writeFileAt,
} from "./fs-ops.js";
import * as gitOps from "./git-ops.js";
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

/** 结构化会话的订阅状态:只需记录已下发到哪个 evSeq */
interface ChatAttachState {
  lastEvSeq: number;
}

interface Conn {
  ws: WebSocket;
  /** null = dev 明文连接(仅 --dev + loopback) */
  channel: SecureChannel | null;
  /** 握手中间态:已回过临时公钥、还在等 hello。收到 hello 后清空 */
  handshake: ServerHandshakeState | null;
  device: DeviceRecord | null;
  attachments: Map<string, AttachState>;
  chatAttachments: Map<string, ChatAttachState>;
  alive: boolean;
}

export interface DaemonServerOptions {
  home: string;
  port: number;
  /** 监听地址;省略 = 0.0.0.0(全部网卡) */
  bindAddr?: string | undefined;
  /** tmux 托管:会话进程活过 daemon 重启 */
  useTmux?: boolean | undefined;
  devMode?: boolean;
  hostName?: string | undefined;
  /** 推送通道配置;省略则不推送 */
  notify?: NotifyConfig | null;
}

export interface DaemonServer {
  port: number;
  /** --dev 的一次性明文口令(仅 devMode 有意义) */
  devToken: string;
  /** 本次启动从 tmux 接管回来的会话数 */
  restoredSessions: number;
  httpServer: Server;
  manager: SessionManager;
  notifier: Notifier;
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
  // --dev 的一次性口令:每次启动重新生成,只存在内存里,只打印到启动它的终端。
  // 这样"能看到终端输出"就成了使用明文通道的前提,而不是"恰好在本机跑着"。
  const devToken = randomBytes(18).toString("base64url");
  const devTokenEqual = (supplied: string): boolean => {
    const a = Buffer.from(supplied);
    const b = Buffer.from(devToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const manager = new SessionManager(opts.useTmux ? { tmux: { home: opts.home } } : {});
  // 菜单栏壳靠这个文件看会话列表(WS 协议要过 E2E 握手,壳没必要实现一遍)
  const statusFile = new StatusFile(opts.home, manager, {
    port: opts.port,
    bind: opts.bindAddr ?? null,
  });
  const conns = new Set<Conn>();
  const devMode = opts.devMode ?? false;
  const notifier = new Notifier(opts.notify ?? null);

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

  manager.on("agentEvent", (sid, body, evSeq) => {
    let delivered = 0;
    for (const conn of conns) {
      const att = conn.chatAttachments.get(sid);
      if (!conn.device || !att) continue;
      send(conn, { type: "agent.event", sid, evSeq, body });
      att.lastEvSeq = evSeq;
      delivered++;
    }
    // 没有客户端在看这个会话(App 被挂起/切走)且需要人决策 → 推到锁屏。
    // 这是 iOS 上唯一能在 App 挂起时把审批送达的路径(WebSocket 已断)。
    if (body.kind === "permission.request" && delivered === 0 && notifier.enabled) {
      const info = safeInfo(sid);
      if (info) {
        void notifier.notifyPermission(sid, info, body.action, body.resources[0] ?? "");
      }
    }
    if (body.kind === "permission.resolved") notifier.clear(sid);
  });

  function safeInfo(sid: string): SessionInfo | null {
    try {
      return manager.infoOf(sid);
    } catch {
      return null; // 会话在事件与查询之间被销毁
    }
  }

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

  /**
   * 结构化会话 attach:能增量续传就发增量,否则全量重放事件历史。
   * 同步路径(事件日志在内存),不会与流式事件乱序。
   */
  function attachChat(conn: Conn, sid: string, lastEvSeq?: number): void {
    const session = manager.requireStructured(sid);
    const incremental = lastEvSeq !== undefined ? session.since(lastEvSeq) : null;
    if (incremental !== null && lastEvSeq !== undefined) {
      conn.chatAttachments.set(sid, { lastEvSeq: session.snapshot().evSeq });
      let seq = lastEvSeq;
      for (const body of incremental) {
        send(conn, { type: "agent.event", sid, evSeq: ++seq, body });
      }
      return;
    }
    const snap = session.snapshot();
    conn.chatAttachments.set(sid, { lastEvSeq: snap.evSeq });
    send(conn, { type: "chat.snapshot", sid, evSeq: snap.evSeq, events: snap.events });
  }

  const catchupTimer = setInterval(() => {
    for (const conn of conns) {
      for (const [sid, att] of conn.attachments) {
        if (!att.paused || conn.ws.bufferedAmount > LOW_WATER) continue;
        const session = manager.getPty(sid);
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
        // 曾经这里不校验任何凭证 —— 于是 --dev 期间本机任意进程(含其他用户)
        // 都能无条件拿到 allowShell 的完整会话。回环来源不是授权,只是位置。
        // 现在要求每次启动新生成的一次性口令,它只打印在启动 daemon 的那个终端里。
        const supplied = (plain as { token?: unknown }).token;
        if (typeof supplied !== "string" || !devTokenEqual(supplied)) {
          console.warn("[prosperod] 拒绝 dev 明文连接:口令不符");
          conn.ws.close(CLOSE_AUTH_FAILED, "dev token required");
          return;
        }
        conn.channel = null;
        conn.device = {
          name: "dev-local",
          token: devToken,
          allowShell: true,
          createdAt: Date.now(),
        };
        console.log("[prosperod] dev 明文连接(loopback,口令已校验)");
        sendHelloOk(conn);
        return;
      }
    }
    // 第 1 帧只有客户端临时公钥;回自己的临时公钥 + 身份证明,等第 2 帧才拿到 hello
    if (conn.handshake === null) {
      const { frame, state } = serverHandshakeRespond(text, identity.secretKey);
      conn.handshake = state;
      conn.ws.send(frame);
      return;
    }
    const { hello, channel } = serverHandshakeAccept(conn.handshake, text);
    conn.handshake = null;
    const device = authenticate(opts.home, hello);
    if (!device) {
      conn.channel = channel;
      send(conn, {
        type: "error",
        code: "auth_failed",
        message: "invalid token, or device key changed",
      });
      conn.channel = null;
      conn.ws.close(CLOSE_AUTH_FAILED, "auth failed");
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
        const info = await manager.create({
          agent: msg.agent,
          kind: msg.kind,
          cwd: msg.cwd,
          command: msg.command,
          cols: msg.cols,
          rows: msg.rows,
          allowShell: device.allowShell,
        });
        // 创建者自动 attach:结构化会话发 chat.snapshot,PTY 发画面快照(锚定 seq 基线)
        if (info.kind === "structured") {
          attachChat(conn, info.id);
          return;
        }
        const session = manager.requirePty(info.id);
        const att: AttachState = { lastSentSeq: 0, lastAckSeq: 0, paused: false };
        conn.attachments.set(info.id, att);
        await sendSnapshot(conn, info.id, session, att);
        return;
      }
      case "session.attach": {
        if (manager.getStructured(msg.sid)) {
          attachChat(conn, msg.sid, msg.lastSeq);
          return;
        }
        const session = manager.requirePty(msg.sid);
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
      case "chat.send":
        await manager.requireStructured(msg.sid).send(msg.text, msg.attachments);
        return;
      case "tool.output.get": {
        const full = manager.requireStructured(msg.sid).toolOutput(msg.callId);
        send(conn, {
          type: "tool.output",
          sid: msg.sid,
          callId: msg.callId,
          output: full?.output ?? "(输出已不可用)",
          ...(full?.truncated === true ? { truncated: true } : {}),
        });
        return;
      }
      case "permission.respond":
        await manager.requireStructured(msg.sid).respondPermission(msg.reqId, msg.reply);
        return;
      case "term.input":
        manager.requirePty(msg.sid).writeInput(utf8Decode(fromB64(msg.dataB64)));
        return;
      case "term.resize":
        manager.requirePty(msg.sid).resize(msg.cols, msg.rows);
        return;
      case "term.ack": {
        const att = conn.attachments.get(msg.sid);
        if (att) att.lastAckSeq = msg.seq;
        return;
      }
      case "session.interrupt":
        await manager.interrupt(msg.sid);
        return;
      case "session.kill":
        await manager.kill(msg.sid);
        return;

      case "approval.policy.set":
        manager.setApprovalPolicy(msg.sid, msg.policy);
        return;

      case "fs.list":
      case "fs.read":
      case "fs.write":
      case "fs.get":
      case "fs.put":
      case "fs.mkdir":
      case "fs.remove":
      case "fs.rename":
        await handleFs(conn, msg);
        return;

      case "git.status":
      case "git.diff":
      case "git.stage":
      case "git.discard":
      case "git.commit":
        await handleGit(conn, msg);
        return;
    }
  }

  /** git 操作。根同样是会话 cwd,路径经 fs-ops 校验后才交给 git。 */
  async function handleGit(
    conn: Conn,
    msg: Extract<C2SMessage, { type: `git.${string}` }>,
  ): Promise<void> {
    const root = manager.cwdOf(msg.sid);
    if (root === null) {
      send(conn, {
        type: "error",
        code: "session_not_found",
        message: `no such session: ${msg.sid}`,
        sid: msg.sid,
      });
      return;
    }
    try {
      switch (msg.type) {
        case "git.status": {
          const st = await gitOps.status(root);
          send(conn, { type: "git.status.result", sid: msg.sid, ...st });
          return;
        }
        case "git.diff": {
          const patch = await gitOps.diff(root, msg.path, msg.staged);
          send(conn, { type: "git.diff.result", sid: msg.sid, path: msg.path, patch });
          return;
        }
        case "git.stage": {
          if (msg.unstage) await gitOps.unstage(root, msg.paths);
          else await gitOps.stage(root, msg.paths);
          send(conn, {
            type: "git.done",
            sid: msg.sid,
            op: msg.unstage ? "unstage" : "stage",
          });
          return;
        }
        case "git.discard": {
          await gitOps.discard(root, msg.path);
          send(conn, { type: "git.done", sid: msg.sid, op: "discard" });
          return;
        }
        case "git.commit": {
          const hash = await gitOps.commit(root, msg.message);
          send(conn, { type: "git.done", sid: msg.sid, op: "commit", detail: hash });
          return;
        }
      }
    } catch (e) {
      const code = e instanceof FsError ? e.code : "io";
      send(conn, {
        type: "error",
        code: code === "denied" ? "denied" : "fs_error",
        message: e instanceof Error ? e.message : String(e),
        sid: msg.sid,
      });
    }
  }

  /**
   * 文件操作。根 = 会话 cwd,越界由 fs-ops 拒绝。
   * 错误统一转成 error 消息而不是断开连接 —— 找不到文件是日常情况,不是协议违规。
   */
  async function handleFs(
    conn: Conn,
    msg: Extract<C2SMessage, { type: `fs.${string}` }>,
  ): Promise<void> {
    const root = manager.cwdOf(msg.sid);
    if (root === null) {
      send(conn, {
        type: "error",
        code: "session_not_found",
        message: `no such session: ${msg.sid}`,
        sid: msg.sid,
      });
      return;
    }
    try {
      switch (msg.type) {
        case "fs.list": {
          const entries = await listDir(root, msg.path);
          send(conn, { type: "fs.listing", sid: msg.sid, path: msg.path, entries });
          return;
        }
        case "fs.read": {
          const r = await readForEdit(root, msg.path);
          send(conn, {
            type: "fs.content",
            sid: msg.sid,
            path: msg.path,
            contentB64: r.content.toString("base64"),
            size: r.size,
            truncated: r.truncated,
            binary: r.binary,
          });
          return;
        }
        case "fs.write": {
          const size = await writeFileAt(root, msg.path, Buffer.from(msg.contentB64, "base64"));
          send(conn, { type: "fs.written", sid: msg.sid, path: msg.path, size });
          return;
        }
        case "fs.get": {
          const c = await readChunk(root, msg.path, msg.offset, msg.length);
          send(conn, {
            type: "fs.chunk",
            sid: msg.sid,
            path: msg.path,
            offset: msg.offset,
            dataB64: c.data.toString("base64"),
            total: c.total,
            eof: c.eof,
          });
          return;
        }
        case "fs.mkdir": {
          await makeDir(root, msg.path);
          send(conn, { type: "fs.done", sid: msg.sid, path: msg.path, op: "mkdir" });
          return;
        }
        case "fs.remove": {
          await removeEntry(root, msg.path);
          send(conn, { type: "fs.done", sid: msg.sid, path: msg.path, op: "remove" });
          return;
        }
        case "fs.rename": {
          await renameEntry(root, msg.path, msg.to);
          send(conn, { type: "fs.done", sid: msg.sid, path: msg.path, op: "rename" });
          return;
        }
        case "fs.put": {
          const size = await writeChunk(
            root,
            msg.path,
            msg.offset,
            Buffer.from(msg.dataB64, "base64"),
          );
          if (msg.final) {
            send(conn, { type: "fs.written", sid: msg.sid, path: msg.path, size });
          }
          return;
        }
      }
    } catch (e) {
      const code = e instanceof FsError ? e.code : "io";
      send(conn, {
        type: "error",
        code: code === "denied" ? "denied" : "fs_error",
        message: e instanceof Error ? e.message : String(e),
        sid: msg.sid,
      });
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
        conn.ws.close(CLOSE_PROTOCOL, e instanceof ProtocolError ? e.code : "handshake error");
        return;
      }
      if (e instanceof ProtocolError && e.code === "crypto") {
        conn.ws.close(CLOSE_PROTOCOL, "crypto"); // 计数器错位/篡改,通道不可信
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
      handshake: null,
      device: null,
      attachments: new Map(),
      chatAttachments: new Map(),
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

  // term.html 与 xterm 资产始终提供(App 的 WebView 终端依赖;纯静态无敏感信息,
  // 会话数据只走鉴权+加密的 WS)。dev-client.html 仅 --dev。
  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (req.url === "/term.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(path.join(pkgRoot, "term.html")));
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
      } else if (req.url === "/assets/webgl.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(readFileSync(req2.resolve("@xterm/addon-webgl")));
      } else if (devMode && (req.url === "/" || req.url === "/index.html")) {
        // 页面本身只在 --dev 且回环时可取,所以把口令注进去不会扩大暴露面:
        // 能拿到这个页面的,已经能看到终端里打印的同一个口令。
        const page = readFileSync(path.join(pkgRoot, "dev-client.html"), "utf8").replace(
          "</head>",
          `<script>window.__PROSPERO_DEV_TOKEN__=${JSON.stringify(devToken)}</script></head>`,
        );
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
      } else {
        res.writeHead(404).end(devMode ? "not found" : "prosperod");
      }
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, opts.bindAddr ?? "0.0.0.0", () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;
  /**
   * 撤销要立刻生效,否则"已撤销"的设备还能一直用着当前连接 —— 撤销就没意义了。
   * CLI 是另一个进程,只能靠盯 devices.json 变化来发现。
   */
  function dropRevokedConnections(): void {
    const liveTokens = new Set(loadDevices(opts.home).map((d) => d.token));
    for (const conn of conns) {
      const device = conn.device;
      // dev 明文连接没有真实设备记录,不受撤销影响
      if (!device || device.token === "dev") continue;
      if (liveTokens.has(device.token)) continue;
      console.log(`[prosperod] 设备已撤销,断开连接: ${device.name}`);
      try {
        send(conn, { type: "error", code: "auth_failed", message: "device revoked" });
      } catch {
        // 连接可能已经坏了,断开才是重点
      }
      conn.device = null;
      // 4003 是握手/加密错误,撤销要能被客户端区分开(前者重试有意义,后者必须重新配对)
      conn.ws.close(CLOSE_REVOKED, "revoked");
    }
  }

  let revokeWatcher: { close(): void } | null = null;
  let revokeTimer: NodeJS.Timeout | null = null;
  try {
    // 盯目录而不是 devices.json 本身:daemon 常在首次 pair 之前就启动了,
    // 那时文件还不存在,watch 会抛 ENOENT —— 撤销就永远不会生效。
    // 盯目录还顺带扛住了"写临时文件再改名"这种替换方式(watch 文件会跟丢 inode)。
    revokeWatcher = watch(opts.home, (_event, filename) => {
      if (filename !== null && filename !== "devices.json") return;
      // authenticate() 自己也写这个文件(更新 lastSeen),会有无害的自触发;
      // 合并一下,避免一次写入触发多次扫描。
      if (revokeTimer) return;
      revokeTimer = setTimeout(() => {
        revokeTimer = null;
        dropRevokedConnections();
      }, 150);
      revokeTimer.unref?.();
    });
  } catch {
    // 连 home 目录都监视不了(极少见);撤销退化为"下次连接时生效"
  }

  // 接管上一轮留下的 tmux 会话。必须在 statusFile.start 之前,
  // 否则壳会先看到一份"零会话"的快照。
  const restored = manager.restoreFromTmux();
  statusFile.start(port);

  return {
    port,
    devToken,
    restoredSessions: restored.length,
    httpServer,
    manager,
    notifier,
    close: async () => {
      clearInterval(catchupTimer);
      clearInterval(pingTimer);
      for (const conn of conns) conn.ws.terminate();
      statusFile.stop();
      if (revokeTimer) clearTimeout(revokeTimer);
      revokeWatcher?.close();
      wss.close();
      manager.disposeAll();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
