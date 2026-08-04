/**
 * 主机连接。
 *
 * 设计要点(都是为了"切网无感"这一个目标):
 * - 多地址并发竞速:WiFi 与 WireGuard 地址同时试,先完成 E2E 握手者胜;
 * - 地址学习:成功过的地址排到最前,下次优先命中,省掉竞速时间;
 * - 心跳:iOS 切后台/切网常留下"半开"连接 —— socket 看似 OPEN 但收发已死,
 *   只靠 onclose 会卡住几十秒。心跳超时即主动断开重连;
 * - 失败诊断:逐地址记录失败原因,合成一条用户能照做的提示;
 * - 发送排队:断线瞬间的用户操作不丢,重连后按序补发。
 */
import { AppState, Platform } from "react-native";
import {
  CLOSE_AUTH_FAILED,
  CLOSE_REVOKED,
  clientHandshakeStart,
  clientHandshakeFinish,
  parseS2C,
  toB64,
  utf8Encode,
  ProtocolError,
  type AgentKind,
  type C2SMessage,
  type KeyPairB64,
  type PermissionReply,
  type S2CAgentEvent,
  type S2CChatSnapshot,
  type S2CError,
  type S2CHelloOk,
  type S2CMessage,
  type S2CTermOutput,
  type S2CTermSnapshot,
  type S2CToolOutput,
  type SecureChannel,
  type SessionKind,
} from "@prospero/protocol";
import { diagnose, type AttemptResult, type Diagnosis } from "./connect-diagnosis";
import { Emitter } from "./emitter";
import { rememberGoodAddr, type StoredHost } from "./hosts";
import { useApp } from "./store";

const APP_VERSION = "0.0.1";
const ATTEMPT_TIMEOUT_MS = 6000;
const BACKOFF_MIN = 400;
const BACKOFF_MAX = 8000;
/** 心跳间隔与容忍的静默时长(daemon 每 15s ping 一次) */
const HEARTBEAT_MS = 10_000;
const SILENCE_LIMIT_MS = 35_000;
/** 断线期间最多排队多少条待发消息 */
const MAX_QUEUE = 50;

interface Won {
  ws: WebSocket;
  channel: SecureChannel;
  helloOk: S2CHelloOk;
  addr: string;
  rttMs: number;
}

export interface ConnEvents extends Record<string, unknown> {
  connected: { addr: string; rttMs: number };
  disconnected: { willRetry: boolean };
  snapshot: S2CTermSnapshot;
  output: S2CTermOutput;
  chatSnapshot: S2CChatSnapshot;
  agentEvent: S2CAgentEvent;
  toolOutput: S2CToolOutput;
  serverError: S2CError;
}

export class HostConnection {
  readonly events = new Emitter<ConnEvents>();
  activeAddr: string | null = null;
  lastRttMs: number | null = null;
  diagnosis: Diagnosis | null = null;

  private ws: WebSocket | null = null;
  private channel: SecureChannel | null = null;
  private connecting = false;
  private stopped = false;
  private backoff = BACKOFF_MIN;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecvAt = 0;
  private everConnected = false;
  /** 断线期间排队的消息,重连后按序补发 */
  private queue: C2SMessage[] = [];

  constructor(
    readonly host: StoredHost,
    private readonly keys: KeyPairB64,
  ) {}

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1 && this.channel !== null;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  start(): void {
    this.stopped = false;
    if (this.connecting || this.isConnected) return;
    void this.connectOnce();
  }

  /** 回前台 / 网络变化 / 用户手动重试:清退避立即连 */
  kick(): void {
    this.backoff = BACKOFF_MIN;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.isConnected) return;
    this.start();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.channel = null;
    this.activeAddr = null;
    this.queue = [];
    useApp.getState().patchRuntime(this.host.id, { status: "idle", activeAddr: null });
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private patch(patch: Parameters<ReturnType<typeof useApp.getState>["patchRuntime"]>[1]): void {
    useApp.getState().patchRuntime(this.host.id, patch);
  }

