/** Outbound daemon relay host client, strictly implementing the T1 control/data contract. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WebSocket, type RawData } from "ws";
import {
  MAX_RELAY_GENERATION,
  RELAY_HOST_PATH,
  RELAY_PROTOCOL_VERSION,
  RELAY_STREAM_PATH,
  MAX_RELAY_CONTROL_FRAME_BYTES,
  MAX_RELAY_DEVICE_CREDENTIALS,
  deriveRelayDeviceCredentialDigest,
  parseRelayHostControlMessage,
  parseRelayStreamControlMessage,
  validateRelayFrameSize,
  validateRelayUrl,
  type RelayErrorCode,
} from "@prospero/protocol";
import {
  deriveRelayRouteId,
  deviceRelayCredentials,
  effectiveRelayUrl,
  prosperoHome,
  type DaemonConfig,
  type DeviceRecord,
} from "./pairing.js";

const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;
const MAX_DATA_PAYLOAD = 16 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const AUTH_TIMEOUT_MS = 10_000;
const DEVICE_SYNC_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 10_000;
const HEARTBEAT_ACK_TIMEOUT_MS = 10_000;
export const RELAY_SYNC_STATE_FILE = "relay-sync-state.json";

export type RelayConnectionState = "disabled" | "offline" | "connecting" | "syncing" | "online" | "error";

/** Status/log safe: no host secret, pairing token, relay token, or stream ticket. */
export interface RelayRuntimeStatus {
  enabled: boolean;
  state: RelayConnectionState;
  url: string | null;
  routeId: string | null;
  updatedAt: number;
  lastConnectedAt?: number;
  lastError?: string;
  devices: { total: number; ready: number; needsRePair: number };
}

export interface RelayHostClientOptions {
  devMode?: boolean;
  /** Called only after `/v1/stream` received stream.ready; socket now carries E2E frames. */
  onStream: (ws: WebSocket) => void;
  onStatus?: (status: RelayRuntimeStatus) => void;
  webSocketFactory?: (url: string) => WebSocket;
  random?: () => number;
  minReconnectMs?: number;
  maxReconnectMs?: number;
  /** Daemon home for the private, atomic per-route generation journal. */
  stateDir?: string;
  /** Test knobs; production defaults keep every control-plane phase bounded. */
  authTimeoutMs?: number;
  deviceSyncTimeoutMs?: number;
  readyTimeoutMs?: number;
  heartbeatMs?: number;
  heartbeatAckTimeoutMs?: number;
}

interface Target {
  url: string;
  routeId: string;
  hostSecret: string;
  devices: DeviceRecord[];
}

interface RelaySyncState {
  version: 1;
  routes: Record<string, number>;
}

function rawText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return raw.toString("utf8");
}

/** URL overrides are relay origins; T1 fixes the two endpoint paths itself. */
function relayEndpoint(url: string, endpointPath: string): string {
  const parsed = new URL(url);
  parsed.pathname = endpointPath;
  return parsed.toString();
}

