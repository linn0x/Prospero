/**
 * Relay v1 的控制面和独立数据面建连契约。
 *
 * `/v1/host` 始终是 JSON control WebSocket；它绝不能承载 SecureChannel
 * 密文。手机的 `/v1/client` socket 在 `stream.ready` 后才切换为不透明数据，
 * daemon 则必须为每个 offer 新开一个 `/v1/stream` socket。这个文件故意不
 * 解析任何 data frame。
 */
import { z } from "zod";
import { fromB64Url, toB64Url } from "./b64.js";
import { ProtocolError } from "./errors.js";
import { utf8Encode } from "./utf8.js";

/** 独立于 Prospero 应用消息版本的 relay 控制协议版本。 */
export const RELAY_PROTOCOL_VERSION = 1;

/** Relay endpoint paths. Tickets are always control-frame fields, never URLs. */
export const RELAY_HOST_PATH = "/v1/host";
export const RELAY_CLIENT_PATH = "/v1/client";
export const RELAY_STREAM_PATH = "/v1/stream";

/** Deployment WebSocket frame limits, shared by every relay implementation. */
export const MAX_RELAY_CONTROL_FRAME_BYTES = 1 * 1024 * 1024;
export const MAX_RELAY_DATA_FRAME_BYTES = 16 * 1024 * 1024;

/** Schema limits remain deliberately much smaller than the WebSocket limits. */
export const MAX_RELAY_URL_CHARS = 2_048;
export const MAX_RELAY_ROUTE_ID_CHARS = 43; // SHA-256, base64url without padding
export const MAX_RELAY_HOST_SECRET_CHARS = 43; // 32 random bytes, base64url
export const MAX_RELAY_DEVICE_ID_CHARS = 128;
export const MAX_RELAY_TOKEN_CHARS = 512;
export const MAX_RELAY_STREAM_ID_CHARS = 128;
export const MAX_RELAY_TICKET_CHARS = 128;
export const MAX_RELAY_ERROR_MESSAGE_CHARS = 256;
export const MAX_RELAY_DEVICE_CREDENTIALS = 1_024;
export const MAX_RELAY_GENERATION = 4_294_967_295;
export const MAX_RELAY_EXPIRES_AT_MS = 8_640_000_000_000_000;

/** Domain separator for routeId = base64url(SHA-256(domain || hostSecretBytes)). */
export const RELAY_ROUTE_ID_DOMAIN = "prospero.relay.v1.route-id\\0";
/** Domain separator for a stored device credential digest. */
export const RELAY_DEVICE_CREDENTIAL_DOMAIN = "prospero.relay.v1.device-credential\\0";

const opaqueId = (label: string, max: number) =>
  z
    .string()
    .min(16, `${label} must be at least 16 characters`)
    .max(max, `${label} is too long`)
    .regex(/^[A-Za-z0-9_-]+$/, `${label} must be base64url`);

const sha256Base64Url = z
  .string()
  .length(43, "SHA-256 digest must be 43 base64url characters")
  .regex(/^[A-Za-z0-9_-]+$/, "SHA-256 digest must be base64url");

/** Opaque route selector; it is a domain-separated digest, never a daemon ID. */
export const RelayRouteIdSchema = sha256Base64Url;
/** 32 random bytes held only by the host and the relay authentication process. */
export const RelayHostSecretSchema = sha256Base64Url;
/** Opaque pairing-device selector used only by the relay control plane. */
export const RelayDeviceIdSchema = opaqueId("deviceId", MAX_RELAY_DEVICE_ID_CHARS);
/** Route ticket; deliberately distinct from PairingPayload.token (the E2E token). */
export const RelayTokenSchema = opaqueId("relay token", MAX_RELAY_TOKEN_CHARS);
export const RelayStreamIdSchema = opaqueId("streamId", MAX_RELAY_STREAM_ID_CHARS);
/** One-time stream ticket sent only in stream.offer / stream.accept control frames. */
export const RelayStreamTicketSchema = opaqueId("stream ticket", MAX_RELAY_TICKET_CHARS);
/** Digest of the per-device relay credential stored by the relay, never that credential. */
export const RelayDeviceCredentialDigestSchema = sha256Base64Url;

const RelayGenerationSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_RELAY_GENERATION);
const RelayExpiresAtSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_RELAY_EXPIRES_AT_MS);

export interface RelayUrlValidationOptions {
  /**
   * Development only. `ws:` is allowed solely for localhost/loopback and callers
   * must opt in explicitly; the default production policy is `wss:` only.
   */
  allowInsecureLoopback?: boolean;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Check the deployment policy for a relay URL. URLs carry no credentials,
 * fragments, or query strings: relay tickets belong in first control frames.
 */
export function validateRelayUrl(
  value: string,
  options: RelayUrlValidationOptions = {},
): string {
  if (value.length === 0 || value.length > MAX_RELAY_URL_CHARS) {
    throw new ProtocolError("relay URL length is invalid", "format");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProtocolError("relay URL is invalid", "format");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new ProtocolError("relay URL must not contain credentials, query, or fragment", "format");
  }
  if (url.protocol === "wss:") return value;
  if (
    options.allowInsecureLoopback === true &&
    url.protocol === "ws:" &&
    isLoopbackHost(url.hostname)
  ) {
    return value;
  }
  throw new ProtocolError(
    "relay URL must use wss (ws is allowed only with explicit loopback development opt-in)",
    "format",
  );
}

/**
 * Syntax schema used in pairing payloads. Deployment policy is enforced by
 * validateRelayUrl()/QR encode/decode, where an explicit development opt-in is
 * available. This keeps the payload shape portable between development and prod.
 */
export const RelayUrlSchema = z.string().min(1).max(MAX_RELAY_URL_CHARS).superRefine((value, ctx) => {
  try {
    // Permit only the development-safe ws form at shape-validation time. Callers
    // still need allowInsecureLoopback=true when encoding/decoding a QR.
    validateRelayUrl(value, { allowInsecureLoopback: true });
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "invalid relay URL",
    });
  }
});

/** The optional relay portion of a v7 pairing QR. */
export const RelayPairingSchema = z
  .object({
    v: z.literal(RELAY_PROTOCOL_VERSION),
    url: RelayUrlSchema,
    routeId: RelayRouteIdSchema,
    deviceId: RelayDeviceIdSchema,
    token: RelayTokenSchema,
  })
  .strict();