  private async connectOnce(): Promise<void> {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    this.patch({ status: this.everConnected ? "reconnecting" : "connecting" });
    try {
      const won = await this.race();
      this.adopt(won);
    } catch {
      this.connecting = false;
      const d = this.diagnosis;
      this.patch({
        status: "failed",
        lastError: d ? `${d.summary} — ${d.hint}` : "连接失败",
      });
      if (d?.fatal !== true && !this.stopped) this.scheduleRetry();
    }
  }

  /** 成功过的地址优先,其余保持原序 */
  private orderedAddrs(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const preferred = this.host.lastGoodAddr;
    if (preferred) {
      out.push(preferred);
      seen.add(preferred);
    }
    for (const a of this.host.addrs) {
      if (!seen.has(a)) {
        out.push(a);
        seen.add(a);
      }
    }
    return out;
  }

  private race(): Promise<Won> {
    const addrs = this.orderedAddrs();
    return new Promise<Won>((resolve, reject) => {
      if (addrs.length === 0) {
        this.diagnosis = diagnose([], !this.everConnected);
        reject(new Error(this.diagnosis.summary));
        return;
      }
      let pending = addrs.length;
      let done = false;
      const failures: AttemptResult[] = [];

      const finishFailure = (): void => {
        if (done) return;
        done = true;
        this.diagnosis = diagnose(failures, !this.everConnected);
        reject(new Error(this.diagnosis.summary));
      };

      for (const addr of addrs) {
        const startedAt = Date.now();
        let ws: WebSocket;
        try {
          ws = new WebSocket(`ws://${addr}:${this.host.port}/ws`);
        } catch (e) {
          failures.push({
            addr,
            failure: "unreachable",
            detail: e instanceof Error ? e.message : undefined,
          });
          if (--pending === 0) finishFailure();
          continue;
        }
        // v1 握手三帧:发临时公钥 → 收 daemon 临时公钥+身份证明 → 发加密 hello。
        // 会话密钥来自双方临时密钥,daemon 静态私钥日后泄漏也解不开今天的流量。
        const { frame, state: hsState } = clientHandshakeStart();
        let channel: SecureChannel | null = null;

        const fail = (failure: AttemptResult["failure"], detail?: string): void => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            // 已关闭
          }
          if (done) return;
          failures.push({ addr, ...(detail !== undefined ? { detail } : {}), failure });
          if (failure === "auth") {
            // 鉴权失败对所有地址都成立,不必等其余
            finishFailure();
            return;
          }
          if (--pending === 0) finishFailure();
        };

        const timer = setTimeout(() => fail("timeout"), ATTEMPT_TIMEOUT_MS);

        // 连接被拒时 RN 会直接触发 onclose(而非 onerror),必须按"是否 open 过"
        // 区分:没 open 过 = 端口不可达;open 过再关 = 握手阶段被拒。
        let opened = false;
        ws.onopen = () => {
          opened = true;
          ws.send(frame);
        };
        ws.onerror = () => fail(opened ? "handshake" : "unreachable");
        // 关闭码是 daemon 唯一能在断开时留下的话。以前这里把它整个丢掉,
        // 于是"设备被撤销""版本不符"都显示成含糊的「握手失败」。
        ws.onclose = (ev) => {
          if (!opened) {
            fail("unreachable");
            return;
          }
          const code = (ev as { code?: number } | undefined)?.code;
          const reason = String((ev as { reason?: unknown } | undefined)?.reason ?? "");
          if (code === CLOSE_AUTH_FAILED) fail("auth", reason || undefined);
          else if (code === CLOSE_REVOKED) fail("revoked", reason || undefined);
          else if (reason === "version") fail("version");
          else fail("handshake", reason || undefined);
        };
        ws.onmessage = (ev) => {
          try {
            // 第 2 帧:验 daemon 身份证明,派生会话密钥,再把 hello 发出去
            if (channel === null) {
              const finished = clientHandshakeFinish(
                hsState,
                String(ev.data),
                this.host.daemonPub,
                {
                  type: "hello",
                  token: this.host.token,
                  clientPubKey: this.keys.publicKey,
                  clientInfo: {
                    platform: Platform.OS === "android" ? "android" : "ios",
                    appVersion: APP_VERSION,
                  },
                },
              );
              channel = finished.channel;
              ws.send(finished.frame);
              return;
            }
            const msg = parseS2C(channel.open(String(ev.data)));
            if (msg.type === "error" && msg.code === "auth_failed") {
              fail("auth", msg.message);
              return;
            }
            if (msg.type !== "hello.ok") {
              fail("handshake", `unexpected ${msg.type}`);
              return;
            }
            clearTimeout(timer);
            if (done) {
              ws.close(); // 竞速落败
              return;
            }
            done = true;
            ws.onmessage = null;
            ws.onclose = null;
            ws.onerror = null;
            resolve({ ws, channel, helloOk: msg, addr, rttMs: Date.now() - startedAt });
          } catch (e) {
            // 身份证明失败是安全事件,不是普通握手错误
            if (e instanceof ProtocolError && e.code === "untrusted") {
              fail("untrusted", e.message);
              return;
            }
            if (e instanceof ProtocolError && e.code === "version") {
              fail("version");
              return;
            }
            fail("handshake", e instanceof ProtocolError ? e.code : undefined);
          }
        };
      }
    });
  }

  private adopt(won: Won): void {
    this.connecting = false;
    this.backoff = BACKOFF_MIN;
    this.everConnected = true;
    this.diagnosis = null;
    this.ws = won.ws;
    this.channel = won.channel;
    this.activeAddr = won.addr;
    this.lastRttMs = won.rttMs;
    this.lastRecvAt = Date.now();

    useApp.getState().setSessions(this.host.id, won.helloOk.sessions);
    this.patch({
      status: "connected",
      hostInfo: won.helloOk.host,
      activeAddr: won.addr,
      lastError: null,
      rttMs: won.rttMs,
    });

    // 记住这个地址,下次优先试(切网后往往还是同一个)
    void rememberGoodAddr(this.host.id, won.addr);

    won.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    won.ws.onclose = () => this.onClose();
    won.ws.onerror = () => {
      // onclose 随后触发
    };

    this.startHeartbeat();
    this.flushQueue();
    this.events.emit("connected", { addr: won.addr, rttMs: won.rttMs });
  }

  /**
   * 心跳:RN 的 WebSocket 不暴露 ping/pong,靠"最近收到任何数据的时间"判活。
   * daemon 每 15s 发一次 ping(ws 协议层),RN 侧收不到 ping 事件,
   * 所以这里额外发一条无副作用的 term.ack 触发对端活动,并检测长时间静默。
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) return;
      const silent = Date.now() - this.lastRecvAt;
      if (silent > SILENCE_LIMIT_MS) {
        // 半开连接:socket 还是 OPEN 但实际已死,主动断开走重连
        this.ws?.close();
        return;
      }
    }, HEARTBEAT_MS);
  }

  private onMessage(text: string): void {
    this.lastRecvAt = Date.now();
    let msg: S2CMessage;
    try {
      msg = parseS2C(this.channel!.open(text));
    } catch {
      this.ws?.close(); // 通道不可信,断开走重连
      return;
    }
    switch (msg.type) {
      case "session.state":
        useApp.getState().upsertSession(this.host.id, msg.session);
        return;
      case "term.snapshot":
        this.events.emit("snapshot", msg);
        return;
      case "term.output":
        this.events.emit("output", msg);
        return;
      case "chat.snapshot":
        this.events.emit("chatSnapshot", msg);
        return;
      case "agent.event":
        this.events.emit("agentEvent", msg);
        return;
      case "tool.output":
        this.events.emit("toolOutput", msg);
        return;
      case "error":
        this.events.emit("serverError", msg);
        return;
      case "hello.ok":
      case "permission.request":
        return;
    }
  }

  private onClose(): void {
    const wasConnected = this.isConnected;
    this.clearTimers();
    this.ws = null;
    this.channel = null;
    this.activeAddr = null;
    if (this.stopped) return;
    this.patch({ status: "reconnecting", activeAddr: null });
    if (wasConnected) this.events.emit("disconnected", { willRetry: true });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const delay = this.backoff + Math.random() * 250;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectOnce();
    }, delay);
  }

  // ---------------------------------------------------------------- 发送 API

  /**
   * @param queueable 断线时是否排队补发。
   * 用户意图(发消息、审批)值得排队;终端按键与 ack 过期即无意义,丢弃。
   */
  send(msg: C2SMessage, queueable = false): boolean {
    if (this.isConnected) {
      this.ws!.send(this.channel!.seal(msg));
      return true;
    }
    if (queueable && this.queue.length < MAX_QUEUE) this.queue.push(msg);
    return false;
  }

  private flushQueue(): void {
    if (this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    for (const m of pending) this.send(m);
  }

  createSession(
    agent: AgentKind,
    cwd?: string,
    command?: string,
    kind?: SessionKind,
    cols = 80,
    rows = 24,
  ): void {
    this.send(
      {
        type: "session.create",
        agent,
        ...(kind ? { kind } : {}),
        ...(cwd ? { cwd } : {}),
        ...(command ? { command } : {}),
        cols,
        rows,
      },
      true,
    );
  }

  attach(sid: string, lastSeq?: number): void {
    this.send({ type: "session.attach", sid, ...(lastSeq !== undefined ? { lastSeq } : {}) });
  }

  chatSend(sid: string, text: string): void {
    this.send({ type: "chat.send", sid, text }, true);
  }

  /** 拉取某次工具调用的完整输出(卡片展开时) */
  getToolOutput(sid: string, callId: string): void {
    this.send({ type: "tool.output.get", sid, callId });
  }

  respondPermission(sid: string, reqId: string, reply: PermissionReply): void {
    this.send({ type: "permission.respond", sid, reqId, reply }, true);
  }

  inputB64(sid: string, dataB64: string): void {
    this.send({ type: "term.input", sid, dataB64 });
  }

  inputText(sid: string, text: string): void {
    this.inputB64(sid, toB64(utf8Encode(text)));
  }

  resize(sid: string, cols: number, rows: number): void {
    this.send({ type: "term.resize", sid, cols, rows });
  }

  ack(sid: string, seq: number): void {
    this.send({ type: "term.ack", sid, seq });
  }

  interrupt(sid: string): void {
    this.send({ type: "session.interrupt", sid }, true);
  }

  kill(sid: string): void {
    this.send({ type: "session.kill", sid }, true);
  }
}

// ---------------------------------------------------------------- 连接注册表

const connections = new Map<string, HostConnection>();

export function getConnection(host: StoredHost, keys: KeyPairB64): HostConnection {
  const existing = connections.get(host.id);
  if (existing) {
    // 重新配对(token/公钥变化)则替换连接
    if (existing.host.token === host.token && existing.host.daemonPub === host.daemonPub) {
      return existing;
    }
    existing.stop();
  }
  const conn = new HostConnection(host, keys);
  connections.set(host.id, conn);
  return conn;
}

export function peekConnection(hostId: string): HostConnection | null {
  return connections.get(hostId) ?? null;
}

export function dropConnection(hostId: string): void {
  connections.get(hostId)?.stop();
  connections.delete(hostId);
}

let appStateWired = false;
/** 回前台立即踢所有连接重连(iOS 后台 socket 数秒即被杀) */
export function wireAppStateReconnect(): void {
  if (appStateWired) return;
  appStateWired = true;
  AppState.addEventListener("change", (state) => {
    if (state === "active") {
      for (const conn of connections.values()) conn.kick();
    }
  });
}
