import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  RELAY_PROTOCOL_VERSION,
  parseRelayClientControlMessage,
  parseRelayHostControlMessage,
  parseRelayStreamControlMessage,
  type RelayErrorCode,
} from "@prospero/protocol";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { equalDigest, opaqueLogId, randomOpaque } from "./crypto.js";
import type { RelayConfig } from "./config.js";
import { RelayMetrics } from "./metrics.js";
import type { EphemeralStore, RouteStore } from "./store.js";
import type { AuthenticatedDevice, DeviceRecord, RelayEvent, StreamTicket } from "./types.js";

const CONTROL_MAX_BYTES = 1024 * 1024;
const DATA_MAX_BYTES = 16 * 1024 * 1024;
const BACKPRESSURE_LIMIT_BYTES = 32 * 1024 * 1024;
const OFFLINE_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000;

type Endpoint = "host" | "client" | "stream";
type Data = Buffer | ArrayBuffer | Buffer[];

interface HostConnection {
  id: string;
  routeId: string;
  ws: WebSocket;
  deviceId: string;
  heartbeat?: NodeJS.Timeout;
}

interface StreamConnection {
  id: string;
  routeId: string;
  clientDeviceId: string;
  hostConnectionId: string;
  client: WebSocket;
  host?: WebSocket;
  pendingClientFrames: Array<{ data: Data; binary: boolean; bytes: number }>;
  pendingBytes: number;
  timeout: NodeJS.Timeout;
  closed: boolean;
}

interface RelayDependencies {
  routes: RouteStore;
  ephemeral: EphemeralStore;
  config: RelayConfig;
  logger: Logger;
  metrics?: RelayMetrics;
}

function bytesOf(data: Data): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.reduce((sum, part) => sum + part.length, 0);
}

function safeJson(data: Data): unknown {
  const text = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : Buffer.concat(data).toString("utf8");
  return JSON.parse(text) as unknown;
}

function sourceIp(request: IncomingMessage): string {
  // Caddy overwrites X-Forwarded-For; direct relay callers fall back to their socket.
  const forwarded = request.headers["x-forwarded-for"];
  const first = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined;
  return first && first.length <= 64 ? first : request.socket.remoteAddress ?? "unknown";
}

function isInternal(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.replace(/^::ffff:/, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized)
  );
}

