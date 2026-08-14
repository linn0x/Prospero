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
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class DelayedRouteStore extends MemoryRouteStore {
  inFlight = 0; maxInFlight = 0; hold = false;
  private releaseHold: (() => void) | undefined;
  private holdEntered: Promise<void> = Promise.resolve();
  private signalHold: (() => void) | undefined;
  deferNext(): Promise<void> { this.hold = true; this.holdEntered = new Promise((resolve) => { this.signalHold = resolve; }); return this.holdEntered; }
  async applyDeviceSnapshot(...args: Parameters<MemoryRouteStore["applyDeviceSnapshot"]>) {
    this.inFlight += 1; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.hold) {
        this.signalHold?.();
        await new Promise<void>((resolve) => { this.releaseHold = resolve; });
        this.hold = false;
      }
      return await super.applyDeviceSnapshot(...args);
    } finally { this.inFlight -= 1; }
  }
  release(): void { this.releaseHold?.(); }
}

class FailingEphemeralStore extends MemoryEphemeralStore {
  failCache = false; failPublish = false; failPresence = false;
  override async cacheCredential(...args: Parameters<MemoryEphemeralStore["cacheCredential"]>): Promise<void> { if (this.failCache) throw new Error("cache unavailable"); await super.cacheCredential(...args); }
  override async publish(...args: Parameters<MemoryEphemeralStore["publish"]>): Promise<void> { if (this.failPublish) throw new Error("publish unavailable"); await super.publish(...args); }
  override async setPresence(...args: Parameters<MemoryEphemeralStore["setPresence"]>): Promise<void> { if (this.failPresence) throw new Error("presence unavailable"); await super.setPresence(...args); }
}

