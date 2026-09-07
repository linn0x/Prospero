import type { RemoteShellHost, RemoteShellMessage, RemoteShellClient } from "./remote-shell-client";
import { RemoteShellClient as DefaultRemoteShellClient } from "./remote-shell-client";
import type { RemoteHostStore } from "./remote-host-store";
import { randomUUID } from "node:crypto";

export type RemoteShellEvent = {
  hostId: string;
  message:
    | RemoteShellMessage
    | { type: "remote.connected"; transport?: "direct" | "relay" | undefined }
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
  creating?: Promise<string> | undefined;
  pendingCreate?: { requestId: string; resolve: (sid: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
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

  async createShell(hostId: string, cwd?: string): Promise<string> {
    await this.connected(hostId);
    const connection = this.clients.get(hostId)!;
    if (connection.creating) return connection.creating;
    const requestId = randomUUID();
    const creating = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pendingCreate = undefined;
        reject(new Error("远程 Shell 创建超时，请先检查远程会话，避免重复创建"));
      }, 15_000);
      connection.pendingCreate = { requestId, resolve, reject, timer };
      try { connection.client.createShell(cwd, 120, 36, requestId); }
      catch (error) { this.rejectCreate(connection, error as Error); }
    }).finally(() => { connection.creating = undefined; });
    connection.creating = creating;
    return creating;
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
    this.rejectCreate(connection, new Error("连接已取消"));
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    this.clients.delete(hostId);
    connection.client.close();
    this.publish({ hostId, message: { type: "remote.closed" } });
  }

  close(): void { for (const hostId of [...this.clients.keys()]) this.disconnect(hostId); }

  private rejectCreate(connection: RemoteConnection, error: Error): void {
    const pending = connection.pendingCreate;
    if (pending) { clearTimeout(pending.timer); connection.pendingCreate = undefined; pending.reject(error); }
  }

  private bindClient(hostId: string, connection: RemoteConnection): void {
    const client = connection.client;
    client.on("connected", () => {
      if (connection.intentionalClose || this.clients.get(hostId) !== connection) return;
      try { this.hosts.markConnected(hostId); }
      catch (error) { this.publish({ hostId, message: { type: "remote.error", message: (error as Error).message } }); }
      this.publish({ hostId, message: { type: "remote.connected", transport: client.transport } });
    });
    client.on("message", (message) => {
      if (connection.intentionalClose || this.clients.get(hostId) !== connection) return;
      this.trackMessage(connection, message);
      const pending = connection.pendingCreate;
      if (message.type === "session.create.result" && pending?.requestId === message.requestId) {
        clearTimeout(pending.timer); connection.pendingCreate = undefined;
        if (message.ok && message.session) pending.resolve(message.session.id);
        else pending.reject(new Error(message.error ?? "远程 Shell 创建失败"));
      } else if (message.type === "error" && pending) {
        this.rejectCreate(connection, new Error(message.message));
      }
      this.publish({ hostId, message });
    });
    client.on("closed", () => {
      if (connection.intentionalClose || this.clients.get(hostId) !== connection) return;
      this.rejectCreate(connection, new Error("连接中断，Shell 可能已经创建，请检查远程会话"));
      this.publish({ hostId, message: { type: "remote.closed" } });
      this.scheduleReconnect(hostId, connection);
    });
    client.on("error", (error) => this.publish({ hostId, message: { type: "remote.error", message: error.message } }));
  }

  private trackMessage(connection: RemoteConnection, message: RemoteShellMessage): void {
    if (message.type === "session.create.result" && message.ok && message.session?.kind === "pty") {
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
      else connection.sessions.set(message.sid, { lastSeq: message.seq });
    }
  }

  private startConnect(hostId: string, connection: RemoteConnection, initial: boolean): Promise<{ name: string; sessions: number }> {
    const connecting = connection.client.connect()
      .then((hello) => {
        if (connection.intentionalClose || this.clients.get(hostId) !== connection) { connection.client.close(); throw new Error("连接已取消"); }
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
          if (this.clients.get(hostId) === connection) this.clients.delete(hostId);
          connection.intentionalClose = true;
        }
        throw error;
      })
      .finally(() => {
        connection.connecting = undefined;
        if (!connection.client.isConnected) this.scheduleReconnect(hostId, connection);
      });
    connection.connecting = connecting;
    return connecting;
  }

  private scheduleReconnect(hostId: string, connection: RemoteConnection): void {
    if (connection.intentionalClose || connection.client.retryable === false || this.clients.get(hostId) !== connection || connection.reconnectTimer || connection.connecting) return;
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
