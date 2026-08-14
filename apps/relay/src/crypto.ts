import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  deriveRelayDeviceCredentialDigest,
  deriveRelayRouteId,
  relayRouteIdMatchesHostSecret,
} from "@prospero/protocol";

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
