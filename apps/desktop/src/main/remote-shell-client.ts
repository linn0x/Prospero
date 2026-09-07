import { randomUUID } from "node:crypto";
import {
  SUPPORTED_PROTOCOL_VERSIONS, clientHandshakeFinish, clientHandshakeStart, generateKeyPairB64,
  parseS2C, parseRelayControlMessage, RELAY_PROTOCOL_VERSION, validateRelayUrl,
  CLOSE_AUTH_FAILED, CLOSE_REVOKED, ProtocolError,
  type C2SMessage, type KeyPairB64, type S2CMessage, type SecureChannel, type RelayPairing,
} from "@prospero/protocol";

export type RemoteShellHost = {
  id: string; name: string; addrs: string[]; port: number; token: string; daemonPubKey: string;
  relay?: RelayPairing;
  /** Stable device identity, encrypted on disk; never sent over renderer IPC. */
  clientKeys?: KeyPairB64;
};
export type RemoteShellMessage = Extract<S2CMessage,
  { type: "session.state" | "session.create.result" | "term.snapshot" | "term.output" | "error" }>;
export interface RemoteSocket {
  readyState: number;
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
}
export type RemoteSocketFactory = (url: string) => RemoteSocket;
type Hello = Extract<S2CMessage, { type: "hello.ok" }>;
export type RemoteShellClientEvents = {
  connected: (message: Hello) => void;
  message: (message: RemoteShellMessage) => void;
  closed: () => void;
  error: (error: Error) => void;
};
export class RemoteConnectionError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}
const terminalMessageTypes = new Set(["session.state", "session.create.result", "term.snapshot", "term.output", "error"]);

/** E2E desktop client. LAN candidates race; relay joins after a short head start. */
export class RemoteShellClient {
  private readonly clientKeys: KeyPairB64;
  private socket: RemoteSocket | null = null;
  private channel: SecureChannel | null = null;
  private hello: Hello | undefined;
  private pending: Promise<Hello> | undefined;
  private readonly attempts = new Set<() => void>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastReceivedAt = 0;
  private pendingPing: { id: string; at: number } | undefined;
  private generation = 0;
  transport: "direct" | "relay" | undefined;
  retryable = true;
  private listeners: { [K in keyof RemoteShellClientEvents]: Set<RemoteShellClientEvents[K]> } = {
    connected: new Set(), message: new Set(), closed: new Set(), error: new Set(),
  };

  constructor(readonly host: RemoteShellHost,
    private readonly openSocket: RemoteSocketFactory = (url) => new WebSocket(url) as unknown as RemoteSocket,
    clientKeys = host.clientKeys ?? generateKeyPairB64(),
  ) { this.clientKeys = clientKeys; }

  get isConnected(): boolean { return this.channel !== null && this.socket?.readyState === 1; }
  on<K extends keyof RemoteShellClientEvents>(event: K, listener: RemoteShellClientEvents[K]): () => void {
    this.listeners[event].add(listener);
    return () => { this.listeners[event].delete(listener); };
  }

  connect(): Promise<Hello> {
    if (this.isConnected && this.hello) return Promise.resolve(this.hello);
    if (this.pending) return this.pending;
    this.retryable = true;
    const generation = ++this.generation;
    const candidates = [...new Set(this.host.addrs)].map((addr) => ({
      url: `ws://${addr.includes(":") && !addr.startsWith("[") ? `[${addr}]` : addr}:${this.host.port}/ws`, relay: undefined as RelayPairing | undefined,
    }));
    if (this.host.relay) {
      const parsed = new URL(validateRelayUrl(this.host.relay.url));
      const path = parsed.pathname.replace(/\/$/, "");
      parsed.pathname = path.endsWith("/v1/client") ? path : path.endsWith("/v1") ? `${path}/client` : "/v1/client";
      candidates.push({ url: parsed.toString(), relay: this.host.relay });
    }
    if (!candidates.length) return Promise.reject(new Error("remote host has no LAN address or relay"));
    const promise = Promise.any(candidates.map((candidate) => this.connectAddress(candidate.url, generation, candidate.relay)))
      .catch((reason: unknown) => {
        const errors = reason instanceof AggregateError ? reason.errors as Error[] : [reason as Error];
        const fatal = errors.find((error) => error instanceof RemoteConnectionError && !error.retryable);
        const error = fatal ?? errors.at(-1) ?? new Error("远程主机连接失败");
        if (generation === this.generation) {
          this.retryable = !fatal;
          this.emit("error", error);
        }
        throw error;
      }).finally(() => { if (this.pending === promise) this.pending = undefined; });
    this.pending = promise;
    return promise;
  }

