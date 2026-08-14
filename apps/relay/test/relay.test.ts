import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { deriveRelayRouteId, MAX_RELAY_CONTROL_FRAME_BYTES, MAX_RELAY_DATA_FRAME_BYTES } from "@prospero/protocol";
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
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

class DeferredGate {
  readonly entered: Promise<void>;
  private readonly markEntered: () => void;
  private readonly released: Promise<void>;
  private readonly markReleased: () => void;
  constructor() {
    this.entered = new Promise((resolve) => { this.markEntered = resolve; });
    this.released = new Promise((resolve) => { this.markReleased = resolve; });
  }
  arrive(): void { this.markEntered(); }
  async wait(): Promise<void> { await this.released; }
  release(): void { this.markReleased(); }
}

class OneShotDeferredRouteStore extends MemoryRouteStore {
  private gate: DeferredGate | undefined;
  deferNextSnapshot(): DeferredGate { const gate = new DeferredGate(); this.gate = gate; return gate; }
  override async applyDeviceSnapshot(...args: Parameters<MemoryRouteStore["applyDeviceSnapshot"]>) {
    const gate = this.gate; this.gate = undefined;
    if (gate !== undefined) { gate.arrive(); await gate.wait(); }
    return super.applyDeviceSnapshot(...args);
  }
}

class DeferredEphemeralStore extends MemoryEphemeralStore {
  private cacheGate: DeferredGate | undefined;
  private presenceGate: DeferredGate | undefined;
  private connectionGate: DeferredGate | undefined;
  private clientAuthGate: DeferredGate | undefined;
  private redeemGate: DeferredGate | undefined;
  readonly presenceWrites: Array<{ routeId: string; connectionId: string }> = [];
  private presenceWaiters: Array<() => void> = [];
  deferNextCache(): DeferredGate { const gate = new DeferredGate(); this.cacheGate = gate; return gate; }
  deferNextPresence(): DeferredGate { const gate = new DeferredGate(); this.presenceGate = gate; return gate; }
  deferConnectionAdmission(): DeferredGate { const gate = new DeferredGate(); this.connectionGate = gate; return gate; }
  deferClientAuth(): DeferredGate { const gate = new DeferredGate(); this.clientAuthGate = gate; return gate; }
  deferTicketRedeem(): DeferredGate { const gate = new DeferredGate(); this.redeemGate = gate; return gate; }
  async waitForPresenceWrites(count: number): Promise<void> {
    while (this.presenceWrites.length < count) await new Promise<void>((resolve) => this.presenceWaiters.push(resolve));
  }
  override async cacheCredential(...args: Parameters<MemoryEphemeralStore["cacheCredential"]>): Promise<void> {
    const gate = this.cacheGate; this.cacheGate = undefined;
    if (gate !== undefined) { gate.arrive(); await gate.wait(); }
    await super.cacheCredential(...args);
  }
  override async setPresence(...args: Parameters<MemoryEphemeralStore["setPresence"]>): Promise<void> {
    const gate = this.presenceGate; this.presenceGate = undefined;
    if (gate !== undefined) { gate.arrive(); await gate.wait(); }
    await super.setPresence(...args);
    this.presenceWrites.push({ routeId: args[0], connectionId: args[1] });
    for (const waiter of this.presenceWaiters.splice(0)) waiter();
  }
  override async consumeRateLimit(...args: Parameters<MemoryEphemeralStore["consumeRateLimit"]>) {
    const gate = args[0].startsWith("connection:") ? this.connectionGate : args[0].startsWith("auth:client:") ? this.clientAuthGate : undefined;
    if (args[0].startsWith("connection:")) this.connectionGate = undefined;
    if (args[0].startsWith("auth:client:")) this.clientAuthGate = undefined;
    if (gate !== undefined) { gate.arrive(); await gate.wait(); }
    return super.consumeRateLimit(...args);
  }
  override async redeemTicket(...args: Parameters<MemoryEphemeralStore["redeemTicket"]>) {
    const gate = this.redeemGate; this.redeemGate = undefined;
    if (gate !== undefined) { gate.arrive(); await gate.wait(); }
    return super.redeemTicket(...args);
  }
}

