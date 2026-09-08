import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientHandshakeFinish, clientHandshakeStart, generateKeyPairB64, parseS2C, type ModelSourceAction, type S2CMessage } from "@prospero/protocol";
import { mintDevice, loadIdentity } from "../src/pairing.js";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";

const fixtures: Array<{ home: string; server: DaemonServer; sockets: WebSocket[] }> = [];
afterEach(async () => {
  for (const { home, server, sockets } of fixtures.splice(0)) {
    for (const socket of sockets) { if (socket.readyState === WebSocket.CLOSED) continue; const closed = once(socket, "close"); socket.close(); await closed; }
    await server.close(); rmSync(home, { recursive: true, force: true });
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function setup() {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-source-control-"));
  vi.stubEnv("CODEX_HOME", path.join(home, "native-codex"));
  const server = await createDaemonServer({ home, port: 0, bindAddr: "127.0.0.1", workspaceRoot: home, useTmux: false, structuredSupervisor: false, ptySupervisor: false, windowsSessionHost: false, accountRunner: async () => ({ stdout: "not logged in", stderr: "", exitCode: 0 }) });
  const fixture = { home, server, sockets: [] as WebSocket[] };
  fixtures.push(fixture);
  const status = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as { controlToken: string; capabilities: string[] };
  const request = async (action: unknown, authenticated = true) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/_prospero/control/model-sources`, { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${status.controlToken}` } : {}) }, body: JSON.stringify({ type: "model.source.action", requestId: "request", action }) });
    return { status: response.status, body: await response.text() };
  };
  return { ...fixture, request, capabilities: status.capabilities };
}

describe("model source control boundary", () => {
  it("authorizes before source access, validates bodies and does not reflect secret fields", async () => {
    const { request, home, capabilities } = await setup();
    expect(capabilities).toContain("model.sources.v1");
    const action = { kind: "create", name: "Source", endpoints: [{ protocol: "openai_responses", baseUrl: "https://source.invalid/v1" }], credential: { name: "Key", apiKey: "synthetic-private-http-key" } };
    expect((await request(action, false)).status).toBe(401);
    expect(existsSync(path.join(home, "model-sources"))).toBe(false);
    const saved = await request(action);
    expect(saved.status).toBe(200);
    expect(saved.body).not.toContain("synthetic-private-http-key");
    const source = JSON.parse(saved.body).sources[0];
    const stale = await request({ kind: "update", sourceId: source.id, revision: 99, name: "stale" });
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body)).toMatchObject({ ok: false, error: { code: "conflict" } });
    const invalid = await request({ kind: "models", sourceId: source.id, revision: 1, credentialId: source.credentials[0].id, protocol: "openai_responses", apiKey: "synthetic-private-reflection" });
    expect(invalid.status).toBe(400); expect(invalid.body).not.toContain("synthetic-private-reflection");
    expect((await request({ kind: "list", padding: "x".repeat(70 * 1024) })).status).toBe(413);
  });

  it("returns a public materialized account for the selected model without returning its key", async () => {
    const { request } = await setup();
    const created = JSON.parse((await request({ kind: "create", name: "Source", endpoints: [{ protocol: "openai_responses", baseUrl: "https://source.invalid/v1" }], credential: { name: "Key", apiKey: "synthetic-private-source-key" } })).body).sources[0];
    const configured = JSON.parse((await request({ kind: "routes.set", sourceId: created.id, revision: created.revision, routes: [{ name: "A", model: "model-a", protocol: "openai_responses", credentialId: created.credentials[0].id, enabled: true }] })).body).sources[0];
    const bound = await request({ kind: "bind", sourceId: configured.id, revision: configured.revision, routeId: configured.routes[0].id });
    expect(bound.status).toBe(200);
    expect(bound.body).not.toContain("synthetic-private-source-key");
    const result = JSON.parse(bound.body);
    expect(result.accounts.find((account: { id: string }) => account.id === result.accountId)).toMatchObject({ apiProfile: { model: "model-a" }, modelSource: { sourceId: configured.id, legacy: false } });
  });

  it.each([[true, 16], [false, 16], [true, 15]])("requires protocol and device permission over E2E WebSocket (%s, %s)", async (allowShell, protocolVersion) => {
    const { server, home, sockets } = await setup();
    const handler = vi.spyOn(server.accounts, "modelSourceAction").mockResolvedValue({ sources: [] });
    const device = mintDevice(home, { name: "Source test device", allowShell: allowShell as boolean });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(socket);
    await once(socket, "open");
    const start = clientHandshakeStart(protocolVersion as number);
    const serverFrame = once(socket, "message"); socket.send(start.frame);
    const [raw] = await serverFrame;
    const keys = generateKeyPairB64();
    const hello = clientHandshakeFinish(start.state, String(raw), loadIdentity(home).publicKey, { type: "hello", token: device.token, clientPubKey: keys.publicKey, clientInfo: { platform: "ios", appVersion: "synthetic" } });
    const messages: S2CMessage[] = [];
    socket.on("message", rawMessage => messages.push(parseS2C(hello.channel.open(rawMessage.toString()))));
    socket.send(hello.frame);
    const wait = async (type: S2CMessage["type"]) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { const value = messages.find(item => item.type === type); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
      throw Error("Missing model source WebSocket response");
    };
    const ready = await wait("hello.ok");
    const allowed = allowShell === true && protocolVersion === 16;
    if (ready.type !== "hello.ok") throw Error("Missing hello");
    expect(ready.host.capabilities?.includes("model.sources.v1") ?? false).toBe(allowed);
    socket.send(hello.channel.seal({ type: "model.source.action", requestId: "request", action: { kind: "list" } satisfies ModelSourceAction }));
    expect(await wait("model.source.result")).toMatchObject({ ok: allowed });
    expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });
});
