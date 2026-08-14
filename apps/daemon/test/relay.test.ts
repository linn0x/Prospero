import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  clientHandshakeFinish,
  clientHandshakeStart,
  generateKeyPairB64,
  parseS2C,
  type SecureChannel,
  type S2CMessage,
} from "@prospero/protocol";
import {
  buildPairingPayload,
  deriveRelayRouteId,
  effectiveRelayUrl,
  generateRelayHostSecret,
  loadConfig,
  loadDevices,
  loadIdentity,
  mintDevice,
  relayPairingForDevice,
  saveConfig,
  saveDevices,
  type DaemonConfig,
  type DeviceRecord,
} from "../src/pairing.js";
import { RelayHostClient } from "../src/relay-host-client.js";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";

const homes: string[] = [];

function home(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), "prospero-relay-test-"));
  homes.push(value);
  return value;
}

function config(url: string, hostSecret = generateRelayHostSecret()): DaemonConfig {
  return { port: 7423, relay: { enabled: true, url, hostSecret } };
}

function device(name: string): DeviceRecord {
  return {
    name,
    token: "pairing-token-0123456789",
    relayDeviceId: `device_${name}_0123456789`,
    relayToken: `ticket_${name}_0123456789`,
    allowShell: true,
    createdAt: 1,
  };
}

async function relayServer(): Promise<{ http: Server; wss: WebSocketServer; url: string; close(): Promise<void> }> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, perMessageDeflate: false });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    http,
    wss,
    url: `ws://127.0.0.1:${String(port)}`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function waitFor(predicate: () => boolean, timeout = 3_000): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout, interval: 10 });
}

function cli(dir: string, args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, ...env, PROSPERO_HOME: dir },
    encoding: "utf8",
  });
}

