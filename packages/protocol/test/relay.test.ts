import { describe, expect, it } from "vitest";
import {
  MAX_RELAY_CONTROL_FRAME_BYTES,
  MAX_RELAY_DATA_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  ProtocolError,
  deriveRelayDeviceCredentialDigest,
  deriveRelayRouteId,
  parseRelayClientControlMessage,
  parseRelayControlMessage,
  parseRelayHostAuthentication,
  parseRelayHostControlMessage,
  parseRelayStreamControlMessage,
  relayRouteIdMatchesHostSecret,
  validateRelayFrameSize,
  validateRelayUrl,
} from "../src/index.js";

const hostSecret = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const routeId = deriveRelayRouteId(hostSecret);
const deviceId = "device_0123456789";
const token = "ticket_0123456789";
const credentialDigest = deriveRelayDeviceCredentialDigest(token);
const streamId = "stream_0123456789";
const streamTicket = "stream_ticket_0123456789";
const expiresAt = 1_800_000_000_000;

describe("relay v1 independent data-plane contract", () => {
  it("authenticates the host with only a domain-separated routeId and host secret", () => {
    const auth = { v: RELAY_PROTOCOL_VERSION, routeId, hostSecret };
    expect(parseRelayHostAuthentication(auth)).toEqual(auth);
    expect(routeId).toBe("u5qjyPEUrUFtnUdGofNV__DgRy47sqUsVsN2152P5Ys");
    expect(relayRouteIdMatchesHostSecret(routeId, hostSecret)).toBe(true);
    expect(relayRouteIdMatchesHostSecret(routeId, `${hostSecret.slice(0, -1)}A`)).toBe(false);
    expect(() => parseRelayHostAuthentication({ ...auth, type: "host.auth" })).toThrowError(
      ProtocolError,
    );
  });

  it("requires an atomic, bounded full credential snapshot before host.ready", () => {
    const sync = {
      type: "host.device-sync" as const,
      v: RELAY_PROTOCOL_VERSION,
      generation: 17,
      credentials: [
        { deviceId, credentialDigest },
        { deviceId: "revoked_0123456789", revoked: true as const },
      ],
    };
    expect(parseRelayHostControlMessage(sync)).toEqual(sync);
    expect(
      parseRelayHostControlMessage({
        type: "host.device-sync.ack",
        v: RELAY_PROTOCOL_VERSION,
        generation: 17,
      }),
    ).toMatchObject({ type: "host.device-sync.ack", generation: 17 });
    expect(
      parseRelayHostControlMessage({
        type: "host.ready",
        v: RELAY_PROTOCOL_VERSION,
        routeId,
        generation: 17,
      }),
    ).toMatchObject({ type: "host.ready", generation: 17 });
    expect(() =>
      parseRelayHostControlMessage({
        ...sync,
        credentials: [{ deviceId, credentialDigest }, { deviceId, revoked: true }],
      }),
    ).toThrowError(/at most once/);
    // An empty atomic replacement deliberately revokes every prior credential.
    expect(parseRelayHostControlMessage({ ...sync, generation: 18, credentials: [] })).toEqual({
      ...sync,
      generation: 18,
      credentials: [],
    });
  });

  it("keeps host control JSON-only and rejects the old same-socket stream.open shape", () => {
    // This is an application SecureChannel ciphertext shape, not relay control.
    expect(() => parseRelayHostControlMessage({ c: "opaque_e2e_ciphertext" })).toThrowError(
      ProtocolError,
    );
    expect(() =>
      parseRelayHostControlMessage({
        type: "stream.open",
        v: RELAY_PROTOCOL_VERSION,
        streamId,
      }),
    ).toThrowError(ProtocolError);
    expect(() =>
      parseRelayControlMessage({
        type: "stream.open",
        v: RELAY_PROTOCOL_VERSION,
        streamId,
      }),
    ).toThrowError(ProtocolError);
  });

  it("orders client pending, host offer/accept, then ready on both data sockets", () => {
    const clientOpen = {
      type: "client.open" as const,
      v: RELAY_PROTOCOL_VERSION,
      routeId,
      deviceId,
      token,
    };
    const pending = {
      type: "client.status" as const,
      v: RELAY_PROTOCOL_VERSION,
      status: "pending" as const,
      streamId,
      expiresAt,
    };
    const offer = {
      type: "stream.offer" as const,
      v: RELAY_PROTOCOL_VERSION,
      streamId,
      ticket: streamTicket,
      deviceId,
      expiresAt,
    };
    const accept = {
      type: "stream.accept" as const,
      v: RELAY_PROTOCOL_VERSION,
      streamId,
      ticket: streamTicket,
    };
    const ready = { type: "stream.ready" as const, v: RELAY_PROTOCOL_VERSION, streamId };

    expect(parseRelayClientControlMessage(clientOpen)).toEqual(clientOpen);
    expect(parseRelayClientControlMessage(pending)).toEqual(pending);
    expect(parseRelayHostControlMessage(offer)).toEqual(offer);
    expect(parseRelayStreamControlMessage(accept)).toEqual(accept);
    // The same ready control is delivered to the client socket and the separate
    // host `/v1/stream` socket. Only after both can the relay forward opaque data.
    expect(parseRelayClientControlMessage(ready)).toEqual(ready);
    expect(parseRelayStreamControlMessage(ready)).toEqual(ready);
  });

  it("states ticket one-time and expiry checks as relay implementation responsibilities", () => {
    const offer = {
      type: "stream.offer" as const,
      v: RELAY_PROTOCOL_VERSION,
      streamId,
      ticket: streamTicket,
      deviceId,
      expiresAt,
    };
    const accept = {
      type: "stream.accept" as const,
      v: RELAY_PROTOCOL_VERSION,
      streamId,
      ticket: streamTicket,
    };
    // Schemas validate only wire shape. The relay's ticket store must compare
    // expiresAt and atomically mark this ticket used; it is intentionally not
    // represented as client-controlled JSON state.
    expect(parseRelayHostControlMessage(offer)).toEqual(offer);
    expect(parseRelayStreamControlMessage(accept)).toEqual(accept);
    expect(parseRelayStreamControlMessage(accept)).toEqual(accept);
  });

  it("defines heartbeat, close/revoke, stable errors, and shared frame limits", () => {
    expect(
      parseRelayHostControlMessage({
        type: "host.heartbeat",
        v: RELAY_PROTOCOL_VERSION,
        generation: 17,
      }),
    ).toMatchObject({ type: "host.heartbeat" });
    expect(
      parseRelayHostControlMessage({
        type: "stream.revoke",
        v: RELAY_PROTOCOL_VERSION,
        streamId,
        code: "revoked",
      }),
    ).toMatchObject({ type: "stream.revoke", code: "revoked" });
    expect(
      parseRelayControlMessage({
        type: "error",
        v: RELAY_PROTOCOL_VERSION,
        code: "ticket_used",
        message: "stream ticket has already been consumed",
      }),
    ).toMatchObject({ type: "error", code: "ticket_used" });
    expect(validateRelayFrameSize(MAX_RELAY_CONTROL_FRAME_BYTES, "control")).toBe(
      MAX_RELAY_CONTROL_FRAME_BYTES,
    );
    expect(validateRelayFrameSize(MAX_RELAY_DATA_FRAME_BYTES, "data")).toBe(
      MAX_RELAY_DATA_FRAME_BYTES,
    );
    expect(() => validateRelayFrameSize(MAX_RELAY_CONTROL_FRAME_BYTES + 1, "control")).toThrow(
      /control frame exceeds/,
    );
    expect(() => validateRelayFrameSize(MAX_RELAY_DATA_FRAME_BYTES + 1, "data")).toThrow(
      /data frame exceeds/,
    );
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