function safeRelayError(code: RelayErrorCode | "invalid_control" | "network"): string {
  // Relay-provided message strings never reach status.json or logs because they
  // may contain deployment details. Stable codes are enough for user diagnosis.
  return `relay ${code}`;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function deviceSnapshotFingerprint(devices: DeviceRecord[]): string {
  // This is an in-memory change detector only.  Never log or publish it: it
  // contains bearer tokens, unlike the credential digests sent to the relay.
  return devices
    .flatMap((device) => {
      const credentials = deviceRelayCredentials(device);
      return credentials ? [`${credentials.deviceId}:${credentials.token}`] : [];
    })
    .sort()
    .join("\n");
}

export class RelayHostClient {
  private target: Target | null = null;
  private control: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private authTimer: NodeJS.Timeout | null = null;
  private deviceSyncTimer: NodeJS.Timeout | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatAckTimer: NodeJS.Timeout | null = null;
  private awaitingHeartbeatGeneration: number | null = null;
  private attempts = 0;
  private generation = 0;
  /** The latest complete snapshot that this control socket has acknowledged. */
  private acceptedGeneration: number | null = null;
  /**
   * `host.ready` is a connection-level transition, not a per-snapshot ACK.
   * T1/T2 send it once after the first snapshot on each /v1/host socket.
   */
  private connectionReady = false;
  private initialGeneration: number | null = null;
  private initialGenerationAcknowledged = false;
  private ready = false;
  private stopped = false;
  private lastError: string | undefined;
  private lastConnectedAt: number | undefined;
  private readonly dataSockets = new Set<WebSocket>();
  private readonly activeStreamIds = new Set<string>();
  private statusValue: RelayRuntimeStatus = {
    enabled: false,
    state: "disabled",
    url: null,
    routeId: null,
    updatedAt: Date.now(),
    devices: { total: 0, ready: 0, needsRePair: 0 },
  };
  private readonly random: () => number;
  private readonly minReconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly authTimeoutMs: number;
  private readonly deviceSyncTimeoutMs: number;
  private readonly readyTimeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly heartbeatAckTimeoutMs: number;
  private readonly generationStateFile: string;
  private readonly generations = new Map<string, number>();
  private readonly suppliedWebSocketFactory: ((url: string) => WebSocket) | undefined;

  constructor(private readonly opts: RelayHostClientOptions) {
    this.random = opts.random ?? Math.random;
    this.minReconnectMs = opts.minReconnectMs ?? MIN_RECONNECT_MS;
    this.maxReconnectMs = opts.maxReconnectMs ?? MAX_RECONNECT_MS;
    this.authTimeoutMs = positiveTimeout(opts.authTimeoutMs, AUTH_TIMEOUT_MS);
    this.deviceSyncTimeoutMs = positiveTimeout(opts.deviceSyncTimeoutMs, DEVICE_SYNC_TIMEOUT_MS);
    this.readyTimeoutMs = positiveTimeout(opts.readyTimeoutMs, READY_TIMEOUT_MS);
    this.heartbeatMs = positiveTimeout(opts.heartbeatMs, HEARTBEAT_MS);
    this.heartbeatAckTimeoutMs = positiveTimeout(opts.heartbeatAckTimeoutMs, HEARTBEAT_ACK_TIMEOUT_MS);
    this.generationStateFile = path.join(opts.stateDir ?? prosperoHome(), RELAY_SYNC_STATE_FILE);
    this.loadGenerations();
    this.suppliedWebSocketFactory = opts.webSocketFactory;
  }

  status(): RelayRuntimeStatus {
    return { ...this.statusValue, devices: { ...this.statusValue.devices } };
  }

  /**
   * Hot-load config/devices.json. Only a change to the active relay credential
   * set sends a full atomic replacement snapshot; metadata and local
   * authorization changes must not perturb relay generations or streams.
   */
  update(config: DaemonConfig, devices: DeviceRecord[]): void {
    this.stopped = false;
    const requestedUrl = effectiveRelayUrl(config);
    if (!config.relay?.enabled) {
      this.target = null;
      this.disconnect();
      this.lastError = undefined;
      this.publish("disabled", null, null, devices);
      return;
    }
    if (!requestedUrl || !config.relay.hostSecret) {
      this.target = null;
      this.disconnect();
      this.lastError = "relay configuration incomplete";
      this.publish("error", requestedUrl ?? null, null, devices);
      return;
    }
    let next: Target;
    try {
      validateRelayUrl(requestedUrl, { allowInsecureLoopback: this.opts.devMode === true });
      next = {
        url: requestedUrl,
        routeId: deriveRelayRouteId(config.relay.hostSecret),
        hostSecret: config.relay.hostSecret,
        devices,
      };
    } catch {
      this.target = null;
      this.disconnect();
      this.lastError = "relay URL or key is invalid";
      this.publish("error", requestedUrl, null, devices);
      return;
    }
    const previous = this.target;
    const endpointChanged = previous?.url !== next.url ||
      this.target?.routeId !== next.routeId || this.target?.hostSecret !== next.hostSecret;
    const credentialsChanged = previous !== null && previous !== undefined &&
      deviceSnapshotFingerprint(previous.devices) !== deviceSnapshotFingerprint(next.devices);
    this.target = next;
    this.lastError = undefined;
    if (endpointChanged) {
      this.generation = this.generations.get(next.routeId) ?? 0;
      this.acceptedGeneration = null;
      this.disconnect();
      this.publish("connecting", next.url, next.routeId, devices);
      this.connect();
      return;
    }
    if (this.control?.readyState === WebSocket.OPEN) {
      // A full replacement sync revokes omissions.  Existing stream sockets
      // carry no device ID, so close them conservatively when that credential
      // set changes rather than allowing a removed device to linger.
      if (credentialsChanged) {
        this.closeDataSockets();
        this.sendFullDeviceSync();
      } else {
        this.refreshStatus();
      }
    } else {
      this.publish("connecting", next.url, next.routeId, devices);
      this.connect();
    }
  }

  close(): void {
    this.stopped = true;
    this.target = null;
    this.disconnect();
    this.publish("disabled", null, null, []);
  }

  private connect(): void {
    const target = this.target;
    if (!target || this.stopped || this.control || this.reconnectTimer) return;
    let ws: WebSocket;
    try {
      ws = this.makeSocket(relayEndpoint(target.url, RELAY_HOST_PATH), MAX_RELAY_CONTROL_FRAME_BYTES);
    } catch {
      this.fail("network");
      this.scheduleReconnect();
      return;
    }
    this.control = ws;
    this.connectionReady = false;
    this.initialGeneration = null;
    this.initialGenerationAcknowledged = false;
    ws.once("open", () => {
      if (this.control !== ws || this.stopped) {
        ws.close();
        return;
      }
      // T1's first /v1/host frame contains exactly these fields. It is not a
      // device bearer credential and it never appears in URL/query/log output.
      this.startAuthTimeout(ws);
      try {
        ws.send(JSON.stringify({ v: RELAY_PROTOCOL_VERSION, routeId: target.routeId, hostSecret: target.hostSecret }));
      } catch {
        this.failAndClose(ws, "network");
        return;
      }
      this.sendFullDeviceSync();
    });
    ws.on("message", (raw, isBinary) => this.onControlMessage(ws, raw, isBinary));
    ws.once("error", () => {
      if (this.control === ws) this.fail("network");
    });
    ws.once("close", () => {
      if (this.control !== ws) return;
      this.control = null;
      this.ready = false;
      this.connectionReady = false;
      this.initialGeneration = null;
      this.initialGenerationAcknowledged = false;
      this.stopControlTimers();
      this.stopHeartbeat();
      this.closeDataSockets();
      this.refreshStatus();
      if (!this.stopped && this.target) this.scheduleReconnect();
    });
  }

  private onControlMessage(ws: WebSocket, raw: RawData, isBinary: boolean): void {
    if (ws !== this.control || !this.target) return;
    let value: unknown;
    try {
      if (isBinary) throw new Error("binary host control");
      value = JSON.parse(rawText(raw));
      validateRelayFrameSize(Buffer.byteLength(rawText(raw), "utf8"), "control");
      const control = parseRelayHostControlMessage(value);
      if (control.type === "host.device-sync.ack") {
        const isInitial = control.generation === this.initialGeneration;
        const isCurrent = control.generation === this.generation;
        // A delayed first-generation ACK still unlocks the one connection-level
        // ready frame, but cannot promote a newer snapshot. Every other stale
        // (or future) ACK is harmless and ignored.
        if (!isInitial && !isCurrent) return;
        if (isInitial) {
          const firstInitialAck = !this.initialGenerationAcknowledged;
          this.clearAuthTimer();
          this.initialGenerationAcknowledged = true;
          if (firstInitialAck && !this.connectionReady) this.startReadyTimeout(ws, control.generation);
        }
        if (isCurrent) {
          this.clearDeviceSyncTimer();
          this.acceptedGeneration = control.generation;
        }
        this.restoreOnlineWhenCurrentSnapshotIsAccepted();
        this.refreshStatus();
        return;
      }
      if (control.type === "host.ready") {
        if (control.routeId !== this.target.routeId ||
          control.generation !== this.initialGeneration || !this.initialGenerationAcknowledged) {
          // A ready for any generation other than this socket's first snapshot
          // is stale or malformed for the T1/T2 contract. It must never
          // promote the latest snapshot by itself.
          return;
        }
        this.clearReadyTimer();
        this.connectionReady = true;
        this.restoreOnlineWhenCurrentSnapshotIsAccepted();
        this.refreshStatus();
        return;
      }
      if (control.type === "host.heartbeat.ack") {
        if (control.generation === this.generation && this.awaitingHeartbeatGeneration === control.generation) {
          this.awaitingHeartbeatGeneration = null;
          this.clearHeartbeatAckTimer();
        }
        return;
      }
      if (control.type === "stream.offer") {
        if (!this.ready || !this.hasRelayDevice(control.deviceId)) {
          ws.send(JSON.stringify({
            type: "stream.revoke", v: RELAY_PROTOCOL_VERSION, streamId: control.streamId, code: "revoked",
          }));
          return;
        }
        if (control.expiresAt <= Date.now()) {
          ws.send(JSON.stringify({
            type: "stream.revoke", v: RELAY_PROTOCOL_VERSION, streamId: control.streamId, code: "expired",
          }));
          return;
        }
        if (this.activeStreamIds.has(control.streamId)) {
          ws.send(JSON.stringify({
            type: "stream.revoke", v: RELAY_PROTOCOL_VERSION, streamId: control.streamId, code: "normal",
          }));
          return;
        }
        this.acceptStream(control.streamId, control.ticket, control.expiresAt);
        return;
      }
      if (control.type === "stream.close" || control.type === "stream.revoke") return;
      if (control.type === "error") {
        this.failAndClose(ws, control.code);
        return;
      }
      // Host-only schemas do not permit device sync/heartbeat from the relay.
      throw new Error("unexpected host control");
    } catch {
      this.failAndClose(ws, "invalid_control");
    }
  }

  private sendFullDeviceSync(): void {
    const ws = this.control;
    const target = this.target;
    if (!ws || ws.readyState !== WebSocket.OPEN || !target) return;
    // T1 uses complete replacement semantics. Omission revokes a prior device;
    // therefore old pre-relay records are intentionally absent and prompted to re-pair.
    const generation = this.nextGeneration(target.routeId);
    if (generation === null) {
      this.failAndClose(ws, "network");
      return;
    }
    this.generation = generation;
    this.acceptedGeneration = null;
    this.ready = false;
    this.stopHeartbeat();
    if (this.initialGeneration === null) this.initialGeneration = generation;
    const credentials = target.devices.flatMap((device) => {
      const credentials = deviceRelayCredentials(device);
      return credentials ? [{
        deviceId: credentials.deviceId,
        credentialDigest: deriveRelayDeviceCredentialDigest(credentials.token),
      }] : [];
    });
    if (credentials.length > MAX_RELAY_DEVICE_CREDENTIALS) {
      this.failAndClose(ws, "invalid_control");
      return;
    }
    this.startDeviceSyncTimeout(ws, generation);
    try {
      ws.send(JSON.stringify({
        type: "host.device-sync",
        v: RELAY_PROTOCOL_VERSION,
        generation,
        credentials,
      }));
    } catch {
      this.failAndClose(ws, "network");
      return;
    }
    this.refreshStatus();
  }

  private acceptStream(streamId: string, ticket: string, expiresAt: number): void {
    if (expiresAt <= Date.now() || !this.target) return;
    let ws: WebSocket;
    try {
      ws = this.makeSocket(relayEndpoint(this.target.url, RELAY_STREAM_PATH), MAX_DATA_PAYLOAD);
    } catch {
      this.fail("network");
      return;
    }
    this.activeStreamIds.add(streamId);
    this.dataSockets.add(ws);
    const onMessage = (raw: RawData, isBinary: boolean): void => {
      try {
        if (isBinary) throw new Error("binary stream setup control");
        const control = parseRelayStreamControlMessage(JSON.parse(rawText(raw)));
        if (control.type === "stream.ready" && control.streamId === streamId) {
          ws.off("message", onMessage);
          this.opts.onStream(ws);
          return;
        }
        if (control.type === "error") this.fail(control.code);
        ws.close();
      } catch {
        this.fail("invalid_control");
        ws.close();
      }
    };
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "stream.accept", v: RELAY_PROTOCOL_VERSION, streamId, ticket }));
    });
    ws.on("message", onMessage);
    ws.once("error", () => this.fail("network"));
    ws.once("close", () => {
      this.dataSockets.delete(ws);
      this.activeStreamIds.delete(streamId);
    });
  }

  private hasRelayDevice(deviceId: string): boolean {
    return this.target?.devices.some((device) => deviceRelayCredentials(device)?.deviceId === deviceId) ?? false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private sendHeartbeat(): void {
    const ws = this.control;
    if (!this.ready || !ws || ws.readyState !== WebSocket.OPEN || this.awaitingHeartbeatGeneration !== null) return;
    const generation = this.generation;
    this.awaitingHeartbeatGeneration = generation;
    this.clearHeartbeatAckTimer();
    this.heartbeatAckTimer = setTimeout(() => {
      if (this.control === ws && this.awaitingHeartbeatGeneration === generation) {
        this.failAndClose(ws, "network");
      }
    }, this.heartbeatAckTimeoutMs);
    this.heartbeatAckTimer.unref?.();
    try {
      ws.send(JSON.stringify({ type: "host.heartbeat", v: RELAY_PROTOCOL_VERSION, generation }));
    } catch {
      this.failAndClose(ws, "network");
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.awaitingHeartbeatGeneration = null;
    this.clearHeartbeatAckTimer();
  }

  /**
   * A connected relay is usable only once its first snapshot has produced the
   * one `host.ready` transition and the most recent replacement is ACKed.
   * Subsequent credential snapshots therefore resume on ACK alone.
   */
  private restoreOnlineWhenCurrentSnapshotIsAccepted(): void {
    if (!this.connectionReady || this.acceptedGeneration !== this.generation) return;
    const becameReady = !this.ready;
    this.ready = true;
    if (becameReady) {
      this.attempts = 0;
      this.lastError = undefined;
      this.lastConnectedAt = Date.now();
      this.startHeartbeat();
    }
  }

  private fail(error: RelayErrorCode | "invalid_control" | "network"): void {
    this.ready = false;
    this.lastError = safeRelayError(error);
    this.refreshStatus();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped || !this.target) return;
    const exponent = Math.min(this.attempts++, 10);
    const cap = Math.min(this.maxReconnectMs, this.minReconnectMs * 2 ** exponent);
    const delay = Math.max(this.minReconnectMs, Math.floor(this.random() * cap));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopControlTimers();
    this.stopHeartbeat();
    const ws = this.control;
    this.control = null;
    this.ready = false;
    this.connectionReady = false;
    this.initialGeneration = null;
    this.initialGenerationAcknowledged = false;
    ws?.terminate();
    this.closeDataSockets();
  }

  private closeDataSockets(): void {
    for (const socket of this.dataSockets) socket.terminate();
    this.dataSockets.clear();
    this.activeStreamIds.clear();
  }

  private makeSocket(url: string, maxPayload: number): WebSocket {
    return this.suppliedWebSocketFactory?.(url) ?? new WebSocket(url, {
      perMessageDeflate: false,
      maxPayload,
    });
  }

  private failAndClose(ws: WebSocket, error: RelayErrorCode | "invalid_control" | "network"): void {
    if (this.control !== ws) return;
    this.fail(error);
    this.stopControlTimers();
    this.stopHeartbeat();
    this.closeDataSockets();
    // Terminate handles silent and half-open peers where a close handshake
    // would itself wait forever. The close handler schedules the bounded-jitter
    // reconnect and is the sole owner of that transition.
    ws.terminate();
  }

  private startAuthTimeout(ws: WebSocket): void {
    this.clearAuthTimer();
    this.authTimer = setTimeout(() => this.failAndClose(ws, "network"), this.authTimeoutMs);
    this.authTimer.unref?.();
  }

  private startDeviceSyncTimeout(ws: WebSocket, generation: number): void {
    this.clearDeviceSyncTimer();
    this.deviceSyncTimer = setTimeout(() => {
      if (this.control === ws && this.generation === generation && this.acceptedGeneration !== generation) {
        this.failAndClose(ws, "network");
      }
    }, this.deviceSyncTimeoutMs);
    this.deviceSyncTimer.unref?.();
  }

  private startReadyTimeout(ws: WebSocket, generation: number): void {
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      if (this.control === ws && this.initialGeneration === generation && !this.connectionReady) {
        this.failAndClose(ws, "network");
      }
    }, this.readyTimeoutMs);
    this.readyTimer.unref?.();
  }

  private clearAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private clearDeviceSyncTimer(): void {
    if (this.deviceSyncTimer) clearTimeout(this.deviceSyncTimer);
    this.deviceSyncTimer = null;
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private clearHeartbeatAckTimer(): void {
    if (this.heartbeatAckTimer) clearTimeout(this.heartbeatAckTimer);
    this.heartbeatAckTimer = null;
  }

  private stopControlTimers(): void {
    this.clearAuthTimer();
    this.clearDeviceSyncTimer();
    this.clearReadyTimer();
  }

  private loadGenerations(): void {
    try {
      if (!existsSync(this.generationStateFile)) return;
      const parsed = JSON.parse(readFileSync(this.generationStateFile, "utf8")) as Partial<RelaySyncState>;
      if (parsed.version !== 1 || !parsed.routes || typeof parsed.routes !== "object") return;
      for (const [routeId, generation] of Object.entries(parsed.routes)) {
        if (Number.isInteger(generation) && generation >= 0 && generation <= MAX_RELAY_GENERATION) {
          this.generations.set(routeId, generation);
        }
      }
    } catch {
      // A missing/corrupt journal must never publish credentials as ready. The
      // next sync starts from a fresh route-local counter and waits for ACK.
      this.generations.clear();
    }
  }

  private nextGeneration(routeId: string): number | null {
    const previous = this.generations.get(routeId) ?? 0;
    // Never wrap to 1: that would violate monotonic replacement semantics and
    // could let an old relay snapshot win. Exhaustion fails closed instead.
    if (previous >= MAX_RELAY_GENERATION) return null;
    const generation = previous + 1;
    const routes = Object.fromEntries(this.generations.entries());
    routes[routeId] = generation;
    const state: RelaySyncState = { version: 1, routes };
    const temporary = `${this.generationStateFile}.${String(process.pid)}.${String(Date.now())}.tmp`;
    try {
      mkdirSync(path.dirname(this.generationStateFile), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(state) + "\n", { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.generationStateFile);
      chmodSync(this.generationStateFile, 0o600);
      this.generations.set(routeId, generation);
      return generation;
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        // The write did not create a recoverable journal entry.
      }
      return null;
    }
  }

  private refreshStatus(): void {
    const target = this.target;
    if (!target) return;
    const ready = this.ready ? target.devices.filter((device) => deviceRelayCredentials(device) !== null).length : 0;
    this.publish(
      this.ready ? "online" : this.lastError ? "error" : "syncing",
      target.url,
      target.routeId,
      target.devices,
      ready,
    );
  }

  private publish(
    state: RelayConnectionState,
    url: string | null,
    routeId: string | null,
    devices: DeviceRecord[],
    ready = 0,
  ): void {
    const needsRePair = devices.filter((device) => deviceRelayCredentials(device) === null).length;
    this.statusValue = {
      enabled: state !== "disabled",
      state,
      url,
      routeId,
      updatedAt: Date.now(),
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      devices: { total: devices.length, ready, needsRePair },
    };
    this.opts.onStatus?.(this.status());
  }
}