function isOpen(ws: WebSocket | undefined): ws is WebSocket {
  return ws !== undefined && ws.readyState === WebSocket.OPEN;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export class RelayServer {
  private readonly routes: RouteStore;
  private readonly ephemeral: EphemeralStore;
  private readonly config: RelayConfig;
  private readonly logger: Logger;
  readonly metrics: RelayMetrics;
  private readonly http: Server;
  private readonly hostWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: DATA_MAX_BYTES });
  private readonly clientWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: DATA_MAX_BYTES });
  private readonly streamWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: DATA_MAX_BYTES });
  private readonly hosts = new Map<string, HostConnection>();
  private readonly streams = new Map<string, StreamConnection>();
  private stopping = false;
  private unsubscribe: (() => Promise<void>) | undefined;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(deps: RelayDependencies) {
    this.routes = deps.routes;
    this.ephemeral = deps.ephemeral;
    this.config = deps.config;
    this.logger = deps.logger;
    this.metrics = deps.metrics ?? new RelayMetrics();
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
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.config.port, this.config.host, () => {
        this.http.off("error", reject);
        resolve();
      });
    });
    const address = this.http.address();
    if (address === null || typeof address === "string") throw new Error("relay did not bind a TCP port");
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
    await this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  address(): AddressInfo | undefined {
    const address = this.http.address();
    return address !== null && typeof address !== "string" ? address : undefined;
  }

  private async requireDependencies(): Promise<void> {
    await Promise.all([this.routes.ping(), this.ephemeral.ping()]);
  }

  private async ready(): Promise<boolean> {
    try {
      await this.requireDependencies();
      return true;
    } catch (error) {
      this.logger.warn({ event: "relay.dependency_unavailable", error: errorKind(error) }, "relay dependency unavailable");
      return false;
    }
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (path === "/health/live") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end('{"status":"live"}');
      return;
    }
    if (path === "/health/ready") {
      void this.ready().then((ready) => {
        response.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(ready ? '{"status":"ready"}' : '{"status":"unavailable"}');
      });
      return;
    }
    if (path === "/metrics") {
      const auth = request.headers.authorization;
      const provided = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const tokenOk = this.config.metricsToken !== undefined && provided.length === this.config.metricsToken.length && timingSafeEqual(Buffer.from(provided), Buffer.from(this.config.metricsToken));
      if (!tokenOk && (this.config.metricsToken !== undefined || this.config.metricsInternalOnly === false || !isInternal(request.socket.remoteAddress))) {
        response.writeHead(403).end();
        return;
      }
      void this.metrics.registry.metrics().then((body) => {
        response.writeHead(200, { "content-type": this.metrics.registry.contentType, "cache-control": "no-store" }).end(body);
      });
      return;
    }
    response.writeHead(404).end();
  }

  private handleUpgrade(request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    const path = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    const server = path === "/v1/host" ? this.hostWss : path === "/v1/client" ? this.clientWss : path === "/v1/stream" ? this.streamWss : undefined;
    if (server === undefined) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    void this.allowConnection(sourceIp(request)).then((allowed) => {
      if (!allowed) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      server.handleUpgrade(request, socket, head, (ws) => server.emit("connection", ws, request));
    }).catch(() => {
      // Redis failure is explicitly fail-closed before a new socket can authenticate.
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
  }

  private async allowConnection(ip: string): Promise<boolean> {
    const verdict = await this.ephemeral.consumeRateLimit(`connection:${ip}`, this.config.connectionRatePerMinute, 60);
    if (!verdict.allowed) this.metrics.rateLimited.inc({ scope: "connection" });
    return verdict.allowed;
  }

  private setupFirstFrame(
    ws: WebSocket,
    request: IncomingMessage,
    endpoint: Endpoint,
    onAuth: (data: Data, isBinary: boolean) => Promise<void>,
  ): void {
    this.metrics.connections.inc({ endpoint, phase: "unauthenticated" });
    let received = false;
    const timeout = setTimeout(() => this.closeSocket(ws, 1008, "authentication timeout"), this.config.authTimeoutMs).unref();
    ws.once("message", (data, isBinary) => {
      received = true;
      clearTimeout(timeout);
      this.metrics.connections.dec({ endpoint, phase: "unauthenticated" });
      if (isBinary || bytesOf(data) > CONTROL_MAX_BYTES) {
        this.metrics.authFailures.inc({ endpoint, reason: "bad_frame" });
        this.sendErrorAndClose(ws, "bad_frame", "invalid control frame");
        return;
      }
      void onAuth(data, isBinary).catch((error) => {
        this.logger.warn({ event: "relay.auth_error", endpoint, ip: sourceIp(request), error: errorKind(error) }, "authentication failed");
        this.metrics.authFailures.inc({ endpoint, reason: "internal" });
        this.sendErrorAndClose(ws, "internal", "relay unavailable");
      });
    });
    ws.once("close", () => {
      clearTimeout(timeout);
      // If this was still unauthenticated, the decrement above has not happened.
      if (!received) this.metrics.connections.dec({ endpoint, phase: "unauthenticated" });
    });
  }

  private handleHost(ws: WebSocket, request: IncomingMessage): void {
    this.setupFirstFrame(ws, request, "host", async (data) => {
      const control = this.parseHostControl(data);
      if (control === null || control.type !== "host.register") {
        this.sendErrorAndClose(ws, "bad_frame", "expected host registration");
        return;
      }
      if (!(await this.allowAuth("host", sourceIp(request)))) {
        this.sendErrorAndClose(ws, "rate_limited", "too many attempts", 60_000);
        return;
      }
      if (!(await this.ready())) {
        this.sendErrorAndClose(ws, "internal", "relay unavailable");
        return;
      }
      const snapshot = await this.routes.registerHost(control.routeId, control.deviceId, control.token);
      if (snapshot === null) {
        this.metrics.authFailures.inc({ endpoint: "host", reason: "unauthorized" });
        this.sendErrorAndClose(ws, "unauthorized", "authentication failed");
        return;
      }
      // Redis credential cache is completely warmed before the route becomes present.
      await Promise.all(snapshot.devices.map((device) => this.ephemeral.cacheCredential(device, snapshot.route.disabledAt, this.config.credentialCacheTtlSeconds)));
      const host: HostConnection = { id: randomUUID(), routeId: control.routeId, ws, deviceId: control.deviceId };
      const prior = this.hosts.get(control.routeId);
      this.hosts.set(control.routeId, host);
      await this.ephemeral.setPresence(control.routeId, host.id, this.config.presenceTtlSeconds);
      host.heartbeat = setInterval(() => {
        void this.ephemeral.setPresence(host.routeId, host.id, this.config.presenceTtlSeconds).catch(() => this.closeSocket(host.ws, 1013, "relay unavailable"));
      }, Math.floor(this.config.presenceTtlSeconds * 500)).unref();
      if (prior !== undefined && prior.id !== host.id) {
        this.logger.info({ event: "relay.host_superseded", route: opaqueLogId(host.routeId) }, "newest host connection wins");
        for (const stream of this.streams.values()) {
          if (stream.hostConnectionId === prior.id) this.closeStream(stream, 1013, "host superseded");
        }
        this.closeSocket(prior.ws, 4009, "superseded by newer host");
      }
      this.metrics.connections.inc({ endpoint: "host", phase: "authenticated" });
      ws.send(JSON.stringify({ type: "host.ready", v: RELAY_PROTOCOL_VERSION, routeId: control.routeId }), { compress: false });
      ws.on("message", (message, binary) => this.handleHostControl(host, message, binary));
      ws.once("close", () => {
        this.metrics.connections.dec({ endpoint: "host", phase: "authenticated" });
        if (host.heartbeat !== undefined) clearInterval(host.heartbeat);
        if (this.hosts.get(host.routeId)?.id === host.id) {
          this.hosts.delete(host.routeId);
          void this.ephemeral.clearPresence(host.routeId, host.id).catch(() => undefined);
          for (const stream of this.streams.values()) {
            if (stream.hostConnectionId === host.id) this.closeStream(stream, 1013, "host disconnected");
          }
        }
      });
      this.logger.info({ event: "relay.host_online", route: opaqueLogId(host.routeId) }, "host registered");
    });
  }

  private handleHostControl(host: HostConnection, data: Data, isBinary: boolean): void {
    // A host control socket never carries app traffic. Only T1 stream.close is accepted here.
    if (isBinary || bytesOf(data) > CONTROL_MAX_BYTES) {
      this.closeSocket(host.ws, 1008, "invalid control frame");
      return;
    }
    try {
      const control = parseRelayStreamControlMessage(safeJson(data));
      if (control.type === "stream.close") {
        const stream = this.streams.get(control.streamId);
        if (stream !== undefined && stream.hostConnectionId === host.id) this.closeStream(stream, 1000, control.code);
        return;
      }
      // stream.open is outbound relay -> host; accepting it here would blur control/data roles.
      this.closeSocket(host.ws, 1008, "unexpected control frame");
    } catch {
      this.closeSocket(host.ws, 1008, "invalid control frame");
    }
  }

  private handleClient(ws: WebSocket, request: IncomingMessage): void {
    this.setupFirstFrame(ws, request, "client", async (data) => {
      const control = this.parseClientControl(data);
      if (control === null || control.type !== "client.connect") {
        this.sendErrorAndClose(ws, "bad_frame", "expected client connection");
        return;
      }
      if (!(await this.allowAuth("client", sourceIp(request)))) {
        this.sendErrorAndClose(ws, "rate_limited", "too many attempts", 60_000);
        return;
      }
      if (!(await this.ready())) {
        this.sendErrorAndClose(ws, "internal", "relay unavailable");
        return;
      }
      const authenticated = await this.authenticateClient(control.routeId, control.deviceId, control.token);
      if (authenticated === null) {
        this.metrics.authFailures.inc({ endpoint: "client", reason: "unauthorized" });
        this.sendErrorAndClose(ws, "unauthorized", "authentication failed");
        return;
      }
      const host = this.hosts.get(control.routeId);
      if (host === undefined || !isOpen(host.ws)) {
        this.sendErrorAndClose(ws, "route_unavailable", "route is offline");
        return;
      }
      const active = [...this.streams.values()].filter((stream) => stream.routeId === control.routeId && !stream.closed).length;
      if (active >= this.config.maxStreamsPerRoute) {
        this.sendErrorAndClose(ws, "rate_limited", "stream limit reached", 1_000);
        return;
      }
      const streamId = randomOpaque(24);
      const ticket: StreamTicket = {
        streamId,
        routeId: control.routeId,
        hostConnectionId: host.id,
        clientDeviceId: authenticated.device.deviceId,
      };
      const timeout = setTimeout(() => {
        const stream = this.streams.get(streamId);
        if (stream !== undefined && stream.host === undefined) this.closeStream(stream, 1013, "host stream timeout");
      }, this.config.ticketTimeoutMs).unref();
      const stream: StreamConnection = {
        id: streamId,
        routeId: control.routeId,
        clientDeviceId: authenticated.device.deviceId,
        hostConnectionId: host.id,
        client: ws,
        pendingClientFrames: [],
        pendingBytes: 0,
        timeout,
        closed: false,
      };
      await this.ephemeral.createTicket(ticket, Math.ceil(this.config.ticketTimeoutMs / 1000));
      this.streams.set(streamId, stream);
      this.metrics.streams.inc();
      this.metrics.connections.inc({ endpoint: "client", phase: "authenticated" });
      ws.send(JSON.stringify({ type: "client.connected", v: RELAY_PROTOCOL_VERSION, streamId }), { compress: false });
      // The schema's streamId is the opaque, single-use ticket. It is never a query parameter.
      host.ws.send(JSON.stringify({ type: "stream.open", v: RELAY_PROTOCOL_VERSION, streamId }), { compress: false });
      ws.on("message", (message, binary) => this.fromClient(stream, message, binary));
      ws.once("close", () => {
        this.metrics.connections.dec({ endpoint: "client", phase: "authenticated" });
        this.closeStream(stream, 1000, "client disconnected", false);
      });
    });
  }

  private async authenticateClient(routeId: string, deviceId: string, token: string): Promise<AuthenticatedDevice | null> {
    // Fresh MySQL/Redis health was established immediately before this method. Redis holds the
    // bounded credential cache, but MySQL remains authoritative so a missed pub/sub invalidation
    // can never authorize a newly revoked device.
    const cached = await this.ephemeral.getCachedCredential(routeId, deviceId);
    if (cached !== null && (cached.disabledAt !== null || cached.device.revokedAt !== null || cached.device.role !== "client" || !equalDigest(cached.device.tokenDigest, token))) return null;
    const authenticated = await this.routes.authenticate(routeId, deviceId, token, "client");
    if (authenticated !== null) await this.ephemeral.cacheCredential(authenticated.device, authenticated.route.disabledAt, this.config.credentialCacheTtlSeconds);
    return authenticated;
  }

  private handleStream(ws: WebSocket, request: IncomingMessage): void {
    this.setupFirstFrame(ws, request, "stream", async (data) => {
      let control;
      try {
        control = parseRelayStreamControlMessage(safeJson(data));
      } catch {
        this.sendErrorAndClose(ws, "bad_frame", "invalid stream ticket");
        return;
      }
      if (control.type !== "stream.open") {
        this.sendErrorAndClose(ws, "bad_frame", "expected stream ticket");
        return;
      }
      if (!(await this.allowAuth("stream", sourceIp(request)))) {
        this.sendErrorAndClose(ws, "rate_limited", "too many attempts", 60_000);
        return;
      }
      if (!(await this.ready())) {
        this.sendErrorAndClose(ws, "internal", "relay unavailable");
        return;
      }
      const ticket = await this.ephemeral.consumeTicket(control.streamId);
      const stream = ticket === null ? undefined : this.streams.get(ticket.streamId);
      const host = ticket === null ? undefined : this.hosts.get(ticket.routeId);
      if (ticket === null || stream === undefined || stream.closed || host === undefined || host.id !== ticket.hostConnectionId || host.id !== stream.hostConnectionId) {
        this.metrics.authFailures.inc({ endpoint: "stream", reason: "unauthorized" });
        this.sendErrorAndClose(ws, "unauthorized", "stream ticket invalid");
        return;
      }
      stream.host = ws;
      clearTimeout(stream.timeout);
      this.metrics.connections.inc({ endpoint: "stream", phase: "authenticated" });
      ws.on("message", (message, binary) => this.fromHost(stream, message, binary));
      ws.once("close", () => {
        this.metrics.connections.dec({ endpoint: "stream", phase: "authenticated" });
        this.closeStream(stream, 1000, "host stream disconnected", false);
      });
      for (const pending of stream.pendingClientFrames.splice(0)) this.forward(stream, ws, pending.data, pending.binary, "client_to_host");
      stream.pendingBytes = 0;
    });
  }

  private fromClient(stream: StreamConnection, data: Data, binary: boolean): void {
    if (bytesOf(data) > DATA_MAX_BYTES) {
      this.closeStream(stream, 1009, "frame too large");
      return;
    }
    if (!isOpen(stream.host)) {
      const bytes = bytesOf(data);
      if (stream.pendingBytes + bytes > BACKPRESSURE_LIMIT_BYTES) this.closeStream(stream, 1013, "backpressure limit");
      else {
        stream.pendingClientFrames.push({ data, binary, bytes });
        stream.pendingBytes += bytes;
      }
      return;
    }
    this.forward(stream, stream.host, data, binary, "client_to_host");
  }

  private fromHost(stream: StreamConnection, data: Data, binary: boolean): void {
    if (bytesOf(data) > DATA_MAX_BYTES) {
      this.closeStream(stream, 1009, "frame too large");
      return;
    }
    this.forward(stream, stream.client, data, binary, "host_to_client");
  }

  private forward(stream: StreamConnection, target: WebSocket, data: Data, binary: boolean, direction: "client_to_host" | "host_to_client"): void {
    if (stream.closed || !isOpen(target)) return;
    const size = bytesOf(data);
    if (target.bufferedAmount + size > BACKPRESSURE_LIMIT_BYTES) {
      this.closeStream(stream, 1013, "backpressure limit");
      return;
    }
    // This is deliberately the only operation on post-open payloads: preserve WS text/binary framing.
    target.send(data, { binary, compress: false }, (error) => {
      if (error != null) this.closeStream(stream, 1013, "write failed");
    });
    this.metrics.forwardedFrames.inc({ direction, kind: binary ? "binary" : "text" });
  }

  private closeStream(stream: StreamConnection, code: number, reason: string, closeClient = true): void {
    if (stream.closed) return;
    stream.closed = true;
    clearTimeout(stream.timeout);
    this.streams.delete(stream.id);
    this.metrics.streams.dec();
    if (closeClient) this.closeSocket(stream.client, code, reason);
    this.closeSocket(stream.host, code, reason);
  }

  private async allowAuth(endpoint: Endpoint, ip: string): Promise<boolean> {
    const verdict = await this.ephemeral.consumeRateLimit(`auth:${endpoint}:${ip}`, this.config.authRatePerMinute, 60);
    if (!verdict.allowed) this.metrics.rateLimited.inc({ scope: "auth" });
    return verdict.allowed;
  }

  private parseHostControl(data: Data): ReturnType<typeof parseRelayHostControlMessage> | null {
    try {
      return parseRelayHostControlMessage(safeJson(data));
    } catch {
      return null;
    }
  }

  private parseClientControl(data: Data): ReturnType<typeof parseRelayClientControlMessage> | null {
    try {
      return parseRelayClientControlMessage(safeJson(data));
    } catch {
      return null;
    }
  }

  private sendErrorAndClose(ws: WebSocket, code: RelayErrorCode, message: string, retryAfterMs?: number): void {
    if (isOpen(ws)) {
      ws.send(JSON.stringify({ type: "error", v: RELAY_PROTOCOL_VERSION, code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }), { compress: false }, () => this.closeSocket(ws, 1008, message));
    } else {
      this.closeSocket(ws, 1008, message);
    }
  }

  private closeSocket(ws: WebSocket | undefined, code: number, reason: string): void {
    if (isOpen(ws)) ws.close(code, reason.slice(0, 123));
  }

  private applyEvent(event: RelayEvent): void {
    if (event.type === "route.disabled") {
      const host = this.hosts.get(event.routeId);
      if (host !== undefined) this.closeSocket(host.ws, 1008, "route disabled");
      for (const stream of this.streams.values()) if (stream.routeId === event.routeId) this.closeStream(stream, 1008, "route disabled");
      return;
    }
    if (event.type === "device.revoked" && event.deviceId !== undefined) {
      for (const stream of this.streams.values()) {
        if (stream.routeId === event.routeId && stream.clientDeviceId === event.deviceId) this.closeStream(stream, 1008, "device revoked");
      }
      const host = this.hosts.get(event.routeId);
      if (host?.deviceId === event.deviceId) this.closeSocket(host.ws, 1008, "device revoked");
    }
  }

  private async runCleanup(): Promise<void> {
    try {
      const count = await this.routes.cleanupInactiveRoutes(new Date(Date.now() - OFFLINE_CLEANUP_MS));
      if (count > 0) this.logger.info({ event: "relay.routes_cleaned", count }, "removed inactive routes");
    } catch (error) {
      this.logger.warn({ event: "relay.cleanup_failed", error: errorKind(error) }, "route cleanup failed");
    }
  }
}
