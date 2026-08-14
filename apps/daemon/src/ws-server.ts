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
  CAPABILITY_AGENT_ACCOUNTS,
  CAPABILITY_AGENT_API_PROFILES,
  CAPABILITY_CHAT_ATTACHMENT_PREVIEWS,
  CAPABILITY_ORCHESTRATION_AUTOMATION,
  CAPABILITY_ORCHESTRATION_GRAPH,
  CAPABILITY_ORCHESTRATION_LIFECYCLE,
  CAPABILITY_ORCHESTRATION_MANAGEMENT,
  CAPABILITY_ORCHESTRATION_MANUAL,
  CAPABILITY_ORCHESTRATION_RUN_LIFECYCLE,
  CAPABILITY_ORCHESTRATION_SNAPSHOT,
  CAPABILITY_SESSION_CREATE_MODEL,
  CAPABILITY_SUBAGENT_HISTORY,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  ProtocolError,
  fromB64,
  hostIdForDaemonPublicKey,
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
  type UsageAccount,
  type ResumableConversation,
} from "@prospero/protocol";
import { availableMemory, osIdentity } from "./host-stats.js";
import {
  authenticate,
  canDeviceOrchestrate,
  loadDevices,
  loadIdentity,
  type DeviceRecord,
} from "./pairing.js";
import { Notifier, type NotifyConfig } from "./notify.js";
import { SessionError, SessionManager } from "./session-manager.js";
import { StatusFile } from "./status-file.js";
import {
  ControlSocketError,
  controlSocketPath as makeControlSocketPath,
  startControlSocket,
  type ControlSocketServer,
} from "./control-socket.js";
import { CollaborationService } from "./orchestration/collaboration.js";
import { AutomationService } from "./orchestration/automation.js";
import { DispatchService } from "./orchestration/dispatch.js";
import { orchestrationControlApi } from "./orchestration/control-api.js";
import { OrchestrationError, OrchestrationStore } from "./orchestration/store.js";
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
import { searchLocalConversations } from "./local-conversations.js";
import { DAEMON_VERSION } from "./version.js";
import { AgentAccountError, AgentAccountManager } from "./agent-accounts.js";

const HIGH_WATER = 512 * 1024; // 超过则暂停向该客户端流式发送
const LOW_WATER = 64 * 1024; //   低于则通过 ring/快照追平
const CATCHUP_MS = 250;
const PING_MS = 15_000;
const MANUAL_ORCHESTRATION_METHODS = new Set([
  "run.create",
  "run.complete",
  "run.abandon",
  "run.delete",
  "task.create",
  "task.cancel",
  "task.retry",
  "worker.start",
  "worker.stop",
  "graph.create",
  "graph.apply",
  "automation.start",
  "automation.pause",
]);

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
  /** 本条连接实际采用的版本；不是 daemon 的最高版本。 */
  protocolVersion: number;
  device: DeviceRecord | null;
  attachments: Map<string, AttachState>;
  chatAttachments: Map<string, ChatAttachState>;
  alive: boolean;
}

export interface DaemonServerOptions {
  home: string;
  port: number;
  /** 新会话目录选择器的根；生产默认当前用户 home，测试可注入临时目录。 */
  workspaceRoot?: string | undefined;
  /** 监听地址;省略 = 0.0.0.0(全部网卡) */
  bindAddr?: string | undefined;
  /** tmux 托管:会话进程活过 daemon 重启 */
  useTmux?: boolean | undefined;
  devMode?: boolean;
  hostName?: string | undefined;
  /** 推送通道配置;省略则不推送 */
  notify?: NotifyConfig | null;
  /** 测试可注入；生产读取 Claude/Codex 官方本机会话索引。 */
  conversationSearch?: (
    agent: "claude" | "codex",
    query: string,
    limit: number,
    environment?: Record<string, string>,
    codexAppServerArgs?: string[],
  ) => Promise<ResumableConversation[]>;
}