afterEach(async () => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

describe("relay pairing persistence", () => {
  it("migrates old records, mints distinct relay credentials, and derives stable domain-separated routes", () => {
    const dir = home();
    const secret = generateRelayHostSecret();
    const first = deriveRelayRouteId(secret);
    expect(first).toHaveLength(43);
    expect(deriveRelayRouteId(secret)).toBe(first);
    expect(deriveRelayRouteId(generateRelayHostSecret())).not.toBe(first);

    saveDevices(dir, [{
      name: "old-phone", token: "old-pairing-token-123", allowShell: true, createdAt: 1,
    }]);
    const fresh = mintDevice(dir, { name: "new-phone", allowShell: true });
    expect(fresh.relayDeviceId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(fresh.relayToken).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const relay = relayPairingForDevice(
      { port: 7423, relay: { enabled: true, url: "wss://relay.example.test/v1", hostSecret: secret } },
      fresh,
    );
    expect(relay).toMatchObject({ url: "wss://relay.example.test/v1", routeId: first });
    expect(relayPairingForDevice(
      { port: 7423, relay: { enabled: true, url: "wss://relay.example.test/v1", hostSecret: secret } },
      { name: "old-phone", token: "old-pairing-token-123", allowShell: true, createdAt: 1 },
    )).toBeNull();
    const payload = buildPairingPayload(dir, {
      token: fresh.token,
      port: 7423,
      relay: relay!,
    });
    expect(payload.relay).toEqual(relay);
    expect(payload.addrs.length === 0 || payload.relay !== undefined).toBe(true);
  });

  it("uses override before deployment default and keeps config private", () => {
    const dir = home();
    const previous = process.env["PROSPERO_DEFAULT_RELAY_URL"];
    process.env["PROSPERO_DEFAULT_RELAY_URL"] = "wss://default.example.test/v1";
    expect(effectiveRelayUrl({ port: 1 })).toBe("wss://default.example.test/v1");
    saveConfig(dir, config("wss://override.example.test/v1"));
    expect(effectiveRelayUrl(loadConfig(dir))).toBe("wss://override.example.test/v1");
    expect(statSync(path.join(dir, "config.json")).mode & 0o777).toBe(0o600);
    if (previous === undefined) delete process.env["PROSPERO_DEFAULT_RELAY_URL"];
    else process.env["PROSPERO_DEFAULT_RELAY_URL"] = previous;
  });
});

describe("prosperod relay CLI", () => {
  it("requires a URL/default, enforces URL policy, writes 0600 config, reports JSON, and rotates credentials", () => {
    const dir = home();
    expect(cli(dir, ["relay", "enable"], { PROSPERO_DEFAULT_RELAY_URL: "" })).toMatchObject({ status: 1 });
    expect(cli(dir, ["relay", "enable", "--url", "ws://127.0.0.1:9010"])).toMatchObject({ status: 1 });
    expect(cli(dir, ["relay", "enable", "--url", "ws://127.0.0.1:9010", "--dev"])).toMatchObject({ status: 0 });
    const enabled = loadConfig(dir);
    expect(enabled.relay).toMatchObject({ enabled: true, url: "ws://127.0.0.1:9010" });
    expect(enabled.relay?.hostSecret).toHaveLength(43);
    expect(statSync(path.join(dir, "config.json")).mode & 0o777).toBe(0o600);

    const paired = mintDevice(dir, { name: "cli-phone", allowShell: true });
    const status = cli(dir, ["relay", "status", "--json"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      enabled: true, url: "ws://127.0.0.1:9010", rePairRequired: false,
    });
    expect(status.stdout).not.toContain(enabled.relay!.hostSecret!);
    expect(status.stdout).not.toContain(paired.relayToken!);

    expect(cli(dir, ["relay", "rotate-key", "--yes"]).status).toBe(0);
    expect(loadConfig(dir).relay?.hostSecret).not.toBe(enabled.relay?.hostSecret);
    expect(relayPairingForDevice(loadConfig(dir), loadDevices(dir)[0]!)).toBeNull();
    expect(cli(dir, ["relay", "disable"]).status).toBe(0);
    expect(loadConfig(dir).relay?.enabled).toBe(false);
  }, 20_000);
});

describe("RelayHostClient", () => {
  it("does a full idempotent device registration sync, reconnects with jitter, and stops cleanly", async () => {
    const relay = await relayServer();
    const snapshots: Array<{ routeId: string; generation: number; credentials: Array<{ deviceId: string }> }> = [];
    let first: WebSocket | null = null;
    relay.wss.on("connection", (ws) => {
      let routeId = "";
      let authed = false;
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as {
          routeId?: string; hostSecret?: string; type?: string; generation?: number;
          credentials?: Array<{ deviceId: string }>;
        };
        if (!authed) {
          expect(message).toMatchObject({ v: 1 });
          expect(message).not.toHaveProperty("type");
          routeId = message.routeId!;
          authed = true;
          first ??= ws;
          return;
        }
        if (message.type !== "host.device-sync") return;
        snapshots.push({ routeId, generation: message.generation!, credentials: message.credentials! });
        ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: message.generation }));
        ws.send(JSON.stringify({ type: "host.ready", v: 1, routeId, generation: message.generation }));
      });
    });
    const states: string[] = [];
    const client = new RelayHostClient({
      devMode: true,
      minReconnectMs: 5,
      maxReconnectMs: 10,
      random: () => 1,
      onStream: () => {},
      onStatus: (status) => states.push(status.state),
    });
    const firstDevice = device("first");
    client.update(config(relay.url), [firstDevice]);
    await waitFor(() => snapshots.length === 1 && client.status().state === "online");
    first!.close();
    await waitFor(() => snapshots.length === 2);

    client.update(config(relay.url), [firstDevice, device("second")]);
    await waitFor(() => snapshots.length >= 3 && client.status().devices.ready === 2);
    expect(snapshots.at(-1)!.credentials.map((item) => item.deviceId).sort()).toEqual([
      firstDevice.relayDeviceId!, "device_second_0123456789",
    ].sort());
    // A revocation is an omission in the next atomic full snapshot; the relay
    // uses replacement semantics to invalidate any stream for the removed ID.
    client.update(config(relay.url), [firstDevice]);
    await waitFor(() => snapshots.length >= 4);
    expect(snapshots.at(-1)!.credentials).toEqual([
      expect.objectContaining({ deviceId: firstDevice.relayDeviceId }),
    ]);
    client.close();
    const countAtClose = snapshots.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(snapshots).toHaveLength(countAtClose);
    expect(states).toContain("online");
    await relay.close();
  });

  it("rejects insecure non-loopback relay URLs outside explicitly dev mode", () => {
    const client = new RelayHostClient({ onStream: () => {} });
    client.update(config("ws://127.0.0.1:9000"), [device("one")]);
    expect(client.status()).toMatchObject({ state: "error", lastError: "relay URL or key is invalid" });
    client.close();
  });
});

