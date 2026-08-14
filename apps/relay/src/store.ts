import { createPool, type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { createClient, type RedisClientType } from "redis";
import { equalCredentialDigest } from "./crypto.js";
import type {
  AuthenticatedDevice,
  DeviceRecord,
  RelayEvent,
  RouteInspection,
  RouteRecord,
  RouteSnapshot,
  StreamTicket,
} from "./types.js";

export type SnapshotCredential =
  | { deviceId: string; credentialDigest: string; revoked?: false | undefined }
  | { deviceId: string; revoked: true };

export interface RouteStore {
  ping(): Promise<void>;
  close(): Promise<void>;
  createRoute(routeId: string): Promise<void>;
  /** Creates an anonymous route on first valid host-secret authentication. */
  ensureRoute(routeId: string): Promise<RouteRecord | null>;
  applyDeviceSnapshot(routeId: string, generation: number, credentials: SnapshotCredential[]): Promise<RouteSnapshot | null>;
  authenticate(routeId: string, deviceId: string, token: string): Promise<AuthenticatedDevice | null>;
  inspectRoute(routeId: string): Promise<RouteInspection | null>;
  disableRoute(routeId: string): Promise<boolean>;
  enableRoute(routeId: string): Promise<boolean>;
  cleanupInactiveRoutes(olderThan: Date): Promise<number>;
}

export interface EphemeralStore {
  ping(): Promise<void>;
  close(): Promise<void>;
  cacheCredential(device: DeviceRecord, disabledAt: Date | null, ttlSeconds: number): Promise<void>;
  getCachedCredential(routeId: string, deviceId: string): Promise<{ device: DeviceRecord; disabledAt: Date | null } | null>;
  setPresence(routeId: string, connectionId: string, ttlSeconds: number): Promise<void>;
  clearPresence(routeId: string, connectionId: string): Promise<void>;
  createTicket(ticket: StreamTicket, ttlSeconds: number): Promise<void>;
  consumeTicket(ticket: string): Promise<StreamTicket | null>;
  consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
  publish(event: RelayEvent): Promise<void>;
  subscribe(listener: (event: RelayEvent) => void): Promise<() => Promise<void>>;
}

interface RouteRow extends RowDataPacket {
  route_id: string;
  generation: number;
  disabled_at: Date | null;
  created_at: Date;
  last_seen_at: Date | null;
}

interface DeviceRow extends RowDataPacket {
  route_id: string;
  device_id: string;
  credential_digest: Buffer | null;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

function routeFromRow(row: RouteRow): RouteRecord {
  return { routeId: row.route_id, generation: row.generation, disabledAt: row.disabled_at, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
}

function deviceFromRow(row: DeviceRow): DeviceRecord {
  return {
    routeId: row.route_id,
    deviceId: row.device_id,
    credentialDigest: row.credential_digest === null ? null : Buffer.from(row.credential_digest),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

function normalize(credentials: SnapshotCredential[]): Array<{ deviceId: string; digest: Buffer | null; revoked: boolean }> {
  return credentials.map((credential) => ({
    deviceId: credential.deviceId,
    digest: credential.revoked === true ? null : Buffer.from(credential.credentialDigest, "base64url"),
    revoked: credential.revoked === true,
  })).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

function snapshotEquals(current: DeviceRecord[], credentials: SnapshotCredential[]): boolean {
  const wanted = normalize(credentials);
  const present = current.map((device) => ({
    deviceId: device.deviceId,
    digest: device.credentialDigest,
    revoked: device.revokedAt !== null,
  })).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  if (present.length !== wanted.length) return false;
  return present.every((device, index) => {
    const other = wanted[index]!;
    return device.deviceId === other.deviceId && device.revoked === other.revoked &&
      ((device.digest === null && other.digest === null) || (device.digest !== null && other.digest !== null && device.digest.equals(other.digest)));
  });
}

export class MySqlRouteStore implements RouteStore {
  readonly pool: Pool;

  constructor(mysqlUrl: string) {
    this.pool = createPool({ uri: mysqlUrl, connectionLimit: 12, enableKeepAlive: true, timezone: "Z" });
  }

  async ping(): Promise<void> { await this.pool.query("SELECT 1"); }
  async close(): Promise<void> { await this.pool.end(); }

  async createRoute(routeId: string): Promise<void> {
    await this.pool.execute("INSERT INTO routes (route_id) VALUES (?)", [routeId]);
  }

  async ensureRoute(routeId: string): Promise<RouteRecord | null> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("INSERT INTO routes (route_id) VALUES (?) ON DUPLICATE KEY UPDATE route_id = VALUES(route_id)", [routeId]);
      const [rows] = await connection.execute<RouteRow[]>("SELECT route_id, generation, disabled_at, created_at, last_seen_at FROM routes WHERE route_id = ? FOR UPDATE", [routeId]);
      const row = rows[0];
      if (row === undefined || row.disabled_at !== null) {
        await connection.rollback();
        return null;
      }
      await connection.execute("UPDATE routes SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE route_id = ?", [routeId]);
      await connection.commit();
      return { ...routeFromRow(row), lastSeenAt: new Date() };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async applyDeviceSnapshot(routeId: string, generation: number, credentials: SnapshotCredential[]): Promise<RouteSnapshot | null> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [routes] = await connection.execute<RouteRow[]>("SELECT route_id, generation, disabled_at, created_at, last_seen_at FROM routes WHERE route_id = ? FOR UPDATE", [routeId]);
      const routeRow = routes[0];
      if (routeRow === undefined || routeRow.disabled_at !== null) {
        await connection.rollback();
        return null;
      }
      const [existingRows] = await connection.execute<DeviceRow[]>("SELECT route_id, device_id, credential_digest, created_at, last_seen_at, revoked_at FROM devices WHERE route_id = ? FOR UPDATE", [routeId]);
      const existing = existingRows.map(deviceFromRow);
      if (generation < routeRow.generation || (generation === routeRow.generation && !snapshotEquals(existing, credentials))) {
        await connection.rollback();
        throw new Error("stale or inconsistent device snapshot generation");
      }
      if (generation > routeRow.generation) {
        // Full replacement: absent entries are revoked, and explicit revocations are retained.
        await connection.execute("UPDATE devices SET revoked_at = CURRENT_TIMESTAMP(3) WHERE route_id = ? AND revoked_at IS NULL", [routeId]);
        for (const credential of normalize(credentials)) {
          if (credential.revoked) {
            await connection.execute(
              `INSERT INTO devices (route_id, device_id, credential_digest, revoked_at)
               VALUES (?, ?, NULL, CURRENT_TIMESTAMP(3))
               ON DUPLICATE KEY UPDATE credential_digest = NULL, revoked_at = CURRENT_TIMESTAMP(3)`,
              [routeId, credential.deviceId],
            );
          } else {
            await connection.execute(
              `INSERT INTO devices (route_id, device_id, credential_digest, revoked_at)
               VALUES (?, ?, ?, NULL)
               ON DUPLICATE KEY UPDATE credential_digest = VALUES(credential_digest), revoked_at = NULL`,
              [routeId, credential.deviceId, credential.digest],
            );
          }
        }
        await connection.execute("UPDATE routes SET generation = ?, last_seen_at = CURRENT_TIMESTAMP(3) WHERE route_id = ?", [generation, routeId]);
      } else {
        await connection.execute("UPDATE routes SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE route_id = ?", [routeId]);
      }
      const [allRows] = await connection.execute<DeviceRow[]>("SELECT route_id, device_id, credential_digest, created_at, last_seen_at, revoked_at FROM devices WHERE route_id = ?", [routeId]);
      await connection.commit();
      return {
        route: { ...routeFromRow(routeRow), generation, lastSeenAt: new Date() },
        devices: allRows.map(deviceFromRow),
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async authenticate(routeId: string, deviceId: string, token: string): Promise<AuthenticatedDevice | null> {
    const [rows] = await this.pool.execute<(RouteRow & DeviceRow)[]>(
      `SELECT r.route_id, r.generation, r.disabled_at, r.created_at, r.last_seen_at,
              d.device_id, d.credential_digest, d.created_at AS device_created_at,
              d.last_seen_at AS device_last_seen_at, d.revoked_at
       FROM routes r JOIN devices d ON d.route_id = r.route_id
       WHERE r.route_id = ? AND d.device_id = ? LIMIT 1`,
      [routeId, deviceId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const route = routeFromRow(row);
    const device: DeviceRecord = {
      routeId: row.route_id, deviceId: row.device_id,
      credentialDigest: row.credential_digest === null ? null : Buffer.from(row.credential_digest),
      createdAt: row.device_created_at, lastSeenAt: row.device_last_seen_at, revokedAt: row.revoked_at,
    };
    if (route.disabledAt !== null || device.revokedAt !== null || !equalCredentialDigest(device.credentialDigest, token)) return null;
    await this.pool.execute("UPDATE devices d JOIN routes r ON r.route_id = d.route_id SET d.last_seen_at = CURRENT_TIMESTAMP(3), r.last_seen_at = CURRENT_TIMESTAMP(3) WHERE d.route_id = ? AND d.device_id = ?", [routeId, deviceId]);
    return { route: { ...route, lastSeenAt: new Date() }, device: { ...device, lastSeenAt: new Date() } };
  }

  async inspectRoute(routeId: string): Promise<RouteInspection | null> {
    const [routes] = await this.pool.execute<RouteRow[]>("SELECT route_id, generation, disabled_at, created_at, last_seen_at FROM routes WHERE route_id = ?", [routeId]);
    const route = routes[0];
    if (route === undefined) return null;
    const [devices] = await this.pool.execute<DeviceRow[]>("SELECT route_id, device_id, credential_digest, created_at, last_seen_at, revoked_at FROM devices WHERE route_id = ? ORDER BY created_at ASC", [routeId]);
    return {
      ...routeFromRow(route),
      devices: devices.map((device) => ({ routeId: device.route_id, deviceId: device.device_id, createdAt: device.created_at, lastSeenAt: device.last_seen_at, revokedAt: device.revoked_at })),
    };
  }

  async disableRoute(routeId: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>("UPDATE routes SET disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP(3)) WHERE route_id = ?", [routeId]);
    return result.affectedRows > 0;
  }

  async enableRoute(routeId: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>("UPDATE routes SET disabled_at = NULL WHERE route_id = ?", [routeId]);
    return result.affectedRows > 0;
  }

  async cleanupInactiveRoutes(olderThan: Date): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>("DELETE FROM routes WHERE disabled_at IS NULL AND COALESCE(last_seen_at, created_at) < ?", [olderThan]);
    return result.affectedRows;
  }
}

interface CachedCredential {
  device: { routeId: string; deviceId: string; credentialDigest: string | null; createdAt: string; lastSeenAt: string | null; revokedAt: string | null };
  disabledAt: string | null;
}

function encodeDevice(device: DeviceRecord, disabledAt: Date | null): string {
  return JSON.stringify({
    device: { routeId: device.routeId, deviceId: device.deviceId, credentialDigest: device.credentialDigest?.toString("base64") ?? null, createdAt: device.createdAt.toISOString(), lastSeenAt: device.lastSeenAt?.toISOString() ?? null, revokedAt: device.revokedAt?.toISOString() ?? null },
    disabledAt: disabledAt?.toISOString() ?? null,
  } satisfies CachedCredential);
}

function decodeDevice(value: string): { device: DeviceRecord; disabledAt: Date | null } | null {
  try {
    const parsed = JSON.parse(value) as CachedCredential;
    if (typeof parsed.device?.routeId !== "string" || typeof parsed.device.deviceId !== "string") return null;
    return { device: { routeId: parsed.device.routeId, deviceId: parsed.device.deviceId, credentialDigest: parsed.device.credentialDigest === null ? null : Buffer.from(parsed.device.credentialDigest, "base64"), createdAt: new Date(parsed.device.createdAt), lastSeenAt: parsed.device.lastSeenAt === null ? null : new Date(parsed.device.lastSeenAt), revokedAt: parsed.device.revokedAt === null ? null : new Date(parsed.device.revokedAt) }, disabledAt: parsed.disabledAt === null ? null : new Date(parsed.disabledAt) };
  } catch { return null; }
}

const EVENT_CHANNEL = "prospero:relay:events:v1";

export class RedisEphemeralStore implements EphemeralStore {
  private readonly client: RedisClientType;
  private subscriber: RedisClientType | undefined;
  constructor(redisUrl: string) { this.client = createClient({ url: redisUrl }); this.client.on("error", () => undefined); }
  private async ready(): Promise<void> { if (!this.client.isOpen) await this.client.connect(); }
  async ping(): Promise<void> { await this.ready(); await this.client.ping(); }
  async close(): Promise<void> { if (this.subscriber?.isOpen) await this.subscriber.quit(); if (this.client.isOpen) await this.client.quit(); }
  async cacheCredential(device: DeviceRecord, disabledAt: Date | null, ttlSeconds: number): Promise<void> { await this.ready(); await this.client.set(`credential:${device.routeId}:${device.deviceId}`, encodeDevice(device, disabledAt), { EX: ttlSeconds }); }
  async getCachedCredential(routeId: string, deviceId: string): Promise<{ device: DeviceRecord; disabledAt: Date | null } | null> { await this.ready(); const value = await this.client.get(`credential:${routeId}:${deviceId}`); return value === null ? null : decodeDevice(value); }
  async setPresence(routeId: string, connectionId: string, ttlSeconds: number): Promise<void> { await this.ready(); await this.client.set(`presence:${routeId}`, connectionId, { EX: ttlSeconds }); }
  async clearPresence(routeId: string, connectionId: string): Promise<void> { await this.ready(); if (await this.client.get(`presence:${routeId}`) === connectionId) await this.client.del(`presence:${routeId}`); }
  async createTicket(ticket: StreamTicket, ttlSeconds: number): Promise<void> { await this.ready(); const stored = await this.client.set(`ticket:${ticket.ticket}`, JSON.stringify(ticket), { EX: ttlSeconds, NX: true }); if (stored !== "OK") throw new Error("stream ticket collision"); }
  async consumeTicket(ticket: string): Promise<StreamTicket | null> { await this.ready(); const value = await this.client.getDel(`ticket:${ticket}`); if (value === null) return null; try { return JSON.parse(value) as StreamTicket; } catch { return null; } }
  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfterMs: number }> { await this.ready(); const tx = this.client.multi(); tx.incr(key); tx.expire(key, windowSeconds, "NX"); const [count] = await tx.exec(); return { allowed: Number(count) <= limit, retryAfterMs: windowSeconds * 1000 }; }
  async publish(event: RelayEvent): Promise<void> { await this.ready(); await this.client.publish(EVENT_CHANNEL, JSON.stringify(event)); }
  async subscribe(listener: (event: RelayEvent) => void): Promise<() => Promise<void>> { await this.ready(); const subscriber = this.client.duplicate(); subscriber.on("error", () => undefined); await subscriber.connect(); await subscriber.subscribe(EVENT_CHANNEL, (message) => { try { const event = JSON.parse(message) as RelayEvent; if (event && typeof event.type === "string" && typeof event.routeId === "string") listener(event); } catch { /* ignore malformed pub/sub */ } }); this.subscriber = subscriber; return async () => { if (subscriber.isOpen) await subscriber.quit(); if (this.subscriber === subscriber) this.subscriber = undefined; }; }
}
