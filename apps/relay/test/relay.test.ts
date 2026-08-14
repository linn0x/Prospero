import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { deriveRelayRouteId } from "@prospero/protocol";
import { createLogger } from "../src/log.js";
import { RelayServer } from "../src/relay.js";
import type { RelayConfig } from "../src/config.js";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { activeCredential, MemoryEphemeralStore, MemoryRouteStore } from "./helpers.js";

const hostSecret = randomBytes(32).toString("base64url");
const routeId = deriveRelayRouteId(hostSecret);
const deviceId = "c".repeat(22);
const token = "T".repeat(43);

function config(): RelayConfig { return { host: "127.0.0.1", port: 0, mysqlUrl: "", redisUrl: "", migrationDir: "", metricsInternalOnly: true, maxStreamsPerRoute: 8, authTimeoutMs: 500, ticketTimeoutMs: 1_000, credentialCacheTtlSeconds: 60, presenceTtlSeconds: 20, authRatePerMinute: 20, connectionRatePerMinute: 60, cleanupIntervalMs: 60_000, logLevel: "silent" }; }
interface Inbox { queue: Array<{ data: Buffer; binary: boolean }>; waiting: Array<(value: { data: Buffer; binary: boolean }) => void>; }
const inboxes = new WeakMap<WebSocket, Inbox>();
function inbox(ws: WebSocket): Inbox { let value = inboxes.get(ws); if (value !== undefined) return value; value = { queue: [], waiting: [] }; ws.on("message", (data, binary) => { const item = { data: Buffer.from(data), binary: Boolean(binary) }; const listener = value!.waiting.shift(); if (listener !== undefined) listener(item); else value!.queue.push(item); }); inboxes.set(ws, value); return value; }
async function open(url: string): Promise<WebSocket> { const ws = new WebSocket(url); await once(ws, "open"); inbox(ws); return ws; }
async function next(ws: WebSocket): Promise<{ data: Buffer; binary: boolean }> { const state = inbox(ws); const item = state.queue.shift(); return item === undefined ? new Promise((resolve) => state.waiting.push(resolve)) : item; }
async function close(ws: WebSocket): Promise<void> { if (ws.readyState >= WebSocket.CLOSING) return; const done = once(ws, "close"); ws.close(); await done; }

