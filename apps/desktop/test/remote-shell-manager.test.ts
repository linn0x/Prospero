import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteShellHost, RemoteShellMessage, RemoteShellClient } from "../src/main/remote-shell-client";
import { RemoteShellManager } from "../src/main/remote-shell-manager";

const host: RemoteShellHost = {
  id: "host-1", name: "remote", addrs: ["127.0.0.1"], port: 7423,
  token: "0123456789abcdef", daemonPubKey: "daemon-key",
};

class FakeClient {
  connected = false;
  readonly attachCalls: Array<{ sid: string; lastSeq?: number }> = [];
  private readonly listeners = {
    connected: [] as Array<(message: never) => void>,
    message: [] as Array<(message: RemoteShellMessage) => void>,
    closed: [] as Array<() => void>,
    error: [] as Array<(error: Error) => void>,
  };
  connectCount = 0;
  failures = 0;
  createCount = 0;
  retryable = true;

  get isConnected(): boolean { return this.connected; }
  on(event: keyof typeof this.listeners, listener: never): () => void {
    (this.listeners[event] as Array<never>).push(listener);
    return () => undefined;
  }
  async connect(): Promise<{ type: "hello.ok"; host: { name: string; daemonVersion: string; protocolVersion: number }; sessions: [] }> {
    this.connectCount += 1;
    if (this.failures-- > 0) throw new Error("offline");
    this.connected = true;
    this.listeners.connected.forEach((listener) => listener({
      type: "hello.ok", host: { name: "remote", daemonVersion: "test", protocolVersion: 16 }, sessions: [],
    } as never));
    return { type: "hello.ok", host: { name: "remote", daemonVersion: "test", protocolVersion: 16 }, sessions: [] };
  }
  createShell(_cwd: string, _cols: number, _rows: number, requestId: string): void {
    this.createCount++;
    this.emit({ type: "session.create.result", requestId, ok: true, session: {
      id: "shell-1", agent: "shell", kind: "pty", title: "shell", cwd: "/tmp", status: "running",
    } } as RemoteShellMessage);
  }
  attach(sid: string, lastSeq?: number): void { this.attachCalls.push({ sid, ...(lastSeq === undefined ? {} : { lastSeq }) }); }
  input(): void {}
  resize(): void {}
  kill(): void {}
  close(): void { this.connected = false; }
  emit(message: RemoteShellMessage): void { this.listeners.message.forEach((listener) => listener(message)); }
  drop(): void {
    this.connected = false;
    this.listeners.closed.forEach((listener) => listener());
  }
}

describe("RemoteShellManager reconnect", () => {
  afterEach(() => vi.useRealTimers());

  it("reconnects after a transport drop and resumes each shell at its last sequence", async () => {
    vi.useFakeTimers();
    const fake = new FakeClient();
    const events: string[] = [];
    const store = {
      get: () => host,
      markConnected: () => undefined,
    };
    const manager = new RemoteShellManager(store as never, (event) => {
      events.push(event.message.type);
    }, () => fake as unknown as RemoteShellClient);

    await manager.connect(host.id);
    await manager.createShell(host.id, "/tmp");
    fake.emit({ type: "term.snapshot", sid: "shell-1", ansi: "", seq: 4, cols: 80, rows: 24 });
    fake.drop();
    expect(events).toContain("remote.reconnecting");

    await vi.advanceTimersByTimeAsync(250);
    expect(fake.connectCount).toBe(2);
    expect(fake.attachCalls).toEqual([{ sid: "shell-1", lastSeq: 4 }]);
    manager.disconnect(host.id);
    expect(events.filter((type) => type === "remote.connected")).toHaveLength(2);
  });
  it("retries again after a failed reconnect, then stops when removed", async () => {
    vi.useFakeTimers();
    const fake = new FakeClient();
    const manager = new RemoteShellManager({ get: () => host, markConnected: () => {} } as never, () => {}, () => fake as unknown as RemoteShellClient);
    await manager.connect(host.id);
    fake.failures = 2;
    fake.drop();
    await vi.advanceTimersByTimeAsync(250 + 500 + 1000);
    expect(fake.connectCount).toBe(4);
    expect(fake.connected).toBe(true);
    fake.drop();
    manager.disconnect(host.id);
    await vi.advanceTimersByTimeAsync(20000);
    expect(fake.connectCount).toBe(4);
  });
  it("coalesces duplicate shell creation and resolves the matching response", async () => {
    const fake = new FakeClient();
    const manager = new RemoteShellManager({ get: () => host, markConnected: () => {} } as never, () => {}, () => fake as unknown as RemoteShellClient);
    await manager.connect(host.id);
    expect(await Promise.all([manager.createShell(host.id), manager.createShell(host.id)])).toEqual(["shell-1", "shell-1"]);
    expect(fake.createCount).toBe(1);
    manager.disconnect(host.id);
  });
});
