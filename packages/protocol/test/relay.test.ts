import { describe, expect, it } from "vitest";
import {
  MAX_RELAY_CONTROL_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  ProtocolError,
  parseRelayClientControlMessage,
  parseRelayControlMessage,
  parseRelayHostControlMessage,
  parseRelayStreamControlMessage,
  validateRelayUrl,
} from "../src/index.js";

const routeId = "route_0123456789";
const deviceId = "device_0123456789";
const token = "ticket_0123456789";
const streamId = "stream_0123456789";

describe("relay v1 control contract", () => {
  it("round-trips each host, client, stream, and error control message", () => {
    const hostRegister = {
      type: "host.register" as const,
      v: RELAY_PROTOCOL_VERSION,
      routeId,
      deviceId,
      token,
    };
    expect(parseRelayHostControlMessage(hostRegister)).toEqual(hostRegister);
    expect(
      parseRelayHostControlMessage({
        type: "host.ready",
        v: RELAY_PROTOCOL_VERSION,
        routeId,
      }),
    ).toMatchObject({ type: "host.ready", routeId });

    const clientConnect = {
      type: "client.connect" as const,
      v: RELAY_PROTOCOL_VERSION,
      routeId,
      deviceId,
      token,
    };
    expect(parseRelayClientControlMessage(clientConnect)).toEqual(clientConnect);
    expect(
      parseRelayClientControlMessage({
        type: "client.connected",
        v: RELAY_PROTOCOL_VERSION,
        streamId,
      }),
    ).toMatchObject({ type: "client.connected", streamId });

    expect(
      parseRelayStreamControlMessage({
        type: "stream.open",
        v: RELAY_PROTOCOL_VERSION,
        streamId,
      }),
    ).toMatchObject({ type: "stream.open", streamId });
    expect(
      parseRelayStreamControlMessage({
        type: "stream.close",
        v: RELAY_PROTOCOL_VERSION,
        streamId,
        code: "peer_closed",
      }),
    ).toMatchObject({ type: "stream.close", code: "peer_closed" });
    expect(
      parseRelayControlMessage({
        type: "error",
        v: RELAY_PROTOCOL_VERSION,
        code: "route_unavailable",
        message: "host is offline",
        retryAfterMs: 500,
      }),
    ).toMatchObject({ type: "error", code: "route_unavailable" });
  });

  it("rejects unknown fields, malformed IDs, unsupported versions, and oversized controls", () => {
    expect(() => parseRelayControlMessage(undefined)).toThrowError(ProtocolError);
    expect(() =>
      parseRelayControlMessage({
        type: "host.ready",
        v: RELAY_PROTOCOL_VERSION,
        routeId,
        unexpected: true,
      }),
    ).toThrowError(ProtocolError);
    expect(() =>
      parseRelayControlMessage({
        type: "client.connect",
        v: RELAY_PROTOCOL_VERSION,
        routeId: "short",
        deviceId,
        token,
      }),
    ).toThrowError(ProtocolError);
    expect(() =>
      parseRelayControlMessage({
        type: "host.ready",
        v: 2,
        routeId,
      }),
    ).toThrowError(ProtocolError);
    expect(() =>
      parseRelayControlMessage({
        type: "error",
        v: RELAY_PROTOCOL_VERSION,
        code: "internal",
        message: "x".repeat(MAX_RELAY_CONTROL_FRAME_BYTES),
      }),
    ).toThrowError(/exceeds maximum size/);
  });

  it("uses wss in production and permits ws only with an explicit loopback development opt-in", () => {
    expect(validateRelayUrl("wss://relay.example.com/v1")).toBe("wss://relay.example.com/v1");
    expect(() => validateRelayUrl("ws://localhost:8787")).toThrowError(/must use wss/);
    expect(validateRelayUrl("ws://localhost:8787", { allowInsecureLoopback: true })).toBe(
      "ws://localhost:8787",
    );
    expect(() =>
      validateRelayUrl("ws://relay.example.com", { allowInsecureLoopback: true }),
    ).toThrowError(/must use wss/);
    expect(() => validateRelayUrl("wss://relay.example.com?token=nope")).toThrowError(
      /must not contain credentials, query, or fragment/,
    );
  });
});