export interface DaemonServer {
  port: number;
  /** --dev 的一次性明文口令(仅 devMode 有意义) */
  devToken: string;
  /** 本次启动从 tmux/原生 Agent 存储接管回来的会话数 */
  restoredSessions: number;
  httpServer: Server;
  manager: SessionManager;
  accounts: AgentAccountManager;
  notifier: Notifier;
  /** M2 编排状态与派发入口；手机协议接入(M4)也将复用它们。 */
  orchestration: {
    store: OrchestrationStore;
    dispatch: DispatchService;
    automation: AutomationService;
  };
  collaboration: CollaborationService;
  controlSocket: ControlSocketServer;
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
  const workspaceRoot = opts.workspaceRoot ?? os.homedir();
  const DAEMON_STARTED_AT = Date.now();
  const hostId = hostIdForDaemonPublicKey(identity.publicKey);
  // --dev 的一次性口令:每次启动重新生成,只存在内存里,只打印到启动它的终端。
  // 这样"能看到终端输出"就成了使用明文通道的前提,而不是"恰好在本机跑着"。
  const devToken = randomBytes(18).toString("base64url");
  const devTokenEqual = (supplied: string): boolean => {
    const a = Buffer.from(supplied);
    const b = Buffer.from(devToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  // Mac GUI 的控制口令只落在 0600 的 status.json,且接口同时强制 loopback。
  const controlToken = randomBytes(24).toString("base64url");
  const controlTokenEqual = (supplied: string): boolean => {
    const a = Buffer.from(supplied);
    const b = Buffer.from(controlToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const controlSocketPath = makeControlSocketPath(opts.home);
  const controlTokenPath = path.join(opts.home, "control.token");
  // `apps/daemon/bin/prospero` 是 package 安装前的本地入口；npm 安装后仍由
  // package bin 指向同一文件。每个 agent 的 PATH 都优先找到它。
  const cliBinDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin");
  const accounts = new AgentAccountManager(opts.home);
  const manager = new SessionManager({
    home: opts.home,
    ...(opts.useTmux ? { tmux: { home: opts.home } } : {}),
    sessionEnv: (sessionId) => ({
      PROSPERO_SESSION_ID: sessionId,
      PROSPERO_CONTROL_SOCK: controlSocketPath,
      PROSPERO_CONTROL_TOKEN_PATH: controlTokenPath,
      PATH: [cliBinDir, process.env["PATH"] ?? ""].filter((part) => part !== "").join(path.delimiter),
    }),
    accountResolver: (accountId, agent) => accounts.resolve(accountId, agent),
  });
  const orchestrationStore = new OrchestrationStore(opts.home);
  const dispatchService = new DispatchService(orchestrationStore, manager);
  const automationService = new AutomationService(orchestrationStore, dispatchService);
  const collaboration = new CollaborationService(orchestrationStore);
  const orchestrationApi = orchestrationControlApi(
    orchestrationStore,
    dispatchService,
    collaboration,
    automationService,
  );
  const controlSocket = await startControlSocket({
    home: opts.home,
    token: controlToken,
    handle: orchestrationApi,
  });
  // Mac GUI 靠这个文件看会话列表(WS 协议要过 E2E 握手,壳没必要实现一遍)
  const statusFile = new StatusFile(opts.home, manager, {
    port: opts.port,
    bind: opts.bindAddr ?? null,
    controlToken,
    persistence: { pty: manager.tmuxEnabled, structured: true },
  });
  const conns = new Set<Conn>();
  const devMode = opts.devMode ?? false;
  const notifier = new Notifier(opts.notify ?? null);
  const conversationSearch = opts.conversationSearch ?? searchLocalConversations;

  const httpServer = createServer((req, res) => handleHttp(req, res));
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  function send(conn: Conn, msg: S2CMessage): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    // v5 不认识 completed 和 v7 新增的响应类型。未知可选字段会被旧 Zod
    // 自动剥掉，但未知 union 成员会让整个连接被客户端主动关闭，必须在发送边界降级。
    if (
      (conn.protocolVersion <= 5 &&
        (msg.type === "orchestration.snapshot" || msg.type === "conversation.results")) ||
      (conn.protocolVersion < 10 && msg.type === "agent.accounts.result")
    ) return;
    const compatible =
      conn.protocolVersion <= 5 && msg.type === "session.state" && msg.session.status === "completed"
        ? { ...msg, session: { ...msg.session, status: "idle" as const } }
        : msg;
    conn.ws.send(conn.channel ? conn.channel.seal(compatible) : JSON.stringify(compatible));
  }

  function orchestrationCapabilities(conn: Conn): string[] {
    const capabilities: string[] = [];
    if (conn.protocolVersion >= 11) {
      capabilities.push(CAPABILITY_CHAT_ATTACHMENT_PREVIEWS);
      capabilities.push(CAPABILITY_SESSION_CREATE_MODEL);
    }
    if (conn.protocolVersion >= 10 && conn.device?.allowShell) {
      capabilities.push(CAPABILITY_AGENT_ACCOUNTS);
    }
    if (conn.protocolVersion >= 12 && conn.device?.allowShell) {
      capabilities.push(CAPABILITY_AGENT_API_PROFILES);
    }
    if (conn.protocolVersion >= 9) capabilities.push(CAPABILITY_SUBAGENT_HISTORY);
    if (conn.protocolVersion >= 7) capabilities.push(CAPABILITY_ORCHESTRATION_SNAPSHOT);
    if (
      conn.protocolVersion >= 8 &&
      conn.device !== null &&
      canDeviceOrchestrate(conn.device)
    ) {
      capabilities.push(CAPABILITY_ORCHESTRATION_MANUAL);
      capabilities.push(CAPABILITY_ORCHESTRATION_GRAPH);
      capabilities.push(CAPABILITY_ORCHESTRATION_AUTOMATION);
      capabilities.push(CAPABILITY_ORCHESTRATION_MANAGEMENT);
      capabilities.push(CAPABILITY_ORCHESTRATION_LIFECYCLE);
      capabilities.push(CAPABILITY_ORCHESTRATION_RUN_LIFECYCLE);
    }
    return capabilities;
  }

  /**
   * 协调者的一轮已经结束、任务图也完全落定时，修复旧协调者遗漏的 Run 完成动作。
   * worker 的 session completed 仍绝不等同于 task done；这里只汇总已经显式交付的 Task。
   */
  function completeSettledCoordinatorRuns(): number {
    const settledCoordinators = new Set(
      manager.list()
        .filter(
          (session) =>
            session.kind === "structured" &&
            (session.status === "completed" || session.status === "done"),
        )
        .map((session) => session.id),
    );
    let completed = 0;
    for (const run of orchestrationStore.listRuns()) {
      if (
        run.status !== "active" ||
        run.coordinatorSessionId === null ||
        !settledCoordinators.has(run.coordinatorSessionId)
      ) {
        continue;
      }
      if (orchestrationStore.completeRunIfSettled(run.id)) completed += 1;
    }
    return completed;
  }

  /** 手机上的状态只读快照来自同一个 store，绝不在 WS 层维护镜像。 */
  function sendOrchestrationSnapshot(conn: Conn): void {
    if (conn.protocolVersion < 7) return;
    const state = orchestrationStore.snapshot();
    send(conn, {
      type: "orchestration.snapshot",
      snapshot: {
        runs: Object.values(state.runs),
        tasks: Object.values(state.tasks),
        dispatches: Object.values(state.dispatches),
        gates: Object.values(state.gates),
      },
    });
  }

  function broadcastOrchestrationSnapshot(): void {
    for (const candidate of conns) {
      if (candidate.device) sendOrchestrationSnapshot(candidate);
    }
  }

  // 控制 socket、自动调度器与 WebSocket 动作都写同一个 Store。统一订阅它，
  // 才不会出现 CLI 已完成而手机还要等下一次 8 秒轮询的状态延迟。
  let orchestrationBroadcastTimer: NodeJS.Timeout | null = null;
  let reconcilingOrchestration = false;
  const scheduleOrchestrationBroadcast = (): void => {
    if (reconcilingOrchestration || orchestrationBroadcastTimer) return;
    orchestrationBroadcastTimer = setTimeout(() => {
      orchestrationBroadcastTimer = null;
      reconcilingOrchestration = true;
      try {
        completeSettledCoordinatorRuns();
      } finally {
        reconcilingOrchestration = false;
      }
      broadcastOrchestrationSnapshot();
    }, 25);
    orchestrationBroadcastTimer.unref?.();
  };
  const stopOrchestrationChanges = orchestrationStore.onChange(scheduleOrchestrationBroadcast);

  const stopOrchestrationBroadcasts = (): void => {
    stopOrchestrationChanges();
    if (orchestrationBroadcastTimer) {
      clearTimeout(orchestrationBroadcastTimer);
      orchestrationBroadcastTimer = null;
    }
  };

  function goalCoordinatorPrompt(runId: string, objective: string): string {
    return [
      "你是本次 Prospero 编排的协调者。",
      `Run ID: ${runId}`,
      "目标：",
      objective,
      "请先调查并拆分有明确交付物的任务；需要并行执行时，用 prospero task / worker 命令派发。",
      "Worker 只能通过 prospero task done 或 task fail 显式交付；遇到需要人决定的事，用 prospero gate create。",
      `所有任务验收完毕且没有待处理 Gate 后，必须执行 prospero run complete --id ${runId}。`,
    ].join("\n\n");
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
        void notifier.notifyPermission(
          sid,
          info,
          body.action,
          body.resources[0] ?? "",
          `prospero://host/${encodeURIComponent(hostId)}/session/${encodeURIComponent(sid)}`,
        );
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
    // Structured sessions naturally settle at completed; done/died are the
    // terminal statuses emitted when a session is explicitly killed. All
    // three mean a worker that did not explicitly hand in must be reconciled.
    if (session.status === "completed" || session.status === "done" || session.status === "died") {
      const settled = dispatchService.settleEndedSession(
        session.id,
        session.status === "died" ? "worker 会话意外退出" : "worker 会话已结束但未显式交付",
      );
      if (settled) {
        automationService.kick(settled.task.runId);
      }
      completeSettledCoordinatorRuns();
    }
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
    const sessions = manager.list().map((session) =>
      conn.protocolVersion <= 5 && session.status === "completed"
        ? { ...session, status: "idle" as const }
        : session,
    );
    send(conn, {
      type: "hello.ok",
      host: {
        name: opts.hostName ?? os.hostname(),
        daemonVersion: DAEMON_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        minimumProtocolVersion: MIN_PROTOCOL_VERSION,
        negotiatedProtocolVersion: conn.protocolVersion,
        capabilities: orchestrationCapabilities(conn),
        platform: osIdentity().platform,
        osVersion: osIdentity().version,
        arch: process.arch,
        cpus: os.cpus().length,
        memTotal: os.totalmem(),
        memFree: availableMemory(),
        uptimeSec: Math.floor(os.uptime()),
        loadAvg: os.loadavg(),
        daemonStartedAt: DAEMON_STARTED_AT,
        tmuxManaged: manager.tmuxEnabled,
      },
      sessions,
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
    const { hello, channel, protocolVersion } = serverHandshakeAccept(conn.handshake, text);
    conn.handshake = null;
    conn.protocolVersion = protocolVersion;
    // 拒绝必须在 Mac 这边留下痕迹:手机上只会看到一句模糊的"配对已失效",
    // 而 daemon 完全静默的话,排查就只剩下猜(已经为此白花过一次时间)
    const device = authenticate(opts.home, hello, (reason) => {
      console.warn(
        reason === "unknown_token"
          ? `[prosperod] 拒绝连接:token 不在设备表里(${hello.token.slice(0, 6)}…)—— 配对码过期,或手机连的是另一台 daemon`
          : `[prosperod] 拒绝连接:token ${hello.token.slice(0, 6)}… 的公钥与首次配对时不符 —— App 重装过就重新配对,否则这个 token 可能已泄漏`,
      );
    });
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
      case "workspace.list": {
        // 新建会话前还没有 sid,所以浏览根固定为当前 macOS 用户的 home。
        // listDir 会 realpath 并阻止符号链接逃逸;响应里只回这一级的预览。
        const root = workspaceRoot;
        const cwd = path.join(root, msg.path);
        try {
          const entries = await listDir(root, msg.path);
          send(conn, { type: "workspace.listing", path: msg.path, cwd, entries });
        } catch (e) {
          send(conn, {
            type: "workspace.listing",
            path: msg.path,
            cwd,
            entries: [],
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }
      case "conversation.search": {
        try {
          const account = msg.accountId ? accounts.resolve(msg.accountId, msg.agent) : undefined;
          const conversations = await conversationSearch(
            msg.agent,
            msg.query,
            msg.limit ?? 20,
            account?.environment,
            account?.codexAppServerArgs,
          );
          send(conn, {
            type: "conversation.results",
            requestId: msg.requestId,
            agent: msg.agent,
            conversations,
          });
        } catch (error) {
          send(conn, {
            type: "conversation.results",
            requestId: msg.requestId,
            agent: msg.agent,
            conversations: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "agent.accounts.list": {
        const list = await accounts.snapshot(manager.list());
        send(conn, {
          type: "agent.accounts.result",
          requestId: msg.requestId,
          action: "list",
          ok: true,
          accounts: list,
        });
        return;
      }
      case "agent.account.create":
      case "agent.account.api.create":
      case "agent.account.api.configure":
      case "agent.account.rename":
      case "agent.account.default":
      case "agent.account.login":
      case "agent.account.credential.set":
      case "agent.account.logout":
      case "agent.account.delete": {
        if (
          conn.protocolVersion < 12 &&
          (msg.type === "agent.account.api.create" || msg.type === "agent.account.api.configure")
        ) {
          send(conn, {
            type: "error",
            code: "bad_message",
            message: "当前协商协议不支持第三方 API Profile",
          });
          return;
        }
        const action = (() => {
          switch (msg.type) {
            case "agent.account.create": return "create" as const;
            case "agent.account.api.create": return "api_create" as const;
            case "agent.account.api.configure": return "api_configure" as const;
            case "agent.account.rename": return "rename" as const;
            case "agent.account.default": return "default" as const;
            case "agent.account.login": return "login" as const;
            case "agent.account.credential.set": return "credential" as const;
            case "agent.account.logout": return "logout" as const;
            case "agent.account.delete": return "delete" as const;
          }
        })();
        if (!device.allowShell) {
          send(conn, {
            type: "agent.accounts.result",
            requestId: msg.requestId,
            action,
            ok: false,
            accounts: [],
            error: "这台设备没有管理电脑端账号环境的权限",
          });
          return;
        }
        try {
          let sessionId: string | undefined;
          switch (msg.type) {
            case "agent.account.create":
              accounts.create(msg.agent, msg.name);
              break;
            case "agent.account.api.create":
              await accounts.createApi(msg.agent, msg.name, {
                baseUrl: msg.baseUrl,
                model: msg.model,
                apiKey: msg.apiKey,
              });
              break;
            case "agent.account.api.configure":
              await accounts.configureApi(msg.accountId, {
                baseUrl: msg.baseUrl,
                model: msg.model,
                apiKey: msg.apiKey,
              });
              break;
            case "agent.account.rename":
              accounts.rename(msg.accountId, msg.name);
              break;
            case "agent.account.default":
              accounts.setDefault(msg.accountId);
              break;
            case "agent.account.login": {
              const info = manager.createAccountLogin(
                accounts.loginSpec(msg.accountId),
                msg.cols,
                msg.rows,
              );
              sessionId = info.id;
              break;
            }
            case "agent.account.credential.set":
              await accounts.setCredential(
                msg.accountId,
                msg.credentialKind,
                msg.credential,
              );
              break;
            case "agent.account.logout":
              await accounts.logout(msg.accountId);
              break;
            case "agent.account.delete":
              await accounts.delete(msg.accountId, manager.list());
              break;
          }
          send(conn, {
            type: "agent.accounts.result",
            requestId: msg.requestId,
            action,
            ok: true,
            accounts: await accounts.snapshot(manager.list()),
            ...(sessionId ? { sessionId } : {}),
          });
        } catch (error) {
          send(conn, {
            type: "agent.accounts.result",
            requestId: msg.requestId,
            action,
            ok: false,
            accounts: await accounts.snapshot(manager.list()).catch(() => []),
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "session.create": {
        const info = await manager.create({
          agent: msg.agent,
          accountId: msg.accountId,
          kind: msg.kind,
          approvalPolicy: msg.approvalPolicy,
          cwd: msg.cwd,
          command: msg.command,
          mode: msg.mode,
          model: msg.model,
          effort: msg.effort,
          resume: msg.resume,
          cols: msg.cols,
          rows: msg.rows,
          allowShell: device.allowShell,
        });
        if (msg.goal !== undefined) {
          const run = orchestrationStore.createRun({
            objective: msg.goal,
            coordinatorSessionId: info.id,
          });
          // Goal 一定是 structured（协议已校验）。Run 已经是可恢复的真相，不能因为
          // 第一次给 Agent 投递提示暂时失败就把新建会话卡死；客户端 attach 后仍会收到它。
          void manager
            .requireStructured(info.id)
            .send(goalCoordinatorPrompt(run.id, run.objective))
            .catch((error: unknown) => {
              console.error(`[prosperod] Goal ${run.id} 的协调者提示投递失败:`, error);
            });
          sendOrchestrationSnapshot(conn);
        }
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
      case "launch.models.get": {
        try {
          const catalog = await manager.launchModels(msg.agent, msg.accountId);
          send(conn, {
            type: "launch.models",
            requestId: msg.requestId,
            agent: msg.agent,
            models: catalog.models,
            ...(catalog.currentModel ? { currentModel: catalog.currentModel } : {}),
            ...(catalog.currentEffort ? { currentEffort: catalog.currentEffort } : {}),
          });
        } catch (error) {
          send(conn, {
            type: "launch.models",
            requestId: msg.requestId,
            agent: msg.agent,
            models: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
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
        await manager.requireStructured(msg.sid).send(msg.text, msg.attachments, msg.delivery);
        return;
      case "chat.queue.remove":
        manager.requireStructured(msg.sid).removeQueued(msg.queueId);
        return;
      case "chat.queue.guide":
        await manager.requireStructured(msg.sid).guideQueued(msg.queueId);
        return;
      case "chat.complete": {
        const session = manager.getStructured(msg.sid);
        if (!session) {
          send(conn, {
            type: "error",
            code: "session_not_found",
            message: `no such structured session: ${msg.sid}`,
            sid: msg.sid,
          });
          return;
        }
        try {
          const items = await session.complete(msg.kind, msg.query);
          send(conn, {
            type: "chat.suggestions",
            sid: msg.sid,
            requestId: msg.requestId,
            kind: msg.kind,
            items,
          });
        } catch (error) {
          send(conn, {
            type: "error",
            code: "bad_message",
            message: error instanceof Error ? error.message : String(error),
            sid: msg.sid,
          });
        }
        return;
      }
      case "agent.models.get": {
        try {
          const catalog = await manager.requireStructured(msg.sid).models();
          send(conn, {
            type: "agent.models",
            sid: msg.sid,
            requestId: msg.requestId,
            models: catalog.models,
            ...(catalog.currentModel ? { currentModel: catalog.currentModel } : {}),
            ...(catalog.currentEffort ? { currentEffort: catalog.currentEffort } : {}),
          });
        } catch (error) {
          send(conn, {
            type: "error",
            code: "bad_message",
            message: error instanceof Error ? error.message : String(error),
            sid: msg.sid,
          });
        }
        return;
      }
      case "agent.model.set": {
        try {
          const selection = await manager
            .requireStructured(msg.sid)
            .setModel(msg.model, msg.effort);
          send(conn, {
            type: "agent.control.result",
            sid: msg.sid,
            requestId: msg.requestId,
            action: "model.set",
            ok: true,
            message: "模型已切换，后续轮次生效",
            currentModel: selection.currentModel,
            ...(selection.currentEffort
              ? { currentEffort: selection.currentEffort }
              : {}),
          });
        } catch (error) {
          send(conn, {
            type: "agent.control.result",
            sid: msg.sid,
            requestId: msg.requestId,
            action: "model.set",
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "agent.modes.get": {
        try {
          const catalog = await manager.requireStructured(msg.sid).modes();
          send(conn, {
            type: "agent.modes",
            sid: msg.sid,
            requestId: msg.requestId,
            modes: catalog.modes,
            ...(catalog.currentMode ? { currentMode: catalog.currentMode } : {}),
          });
        } catch (error) {
          send(conn, {
            type: "error",
            code: "bad_message",
            message: error instanceof Error ? error.message : String(error),
            sid: msg.sid,
          });
        }
        return;
      }
      case "agent.mode.set": {
        try {
          const selection = await manager.requireStructured(msg.sid).setMode(msg.mode);
          send(conn, {
            type: "agent.control.result",
            sid: msg.sid,
            requestId: msg.requestId,
            action: "mode.set",
            ok: true,
            message: selection.currentMode === "plan" ? "已切换到 Plan 模式" : "已切换到执行模式",
            currentMode: selection.currentMode,
          });
        } catch (error) {
          send(conn, {
            type: "agent.control.result",
            sid: msg.sid,
            requestId: msg.requestId,
            action: "mode.set",
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "agent.compact": {
        try {
          await manager.requireStructured(msg.sid).compact();
          send(conn, {
            type: "agent.control.result",
            sid: msg.sid,
            requestId: msg.requestId,
            action: "compact",
            ok: true,
            message: "上下文压缩已完成或已由 Agent 接受",
          });
        } catch (error) {
          send(conn, {
            type: "agent.control.result",
            sid: msg.sid,
            requestId: msg.requestId,
            action: "compact",
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
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
      case "chat.attachment.get": {
        if (conn.protocolVersion < 11) {
          send(conn, {
            type: "error",
            code: "bad_message",
            message: "当前协商协议不支持聊天附件预览",
            sid: msg.sid,
          });
          return;
        }
        const chunk = await manager
          .requireStructured(msg.sid)
          .attachmentChunk(msg.msgId, msg.attachmentId, msg.offset, msg.length);
        if (!chunk) {
          send(conn, {
            type: "error",
            code: "fs_error",
            message: "图片附件已不可用",
            sid: msg.sid,
          });
          return;
        }
        send(conn, {
          type: "chat.attachment.chunk",
          sid: msg.sid,
          msgId: msg.msgId,
          attachmentId: msg.attachmentId,
          mimeType: chunk.mimeType,
          dataB64: toB64(chunk.data),
          total: chunk.total,
          eof: chunk.eof,
          requestId: msg.requestId,
        });
        return;
      }
      case "permission.respond":
        await manager.requireStructured(msg.sid).respondPermission(msg.reqId, msg.reply);
        return;
      case "question.respond":
        await manager
          .requireStructured(msg.sid)
          .respondQuestion(msg.reqId, msg.answers, msg.cancelled === true);
        return;
      case "subagent.send":
        await manager.requireStructured(msg.sid).sendToSubagent(msg.subagentId, msg.text);
        return;
      case "subagent.history.get": {
        if (conn.protocolVersion < 9) {
          send(conn, {
            type: "error",
            code: "bad_message",
            message: "当前协商协议不支持子 Agent 历史",
            sid: msg.sid,
          });
          return;
        }
        const snapshot = await manager.requireStructured(msg.sid).subagentSnapshot(msg.subagentId);
        send(conn, {
          type: "subagent.history.result",
          sid: msg.sid,
          subagentId: msg.subagentId,
          requestId: msg.requestId,
          events: snapshot.events,
        });
        return;
      }
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

      case "usage.get": {
        // 不带 sid = 账号级:每个 agent 各问一份。限流按账号走,而账号按 agent 分,
        // 随便挑一个会话只能答出其中一家的额度,另外几家的订阅就看不见了。
        if (msg.sid === undefined) {
          const sessions = manager.structuredPerAgent();
          if (sessions.length === 0) {
            send(conn, {
              type: "usage.result",
              available: false,
              reason: "还没有对话型会话 —— 用量要有会话才问得到。",
              accounts: [],
            });
            return;
          }
          const accounts = await Promise.all(
            sessions.map(async (s): Promise<UsageAccount> => {
              const r = await s.usage();
              if (!r) {
                return {
                  agent: s.agent,
                  available: false,
                  windows: [],
                  reason: "还没产生用量 —— 发一条消息后再看。",
                };
              }
              return {
                agent: s.agent,
                ...(s.accountId ? { accountId: s.accountId } : {}),
                ...(s.accountName ? { accountName: s.accountName } : {}),
                available: true,
                subscription: r.subscription ?? null,
                ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}),
                ...(r.inputTokens !== undefined ? { inputTokens: r.inputTokens } : {}),
                ...(r.outputTokens !== undefined ? { outputTokens: r.outputTokens } : {}),
                windows: r.windows,
                ...(r.windows.length === 0
                  ? { reason: "这个后端不提供套餐限流窗口。" }
                  : {}),
              };
            }),
          );
          // 顶层字段挑压力最大的那家:老客户端只认这几个字段,给它最该看见的一份
          const lead =
            [...accounts]
              .filter((a) => a.available)
              .sort(
                (a, b) =>
                  Math.max(0, ...b.windows.map((w) => w.utilization)) -
                  Math.max(0, ...a.windows.map((w) => w.utilization)),
              )[0] ?? accounts[0];
          send(conn, {
            type: "usage.result",
            available: accounts.some((a) => a.available),
            ...(lead?.subscription !== undefined ? { subscription: lead.subscription } : {}),
            ...(lead?.costUsd !== undefined ? { costUsd: lead.costUsd } : {}),
            ...(lead?.inputTokens !== undefined ? { inputTokens: lead.inputTokens } : {}),
            ...(lead?.outputTokens !== undefined ? { outputTokens: lead.outputTokens } : {}),
            windows: lead?.windows ?? [],
            ...(lead?.reason !== undefined ? { reason: lead.reason } : {}),
            accounts,
          });
          return;
        }

        const s = manager.requireStructured(msg.sid);
        const report = await s.usage();
        if (!report) {
          send(conn, {
            type: "usage.result",
            sid: msg.sid,
            available: false,
            reason: "这个会话还没产生用量 —— 发一条消息后再看。",
          });
          return;
        }
        send(conn, {
          type: "usage.result",
          sid: msg.sid,
          available: true,
          subscription: report.subscription ?? null,
          ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
          ...(report.inputTokens !== undefined ? { inputTokens: report.inputTokens } : {}),
          ...(report.outputTokens !== undefined ? { outputTokens: report.outputTokens } : {}),
          windows: report.windows,
          ...(report.windows.length === 0
            ? { reason: "这个后端不提供套餐限流窗口(只有 claude.ai 订阅会话有)。" }
            : {}),
        });
        return;
      }

      case "orchestration.snapshot":
        sendOrchestrationSnapshot(conn);
        return;

      case "orchestration.gate.resolve":
        {
          const gate = orchestrationStore.resolveGate(msg.gateId, msg.decision);
          automationService.kick(gate.runId);
        }
        sendOrchestrationSnapshot(conn);
        return;

      case "orchestration.run.create":
      case "orchestration.run.complete":
      case "orchestration.run.abandon":
      case "orchestration.run.delete":
      case "orchestration.task.create":
      case "orchestration.task.cancel":
      case "orchestration.task.retry":
      case "orchestration.worker.start":
      case "orchestration.worker.stop":
      case "orchestration.graph.create":
      case "orchestration.graph.apply":
      case "orchestration.automation.start":
      case "orchestration.automation.pause": {
        if (!canDeviceOrchestrate(device) || conn.protocolVersion < 8) {
          send(conn, {
            type: "error",
            code: "forbidden",
            message: "这台设备没有人工编排权限，或 daemon 版本过旧",
          });
          return;
        }
        if (msg.type === "orchestration.run.create") {
          await orchestrationApi("run.create", {
            objective: msg.objective,
            coordinatorSessionId: null,
            ...(msg.operationId ? { operationId: msg.operationId } : {}),
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.run.complete") {
          await orchestrationApi("run.complete", {
            runId: msg.runId,
            operationId: msg.operationId,
            actorSessionId: null,
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.run.abandon") {
          await orchestrationApi("run.abandon", {
            runId: msg.runId,
            operationId: msg.operationId,
            actorSessionId: null,
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.run.delete") {
          await orchestrationApi("run.delete", {
            runId: msg.runId,
            operationId: msg.operationId,
            actorSessionId: null,
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.task.create") {
          await orchestrationApi("task.create", {
            runId: msg.runId,
            title: msg.title,
            spec: msg.spec,
            deps: msg.deps ?? [],
            ...(msg.parentId ? { parentId: msg.parentId } : {}),
            ...(msg.operationId ? { operationId: msg.operationId } : {}),
            actorSessionId: null,
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.task.cancel") {
          await orchestrationApi("task.cancel", {
            taskId: msg.taskId,
            operationId: msg.operationId,
            ...(msg.reason ? { reason: msg.reason } : {}),
            actorSessionId: null,
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.task.retry") {
          await orchestrationApi("task.retry", {
            taskId: msg.taskId,
            operationId: msg.operationId,
            actorSessionId: null,
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.worker.start") {
          await orchestrationApi("worker.start", {
            taskId: msg.taskId,
            agent: msg.agent,
            ...(msg.accountId ? { accountId: msg.accountId } : {}),
            worktree: msg.worktree,
            cwd: msg.cwd,
            ...(msg.kind ? { kind: msg.kind } : {}),
            ...(msg.approvalPolicy ? { approvalPolicy: msg.approvalPolicy } : {}),
            ...(msg.operationId ? { operationId: msg.operationId } : {}),
            actorSessionId: null,
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.worker.stop") {
          await orchestrationApi("worker.stop", {
            taskId: msg.taskId,
            operationId: msg.operationId,
            ...(msg.reason ? { reason: msg.reason } : {}),
            actorSessionId: null,
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.graph.create") {
          await orchestrationApi("graph.create", {
            operationId: msg.operationId,
            objective: msg.objective,
            nodes: msg.nodes,
            coordinatorSessionId: null,
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.graph.apply") {
          await orchestrationApi("graph.apply", {
            operationId: msg.operationId,
            runId: msg.runId,
            baseRevision: msg.baseRevision,
            nodes: msg.nodes,
            deleteTaskIds: msg.deleteTaskIds ?? [],
            actorSessionId: null,
          }, new AbortController().signal);
        } else if (msg.type === "orchestration.automation.start") {
          await orchestrationApi("automation.start", {
            operationId: msg.operationId,
            runId: msg.runId,
            agent: msg.agent,
            ...(msg.accountId ? { accountId: msg.accountId } : {}),
            approvalPolicy: msg.approvalPolicy,
            workspace: msg.workspace,
            cwd: msg.cwd,
            actorSessionId: null,
          }, new AbortController().signal);
        } else {
          await orchestrationApi("automation.pause", {
            operationId: msg.operationId,
            runId: msg.runId,
            actorSessionId: null,
          }, new AbortController().signal);
        }
        // 幂等重试可能不产生 Store change；仍给发起设备一份确认快照。
        sendOrchestrationSnapshot(conn);
        return;
      }

      case "approval.policy.set":
        await manager.setApprovalPolicy(msg.sid, msg.policy);
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
      if (e instanceof AgentAccountError) {
        send(conn, { type: "error", code: "bad_message", message: e.message });
        return;
      }
      if (e instanceof OrchestrationError) {
        const code = e.code === "revision_conflict" ||
          e.code === "operation_conflict" ||
          e.code === "task_not_editable" ||
          e.code === "run_not_deletable" ||
          e.code === "invalid_transition" ||
          e.code === "task_not_dispatchable"
          ? "conflict"
          : "bad_message";
        send(conn, { type: "error", code, message: e.message });
        return;
      }
      if (e instanceof ControlSocketError) {
        const conflict = e.code === "revision_conflict" ||
          e.code === "operation_conflict" ||
          e.code === "task_not_editable" ||
          e.code === "run_not_deletable" ||
          e.code === "invalid_transition" ||
          e.code === "task_not_dispatchable" ||
          e.code === "worker_not_active";
        send(conn, {
          type: "error",
          code: e.code === "forbidden" ? "forbidden" : conflict ? "conflict" : "bad_message",
          message: e.message,
        });
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
      protocolVersion: PROTOCOL_VERSION,
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

  async function handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("cache-control", "no-store");
    if (!isLoopback(req)) {
      res.writeHead(403).end("loopback only");
      return;
    }
    const auth = req.headers.authorization ?? "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!controlTokenEqual(supplied)) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/_prospero/control/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sessions: manager.list().length }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/_prospero/control/session/create") {
      try {
        const body = await readControlJson(req);
        // 本机壳和手机共用同一份协议校验，避免 HTTP 控制面悄悄长出另一套会话参数语义。
        // Goal/恢复会话不是这个轻量启动器的职责，因此只挑选基础创建字段。
        const message = parseC2S({
          type: "session.create",
          agent: body["agent"],
          accountId: body["accountId"],
          kind: body["kind"],
          approvalPolicy: body["approvalPolicy"],
          cwd: body["cwd"],
          command: body["command"],
          cols: body["cols"] ?? 120,
          rows: body["rows"] ?? 40,
        });
        if (message.type !== "session.create") {
          throw new ProtocolError("expected session.create", "format");
        }
        const info = await manager.create({
          agent: message.agent,
          accountId: message.accountId,
          kind: message.kind,
          approvalPolicy: message.approvalPolicy,
          cwd: message.cwd,
          command: message.command,
          cols: message.cols,
          rows: message.rows,
          // control token 只写在 0600 status.json，且这个入口仅接受 loopback。
          // 它代表 Mac 宿主用户本人，不继承任一手机设备的 allowShell 限制。
          allowShell: true,
        });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(info));
      } catch (e) {
        if (e instanceof ProtocolError) {
          res.writeHead(400).end(e.message);
        } else if (e instanceof SessionError) {
          res.writeHead(409).end(e.message);
        } else {
          res.writeHead(400).end(e instanceof Error ? e.message : String(e));
        }
      }
      return;
    }
    const sessionViewMatch = url.pathname.match(
      /^\/_prospero\/control\/session\/([^/]+)\/view$/,
    );
    if (req.method === "GET" && sessionViewMatch) {
      try {
        const sid = decodeURIComponent(sessionViewMatch[1]!);
        const rawKnownSeq = url.searchParams.get("knownSeq");
        const knownSeq = rawKnownSeq === null ? undefined : Number(rawKnownSeq);
        if (
          knownSeq !== undefined &&
          (!Number.isSafeInteger(knownSeq) || knownSeq < 0)
        ) {
          res.writeHead(400).end("invalid knownSeq");
          return;
        }

        const structured = manager.getStructured(sid);
        if (structured) {
          const snapshot = structured.snapshot();
          if (knownSeq === snapshot.evSeq) {
            res.writeHead(204).end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            kind: "structured",
            seq: snapshot.evSeq,
            evSeq: snapshot.evSeq,
            events: snapshot.events,
          }));
          return;
        }

        const terminal = manager.requirePty(sid);
        if (knownSeq === terminal.ring.lastSeq) {
          res.writeHead(204).end();
          return;
        }
        const snapshot = await terminal.snapshot();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ kind: "pty", ...snapshot }));
      } catch (e) {
        if (e instanceof SessionError) {
          res.writeHead(e.code === "session_not_found" ? 404 : 409).end(e.message);
        } else if (e instanceof URIError) {
          res.writeHead(400).end("invalid session id");
        } else {
          res.writeHead(400).end(e instanceof Error ? e.message : String(e));
        }
      }
      return;
    }
    const sessionInteractMatch = url.pathname.match(
      /^\/_prospero\/control\/session\/([^/]+)\/interact$/,
    );
    if (req.method === "POST" && sessionInteractMatch) {
      try {
        const sid = decodeURIComponent(sessionInteractMatch[1]!);
        const body = await readControlJson(req);
        // 复用手机协议校验，Mac 本地工作台不会悄悄形成第三套输入语义。
        const message = parseC2S({ ...body, sid });
        switch (message.type) {
          case "chat.send":
            await manager
              .requireStructured(sid)
              .send(message.text, message.attachments, message.delivery);
            break;
          case "term.input":
            manager.requirePty(sid).writeInput(utf8Decode(fromB64(message.dataB64)));
            break;
          case "term.resize":
            manager.requirePty(sid).resize(message.cols, message.rows);
            break;
          case "permission.respond":
            await manager
              .requireStructured(sid)
              .respondPermission(message.reqId, message.reply);
            break;
          case "question.respond":
            await manager
              .requireStructured(sid)
              .respondQuestion(message.reqId, message.answers, message.cancelled === true);
            break;
          case "approval.policy.set":
            await manager.requireStructured(sid).setApprovalPolicy(message.policy);
            break;
          default:
            res.writeHead(400).end("unsupported local session interaction");
            return;
        }
        res.writeHead(204).end();
      } catch (e) {
        if (e instanceof ProtocolError) {
          res.writeHead(400).end(e.message);
        } else if (e instanceof SessionError) {
          res.writeHead(e.code === "session_not_found" ? 404 : 409).end(e.message);
        } else if (e instanceof URIError) {
          res.writeHead(400).end("invalid session id");
        } else {
          res.writeHead(400).end(e instanceof Error ? e.message : String(e));
        }
      }
      return;
    }
    const subagentEventsMatch = url.pathname.match(
      /^\/_prospero\/control\/session\/([^/]+)\/subagent\/([^/]+)\/events$/,
    );
    if (req.method === "GET" && subagentEventsMatch) {
      try {
        const sid = decodeURIComponent(subagentEventsMatch[1]!);
        const subagentId = decodeURIComponent(subagentEventsMatch[2]!);
        const session = manager.requireStructured(sid);
        if (!session.info().subagents?.some((candidate) => candidate.id === subagentId)) {
          res.writeHead(404).end("no such subagent");
          return;
        }
        const snapshot = await session.subagentSnapshot(subagentId);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(snapshot));
      } catch (e) {
        if (e instanceof SessionError) {
          res.writeHead(409).end(e.message);
        } else if (e instanceof URIError) {
          res.writeHead(400).end("invalid session or subagent id");
        } else {
          res.writeHead(400).end(e instanceof Error ? e.message : String(e));
        }
      }
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/_prospero/control/orchestration/action"
    ) {
      try {
        const body = await readControlJson(req);
        const method = body["method"];
        const rawParams = body["params"];
        if (
          typeof method !== "string" ||
          !MANUAL_ORCHESTRATION_METHODS.has(method) ||
          !rawParams ||
          typeof rawParams !== "object" ||
          Array.isArray(rawParams)
        ) {
          res.writeHead(400).end("无效的人工编排动作");
          return;
        }
        const supplied = rawParams as Record<string, unknown>;
        const params = method === "run.create" || method === "graph.create"
          ? { ...supplied, coordinatorSessionId: null }
          : { ...supplied, actorSessionId: null };
        const result = await orchestrationApi(
          method,
          params,
          new AbortController().signal,
        );
        broadcastOrchestrationSnapshot();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        if (e instanceof ControlSocketError) {
          res.writeHead(e.code === "forbidden" ? 403 : 409).end(e.message);
        } else {
          res.writeHead(400).end(e instanceof Error ? e.message : String(e));
        }
      }
      return;
    }
    const gateMatch = url.pathname.match(
      /^\/_prospero\/control\/orchestration\/gate\/([^/]+)\/resolve$/,
    );
    if (req.method === "POST" && gateMatch) {
      try {
        const body = await readControlJson(req);
        const decision = typeof body["decision"] === "string" ? body["decision"].trim() : "";
        if (decision === "") {
          res.writeHead(400).end("决策内容不能为空");
          return;
        }
        const gate = orchestrationStore.resolveGate(decodeURIComponent(gateMatch[1]!), decision);
        automationService.kick(gate.runId);
        broadcastOrchestrationSnapshot();
        res.writeHead(204).end();
      } catch (e) {
        if (e instanceof OrchestrationError) {
          const status = e.code === "gate_not_found" ? 404 : 409;
          res.writeHead(status).end(e.message);
        } else {
          res.writeHead(400).end(e instanceof Error ? e.message : String(e));
        }
      }
      return;
    }
    const match = url.pathname.match(/^\/_prospero\/control\/session\/([^/]+)\/(kill|interrupt)$/);
    if (req.method !== "POST" || !match) {
      res.writeHead(404).end("not found");
      return;
    }
    const sid = decodeURIComponent(match[1]!);
    try {
      if (match[2] === "kill") await manager.kill(sid);
      else await manager.interrupt(sid);
      res.writeHead(204).end();
    } catch (e) {
      if (e instanceof SessionError) {
        res.writeHead(e.code === "session_not_found" ? 404 : 409).end(e.message);
      } else {
        res.writeHead(500).end(e instanceof Error ? e.message : String(e));
      }
    }
  }

  /** 图编辑一次最多 200 个节点；显式限长，避免本机控制面被大 body 占住内存。 */
  async function readControlJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > 4 * 1024 * 1024) throw new Error("控制请求过大");
      chunks.push(data);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("控制请求必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  }

  // term.html 与 xterm 资产始终提供(App 的 WebView 终端依赖;纯静态无敏感信息,
  // 会话数据只走鉴权+加密的 WS)。dev-client.html 仅 --dev。
  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (req.url?.startsWith("/_prospero/control/")) {
        void handleControl(req, res);
      } else if (req.url === "/term.html") {
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

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(opts.port, opts.bindAddr ?? "0.0.0.0", () => resolve());
    });
  } catch (error) {
    // control socket 已先于 HTTP 起来，好让所有 session 都能继承它；若主监听
    // 失败，必须把这批私有凭证和 interval 一并清掉，不能留下幽灵 daemon。
    clearInterval(catchupTimer);
    clearInterval(pingTimer);
    wss.close();
    await controlSocket.close();
    await manager.disposeAll();
    stopOrchestrationBroadcasts();
    orchestrationStore.close();
    throw error;
  }
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
  const restoredPty = manager.restoreFromTmux();
  const restoredStructured = await manager.restoreStructured();
  completeSettledCoordinatorRuns();
  statusFile.start(port);
  automationService.resumePersisted();

  return {
    port,
    devToken,
    restoredSessions: restoredPty.length + restoredStructured.length,
    httpServer,
    manager,
    accounts,
    notifier,
    orchestration: {
      store: orchestrationStore,
      dispatch: dispatchService,
      automation: automationService,
    },
    collaboration,
    controlSocket,
    close: async () => {
      clearInterval(catchupTimer);
      clearInterval(pingTimer);
      for (const conn of conns) conn.ws.terminate();
      statusFile.stop();
      await controlSocket.close();
      if (revokeTimer) clearTimeout(revokeTimer);
      revokeWatcher?.close();
      wss.close();
      await manager.disposeAll();
      stopOrchestrationBroadcasts();
      orchestrationStore.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
