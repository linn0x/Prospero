import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  clientHandshakeFinish, clientHandshakeStart, generateKeyPairB64, parseS2C,
  type S2CMessage, type SecureChannel,
} from "@prospero/protocol";
import { loadIdentity, mintDevice } from "../src/pairing.js";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";
import type { AgentAdapter } from "../src/adapters/types.js";

class TestClient {
  readonly received: S2CMessage[] = [];
  private readonly queue: S2CMessage[] = [];
  private parseError: unknown;

  private constructor(private readonly ws: WebSocket, private readonly channel: SecureChannel) {
    ws.on("message", (raw) => {
      try {
        const message = parseS2C(channel.open(raw.toString()));
        this.received.push(message); this.queue.push(message);
      } catch (error) { this.parseError = error; }
    });
  }

  static async connect(server: DaemonServer, home: string, protocolVersion: number): Promise<TestClient> {
    const device = mintDevice(home, { name: "Synthetic creation client", allowShell: true });
    const keys = generateKeyPairB64();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await once(ws, "open");
    const start = clientHandshakeStart(protocolVersion);
    const reply = once(ws, "message"); ws.send(start.frame);
    const [raw] = await reply;
    const hello = clientHandshakeFinish(start.state, String(raw), loadIdentity(home).publicKey, {
      type: "hello", token: device.token, clientPubKey: keys.publicKey,
      clientInfo: { platform: "ios", appVersion: "synthetic-create-test" },
    });
    const client = new TestClient(ws, hello.channel);
    ws.send(hello.frame);
    return client;
  }

  send(message: unknown): void { this.ws.send(this.channel.seal(message)); }

  async waitFor(predicate: (message: S2CMessage) => boolean): Promise<S2CMessage> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (this.parseError) throw this.parseError;
      const index = this.queue.findIndex(predicate);
      if (index >= 0) return this.queue.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Creation result timed out; queued types: ${this.queue.map((message) => message.type).join(", ")}`);
  }

  async flush(): Promise<void> {
    const id = "creation-test-barrier";
    this.send({ type: "connection.ping", id });
    await this.waitFor((message) => message.type === "connection.pong" && message.id === id);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = once(this.ws, "close"); this.ws.close(); await closed;
  }
}

const fixtures: Array<{ home: string; server: DaemonServer; clients: TestClient[] }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await Promise.all(fixture.clients.map((client) => client.close()));
    await fixture.server.close();
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

async function setup(protocolVersion = 16, start: AgentAdapter["start"] = async () => {}) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "prospero-create-result-")));
  const server = await createDaemonServer({
    home, port: 0, bindAddr: "127.0.0.1", workspaceRoot: home,
    useTmux: false, structuredSupervisor: false, ptySupervisor: false, windowsSessionHost: false,
    accountRunner: async () => ({ stdout: "not logged in", stderr: "", exitCode: 0 }),
    adapterFactory: () => ({ start, send: async () => {}, respondPermission: async () => {}, interrupt: async () => {}, dispose: async () => {} }),
  });
  const fixture = { home, server, clients: [] as TestClient[] }; fixtures.push(fixture);
  const client = await TestClient.connect(server, home, protocolVersion); fixture.clients.push(client);
  const hello = await client.waitFor((message) => message.type === "hello.ok");
  if (hello.type !== "hello.ok") throw new Error("Missing handshake acknowledgement");
  return { home, server, client, hello };
}

function create(cwd: string, requestId?: string) {
  return { type: "session.create", agent: "codex", kind: "structured", cwd, cols: 80, rows: 24, ...(requestId ? { requestId } : {}) };
}

describe("Correlated WebSocket session creation results", () => {
  it("returns the exact created session ID alongside the creator's chat snapshot", async () => {
    const { home, client, server, hello } = await setup();
    expect(hello.host.capabilities).toContain("session.create-result.v1");
    client.send(create(home, "create-exact"));
    const result = await client.waitFor((message) => message.type === "session.create.result" && message.requestId === "create-exact");
    expect(result).toMatchObject({ type: "session.create.result", requestId: "create-exact", ok: true, session: { agent: "codex", kind: "structured", cwd: home, status: "idle" } });
    if (result.type !== "session.create.result" || !result.ok) throw new Error("Expected successful creation result");
    expect(server.manager.list().map((session) => session.id)).toEqual([result.session.id]);
    const snapshot = await client.waitFor((message) => message.type === "chat.snapshot" && message.sid === result.session.id);
    expect(snapshot).toMatchObject({ sid: result.session.id });
  });

  it("associates adapter startup failure with its request without leaving a phantom session", async () => {
    const { home, client, server } = await setup(16, async () => { throw new Error("synthetic startup failure"); });
    client.send(create(home, "create-failed"));
    const result = await client.waitFor((message) => message.type === "session.create.result" && message.requestId === "create-failed");
    expect(result).toMatchObject({ requestId: "create-failed", ok: false, code: "agent_unavailable", error: expect.stringContaining("synthetic startup failure") });
    expect(server.manager.list()).toEqual([]);
    await client.flush();
    expect(client.received.filter((message) => message.type === "session.create.result")).toHaveLength(1);
  });

  it("keeps two concurrent creations correlated when the second finishes first", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = vi.fn<AgentAdapter["start"]>(async (context) => {
      if (path.basename(context.cwd) === "slow") await blocked;
    });
    const { home, client } = await setup(16, started);
    const slow = path.join(home, "slow"); const fast = path.join(home, "fast");
    mkdirSync(slow); mkdirSync(fast);
    try {
      client.send(create(slow, "create-slow"));
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
      client.send(create(fast, "create-fast"));
      const second = await client.waitFor((message) => message.type === "session.create.result" && message.requestId === "create-fast");
      expect(second).toMatchObject({ ok: true, session: { cwd: fast } });
      expect(client.received.some((message) => message.type === "session.create.result" && message.requestId === "create-slow")).toBe(false);
      release();
      const first = await client.waitFor((message) => message.type === "session.create.result" && message.requestId === "create-slow");
      expect(first).toMatchObject({ ok: true, session: { cwd: slow } });
      if (first.type !== "session.create.result" || !first.ok || second.type !== "session.create.result" || !second.ok) throw new Error("Expected two successful creations");
      expect(first.session.id).not.toBe(second.session.id);
      for (const result of [first, second]) await client.waitFor((message) => message.type === "chat.snapshot" && message.sid === result.session.id);
    } finally { release(); }
  });

  it.each([[15, undefined], [15, "ignored-old-request"], [16, undefined]] as const)("preserves legacy snapshots/errors for v%s requestId=%s", async (protocolVersion, requestId) => {
    const start = vi.fn<AgentAdapter["start"]>().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("legacy synthetic failure"));
    const { home, client, hello } = await setup(protocolVersion, start);
    expect(hello.host.capabilities?.includes("session.create-result.v1")).toBe(protocolVersion >= 16);
    client.send(create(home, requestId));
    await client.waitFor((message) => message.type === "chat.snapshot");
    client.send(create(home, requestId));
    const failure = await client.waitFor((message) => message.type === "error");
    expect(failure).toMatchObject({ code: "agent_unavailable", message: expect.stringContaining("legacy synthetic failure") });
    await client.flush();
    expect(client.received.some((message) => message.type === "session.create.result")).toBe(false);
  });
});
