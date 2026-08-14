import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialDigest, deriveRouteId, randomOpaque } from "../src/crypto.js";
import { runMigrations } from "../src/migrate.js";
import { MySqlRouteStore, RedisEphemeralStore } from "../src/store.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const compose = join(here, "compose.integration.yaml");
const project = `prospero-relay-it-${process.pid}`;
const mysqlUrl = "mysql://prospero:integration-password@127.0.0.1:33306/prospero_relay_test";
const redisUrl = "redis://127.0.0.1:36379";

describe.skipIf(process.env.RELAY_INTEGRATION !== "1")("MySQL 8.4 + Redis real-container integration", () => {
  it("migrates anonymous credential records and atomically consumes Redis tickets", async () => {
    await exec("docker", ["compose", "-p", project, "-f", compose, "up", "-d", "--wait"], { timeout: 120_000 });
    const routes = new MySqlRouteStore(mysqlUrl);
    const ephemeral = new RedisEphemeralStore(redisUrl);
    try {
      await runMigrations(mysqlUrl, join(here, "..", "migrations"));
      const routeId = deriveRouteId(Buffer.from(randomOpaque(32), "base64url"));
      const token = randomOpaque(32);
      const deviceId = randomOpaque(16);
      await routes.createRoute(routeId);
      const snapshot = await routes.applyDeviceSnapshot(routeId, 1, [{ deviceId, credentialDigest: credentialDigest(token).toString("base64url") }]);
      expect(snapshot?.route.generation).toBe(1);
      const streamId = randomOpaque(16);
      const ticket = randomOpaque(16);
      await ephemeral.createTicket({ streamId, ticket, routeId, hostConnectionId: "test", clientDeviceId: "client", expiresAt: Date.now() + 30_000 }, 30);
      expect((await ephemeral.consumeTicket(ticket))?.streamId).toBe(streamId);
      expect(await ephemeral.consumeTicket(ticket)).toBeNull();
      const inspected = await routes.inspectRoute(routeId);
      expect(JSON.stringify(inspected)).not.toContain(token);
    } finally {
      await Promise.allSettled([routes.close(), ephemeral.close()]);
      await exec("docker", ["compose", "-p", project, "-f", compose, "down", "-v"], { timeout: 60_000 });
    }
  }, 180_000);
});
