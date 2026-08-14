import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ROUTE_DOMAIN = Buffer.from("prospero.relay.route.v1\\0", "utf8");

export function randomOpaque(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function equalDigest(actual: Buffer, candidateToken: string): boolean {
  const candidate = tokenDigest(candidateToken);
  return actual.length === candidate.length && timingSafeEqual(actual, candidate);
}

/** route IDs are deterministic selectors, while host secrets never leave the host/admin ceremony. */
export function deriveRouteId(hostSecret: Buffer): string {
  if (hostSecret.length !== 32) throw new Error("hostSecret must contain exactly 32 bytes");
  return createHash("sha256").update(ROUTE_DOMAIN).update(hostSecret).digest("base64url");
}

export function opaqueLogId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}
