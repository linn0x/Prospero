import { once } from "node:events";
import { createLogger } from "../src/log.js";
import { RelayServer } from "../src/relay.js";
import type { RelayConfig } from "../src/config.js";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryEphemeralStore, MemoryRouteStore } from "./helpers.js";

const routeId = "r".repeat(22);
const hostId = "h".repeat(22);
const clientId = "c".repeat(22);
const hostToken = "H".repeat(43);
const clientToken = "C".repeat(43);

function config(): RelayConfig {
  return {
    host: "127.0.0.1", port: 0, mysqlUrl: "", redisUrl: "", migrationDir: "", metricsInternalOnly: true,
    maxStreamsPerRoute: 8, authTimeoutMs: 500, ticketTimeoutMs: 1_000, credentialCacheTtlSeconds: 60,
    presenceTtlSeconds: 20, authRatePerMinute: 20, connectionRatePerMinute: 60, cleanupIntervalMs: 60_000, logLevel: "silent",
  };
}

async function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  await once(ws, "open");
  return ws;
}

async function next(ws: WebSocket): Promise<{ data: Buffer; binary: boolean }> {
  const [data, binary] = await once(ws, "message") as [Buffer, boolean];
  return { data: Buffer.from(data), binary };
}

async function close(ws: WebSocket): Promise<void> {
  if (ws.readyState >= WebSocket.CLOSING) return;
  const event = once(ws, "close");
  ws.close();
  await event;
}