// SHA-256 is implemented here instead of Node's crypto so this protocol package
// remains usable by React Native/Hermes. It receives a tiny fixed-size input.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
  0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
  0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function sha256(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const blockLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(blockLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // This protocol input is bounded below Number.MAX_SAFE_INTEGER; high word is
  // still written for a standard SHA-256 length encoding.
  view.setUint32(blockLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(blockLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) w[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const x = w[index - 15]!;
      const y = w[index - 2]!;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[index] = (((w[index - 16]! + s0) | 0) + ((w[index - 7]! + s1) | 0)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (((((h + s1) | 0) + choice) | 0) + SHA256_K[index]! + w[index]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => {
    digestView.setUint32(index * 4, word, false);
  });
  return digest;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProtocolError(message, "format");
  return result.data;
}

/** Derive the route selector the relay must validate for the host's first frame. */
export function deriveRelayRouteId(hostSecret: string): string {
  const secret = parseOrThrow(RelayHostSecretSchema, hostSecret, "host secret is invalid");
  const domain = utf8Encode(RELAY_ROUTE_ID_DOMAIN);
  const secretBytes = fromB64Url(secret);
  const input = new Uint8Array(domain.length + secretBytes.length);
  input.set(domain);
  input.set(secretBytes, domain.length);
  return toB64Url(sha256(input));
}

/**
 * Derive the digest sent in an atomic device snapshot. A relay compares this
 * value with client.open's token; it does not need to persist the token itself.
 */
export function deriveRelayDeviceCredentialDigest(token: string): string {
  const credential = parseOrThrow(RelayTokenSchema, token, "relay token is invalid");
  const domain = utf8Encode(RELAY_DEVICE_CREDENTIAL_DOMAIN);
  const tokenBytes = utf8Encode(credential);
  const input = new Uint8Array(domain.length + tokenBytes.length);
  input.set(domain);
  input.set(tokenBytes, domain.length);
  return toB64Url(sha256(input));
}

/** Constant-work comparison for relay authentication implementations. */
export function relayRouteIdMatchesHostSecret(routeId: string, hostSecret: string): boolean {
  try {
    const expected = deriveRelayRouteId(hostSecret);
    const actual = parseOrThrow(RelayRouteIdSchema, routeId, "routeId is invalid");
    let difference = 0;
    for (let index = 0; index < expected.length; index++) {
      difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
    }
    return difference === 0;
  } catch {
    return false;
  }
}

const relayVersion = z.literal(RELAY_PROTOCOL_VERSION);

/**
 * `/v1/host` first frame. It deliberately has no `type`: its path and position
 * are its type, so the frame contains only the version, route selector, and host
 * secret. The relay validates routeId with relayRouteIdMatchesHostSecret().
 */
export const RelayHostAuthenticationSchema = z
  .object({
    v: relayVersion,
    routeId: RelayRouteIdSchema,
    hostSecret: RelayHostSecretSchema,
  })
  .strict();
/** Short alias for callers that name the endpoint's first frame "auth". */
export const RelayHostAuthSchema = RelayHostAuthenticationSchema;

const RelayActiveDeviceCredentialSchema = z
  .object({
    deviceId: RelayDeviceIdSchema,
    credentialDigest: RelayDeviceCredentialDigestSchema,
    revoked: z.literal(false).optional(),
  })
  .strict();
const RelayRevokedDeviceCredentialSchema = z
  .object({
    deviceId: RelayDeviceIdSchema,
    revoked: z.literal(true),
  })
  .strict();

/** An entry in the host's complete device-credential snapshot. */
export const RelayDeviceCredentialSchema = z.union([
  RelayActiveDeviceCredentialSchema,
  RelayRevokedDeviceCredentialSchema,
]);

const RelayDeviceCredentialListSchema = z
  .array(RelayDeviceCredentialSchema)
  .max(MAX_RELAY_DEVICE_CREDENTIALS)
  .superRefine((credentials, ctx) => {
    const deviceIds = new Set<string>();
    credentials.forEach((credential, index) => {
      if (deviceIds.has(credential.deviceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "deviceId"],
          message: "deviceId must occur at most once in a credential snapshot",
        });
      }
      deviceIds.add(credential.deviceId);
    });
  });

/**
 * Host → relay: atomically replace this route's full device credential snapshot.
 * `revoked: true` explicitly rejects that device; omitted devices are revoked by
 * replacement too, and `credentials: []` revokes every previously known device.
 */
export const RelayHostDeviceSyncSchema = z
  .object({
    type: z.literal("host.device-sync"),
    v: relayVersion,
    generation: RelayGenerationSchema,
    credentials: RelayDeviceCredentialListSchema,
  })
  .strict();

/** Relay → host: the matching snapshot generation was atomically persisted. */
export const RelayHostDeviceSyncAckSchema = z
  .object({
    type: z.literal("host.device-sync.ack"),
    v: relayVersion,
    generation: RelayGenerationSchema,
  })
  .strict();

/** Relay → host: sent only after the first device-sync acknowledgement. */
export const RelayHostReadySchema = z
  .object({
    type: z.literal("host.ready"),
    v: relayVersion,
    routeId: RelayRouteIdSchema,
    generation: RelayGenerationSchema,
  })
  .strict();

/** Host → relay liveness check for an online host control socket. */
export const RelayHostHeartbeatSchema = z
  .object({
    type: z.literal("host.heartbeat"),
    v: relayVersion,
    generation: RelayGenerationSchema,
  })
  .strict();

/** Relay → host heartbeat acknowledgement. */
export const RelayHostHeartbeatAckSchema = z
  .object({
    type: z.literal("host.heartbeat.ack"),
    v: relayVersion,
    generation: RelayGenerationSchema,
  })
  .strict();

/**
 * Relay → host control: open a separate `/v1/stream` connection and consume the
 * one-time ticket in its first `stream.accept` frame. Tickets never enter a URL.
 */
export const RelayStreamOfferSchema = z
  .object({
    type: z.literal("stream.offer"),
    v: relayVersion,
    streamId: RelayStreamIdSchema,
    ticket: RelayStreamTicketSchema,
    deviceId: RelayDeviceIdSchema,
    expiresAt: RelayExpiresAtSchema,
  })
  .strict();

/** `/v1/stream` first frame from the host; consuming its ticket is implementation state. */
export const RelayStreamAcceptSchema = z
  .object({
    type: z.literal("stream.accept"),
    v: relayVersion,
    streamId: RelayStreamIdSchema,
    ticket: RelayStreamTicketSchema,
  })
  .strict();

/**
 * Relay → client data socket and relay → host stream data socket. Receiving this
 * frame is the sole transition to opaque SecureChannel byte forwarding.
 */
export const RelayStreamReadySchema = z
  .object({
    type: z.literal("stream.ready"),
    v: relayVersion,
    streamId: RelayStreamIdSchema,
  })
  .strict();

export const RelayStreamCloseCodeSchema = z.enum([
  "normal",
  "peer_closed",
  "idle_timeout",
  "expired",
  "revoked",
  "relay_shutdown",
]);

/**
 * A pre-ready terminal control. Once a stream is ready, data sockets use WebSocket
 * close rather than injecting JSON control into the opaque E2E byte stream.
 */
export const RelayStreamCloseSchema = z
  .object({
    type: z.literal("stream.close"),
    v: relayVersion,
    streamId: RelayStreamIdSchema,
    code: RelayStreamCloseCodeSchema,
  })
  .strict();

/** Host or relay cancels a pending offer; the relay reports `stream.close` to the peer. */
export const RelayStreamRevokeSchema = z
  .object({
    type: z.literal("stream.revoke"),
    v: relayVersion,
    streamId: RelayStreamIdSchema,
    code: z.enum(["revoked", "expired", "normal"]),
  })
  .strict();

/** Client → relay first frame on `/v1/client`. */
export const RelayClientOpenSchema = z
  .object({
    type: z.literal("client.open"),
    v: relayVersion,
    routeId: RelayRouteIdSchema,
    deviceId: RelayDeviceIdSchema,
    token: RelayTokenSchema,
  })
  .strict();

/** Relay → client while it waits for the host's independent stream accept. */
export const RelayClientPendingSchema = z
  .object({
    type: z.literal("client.status"),
    v: relayVersion,
    status: z.literal("pending"),
    streamId: RelayStreamIdSchema,
    expiresAt: RelayExpiresAtSchema,
  })
  .strict();

/** Stable, non-sensitive errors for relay control frames. */
export const RelayErrorCodeSchema = z.enum([
  "bad_frame",
  "unsupported_version",
  "unauthorized",
  "route_not_found",
  "route_unavailable",
  "device_revoked",
  "ticket_invalid",
  "ticket_expired",
  "ticket_used",
  "stream_not_found",
  "stream_not_ready",
  "rate_limited",
  "internal",
]);

/** `error` is the error result of client.open, host auth, or a pending stream. */
export const RelayErrorMessageSchema = z
  .object({
    type: z.literal("error"),
    v: relayVersion,
    code: RelayErrorCodeSchema,
    message: z.string().min(1).max(MAX_RELAY_ERROR_MESSAGE_CHARS),
    retryAfterMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();

/** Every JSON frame allowed on the host's long-lived `/v1/host` control socket. */
export const RelayHostControlMessageSchema = z.discriminatedUnion("type", [
  RelayHostDeviceSyncSchema,
  RelayHostDeviceSyncAckSchema,
  RelayHostReadySchema,
  RelayHostHeartbeatSchema,
  RelayHostHeartbeatAckSchema,
  RelayStreamOfferSchema,
  RelayStreamCloseSchema,
  RelayStreamRevokeSchema,
  RelayErrorMessageSchema,
]);

/** Every JSON frame allowed before `/v1/client` switches to opaque data. */
export const RelayClientControlMessageSchema = z.discriminatedUnion("type", [
  RelayClientOpenSchema,
  RelayClientPendingSchema,
  RelayStreamReadySchema,
  RelayStreamCloseSchema,
  RelayErrorMessageSchema,
]);

/** Every JSON frame allowed before `/v1/stream` switches to opaque data. */
export const RelayStreamControlMessageSchema = z.discriminatedUnion("type", [
  RelayStreamAcceptSchema,
  RelayStreamReadySchema,
  RelayStreamCloseSchema,
  RelayErrorMessageSchema,
]);

/** All schema-defined relay JSON controls; it intentionally excludes application data. */
export const RelayControlMessageSchema = z.discriminatedUnion("type", [
  RelayHostDeviceSyncSchema,
  RelayHostDeviceSyncAckSchema,
  RelayHostReadySchema,
  RelayHostHeartbeatSchema,
  RelayHostHeartbeatAckSchema,
  RelayStreamOfferSchema,
  RelayStreamAcceptSchema,
  RelayStreamReadySchema,
  RelayStreamCloseSchema,
  RelayStreamRevokeSchema,
  RelayClientOpenSchema,
  RelayClientPendingSchema,
  RelayErrorMessageSchema,
]);

export type RelayPairing = z.infer<typeof RelayPairingSchema>;
export type RelayHostAuthentication = z.infer<typeof RelayHostAuthenticationSchema>;
export type RelayDeviceCredential = z.infer<typeof RelayDeviceCredentialSchema>;
export type RelayHostControlMessage = z.infer<typeof RelayHostControlMessageSchema>;
export type RelayClientControlMessage = z.infer<typeof RelayClientControlMessageSchema>;
export type RelayStreamControlMessage = z.infer<typeof RelayStreamControlMessageSchema>;
export type RelayControlMessage = z.infer<typeof RelayControlMessageSchema>;
export type RelayErrorCode = z.infer<typeof RelayErrorCodeSchema>;
export type RelayStreamCloseCode = z.infer<typeof RelayStreamCloseCodeSchema>;

/** Check an implementation-provided received WebSocket frame length by plane. */
export function validateRelayFrameSize(
  byteLength: number,
  plane: "control" | "data",
): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new ProtocolError("relay frame byte length is invalid", "format");
  }
  const limit = plane === "control" ? MAX_RELAY_CONTROL_FRAME_BYTES : MAX_RELAY_DATA_FRAME_BYTES;
  if (byteLength > limit) {
    throw new ProtocolError(`relay ${plane} frame exceeds maximum size`, "format");
  }
  return byteLength;
}

function controlFrameSize(value: unknown): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ProtocolError("relay control frame is not JSON-serializable", "format");
  }
  if (typeof encoded !== "string") {
    throw new ProtocolError("relay control frame is not a JSON value", "format");
  }
  validateRelayFrameSize(utf8Encode(encoded).length, "control");
}

function parseRelayMessage<T>(schema: z.ZodType<T>, value: unknown): T {
  controlFrameSize(value);
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ProtocolError(`bad relay control message: ${detail}`, "format");
  }
  return result.data;
}

/** Parse and enforce the special, three-field first frame for `/v1/host`. */
export function parseRelayHostAuthentication(value: unknown): RelayHostAuthentication {
  return parseRelayMessage(RelayHostAuthenticationSchema, value);
}

export function parseRelayHostControlMessage(value: unknown): RelayHostControlMessage {
  return parseRelayMessage(RelayHostControlMessageSchema, value);
}

export function parseRelayClientControlMessage(value: unknown): RelayClientControlMessage {
  return parseRelayMessage(RelayClientControlMessageSchema, value);
}

export function parseRelayStreamControlMessage(value: unknown): RelayStreamControlMessage {
  return parseRelayMessage(RelayStreamControlMessageSchema, value);
}

export function parseRelayControlMessage(value: unknown): RelayControlMessage {
  return parseRelayMessage(RelayControlMessageSchema, value);
}
