import { createPool, type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { createClient, type RedisClientType } from "redis";
import { equalDigest, tokenDigest } from "./crypto.js";
import type {
  AuthenticatedDevice,
  DeviceRecord,
  DeviceRole,
  RelayEvent,
  RouteInspection,
  RouteRecord,
  RouteSnapshot,
  StreamTicket,
} from "./types.js";

export interface RouteStore {
  ping(): Promise<void>;
  close(): Promise<void>;
  createRoute(routeId: string, hostDeviceId: string, hostToken: string): Promise<void>;
  addDevice(routeId: string, deviceId: string, token: string, role?: DeviceRole): Promise<void>;
  authenticate(routeId: string, deviceId: string, token: string, role?: DeviceRole): Promise<AuthenticatedDevice | null>;
  /** Takes a repeatable-read snapshot while verifying the host credential. */
  registerHost(routeId: string, deviceId: string, token: string): Promise<RouteSnapshot | null>;
  inspectRoute(routeId: string): Promise<RouteInspection | null>;
  disableRoute(routeId: string): Promise<boolean>;
  enableRoute(routeId: string): Promise<boolean>;
  revokeDevice(routeId: string, deviceId: string): Promise<boolean>;
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
  consumeTicket(streamId: string): Promise<StreamTicket | null>;
  consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
  publish(event: RelayEvent): Promise<void>;
  subscribe(listener: (event: RelayEvent) => void): Promise<() => Promise<void>>;
}

interface RouteRow extends RowDataPacket {
  route_id: string;
  disabled_at: Date | null;
  created_at: Date;
  last_seen_at: Date | null;
}

interface DeviceRow extends RowDataPacket {
  route_id: string;
  device_id: string;
  role: DeviceRole;
  token_digest: Buffer;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

function routeFromRow(row: RouteRow): RouteRecord {
  return {
    routeId: row.route_id,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function deviceFromRow(row: DeviceRow): DeviceRecord {
  return {
    routeId: row.route_id,
    deviceId: row.device_id,
    role: row.role,
    tokenDigest: Buffer.from(row.token_digest),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export class MySqlRouteStore implements RouteStore {
  readonly pool: Pool;

  constructor(mysqlUrl: string) {
    this.pool = createPool({
      uri: mysqlUrl,
      connectionLimit: 12,
      enableKeepAlive: true,
      decimalNumbers: true,
      timezone: "Z",
    });
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createRoute(routeId: string, hostDeviceId: string, hostToken: string): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("INSERT INTO routes (route_id) VALUES (?)", [routeId]);
      await connection.execute(
        "INSERT INTO devices (route_id, device_id, role, token_digest) VALUES (?, ?, 'host', ?)",
        [routeId, hostDeviceId, tokenDigest(hostToken)],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async addDevice(routeId: string, deviceId: string, token: string, role: DeviceRole = "client"): Promise<void> {
    await this.pool.execute(
      "INSERT INTO devices (route_id, device_id, role, token_digest) VALUES (?, ?, ?, ?)",
      [routeId, deviceId, role, tokenDigest(token)],
    );
  }

  async authenticate(
    routeId: string,
    deviceId: string,
    token: string,
    role?: DeviceRole,
  ): Promise<AuthenticatedDevice | null> {
    const [rows] = await this.pool.execute<(RouteRow & DeviceRow)[]>(
      `SELECT r.route_id, r.disabled_at, r.created_at, r.last_seen_at,
              d.device_id, d.role, d.token_digest, d.created_at AS device_created_at,
              d.last_seen_at AS device_last_seen_at, d.revoked_at
       FROM routes r JOIN devices d ON d.route_id = r.route_id
       WHERE r.route_id = ? AND d.device_id = ? LIMIT 1`,
      [routeId, deviceId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const device: DeviceRecord = {
      routeId: row.route_id,
      deviceId: row.device_id,
      role: row.role,
      tokenDigest: Buffer.from(row.token_digest),
      createdAt: row.device_created_at,
      lastSeenAt: row.device_last_seen_at,
      revokedAt: row.revoked_at,
    };
    const route = routeFromRow(row);
    if (route.disabledAt !== null || device.revokedAt !== null || (role !== undefined && device.role !== role)) {
      return null;
    }
    if (!equalDigest(device.tokenDigest, token)) return null;
    await this.pool.execute(
      "UPDATE devices d JOIN routes r ON r.route_id = d.route_id SET d.last_seen_at = CURRENT_TIMESTAMP(3), r.last_seen_at = CURRENT_TIMESTAMP(3) WHERE d.route_id = ? AND d.device_id = ?",
      [routeId, deviceId],
    );
    return { route, device: { ...device, lastSeenAt: new Date() } };
  }

  async registerHost(routeId: string, deviceId: string, token: string): Promise<RouteSnapshot | null> {
    const connection = await this.pool.getConnection();
    try {
      // A locked consistent snapshot prevents a partially edited device set from becoming live.
      await connection.beginTransaction();
      const [routeRows] = await connection.execute<RouteRow[]>(
        "SELECT route_id, disabled_at, created_at, last_seen_at FROM routes WHERE route_id = ? FOR UPDATE",
        [routeId],
      );
      const routeRow = routeRows[0];
      if (routeRow === undefined || routeRow.disabled_at !== null) {
        await connection.rollback();
        return null;
      }
      const [deviceRows] = await connection.execute<DeviceRow[]>(
        "SELECT route_id, device_id, role, token_digest, created_at, last_seen_at, revoked_at FROM devices WHERE route_id = ? AND device_id = ? FOR UPDATE",
        [routeId, deviceId],
      );
      const deviceRow = deviceRows[0];
      if (
        deviceRow === undefined ||
        deviceRow.role !== "host" ||
        deviceRow.revoked_at !== null ||
        !equalDigest(Buffer.from(deviceRow.token_digest), token)
      ) {
        await connection.rollback();
        return null;
      }
      const [allDeviceRows] = await connection.execute<DeviceRow[]>(
        "SELECT route_id, device_id, role, token_digest, created_at, last_seen_at, revoked_at FROM devices WHERE route_id = ? AND revoked_at IS NULL FOR UPDATE",
        [routeId],
      );
      await connection.execute(
        "UPDATE routes SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE route_id = ?",
        [routeId],
      );
      await connection.execute(
        "UPDATE devices SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE route_id = ? AND device_id = ?",
        [routeId, deviceId],
      );
      await connection.commit();
      const now = new Date();
      return {
        route: { ...routeFromRow(routeRow), lastSeenAt: now },
        device: { ...deviceFromRow(deviceRow), lastSeenAt: now },
        devices: allDeviceRows.map((item) => deviceFromRow(item)),
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async inspectRoute(routeId: string): Promise<RouteInspection | null> {
    const [routes] = await this.pool.execute<RouteRow[]>(
      "SELECT route_id, disabled_at, created_at, last_seen_at FROM routes WHERE route_id = ?",
      [routeId],
    );
    const route = routes[0];
    if (route === undefined) return null;
    const [devices] = await this.pool.execute<DeviceRow[]>(
      "SELECT route_id, device_id, role, token_digest, created_at, last_seen_at, revoked_at FROM devices WHERE route_id = ? ORDER BY created_at ASC",
      [routeId],
    );
    return {
      ...routeFromRow(route),
      devices: devices.map(({ token_digest: _digest, ...device }) => ({
        routeId: device.route_id,
        deviceId: device.device_id,
        role: device.role,
        createdAt: device.created_at,
        lastSeenAt: device.last_seen_at,
        revokedAt: device.revoked_at,
      })),
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

  async revokeDevice(routeId: string, deviceId: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "UPDATE devices SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP(3)) WHERE route_id = ? AND device_id = ?",
      [routeId, deviceId],
    );
    return result.affectedRows > 0;
  }

  async cleanupInactiveRoutes(olderThan: Date): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      "DELETE FROM routes WHERE disabled_at IS NULL AND COALESCE(last_seen_at, created_at) < ?",
      [olderThan],
    );
    return result.affectedRows;
  }
}

interface CachedCredential {
  device: {
    routeId: string;
    deviceId: string;
    role: DeviceRole;
    tokenDigest: string;
    createdAt: string;
    lastSeenAt: string | null;
    revokedAt: string | null;
  };
  disabledAt: string | null;
}

function encodeDevice(device: DeviceRecord, disabledAt: Date | null): string {
  const value: CachedCredential = {
    device: {
      routeId: device.routeId,
      deviceId: device.deviceId,
      role: device.role,
      tokenDigest: device.tokenDigest.toString("base64"),
      createdAt: device.createdAt.toISOString(),
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      revokedAt: device.revokedAt?.toISOString() ?? null,
    },
    disabledAt: disabledAt?.toISOString() ?? null,
  };
  return JSON.stringify(value);
}

function decodeDevice(value: string): { device: DeviceRecord; disabledAt: Date | null } | null {
  try {
    const parsed = JSON.parse(value) as CachedCredential;
    if (!parsed.device || !["host", "client"].includes(parsed.device.role)) return null;
    return {
      device: {
        routeId: parsed.device.routeId,
        deviceId: parsed.device.deviceId,
        role: parsed.device.role,
        tokenDigest: Buffer.from(parsed.device.tokenDigest, "base64"),
        createdAt: new Date(parsed.device.createdAt),
        lastSeenAt: parsed.device.lastSeenAt === null ? null : new Date(parsed.device.lastSeenAt),
        revokedAt: parsed.device.revokedAt === null ? null : new Date(parsed.device.revokedAt),
      },
      disabledAt: parsed.disabledAt === null ? null : new Date(parsed.disabledAt),
    };
  } catch {
    return null;
  }
}

const EVENT_CHANNEL = "prospero:relay:events:v1";

export class RedisEphemeralStore implements EphemeralStore {
  private readonly client: RedisClientType;
  private subscriber: RedisClientType | undefined;

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl });
    this.client.on("error", () => undefined);
  }

  private async ready(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }

  async ping(): Promise<void> {
    await this.ready();
    await this.client.ping();
  }

  async close(): Promise<void> {
    if (this.subscriber?.isOpen) await this.subscriber.quit();
    if (this.client.isOpen) await this.client.quit();
  }

  async cacheCredential(device: DeviceRecord, disabledAt: Date | null, ttlSeconds: number): Promise<void> {
    await this.ready();
    await this.client.set(`credential:${device.routeId}:${device.deviceId}`, encodeDevice(device, disabledAt), { EX: ttlSeconds });
  }

  async getCachedCredential(routeId: string, deviceId: string): Promise<{ device: DeviceRecord; disabledAt: Date | null } | null> {
    await this.ready();
    const value = await this.client.get(`credential:${routeId}:${deviceId}`);
    return value === null ? null : decodeDevice(value);
  }

  async setPresence(routeId: string, connectionId: string, ttlSeconds: number): Promise<void> {
    await this.ready();
    await this.client.set(`presence:${routeId}`, connectionId, { EX: ttlSeconds });
  }

  async clearPresence(routeId: string, connectionId: string): Promise<void> {
    await this.ready();
    // Do not let the close event of an evicted host erase the newer host's presence.
    const current = await this.client.get(`presence:${routeId}`);
    if (current === connectionId) await this.client.del(`presence:${routeId}`);
  }

  async createTicket(ticket: StreamTicket, ttlSeconds: number): Promise<void> {
    await this.ready();
    const stored = await this.client.set(`ticket:${ticket.streamId}`, JSON.stringify(ticket), { EX: ttlSeconds, NX: true });
    if (stored !== "OK") throw new Error("stream ticket collision");
  }

  async consumeTicket(streamId: string): Promise<StreamTicket | null> {
    await this.ready();
    const value = await this.client.getDel(`ticket:${streamId}`);
    if (value === null) return null;
    try {
      return JSON.parse(value) as StreamTicket;
    } catch {
      return null;
    }
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfterMs: number }> {
    await this.ready();
    const tx = this.client.multi();
    tx.incr(key);
    tx.expire(key, windowSeconds, "NX");
    const [count] = await tx.exec();
    const amount = Number(count);
    return { allowed: amount <= limit, retryAfterMs: windowSeconds * 1000 };
  }

  async publish(event: RelayEvent): Promise<void> {
    await this.ready();
    await this.client.publish(EVENT_CHANNEL, JSON.stringify(event));
  }

  async subscribe(listener: (event: RelayEvent) => void): Promise<() => Promise<void>> {
    await this.ready();
    const subscriber = this.client.duplicate();
    subscriber.on("error", () => undefined);
    await subscriber.connect();
    await subscriber.subscribe(EVENT_CHANNEL, (message) => {
      try {
        const event = JSON.parse(message) as RelayEvent;
        if (event && typeof event.routeId === "string" && typeof event.type === "string") listener(event);
      } catch {
        // A bad pub/sub message is not an authorization decision; ignore it.
      }
    });
    this.subscriber = subscriber;
    return async () => {
      if (subscriber.isOpen) await subscriber.quit();
      if (this.subscriber === subscriber) this.subscriber = undefined;
    };
  }
}