describe("relay stream socket joins the existing E2E server path", () => {
  it("accepts v13 E2E hello and encrypted ping after offer/accept/ready without dev plaintext", async () => {
    const dir = home();
    const relay = await relayServer();
    const paired = mintDevice(dir, { name: "phone", allowShell: true });
    const relayConfig = config(relay.url);
    saveConfig(dir, relayConfig);
    const daemonPub = loadIdentity(dir).publicKey;
    let channel: SecureChannel | undefined;
    let startState: ReturnType<typeof clientHandshakeStart>["state"] | undefined;
    const received: S2CMessage[] = [];
    let streamSocket: WebSocket | undefined;
    let hostPhase = 0;
    let streamPhase = 0;
    relay.wss.on("connection", (ws, req) => {
      if (req.url === "/v1/host") {
        let routeId = "";
        ws.on("message", (raw) => {
          const text = raw.toString();
          if (hostPhase === 0) {
            const auth = JSON.parse(text) as { routeId: string; hostSecret: string };
            expect(auth.hostSecret).toHaveLength(43);
            routeId = auth.routeId;
            hostPhase = 1;
            return;
          }
          if (hostPhase === 1) {
            const sync = JSON.parse(text) as { generation: number; type: string };
            expect(sync.type).toBe("host.device-sync");
            hostPhase = 2;
            ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: sync.generation }));
            ws.send(JSON.stringify({ type: "host.ready", v: 1, routeId, generation: sync.generation }));
            setTimeout(() => ws.send(JSON.stringify({
              type: "stream.offer", v: 1, streamId: "stream_0123456789",
              ticket: "ticket_0123456789", deviceId: paired.relayDeviceId!, expiresAt: Date.now() + 10_000,
            })), 0);
          }
        });
        return;
      }
      expect(req.url).toBe("/v1/stream");
      streamSocket = ws;
      ws.on("message", (raw) => {
        const text = raw.toString();
        if (streamPhase === 0) {
          expect(JSON.parse(text)).toMatchObject({ type: "stream.accept", ticket: "ticket_0123456789" });
          streamPhase = 1;
          ws.send(JSON.stringify({ type: "stream.ready", v: 1, streamId: "stream_0123456789" }));
          const start = clientHandshakeStart(13);
          startState = start.state;
          setTimeout(() => ws.send(start.frame), 0);
          return;
        }
        if (streamPhase === 1) {
          // The temporary frame was sent to daemon; this is its authenticated proof.
          // Recreate the same start state from an outer closure below.
          const finish = clientHandshakeFinish(startState!, text, daemonPub, {
            type: "hello",
            token: paired.token,
            clientPubKey: generateKeyPairB64().publicKey,
            clientInfo: { platform: "ios", appVersion: "test" },
          });
          channel = finish.channel;
          streamPhase = 2;
          ws.send(finish.frame);
          return;
        }
        if (channel) received.push(parseS2C(channel.open(text)));
      });
    });
    let daemon: DaemonServer | undefined;
    try {
      daemon = await createDaemonServer({ home: dir, port: 0, devMode: true });
      await waitFor(() => received.some((message) => message.type === "hello.ok"));
      expect(daemon.relay.status().state).toBe("online");
      // Send through the relay-connected data socket: it must use encrypted
      // application ping/pong, not WebSocket transport ping or dev plaintext.
      streamSocket!.send(channel!.seal({ type: "connection.ping", id: "relay-ping" }));
      await waitFor(() => received.some((message) => message.type === "connection.pong"));
      expect(received).toContainEqual({ type: "connection.pong", id: "relay-ping" });
    } finally {
      await daemon?.close();
      await relay.close();
    }
  }, 20_000);
});

describe("daemon relay hot reload and status redaction", () => {
  it("starts/stops relay registrations when config.json changes without restarting direct daemon state", async () => {
    const dir = home();
    const relay = await relayServer();
    mintDevice(dir, { name: "watch-phone", allowShell: true });
    let syncs = 0;
    relay.wss.on("connection", (ws, req) => {
      expect(req.url).toBe("/v1/host");
      let routeId = "";
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { routeId?: string; type?: string; generation?: number };
        if (!message.type) {
          routeId = message.routeId!;
          return;
        }
        if (message.type !== "host.device-sync") return;
        syncs++;
        ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: message.generation }));
        ws.send(JSON.stringify({ type: "host.ready", v: 1, routeId, generation: message.generation }));
      });
    });
    let daemon: DaemonServer | undefined;
    try {
      daemon = await createDaemonServer({ home: dir, port: 0, devMode: true });
      const port = daemon.port;
      const direct = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`, { perMessageDeflate: true });
      await new Promise<void>((resolve, reject) => {
        direct.once("open", resolve);
        direct.once("error", reject);
      });
      expect(direct.extensions).toBe("");
      const tooLargeClosed = new Promise<number>((resolve) => direct.once("close", (code) => resolve(code)));
      direct.send(Buffer.alloc(16 * 1024 * 1024 + 1));
      expect(await tooLargeClosed).toBe(1009);
      saveConfig(dir, config(relay.url));
      await waitFor(() => daemon!.relay.status().state === "online" && syncs === 1);
      expect(daemon.port).toBe(port);
      await waitFor(() => {
        try {
          return Boolean(JSON.parse(readFileSync(path.join(dir, "status.json"), "utf8")).relay);
        } catch {
          return false;
        }
      });
      const status = JSON.parse(readFileSync(path.join(dir, "status.json"), "utf8")) as {
        relay: Record<string, unknown>;
      };
      expect(status.relay).toMatchObject({ state: "online", url: relay.url });
      expect(JSON.stringify(status.relay)).not.toContain(loadConfig(dir).relay!.hostSecret!);
      saveConfig(dir, { ...loadConfig(dir), relay: { ...loadConfig(dir).relay!, enabled: false } });
      await waitFor(() => daemon!.relay.status().state === "disabled");
      expect(daemon.port).toBe(port);
    } finally {
      await daemon?.close();
      await relay.close();
    }
  }, 20_000);
});
