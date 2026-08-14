import { equalDigest, tokenDigest } from "../src/crypto.js";
import type { EphemeralStore, RouteStore } from "../src/store.js";
import type {
  AuthenticatedDevice,
  DeviceRecord,
  DeviceRole,
  RelayEvent,
  RouteInspection,
  RouteRecord,
  RouteSnapshot,
  StreamTicket,
} from "../src/types.js";

function copyDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value);
}

function cloneRoute(route: RouteRecord): RouteRecord {
  return { ...route, disabledAt: copyDate(route.disabledAt), createdAt: new Date(route.createdAt), lastSeenAt: copyDate(route.lastSeenAt) };
}

function cloneDevice(device: DeviceRecord): DeviceRecord {
  return {
    ...device,
    tokenDigest: Buffer.from(device.tokenDigest),
    createdAt: new Date(device.createdAt),
    lastSeenAt: copyDate(device.lastSeenAt),
    revokedAt: copyDate(device.revokedAt),
  };
}

export class MemoryRouteStore implements RouteStore {
  available = true;
  readonly routes = new Map<string, RouteRecord>();
  readonly devices = new Map<string, Map<string, DeviceRecord>>();

  private ensure(): void {
    if (!this.available) throw new Error("mysql unavailable");
  }

  async ping(): Promise<void> { this.ensure(); }
  async close(): Promise<void> {}

  async createRoute(routeId: string, hostDeviceId: string, hostToken: string): Promise<void> {
    this.ensure();
    if (this.routes.has(routeId)) throw new Error("duplicate route");
    const now = new Date();
    this.routes.set(routeId, { routeId, disabledAt: null, createdAt: now, lastSeenAt: null });
    this.devices.set(routeId, new Map([[hostDeviceId, { routeId, deviceId: hostDeviceId, role: "host", tokenDigest: tokenDigest(hostToken), createdAt: now, lastSeenAt: null, revokedAt: null }]]));
  }

  async addDevice(routeId: string, deviceId: string, token: string, role: DeviceRole = "client"): Promise<void> {
    this.ensure();
    const devices = this.devices.get(routeId);
    if (devices === undefined) throw new Error("route not found");
    if (devices.has(deviceId)) throw new Error("duplicate device");
    devices.set(deviceId, { routeId, deviceId, role, tokenDigest: tokenDigest(token), createdAt: new Date(), lastSeenAt: null, revokedAt: null });
  }

  async authenticate(routeId: string, deviceId: string, token: string, role?: DeviceRole): Promise<AuthenticatedDevice | null> {
    this.ensure();
    const route = this.routes.get(routeId);
    const device = this.devices.get(routeId)?.get(deviceId);
    if (route === undefined || device === undefined || route.disabledAt !== null || device.revokedAt !== null || (role !== undefined && role !== device.role) || !equalDigest(device.tokenDigest, token)) return null;
    const now = new Date();
    route.lastSeenAt = now;
    device.lastSeenAt = now;
    return { route: cloneRoute(route), device: cloneDevice(device) };
  }

  async registerHost(routeId: string, deviceId: string, token: string): Promise<RouteSnapshot | null> {
    const auth = await this.authenticate(routeId, deviceId, token, "host");
    if (auth === null) return null;
    const devices = [...(this.devices.get(routeId)?.values() ?? [])].filter((device) => device.revokedAt === null).map(cloneDevice);
    return { ...auth, devices };
  }

  async inspectRoute(routeId: string): Promise<RouteInspection | null> {
    this.ensure();
    const route = this.routes.get(routeId);
    if (route === undefined) return null;
    return {
      ...cloneRoute(route),
      devices: [...(this.devices.get(routeId)?.values() ?? [])].map(({ tokenDigest: _tokenDigest, ...device }) => ({ ...device, createdAt: new Date(device.createdAt), lastSeenAt: copyDate(device.lastSeenAt), revokedAt: copyDate(device.revokedAt) })),
    };
  }

  async disableRoute(routeId: string): Promise<boolean> {
    this.ensure();
    const route = this.routes.get(routeId);
    if (route === undefined) return false;
    route.disabledAt ??= new Date();
    return true;
  }

  async enableRoute(routeId: string): Promise<boolean> {
    this.ensure();
    const route = this.routes.get(routeId);
    if (route === undefined) return false;
    route.disabledAt = null;
    return true;
  }

  async revokeDevice(routeId: string, deviceId: string): Promise<boolean> {
    this.ensure();
    const device = this.devices.get(routeId)?.get(deviceId);
    if (device === undefined) return false;
    device.revokedAt ??= new Date();
    return true;
  }

  async cleanupInactiveRoutes(olderThan: Date): Promise<number> {
    this.ensure();
    let count = 0;
    for (const [id, route] of this.routes) {
      if (route.disabledAt === null && (route.lastSeenAt ?? route.createdAt) < olderThan) {
        this.routes.delete(id);
        this.devices.delete(id);
        count += 1;
      }
    }
    return count;
  }
}

export class MemoryEphemeralStore implements EphemeralStore {
  available = true;
  readonly cached = new Map<string, { device: DeviceRecord; disabledAt: Date | null }>();
  readonly presence = new Map<string, string>();
  readonly tickets = new Map<string, StreamTicket>();
  readonly listeners = new Set<(event: RelayEvent) => void>();
  limitAllowed = true;

  private ensure(): void { if (!this.available) throw new Error("redis unavailable"); }
  async ping(): Promise<void> { this.ensure(); }
  async close(): Promise<void> {}
  async cacheCredential(device: DeviceRecord, disabledAt: Date | null, _ttlSeconds: number): Promise<void> { this.ensure(); this.cached.set(`${device.routeId}:${device.deviceId}`, { device: cloneDevice(device), disabledAt: copyDate(disabledAt) }); }
  async getCachedCredential(routeId: string, deviceId: string): Promise<{ device: DeviceRecord; disabledAt: Date | null } | null> { this.ensure(); const item = this.cached.get(`${routeId}:${deviceId}`); return item === undefined ? null : { device: cloneDevice(item.device), disabledAt: copyDate(item.disabledAt) }; }
  async setPresence(routeId: string, connectionId: string, _ttlSeconds: number): Promise<void> { this.ensure(); this.presence.set(routeId, connectionId); }
  async clearPresence(routeId: string, connectionId: string): Promise<void> { this.ensure(); if (this.presence.get(routeId) === connectionId) this.presence.delete(routeId); }
  async createTicket(ticket: StreamTicket, _ttlSeconds: number): Promise<void> { this.ensure(); if (this.tickets.has(ticket.streamId)) throw new Error("ticket collision"); this.tickets.set(ticket.streamId, { ...ticket }); }
  async consumeTicket(streamId: string): Promise<StreamTicket | null> { this.ensure(); const ticket = this.tickets.get(streamId); this.tickets.delete(streamId); return ticket === undefined ? null : { ...ticket }; }
  async consumeRateLimit(_key: string, _limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfterMs: number }> { this.ensure(); return { allowed: this.limitAllowed, retryAfterMs: windowSeconds * 1000 }; }
  async publish(event: RelayEvent): Promise<void> { this.ensure(); for (const listener of this.listeners) listener(event); }
  async subscribe(listener: (event: RelayEvent) => void): Promise<() => Promise<void>> { this.ensure(); this.listeners.add(listener); return async () => { this.listeners.delete(listener); }; }
}