  close(): void {
    ++this.generation;
    for (const cancel of [...this.attempts]) cancel();
    this.pending = undefined;
    this.dropSocket();
    this.emit("closed");
  }
  createShell(cwd?: string, cols = 120, rows = 36, requestId = randomUUID()): string {
    this.send({ type: "session.create", requestId, agent: "shell", kind: "pty", cols, rows, ...(cwd ? { cwd } : {}) });
    return requestId;
  }
  attach(sid: string, lastSeq?: number): void { this.send({ type: "session.attach", sid, ...(lastSeq === undefined ? {} : { lastSeq }) }); }
  input(sid: string, dataB64: string): void { this.send({ type: "term.input", sid, dataB64 }); }
  resize(sid: string, cols: number, rows: number): void { this.send({ type: "term.resize", sid, cols, rows }); }
  kill(sid: string): void { this.send({ type: "session.kill", sid }); }

  private connectAddress(url: string, generation: number, relay?: RelayPairing): Promise<Hello> {
    return new Promise((resolve, reject) => {
      let socket: RemoteSocket | undefined;
      let done = false;
      let channel: SecureChannel | undefined;
      let relayReady = !relay;
      const { frame, state } = clientHandshakeStart(SUPPORTED_PROTOCOL_VERSIONS[0]);
      const fail = (error: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearTimeout(startTimer); this.attempts.delete(cancel);
        if (socket) { this.detach(socket); try { socket.close(); } catch { /* closed */ } }
        reject(error);
      };
      const cancel = (): void => fail(new RemoteConnectionError("连接已取消", false));
      const timer = setTimeout(() => fail(new Error("远程连接超时，请检查电脑与网络")), 6_000);
      this.attempts.add(cancel);
      const startTimer = setTimeout(() => {
        if (generation !== this.generation) { cancel(); return; }
        try {
          socket = this.openSocket(url);
          socket.binaryType = "arraybuffer";
          socket.onopen = () => {
            try {
              socket!.send(relay ? JSON.stringify({ type: "client.open", v: RELAY_PROTOCOL_VERSION,
                routeId: relay.routeId, deviceId: relay.deviceId, token: relay.token }) : frame);
            } catch (e) { fail(e as Error); }
          };
          socket.onerror = () => fail(new Error("无法连接远程电脑，请检查网络"));
          socket.onclose = (event) => fail(new RemoteConnectionError(
            event.code === CLOSE_AUTH_FAILED || event.code === CLOSE_REVOKED
              ? "配对已失效或被撤销，请在远程电脑生成新的配对串" : "远程电脑关闭了连接",
            event.code !== CLOSE_AUTH_FAILED && event.code !== CLOSE_REVOKED,
          ));
          socket.onmessage = (event) => {
            try {
              const text = this.frameText(event.data);
              if (!relayReady) {
                const control = parseRelayControlMessage(JSON.parse(text));
                if (control.type === "client.status" && control.status === "pending") return;
                if (control.type === "stream.ready") { relayReady = true; socket!.send(frame); return; }
                throw new Error(control.type === "error" ? control.message : "中继握手失败");
              }
              if (!channel) {
                const finished = clientHandshakeFinish(state, text, this.host.daemonPubKey, {
                  type: "hello", token: this.host.token, clientPubKey: this.clientKeys.publicKey,
                  clientInfo: { platform: "desktop", appVersion: "0.0.13" },
                });
                channel = finished.channel;
                socket!.send(finished.frame);
                return;
              }
              const message = parseS2C(channel.open(text));
              if (message.type === "error" && message.code === "auth_failed") throw new RemoteConnectionError("配对已失效，请重新配对", false);
              if (message.type !== "hello.ok") throw new Error(`unexpected remote handshake message: ${message.type}`);
              if (generation !== this.generation || this.isConnected) { cancel(); return; }
              done = true; clearTimeout(timer); this.attempts.delete(cancel);
              this.socket = socket!; this.channel = channel; this.hello = message; this.transport = relay ? "relay" : "direct";
              this.installConnected(socket!);
              for (const abort of [...this.attempts]) abort();
              resolve(message); this.emit("connected", message);
            } catch (e) {
              fail(e instanceof ProtocolError && ["untrusted", "version"].includes(e.code)
                ? new RemoteConnectionError("远程身份或协议不兼容，请更新电脑端并重新配对", false) : e as Error);
            }
          };
        } catch (e) { fail(e as Error); }
      }, relay && this.host.addrs.length ? 750 : 0);
    });
  }

