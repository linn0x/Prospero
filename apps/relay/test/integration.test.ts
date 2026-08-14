import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { randomOpaque } from "../src/crypto.js";
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
      const routeId = randomOpaque(16);
      const hostDeviceId = randomOpaque(16);
      const hostToken = randomOpaque(32);
      await routes.createRoute(routeId, hostDeviceId, hostToken);
      const snapshot = await routes.registerHost(routeId, hostDeviceId, hostToken);
      expect(snapshot?.device.role).toBe("host");
      const streamId = randomOpaque(16);
      await ephemeral.createTicket({ streamId, routeId, hostConnectionId: "test", clientDeviceId: "client" }, 30);
      expect((await ephemeral.consumeTicket(streamId))?.streamId).toBe(streamId);
      expect(await ephemeral.consumeTicket(streamId)).toBeNull();
      const inspected = await routes.inspectRoute(routeId);
      expect(JSON.stringify(inspected)).not.toContain(hostToken);
    } finally {
      await Promise.allSettled([routes.close(), ephemeral.close()]);
      await exec("docker", ["compose", "-p", project, "-f", compose, "down", "-v"], { timeout: 60_000 });
    }
  }, 180_000);
});
