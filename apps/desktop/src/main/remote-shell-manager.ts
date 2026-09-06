import type { RemoteShellMessage } from "./remote-shell-client";
import { RemoteShellClient } from "./remote-shell-client";
import { RemoteHostStore } from "./remote-host-store";

export type RemoteShellEvent = {
  hostId: string;
  message: RemoteShellMessage | { type: "remote.connected" } | { type: "remote.closed" } | { type: "remote.error"; message: string };
};

export class RemoteShellManager {
  private readonly clients = new Map<string, RemoteShellClient>();

  constructor(
    private readonly hosts: RemoteHostStore,
    private readonly publish: (event: RemoteShellEvent) => void,
  ) {}

  async connect(hostId: string): Promise<{ name: string; sessions: number }> {
    const existing = this.clients.get(hostId);
    if (existing?.isConnected) return { name: existing.host.name, sessions: 0 };
    const host = this.hosts.get(hostId);
    if (!host) throw new Error("远程主机不存在，请重新配对");
    const client = new RemoteShellClient(host);
    client.on("connected", (message) => {
      this.hosts.markConnected(hostId);
      this.publish({ hostId, message: { type: "remote.connected" } });
      // The hello payload is intentionally returned to the caller only; its
      // full host/session snapshot is not broadcast to the renderer.
      void message;
    });
    client.on("message", (message) => {
      // Shell creation is correlated by the daemon's result message. Attach
      // immediately so the first terminal snapshot follows without a second
      // renderer round-trip.
      if (message.type === "session.create.result" && message.ok && message.session) {
        client.attach(message.session.id);
      }
      this.publish({ hostId, message });
    });
    client.on("closed", () => {
      this.clients.delete(hostId);
      this.publish({ hostId, message: { type: "remote.closed" } });
    });
    client.on("error", (error) => this.publish({ hostId, message: { type: "remote.error", message: error.message } }));
    const hello = await client.connect();
    this.clients.set(hostId, client);
    return { name: hello.host.name, sessions: hello.sessions.length };
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
  }

  disconnect(hostId: string): void {
    const client = this.clients.get(hostId);
    if (!client) return;
    this.clients.delete(hostId);
    client.close();
  }

  private async connected(hostId: string): Promise<RemoteShellClient> {
    const existing = this.clients.get(hostId);
    if (existing?.isConnected) return existing;
    await this.connect(hostId);
    return this.require(hostId);
  }

  private require(hostId: string): RemoteShellClient {
    const client = this.clients.get(hostId);
    if (!client?.isConnected) throw new Error("远程主机尚未连接");
    return client;
  }
}
