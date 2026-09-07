import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  clientHandshakeFinish, clientHandshakeStart, generateKeyPairB64, parseS2C,
  type AgentApiValidation, type AgentApiEngineValidation, type S2CMessage, type SecureChannel,
} from "@prospero/protocol";
import { loadIdentity, mintDevice } from "../src/pairing.js";
import { createDaemonServer, type DaemonServer, type DaemonServerOptions } from "../src/ws-server.js";

class TestClient {
  private readonly queue: S2CMessage[] = [];
  private constructor(private readonly ws: WebSocket, private readonly channel: SecureChannel) {
    ws.on("message", (raw) => this.queue.push(parseS2C(channel.open(raw.toString()))));
  }

  static async connect(server: DaemonServer, home: string, allowShell: boolean, protocolVersion: number): Promise<TestClient> {
    const device = mintDevice(home, { name: "Synthetic WebSocket test device", allowShell });
    const keys = generateKeyPairB64();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await once(ws, "open");
    const start = clientHandshakeStart(protocolVersion);
    const serverFrame = once(ws, "message");
    ws.send(start.frame);
    const [raw] = await serverFrame;
    const hello = clientHandshakeFinish(start.state, String(raw), loadIdentity(home).publicKey, {
      type: "hello", token: device.token, clientPubKey: keys.publicKey,
      clientInfo: { platform: "ios", appVersion: "synthetic-test" },
    });
    const client = new TestClient(ws, hello.channel);
    ws.send(hello.frame);
    return client;
  }

  send(message: unknown): void { this.ws.send(this.channel.seal(message)); }

