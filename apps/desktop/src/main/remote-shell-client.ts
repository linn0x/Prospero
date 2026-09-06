import {
  SUPPORTED_PROTOCOL_VERSIONS,
  clientHandshakeFinish,
  clientHandshakeStart,
  generateKeyPairB64,
  parseS2C,
  type C2SMessage,
  type KeyPairB64,
  type S2CMessage,
  type SecureChannel,
} from "@prospero/protocol";

export type RemoteShellHost = {
  id: string;
  name: string;
  addrs: string[];
  port: number;
  token: string;
  daemonPubKey: string;
};

export type RemoteShellMessage = Extract<
  S2CMessage,
  { type: "hello.ok" | "session.state" | "session.create.result" | "term.snapshot" | "term.output" | "error" }
>;

export interface RemoteSocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type RemoteSocketFactory = (url: string) => RemoteSocket;

export type RemoteShellClientEvents = {
  connected: (message: Extract<S2CMessage, { type: "hello.ok" }>) => void;
  message: (message: RemoteShellMessage) => void;
  closed: () => void;
  error: (error: Error) => void;
};

const OPEN = 1;
const HANDSHAKE_TIMEOUT_MS = 6_000;

/**
 * Desktop-to-desktop client for the existing daemon protocol.
 *
 * The renderer never receives the pairing token or SecureChannel. Keeping the
 * client in Electron main makes the desktop path use the same trust boundary
 * as mobile: the daemon public key is pinned before the encrypted hello.
 */
export class RemoteShellClient {
  private readonly clientKeys: KeyPairB64;
  private socket: RemoteSocket | null = null;
  private channel: SecureChannel | null = null;
  private connected = false;
  private listeners: { [K in keyof RemoteShellClientEvents]: Set<RemoteShellClientEvents[K]> } = {
    connected: new Set(), message: new Set(), closed: new Set(), error: new Set(),
  };

  constructor(
    readonly host: RemoteShellHost,
    private readonly openSocket: RemoteSocketFactory = (url) => new WebSocket(url) as unknown as RemoteSocket,
    clientKeys = generateKeyPairB64(),
  ) {
    this.clientKeys = clientKeys;
  }

  get isConnected(): boolean { return this.connected && this.channel !== null; }

  on<K extends keyof RemoteShellClientEvents>(event: K, listener: RemoteShellClientEvents[K]): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  async connect(): Promise<Extract<S2CMessage, { type: "hello.ok" }>> {
    if (this.isConnected) throw new Error("remote host is already connected");
    if (this.host.addrs.length === 0) throw new Error("remote host has no LAN address");
    let lastError: Error | undefined;
    for (const addr of this.host.addrs) {
      try {
        return await this.connectAddress(addr);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.closeSocket();
      }
    }
    throw lastError ?? new Error("remote host connection failed");
  }

  close(): void {
    this.closeSocket();
    this.emit("closed");
  }

  createShell(cwd?: string, cols = 120, rows = 36): void {
    this.send({ type: "session.create", agent: "shell", kind: "pty", cols, rows, ...(cwd ? { cwd } : {}) });
  }

  attach(sid: string, lastSeq?: number): void {
    this.send({ type: "session.attach", sid, ...(lastSeq === undefined ? {} : { lastSeq }) });
  }

  input(sid: string, dataB64: string): void {
    this.send({ type: "term.input", sid, dataB64 });
  }

  resize(sid: string, cols: number, rows: number): void {
    this.send({ type: "term.resize", sid, cols, rows });
  }

  kill(sid: string): void {
    this.send({ type: "session.kill", sid });
  }

  private async connectAddress(addr: string): Promise<Extract<S2CMessage, { type: "hello.ok" }>> {
    const url = `ws://${addr}:${String(this.host.port)}/ws`;
    const socket = this.openSocket(url);
    this.socket = socket;
    return await new Promise((resolve, reject) => {
      let settled = false;
      let opened = false;
      let channel: SecureChannel | null = null;
      const { frame, state } = clientHandshakeStart(SUPPORTED_PROTOCOL_VERSIONS[0]);
      const timer = setTimeout(() => fail(new Error("remote host handshake timed out")), HANDSHAKE_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true; cleanup(); reject(error); this.emit("error", error);
      };
      socket.onopen = () => {
        opened = true;
        try { socket.send(frame); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      };
      socket.onerror = () => fail(new Error(`unable to reach remote host at ${addr}`));
      socket.onclose = (event) => {
        if (!settled) fail(new Error(event.reason || (opened ? "remote host closed during handshake" : "remote host is offline")));
        else this.handleClosed();
      };
      socket.onmessage = (event) => {
        try {
          const text = String(event.data);
          if (channel === null) {
            const finished = clientHandshakeFinish(state, text, this.host.daemonPubKey, {
              type: "hello",
              token: this.host.token,
              clientPubKey: this.clientKeys.publicKey,
              clientInfo: { platform: "desktop", appVersion: "0.0.13" },
            });
            channel = finished.channel;
            socket.send(finished.frame);
            return;
          }
          const message = parseS2C(channel.open(text));
          if (message.type !== "hello.ok") {
            fail(new Error(`unexpected remote handshake message: ${message.type}`));
            return;
          }
          settled = true; cleanup(); this.channel = channel; this.connected = true;
          this.emit("connected", message); resolve(message);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
    });
  }

  private send(message: C2SMessage): void {
    if (!this.socket || !this.channel || !this.connected || this.socket.readyState !== OPEN) {
      throw new Error("remote host is not connected");
    }
    this.socket.send(this.channel.seal(message));
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null; this.channel = null; this.connected = false;
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      try { socket.close(); } catch { /* best effort */ }
    }
  }

  private handleClosed(): void {
    this.socket = null; this.channel = null;
    if (!this.connected) return;
    this.connected = false; this.emit("closed");
  }

  private emit<K extends keyof RemoteShellClientEvents>(event: K, value?: Parameters<RemoteShellClientEvents[K]>[0]): void {
    for (const listener of this.listeners[event]) {
      if (value === undefined) (listener as () => void)();
      else (listener as (input: Parameters<RemoteShellClientEvents[K]>[0]) => void)(value);
    }
  }
}
