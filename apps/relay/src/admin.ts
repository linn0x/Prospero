#!/usr/bin/env node
import { readConfig } from "./config.js";
import { RedisEphemeralStore, MySqlRouteStore } from "./store.js";
import type { RelayEvent } from "./types.js";

function usage(): never {
  process.stderr.write(`Usage:
  prospero-relay-admin route disable <routeId>
  prospero-relay-admin route enable <routeId>
  prospero-relay-admin route inspect <routeId>
`);
  process.exit(2);
}

function requireId(value: string | undefined, name: string): string {
  if (value === undefined || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new Error(`${name} must be a base64url opaque ID`);
  return value;
}

async function publish(ephemeral: RedisEphemeralStore, event: RelayEvent): Promise<void> {
  await ephemeral.publish(event);
}

async function main(args: string[]): Promise<void> {
  const config = readConfig();
  const routes = new MySqlRouteStore(config.mysqlUrl);
  const ephemeral = new RedisEphemeralStore(config.redisUrl);
  try {
    const [noun, verb, ...rest] = args;
    if (noun === "route" && (verb === "disable" || verb === "enable" || verb === "inspect")) {
      const routeId = requireId(rest[0], "routeId");
      if (verb === "inspect") {
        const route = await routes.inspectRoute(routeId);
        if (route === null) throw new Error("route not found");
        process.stdout.write(`${JSON.stringify(route)}\n`);
        return;
      }
      const changed = verb === "disable" ? await routes.disableRoute(routeId) : await routes.enableRoute(routeId);
      if (!changed) throw new Error("route not found");
      await publish(ephemeral, { type: verb === "disable" ? "route.disabled" : "route.enabled", routeId });
      process.stdout.write(`${JSON.stringify({ routeId, status: verb === "disable" ? "disabled" : "enabled" })}\n`);
      return;
    }
    usage();
  } finally {
    await Promise.allSettled([routes.close(), ephemeral.close()]);
  }
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`relay admin failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
