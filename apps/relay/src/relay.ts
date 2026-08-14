import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  MAX_RELAY_CONTROL_FRAME_BYTES,
  MAX_RELAY_DATA_FRAME_BYTES,
  RELAY_CLIENT_PATH,
  RELAY_HOST_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_STREAM_PATH,
  parseRelayClientControlMessage,
  parseRelayHostAuthentication,
  parseRelayHostControlMessage,
  parseRelayStreamControlMessage,
  type RelayErrorCode,
} from "@prospero/protocol";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { equalCredentialDigest, opaqueLogId, randomOpaque, routeIdMatchesHostSecret } from "./crypto.js";
import type { RelayConfig } from "./config.js";
import { RelayMetrics } from "./metrics.js";
import { SnapshotGenerationError, type EphemeralStore, type RouteStore, type SnapshotCredential } from "./store.js";
import type { AuthenticatedDevice, RelayEvent, StreamTicket } from "./types.js";

const BACKPRESSURE_LIMIT_BYTES = 32 * 1024 * 1024;
const OFFLINE_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000;
const STREAM_LEASE_TTL_MS = 60_000;
const SHUTDOWN_GRACE_MS = 5_000;
type Endpoint = "host" | "client" | "stream";
type Data = Buffer | ArrayBuffer | Buffer[];

interface HostConnection {
  id: string;
  routeId: string;
  ws: WebSocket;
  generation: number | null;
  online: boolean;
  readySent: boolean;
  syncing: boolean;
  closed: boolean;
  lastHeartbeat: number;
  heartbeatWatch?: NodeJS.Timeout;
  readyTimeout: NodeJS.Timeout;
  controlChain: Promise<void>;
}

interface StreamConnection {
  id: string;
  routeId: string;
  clientDeviceId: string;
  hostConnectionId: string;
  client: WebSocket;
  host?: WebSocket;
  ready: boolean;
  timeout: NodeJS.Timeout;
  ticket: string;
  leaseId: string;
  leaseWatch: NodeJS.Timeout;
  closed: boolean;
}

interface RelayDependencies { routes: RouteStore; ephemeral: EphemeralStore; config: RelayConfig; logger: Logger; metrics?: RelayMetrics; }

function bytesOf(data: Data): number { return Buffer.isBuffer(data) ? data.length : data instanceof ArrayBuffer ? data.byteLength : data.reduce((sum, part) => sum + part.length, 0); }
function safeJson(data: Data): unknown { return JSON.parse((Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data)).toString("utf8")) as unknown; }
function sourceIp(request: IncomingMessage): string { const forwarded = request.headers["x-forwarded-for"]; const first = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined; return first && first.length <= 64 ? first : request.socket.remoteAddress ?? "unknown"; }
function isInternal(address: string | undefined): boolean { if (address === undefined) return false; const ip = address.replace(/^::ffff:/, ""); return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip); }
function isOpen(ws: WebSocket | undefined): ws is WebSocket { return ws !== undefined && ws.readyState === WebSocket.OPEN; }
function errorKind(error: unknown): string { return error instanceof Error ? error.name : "unknown"; }
function closeCodeForSocketError(error: unknown): number {
  return error instanceof RangeError && /max payload size exceeded/i.test(error.message) ? 1009 : 1013;
}

