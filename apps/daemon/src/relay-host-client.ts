/** Outbound daemon relay host client, strictly implementing the T1 control/data contract. */
import { WebSocket, type RawData } from "ws";
import {
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
  type DaemonConfig,
  type DeviceRecord,
} from "./pairing.js";

const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;
const MAX_DATA_PAYLOAD = 16 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

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
}

interface Target {
  url: string;
  routeId: string;
  hostSecret: string;
  devices: DeviceRecord[];
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

export class RelayHostClient {
  private target: Target | null = null;
  private control: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private generation = 0;
  private acceptedGeneration = 0;
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
  private readonly suppliedWebSocketFactory: ((url: string) => WebSocket) | undefined;

  constructor(private readonly opts: RelayHostClientOptions) {
    this.random = opts.random ?? Math.random;
    this.minReconnectMs = opts.minReconnectMs ?? MIN_RECONNECT_MS;
    this.maxReconnectMs = opts.maxReconnectMs ?? MAX_RECONNECT_MS;
    this.suppliedWebSocketFactory = opts.webSocketFactory;
  }

  status(): RelayRuntimeStatus {
    return { ...this.statusValue, devices: { ...this.statusValue.devices } };
  }

  /** Hot-load config/devices.json. A device event sends a full atomic snapshot, never a delta. */
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
    const endpointChanged = this.target?.url !== next.url ||
      this.target?.routeId !== next.routeId || this.target?.hostSecret !== next.hostSecret;
    this.target = next;
    this.lastError = undefined;
    if (endpointChanged) {
      this.disconnect();
      this.publish("connecting", next.url, next.routeId, devices);
      this.connect();
      return;
    }
    if (this.control?.readyState === WebSocket.OPEN) {
      this.sendFullDeviceSync();
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
    ws.once("open", () => {
      if (this.control !== ws || this.target !== target || this.stopped) {
        ws.close();
        return;
      }
      // T1's first /v1/host frame contains exactly these fields. It is not a
      // device bearer credential and it never appears in URL/query/log output.
      ws.send(JSON.stringify({ v: RELAY_PROTOCOL_VERSION, routeId: target.routeId, hostSecret: target.hostSecret }));
      this.sendFullDeviceSync();
    });
    ws.on("message", (raw, isBinary) => this.onControlMessage(ws, raw, isBinary));
    ws.once("error", () => this.fail("network"));
    ws.once("close", () => {
      if (this.control !== ws) return;
      this.control = null;
      this.ready = false;
      this.stopHeartbeat();
      this.closeDataSockets();
      this.refreshStatus();
      if (!this.stopped && this.target === target) this.scheduleReconnect();
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
        if (control.generation !== this.generation) throw new Error("stale sync acknowledgement");
        this.acceptedGeneration = control.generation;
        this.refreshStatus();
        return;
      }
      if (control.type === "host.ready") {
        if (control.routeId !== this.target.routeId || control.generation !== this.acceptedGeneration) {
          throw new Error("mismatched host ready");
        }
        this.ready = true;
        this.attempts = 0;
        this.lastError = undefined;
        this.lastConnectedAt = Date.now();
        this.startHeartbeat();
        this.refreshStatus();
        return;
      }
      if (control.type === "host.heartbeat.ack") return;
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
        this.fail(control.code);
        ws.close();
        return;
      }
      // Host-only schemas do not permit device sync/heartbeat from the relay.
      throw new Error("unexpected host control");
    } catch {
      this.fail("invalid_control");
      ws.close();
    }
  }

  private sendFullDeviceSync(): void {
    const ws = this.control;
    const target = this.target;
    if (!ws || ws.readyState !== WebSocket.OPEN || !target) return;
    // T1 uses complete replacement semantics. Omission revokes a prior device;
    // therefore old pre-relay records are intentionally absent and prompted to re-pair.
    this.generation = this.generation >= 0xffff_ffff ? 1 : this.generation + 1;
    this.acceptedGeneration = 0;
    const credentials = target.devices.flatMap((device) => {
      const credentials = deviceRelayCredentials(device);
      return credentials ? [{
        deviceId: credentials.deviceId,
        credentialDigest: deriveRelayDeviceCredentialDigest(credentials.token),
      }] : [];
    });
    if (credentials.length > MAX_RELAY_DEVICE_CREDENTIALS) {
      this.fail("invalid_control");
      return;
    }
    ws.send(JSON.stringify({
      type: "host.device-sync",
      v: RELAY_PROTOCOL_VERSION,
      generation: this.generation,
      credentials,
    }));
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
    this.heartbeatTimer = setInterval(() => {
      if (!this.ready || !this.control || this.control.readyState !== WebSocket.OPEN) return;
      this.control.send(JSON.stringify({
        type: "host.heartbeat", v: RELAY_PROTOCOL_VERSION, generation: this.generation,
      }));
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
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
    this.stopHeartbeat();
    const ws = this.control;
    this.control = null;
    this.ready = false;
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
