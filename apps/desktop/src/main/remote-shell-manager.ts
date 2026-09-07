import type { RemoteShellHost, RemoteShellMessage, RemoteShellClient } from "./remote-shell-client";
import { RemoteShellClient as DefaultRemoteShellClient } from "./remote-shell-client";
import type { RemoteHostStore } from "./remote-host-store";
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "@prospero/protocol";
import { normalizedRemoteCwd, remoteDirectoryRequest, type RemoteDirectoryListing, type RemoteDirectoryRequest } from "../shared/remote-workspaces";

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
  catalog: Map<string, SessionInfo>;
  connecting: Promise<{ name: string; sessions: number }> | undefined;
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  reconnectAttempt: number;
  intentionalClose: boolean;
  creating: Map<string, Promise<string>>;
  uncertainCreates: Map<string, string>;
  controlTail: Promise<void>;
  pendingBrowse?: { path: string; root: string; resolve: (listing: RemoteDirectoryListing) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  pendingCreate?: { requestId: string; cwd: string; resolve: (sid: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
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
  private readonly owners = new Map<string, Map<string, number>>();
  private ownerSequence = 0;

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
      catalog: new Map(),
      connecting: undefined,
      reconnectTimer: undefined,
      reconnectAttempt: 0,
      intentionalClose: false,
      creating: new Map(),
      uncertainCreates: new Map(),
      controlTail: Promise.resolve(),
    };
    this.clients.set(hostId, connection);
    this.bindClient(hostId, connection);
    return this.startConnect(hostId, connection, true);
  }

  async createShell(hostId: string, cwd?: string): Promise<string> {
    await this.connected(hostId);
    const connection = this.clients.get(hostId)!;
    const key = cwd ?? "";
    if (connection.uncertainCreates.has(key)) throw new Error("上次 Shell 创建结果尚未确认，请检查远程会话后重连 / Previous shell creation is unconfirmed; check remote sessions and reconnect");
    const previous = connection.creating.get(key);
    if (previous) return previous;
    const creating = this.control(hostId, connection, async () => {
      const requestId = randomUUID();
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          connection.pendingCreate = undefined;
          connection.uncertainCreates.set(key, requestId);
          reject(new Error("远程 Shell 创建超时，请先检查远程会话，避免重复创建"));
        }, 15_000);
        connection.pendingCreate = { requestId, cwd: key, resolve, reject, timer };
        try { connection.client.createShell(cwd, 120, 36, requestId); }
        catch (error) { this.rejectCreate(connection, error as Error); }
      });
    }).finally(() => { if (connection.creating.get(key) === creating) connection.creating.delete(key); });
    connection.creating.set(key, creating);
    return creating;
  }

  async listShells(hostId: string): Promise<SessionInfo[]> {
    await this.connected(hostId);
    return [...this.clients.get(hostId)!.catalog.values()].slice(0, 128);
  }

  async listWorkspaceShells(hostId: string, cwd: string): Promise<SessionInfo[]> {
    await this.connected(hostId);
    const target = normalizedRemoteCwd(cwd);
    return [...this.clients.get(hostId)!.catalog.values()].filter(session => {
      try { return session.agent === "shell" && normalizedRemoteCwd(session.cwd) === target; } catch { return false; }
    }).slice(0, 128);
  }

  async listWorkspace(input: RemoteDirectoryRequest): Promise<RemoteDirectoryListing> {
    const request = remoteDirectoryRequest(input);
    await this.connected(request.hostId);
    const connection = this.clients.get(request.hostId)!;
    return this.control(request.hostId, connection, async () => new Promise<RemoteDirectoryListing>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pendingBrowse = undefined;
        reject(new Error("远程目录读取超时，请重试 / Remote directory request timed out"));
        connection.client.close();
      }, 10_000);
      connection.pendingBrowse = { path: request.path, root: request.root, resolve, reject, timer };
      try { connection.client.listWorkspace(request.path, request.root); }
      catch (error) { this.rejectBrowse(connection, error instanceof Error ? error : new Error("远程目录读取失败")); }
    }));
  }

  async attach(hostId: string, sid: string, ownerId = "legacy"): Promise<void> {
    const key = `${hostId}\0${sid}`;
    const owners = this.owners.get(key) ?? new Map<string, number>();
    if (!owners.has(ownerId)) owners.set(ownerId, ++this.ownerSequence);
    const sequence = owners.get(ownerId);
    this.owners.set(key, owners);
    const client = await this.connected(hostId);
    if (this.owners.get(key)?.get(ownerId) !== sequence) return;
    const connection = this.clients.get(hostId)!;
    if (!connection.catalog.has(sid)) { this.detach(hostId, sid, ownerId); throw new Error("远程终端不存在，请刷新会话列表"); }
    if (!connection.sessions.has(sid)) connection.sessions.set(sid, { lastSeq: 0 });
    client.attach(sid);
  }

  detach(hostId: string, sid: string, ownerId = "legacy"): void {
    const key = `${hostId}\0${sid}`;
    const owners = this.owners.get(key);
    if (!owners?.delete(ownerId)) return;
    if (owners.size === 0) { this.owners.delete(key); this.clients.get(hostId)?.sessions.delete(sid); }
  }

  input(hostId: string, sid: string, dataB64: string, ownerId?: string): void {
    if (ownerId && !this.activeOwner(hostId, sid, ownerId)) throw new Error("终端当前由另一视图控制 / Another view controls this terminal");
    void this.require(hostId).input(sid, dataB64);
  }

  resize(hostId: string, sid: string, cols: number, rows: number, ownerId?: string): void {
    if (ownerId && !this.activeOwner(hostId, sid, ownerId)) return;
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
    this.rejectBrowse(connection, new Error("连接已取消"));
    for (const key of this.owners.keys()) if (key.startsWith(`${hostId}\0`)) this.owners.delete(key);
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

  private rejectBrowse(connection: RemoteConnection, error: Error): void {
    const pending = connection.pendingBrowse;
    if (pending) { clearTimeout(pending.timer); connection.pendingBrowse = undefined; pending.reject(error); }
  }

  private activeOwner(hostId: string, sid: string, ownerId: string): boolean {
    const owners = this.owners.get(`${hostId}\0${sid}`);
    return Boolean(owners?.has(ownerId) && owners.get(ownerId) === Math.max(...owners.values()));
  }

  private control<T>(hostId: string, connection: RemoteConnection, action: () => Promise<T>): Promise<T> {
    const result = connection.controlTail.then(async () => {
      if (connection.intentionalClose || this.clients.get(hostId) !== connection) throw new Error("远程连接已取消");
      await this.connected(hostId);
      if (connection.intentionalClose || this.clients.get(hostId) !== connection) throw new Error("远程连接已取消");
      return action();
    });
    connection.controlTail = result.then(() => {}, () => {});
    return result;
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
      if (message.type === "session.create.result") {
        for (const [cwd, requestId] of connection.uncertainCreates) if (requestId === message.requestId) connection.uncertainCreates.delete(cwd);
      }
      const browse = connection.pendingBrowse;
      if (message.type === "workspace.listing") {
        if (!browse || message.path !== browse.path || (message.root ?? "home") !== browse.root) return;
        clearTimeout(browse.timer); connection.pendingBrowse = undefined;
        if (message.error) browse.reject(new Error(message.error.slice(0, 2000)));
        else browse.resolve({ hostId, path: message.path, root: (message.root ?? "home") as RemoteDirectoryListing["root"], cwd: message.cwd,
          entries: message.entries.slice(0, 10_000), supportsRoots: connection.client.supportsWorkspaceRoots });
        return;
      }
      if (message.type === "error" && !message.sid && browse) this.rejectBrowse(connection, new Error(message.message));
      const pending = connection.pendingCreate;
      if (message.type === "session.create.result" && pending?.requestId === message.requestId) {
        clearTimeout(pending.timer); connection.pendingCreate = undefined;
        if (message.ok && message.session) pending.resolve(message.session.id);
        else pending.reject(new Error(message.error ?? "远程 Shell 创建失败"));
      } else if (message.type === "error" && pending) {
        this.rejectCreate(connection, new Error(message.message));
      }
      if ((message.type === "term.output" || message.type === "term.snapshot") && !connection.sessions.has(message.sid)) return;
      this.publish({ hostId, message });
    });
    client.on("closed", () => {
      if (connection.intentionalClose || this.clients.get(hostId) !== connection) return;
      if (connection.pendingCreate) connection.uncertainCreates.set(connection.pendingCreate.cwd, connection.pendingCreate.requestId);
      this.rejectCreate(connection, new Error("连接中断，Shell 可能已经创建，请检查远程会话"));
      this.rejectBrowse(connection, new Error("远程目录读取时连接中断，请重试 / Remote connection interrupted"));
      this.publish({ hostId, message: { type: "remote.closed" } });
      this.scheduleReconnect(hostId, connection);
    });
    client.on("error", (error) => this.publish({ hostId, message: { type: "remote.error", message: error.message } }));
  }

  private trackMessage(connection: RemoteConnection, message: RemoteShellMessage): void {
    if (message.type === "session.state" || message.type === "session.create.result") {
      const session = message.session;
      if (session?.kind === "pty") {
        if (TERMINAL_SESSION_STATUSES.has(session.status)) connection.catalog.delete(session.id);
        else connection.catalog.set(session.id, session);
      }
    }
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
    }
  }

  private startConnect(hostId: string, connection: RemoteConnection, initial: boolean): Promise<{ name: string; sessions: number }> {
    const connecting = connection.client.connect()
      .then((hello) => {
        if (connection.intentionalClose || this.clients.get(hostId) !== connection) { connection.client.close(); throw new Error("连接已取消"); }
        connection.reconnectAttempt = 0;
        connection.catalog = new Map(hello.sessions.filter((session) => session.kind === "pty" && !TERMINAL_SESSION_STATUSES.has(session.status)).map((session) => [session.id, session]));
        for (const cwd of connection.uncertainCreates.keys()) if ([...connection.catalog.values()].some(session => session.agent === "shell" && session.cwd === cwd)) connection.uncertainCreates.delete(cwd);
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
