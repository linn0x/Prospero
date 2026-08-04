/**
 * 主机连接:多地址并发竞速 → 首个完成 E2E 握手者胜;断线指数退避重连;
 * App 回前台立即踢一次重连。每个 attempt 有独立的临时密钥/通道。
 */
import { AppState, Platform } from "react-native";
import {
  clientHandshake,
  parseS2C,
  toB64,
  utf8Encode,
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
  type SecureChannel,
  type SessionKind,
} from "@prospero/protocol";
import { Emitter } from "./emitter";
import type { StoredHost } from "./hosts";
import { useApp } from "./store";

const APP_VERSION = "0.0.1";
const ATTEMPT_TIMEOUT_MS = 8000;
const BACKOFF_MIN = 500;
const BACKOFF_MAX = 8000;

interface Won {
  ws: WebSocket;
  channel: SecureChannel;
  helloOk: S2CHelloOk;
  addr: string;
}

class FatalConnectError extends Error {
  fatal = true as const;
}

export interface ConnEvents extends Record<string, unknown> {
  connected: { addr: string };
  disconnected: { willRetry: boolean };
  snapshot: S2CTermSnapshot;
  output: S2CTermOutput;
  chatSnapshot: S2CChatSnapshot;
  agentEvent: S2CAgentEvent;
  serverError: S2CError;
}

export class HostConnection {
  readonly events = new Emitter<ConnEvents>();
  activeAddr: string | null = null;

  private ws: WebSocket | null = null;
  private channel: SecureChannel | null = null;
  private connecting = false;
  private stopped = false;
  private backoff = BACKOFF_MIN;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly host: StoredHost,
    private readonly keys: KeyPairB64,
  ) {}

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1 && this.channel !== null;
  }

  start(): void {
    this.stopped = false;
    if (this.connecting || this.isConnected) return;
    void this.connectOnce();
  }

  /** 回前台/用户手动重试:清退避立即连 */
  kick(): void {
    this.backoff = BACKOFF_MIN;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.channel = null;
    this.activeAddr = null;
    useApp.getState().patchRuntime(this.host.id, { status: "idle", activeAddr: null });
  }

  private patch(patch: Parameters<ReturnType<typeof useApp.getState>["patchRuntime"]>[1]): void {
    useApp.getState().patchRuntime(this.host.id, patch);
  }

  private async connectOnce(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    this.patch({
      status: this.backoff === BACKOFF_MIN ? "connecting" : "reconnecting",
    });
    try {
      const won = await this.race();
      this.adopt(won);
    } catch (e) {
      this.connecting = false;
      const fatal = e instanceof FatalConnectError;
      this.patch({
        status: "failed",
        lastError: e instanceof Error ? e.message : String(e),
      });
      if (!fatal && !this.stopped) this.scheduleRetry();
    }
  }

  private race(): Promise<Won> {
    const addrs = [...new Set(this.host.addrs)];
    return new Promise<Won>((resolve, reject) => {
      if (addrs.length === 0) {
        reject(new Error("主机没有可用地址"));
        return;
      }
      let pending = addrs.length;
      let done = false;
      let lastError: Error = new Error("全部地址连接失败");

      for (const addr of addrs) {
        let ws: WebSocket;
        try {
          ws = new WebSocket(`ws://${addr}:${this.host.port}/ws`);
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (--pending === 0 && !done) reject(lastError);
          continue;
        }
        const { frame, channel } = clientHandshake(this.host.daemonPub, {
          type: "hello",
          token: this.host.token,
          clientPubKey: this.keys.publicKey,
          clientInfo: {
            platform: Platform.OS === "android" ? "android" : "ios",
            appVersion: APP_VERSION,
          },
        });
        const timer = setTimeout(() => fail(new Error(`${addr} 超时`)), ATTEMPT_TIMEOUT_MS);
        const fail = (e: Error): void => {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            // ignore
          }
          if (done) return;
          lastError = e instanceof FatalConnectError ? e : lastError.message === "全部地址连接失败" ? e : lastError;
          if (e instanceof FatalConnectError) {
            done = true;
            reject(e);
            return;
          }
          if (--pending === 0) reject(lastError);
        };
        ws.onopen = () => ws.send(frame);
        ws.onerror = () => fail(new Error(`${addr} 连接失败`));
        ws.onclose = () => fail(new Error(`${addr} 连接被关闭`));
        ws.onmessage = (ev) => {
          try {
            const msg = parseS2C(channel.open(String(ev.data)));
            if (msg.type === "error" && msg.code === "auth_failed") {
              fail(new FatalConnectError("配对已失效(token 无效或设备密钥变化),请重新扫码配对"));
              return;
            }
            if (msg.type !== "hello.ok") {
              fail(new Error(`${addr} 意外的首条消息: ${msg.type}`));
              return;
            }
            clearTimeout(timer);
            if (done) {
              ws.close(); // 竞速落败的连接
              return;
            }
            done = true;
            ws.onmessage = null;
            ws.onclose = null;
            ws.onerror = null;
            resolve({ ws, channel, helloOk: msg, addr });
          } catch (e) {
            fail(e instanceof Error ? e : new Error(String(e)));
          }
        };
      }
    });
  }

  private adopt(won: Won): void {
    this.connecting = false;
    this.backoff = BACKOFF_MIN;
    this.ws = won.ws;
    this.channel = won.channel;
    this.activeAddr = won.addr;
    useApp.getState().setSessions(this.host.id, won.helloOk.sessions);
    this.patch({
      status: "connected",
      hostInfo: won.helloOk.host,
      activeAddr: won.addr,
      lastError: null,
    });
    won.ws.onmessage = (ev) => this.onMessage(String(ev.data));
    won.ws.onclose = () => this.onClose();
    won.ws.onerror = () => {
      // onclose 会随后触发
    };
    this.events.emit("connected", { addr: won.addr });
  }

  private onMessage(text: string): void {
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

  send(msg: C2SMessage): boolean {
    if (!this.isConnected) return false;
    this.ws!.send(this.channel!.seal(msg));
    return true;
  }

  createSession(
    agent: AgentKind,
    cwd?: string,
    command?: string,
    kind?: SessionKind,
    cols = 80,
    rows = 24,
  ): void {
    this.send({
      type: "session.create",
      agent,
      ...(kind ? { kind } : {}),
      ...(cwd ? { cwd } : {}),
      ...(command ? { command } : {}),
      cols,
      rows,
    });
  }

  chatSend(sid: string, text: string): void {
    this.send({ type: "chat.send", sid, text });
  }

  respondPermission(sid: string, reqId: string, reply: PermissionReply): void {
    this.send({ type: "permission.respond", sid, reqId, reply });
  }

  attach(sid: string, lastSeq?: number): void {
    this.send({ type: "session.attach", sid, ...(lastSeq !== undefined ? { lastSeq } : {}) });
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
    this.send({ type: "session.interrupt", sid });
  }

  kill(sid: string): void {
    this.send({ type: "session.kill", sid });
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