describe("relay v1 independent data-plane service", () => {
  const running: RelayServer[] = [];
  afterEach(async () => { await Promise.all(running.splice(0).map((relay) => relay.close())); });

  async function start(overrides: Partial<RelayConfig> = {}, routes = new MemoryRouteStore(), ephemeral = new MemoryEphemeralStore()) {
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

  it("serializes each host's control frames and does not advertise an in-progress full snapshot", async () => {
    const routes = new DelayedRouteStore(); const ephemeral = new MemoryEphemeralStore();
    const { url } = await start({}, routes, ephemeral); const host = await hostOnline(url);
    routes.maxInFlight = 0; const syncStarted = routes.deferNext();
    host.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 2, credentials: [activeCredential(deviceId, token)] }));
    await syncStarted;
    const during = await open(`${url}/v1/client`);
    during.send(JSON.stringify({ type: "client.open", v: 1, routeId, deviceId, token }));
    expect(JSON.parse((await next(during)).data.toString())).toMatchObject({ type: "error", code: "route_unavailable" });
    await once(during, "close");
    host.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 3, credentials: [activeCredential(deviceId, token)] }));
    routes.release();
    expect(JSON.parse((await next(host)).data.toString())).toMatchObject({ type: "host.device-sync.ack", generation: 2 });
    expect(JSON.parse((await next(host)).data.toString())).toMatchObject({ type: "host.device-sync.ack", generation: 3 });
    expect(routes.maxInFlight).toBe(1);
    await close(host);
  });

  it("fails a route closed when cache, publish, or heartbeat presence operations fail", async () => {
    const routes = new MemoryRouteStore(); const ephemeral = new FailingEphemeralStore();
    const { url } = await start({}, routes, ephemeral); const host = await hostOnline(url); const { client, pending } = await clientPending(url);
    const offer = JSON.parse((await next(host)).data.toString()) as { streamId: string; ticket: string };
    const stream = await open(`${url}/v1/stream`); stream.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket })); await next(stream); await next(client);
    const clientClosed = once(client, "close"); const hostClosed = once(host, "close");
    ephemeral.failCache = true;
    host.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 2, credentials: [activeCredential(deviceId, token)] }));
    expect((await clientClosed)[0]).toBe(1013);
    expect((await hostClosed)[0]).toBe(1008);
    expect(pending.streamId).toBe(offer.streamId);
    await close(stream);

    const secondRoutes = new MemoryRouteStore(); const secondEphemeral = new FailingEphemeralStore();
    const second = await start({}, secondRoutes, secondEphemeral); const heartbeatHost = await hostOnline(second.url); const heartbeatClient = await clientPending(second.url); await next(heartbeatHost);
    const heartbeatClosed = once(heartbeatClient.client, "close");
    secondEphemeral.failPresence = true;
    heartbeatHost.send(JSON.stringify({ type: "host.heartbeat", v: 1, generation: 1 }));
    expect((await heartbeatClosed)[0]).toBe(1013);
    await close(heartbeatHost);

    const thirdRoutes = new MemoryRouteStore(); const thirdEphemeral = new FailingEphemeralStore();
    const third = await start({}, thirdRoutes, thirdEphemeral); const publishHost = await hostOnline(third.url); const publishClient = await clientPending(third.url); await next(publishHost);
    const publishClosed = once(publishClient.client, "close");
    thirdEphemeral.failPublish = true;
    publishHost.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 2, credentials: [{ deviceId, revoked: true }] }));
    expect((await publishClosed)[0]).toBe(1013);
    await close(publishHost);
  });

  it("uses generation-equivalent full snapshots and retains absent devices as revocations", async () => {
    const routes = new MemoryRouteStore();
    await routes.ensureRoute(routeId);
    const secondDevice = "d".repeat(22); const secondToken = "U".repeat(43);
    await routes.applyDeviceSnapshot(routeId, 1, [activeCredential(deviceId, token), activeCredential(secondDevice, secondToken)]);
    await routes.applyDeviceSnapshot(routeId, 2, [activeCredential(deviceId, token)]);
    const retained = await routes.inspectRoute(routeId);
    expect(retained?.devices.find((device) => device.deviceId === secondDevice)?.revokedAt).not.toBeNull();
    await expect(routes.applyDeviceSnapshot(routeId, 2, [activeCredential(deviceId, token)])).rejects.toThrow("stale or inconsistent");
    await expect(routes.applyDeviceSnapshot(routeId, 1, [activeCredential(deviceId, token), { deviceId: secondDevice, revoked: true }])).rejects.toThrow("stale or inconsistent");
    await expect(routes.applyDeviceSnapshot(routeId, 2, [activeCredential(deviceId, token), { deviceId: secondDevice, revoked: true }])).resolves.toMatchObject({ route: { generation: 2 } });
  });

  it("accepts an idempotent snapshot after a host restart and fails existing streams closed on MySQL loss", async () => {
    const routes = new MemoryRouteStore(); const ephemeral = new MemoryEphemeralStore(); const { url } = await start({}, routes, ephemeral);
    const first = await hostOnline(url); await close(first);
    const restarted = await hostOnline(url);
    expect(restarted.readyState).toBe(WebSocket.OPEN);
    const pending = await clientPending(url); await next(restarted);
    const pendingClosed = once(pending.client, "close"); const hostClosed = once(restarted, "close");
    routes.available = false;
    const probe = await open(`${url}/v1/client`); probe.send(JSON.stringify({ type: "client.open", v: 1, routeId, deviceId, token }));
    expect(JSON.parse((await next(probe)).data.toString())).toMatchObject({ type: "error", code: "internal" });
    expect((await pendingClosed)[0]).toBe(1013); expect((await hostClosed)[0]).toBe(1013);
    await close(probe);
  });

  it("keeps newest presence, atomically caps concurrent client.open calls, and exactly releases leases", async () => {
    const { url, ephemeral } = await start({ maxStreamsPerRoute: 1, ticketTimeoutMs: 5_000 });
    await ephemeral.setPresence(routeId, "old", 20); await ephemeral.setPresence(routeId, "new", 20); await ephemeral.clearPresence(routeId, "old");
    expect(ephemeral.presence.get(routeId)).toBe("new");
    const host = await hostOnline(url);
    const clients = await Promise.all([open(`${url}/v1/client`), open(`${url}/v1/client`)]);
    for (const client of clients) client.send(JSON.stringify({ type: "client.open", v: 1, routeId, deviceId, token }));
    const responses = await Promise.all(clients.map(async (client) => JSON.parse((await next(client)).data.toString()) as { type: string; code?: string }));
    expect(responses.filter((response) => response.type === "client.status")).toHaveLength(1);
    expect(responses.filter((response) => response.code === "rate_limited")).toHaveLength(1);
    const pendingClient = clients[responses.findIndex((response) => response.type === "client.status")]!;
    const offer = JSON.parse((await next(host)).data.toString()) as { streamId: string; ticket: string };
    await close(pendingClient);
    await wait(5);
    const replacement = await clientPending(url);
    expect(replacement.pending.streamId).not.toBe(offer.streamId);
    await close(replacement.client); await Promise.all(clients.map(close)); await close(host);
  });

  it("distinguishes invalid, expired, and used tickets without burning a wrong streamId", async () => {
    const { url } = await start({ ticketTimeoutMs: 35 }); const host = await hostOnline(url); const { client } = await clientPending(url);
    const offer = JSON.parse((await next(host)).data.toString()) as { streamId: string; ticket: string };
    const wrong = await open(`${url}/v1/stream`); wrong.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: "x".repeat(16), ticket: offer.ticket }));
    expect(JSON.parse((await next(wrong)).data.toString())).toMatchObject({ type: "error", code: "ticket_invalid" }); await once(wrong, "close");
    const accepted = await open(`${url}/v1/stream`); accepted.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket })); await next(accepted); await next(client);
    const used = await open(`${url}/v1/stream`); used.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket }));
    expect(JSON.parse((await next(used)).data.toString())).toMatchObject({ type: "error", code: "ticket_used" }); await once(used, "close");
    await close(accepted); await close(client);

    const expiring = await clientPending(url); const expiredOffer = JSON.parse((await next(host)).data.toString()) as { streamId: string; ticket: string };
    await wait(45);
    const expired = await open(`${url}/v1/stream`); expired.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: expiredOffer.streamId, ticket: expiredOffer.ticket }));
    expect(JSON.parse((await next(expired)).data.toString())).toMatchObject({ type: "error", code: "ticket_expired" });
    await once(expired, "close"); await close(expiring.client); await close(host);
  });

  it("rejects binary pre-ready frames and tears down unauthenticated sockets during shutdown", async () => {
    const { url } = await start(); const host = await hostOnline(url); const { client } = await clientPending(url); await next(host);
    const binaryClosed = once(client, "close"); client.send(Buffer.from([7])); expect((await binaryClosed)[0]).toBe(1008);
    const raw = await open(`${url}/v1/client`); const relay = running.at(-1)!; const rawClosed = once(raw, "close"); await relay.close();
    expect((await rawClosed)[0]).toBe(1012); await close(host);
  });

  it("requires a bounded initial snapshot after host authentication", async () => {
    const { url } = await start({ authTimeoutMs: 40 }); const host = await open(`${url}/v1/host`);
    const closed = once(host, "close"); host.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    expect((await closed)[0]).toBe(1013);
  });
});