describe("relay v1 service", () => {
  const running: RelayServer[] = [];
  afterEach(async () => { await Promise.all(running.splice(0).map((relay) => relay.close())); });

  async function start(overrides: Partial<RelayConfig> = {}) {
    const routes = new MemoryRouteStore();
    const ephemeral = new MemoryEphemeralStore();
    await routes.createRoute(routeId, hostId, hostToken);
    await routes.addDevice(routeId, clientId, clientToken);
    const relay = new RelayServer({ routes, ephemeral, config: { ...config(), ...overrides }, logger: createLogger("silent") });
    await relay.listen();
    running.push(relay);
    const address = relay.address();
    if (address === undefined) throw new Error("missing address");
    return { routes, ephemeral, relay, url: `ws://127.0.0.1:${address.port}` };
  }

  async function hostOnline(url: string): Promise<WebSocket> {
    const host = await open(`${url}/v1/host`);
    host.send(JSON.stringify({ type: "host.register", v: 1, routeId, deviceId: hostId, token: hostToken }));
    expect(JSON.parse((await next(host)).data.toString())).toMatchObject({ type: "host.ready", routeId });
    return host;
  }

  it("authenticates first frames, atomically warms all devices, and fails closed", async () => {
    const { url, ephemeral, routes } = await start();
    const bad = await open(`${url}/v1/host`);
    bad.send(JSON.stringify({ type: "host.register", v: 1, routeId, deviceId: hostId, token: clientToken }));
    expect(JSON.parse((await next(bad)).data.toString()).code).toBe("unauthorized");
    await once(bad, "close");
    const host = await hostOnline(url);
    expect(ephemeral.cached.size).toBe(2);
    expect(ephemeral.presence.has(routeId)).toBe(true);
    await close(host);
    routes.available = false;
    const unavailable = await open(`${url}/v1/host`);
    unavailable.send(JSON.stringify({ type: "host.register", v: 1, routeId, deviceId: hostId, token: hostToken }));
    expect(JSON.parse((await next(unavailable)).data.toString()).code).toBe("internal");
  });

  it("reports offline routes and lets newest authenticated host win", async () => {
    const { url } = await start();
    const client = await open(`${url}/v1/client`);
    client.send(JSON.stringify({ type: "client.connect", v: 1, routeId, deviceId: clientId, token: clientToken }));
    expect(JSON.parse((await next(client)).data.toString()).code).toBe("route_unavailable");
    await once(client, "close");
    const oldHost = await hostOnline(url);
    const oldClose = once(oldHost, "close");
    const newHost = await hostOnline(url);
    const [code] = await oldClose as [number];
    expect(code).toBe(4009);
    await close(newHost);
  });

  it("redeems stream tickets once and forwards opaque text/binary frames unchanged", async () => {
    const { url } = await start();
    const host = await hostOnline(url);
    const client = await open(`${url}/v1/client`);
    client.send(JSON.stringify({ type: "client.connect", v: 1, routeId, deviceId: clientId, token: clientToken }));
    const connected = JSON.parse((await next(client)).data.toString()) as { streamId: string };
    const offered = JSON.parse((await next(host)).data.toString()) as { streamId: string };
    expect(offered.streamId).toBe(connected.streamId);
    client.send("early-frame");
    const stream = await open(`${url}/v1/stream`);
    stream.send(JSON.stringify({ type: "stream.open", v: 1, streamId: connected.streamId }));
    const early = await next(stream);
    expect(early.binary).toBe(false);
    expect(early.data.toString()).toBe("early-frame");
    client.send(Buffer.from([1, 2, 3]));
    const binary = await next(stream);
    expect(binary.binary).toBe(true);
    expect([...binary.data]).toEqual([1, 2, 3]);
    stream.send("host-frame");
    expect((await next(client)).data.toString()).toBe("host-frame");
    const reused = await open(`${url}/v1/stream`);
    reused.send(JSON.stringify({ type: "stream.open", v: 1, streamId: connected.streamId }));
    expect(JSON.parse((await next(reused)).data.toString()).code).toBe("unauthorized");
    await close(stream);
    await close(client);
    await close(host);
  });

  it("closes live streams immediately when a device is revoked", async () => {
    const { url, ephemeral, routes } = await start();
    const host = await hostOnline(url);
    const client = await open(`${url}/v1/client`);
    client.send(JSON.stringify({ type: "client.connect", v: 1, routeId, deviceId: clientId, token: clientToken }));
    const streamId = (JSON.parse((await next(client)).data.toString()) as { streamId: string }).streamId;
    await next(host);
    const stream = await open(`${url}/v1/stream`);
    stream.send(JSON.stringify({ type: "stream.open", v: 1, streamId }));
    const closed = once(client, "close");
    await routes.revokeDevice(routeId, clientId);
    await ephemeral.publish({ type: "device.revoked", routeId, deviceId: clientId });
    expect((await closed)[0]).toBe(1008);
    await close(stream);
    await close(host);
  });

  it("enforces Redis-backed rate limits and keeps disabled tombstones during cleanup", async () => {
    const { url, ephemeral, routes } = await start();
    const ws = await open(`${url}/v1/host`);
    ephemeral.limitAllowed = false;
    ws.send(JSON.stringify({ type: "host.register", v: 1, routeId, deviceId: hostId, token: hostToken }));
    expect(JSON.parse((await next(ws)).data.toString()).code).toBe("rate_limited");
    await routes.disableRoute(routeId);
    const removed = await routes.cleanupInactiveRoutes(new Date(Date.now() + 1_000));
    expect(removed).toBe(0);
    expect(await routes.inspectRoute(routeId)).not.toBeNull();
  });

  it("enforces route stream limits and closes a pre-host queue above 32 MiB", async () => {
    const limited = await start({ maxStreamsPerRoute: 1, ticketTimeoutMs: 5_000 });
    const host = await hostOnline(limited.url);
    const first = await open(`${limited.url}/v1/client`);
    first.send(JSON.stringify({ type: "client.connect", v: 1, routeId, deviceId: clientId, token: clientToken }));
    await next(first);
    await next(host);
    const second = await open(`${limited.url}/v1/client`);
    second.send(JSON.stringify({ type: "client.connect", v: 1, routeId, deviceId: clientId, token: clientToken }));
    expect(JSON.parse((await next(second)).data.toString()).code).toBe("rate_limited");
    await once(second, "close");
    const closed = once(first, "close");
    const frame = Buffer.alloc(15 * 1024 * 1024, 7);
    first.send(frame);
    first.send(frame);
    first.send(frame);
    expect((await closed)[0]).toBe(1013);
    await close(host);
  }, 20_000);

  it("survives a process restart when durable route state remains and removes old enabled routes", async () => {
    const routes = new MemoryRouteStore();
    const ephemeral = new MemoryEphemeralStore();
    await routes.createRoute(routeId, hostId, hostToken);
    await routes.addDevice(routeId, clientId, clientToken);
    const first = new RelayServer({ routes, ephemeral, config: config(), logger: createLogger("silent") });
    await first.listen();
    const firstAddress = first.address();
    if (firstAddress === undefined) throw new Error("missing address");
    const firstHost = await hostOnline(`ws://127.0.0.1:${firstAddress.port}`);
    await close(firstHost);
    await first.close();
    const second = new RelayServer({ routes, ephemeral, config: config(), logger: createLogger("silent") });
    await second.listen();
    running.push(second);
    const secondAddress = second.address();
    if (secondAddress === undefined) throw new Error("missing address");
    const secondHost = await hostOnline(`ws://127.0.0.1:${secondAddress.port}`);
    await close(secondHost);
    const stale = routes.routes.get(routeId);
    if (stale === undefined) throw new Error("missing route");
    stale.lastSeenAt = new Date(0);
    expect(await routes.cleanupInactiveRoutes(new Date(1))).toBe(1);
    expect(await routes.inspectRoute(routeId)).toBeNull();
  });
});