class FailingEphemeralStore extends MemoryEphemeralStore {
  failCache = false; failPublish = false; failPresence = false;
  override async cacheCredential(...args: Parameters<MemoryEphemeralStore["cacheCredential"]>): Promise<void> { if (this.failCache) throw new Error("cache unavailable"); await super.cacheCredential(...args); }
  override async publish(...args: Parameters<MemoryEphemeralStore["publish"]>): Promise<void> { if (this.failPublish) throw new Error("publish unavailable"); await super.publish(...args); }
  override async setPresence(...args: Parameters<MemoryEphemeralStore["setPresence"]>): Promise<void> { if (this.failPresence) throw new Error("presence unavailable"); await super.setPresence(...args); }
}

class PostWriteThrowRouteStore extends MemoryRouteStore {
  private snapshotGate: DeferredGate | undefined;
  deferNextSnapshotWriteThenThrow(): DeferredGate { const gate = new DeferredGate(); this.snapshotGate = gate; return gate; }
  override async applyDeviceSnapshot(...args: Parameters<MemoryRouteStore["applyDeviceSnapshot"]>) {
    const snapshot = await super.applyDeviceSnapshot(...args);
    const gate = this.snapshotGate; this.snapshotGate = undefined;
    if (gate === undefined) return snapshot;
    gate.arrive(); await gate.wait();
    throw new Error("snapshot write acknowledgement lost");
  }
}

class PostWriteThrowEphemeralStore extends MemoryEphemeralStore {
  private cacheGate: DeferredGate | undefined;
  private presenceGate: DeferredGate | undefined;
  deferNextCacheWriteThenThrow(): DeferredGate { const gate = new DeferredGate(); this.cacheGate = gate; return gate; }
  deferNextPresenceWriteThenThrow(): DeferredGate { const gate = new DeferredGate(); this.presenceGate = gate; return gate; }
  override async cacheCredential(...args: Parameters<MemoryEphemeralStore["cacheCredential"]>): Promise<void> {
    await super.cacheCredential(...args);
    const gate = this.cacheGate; this.cacheGate = undefined;
    if (gate === undefined) return;
    gate.arrive(); await gate.wait();
    throw new Error("cache write acknowledgement lost");
  }
  override async setPresence(...args: Parameters<MemoryEphemeralStore["setPresence"]>): Promise<void> {
    await super.setPresence(...args);
    const gate = this.presenceGate; this.presenceGate = undefined;
    if (gate === undefined) return;
    gate.arrive(); await gate.wait();
    throw new Error("presence write acknowledgement lost");
  }
}

