import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { deriveRelayRouteId } from "@prospero/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { RelayConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { RelayServer } from "../src/relay.js";
import { streamTicketStorageKey } from "../src/crypto.js";
import { MemoryEphemeralStore, MemoryRouteStore } from "./helpers.js";
import { WebSocket } from "ws";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function config(): RelayConfig {
  return {
    host: "127.0.0.1", port: 0, mysqlUrl: "", redisUrl: "", migrationDir: "",
    metricsInternalOnly: true, maxStreamsPerRoute: 8, authTimeoutMs: 500,
    ticketTimeoutMs: 1_000, credentialCacheTtlSeconds: 60, presenceTtlSeconds: 20,
    authRatePerMinute: 20, connectionRatePerMinute: 60, cleanupIntervalMs: 60_000,
    logLevel: "silent",
  };
}

class CapturingDestination extends Writable {
  output = "";
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString("utf8");
    callback();
  }
}

class RateLimitCapture extends MemoryEphemeralStore {
  readonly keys: string[] = [];
  override async consumeRateLimit(...args: Parameters<MemoryEphemeralStore["consumeRateLimit"]>) {
    this.keys.push(args[0]);
    return super.consumeRateLimit(...args);
  }
}

describe("relay security audit regressions", () => {
  const running: RelayServer[] = [];
  afterEach(async () => { await Promise.all(running.splice(0).map((relay) => relay.close())); });

  it("redacts credential fields at every supported log nesting level", () => {
    const token = "relay-token-audit-marker";
    const hostSecret = "host-secret-audit-marker";
    const credentialDigest = "credential-digest-audit-marker";
    const ticket = "stream-ticket-audit-marker";
    const sink = new CapturingDestination();
    const logger = createLogger("info", sink);

    logger.info({ token, hostSecret, credentialDigest, ticket, nested: { token, hostSecret, credentialDigest, ticket }, headers: { authorization: `Bearer ${token}` } }, "safe event");

    for (const secret of [token, hostSecret, credentialDigest, ticket]) {
      expect(sink.output).not.toContain(secret);
    }
    expect(sink.output).toContain("[redacted]");
  });

  it("hashes stream tickets before the persistence boundary and keeps redemption semantics", async () => {
    const ephemeral = new MemoryEphemeralStore();
    const ticket = "t".repeat(43);
    await ephemeral.createTicket({
      streamId: "s".repeat(22), ticket, routeId: "r".repeat(43),
      hostConnectionId: "host-connection", clientDeviceId: "device-id", expiresAt: Date.now() + 5_000,
    });

    const stored = JSON.stringify({ tickets: [...ephemeral.tickets], states: [...ephemeral.ticketStates] });
    expect(stored).not.toContain(ticket);
    expect([...ephemeral.tickets.keys()]).toEqual([streamTicketStorageKey(ticket)]);
    expect(await ephemeral.redeemTicket(ticket, "s".repeat(22))).toMatchObject({ status: "ok" });
    expect(await ephemeral.redeemTicket(ticket, "s".repeat(22))).toEqual({ status: "used" });
  });

  it("does not accept caller-controlled forwarding headers for rate limits or logs", async () => {
    const hostSecret = randomBytes(32).toString("base64url");
    const routes = new MemoryRouteStore();
    const ephemeral = new RateLimitCapture();
    const relay = new RelayServer({
      routes,
      ephemeral,
      config: { ...config(), trustedProxyIps: ["203.0.113.7"] },
      logger: createLogger("silent"),
    });
    await relay.listen();
    running.push(relay);
    const address = relay.address();
    if (address === undefined) throw new Error("relay did not bind");

    const marker = "e2e-token-must-not-be-a-rate-limit-key";
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/host`, {
      headers: { "x-forwarded-for": marker, "x-prospero-source-ip": marker },
    });
    await once(ws, "open");
    ws.send(JSON.stringify({ v: 1, routeId: deriveRelayRouteId(hostSecret), hostSecret }));
    await wait(20);
    ws.terminate();

    expect(ephemeral.keys).toContain("connection:127.0.0.1");
    expect(ephemeral.keys).toContain("auth:host:127.0.0.1");
    expect(ephemeral.keys.join("\n")).not.toContain(marker);
  });
});
