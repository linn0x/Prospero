/**
 * Relay v1 的公开控制面。
 *
 * 这些 JSON 控制帧只建立/撤销一条字节流；stream.open 之后的应用帧是
 * SecureChannel 密文，relay 必须把它们作为不透明字节转发，不能解析或修改。
 */
import { z } from "zod";
import { ProtocolError } from "./errors.js";
import { utf8Encode } from "./utf8.js";

/** 独立于 Prospero 应用消息版本的 relay 控制协议版本。 */
export const RELAY_PROTOCOL_VERSION = 1;

/** 所有控制字段都有上限，避免 relay 在建立流前承受无界输入。 */
export const MAX_RELAY_CONTROL_FRAME_BYTES = 4_096;
export const MAX_RELAY_URL_CHARS = 2_048;
export const MAX_RELAY_ROUTE_ID_CHARS = 128;
export const MAX_RELAY_DEVICE_ID_CHARS = 128;
export const MAX_RELAY_TOKEN_CHARS = 512;
export const MAX_RELAY_STREAM_ID_CHARS = 128;
export const MAX_RELAY_ERROR_MESSAGE_CHARS = 256;

const opaqueId = (label: string, max: number) =>
  z
    .string()
    .min(16, `${label} must be at least 16 characters`)
    .max(max, `${label} is too long`)
    .regex(/^[A-Za-z0-9_-]+$/, `${label} must be base64url`);

/** Opaque route selector. It is not a daemon identity or an E2E secret. */
export const RelayRouteIdSchema = opaqueId("routeId", MAX_RELAY_ROUTE_ID_CHARS);
/** Opaque pairing-device selector used only by the relay control plane. */
export const RelayDeviceIdSchema = opaqueId("deviceId", MAX_RELAY_DEVICE_ID_CHARS);
/** Route ticket; deliberately distinct from PairingPayload.token (the E2E token). */
export const RelayTokenSchema = opaqueId("relay token", MAX_RELAY_TOKEN_CHARS);
export const RelayStreamIdSchema = opaqueId("streamId", MAX_RELAY_STREAM_ID_CHARS);

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
 * fragments, or query strings: relay tickets belong in the first control frame.
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

const relayVersion = z.literal(RELAY_PROTOCOL_VERSION);

/** Host → relay: keep this route available for paired clients. */
export const RelayHostRegisterSchema = z
  .object({
    type: z.literal("host.register"),
    v: relayVersion,
    routeId: RelayRouteIdSchema,
    deviceId: RelayDeviceIdSchema,
    token: RelayTokenSchema,
  })
  .strict();

/** Relay → host acknowledgement for a registered route. */
export const RelayHostReadySchema = z
  .object({
    type: z.literal("host.ready"),
    v: relayVersion,
    routeId: RelayRouteIdSchema,
  })
  .strict();

/** Client → relay: request a stream to an already registered host route. */
export const RelayClientConnectSchema = z
  .object({
    type: z.literal("client.connect"),
    v: relayVersion,
    routeId: RelayRouteIdSchema,
    deviceId: RelayDeviceIdSchema,
    token: RelayTokenSchema,
  })
  .strict();

/** Relay → client acknowledgement; the following bytes use this stream. */
export const RelayClientConnectedSchema = z
  .object({
    type: z.literal("client.connected"),
    v: relayVersion,
    streamId: RelayStreamIdSchema,
  })
  .strict();

/** Relay → host: a client stream is ready; following bytes are opaque E2E frames. */
export const RelayStreamOpenSchema = z
  .object({
    type: z.literal("stream.open"),
    v: relayVersion,
    streamId: RelayStreamIdSchema,
  })
  .strict();

export const RelayStreamCloseCodeSchema = z.enum([
  "normal",
  "peer_closed",
  "idle_timeout",
  "relay_shutdown",
]);

/** Either peer or relay may close a stream; no application payload belongs here. */
export const RelayStreamCloseSchema = z
  .object({
    type: z.literal("stream.close"),
    v: relayVersion,
    streamId: RelayStreamIdSchema,
    code: RelayStreamCloseCodeSchema,
  })
  .strict();

/** Stable, non-sensitive errors for relay control frames. */
export const RelayErrorCodeSchema = z.enum([
  "bad_frame",
  "unsupported_version",
  "unauthorized",
  "route_not_found",
  "route_unavailable",
  "stream_not_found",
  "rate_limited",
  "internal",
]);

export const RelayErrorMessageSchema = z
  .object({
    type: z.literal("error"),
    v: relayVersion,
    code: RelayErrorCodeSchema,
    message: z.string().min(1).max(MAX_RELAY_ERROR_MESSAGE_CHARS),
    retryAfterMs: z.number().int().min(0).max(86_400_000).optional(),
  })
  .strict();

/** Control messages categorized by the endpoint they establish. */
export const RelayHostControlMessageSchema = z.discriminatedUnion("type", [
  RelayHostRegisterSchema,
  RelayHostReadySchema,
]);
export const RelayClientControlMessageSchema = z.discriminatedUnion("type", [
  RelayClientConnectSchema,
  RelayClientConnectedSchema,
]);
export const RelayStreamControlMessageSchema = z.discriminatedUnion("type", [
  RelayStreamOpenSchema,
  RelayStreamCloseSchema,
]);
export const RelayControlMessageSchema = z.discriminatedUnion("type", [
  RelayHostRegisterSchema,
  RelayHostReadySchema,
  RelayClientConnectSchema,
  RelayClientConnectedSchema,
  RelayStreamOpenSchema,
  RelayStreamCloseSchema,
  RelayErrorMessageSchema,
]);

export type RelayPairing = z.infer<typeof RelayPairingSchema>;
export type RelayHostControlMessage = z.infer<typeof RelayHostControlMessageSchema>;
export type RelayClientControlMessage = z.infer<typeof RelayClientControlMessageSchema>;
export type RelayStreamControlMessage = z.infer<typeof RelayStreamControlMessageSchema>;
export type RelayControlMessage = z.infer<typeof RelayControlMessageSchema>;
export type RelayErrorCode = z.infer<typeof RelayErrorCodeSchema>;
export type RelayStreamCloseCode = z.infer<typeof RelayStreamCloseCodeSchema>;

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
  if (utf8Encode(encoded).length > MAX_RELAY_CONTROL_FRAME_BYTES) {
    throw new ProtocolError("relay control frame exceeds maximum size", "format");
  }
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
