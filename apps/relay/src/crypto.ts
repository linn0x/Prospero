import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  deriveRelayDeviceCredentialDigest,
  deriveRelayRouteId,
  relayRouteIdMatchesHostSecret,
} from "@prospero/protocol";

/**
 * Redis must not retain the one-time bearer ticket itself in either a key or
 * a value (AOF/RDB backups are persistence too).  This identifier is only an
 * internal lookup key, so it gets a separate domain from route and device
 * credentials.
 */
const STREAM_TICKET_STORAGE_DOMAIN = "prospero.relay.v1.stream-ticket-storage\0";

export function randomOpaque(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/** T1's domain-separated digest, stored as its raw 32-byte form in MySQL/Redis. */
export function credentialDigest(token: string): Buffer {
  return Buffer.from(deriveRelayDeviceCredentialDigest(token), "base64url");
}

export function equalCredentialDigest(actual: Buffer | null, candidateToken: string): boolean {
  if (actual === null) return false;
  const candidate = credentialDigest(candidateToken);
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

export function deriveRouteId(hostSecret: Buffer): string {
  if (hostSecret.length !== 32) throw new Error("hostSecret must contain exactly 32 bytes");
  return deriveRelayRouteId(hostSecret.toString("base64url"));
}

export function routeIdMatchesHostSecret(routeId: string, hostSecret: string): boolean {
  return relayRouteIdMatchesHostSecret(routeId, hostSecret);
}

export function opaqueLogId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

export function streamTicketStorageKey(ticket: string): string {
  return createHash("sha256")
    .update(STREAM_TICKET_STORAGE_DOMAIN, "utf8")
    .update(ticket, "utf8")
    .digest("base64url");
}