describe("relay v1 independent data-plane service", () => {
  const running: RelayServer[] = [];
  afterEach(async () => { await Promise.all(running.splice(0).map((relay) => relay.close())); });

  async function start(overrides: Partial<RelayConfig> = {}, routes = new MemoryRouteStore(), ephemeral = new MemoryEphemeralStore(), shutdownGraceMs?: number) {
    const relay = new RelayServer({ routes, ephemeral, config: { ...config(), ...overrides }, logger: createLogger("silent"), ...(shutdownGraceMs === undefined ? {} : { shutdownGraceMs }) });
    await relay.listen(); running.push(relay); const address = relay.address(); if (address === undefined) throw new Error("missing address");
    return { relay, routes, ephemeral, url: `ws://127.0.0.1:${address.port}` };
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

  it("keeps a disabled self-registered route as a tombstone", async () => {
    const { url, routes } = await start();
    const first = await hostOnline(url); await close(first);
    expect(await routes.disableRoute(routeId)).toBe(true);
    const retry = await open(`${url}/v1/host`); const retryClosed = once(retry, "close");
    retry.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    expect(JSON.parse((await next(retry)).data.toString())).toMatchObject({ type: "error", code: "route_unavailable" });
    expect((await retryClosed)[0]).toBe(1008);
    expect((await routes.inspectRoute(routeId))?.disabledAt).not.toBeNull();
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
    // A restart sends the active set again; the old missing device remains a
    // retained revoked DB row without having to be re-listed on the wire.
    await expect(routes.applyDeviceSnapshot(routeId, 2, [activeCredential(deviceId, token)])).resolves.toMatchObject({ route: { generation: 2 } });
    await expect(routes.applyDeviceSnapshot(routeId, 1, [activeCredential(deviceId, token), { deviceId: secondDevice, revoked: true }])).rejects.toThrow("stale or inconsistent");
    await expect(routes.applyDeviceSnapshot(routeId, 2, [activeCredential(deviceId, token), { deviceId: secondDevice, revoked: true }])).resolves.toMatchObject({ route: { generation: 2 } });
    await expect(routes.applyDeviceSnapshot(routeId, 2, [activeCredential(deviceId, "V".repeat(43))])).rejects.toThrow("stale or inconsistent");
    await expect(routes.applyDeviceSnapshot(routeId, 2, [activeCredential(deviceId, token), { deviceId: "e".repeat(22), revoked: true }])).rejects.toThrow("stale or inconsistent");
  });

  it("fences timed-out and superseded hosts across deferred snapshot, cache, and presence work", async () => {
    const timedOutRoutes = new OneShotDeferredRouteStore(); const timedOutEphemeral = new DeferredEphemeralStore();
    const timedOut = await start({ authTimeoutMs: 40 }, timedOutRoutes, timedOutEphemeral);
    const slow = await open(`${timedOut.url}/v1/host`); const snapshotGate = timedOutRoutes.deferNextSnapshot(); const slowClosed = once(slow, "close");
    slow.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    slow.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 1, credentials: [activeCredential(deviceId, token)] }));
    await snapshotGate.entered;
    expect((await slowClosed)[0]).toBe(1013);
    snapshotGate.release(); await nextTurn();
    expect(timedOutEphemeral.presence.size).toBe(0);

    const cacheRoutes = new MemoryRouteStore(); const cacheEphemeral = new DeferredEphemeralStore(); const cached = await start({}, cacheRoutes, cacheEphemeral);
    const old = await open(`${cached.url}/v1/host`); const cacheGate = cacheEphemeral.deferNextCache(); const oldClosed = once(old, "close");
    old.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    old.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 1, credentials: [activeCredential(deviceId, token)] }));
    await cacheGate.entered;
    const newer = await hostOnline(cached.url, 2);
    expect((await oldClosed)[0]).toBe(4009);
    const newestPresence = cacheEphemeral.presence.get(routeId);
    cacheGate.release(); await nextTurn();
    expect(cacheEphemeral.presence.get(routeId)).toBe(newestPresence);
    await close(newer);

    const presenceRoutes = new MemoryRouteStore(); const presenceEphemeral = new DeferredEphemeralStore(); const present = await start({}, presenceRoutes, presenceEphemeral);
    const previous = await open(`${present.url}/v1/host`); const presenceGate = presenceEphemeral.deferNextPresence(); const previousClosed = once(previous, "close");
    previous.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    previous.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 1, credentials: [activeCredential(deviceId, token)] }));
    await presenceGate.entered;
    const current = await hostOnline(present.url, 2);
    expect((await previousClosed)[0]).toBe(4009);
    const currentPresence = presenceEphemeral.presence.get(routeId);
    presenceGate.release();
    await presenceEphemeral.waitForPresenceWrites(3);
    expect(presenceEphemeral.presence.get(routeId)).toBe(currentPresence);
    await close(current);

    // H1's delayed write is repairing H2 exactly as H3 takes over. H2 can
    // therefore land after H3, be compare-deleted, and must re-resolve H3
    // instead of leaving the route with no presence marker.
    const tripleRoutes = new MemoryRouteStore(); const tripleEphemeral = new DeferredEphemeralStore(); const triple = await start({}, tripleRoutes, tripleEphemeral);
    const h1 = await open(`${triple.url}/v1/host`); const h1PresenceGate = tripleEphemeral.deferNextPresence(); const h1Closed = once(h1, "close");
    h1.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    h1.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 1, credentials: [activeCredential(deviceId, token)] }));
    await h1PresenceGate.entered;
    const h2 = await hostOnline(triple.url, 2); const h2Closed = once(h2, "close");
    expect((await h1Closed)[0]).toBe(4009);
    const h2RepairGate = tripleEphemeral.deferNextPresence();
    h1PresenceGate.release(); await h2RepairGate.entered;
    const h3 = await hostOnline(triple.url, 3);
    expect((await h2Closed)[0]).toBe(4009);
    const h3Presence = tripleEphemeral.presence.get(routeId);
    h2RepairGate.release();
    await tripleEphemeral.waitForPresenceWrites(5);
    expect(tripleEphemeral.presence.get(routeId)).toBe(h3Presence);
    await close(h3);
  });

  it.each(["snapshot", "cache", "presence"] as const)("fails the newer owner closed after an ambiguous stale %s write", async (operation) => {
    const routes = new PostWriteThrowRouteStore(); const ephemeral = new PostWriteThrowEphemeralStore();
    const { url } = await start({}, routes, ephemeral);
    const gate = operation === "snapshot"
      ? routes.deferNextSnapshotWriteThenThrow()
      : operation === "cache"
        ? ephemeral.deferNextCacheWriteThenThrow()
        : ephemeral.deferNextPresenceWriteThenThrow();
    const old = await open(`${url}/v1/host`); const oldClosed = once(old, "close");
    old.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    old.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 1, credentials: [activeCredential(deviceId, token)] }));
    await gate.entered;

    const newer = await hostOnline(url, 2);
    expect((await oldClosed)[0]).toBe(4009);

    const pending = await clientPending(url);
    const pendingOffer = JSON.parse((await next(newer)).data.toString()) as { streamId: string; ticket: string };
    const live = await clientPending(url);
    const liveOffer = JSON.parse((await next(newer)).data.toString()) as { streamId: string; ticket: string };
    const dataSocket = await open(`${url}/v1/stream`);
    dataSocket.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: liveOffer.streamId, ticket: liveOffer.ticket }));
    await next(dataSocket); await next(live.client);

    const newerClosed = once(newer, "close"); const pendingClosed = once(pending.client, "close");
    const liveClosed = once(live.client, "close"); const dataClosed = once(dataSocket, "close");
    gate.release();
    expect((await newerClosed)[0]).toBe(1013);
    expect((await pendingClosed)[0]).toBe(1013);
    expect((await liveClosed)[0]).toBe(1013);
    expect((await dataClosed)[0]).toBe(1013);
    await nextTurn();
    expect(ephemeral.presence.has(routeId)).toBe(false);
    expect(ephemeral.tickets.size).toBe(0);
    expect(ephemeral.leases.size).toBe(0);
    expect(pendingOffer.streamId).not.toBe(liveOffer.streamId);

    const offline = await open(`${url}/v1/client`); const offlineClosed = once(offline, "close");
    offline.send(JSON.stringify({ type: "client.open", v: 1, routeId, deviceId, token }));
    expect(JSON.parse((await next(offline)).data.toString())).toMatchObject({ type: "error", code: "route_unavailable" });
    expect((await offlineClosed)[0]).toBe(1008);
  });

  it("cancels pre-ready and closed peers before they can leave client-open or redeem side effects", async () => {
    const ephemeral = new DeferredEphemeralStore(); const { relay, url } = await start({}, new MemoryRouteStore(), ephemeral);
    const host = await hostOnline(url);
    const preReady = await open(`${url}/v1/client`); const authGate = ephemeral.deferClientAuth(); const preReadyClosed = once(preReady, "close");
    preReady.send(JSON.stringify({ type: "client.open", v: 1, routeId, deviceId, token }));
    preReady.send("not control");
    await authGate.entered;
    expect((await preReadyClosed)[0]).toBe(1008);
    authGate.release(); await nextTurn();
    expect(ephemeral.tickets.size).toBe(0); expect(ephemeral.leases.size).toBe(0); expect(inbox(host).queue).toHaveLength(0);

    const closedClient = await open(`${url}/v1/client`); const closeGate = ephemeral.deferClientAuth();
    closedClient.send(JSON.stringify({ type: "client.open", v: 1, routeId, deviceId, token }));
    await closeGate.entered;
    const clientGone = once(closedClient, "close"); closedClient.close(); await clientGone;
    closeGate.release(); await nextTurn();
    expect(ephemeral.tickets.size).toBe(0); expect(ephemeral.leases.size).toBe(0); expect(inbox(host).queue).toHaveLength(0);

    const pending = await clientPending(url); const offer = JSON.parse((await next(host)).data.toString()) as { streamId: string; ticket: string };
    const redeemGate = ephemeral.deferTicketRedeem(); const stream = await open(`${url}/v1/stream`); const streamGone = once(stream, "close"); const pendingGone = once(pending.client, "close");
    stream.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket }));
    await redeemGate.entered;
    stream.close(); await streamGone;
    redeemGate.release(); await pendingGone; await nextTurn();
    expect(inbox(stream).queue).toHaveLength(0); expect(ephemeral.tickets.has(offer.ticket)).toBe(false); expect(ephemeral.leases.size).toBe(0);
    const metricValues = (await relay.metrics.connections.get()).values.map((value) => value.value);
    expect(metricValues.every((value) => value >= 0)).toBe(true);
    await close(host); await relay.close();
    expect((await relay.metrics.connections.get()).values.every((value) => value.value === 0)).toBe(true);
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

  it("bounds shutdown for stalled close handshakes and never upgrades a deferred admission after stopping", async () => {
    const first = await start({}, new MemoryRouteStore(), new MemoryEphemeralStore(), 25);
    const host = await hostOnline(first.url);
    const rawSocket = (host as unknown as { _socket?: { pause: () => void } })._socket;
    expect(rawSocket).toBeDefined(); rawSocket?.pause();
    const started = Date.now(); await first.relay.close();
    expect(Date.now() - started).toBeLessThan(750);
    host.terminate();

    const deferred = new DeferredEphemeralStore(); const second = await start({}, new MemoryRouteStore(), deferred, 100);
    const admissionGate = deferred.deferConnectionAdmission(); const delayed = new WebSocket(`${second.url}/v1/client`); delayed.on("error", () => undefined);
    await admissionGate.entered;
    const closing = second.relay.close();
    admissionGate.release();
    await closing; await nextTurn();
    expect(delayed.readyState).not.toBe(WebSocket.OPEN);
    delayed.terminate();
  });

  it("rejects URL query credentials and closes both peers for pre-ready stream data", async () => {
    const { url } = await start({ ticketTimeoutMs: 5_000 });
    const rejected = new WebSocket(`${url}/v1/stream?ticket=must-not-be-here`);
    rejected.on("error", () => undefined);
    const status = await new Promise<number | undefined>((resolve) => {
      rejected.once("unexpected-response", (_request, response) => { response.resume(); resolve(response.statusCode); });
    });
    expect(status).toBe(400);

    const host = await hostOnline(url); const { client } = await clientPending(url);
    const offer = JSON.parse((await next(host)).data.toString()) as { streamId: string; ticket: string };
    const stream = await open(`${url}/v1/stream`);
    const clientClosed = once(client, "close"); const streamClosed = once(stream, "close");
    stream.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket }));
    stream.send("application data before stream.ready");
    expect((await streamClosed)[0]).toBe(1008);
    expect((await clientClosed)[0]).toBe(1008);
    await close(host);
  });

  it("enforces control and data limits and closes the opposite data peer", async () => {
    const { url } = await start({ ticketTimeoutMs: 5_000 });
    const oversizedHost = await open(`${url}/v1/host`);
    const oversizedHostClosed = once(oversizedHost, "close");
    oversizedHost.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    oversizedHost.send("x".repeat(MAX_RELAY_CONTROL_FRAME_BYTES + 1));
    expect((await oversizedHostClosed)[0]).toBe(1008);

    const host = await hostOnline(url); const { client } = await clientPending(url);
    const offer = JSON.parse((await next(host)).data.toString()) as { streamId: string; ticket: string };
    const stream = await open(`${url}/v1/stream`);
    stream.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket }));
    await next(stream); await next(client);
    const clientClosed = once(client, "close"); const streamClosed = once(stream, "close");
    client.send(Buffer.alloc(MAX_RELAY_DATA_FRAME_BYTES + 1));
    expect((await clientClosed)[0]).toBe(1009);
    expect((await streamClosed)[0]).toBe(1009);
    await close(host);
  });

  it("closes the client when an authenticated host data socket disappears", async () => {
    const { url } = await start(); const host = await hostOnline(url); const { client } = await clientPending(url);
    const offer = JSON.parse((await next(host)).data.toString()) as { streamId: string; ticket: string };
    const stream = await open(`${url}/v1/stream`);
    stream.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket }));
    await next(stream); await next(client);
    const clientClosed = once(client, "close");
    await close(stream);
    expect((await clientClosed)[0]).toBe(1000);
    await close(host);
  });

  it("requires a bounded initial snapshot after host authentication", async () => {
    const { url } = await start({ authTimeoutMs: 40 }); const host = await open(`${url}/v1/host`);
    const closed = once(host, "close"); host.send(JSON.stringify({ v: 1, routeId, hostSecret }));
    expect((await closed)[0]).toBe(1013);
  });
});
