import { credentialDigest, equalCredentialDigest, streamTicketStorageKey } from "../src/crypto.js";
import { SnapshotGenerationError, snapshotEquals, type EphemeralStore, type RouteStore, type SnapshotCredential, type TicketRedemption } from "../src/store.js";
import type { AuthenticatedDevice, DeviceRecord, RelayEvent, RouteInspection, RouteRecord, RouteSnapshot, StreamTicket } from "../src/types.js";

const copyDate = (value: Date | null): Date | null => value === null ? null : new Date(value);
const cloneRoute = (route: RouteRecord): RouteRecord => ({ ...route, disabledAt: copyDate(route.disabledAt), createdAt: new Date(route.createdAt), lastSeenAt: copyDate(route.lastSeenAt) });
const cloneDevice = (device: DeviceRecord): DeviceRecord => ({ ...device, credentialDigest: device.credentialDigest === null ? null : Buffer.from(device.credentialDigest), createdAt: new Date(device.createdAt), lastSeenAt: copyDate(device.lastSeenAt), revokedAt: copyDate(device.revokedAt) });

export class MemoryRouteStore implements RouteStore {
  available = true;
  readonly routes = new Map<string, RouteRecord>();
  readonly devices = new Map<string, Map<string, DeviceRecord>>();
  private ensure(): void { if (!this.available) throw new Error("mysql unavailable"); }
  async ping(): Promise<void> { this.ensure(); }
  async close(): Promise<void> {}
  async createRoute(routeId: string): Promise<void> { this.ensure(); if (this.routes.has(routeId)) throw new Error("duplicate route"); const now = new Date(); this.routes.set(routeId, { routeId, generation: 0, disabledAt: null, createdAt: now, lastSeenAt: null }); this.devices.set(routeId, new Map()); }
  async ensureRoute(routeId: string): Promise<RouteRecord | null> { this.ensure(); if (!this.routes.has(routeId)) await this.createRoute(routeId); const route = this.routes.get(routeId)!; if (route.disabledAt !== null) return null; route.lastSeenAt = new Date(); return cloneRoute(route); }
  async applyDeviceSnapshot(routeId: string, generation: number, credentials: SnapshotCredential[]): Promise<RouteSnapshot | null> {
    this.ensure(); const route = this.routes.get(routeId); if (route === undefined || route.disabledAt !== null) return null;
    const devices = this.devices.get(routeId)!;
    if (generation < route.generation || (generation === route.generation && !snapshotEquals([...devices.values()], credentials))) throw new SnapshotGenerationError();
    if (generation > route.generation) {
      for (const device of devices.values()) if (device.revokedAt === null) device.revokedAt = new Date();
      for (const item of credentials) {
        const old = devices.get(item.deviceId); const now = new Date();
        devices.set(item.deviceId, { routeId, deviceId: item.deviceId, credentialDigest: item.revoked === true ? null : Buffer.from(item.credentialDigest, "base64url"), createdAt: old?.createdAt ?? now, lastSeenAt: old?.lastSeenAt ?? null, revokedAt: item.revoked === true ? now : null });
      }
      route.generation = generation;
    }
    route.lastSeenAt = new Date();
    return { route: cloneRoute(route), devices: [...devices.values()].map(cloneDevice) };
  }
  async authenticate(routeId: string, deviceId: string, token: string): Promise<AuthenticatedDevice | null> { this.ensure(); const route = this.routes.get(routeId); const device = this.devices.get(routeId)?.get(deviceId); if (route === undefined || device === undefined || route.disabledAt !== null || device.revokedAt !== null || !equalCredentialDigest(device.credentialDigest, token)) return null; const now = new Date(); route.lastSeenAt = now; device.lastSeenAt = now; return { route: cloneRoute(route), device: cloneDevice(device) }; }
  async inspectRoute(routeId: string): Promise<RouteInspection | null> { this.ensure(); const route = this.routes.get(routeId); if (route === undefined) return null; return { ...cloneRoute(route), devices: [...this.devices.get(routeId)!.values()].map(({ credentialDigest: _digest, ...device }) => ({ ...device, createdAt: new Date(device.createdAt), lastSeenAt: copyDate(device.lastSeenAt), revokedAt: copyDate(device.revokedAt) })) }; }
  async disableRoute(routeId: string): Promise<boolean> { this.ensure(); const route = this.routes.get(routeId); if (route === undefined) return false; route.disabledAt ??= new Date(); return true; }
  async enableRoute(routeId: string): Promise<boolean> { this.ensure(); const route = this.routes.get(routeId); if (route === undefined) return false; route.disabledAt = null; return true; }
  async cleanupInactiveRoutes(olderThan: Date): Promise<number> { this.ensure(); let count = 0; for (const [id, route] of this.routes) if (route.disabledAt === null && (route.lastSeenAt ?? route.createdAt) < olderThan) { this.routes.delete(id); this.devices.delete(id); count += 1; } return count; }
}

