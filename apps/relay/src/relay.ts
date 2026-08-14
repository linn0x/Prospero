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
import type { EphemeralStore, RouteStore, SnapshotCredential } from "./store.js";
import type { AuthenticatedDevice, RelayEvent, StreamTicket } from "./types.js";

const BACKPRESSURE_LIMIT_BYTES = 32 * 1024 * 1024;
const OFFLINE_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000;
type Endpoint = "host" | "client" | "stream";
type Data = Buffer | ArrayBuffer | Buffer[];

interface HostConnection {
  id: string;
  routeId: string;
  ws: WebSocket;
  generation: number | null;
  online: boolean;
  readySent: boolean;
  lastHeartbeat: number;
  heartbeatWatch?: NodeJS.Timeout;
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
  closed: boolean;
}

interface RelayDependencies { routes: RouteStore; ephemeral: EphemeralStore; config: RelayConfig; logger: Logger; metrics?: RelayMetrics; }

function bytesOf(data: Data): number { return Buffer.isBuffer(data) ? data.length : data instanceof ArrayBuffer ? data.byteLength : data.reduce((sum, part) => sum + part.length, 0); }
function safeJson(data: Data): unknown { return JSON.parse((Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.concat(data)).toString("utf8")) as unknown; }
function sourceIp(request: IncomingMessage): string { const forwarded = request.headers["x-forwarded-for"]; const first = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined; return first && first.length <= 64 ? first : request.socket.remoteAddress ?? "unknown"; }
function isInternal(address: string | undefined): boolean { if (address === undefined) return false; const ip = address.replace(/^::ffff:/, ""); return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip); }
function isOpen(ws: WebSocket | undefined): ws is WebSocket { return ws !== undefined && ws.readyState === WebSocket.OPEN; }
function errorKind(error: unknown): string { return error instanceof Error ? error.name : "unknown"; }

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
  private stopping = false;
  private unsubscribe: (() => Promise<void>) | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(deps: RelayDependencies) {
    this.routes = deps.routes; this.ephemeral = deps.ephemeral; this.config = deps.config; this.logger = deps.logger; this.metrics = deps.metrics ?? new RelayMetrics();
    this.http = createServer((request, response) => this.handleHttp(request, response));
    this.http.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    this.hostWss.on("connection", (ws, request) => this.handleHost(ws, request));
    this.clientWss.on("connection", (ws, request) => this.handleClient(ws, request));
    this.streamWss.on("connection", (ws, request) => this.handleStream(ws, request));
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
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    await this.unsubscribe?.(); this.unsubscribe = undefined;
  }

  address(): AddressInfo | undefined { const address = this.http.address(); return address !== null && typeof address !== "string" ? address : undefined; }
  private async requireDependencies(): Promise<void> { await Promise.all([this.routes.ping(), this.ephemeral.ping()]); }
  private async ready(): Promise<boolean> { try { await this.requireDependencies(); return true; } catch (error) { this.logger.warn({ event: "relay.dependency_unavailable", error: errorKind(error) }, "relay dependency unavailable"); return false; } }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (path === "/health/live") { response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end('{"status":"live"}'); return; }
    if (path === "/health/ready") { void this.ready().then((ready) => response.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" }).end(ready ? '{"status":"ready"}' : '{"status":"unavailable"}')); return; }
    if (path === "/metrics") {
      const auth = request.headers.authorization;
      const value = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const tokenOk = this.config.metricsToken !== undefined && value.length === this.config.metricsToken.length && timingSafeEqual(Buffer.from(value), Buffer.from(this.config.metricsToken));
      if (!tokenOk && (this.config.metricsToken !== undefined || this.config.metricsInternalOnly === false || !isInternal(request.socket.remoteAddress))) { response.writeHead(403).end(); return; }
      void this.metrics.registry.metrics().then((body) => response.writeHead(200, { "content-type": this.metrics.registry.contentType, "cache-control": "no-store" }).end(body)); return;
    }
    response.writeHead(404).end();
  }

  private handleUpgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    if (this.stopping) { socket.destroy(); return; }
    const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    const server = path === RELAY_HOST_PATH ? this.hostWss : path === RELAY_CLIENT_PATH ? this.clientWss : path === RELAY_STREAM_PATH ? this.streamWss : undefined;
    if (server === undefined) { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    void this.allowConnection(sourceIp(request)).then((allowed) => {
      if (!allowed) { socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      server.handleUpgrade(request, socket, head, (ws) => server.emit("connection", ws, request));
    }).catch(() => { socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); socket.destroy(); });
  }

  private async allowConnection(ip: string): Promise<boolean> { const verdict = await this.ephemeral.consumeRateLimit(`connection:${ip}`, this.config.connectionRatePerMinute, 60); if (!verdict.allowed) this.metrics.rateLimited.inc({ scope: "connection" }); return verdict.allowed; }
  private async allowAuth(endpoint: Endpoint, ip: string): Promise<boolean> { const verdict = await this.ephemeral.consumeRateLimit(`auth:${endpoint}:${ip}`, this.config.authRatePerMinute, 60); if (!verdict.allowed) this.metrics.rateLimited.inc({ scope: "auth" }); return verdict.allowed; }

  private setupFirstFrame(ws: WebSocket, request: IncomingMessage, endpoint: Endpoint, onAuth: (data: Data, install: (handler: (message: Data, binary: boolean) => void) => void) => Promise<void>): void {
    this.metrics.connections.inc({ endpoint, phase: "unauthenticated" });
    let received = false;
    const timeout = setTimeout(() => this.closeSocket(ws, 1008, "authentication timeout"), this.config.authTimeoutMs).unref();
    let subsequent: ((message: Data, binary: boolean) => void) | undefined;
    const queued: Array<{ message: Data; binary: boolean }> = [];
    ws.on("message", (data, binary) => {
      if (received) {
        if (subsequent === undefined) queued.push({ message: data, binary });
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
      if (!(await this.ready())) { this.sendErrorAndClose(ws, "internal", "relay unavailable"); return; }
      if (!routeIdMatchesHostSecret(auth.routeId, auth.hostSecret)) { this.metrics.authFailures.inc({ endpoint: "host", reason: "unauthorized" }); this.sendErrorAndClose(ws, "unauthorized", "authentication failed"); return; }
      const route = await this.routes.ensureRoute(auth.routeId);
      if (route === null) { this.sendErrorAndClose(ws, "route_unavailable", "route disabled"); return; }
      const host: HostConnection = { id: randomUUID(), routeId: auth.routeId, ws, generation: null, online: false, readySent: false, lastHeartbeat: Date.now() };
      const prior = this.hosts.get(host.routeId);
      this.hosts.set(host.routeId, host);
      if (prior !== undefined && prior.id !== host.id) {
        for (const stream of this.streams.values()) if (stream.hostConnectionId === prior.id) this.closeStream(stream, 1013, "host superseded");
        this.closeSocket(prior.ws, 4009, "superseded by newer host");
      }
      this.metrics.connections.inc({ endpoint: "host", phase: "authenticated" });
      install((message, binary) => { void this.handleHostControl(host, message, binary); });
      ws.once("close", () => this.hostClosed(host));
      this.logger.info({ event: "relay.host_authenticated", route: opaqueLogId(host.routeId) }, "host authenticated; awaiting device snapshot");
    });
  }

  private async handleHostControl(host: HostConnection, data: Data, binary: boolean): Promise<void> {
    if (binary || bytesOf(data) > MAX_RELAY_CONTROL_FRAME_BYTES) { this.closeSocket(host.ws, 1008, "invalid control frame"); return; }
    let control;
    try { control = parseRelayHostControlMessage(safeJson(data)); } catch { this.closeSocket(host.ws, 1008, "invalid control frame"); return; }
    if (control.type === "host.device-sync") {
      const credentials: SnapshotCredential[] = control.credentials.map((item) => item.revoked === true ? { deviceId: item.deviceId, revoked: true } : { deviceId: item.deviceId, credentialDigest: item.credentialDigest });
      const snapshot = await this.routes.applyDeviceSnapshot(host.routeId, control.generation, credentials);
      if (snapshot === null) { this.sendErrorAndClose(host.ws, "route_unavailable", "route disabled"); return; }
      await Promise.all(snapshot.devices.map((device) => this.ephemeral.cacheCredential(device, snapshot.route.disabledAt, this.config.credentialCacheTtlSeconds)));
      for (const device of snapshot.devices) {
        if (device.revokedAt !== null) await this.ephemeral.publish({ type: "device.revoked", routeId: host.routeId, deviceId: device.deviceId });
      }
      host.generation = control.generation;
      host.lastHeartbeat = Date.now();
      host.ws.send(JSON.stringify({ type: "host.device-sync.ack", v: RELAY_PROTOCOL_VERSION, generation: control.generation }), { compress: false });
      if (!host.readySent) {
        host.online = true; host.readySent = true;
        await this.ephemeral.setPresence(host.routeId, host.id, this.config.presenceTtlSeconds);
        host.heartbeatWatch = setInterval(() => { if (Date.now() - host.lastHeartbeat > this.config.presenceTtlSeconds * 1000) this.closeSocket(host.ws, 1013, "host heartbeat timeout"); }, Math.max(1_000, Math.floor(this.config.presenceTtlSeconds * 500))).unref();
        host.ws.send(JSON.stringify({ type: "host.ready", v: RELAY_PROTOCOL_VERSION, routeId: host.routeId, generation: control.generation }), { compress: false });
        this.logger.info({ event: "relay.host_online", route: opaqueLogId(host.routeId) }, "host snapshot synchronized");
      }
      return;
    }
    if (control.type === "host.heartbeat") {
      if (!host.online || host.generation !== control.generation) { this.sendErrorAndClose(host.ws, "stream_not_ready", "host snapshot is not current"); return; }
      host.lastHeartbeat = Date.now();
      await this.ephemeral.setPresence(host.routeId, host.id, this.config.presenceTtlSeconds);
      host.ws.send(JSON.stringify({ type: "host.heartbeat.ack", v: RELAY_PROTOCOL_VERSION, generation: control.generation }), { compress: false });
      return;
    }
    if ((control.type === "stream.revoke" || control.type === "stream.close") && this.streams.has(control.streamId)) { const stream = this.streams.get(control.streamId)!; if (stream.hostConnectionId === host.id) this.closeStream(stream, 1000, control.code); return; }
    this.closeSocket(host.ws, 1008, "unexpected control frame");
  }

  private hostClosed(host: HostConnection): void {
    this.metrics.connections.dec({ endpoint: "host", phase: "authenticated" });
    if (host.heartbeatWatch !== undefined) clearInterval(host.heartbeatWatch);
    if (this.hosts.get(host.routeId)?.id !== host.id) return;
    this.hosts.delete(host.routeId);
    void this.ephemeral.clearPresence(host.routeId, host.id).catch(() => undefined);
    for (const stream of this.streams.values()) if (stream.hostConnectionId === host.id) this.closeStream(stream, 1013, "host disconnected");
  }

  private handleClient(ws: WebSocket, request: IncomingMessage): void {
    this.setupFirstFrame(ws, request, "client", async (data, install) => {
      let control;
      try { control = parseRelayClientControlMessage(safeJson(data)); } catch { this.sendErrorAndClose(ws, "bad_frame", "expected client.open"); return; }
      if (control.type !== "client.open") { this.sendErrorAndClose(ws, "bad_frame", "expected client.open"); return; }
      if (!(await this.allowAuth("client", sourceIp(request)))) { this.sendErrorAndClose(ws, "rate_limited", "too many attempts", 60_000); return; }
      if (!(await this.ready())) { this.sendErrorAndClose(ws, "internal", "relay unavailable"); return; }
      const authenticated = await this.authenticateClient(control.routeId, control.deviceId, control.token);
      if (authenticated === null) { this.metrics.authFailures.inc({ endpoint: "client", reason: "unauthorized" }); this.sendErrorAndClose(ws, "unauthorized", "authentication failed"); return; }
      const host = this.hosts.get(control.routeId);
      if (host === undefined || !host.online || !isOpen(host.ws)) { this.sendErrorAndClose(ws, "route_unavailable", "route is offline"); return; }
      const active = [...this.streams.values()].filter((stream) => stream.routeId === control.routeId && !stream.closed).length;
      if (active >= this.config.maxStreamsPerRoute) { this.sendErrorAndClose(ws, "rate_limited", "stream limit reached", 1_000); return; }
      const streamId = randomOpaque(24); const ticketValue = randomOpaque(32); const expiresAt = Date.now() + this.config.ticketTimeoutMs;
      const ticket: StreamTicket = { streamId, ticket: ticketValue, routeId: control.routeId, hostConnectionId: host.id, clientDeviceId: authenticated.device.deviceId, expiresAt };
      const timeout = setTimeout(() => { const stream = this.streams.get(streamId); if (stream !== undefined && !stream.ready) this.closeStream(stream, 1013, "host stream timeout"); }, this.config.ticketTimeoutMs).unref();
      const stream: StreamConnection = { id: streamId, routeId: control.routeId, clientDeviceId: authenticated.device.deviceId, hostConnectionId: host.id, client: ws, ready: false, timeout, closed: false };
      await this.ephemeral.createTicket(ticket, Math.ceil(this.config.ticketTimeoutMs / 1000));
      this.streams.set(streamId, stream); this.metrics.streams.inc(); this.metrics.connections.inc({ endpoint: "client", phase: "authenticated" });
      install((message, binary) => this.fromClient(stream, message, binary));
      ws.once("close", () => { this.metrics.connections.dec({ endpoint: "client", phase: "authenticated" }); this.closeStream(stream, 1000, "client disconnected", false); });
      ws.send(JSON.stringify({ type: "client.status", v: RELAY_PROTOCOL_VERSION, status: "pending", streamId, expiresAt }), { compress: false });
      host.ws.send(JSON.stringify({ type: "stream.offer", v: RELAY_PROTOCOL_VERSION, streamId, ticket: ticketValue, deviceId: authenticated.device.deviceId, expiresAt }), { compress: false });
    });
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
      if (!(await this.allowAuth("stream", sourceIp(request)))) { this.sendErrorAndClose(ws, "rate_limited", "too many attempts", 60_000); return; }
      if (!(await this.ready())) { this.sendErrorAndClose(ws, "internal", "relay unavailable"); return; }
      const ticket = await this.ephemeral.consumeTicket(control.ticket);
      if (ticket === null) { this.metrics.authFailures.inc({ endpoint: "stream", reason: "ticket_used" }); this.sendErrorAndClose(ws, "ticket_used", "stream ticket is invalid or used"); return; }
      if (ticket.expiresAt < Date.now()) { this.sendErrorAndClose(ws, "ticket_expired", "stream ticket expired"); return; }
      const stream = this.streams.get(ticket.streamId); const host = this.hosts.get(ticket.routeId);
      if (ticket.streamId !== control.streamId || stream === undefined || stream.closed || host === undefined || host.id !== ticket.hostConnectionId || host.id !== stream.hostConnectionId) { this.sendErrorAndClose(ws, "ticket_invalid", "stream ticket invalid"); return; }
      stream.host = ws; stream.ready = true; clearTimeout(stream.timeout); this.metrics.connections.inc({ endpoint: "stream", phase: "authenticated" });
      install((message, binary) => this.fromHost(stream, message, binary));
      ws.once("close", () => { this.metrics.connections.dec({ endpoint: "stream", phase: "authenticated" }); this.closeStream(stream, 1000, "host stream disconnected", false); });
      // Both sockets transition only after ready is emitted; after this no frame is parsed by the relay.
      ws.send(JSON.stringify({ type: "stream.ready", v: RELAY_PROTOCOL_VERSION, streamId: stream.id }), { compress: false });
      stream.client.send(JSON.stringify({ type: "stream.ready", v: RELAY_PROTOCOL_VERSION, streamId: stream.id }), { compress: false });
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
    if (stream.closed || !isOpen(target)) return;
    const size = bytesOf(data);
    if (size > MAX_RELAY_DATA_FRAME_BYTES) { this.closeStream(stream, 1009, "frame too large"); return; }
    if (target.bufferedAmount + size > BACKPRESSURE_LIMIT_BYTES) { this.closeStream(stream, 1013, "backpressure limit"); return; }
    // No decode, JSON parse, decryption, recompression, or framing conversion occurs here.
    target.send(data, { binary, compress: false }, (error) => { if (error != null) this.closeStream(stream, 1013, "write failed"); });
    this.metrics.forwardedFrames.inc({ direction, kind: binary ? "binary" : "text" });
  }

  private closeStream(stream: StreamConnection, code: number, reason: string, closeClient = true): void {
    if (stream.closed) return;
    stream.closed = true; clearTimeout(stream.timeout); this.streams.delete(stream.id); this.metrics.streams.dec();
    if (!stream.ready) {
      const close = JSON.stringify({ type: "stream.close", v: RELAY_PROTOCOL_VERSION, streamId: stream.id, code: code === 1013 ? "expired" : "peer_closed" });
      if (closeClient && isOpen(stream.client)) stream.client.send(close, { compress: false }, () => this.closeSocket(stream.client, code, reason));
      if (isOpen(stream.host)) stream.host.send(close, { compress: false }, () => this.closeSocket(stream.host, code, reason));
      const host = this.hosts.get(stream.routeId);
      if (host !== undefined && isOpen(host.ws)) host.ws.send(JSON.stringify({ type: "stream.revoke", v: RELAY_PROTOCOL_VERSION, streamId: stream.id, code: code === 1013 ? "expired" : "normal" }), { compress: false });
    }
    if (closeClient) this.closeSocket(stream.client, code, reason);
    this.closeSocket(stream.host, code, reason);
  }

  private sendErrorAndClose(ws: WebSocket, code: RelayErrorCode, message: string, retryAfterMs?: number): void {
    if (isOpen(ws)) {
      // ws serializes the close frame after already queued data, so send the stable
      // control error first and initiate close immediately rather than relying on a
      // write callback (which is not guaranteed after a peer begins closing).
      ws.send(JSON.stringify({ type: "error", v: RELAY_PROTOCOL_VERSION, code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }), { compress: false });
      this.closeSocket(ws, 1008, message);
    } else this.closeSocket(ws, 1008, message);
  }
  private closeSocket(ws: WebSocket | undefined, code: number, reason: string): void { if (isOpen(ws)) ws.close(code, reason.slice(0, 123)); }

  private applyEvent(event: RelayEvent): void {
    if (event.type === "route.disabled") { const host = this.hosts.get(event.routeId); if (host !== undefined) this.closeSocket(host.ws, 1008, "route disabled"); for (const stream of this.streams.values()) if (stream.routeId === event.routeId) this.closeStream(stream, 1008, "route disabled"); return; }
    if (event.type === "device.revoked" && event.deviceId !== undefined) for (const stream of this.streams.values()) if (stream.routeId === event.routeId && stream.clientDeviceId === event.deviceId) this.closeStream(stream, 1008, "device revoked");
  }
  private async runCleanup(): Promise<void> { try { const count = await this.routes.cleanupInactiveRoutes(new Date(Date.now() - OFFLINE_CLEANUP_MS)); if (count > 0) this.logger.info({ event: "relay.routes_cleaned", count }, "removed inactive routes"); } catch (error) { this.logger.warn({ event: "relay.cleanup_failed", error: errorKind(error) }, "route cleanup failed"); } }
}