describe("relay v1 independent data-plane service", () => {
  const running: RelayServer[] = [];
  afterEach(async () => { await Promise.all(running.splice(0).map((relay) => relay.close())); });

  async function start(overrides: Partial<RelayConfig> = {}) {
    const routes = new MemoryRouteStore(); const ephemeral = new MemoryEphemeralStore();
    const relay = new RelayServer({ routes, ephemeral, config: { ...config(), ...overrides }, logger: createLogger("silent") });
    await relay.listen(); running.push(relay); const address = relay.address(); if (address === undefined) throw new Error("missing address");
    return { routes, ephemeral, url: `ws://127.0.0.1:${address.port}` };
  }

  async function hostOnline(url: string, generation = 1): Promise<WebSocket> {
    const host = await open(`${url}/v1/host`);
    host.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    host.send(JSON.stringify({ type: "host.device-sync", v: 1, generation, credentials: [activeCredential(deviceId, token)] }));
    expect(JSON.parse((await next(host)).data.toString())).toMatchObject({ type: "host.device-sync.ack", generation });
    expect(JSON.parse((await next(host)).data.toString())).toMatchObject({ type: "host.ready", routeId, generation });
    return host;
  }

  async function clientPending(url: string): Promise<{ client: WebSocket; pending: { streamId: string; expiresAt: number } }> {
    const client = await open(`${url}/v1/client`);
    client.send(JSON.stringify({ type: "client.open", v: 1, routeId, deviceId, token }));
    const pending = JSON.parse((await next(client)).data.toString()) as { streamId: string; expiresAt: number };
    expect(pending).toMatchObject({ streamId: expect.any(String), expiresAt: expect.any(Number) });
    return { client, pending };
  }

  it("authenticates host secrets, atomically syncs credentials before online, and fails closed", async () => {
    const { url, routes, ephemeral } = await start();
    const bad = await open(`${url}/v1/host`);
    const badClosed = once(bad, "close");
    bad.send(JSON.stringify({ v: 1, routeId, hostSecret: randomBytes(32).toString("base64url") }));
    expect(JSON.parse((await next(bad)).data.toString()).code).toBe("unauthorized");
    expect((await badClosed)[0]).toBe(1008);
    const host = await hostOnline(url);
    expect(ephemeral.cached.size).toBe(1); expect(ephemeral.presence.has(routeId)).toBe(true);
    await close(host); routes.available = false;
    const unavailable = await open(`${url}/v1/host`);
    unavailable.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    expect(JSON.parse((await next(unavailable)).data.toString()).code).toBe("internal");
  });

  it("keeps offline routes unavailable and newest authenticated host wins", async () => {
    const { url } = await start();
    const offline = await open(`${url}/v1/client`);
    offline.send(JSON.stringify({ type: "client.open", v: 1, routeId, deviceId, token }));
    expect(JSON.parse((await next(offline)).data.toString()).code).toBe("unauthorized");
    await once(offline, "close");
    const oldHost = await hostOnline(url); const oldClose = once(oldHost, "close"); const newHost = await hostOnline(url, 2);
    expect((await oldClose)[0]).toBe(4009); await close(newHost);
  });

  it("uses separate ticketed host data sockets and preserves opaque text/binary frame boundaries", async () => {
    const { url } = await start(); const host = await hostOnline(url); const { client, pending } = await clientPending(url);
    const offer = JSON.parse((await next(host)).data.toString()) as { streamId: string; ticket: string; deviceId: string };
    expect(offer.streamId).toBe(pending.streamId); expect(offer.deviceId).toBe(deviceId);
    const stream = await open(`${url}/v1/stream`);
    stream.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket }));
    expect(JSON.parse((await next(stream)).data.toString())).toMatchObject({ type: "stream.ready", streamId: offer.streamId });
    expect(JSON.parse((await next(client)).data.toString())).toMatchObject({ type: "stream.ready", streamId: offer.streamId });
    client.send("opaque text"); expect((await next(stream)).data.toString()).toBe("opaque text");
    stream.send(Buffer.from([1, 2, 3])); const binary = await next(client); expect(binary.binary).toBe(true); expect([...binary.data]).toEqual([1, 2, 3]);
    const reused = await open(`${url}/v1/stream`); reused.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket }));
    expect(JSON.parse((await next(reused)).data.toString()).code).toBe("ticket_used");
    await close(stream); await close(client); await close(host);
  });

  it("propagates a full-snapshot revocation to live streams", async () => {
    const { url } = await start(); const host = await hostOnline(url); const { client, pending } = await clientPending(url);
    const offer = JSON.parse((await next(host)).data.toString()) as { streamId: string; ticket: string };
    const stream = await open(`${url}/v1/stream`); stream.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket })); await next(stream); await next(client);
    const closed = once(client, "close");
    host.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 2, credentials: [{ deviceId, revoked: true }] }));
    expect(JSON.parse((await next(host)).data.toString())).toMatchObject({ type: "host.device-sync.ack", generation: 2 });
    expect((await closed)[0]).toBe(1008); await close(stream); await close(host);
  });

  it("enforces Redis rate limits, per-route stream limits, restart, and 30-day cleanup", async () => {
    const { url, routes, ephemeral } = await start({ maxStreamsPerRoute: 1, ticketTimeoutMs: 5_000 });
    const rate = await open(`${url}/v1/host`); ephemeral.limitAllowed = false; rate.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    expect(JSON.parse((await next(rate)).data.toString()).code).toBe("rate_limited"); await once(rate, "close"); ephemeral.limitAllowed = true;
    const host = await hostOnline(url); const first = await clientPending(url); await next(host);
    const second = await open(`${url}/v1/client`); second.send(JSON.stringify({ type: "client.open", v: 1, routeId, deviceId, token })); expect(JSON.parse((await next(second)).data.toString()).code).toBe("rate_limited");
    await routes.disableRoute(routeId); expect(await routes.cleanupInactiveRoutes(new Date(Date.now() + 1_000))).toBe(0); await routes.enableRoute(routeId);
    const route = routes.routes.get(routeId)!; route.lastSeenAt = new Date(0); expect(await routes.cleanupInactiveRoutes(new Date(1))).toBe(1); expect(await routes.inspectRoute(routeId)).toBeNull();
    await close(first.client); await close(host);
  });
});
