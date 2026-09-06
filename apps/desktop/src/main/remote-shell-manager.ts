import type { RemoteShellHost, RemoteShellMessage, RemoteShellClient } from "./remote-shell-client";
import { RemoteShellClient as DefaultRemoteShellClient } from "./remote-shell-client";
import { RemoteHostStore } from "./remote-host-store";

export type RemoteShellEvent = {
  hostId: string;
  message:
    | RemoteShellMessage
    | { type: "remote.connected" }
    | { type: "remote.closed" }
    | { type: "remote.reconnecting"; attempt: number; delayMs: number }
    | { type: "remote.error"; message: string };
};

type TrackedSession = { lastSeq: number };
type RemoteConnection = {
  host: RemoteShellHost;
  client: RemoteShellClient;
  sessions: Map<string, TrackedSession>;
  connecting: Promise<{ name: string; sessions: number }> | undefined;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  reconnectAttempt: number;
  intentionalClose: boolean;
};

export type RemoteShellClientFactory = (host: RemoteShellHost) => RemoteShellClient;

const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];
const TERMINAL_SESSION_STATUSES = new Set(["completed", "done", "died", "failed", "killed", "cancelled", "error"]);

/**
 * Owns desktop remote connections. A transport drop is recoverable: the
 * manager reconnects with bounded backoff and re-attaches every live shell at
 * its last received output sequence, allowing the daemon ring to replay the
 * missing bytes (or return a fresh snapshot when the gap is too old).
 */
export class RemoteShellManager {
  private readonly clients = new Map<string, RemoteConnection>();

  constructor(
    private readonly hosts: RemoteHostStore,
    private readonly publish: (event: RemoteShellEvent) => void,
    private readonly createClient: RemoteShellClientFactory = (host) => new DefaultRemoteShellClient(host),
  ) {}

  async connect(hostId: string): Promise<{ name: string; sessions: number }> {
    const existing = this.clients.get(hostId);
    if (existing) {
      if (existing.client.isConnected) return { name: existing.host.name, sessions: existing.sessions.size };
      if (existing.connecting) return existing.connecting;
      if (existing.reconnectTimer) {
        clearTimeout(existing.reconnectTimer);
        existing.reconnectTimer = undefined;
      }
      return this.startConnect(hostId, existing, false);
    }
    const host = this.hosts.get(hostId);
    if (!host) throw new Error("远程主机不存在，请重新配对");
    const connection: RemoteConnection = {
      host,
      client: this.createClient(host),
      sessions: new Map(),
      connecting: undefined,
      reconnectTimer: undefined,
      reconnectAttempt: 0,
      intentionalClose: false,
    };
    this.clients.set(hostId, connection);
    this.bindClient(hostId, connection);
    return this.startConnect(hostId, connection, true);
  }

  async createShell(hostId: string, cwd?: string): Promise<void> {
    const client = await this.connected(hostId);
    client.createShell(cwd);
  }

  input(hostId: string, sid: string, dataB64: string): void {
    void this.require(hostId).input(sid, dataB64);
  }

  resize(hostId: string, sid: string, cols: number, rows: number): void {
    void this.require(hostId).resize(sid, cols, rows);
  }

  kill(hostId: string, sid: string): void {
    void this.require(hostId).kill(sid);
    const connection = this.clients.get(hostId);
    connection?.sessions.delete(sid);
  }

  disconnect(hostId: string): void {
    const connection = this.clients.get(hostId);
    if (!connection) return;
    connection.intentionalClose = true;
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    this.clients.delete(hostId);
    connection.client.close();
  }

  private bindClient(hostId: string, connection: RemoteConnection): void {
    const client = connection.client;
    client.on("connected", () => {
      this.hosts.markConnected(hostId);
      this.publish({ hostId, message: { type: "remote.connected" } });
    });
    client.on("message", (message) => {
      this.trackMessage(connection, message);
      // Shell creation is correlated by the daemon's result message. Attach
      // immediately so the first terminal snapshot follows without a second
      // renderer round-trip.
      if (message.type === "session.create.result" && message.ok && message.session) {
        connection.sessions.set(message.session.id, { lastSeq: 0 });
        client.attach(message.session.id);
      }
      this.publish({ hostId, message });
    });
    client.on("closed", () => {
      if (connection.intentionalClose || this.clients.get(hostId) !== connection) return;
      this.publish({ hostId, message: { type: "remote.closed" } });
      this.scheduleReconnect(hostId, connection);
    });
    client.on("error", (error) => this.publish({ hostId, message: { type: "remote.error", message: error.message } }));
  }

  private trackMessage(connection: RemoteConnection, message: RemoteShellMessage): void {
    if (message.type === "session.create.result" && message.ok && message.session) {
      connection.sessions.set(message.session.id, { lastSeq: 0 });
      return;
    }
    if (message.type === "session.state") {
      const sid = message.session.id;
      if (TERMINAL_SESSION_STATUSES.has(message.session.status)) connection.sessions.delete(sid);
      return;
    }
    if (message.type === "term.snapshot" || message.type === "term.output") {
      const tracked = connection.sessions.get(message.sid);
      if (tracked) tracked.lastSeq = Math.max(tracked.lastSeq, message.seq);
    }
  }

  private startConnect(hostId: string, connection: RemoteConnection, initial: boolean): Promise<{ name: string; sessions: number }> {
    const connecting = connection.client.connect()
      .then((hello) => {
        connection.reconnectAttempt = 0;
        if (connection.reconnectTimer) {
          clearTimeout(connection.reconnectTimer);
          connection.reconnectTimer = undefined;
        }
        if (!initial) {
          for (const [sid, tracked] of connection.sessions) {
            try { connection.client.attach(sid, tracked.lastSeq); }
            catch (error) { this.publish({ hostId, message: { type: "remote.error", message: error instanceof Error ? error.message : String(error) } }); }
          }
        }
        return { name: hello.host.name, sessions: hello.sessions.length };
      })
      .catch((error: unknown) => {
        if (initial) {
          this.clients.delete(hostId);
          connection.intentionalClose = true;
        } else {
          this.scheduleReconnect(hostId, connection);
        }
        throw error;
      })
      .finally(() => { connection.connecting = undefined; });
    connection.connecting = connecting;
    return connecting;
  }

  private scheduleReconnect(hostId: string, connection: RemoteConnection): void {
    if (connection.intentionalClose || this.clients.get(hostId) !== connection || connection.reconnectTimer || connection.connecting) return;
    const attempt = connection.reconnectAttempt + 1;
    connection.reconnectAttempt = attempt;
    const delayMs = RECONNECT_DELAYS_MS[Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)]!;
    this.publish({ hostId, message: { type: "remote.reconnecting", attempt, delayMs } });
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = undefined;
      void this.startConnect(hostId, connection, false).catch(() => { /* next retry is scheduled by startConnect */ });
    }, delayMs);
    connection.reconnectTimer.unref?.();
  }

  private async connected(hostId: string): Promise<RemoteShellClient> {
    const existing = this.clients.get(hostId);
    if (existing?.client.isConnected) return existing.client;
    await this.connect(hostId);
    return this.require(hostId);
  }

  private require(hostId: string): RemoteShellClient {
    const client = this.clients.get(hostId)?.client;
    if (!client?.isConnected) throw new Error("远程主机尚未连接");
    return client;
  }
}
