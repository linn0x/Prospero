import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteShellHost, RemoteShellMessage, RemoteShellClient } from "../src/main/remote-shell-client";
import { RemoteShellManager } from "../src/main/remote-shell-manager";
import type { SessionInfo } from "@prospero/protocol";

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
  supportsWorkspaceRoots = false;
  readonly browseCalls: { path: string; root: string }[] = [];
  readonly createCalls: { cwd: string | undefined; requestId: string }[] = [];
  readonly resizeCalls: string[] = [];
  readonly inputCalls: string[] = [];
  initialSessions: SessionInfo[] = [];
  deferBrowse = false;
  deferCreate = false;

  get isConnected(): boolean { return this.connected; }
  on(event: keyof typeof this.listeners, listener: never): () => void {
    (this.listeners[event] as Array<never>).push(listener);
    return () => undefined;
  }
  async connect(): Promise<{ type: "hello.ok"; host: { name: string; daemonVersion: string; protocolVersion: number }; sessions: SessionInfo[] }> {
    this.connectCount += 1;
    if (this.failures-- > 0) throw new Error("offline");
    this.connected = true;
    this.listeners.connected.forEach((listener) => listener({
      type: "hello.ok", host: { name: "remote", daemonVersion: "test", protocolVersion: 16 }, sessions: [],
    } as never));
    return { type: "hello.ok", host: { name: "remote", daemonVersion: "test", protocolVersion: 16 }, sessions: this.initialSessions };
  }
  createShell(_cwd: string, _cols: number, _rows: number, requestId: string): void {
    this.createCount++;
    this.createCalls.push({ cwd: _cwd, requestId });
    if (this.deferCreate) return;
    this.emit({ type: "session.create.result", requestId, ok: true, session: {
      id: `shell-${this.createCount}`, agent: "shell", kind: "pty", title: "shell", cwd: _cwd ?? "/tmp", status: "running",
    } } as RemoteShellMessage);
  }
  attach(sid: string, lastSeq?: number): void { this.attachCalls.push({ sid, ...(lastSeq === undefined ? {} : { lastSeq }) }); }
  input(sid: string): void { this.inputCalls.push(sid); }
  resize(sid: string): void { this.resizeCalls.push(sid); }
  listWorkspace(path: string, root: string): void {
    this.browseCalls.push({ path, root });
    if (!this.deferBrowse) this.emit({ type: "workspace.listing", root: root as "home", path, cwd: `/remote/${path}`, entries: [] });
  }
  kill(): void {}
  close(): void { this.connected = false; this.listeners.closed.forEach(listener => listener()); }
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

  it("deduplicates by cwd and never confuses different remote directories on the same host", async () => {
    const fake = new FakeClient();
    const manager = new RemoteShellManager({ get: () => host, markConnected: () => {} } as never, () => {}, () => fake as unknown as RemoteShellClient);
    const ids = await Promise.all([manager.createShell(host.id, "/remote/a"), manager.createShell(host.id, "/remote/b"), manager.createShell(host.id, "/remote/a")]);
    expect(ids[0]).toBe(ids[2]); expect(ids[0]).not.toBe(ids[1]);
    expect(fake.createCalls.map(call => call.cwd).sort()).toEqual(["/remote/a", "/remote/b"]);
    expect((await manager.listWorkspaceShells(host.id, "/remote/b")).map(session => session.id)).toEqual([ids[1]]);
    manager.close();
  });

  it("serializes uncorrelated directory listings and closes a timed-out transport before retrying", async () => {
    vi.useFakeTimers();
    const fake = new FakeClient(); fake.deferBrowse = true;
    const manager = new RemoteShellManager({ get: () => host, markConnected: () => {} } as never, () => {}, () => fake as unknown as RemoteShellClient);
    const first = manager.listWorkspace({ hostId: host.id, path: "first" });
    const failed = expect(first).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    expect(fake.connected).toBe(false);
    fake.deferBrowse = false;
    const listing = await manager.listWorkspace({ hostId: host.id, path: "first" });
    expect(listing).toMatchObject({ hostId: host.id, path: "first", cwd: "/remote/first" });
    expect(fake.connectCount).toBe(2);
    manager.close();
  });

  it("does not create another shell automatically after an unconfirmed timeout", async () => {
    vi.useFakeTimers();
    const fake = new FakeClient(); fake.deferCreate = true;
    const manager = new RemoteShellManager({ get: () => host, markConnected: () => {} } as never, () => {}, () => fake as unknown as RemoteShellClient);
    const creation = manager.createShell(host.id, "/remote/a");
    const failed = expect(creation).rejects.toThrow("创建超时");
    await vi.advanceTimersByTimeAsync(15_000); await failed;
    await expect(manager.createShell(host.id, "/remote/a")).rejects.toThrow("unconfirmed");
    expect(fake.createCount).toBe(1);
    manager.close();
  });

  it("retains uncertainty when the connection drops during remote creation", async () => {
    vi.useFakeTimers();
    const fake = new FakeClient(); fake.deferCreate = true;
    const manager = new RemoteShellManager({ get: () => host, markConnected: () => {} } as never, () => {}, () => fake as unknown as RemoteShellClient);
    const creation = manager.createShell(host.id, "/remote/a");
    const failed = expect(creation).rejects.toThrow("可能已经创建");
    await vi.advanceTimersByTimeAsync(0);
    fake.drop(); await failed;
    await vi.advanceTimersByTimeAsync(250);
    await expect(manager.createShell(host.id, "/remote/a")).rejects.toThrow("unconfirmed");
    expect(fake.createCount).toBe(1);
    manager.close();
  });

  it("filters by cwd before limiting host sessions and keeps identical session IDs scoped to their host", async () => {
    const clients = new Map<string, FakeClient>();
    for (const id of ["host-a", "host-b"]) {
      const fake = new FakeClient();
      fake.initialSessions = Array.from({ length: 140 }, (_, index) => ({ id: index === 139 ? "shared-sid" : `sid-${index}`, agent: "shell", kind: "pty", title: "shell", cwd: index === 139 ? `/remote/${id}` : "/unrelated", status: "running", createdAt: index }));
      clients.set(id, fake);
    }
    const manager = new RemoteShellManager({ get: (id: string) => ({ ...host, id }), markConnected: () => {} } as never, () => {}, selected => clients.get(selected.id)! as unknown as RemoteShellClient);
    expect((await manager.listWorkspaceShells("host-a", "/remote/host-a")).map(session => session.id)).toEqual(["shared-sid"]);
    expect(await manager.listWorkspaceShells("host-b", "/remote/host-a")).toEqual([]);
    manager.close();
  });

  it("uses view leases for attach/detach and prevents a stale view from resizing or typing", async () => {
    const fake = new FakeClient();
    const events: string[] = [];
    const manager = new RemoteShellManager({ get: () => host, markConnected: () => {} } as never, event => events.push(event.message.type), () => fake as unknown as RemoteShellClient);
    const sid = await manager.createShell(host.id, "/remote/a");
    await manager.attach(host.id, sid, "old-view");
    await manager.attach(host.id, sid, "new-view");
    await manager.attach(host.id, sid, "old-view");
    expect(fake.attachCalls).toHaveLength(3);
    manager.resize(host.id, sid, 80, 24, "old-view");
    expect(fake.resizeCalls).toEqual([]);
    expect(() => manager.input(host.id, sid, "eA==", "old-view")).toThrow("Another view");
    manager.detach(host.id, sid, "old-view");
    manager.resize(host.id, sid, 80, 24, "new-view");
    manager.input(host.id, sid, "eA==", "new-view");
    expect(fake.resizeCalls).toEqual([sid]); expect(fake.inputCalls).toEqual([sid]);
    manager.detach(host.id, sid, "new-view");
    const count = events.length;
    fake.emit({ type: "term.output", sid, seq: 2, dataB64: "eA==" });
    expect(events).toHaveLength(count);
    expect(fake.connected).toBe(true);
    manager.close();
  });

  it("does not complete a stale attach after its owner detached during connection", async () => {
    const fake = new FakeClient();
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const original = fake.connect.bind(fake);
    fake.initialSessions = [{ id: "shell", agent: "shell", kind: "pty", title: "shell", cwd: "/remote", status: "running", createdAt: 0 }];
    fake.connect = async () => { await wait; return original(); };
    const manager = new RemoteShellManager({ get: () => host, markConnected: () => {} } as never, () => {}, () => fake as unknown as RemoteShellClient);
    const old = manager.attach(host.id, "shell", "old");
    manager.detach(host.id, "shell", "old");
    const fresh = manager.attach(host.id, "shell", "new");
    finish(); await Promise.all([old, fresh]);
    expect(fake.attachCalls).toEqual([{ sid: "shell" }]);
    manager.close();
  });
});