export class RelayServer {
  private readonly routes: RouteStore;
  private readonly ephemeral: EphemeralStore;
  private readonly config: RelayConfig;
  private readonly logger: Logger;
  readonly metrics: RelayMetrics;
  private readonly http: Server;
  private readonly hostWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_RELAY_DATA_FRAME_BYTES });
  private readonly clientWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_RELAY_DATA_FRAME_BYTES });
  private readonly streamWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_RELAY_DATA_FRAME_BYTES });
  private readonly hosts = new Map<string, HostConnection>();
  private readonly streams = new Map<string, StreamConnection>();
  private readonly sockets = new Set<WebSocket>();
  private stopping = false;
  private unsubscribe: (() => Promise<void>) | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  /** Wakes graceful shutdown when the last upgraded socket actually closes. */
  private shutdownDrain: (() => void) | undefined;

  constructor(deps: RelayDependencies) {
    this.routes = deps.routes; this.ephemeral = deps.ephemeral; this.config = deps.config; this.logger = deps.logger; this.metrics = deps.metrics ?? new RelayMetrics();
    this.http = createServer((request, response) => this.handleHttp(request, response));
    this.http.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.hostWss.on("connection", (ws, request) => { this.trackSocket(ws); this.handleHost(ws, request); });
    this.clientWss.on("connection", (ws, request) => { this.trackSocket(ws); this.handleClient(ws, request); });
    this.streamWss.on("connection", (ws, request) => { this.trackSocket(ws); this.handleStream(ws, request); });
  }

  async listen(): Promise<number> {
    await this.requireDependencies();
    this.unsubscribe = await this.ephemeral.subscribe((event) => this.applyEvent(event));
    this.cleanupTimer = setInterval(() => void this.runCleanup(), this.config.cleanupIntervalMs).unref();
    await new Promise<void>((resolve, reject) => { this.http.once("error", reject); this.http.listen(this.config.port, this.config.host, () => { this.http.off("error", reject); resolve(); }); });
    const address = this.address();
    if (address === undefined) throw new Error("relay did not bind TCP");
    this.logger.info({ event: "relay.listening", port: address.port }, "relay listening");
    return address.port;
  }

  async close(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer);
    for (const host of this.hosts.values()) this.closeSocket(host.ws, 1012, "relay shutdown");
    for (const stream of this.streams.values()) this.closeStream(stream, 1012, "relay shutdown");
    for (const socket of this.sockets) this.closeSocket(socket, 1012, "relay shutdown");
    await this.closeHttpWithDeadline();
    await this.unsubscribe?.(); this.unsubscribe = undefined;
  }

  address(): AddressInfo | undefined { const address = this.http.address(); return address !== null && typeof address !== "string" ? address : undefined; }
  private async requireDependencies(): Promise<void> { await Promise.all([this.routes.ping(), this.ephemeral.ping()]); }
  private async ready(): Promise<boolean> {
    try {
      await this.requireDependencies();
      return true;
    } catch (error) {
      this.logger.warn({ event: "relay.dependency_unavailable", error: errorKind(error) }, "relay dependency unavailable");
      // Dependency health is global, but fail-closed state is route scoped: do
      // not leave any authenticated host advertising an online route after a
      // Redis/MySQL probe has failed.
      this.failAllRoutes("dependency health check failed");
      return false;
    }
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (path === "/health/live") { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end('{"status":"live"}'); return; }
    if (path === "/health/ready") {
      void this.ready()
        .then((ready) => response.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" }).end(ready ? '{"status":"ready"}' : '{"status":"unavailable"}'))
        .catch(() => response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" }).end('{"status":"unavailable"}'));
      return;
    }
    if (path === "/metrics") {
      const auth = request.headers.authorization;
      const value = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const tokenOk = this.config.metricsToken !== undefined && value.length === this.config.metricsToken.length && timingSafeEqual(Buffer.from(value), Buffer.from(this.config.metricsToken));
      if (!tokenOk && (this.config.metricsToken !== undefined || this.config.metricsInternalOnly === false || !isInternal(request.socket.remoteAddress))) { response.writeHead(403).end(); return; }
      void this.metrics.registry.metrics()
        .then((body) => response.writeHead(200, { "content-type": this.metrics.registry.contentType, "cache-control": "no-store" }).end(body))
        .catch((error: unknown) => {
          this.logger.warn({ event: "relay.metrics_failed", error: errorKind(error) }, "metrics scrape failed");
          response.writeHead(503).end();
        });
      return;
    }
    response.writeHead(404).end();
  }

  private handleUpgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    if (this.stopping) { socket.destroy(); return; }
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    // Query strings are never part of relay endpoint identity. Reject them
    // rather than silently allowing a ticket to be leaked through an URL or an
    // access log and then duplicated in the first control frame.
    if (url.search !== "") { socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    const path = url.pathname;
    const server = path === RELAY_HOST_PATH ? this.hostWss : path === RELAY_CLIENT_PATH ? this.clientWss : path === RELAY_STREAM_PATH ? this.streamWss : undefined;
    if (server === undefined) { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    void this.allowConnection(sourceIp(request)).then((allowed) => {
      if (!allowed) { socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      server.handleUpgrade(request, socket, head, (ws) => server.emit("connection", ws, request));
    }).catch(() => { socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); });
  }

  private async allowConnection(ip: string): Promise<boolean> { const verdict = await this.ephemeral.consumeRateLimit(`connection:${ip}`, this.config.connectionRatePerMinute, 60); if (!verdict.allowed) this.metrics.rateLimited.inc({ scope: "connection" }); return verdict.allowed; }
  private async allowAuth(endpoint: Endpoint, ip: string): Promise<boolean> { const verdict = await this.ephemeral.consumeRateLimit(`auth:${endpoint}:${ip}`, this.config.authRatePerMinute, 60); if (!verdict.allowed) this.metrics.rateLimited.inc({ scope: "auth" }); return verdict.allowed; }

  private trackSocket(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on("error", () => undefined);
    ws.once("close", () => { this.sockets.delete(ws); this.shutdownDrain?.(); });
  }
  private async closeHttpWithDeadline(): Promise<void> {
    await new Promise<void>((resolve) => {
      let finished = false;
      let deadline: NodeJS.Timeout | undefined;
      let httpClosed = false;
      const drain = () => { if (httpClosed && this.sockets.size === 0) finish(); };
      const finish = () => {
        if (!finished) {
          finished = true;
          if (deadline !== undefined) clearTimeout(deadline);
          if (this.shutdownDrain === drain) this.shutdownDrain = undefined;
          resolve();
        }
      };
      this.shutdownDrain = drain;
      deadline = setTimeout(() => {
        for (const socket of this.sockets) { try { socket.terminate(); } catch { /* already gone */ } }
        finish();
      }, SHUTDOWN_GRACE_MS).unref();
      this.http.close(() => { httpClosed = true; drain(); });
    });
  }

  private setupFirstFrame(ws: WebSocket, request: IncomingMessage, endpoint: Endpoint, onAuth: (data: Data, install: (handler: (message: Data, binary: boolean) => void) => void) => Promise<void>): void {
    this.metrics.connections.inc({ endpoint, phase: "unauthenticated" });
    let received = false;
    const timeout = setTimeout(() => this.closeSocket(ws, 1008, "authentication timeout"), this.config.authTimeoutMs).unref();
    let subsequent: ((message: Data, binary: boolean) => void) | undefined;
    const queued: Array<{ message: Data; binary: boolean }> = [];
    ws.on("message", (data, binary) => {
      if (received) {
        if (subsequent === undefined) {
          // Only hosts have a legitimate second control frame (device-sync) that
          // can arrive while authentication awaits storage. Client and stream
          // endpoints have no pre-ready frame at all: accepting text here would
          // let application data race stream.ready and become opaque data.
          if (endpoint !== "host" || binary || bytesOf(data) > MAX_RELAY_CONTROL_FRAME_BYTES || queued.length > 0) { this.closeSocket(ws, 1008, "pre-ready frame invalid"); return; }
          queued.push({ message: data, binary });
        }
        else subsequent(data, binary);
        return;
      }
      received = true; clearTimeout(timeout); this.metrics.connections.dec({ endpoint, phase: "unauthenticated" });
      if (binary || bytesOf(data) > MAX_RELAY_CONTROL_FRAME_BYTES) { this.metrics.authFailures.inc({ endpoint, reason: "bad_frame" }); this.sendErrorAndClose(ws, "bad_frame", "invalid control frame"); return; }
      const install = (handler: (message: Data, binary: boolean) => void) => { subsequent = handler; for (const item of queued.splice(0)) handler(item.message, item.binary); };
      void onAuth(data, install).catch((error) => { this.logger.warn({ event: "relay.auth_error", endpoint, ip: sourceIp(request), error: errorKind(error) }, "authentication failed"); this.metrics.authFailures.inc({ endpoint, reason: "internal" }); this.sendErrorAndClose(ws, "internal", "relay unavailable"); });
    });
    ws.once("close", () => { clearTimeout(timeout); if (!received) this.metrics.connections.dec({ endpoint, phase: "unauthenticated" }); });
  }

  private handleHost(ws: WebSocket, request: IncomingMessage): void {
    this.setupFirstFrame(ws, request, "host", async (data, install) => {
      let auth;
      try { auth = parseRelayHostAuthentication(safeJson(data)); } catch { this.sendErrorAndClose(ws, "bad_frame", "expected host authentication"); return; }
      if (!(await this.allowAuth("host", sourceIp(request)))) { this.sendErrorAndClose(ws, "rate_limited", "too many attempts", 60_000); return; }
      if (!isOpen(ws)) return;
      if (!(await this.ready())) { this.sendErrorAndClose(ws, "internal", "relay unavailable"); return; }
      if (!isOpen(ws)) return;
      if (!routeIdMatchesHostSecret(auth.routeId, auth.hostSecret)) { this.metrics.authFailures.inc({ endpoint: "host", reason: "unauthorized" }); this.sendErrorAndClose(ws, "unauthorized", "authentication failed"); return; }
      const route = await this.routes.ensureRoute(auth.routeId);
      if (route === null) { this.sendErrorAndClose(ws, "route_unavailable", "route disabled"); return; }
      if (!isOpen(ws)) return;
      let host!: HostConnection;
      const readyTimeout = setTimeout(() => this.failHost(host, "initial snapshot timeout"), this.config.authTimeoutMs).unref();
      host = { id: randomUUID(), routeId: auth.routeId, ws, generation: null, online: false, readySent: false, syncing: false, closed: false, lastHeartbeat: Date.now(), readyTimeout, controlChain: Promise.resolve() };
      const prior = this.hosts.get(host.routeId);
      this.hosts.set(host.routeId, host);
      if (prior !== undefined && prior.id !== host.id) {
        this.failHost(prior, "host superseded", 4009);
        this.closeSocket(prior.ws, 4009, "superseded by newer host");
      }
      this.metrics.connections.inc({ endpoint: "host", phase: "authenticated" });
      install((message, binary) => this.enqueueHostControl(host, message, binary));
      ws.once("close", () => this.hostClosed(host));
      this.logger.info({ event: "relay.host_authenticated", route: opaqueLogId(host.routeId) }, "host authenticated; awaiting device snapshot");
    });
  }

  private enqueueHostControl(host: HostConnection, data: Data, binary: boolean): void {
    host.controlChain = host.controlChain
      .then(async () => { if (!host.closed) await this.handleHostControl(host, data, binary); })
      .catch((error: unknown) => this.handleHostControlFailure(host, error));
  }

  private handleHostControlFailure(host: HostConnection, error: unknown): void {
    if (error instanceof SnapshotGenerationError) this.sendErrorAndClose(host.ws, "bad_frame", "stale or inconsistent device snapshot");
    else this.sendErrorAndClose(host.ws, "internal", "relay unavailable");
    this.logger.warn({ event: "relay.host_control_failed", route: opaqueLogId(host.routeId), error: errorKind(error) }, "host control failed closed");
    this.failHost(host, "host control failure");
  }

  private async handleHostControl(host: HostConnection, data: Data, binary: boolean): Promise<void> {
    if (binary || bytesOf(data) > MAX_RELAY_CONTROL_FRAME_BYTES) { this.failHost(host, "invalid control frame", 1008); return; }
    let control;
    try { control = parseRelayHostControlMessage(safeJson(data)); } catch { this.failHost(host, "invalid control frame", 1008); return; }
    if (control.type === "host.device-sync") {
      // A full replacement is never advertised as online while its DB/cache/event
      // work is incomplete. Existing data sockets remain opaque until a failure
      // closes them, but no new offer can be created in this interval.
      host.online = false; host.syncing = true;
      const credentials: SnapshotCredential[] = control.credentials.map((item) => item.revoked === true ? { deviceId: item.deviceId, revoked: true } : { deviceId: item.deviceId, credentialDigest: item.credentialDigest });
      const snapshot = await this.routes.applyDeviceSnapshot(host.routeId, control.generation, credentials);
      if (snapshot === null) { this.sendErrorAndClose(host.ws, "route_unavailable", "route disabled"); this.failHost(host, "route disabled", 1008); return; }
      for (const device of snapshot.devices) await this.ephemeral.cacheCredential(device, snapshot.route.disabledAt, this.config.credentialCacheTtlSeconds);
      for (const device of snapshot.devices) {
        if (device.revokedAt !== null) await this.ephemeral.publish({ type: "device.revoked", routeId: host.routeId, deviceId: device.deviceId });
      }
      await this.ephemeral.setPresence(host.routeId, host.id, this.config.presenceTtlSeconds);
      host.generation = control.generation;
      host.lastHeartbeat = Date.now();
      host.online = true; host.syncing = false;
      this.sendControl(host.ws, { type: "host.device-sync.ack", v: RELAY_PROTOCOL_VERSION, generation: control.generation }, () => this.failHost(host, "host sync acknowledgement write failed"));
      if (!host.readySent) {
        host.readySent = true; clearTimeout(host.readyTimeout);
        host.heartbeatWatch = setInterval(() => { if (Date.now() - host.lastHeartbeat > this.config.presenceTtlSeconds * 1000) this.failHost(host, "host heartbeat timeout"); }, Math.max(1_000, Math.floor(this.config.presenceTtlSeconds * 500))).unref();
        this.sendControl(host.ws, { type: "host.ready", v: RELAY_PROTOCOL_VERSION, routeId: host.routeId, generation: control.generation }, () => this.failHost(host, "host ready write failed"));
        this.logger.info({ event: "relay.host_online", route: opaqueLogId(host.routeId) }, "host snapshot synchronized");
      }
      return;
    }
    if (control.type === "host.heartbeat") {
      if (!host.online || host.generation !== control.generation) { this.sendErrorAndClose(host.ws, "stream_not_ready", "host snapshot is not current"); this.failHost(host, "host snapshot is not current", 1008); return; }
      if (!(await this.ready())) throw new Error("relay dependency unavailable during heartbeat");
      host.lastHeartbeat = Date.now();
      await this.ephemeral.setPresence(host.routeId, host.id, this.config.presenceTtlSeconds);
      this.sendControl(host.ws, { type: "host.heartbeat.ack", v: RELAY_PROTOCOL_VERSION, generation: control.generation }, () => this.failHost(host, "host heartbeat acknowledgement write failed"));
      return;
    }
    if ((control.type === "stream.revoke" || control.type === "stream.close") && this.streams.has(control.streamId)) { const stream = this.streams.get(control.streamId)!; if (stream.hostConnectionId === host.id) this.closeStream(stream, 1000, control.code); return; }
    this.failHost(host, "unexpected control frame", 1008);
  }

  private hostClosed(host: HostConnection): void {
    this.metrics.connections.dec({ endpoint: "host", phase: "authenticated" });
    host.closed = true; host.online = false; host.syncing = false; clearTimeout(host.readyTimeout);
    if (host.heartbeatWatch !== undefined) clearInterval(host.heartbeatWatch);
    if (this.hosts.get(host.routeId)?.id === host.id) this.hosts.delete(host.routeId);
    void this.ephemeral.clearPresence(host.routeId, host.id).catch((error: unknown) => this.logger.warn({ event: "relay.presence_clear_failed", route: opaqueLogId(host.routeId), error: errorKind(error) }, "presence clear failed after host close"));
    for (const stream of this.streams.values()) if (stream.hostConnectionId === host.id) this.closeStream(stream, 1013, "host disconnected");
  }

  private failHost(host: HostConnection, reason: string, code = 1013): void {
    if (host.closed) return;
    host.closed = true; host.online = false; host.syncing = false; clearTimeout(host.readyTimeout);
    if (host.heartbeatWatch !== undefined) clearInterval(host.heartbeatWatch);
    for (const stream of [...this.streams.values()]) if (stream.hostConnectionId === host.id) this.closeStream(stream, code, reason);
    void this.ephemeral.clearPresence(host.routeId, host.id).catch((error: unknown) => this.logger.warn({ event: "relay.presence_clear_failed", route: opaqueLogId(host.routeId), error: errorKind(error) }, "presence clear failed while failing route"));
    this.closeSocket(host.ws, code, reason);
  }

  private handleClient(ws: WebSocket, request: IncomingMessage): void {
    this.setupFirstFrame(ws, request, "client", async (data, install) => {
      let control;
      try { control = parseRelayClientControlMessage(safeJson(data)); } catch { this.sendErrorAndClose(ws, "bad_frame", "expected client.open"); return; }
      if (control.type !== "client.open") { this.sendErrorAndClose(ws, "bad_frame", "expected client.open"); return; }
      let leaseId: string | undefined;
      try {
        if (!(await this.allowAuth("client", sourceIp(request)))) { this.sendErrorAndClose(ws, "rate_limited", "too many attempts", 60_000); return; }
        if (!isOpen(ws)) return;
        if (!(await this.ready())) { this.failRoute(control.routeId, "dependency health check failed"); this.sendErrorAndClose(ws, "internal", "relay unavailable"); return; }
        if (!isOpen(ws)) return;
        const authenticated = await this.authenticateClient(control.routeId, control.deviceId, control.token);
        if (authenticated === null) { this.metrics.authFailures.inc({ endpoint: "client", reason: "unauthorized" }); this.sendErrorAndClose(ws, "unauthorized", "authentication failed"); return; }
        if (!isOpen(ws)) return;
        const host = this.hosts.get(control.routeId);
        if (host === undefined || !host.online || host.syncing || !isOpen(host.ws)) { this.sendErrorAndClose(ws, "route_unavailable", "route is offline"); return; }
        leaseId = randomOpaque(24);
        if (!(await this.ephemeral.acquireStreamLease(control.routeId, leaseId, this.config.maxStreamsPerRoute, STREAM_LEASE_TTL_MS))) { this.sendErrorAndClose(ws, "rate_limited", "stream limit reached", 1_000); return; }
        if (!isOpen(ws)) { await this.releaseLeaseAfterFailedOpen(control.routeId, leaseId); leaseId = undefined; return; }
        const streamId = randomOpaque(24); const ticketValue = randomOpaque(32); const expiresAt = Date.now() + this.config.ticketTimeoutMs;
        const ticket: StreamTicket = { streamId, ticket: ticketValue, routeId: control.routeId, hostConnectionId: host.id, clientDeviceId: authenticated.device.deviceId, expiresAt };
        await this.ephemeral.createTicket(ticket);
        // The client or the host may have disappeared while durable ticket
        // creation was awaiting Redis. Do not leave either a lease or a pending
        // stream owned by an already-closed socket.
        if (!isOpen(ws) || host.closed || !host.online || this.hosts.get(control.routeId)?.id !== host.id) {
          await this.ephemeral.invalidateTicket(ticketValue);
          throw new Error("stream peer disappeared during ticket creation");
        }
        const timeout = setTimeout(() => { const stream = this.streams.get(streamId); if (stream !== undefined && !stream.ready) this.closeStream(stream, 1013, "host stream timeout"); }, this.config.ticketTimeoutMs).unref();
        const leaseWatch = setInterval(() => this.refreshStreamLease(streamId), Math.floor(STREAM_LEASE_TTL_MS / 2)).unref();
        const stream: StreamConnection = { id: streamId, routeId: control.routeId, clientDeviceId: authenticated.device.deviceId, hostConnectionId: host.id, client: ws, ready: false, timeout, ticket: ticketValue, leaseId, leaseWatch, closed: false };
        this.streams.set(streamId, stream); this.metrics.streams.inc(); this.metrics.connections.inc({ endpoint: "client", phase: "authenticated" });
        install((message, binary) => this.fromClient(stream, message, binary));
        ws.once("error", (error) => this.closeStream(stream, closeCodeForSocketError(error), "client socket error", false));
        ws.once("close", (code) => {
          this.metrics.connections.dec({ endpoint: "client", phase: "authenticated" });
          this.closeStream(stream, code === 1009 ? 1009 : 1000, "client disconnected", false);
        });
        this.sendControl(ws, { type: "client.status", v: RELAY_PROTOCOL_VERSION, status: "pending", streamId, expiresAt }, () => this.closeStream(stream, 1013, "client pending write failed", false));
        this.sendControl(host.ws, { type: "stream.offer", v: RELAY_PROTOCOL_VERSION, streamId, ticket: ticketValue, deviceId: authenticated.device.deviceId, expiresAt }, () => this.failHost(host, "stream offer write failed"));
        leaseId = undefined; // Stream ownership takes over exact release below.
      } catch (error) {
        if (leaseId !== undefined) await this.releaseLeaseAfterFailedOpen(control.routeId, leaseId);
        this.logger.warn({ event: "relay.client_open_failed", route: opaqueLogId(control.routeId), error: errorKind(error) }, "client open failed closed");
        this.failRoute(control.routeId, "client open dependency failure");
        this.sendErrorAndClose(ws, "internal", "relay unavailable");
      }
    });
  }

  private failRoute(routeId: string, reason: string): void { const host = this.hosts.get(routeId); if (host !== undefined) this.failHost(host, reason); }
  private failAllRoutes(reason: string): void { for (const host of [...this.hosts.values()]) this.failHost(host, reason); }
  private async releaseLeaseAfterFailedOpen(routeId: string, leaseId: string): Promise<void> {
    try { await this.ephemeral.releaseStreamLease(routeId, leaseId); }
    catch (error) { this.logger.warn({ event: "relay.lease_release_failed", route: opaqueLogId(routeId), error: errorKind(error) }, "lease release failed closed"); this.failRoute(routeId, "stream lease release failed"); }
  }
  private refreshStreamLease(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined || stream.closed) return;
    void this.ephemeral.renewStreamLease(stream.routeId, stream.leaseId, STREAM_LEASE_TTL_MS)
      .then((renewed) => { if (!renewed) this.failRoute(stream.routeId, "stream lease lost"); })
      .catch((error: unknown) => { this.logger.warn({ event: "relay.lease_renew_failed", route: opaqueLogId(stream.routeId), error: errorKind(error) }, "lease renewal failed closed"); this.failRoute(stream.routeId, "stream lease renewal failed"); });
  }

  private async authenticateClient(routeId: string, deviceId: string, token: string): Promise<AuthenticatedDevice | null> {
    const cached = await this.ephemeral.getCachedCredential(routeId, deviceId);
    if (cached !== null && (cached.disabledAt !== null || cached.device.revokedAt !== null || !equalCredentialDigest(cached.device.credentialDigest, token))) return null;
    const authenticated = await this.routes.authenticate(routeId, deviceId, token);
    if (authenticated !== null) await this.ephemeral.cacheCredential(authenticated.device, authenticated.route.disabledAt, this.config.credentialCacheTtlSeconds);
    return authenticated;
  }

  private handleStream(ws: WebSocket, request: IncomingMessage): void {
    this.setupFirstFrame(ws, request, "stream", async (data, install) => {
      let control;
      try { control = parseRelayStreamControlMessage(safeJson(data)); } catch { this.sendErrorAndClose(ws, "bad_frame", "expected stream.accept"); return; }
      if (control.type !== "stream.accept") { this.sendErrorAndClose(ws, "bad_frame", "expected stream.accept"); return; }
      const expected = this.streams.get(control.streamId);
      try {
        if (!(await this.allowAuth("stream", sourceIp(request)))) { this.sendErrorAndClose(ws, "rate_limited", "too many attempts", 60_000); return; }
        if (!isOpen(ws)) { if (expected !== undefined) this.closeStream(expected, 1008, "pre-ready stream frame"); return; }
        if (!(await this.ready())) { if (expected !== undefined) this.failRoute(expected.routeId, "dependency health check failed"); this.sendErrorAndClose(ws, "internal", "relay unavailable"); return; }
        if (!isOpen(ws)) { if (expected !== undefined) this.closeStream(expected, 1008, "pre-ready stream frame"); return; }
        const redemption = await this.ephemeral.redeemTicket(control.ticket, control.streamId);
        if (redemption.status !== "ok") {
          const code: RelayErrorCode = redemption.status === "used" ? "ticket_used" : redemption.status === "expired" ? "ticket_expired" : "ticket_invalid";
          this.metrics.authFailures.inc({ endpoint: "stream", reason: code });
          this.sendErrorAndClose(ws, code, code === "ticket_used" ? "stream ticket already used" : code === "ticket_expired" ? "stream ticket expired" : "stream ticket invalid");
          return;
        }
        const ticket = redemption.ticket;
        const stream = this.streams.get(ticket.streamId); const host = this.hosts.get(ticket.routeId);
        if (stream === undefined || stream.closed || host === undefined || !host.online || host.syncing || host.id !== ticket.hostConnectionId || host.id !== stream.hostConnectionId) {
          if (stream !== undefined) this.closeStream(stream, 1013, "ticket no longer routable");
          this.sendErrorAndClose(ws, "ticket_invalid", "stream ticket invalid");
          return;
        }
        if (!isOpen(ws)) { this.closeStream(stream, 1013, "host stream disconnected"); return; }
        stream.host = ws; stream.ready = true; clearTimeout(stream.timeout); this.metrics.connections.inc({ endpoint: "stream", phase: "authenticated" });
        install((message, binary) => this.fromHost(stream, message, binary));
        ws.once("error", (error) => this.closeStream(stream, closeCodeForSocketError(error), "host stream socket error"));
        ws.once("close", (code) => {
          this.metrics.connections.dec({ endpoint: "stream", phase: "authenticated" });
          this.closeStream(stream, code === 1009 ? 1009 : 1000, "host stream disconnected");
        });
        // Both sockets transition only after ready is emitted; after this no frame is parsed by the relay.
        this.sendControl(ws, { type: "stream.ready", v: RELAY_PROTOCOL_VERSION, streamId: stream.id }, () => this.closeStream(stream, 1013, "host stream ready write failed"));
        this.sendControl(stream.client, { type: "stream.ready", v: RELAY_PROTOCOL_VERSION, streamId: stream.id }, () => this.closeStream(stream, 1013, "client stream ready write failed"));
      } catch (error) {
        if (expected !== undefined) this.failRoute(expected.routeId, "stream accept dependency failure");
        this.logger.warn({ event: "relay.stream_accept_failed", stream: opaqueLogId(control.streamId), error: errorKind(error) }, "stream accept failed closed");
        this.sendErrorAndClose(ws, "internal", "relay unavailable");
      }
    });
  }

  private fromClient(stream: StreamConnection, data: Data, binary: boolean): void {
    if (!stream.ready) { this.closeStream(stream, 1008, "stream not ready"); return; }
    this.forward(stream, stream.host, data, binary, "client_to_host");
  }

  private fromHost(stream: StreamConnection, data: Data, binary: boolean): void {
    if (!stream.ready) { this.closeStream(stream, 1008, "stream not ready"); return; }
    this.forward(stream, stream.client, data, binary, "host_to_client");
  }

  private forward(stream: StreamConnection, target: WebSocket | undefined, data: Data, binary: boolean, direction: "client_to_host" | "host_to_client"): void {
    if (stream.closed) return;
    if (!isOpen(target)) { this.closeStream(stream, 1013, "peer unavailable"); return; }
    const size = bytesOf(data);
    if (size > MAX_RELAY_DATA_FRAME_BYTES) { this.closeStream(stream, 1009, "frame too large"); return; }
    if (target.bufferedAmount + size > BACKPRESSURE_LIMIT_BYTES) { this.closeStream(stream, 1013, "backpressure limit"); return; }
    // No decode, JSON parse, decryption, recompression, or framing conversion occurs here.
    try { target.send(data, { binary, compress: false }, (error) => { if (error != null) this.closeStream(stream, 1013, "write failed"); }); }
    catch { this.closeStream(stream, 1013, "write failed"); return; }
    this.metrics.forwardedFrames.inc({ direction, kind: binary ? "binary" : "text" });
  }

  private closeStream(stream: StreamConnection, code: number, reason: string, closeClient = true): void {
    if (stream.closed) return;
    stream.closed = true; clearTimeout(stream.timeout); clearInterval(stream.leaseWatch); this.streams.delete(stream.id); this.metrics.streams.dec();
    void this.ephemeral.releaseStreamLease(stream.routeId, stream.leaseId).catch((error: unknown) => {
      this.logger.warn({ event: "relay.lease_release_failed", route: opaqueLogId(stream.routeId), error: errorKind(error) }, "lease release failed closed");
      this.failRoute(stream.routeId, "stream lease release failed");
    });
    if (!stream.ready) {
      // Let the ticket's exact Redis expiry produce ticket_expired after an offer
      // times out. Explicit cancellation/destruction remains ticket_invalid.
      if (reason !== "host stream timeout") void this.ephemeral.invalidateTicket(stream.ticket).catch((error: unknown) => {
        this.logger.warn({ event: "relay.ticket_invalidate_failed", route: opaqueLogId(stream.routeId), error: errorKind(error) }, "ticket invalidation failed closed");
        this.failRoute(stream.routeId, "ticket invalidation failed");
      });
      const close = { type: "stream.close", v: RELAY_PROTOCOL_VERSION, streamId: stream.id, code: code === 1013 ? "expired" : "peer_closed" };
      if (closeClient && isOpen(stream.client)) this.sendControl(stream.client, close, () => this.closeSocket(stream.client, code, reason));
      if (isOpen(stream.host)) this.sendControl(stream.host, close, () => this.closeSocket(stream.host, code, reason));
      const host = this.hosts.get(stream.routeId);
      if (host !== undefined && isOpen(host.ws)) this.sendControl(host.ws, { type: "stream.revoke", v: RELAY_PROTOCOL_VERSION, streamId: stream.id, code: code === 1013 ? "expired" : "normal" }, () => this.failHost(host, "stream revoke write failed"));
    }
    if (closeClient) this.closeSocket(stream.client, code, reason);
    this.closeSocket(stream.host, code, reason);
  }

  private sendErrorAndClose(ws: WebSocket, code: RelayErrorCode, message: string, retryAfterMs?: number): void {
    if (isOpen(ws)) {
      // ws serializes the close frame after already queued data, so send the stable
      // control error first and initiate close immediately rather than relying on a
      // write callback (which is not guaranteed after a peer begins closing).
      this.sendControl(ws, { type: "error", v: RELAY_PROTOCOL_VERSION, code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
      this.closeSocket(ws, 1008, message);
    } else this.closeSocket(ws, 1008, message);
  }
  private sendControl(ws: WebSocket | undefined, message: unknown, onError?: () => void): boolean {
    if (!isOpen(ws)) { onError?.(); return false; }
    try { ws.send(JSON.stringify(message), { compress: false }, (error) => { if (error != null) onError?.(); }); return true; }
    catch { onError?.(); return false; }
  }
  private closeSocket(ws: WebSocket | undefined, code: number, reason: string): void { if (isOpen(ws)) { try { ws.close(code, reason.slice(0, 123)); } catch { try { ws.terminate(); } catch { /* already gone */ } } } }

  private applyEvent(event: RelayEvent): void {
    if (event.type === "route.disabled") { const host = this.hosts.get(event.routeId); if (host !== undefined) this.failHost(host, "route disabled", 1008); for (const stream of this.streams.values()) if (stream.routeId === event.routeId) this.closeStream(stream, 1008, "route disabled"); return; }
    if (event.type === "device.revoked" && event.deviceId !== undefined) for (const stream of this.streams.values()) if (stream.routeId === event.routeId && stream.clientDeviceId === event.deviceId) this.closeStream(stream, 1008, "device revoked");
  }
  private async runCleanup(): Promise<void> {
    try {
      const count = await this.routes.cleanupInactiveRoutes(new Date(Date.now() - OFFLINE_CLEANUP_MS));
      if (count > 0) this.logger.info({ event: "relay.routes_cleaned", count }, "removed inactive routes");
    } catch (error) {
      this.logger.warn({ event: "relay.cleanup_failed", error: errorKind(error) }, "route cleanup failed");
      for (const host of this.hosts.values()) this.failHost(host, "route cleanup dependency failure");
    }
  }
}
