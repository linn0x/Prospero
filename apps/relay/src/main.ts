#!/usr/bin/env node
import { readConfig } from "./config.js";
import { createLogger } from "./log.js";
import { RelayServer } from "./relay.js";
import { MySqlRouteStore, RedisEphemeralStore } from "./store.js";

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config.logLevel);
  const routes = new MySqlRouteStore(config.mysqlUrl);
  const ephemeral = new RedisEphemeralStore(config.redisUrl);
  const relay = new RelayServer({ routes, ephemeral, config, logger });
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ event: "relay.shutdown", signal }, "relay shutting down");
    void relay.close().then(() => Promise.all([routes.close(), ephemeral.close()])).catch((error: unknown) => {
      logger.error({ event: "relay.shutdown_failed", error: error instanceof Error ? error.name : "unknown" }, "relay shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  await relay.listen();
}

void main().catch((error: unknown) => {
  process.stderr.write(`relay failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
