import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

export class RelayMetrics {
  readonly registry = new Registry();
  readonly connections = new Gauge({
    name: "prospero_relay_connections",
    help: "Current relay WebSocket connections by endpoint and phase",
    labelNames: ["endpoint", "phase"] as const,
    registers: [this.registry],
  });
  readonly streams = new Gauge({
    name: "prospero_relay_streams",
    help: "Current relay streams",
    registers: [this.registry],
  });
  readonly authFailures = new Counter({
    name: "prospero_relay_auth_failures_total",
    help: "Failed relay control authentications",
    labelNames: ["endpoint", "reason"] as const,
    registers: [this.registry],
  });
  readonly forwardedFrames = new Counter({
    name: "prospero_relay_forwarded_frames_total",
    help: "Opaque WebSocket frames forwarded without inspection",
    labelNames: ["direction", "kind"] as const,
    registers: [this.registry],
  });
  /**
   * The relay deliberately does not inspect opaque payloads, but byte counts
   * are safe operational telemetry and are needed to verify capacity traffic.
   */
  readonly forwardedBytes = new Counter({
    name: "prospero_relay_forwarded_bytes_total",
    help: "Opaque WebSocket payload bytes forwarded without inspection",
    labelNames: ["direction"] as const,
    registers: [this.registry],
  });
  readonly rateLimited = new Counter({
    name: "prospero_relay_rate_limited_total",
    help: "Connections and auth attempts rate limited",
    labelNames: ["scope"] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: "prospero_relay_process_" });
  }
}
