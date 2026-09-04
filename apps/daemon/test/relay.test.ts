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
  issueRelayCredentials,
  persistRelayCredentials,
  relayPairingForDevice,
  rotateRelayKey,
  saveConfig,
  saveDevices,
  type DaemonConfig,
  type DeviceRecord,
} from "../src/pairing.js";
import { RELAY_SYNC_STATE_FILE, RelayHostClient } from "../src/relay-host-client.js";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";

const homes: string[] = [];

function home(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), "prospero-relay-test-"));
  homes.push(value);
  return value;
}

function expectPrivateFile(file: string): void {
  const stats = statSync(file);
  expect(stats.isFile()).toBe(true);
  // Windows reports POSIX compatibility mode bits from its ACL translation;
  // 0600 is enforceable and meaningful only on POSIX. Windows coverage still
  // verifies the file lifecycle and that secrets never enter status output.
  if (process.platform !== "win32") expect(stats.mode & 0o777).toBe(0o600);
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
    relayCredentialIssued: true,
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
  it("keeps direct pairings relay-inactive until credentials are rendered in a relay QR", () => {
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
    expect(fresh.relayDeviceId).toBeUndefined();
    expect(relayPairingForDevice(
      { port: 7423, relay: { enabled: true, url: "wss://relay.example.test/v1", hostSecret: secret } },
      fresh,
    )).toBeNull();
    const issued = issueRelayCredentials(fresh);
    expect(issued.relayDeviceId).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(issued.relayToken).toMatch(/^[A-Za-z0-9_-]{16,}$/);

    const relay = relayPairingForDevice(
      { port: 7423, relay: { enabled: true, url: "wss://relay.example.test/v1", hostSecret: secret } },
      issued,
    );
    expect(relay).toMatchObject({ url: "wss://relay.example.test/v1", routeId: first });
    expect(relayPairingForDevice(
      { port: 7423, relay: { enabled: true, url: "wss://relay.example.test/v1", hostSecret: secret } },
      { name: "old-phone", token: "old-pairing-token-123", allowShell: true, createdAt: 1 },
    )).toBeNull();
    const payload = buildPairingPayload(dir, {
      token: issued.token,
      port: 7423,
      relay: relay!,
    });
    expect(payload.relay).toEqual(relay);
    expect(payload.addrs.length === 0 || payload.relay !== undefined).toBe(true);
    persistRelayCredentials(dir, issued);
    expect(relayPairingForDevice(
      { port: 7423, relay: { enabled: true, url: "wss://relay.example.test/v1", hostSecret: secret } },
      loadDevices(dir).find((device) => device.token === issued.token)!,
    )).toEqual(relay);
  });

  it("uses override before deployment default and keeps config private", () => {
    const dir = home();
    const previous = process.env["PROSPERO_DEFAULT_RELAY_URL"];
    process.env["PROSPERO_DEFAULT_RELAY_URL"] = "wss://default.example.test/v1";
    expect(effectiveRelayUrl({ port: 1 })).toBe("wss://default.example.test/v1");
    saveConfig(dir, config("wss://override.example.test/v1"));
    expect(effectiveRelayUrl(loadConfig(dir))).toBe("wss://override.example.test/v1");
    expectPrivateFile(path.join(dir, "config.json"));
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
    expectPrivateFile(path.join(dir, "config.json"));

    const paired = issueRelayCredentials(mintDevice(dir, { name: "cli-phone", allowShell: true }));
    persistRelayCredentials(dir, paired);
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

  it("requires a direct pairing made while relay was disabled to re-pair after enable", () => {
    const dir = home();
    const direct = mintDevice(dir, { name: "direct-phone", allowShell: true });
    expect(direct.relayDeviceId).toBeUndefined();
    expect(cli(dir, ["relay", "enable", "--url", "ws://127.0.0.1:9010", "--dev"]).status).toBe(0);
    const before = JSON.parse(cli(dir, ["relay", "status", "--json"]).stdout) as {
      rePairRequired: boolean; devices: { ready: number; needsRePair: number };
    };
    expect(before).toMatchObject({ rePairRequired: true, devices: { ready: 0, needsRePair: 1 } });
    expect(relayPairingForDevice(loadConfig(dir), loadDevices(dir)[0]!)).toBeNull();
  });

  it("clears credentials before a relay key rotation config write and stays conservative on failure", () => {
    const dir = home();
    const initial = config("wss://relay.example.test/v1");
    saveConfig(dir, initial);
    const paired = issueRelayCredentials(mintDevice(dir, { name: "rotate-phone", allowShell: true }));
    persistRelayCredentials(dir, paired);
    expect(() => rotateRelayKey(dir, initial, {
      saveDevices: (_home, devices) => saveDevices(dir, devices),
      saveConfig: () => { throw new Error("simulated config write failure"); },
    })).toThrow("simulated config write failure");
    const retainedConfig = loadConfig(dir);
    const cleared = loadDevices(dir)[0]!;
    expect(retainedConfig.relay?.hostSecret).toBe(initial.relay?.hostSecret);
    expect(relayPairingForDevice(retainedConfig, cleared)).toBeNull();
  });
});

describe("RelayHostClient", () => {
  it("does a full idempotent device registration sync, reconnects with jitter, and stops cleanly", async () => {
    const relay = await relayServer();
    const snapshots: Array<{ routeId: string; generation: number; credentials: Array<{ deviceId: string }> }> = [];
    let first: WebSocket | null = null;
    let reconnected: WebSocket | null = null;
    let connections = 0;
    relay.wss.on("connection", (ws) => {
      const connection = ++connections;
      let routeId = "";
      let authed = false;
      let syncsOnConnection = 0;
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
        syncsOnConnection++;
        snapshots.push({ routeId, generation: message.generation!, credentials: message.credentials! });
        ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: message.generation }));
        if (syncsOnConnection === 1) {
          if (connection === 2) reconnected = ws;
          else ws.send(JSON.stringify({ type: "host.ready", v: 1, routeId, generation: message.generation }));
        }
      });
    });
    const states: string[] = [];
    const client = new RelayHostClient({
      devMode: true,
      minReconnectMs: 5,
      maxReconnectMs: 10,
      random: () => 1,
      stateDir: home(),
      onStream: () => {},
      onStatus: (status) => states.push(status.state),
    });
    const firstDevice = device("first");
    client.update(config(relay.url), [firstDevice]);
    await waitFor(() => snapshots.length === 1 && client.status().state === "online");
    first!.close();
    await waitFor(() => snapshots.length === 2);
    expect(snapshots[1]!.generation).toBeGreaterThan(snapshots[0]!.generation);
    expect(client.status().state).toBe("syncing");
    reconnected!.send(JSON.stringify({
      type: "host.ready", v: 1, routeId: snapshots[1]!.routeId, generation: snapshots[1]!.generation,
    }));
    await waitFor(() => client.status().state === "online");

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

  it("waits for ready once per control connection, then resumes later credential snapshots on ACK and heartbeat", async () => {
    const dir = home();
    const relay = await relayServer();
    const generations: number[] = [];
    const heartbeats: number[] = [];
    let routeId = "";
    let control: WebSocket | undefined;
    relay.wss.on("connection", (ws) => {
      control = ws;
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { routeId?: string; type?: string; generation?: number };
        if (!message.type) {
          routeId = message.routeId!;
          return;
        }
        if (message.type === "host.device-sync") {
          generations.push(message.generation!);
          ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: message.generation }));
          // T2's relay sends host.ready exactly once, after this connection's
          // first snapshot. The test emits that frame below and never again.
          return;
        }
        if (message.type === "host.heartbeat") {
          heartbeats.push(message.generation!);
          ws.send(JSON.stringify({ type: "host.heartbeat.ack", v: 1, generation: message.generation }));
        }
      });
    });
    const client = new RelayHostClient({
      devMode: true, stateDir: dir, minReconnectMs: 5, maxReconnectMs: 10, random: () => 1,
      heartbeatMs: 20, heartbeatAckTimeoutMs: 100, onStream: () => {},
    });
    try {
      const first = device("ready-once");
      const relayConfig = config(relay.url);
      client.update(relayConfig, [first]);
      await waitFor(() => generations.length === 1);
      expect(client.status().state).toBe("syncing");

      control!.send(JSON.stringify({
        type: "host.ready", v: 1, routeId, generation: generations[0],
      }));
      await waitFor(() => client.status().state === "online" && heartbeats.includes(generations[0]!));

      client.update(relayConfig, [first, device("ready-once-second")]);
      await waitFor(() =>
        generations.length === 2 && client.status().state === "online" && heartbeats.includes(generations[1]!),
      );
      expect(generations[1]).toBeGreaterThan(generations[0]!);
    } finally {
      client.close();
      await relay.close();
    }
  });

  it("keeps the first ready gate across an in-place credential replacement and promotes only its latest ACK", async () => {
    const dir = home();
    const relay = await relayServer();
    const generations: number[] = [];
    const heartbeats: number[] = [];
    let routeId = "";
    let control: WebSocket | undefined;
    relay.wss.on("connection", (ws) => {
      control = ws;
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { routeId?: string; type?: string; generation?: number };
        if (!message.type) {
          routeId = message.routeId!;
          return;
        }
        if (message.type === "host.device-sync") {
          generations.push(message.generation!);
          // Deliberately acknowledge both generations without ever sending a
          // replacement ready. The sole ready below belongs to the first
          // snapshot, as the T2 relay contract requires.
          ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: message.generation }));
          return;
        }
        if (message.type === "host.heartbeat") {
          heartbeats.push(message.generation!);
          ws.send(JSON.stringify({ type: "host.heartbeat.ack", v: 1, generation: message.generation }));
        }
      });
    });
    const client = new RelayHostClient({
      devMode: true, stateDir: dir, minReconnectMs: 5, maxReconnectMs: 10, random: () => 1,
      heartbeatMs: 20, heartbeatAckTimeoutMs: 100, onStream: () => {},
    });
    try {
      const records = [device("in-place-one")];
      const relayConfig = config(relay.url);
      client.update(relayConfig, records);
      await waitFor(() => generations.length === 1);

      // A watcher can retain its array and replace a record in place. The
      // previous active credential snapshot must still detect this as a relay
      // update rather than comparing the same mutated object twice.
      records[0] = { ...records[0]!, relayToken: "ticket_in-place-rotated_0123456789" };
      client.update(relayConfig, records);
      await waitFor(() => generations.length === 2);
      expect(generations[1]).toBeGreaterThan(generations[0]!);
      expect(client.status().state).toBe("syncing");
      expect(heartbeats).toEqual([]);

      control!.send(JSON.stringify({
        type: "host.ready", v: 1, routeId, generation: generations[0],
      }));
      await waitFor(() => client.status().state === "online" && heartbeats.includes(generations[1]!));
    } finally {
      client.close();
      await relay.close();
    }
  });

  it("leaves relay state untouched for lastSeen, metadata, permission, and no-op device updates", async () => {
    const dir = home();
    const relay = await relayServer();
    const snapshots: number[] = [];
    let routeId = "";
    let control: WebSocket | undefined;
    let streamReady = false;
    let streamClosed = false;
    relay.wss.on("connection", (ws, req) => {
      if (req.url === "/v1/stream") {
        ws.once("message", (raw) => {
          expect(JSON.parse(raw.toString())).toMatchObject({ type: "stream.accept" });
          ws.send(JSON.stringify({ type: "stream.ready", v: 1, streamId: "stream_metadata_012345" }));
        });
        ws.once("close", () => { streamClosed = true; });
        return;
      }
      control = ws;
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { routeId?: string; type?: string; generation?: number };
        if (!message.type) {
          routeId = message.routeId!;
          return;
        }
        if (message.type === "host.device-sync") {
          snapshots.push(message.generation!);
          ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: message.generation }));
          ws.send(JSON.stringify({ type: "host.ready", v: 1, routeId, generation: message.generation }));
          return;
        }
        if (message.type === "host.heartbeat") {
          ws.send(JSON.stringify({ type: "host.heartbeat.ack", v: 1, generation: message.generation }));
        }
      });
    });
    const client = new RelayHostClient({
      devMode: true, stateDir: dir, minReconnectMs: 5, maxReconnectMs: 10, random: () => 1,
      heartbeatMs: 1_000, heartbeatAckTimeoutMs: 1_000, onStream: () => { streamReady = true; },
    });
    try {
      const first = device("metadata");
      const relayConfig = config(relay.url);
      client.update(relayConfig, [first]);
      await waitFor(() => client.status().state === "online" && snapshots.length === 1);
      control!.send(JSON.stringify({
        type: "stream.offer", v: 1, streamId: "stream_metadata_012345", ticket: "ticket_metadata_012345",
        deviceId: first.relayDeviceId, expiresAt: Date.now() + 10_000,
      }));
      await waitFor(() => streamReady);

      const journal = path.join(dir, RELAY_SYNC_STATE_FILE);
      const journalBefore = readFileSync(journal, "utf8");
      const metadataOnly = {
        ...first,
        name: "metadata-renamed",
        lastSeenAt: 2,
        allowShell: false,
        allowOrchestration: false,
      };
      client.update(relayConfig, [metadataOnly]);
      client.update(relayConfig, [{ ...metadataOnly, lastSeenAt: 3 }]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(snapshots).toHaveLength(1);
      expect(readFileSync(journal, "utf8")).toBe(journalBefore);
      expect(streamClosed).toBe(false);
    } finally {
      client.close();
      await relay.close();
    }
  });

  it("pauses offers and closes active data sockets until a credential replacement ACK arrives", async () => {
    const dir = home();
    const relay = await relayServer();
    let routeId = "";
    let control: WebSocket | undefined;
    let updateGeneration: number | undefined;
    const heartbeats: number[] = [];
    let streamReady = false;
    let streamClosed = false;
    let revokedOffer = false;
    relay.wss.on("connection", (ws, req) => {
      if (req.url === "/v1/stream") {
        ws.once("message", (raw) => {
          expect(JSON.parse(raw.toString())).toMatchObject({ type: "stream.accept" });
          ws.send(JSON.stringify({ type: "stream.ready", v: 1, streamId: "stream_sync_012345" }));
        });
        ws.once("close", () => { streamClosed = true; });
        return;
      }
      control = ws;
      let snapshots = 0;
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { routeId?: string; type?: string; generation?: number };
        if (!message.type) {
          routeId = message.routeId!;
          return;
        }
        if (message.type === "host.device-sync") {
          snapshots++;
          if (snapshots === 1) {
            ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: message.generation }));
            ws.send(JSON.stringify({ type: "host.ready", v: 1, routeId, generation: message.generation }));
          } else {
            updateGeneration = message.generation;
          }
          return;
        }
        if (message.type === "host.heartbeat") {
          heartbeats.push(message.generation!);
          ws.send(JSON.stringify({ type: "host.heartbeat.ack", v: 1, generation: message.generation }));
          return;
        }
        if (message.type === "stream.revoke") revokedOffer = true;
      });
    });
    const client = new RelayHostClient({
      devMode: true, stateDir: dir, minReconnectMs: 5, maxReconnectMs: 10, random: () => 1,
      heartbeatMs: 20, heartbeatAckTimeoutMs: 100, onStream: () => { streamReady = true; },
    });
    try {
      const first = device("sync-pause");
      const relayConfig = config(relay.url);
      client.update(relayConfig, [first]);
      await waitFor(() => client.status().state === "online");
      control!.send(JSON.stringify({
        type: "stream.offer", v: 1, streamId: "stream_sync_012345", ticket: "ticket_sync_012345",
        deviceId: first.relayDeviceId, expiresAt: Date.now() + 10_000,
      }));
      await waitFor(() => streamReady);

      client.update(relayConfig, [first, device("sync-pause-second")]);
      await waitFor(() => updateGeneration !== undefined && streamClosed);
      expect(client.status().state).toBe("syncing");
      control!.send(JSON.stringify({
        type: "stream.offer", v: 1, streamId: "stream_sync_new_012345", ticket: "ticket_sync_new_012345",
        deviceId: first.relayDeviceId, expiresAt: Date.now() + 10_000,
      }));
      await waitFor(() => revokedOffer);

      control!.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: updateGeneration }));
      await waitFor(() => client.status().state === "online" && heartbeats.includes(updateGeneration!));
    } finally {
      client.close();
      await relay.close();
    }
  });

  it("persists strictly increasing route-local generations across restart and initializes a rotated route independently", async () => {
    const dir = home();
    const relay = await relayServer();
    const snapshots: Array<{ routeId: string; generation: number }> = [];
    relay.wss.on("connection", (ws) => {
      let routeId = "";
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { routeId?: string; type?: string; generation?: number };
        if (!message.type) {
          routeId = message.routeId!;
          return;
        }
        if (message.type !== "host.device-sync") return;
        snapshots.push({ routeId, generation: message.generation! });
        ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: message.generation }));
        ws.send(JSON.stringify({ type: "host.ready", v: 1, routeId, generation: message.generation }));
      });
    });
    const firstConfig = config(relay.url);
    const first = new RelayHostClient({
      devMode: true, stateDir: dir, minReconnectMs: 5, maxReconnectMs: 10, random: () => 1, onStream: () => {},
    });
    try {
      first.update(firstConfig, [device("persist")]);
      await waitFor(() => first.status().state === "online" && snapshots.length === 1);
      expectPrivateFile(path.join(dir, RELAY_SYNC_STATE_FILE));
      first.close();

      const restarted = new RelayHostClient({
        devMode: true, stateDir: dir, minReconnectMs: 5, maxReconnectMs: 10, random: () => 1, onStream: () => {},
      });
      try {
        restarted.update(firstConfig, [device("persist")]);
        await waitFor(() => restarted.status().state === "online" && snapshots.length === 2);
        expect(snapshots[1]!.generation).toBeGreaterThan(snapshots[0]!.generation);

        const rotated = config(relay.url);
        restarted.update(rotated, [device("persist")]);
        await waitFor(() => restarted.status().state === "online" && snapshots.length === 3);
        expect(snapshots[2]).toMatchObject({
          routeId: deriveRelayRouteId(rotated.relay!.hostSecret!), generation: 1,
        });
      } finally {
        restarted.close();
      }
    } finally {
      first.close();
      await relay.close();
    }
  });

  it("brings only the latest rapid credential generation online after late ACK/ready frames, then restores heartbeat", async () => {
    const dir = home();
    const relay = await relayServer();
    const generations: number[] = [];
    const heartbeats: number[] = [];
    let controls = 0;
    let staleFramesSent = false;
    relay.wss.on("connection", (ws) => {
      let routeId = "";
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { routeId?: string; type?: string; generation?: number };
        if (!message.type) {
          routeId = message.routeId!;
          return;
        }
        if (message.type === "host.heartbeat") {
          heartbeats.push(message.generation!);
          ws.send(JSON.stringify({ type: "host.heartbeat.ack", v: 1, generation: message.generation }));
          return;
        }
        if (message.type !== "host.device-sync") return;
        controls++;
        const generation = message.generation!;
        generations.push(generation);
        if (controls === 1) {
          // ACK delivery is idempotent, and the first snapshot alone emits ready.
          ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation }));
          ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation }));
          ws.send(JSON.stringify({ type: "host.ready", v: 1, routeId, generation }));
          return;
        }
        if (controls === 2) return; // Hold this ACK until generation 3 exists.
        const previous = generations[1]!;
        ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: previous }));
        ws.send(JSON.stringify({ type: "host.ready", v: 1, routeId, generation: previous }));
        staleFramesSent = true;
        setTimeout(() => {
          // T2 only ACKs replacements on an already-ready socket.
          ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation }));
        }, 20);
      });
    });
    const client = new RelayHostClient({
      devMode: true, stateDir: dir, minReconnectMs: 5, maxReconnectMs: 10, random: () => 1, onStream: () => {},
      heartbeatMs: 20, heartbeatAckTimeoutMs: 100,
    });
    try {
      const first = device("rapid-one");
      const relayConfig = config(relay.url);
      client.update(relayConfig, [first]);
      await waitFor(() => client.status().state === "online" && generations.length === 1);
      client.update(relayConfig, [first, device("rapid-two")]);
      await waitFor(() => generations.length === 2);
      client.update(relayConfig, [first]);
      await waitFor(() => generations.length === 3 && staleFramesSent);
      expect(client.status().state).toBe("syncing");
      await waitFor(() => client.status().state === "online" && heartbeats.includes(generations[2]!));
      expect(generations[0]).toBeLessThan(generations[1]!);
      expect(generations[1]).toBeLessThan(generations[2]!);
      expect(client.status()).toMatchObject({ state: "online", devices: { ready: 1 } });
    } finally {
      client.close();
      await relay.close();
    }
  });

  it("bounds silent authentication/device-sync and ready phases with a reconnect", async () => {
    const authSilent = await relayServer();
    let authConnections = 0;
    authSilent.wss.on("connection", () => { authConnections++; });
    const authStates: string[] = [];
    const authClient = new RelayHostClient({
      devMode: true, stateDir: home(), minReconnectMs: 5, maxReconnectMs: 10, random: () => 1,
      authTimeoutMs: 20, deviceSyncTimeoutMs: 20, readyTimeoutMs: 20,
      onStream: () => {}, onStatus: (status) => authStates.push(status.state),
    });
    try {
      authClient.update(config(authSilent.url), [device("silent-auth")]);
      await waitFor(() => authConnections >= 2 && authStates.includes("error"), 1_000);
    } finally {
      authClient.close();
      await authSilent.close();
    }

    const readySilent = await relayServer();
    let readyConnections = 0;
    readySilent.wss.on("connection", (ws) => {
      readyConnections++;
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string; generation?: number };
        if (message.type === "host.device-sync") {
          // This ACK also proves auth, but deliberately withhold host.ready.
          ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: message.generation }));
        }
      });
    });
    const readyStates: string[] = [];
    const readyClient = new RelayHostClient({
      devMode: true, stateDir: home(), minReconnectMs: 5, maxReconnectMs: 10, random: () => 1,
      authTimeoutMs: 20, deviceSyncTimeoutMs: 20, readyTimeoutMs: 20,
      onStream: () => {}, onStatus: (status) => readyStates.push(status.state),
    });
    try {
      readyClient.update(config(readySilent.url), [device("silent-ready")]);
      await waitFor(() => readyConnections >= 2 && readyStates.includes("error"), 1_000);
    } finally {
      readyClient.close();
      await readySilent.close();
    }
  });

  it("closes control and active data sockets when a generation-mismatched heartbeat ACK leaves relay half-open", async () => {
    const dir = home();
    const relay = await relayServer();
    let routeId = "";
    let streamClosed = false;
    let streamOpened = false;
    relay.wss.on("connection", (ws, req) => {
      if (req.url === "/v1/host") {
        ws.on("message", (raw) => {
          const message = JSON.parse(raw.toString()) as {
            routeId?: string; type?: string; generation?: number;
          };
          if (!message.type) {
            routeId = message.routeId!;
            return;
          }
          if (message.type === "host.device-sync") {
            ws.send(JSON.stringify({ type: "host.device-sync.ack", v: 1, generation: message.generation }));
            ws.send(JSON.stringify({ type: "host.ready", v: 1, routeId, generation: message.generation }));
            setTimeout(() => ws.send(JSON.stringify({
              type: "stream.offer", v: 1, streamId: "stream_heartbeat_012345", ticket: "ticket_heartbeat_012345",
              deviceId: device("heartbeat").relayDeviceId!, expiresAt: Date.now() + 10_000,
            })), 0);
            return;
          }
          if (message.type === "host.heartbeat") {
            // It is syntactically valid but is deliberately for the wrong
            // snapshot. It must not satisfy the liveness deadline.
            ws.send(JSON.stringify({ type: "host.heartbeat.ack", v: 1, generation: message.generation! - 1 }));
          }
        });
        return;
      }
      expect(req.url).toBe("/v1/stream");
      ws.once("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type?: string };
        expect(message.type).toBe("stream.accept");
        streamOpened = true;
        ws.send(JSON.stringify({ type: "stream.ready", v: 1, streamId: "stream_heartbeat_012345" }));
      });
      ws.once("close", () => { streamClosed = true; });
    });
    const states: string[] = [];
    const client = new RelayHostClient({
      devMode: true, stateDir: dir, minReconnectMs: 5, maxReconnectMs: 10, random: () => 1,
      heartbeatMs: 20, heartbeatAckTimeoutMs: 100,
      onStream: () => {}, onStatus: (status) => states.push(status.state),
    });
    try {
      client.update(config(relay.url), [device("heartbeat")]);
      await waitFor(() => streamOpened);
      await waitFor(() => streamClosed && states.includes("error"), 1_000);
    } finally {
      client.close();
      await relay.close();
    }
  });
});

describe("relay stream socket joins the existing E2E server path", () => {
  it("accepts v13 E2E hello and encrypted ping after offer/accept/ready without dev plaintext", async () => {
    const dir = home();
    const relay = await relayServer();
    const relayConfig = config(relay.url);
    saveConfig(dir, relayConfig);
    const paired = issueRelayCredentials(mintDevice(dir, { name: "phone", allowShell: true }));
    persistRelayCredentials(dir, paired);
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
          const relayStatus = JSON.parse(readFileSync(path.join(dir, "status.json"), "utf8")).relay as
            | { state?: unknown; url?: unknown }
            | undefined;
          return relayStatus?.state === "online" && relayStatus.url === relay.url;
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