export class MemoryEphemeralStore implements EphemeralStore {
  available = true; limitAllowed = true;
  readonly cached = new Map<string, { device: DeviceRecord; disabledAt: Date | null }>();
  readonly presence = new Map<string, string>(); readonly tickets = new Map<string, Omit<StreamTicket, "ticket">>(); readonly ticketStates = new Map<string, "active" | "used" | "expired" | "invalid">(); readonly leases = new Map<string, Map<string, number>>(); readonly listeners = new Set<(event: RelayEvent) => void>();
  private ensure(): void { if (!this.available) throw new Error("redis unavailable"); }
  async ping(): Promise<void> { this.ensure(); } async close(): Promise<void> {}
  async cacheCredential(device: DeviceRecord, disabledAt: Date | null, _ttl: number): Promise<void> { this.ensure(); this.cached.set(`${device.routeId}:${device.deviceId}`, { device: cloneDevice(device), disabledAt: copyDate(disabledAt) }); }
  async getCachedCredential(routeId: string, deviceId: string): Promise<{ device: DeviceRecord; disabledAt: Date | null } | null> { this.ensure(); const item = this.cached.get(`${routeId}:${deviceId}`); return item === undefined ? null : { device: cloneDevice(item.device), disabledAt: copyDate(item.disabledAt) }; }
  async setPresence(routeId: string, connectionId: string, _ttl: number): Promise<void> { this.ensure(); this.presence.set(routeId, connectionId); }
  async clearPresence(routeId: string, connectionId: string): Promise<void> { this.ensure(); if (this.presence.get(routeId) === connectionId) this.presence.delete(routeId); }
  async createTicket(ticket: StreamTicket): Promise<void> { this.ensure(); const key = streamTicketStorageKey(ticket.ticket); if (ticket.expiresAt <= Date.now() || this.tickets.has(key) || this.ticketStates.has(key)) throw new Error("collision or expired ticket"); const { ticket: _ticket, ...stored } = ticket; this.tickets.set(key, stored); this.ticketStates.set(key, "active"); }
  async redeemTicket(ticket: string, streamId: string): Promise<TicketRedemption> {
    this.ensure(); const key = streamTicketStorageKey(ticket); const value = this.tickets.get(key);
    if (value === undefined) { const state = this.ticketStates.get(key); if (state === "used") return { status: "used" }; if (state === "active" || state === "expired") { this.ticketStates.set(key, "expired"); return { status: "expired" }; } return { status: "invalid" }; }
    if (value.streamId !== streamId) return { status: "invalid" };
    if (value.expiresAt <= Date.now()) { this.tickets.delete(key); this.ticketStates.set(key, "expired"); return { status: "expired" }; }
    this.tickets.delete(key); this.ticketStates.set(key, "used"); return { status: "ok", ticket: { ...value, ticket } };
  }
  async invalidateTicket(ticket: string): Promise<void> { this.ensure(); const key = streamTicketStorageKey(ticket); this.tickets.delete(key); this.ticketStates.set(key, "invalid"); }
  private pruneLeases(routeId: string): Map<string, number> { const leases = this.leases.get(routeId) ?? new Map<string, number>(); const now = Date.now(); for (const [id, expiresAt] of leases) if (expiresAt <= now) leases.delete(id); if (leases.size > 0) this.leases.set(routeId, leases); else this.leases.delete(routeId); return leases; }
  async acquireStreamLease(routeId: string, leaseId: string, limit: number, ttlMs: number): Promise<boolean> { this.ensure(); const leases = this.pruneLeases(routeId); if (!leases.has(leaseId) && leases.size >= limit) return false; leases.set(leaseId, Date.now() + ttlMs); this.leases.set(routeId, leases); return true; }
  async renewStreamLease(routeId: string, leaseId: string, ttlMs: number): Promise<boolean> { this.ensure(); const leases = this.pruneLeases(routeId); if (!leases.has(leaseId)) return false; leases.set(leaseId, Date.now() + ttlMs); return true; }
  async releaseStreamLease(routeId: string, leaseId: string): Promise<void> { this.ensure(); const leases = this.pruneLeases(routeId); leases.delete(leaseId); if (leases.size === 0) this.leases.delete(routeId); }
  async consumeRateLimit(_key: string, _limit: number, seconds: number): Promise<{ allowed: boolean; retryAfterMs: number }> { this.ensure(); return { allowed: this.limitAllowed, retryAfterMs: seconds * 1000 }; }
  async publish(event: RelayEvent): Promise<void> { this.ensure(); for (const listener of this.listeners) listener(event); }
  async subscribe(listener: (event: RelayEvent) => void): Promise<() => Promise<void>> { this.ensure(); this.listeners.add(listener); return async () => { this.listeners.delete(listener); }; }
}

export function activeCredential(deviceId: string, token: string): SnapshotCredential { return { deviceId, credentialDigest: credentialDigest(token).toString("base64url") }; }