  async waitFor(predicate: (message: S2CMessage) => boolean): Promise<S2CMessage> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const index = this.queue.findIndex(predicate);
      if (index >= 0) return this.queue.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for WebSocket result; queued message types: ${this.queue.map((message) => message.type).join(", ")}`);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = once(this.ws, "close");
    this.ws.close();
    await closed;
  }
}

const fixtures: { server: DaemonServer; home: string; client: TestClient }[] = [];
afterEach(async () => {
  for (const { server, home, client } of fixtures.splice(0)) {
    await client.close();
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

function passed(): AgentApiValidation {
  return { status: "passed", engine: "opencode", checkedAt: Date.now(),
    checks: { runtime: "passed", streaming: "passed", tools: "passed" },
    detail: "Synthetic CLI and protocol check only.", latencyMs: 1 };
}

async function setup(allowShell: boolean, protocolVersion: number, probe: NonNullable<DaemonServerOptions["apiProfileProbe"]>, engineProbe?: NonNullable<DaemonServerOptions["apiProfileEngineProbe"]>) {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-api-profile-ws-"));
  const server = await createDaemonServer({
    home, port: 0, bindAddr: "127.0.0.1", workspaceRoot: home,
    useTmux: false, structuredSupervisor: false, ptySupervisor: false, windowsSessionHost: false,
    accountRunner: async () => ({ stdout: "not logged in", stderr: "", exitCode: 0 }),
    apiProfileProbe: probe,
    ...(engineProbe ? { apiProfileEngineProbe: engineProbe } : {}),
  });
  const account = await server.accounts.createApi("codex", "Synthetic WebSocket profile", {
    protocol: "openai_chat_completions", baseUrl: "http://127.0.0.1:1/v1", model: "synthetic-model", apiKey: "synthetic-private-key",
  });
  const client = await TestClient.connect(server, home, allowShell, protocolVersion);
  fixtures.push({ home, server, client });
  const hello = await client.waitFor((message) => message.type === "hello.ok");
  if (hello.type !== "hello.ok") throw new Error("missing hello.ok");
  return { client, server, accountId: account.id, hello };
}

describe("API Profile WebSocket authorization boundary", () => {
  it.each([[true, 16], [false, 16], [true, 15]])("gates model/config features by protocol and permission: allowShell=%s protocol=%s", async (allowShell, protocolVersion) => {
    const { client, server, accountId, hello } = await setup(allowShell as boolean, protocolVersion as number, async () => passed());
    const fetchModels = vi.spyOn(server.accounts, "apiModels").mockResolvedValue([{ id: "synthetic-model" }]);
    const allowed = allowShell === true && protocolVersion === 16;
    expect(hello.host.capabilities?.includes("agent.account.api.models") ?? false).toBe(allowed);
    expect(hello.host.capabilities?.includes("agent.account.config") ?? false).toBe(allowed);
    client.send({ type: "agent.account.api.models.get", requestId: "models", accountId });
    const models = await client.waitFor((message) => message.type === "agent.account.api.models.result");
    expect(models).toMatchObject({ ok: allowed });
    expect(fetchModels).toHaveBeenCalledTimes(allowed ? 1 : 0);
    client.send({ type: "agent.account.config.get", requestId: "config", accountId });
    const config = await client.waitFor((message) => message.type === "agent.account.config.result");
    expect(config).toMatchObject({ ok: allowed });
    expect(JSON.stringify([models, config])).not.toContain("synthetic-private-key");
  });

  it.each([false, true])("keeps explicit engine validation behind account authorization (allowShell=%s)", async (allowShell) => {
    const wire = vi.fn(async () => passed());
    const engineResult: AgentApiEngineValidation = { ...passed(), cliVersion: "1.2.3", checks: { ...passed().checks, configuration: "passed" } };
    const engine = vi.fn(async () => engineResult);
    const { client, accountId, hello } = await setup(allowShell, 16, wire, engine);
    expect(hello.host.capabilities?.includes("agent.api-engine-validation.v1")).toBe(allowShell);
    client.send({ type: "agent.account.api.test", requestId: "engine-check", scope: "engine", accountId });
    const result = await client.waitFor((message) => message.type === "agent.accounts.result" && message.requestId === "engine-check");
    expect(result).toMatchObject({ ok: allowShell });
    expect(wire).not.toHaveBeenCalled();
    expect(engine).toHaveBeenCalledTimes(allowShell ? 1 : 0);
    if (allowShell) expect(result).toMatchObject({ engineValidation: engineResult });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
  });

  it("cancels a native-engine check when the requesting client disconnects", async () => {
    let entered!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => { entered = resolve; });
    const engine = vi.fn<NonNullable<DaemonServerOptions["apiProfileEngineProbe"]>>(async (_binding, options) => {
      const signal = options!.signal!;
      entered(signal);
      return new Promise<AgentApiEngineValidation>((resolve) => signal.addEventListener("abort", () => resolve({
        ...passed(), status: "failed", code: "cancelled", checks: { runtime: "passed", configuration: "passed", streaming: "failed", tools: "not_tested" },
      }), { once: true }));
    });
    const { client, accountId, server } = await setup(true, 16, async () => passed(), engine);
    client.send({ type: "agent.account.api.test", requestId: "cancel-engine", scope: "engine", accountId });
    const signal = await started;
    await client.close();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    await vi.waitFor(async () => expect((await server.accounts.snapshot([])).find((item) => item.id === accountId)?.apiEngineValidation?.code).toBe("cancelled"));
    expect(engine).toHaveBeenCalledOnce();
  });

  it("denies allowShell=false devices before any probe can start", async () => {
    const probe = vi.fn(async () => passed());
    const { client, accountId, hello, server } = await setup(false, 16, probe);
    expect(hello.host.capabilities).not.toContain("agent.api-validation.v1");
    client.send({ type: "agent.account.api.test", requestId: "restricted", accountId });
    const result = await client.waitFor((message) => message.type === "agent.accounts.result" && message.requestId === "restricted");
    expect(result).toMatchObject({ type: "agent.accounts.result", action: "api_test", ok: false, accounts: [] });
    expect(probe).not.toHaveBeenCalled();
    expect((await server.accounts.snapshot([])).find((account) => account.id === accountId)?.apiValidation).toBeUndefined();
  });

  it("rejects an api.test message from protocol v15 before invoking the probe", async () => {
    const probe = vi.fn(async () => passed());
    const { client, accountId, hello } = await setup(true, 15, probe);
    expect(hello.host.negotiatedProtocolVersion).toBe(15);
    expect(hello.host.capabilities).not.toContain("agent.api-validation.v1");
    client.send({ type: "agent.account.api.test", requestId: "old-protocol", accountId });
    const result = await client.waitFor((message) => message.type === "error");
    expect(result).toMatchObject({ type: "error", code: "bad_message" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("allows an explicit v16 action to run the injected probe and returns only public validation", async () => {
    const probe = vi.fn<NonNullable<DaemonServerOptions["apiProfileProbe"]>>(async (binding, options) => {
      expect(binding.engine).toBe("opencode");
      expect(binding.apiProfile?.model).toBe("synthetic-model");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(options?.signal?.aborted).toBe(false);
      return passed();
    });
    const { client, accountId, hello, server } = await setup(true, 16, probe);
    expect(hello.host.capabilities).toContain("agent.api-validation.v1");
    expect(probe).not.toHaveBeenCalled();
    client.send({ type: "agent.account.api.test", requestId: "explicit-test", accountId });
    const result = await client.waitFor((message) => message.type === "agent.accounts.result" && message.requestId === "explicit-test");
    expect(result).toMatchObject({ type: "agent.accounts.result", action: "api_test", accountId, ok: true, validation: { status: "passed", engine: "opencode" } });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-key");
    expect(probe).toHaveBeenCalledTimes(1);
    expect((await server.accounts.snapshot([])).find((account) => account.id === accountId)?.apiValidation?.status).toBe("passed");
  });

  it("aborts the in-flight probe when its authenticated client disconnects", async () => {
    let entered!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => { entered = resolve; });
    let observedAbort!: () => void;
    const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
    const probe = vi.fn<NonNullable<DaemonServerOptions["apiProfileProbe"]>>(async (_binding, options) => {
      const signal = options!.signal!;
      entered(signal);
      return new Promise<AgentApiValidation>((resolve) => signal.addEventListener("abort", () => {
        observedAbort();
        resolve({ ...passed(), status: "failed", code: "cancelled", checks: { runtime: "passed", streaming: "failed", tools: "not_tested" } });
      }, { once: true }));
    });
    const { client, accountId } = await setup(true, 16, probe);
    client.send({ type: "agent.account.api.test", requestId: "disconnect", accountId });
    const signal = await started;
    expect(signal.aborted).toBe(false);
    await client.close();
    await aborted;
    expect(signal.aborted).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
