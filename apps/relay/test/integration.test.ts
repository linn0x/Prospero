import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createClient } from "redis";
import { credentialDigest, deriveRouteId, randomOpaque } from "../src/crypto.js";
import { runMigrations } from "../src/migrate.js";
import { MySqlRouteStore, RedisEphemeralStore, SnapshotGenerationError } from "../src/store.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const compose = join(here, "compose.integration.yaml");
const project = `prospero-relay-it-${process.pid}`;
const mysqlUrl = "mysql://prospero:integration-password@127.0.0.1:33306/prospero_relay_test";
const redisUrl = "redis://127.0.0.1:36379";

describe.skipIf(process.env.RELAY_INTEGRATION !== "1")("MySQL 8.4 + Redis real-container integration", () => {
  it("builds a healthy relay and preserves MySQL/Redis concurrency semantics", async () => {
    await exec("docker", ["compose", "-p", project, "-f", compose, "up", "-d", "--build", "--wait"], { timeout: 240_000 });
    const routes = new MySqlRouteStore(mysqlUrl);
    const ephemeral = new RedisEphemeralStore(redisUrl);
    const rawRedis = createClient({ url: redisUrl });
    try {
      await runMigrations(mysqlUrl, join(here, "..", "migrations"));
      expect((await fetch("http://127.0.0.1:38787/health/ready")).status).toBe(200);
      const routeId = deriveRouteId(Buffer.from(randomOpaque(32), "base64url"));
      const token = randomOpaque(32);
      const deviceId = randomOpaque(16);
      const missingDeviceId = randomOpaque(16);
      await routes.createRoute(routeId);
      const snapshot = await routes.applyDeviceSnapshot(routeId, 1, [
        { deviceId, credentialDigest: credentialDigest(token).toString("base64url") },
        { deviceId: missingDeviceId, credentialDigest: credentialDigest(randomOpaque(32)).toString("base64url") },
      ]);
      expect(snapshot?.route.generation).toBe(1);
      await routes.applyDeviceSnapshot(routeId, 2, [{ deviceId, credentialDigest: credentialDigest(token).toString("base64url") }]);
      await expect(routes.applyDeviceSnapshot(routeId, 2, [
        { deviceId, credentialDigest: credentialDigest(token).toString("base64url") }, { deviceId: missingDeviceId, revoked: true },
      ])).resolves.toMatchObject({ route: { generation: 2 } });
      await expect(routes.applyDeviceSnapshot(routeId, 2, [{ deviceId, credentialDigest: credentialDigest(token).toString("base64url") }])).resolves.toMatchObject({ route: { generation: 2 } });
      const beforeRejectedSnapshot = await routes.inspectRoute(routeId);
      await expect(routes.applyDeviceSnapshot(routeId, 2, [
        { deviceId, credentialDigest: credentialDigest(token).toString("base64url") }, { deviceId: randomOpaque(16), revoked: true },
      ])).rejects.toBeInstanceOf(SnapshotGenerationError);
      // SnapshotGenerationError is emitted only after the MySQL transaction
      // rolls back, which makes a stale host's rejection safe to ignore.
      expect(await routes.inspectRoute(routeId)).toEqual(beforeRejectedSnapshot);
      await expect(routes.applyDeviceSnapshot(routeId, 1, [{ deviceId, credentialDigest: credentialDigest(token).toString("base64url") }])).rejects.toThrow("stale or inconsistent");

      const concurrent = await Promise.allSettled([
        routes.applyDeviceSnapshot(routeId, 3, [{ deviceId, credentialDigest: credentialDigest(token).toString("base64url") }]),
        routes.applyDeviceSnapshot(routeId, 3, [{ deviceId, credentialDigest: credentialDigest(randomOpaque(32)).toString("base64url") }]),
      ]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);

      const streamId = randomOpaque(16);
      const ticket = randomOpaque(16);
      await ephemeral.createTicket({ streamId, ticket, routeId, hostConnectionId: "test", clientDeviceId: "client", expiresAt: Date.now() + 30_000 });
      expect(await ephemeral.redeemTicket(ticket, randomOpaque(16))).toEqual({ status: "invalid" });
      expect((await ephemeral.redeemTicket(ticket, streamId))).toMatchObject({ status: "ok", ticket: { streamId } });
      expect(await ephemeral.redeemTicket(ticket, streamId)).toEqual({ status: "used" });
      const concurrentTicket = randomOpaque(16);
      const concurrentStreamId = randomOpaque(16);
      await ephemeral.createTicket({ streamId: concurrentStreamId, ticket: concurrentTicket, routeId, hostConnectionId: "test", clientDeviceId: "client", expiresAt: Date.now() + 30_000 });
      const concurrentRedemptions = await Promise.all([
        ephemeral.redeemTicket(concurrentTicket, concurrentStreamId),
        ephemeral.redeemTicket(concurrentTicket, concurrentStreamId),
      ]);
      expect(concurrentRedemptions.filter((result) => result.status === "ok")).toHaveLength(1);
      expect(concurrentRedemptions.filter((result) => result.status === "used")).toHaveLength(1);
      const expiringTicket = randomOpaque(16);
      await ephemeral.createTicket({ streamId: randomOpaque(16), ticket: expiringTicket, routeId, hostConnectionId: "test", clientDeviceId: "client", expiresAt: Date.now() + 25 });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(await ephemeral.redeemTicket(expiringTicket, randomOpaque(16))).toEqual({ status: "expired" });

      const leases = await Promise.all(Array.from({ length: 16 }, (_, index) => ephemeral.acquireStreamLease(routeId, `lease-${index}`, 8, 5_000)));
      expect(leases.filter(Boolean)).toHaveLength(8);
      await Promise.all(leases.map((acquired, index) => acquired ? ephemeral.releaseStreamLease(routeId, `lease-${index}`) : undefined));
      expect(await ephemeral.acquireStreamLease(routeId, "replacement", 8, 5_000)).toBe(true);
      await ephemeral.releaseStreamLease(routeId, "replacement");

      await rawRedis.connect();
      for (let race = 0; race < 8; race += 1) {
        await ephemeral.setPresence(routeId, "old", 30);
        await Promise.all([ephemeral.setPresence(routeId, "new", 30), ephemeral.clearPresence(routeId, "old")]);
        expect(await rawRedis.get(`presence:${routeId}`)).toBe("new");
      }
      const inspected = await routes.inspectRoute(routeId);
      expect(JSON.stringify(inspected)).not.toContain(token);
    } finally {
      await Promise.allSettled([routes.close(), ephemeral.close(), rawRedis.isOpen ? rawRedis.quit() : Promise.resolve()]);
      await exec("docker", ["compose", "-p", project, "-f", compose, "down", "-v"], { timeout: 60_000 });
    }
  }, 300_000);
});