  private installConnected(socket: RemoteSocket): void {
    this.lastReceivedAt = Date.now(); this.pendingPing = undefined;
    socket.onopen = null;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      if (event.code === CLOSE_AUTH_FAILED || event.code === CLOSE_REVOKED) {
        this.retryable = false;
        this.emit("error", new RemoteConnectionError("配对已撤销，请重新配对", false));
      }
      this.dropSocket(); this.emit("closed");
    };
    socket.onerror = () => { if (this.socket === socket) { this.dropSocket(); this.emit("closed"); } };
    socket.onmessage = (event) => {
      if (this.socket !== socket || !this.channel) return;
      try {
        const message = parseS2C(this.channel.open(this.frameText(event.data)));
        this.lastReceivedAt = Date.now();
        if (message.type === "connection.pong") { if (message.id === this.pendingPing?.id) this.pendingPing = undefined; return; }
        if (message.type === "error" && message.code === "auth_failed") this.retryable = false;
        if (terminalMessageTypes.has(message.type)) this.emit("message", message as RemoteShellMessage);
        if (message.type === "term.output" || message.type === "term.snapshot") this.send({ type: "term.ack", sid: message.sid, seq: message.seq });
      } catch (e) {
        this.emit("error", e as Error);
        this.dropSocket(); this.emit("closed");
      }
    };
    this.heartbeat = setInterval(() => {
      if (this.pendingPing && Date.now() - this.pendingPing.at > 15_000) { this.dropSocket(); this.emit("closed"); return; }
      if (!this.pendingPing && Date.now() - this.lastReceivedAt > 10_000) {
        this.pendingPing = { id: randomUUID(), at: Date.now() };
        try { this.send({ type: "connection.ping", id: this.pendingPing.id }); }
        catch { this.dropSocket(); this.emit("closed"); }
      }
    }, 5_000);
    this.heartbeat.unref?.();
  }
  private frameText(data: unknown): string {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    throw new Error("invalid remote WebSocket frame");
  }
  private send(message: C2SMessage): void {
    if (!this.socket || !this.channel || this.socket.readyState !== 1) throw new Error("远程主机尚未连接");
    this.socket.send(this.channel.seal(message));
  }
  private detach(socket: RemoteSocket): void { socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; }
  private dropSocket(): void {
    const socket = this.socket; this.socket = null; this.channel = null; this.hello = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (socket) { this.detach(socket); try { socket.close(); } catch { /* closed */ } }
  }
  private emit<K extends keyof RemoteShellClientEvents>(event: K, value?: Parameters<RemoteShellClientEvents[K]>[0]): void {
    for (const listener of this.listeners[event]) {
      if (value === undefined) (listener as () => void)();
      else (listener as (input: Parameters<RemoteShellClientEvents[K]>[0]) => void)(value);
    }
  }
}
