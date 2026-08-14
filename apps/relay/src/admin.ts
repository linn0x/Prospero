#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { deriveRouteId } from "./crypto.js";
import { readConfig } from "./config.js";
import { RedisEphemeralStore, MySqlRouteStore } from "./store.js";
import type { RelayEvent } from "./types.js";

function usage(): never {
  process.stderr.write(`Usage:
  prospero-relay-admin route create [--host-secret BASE64URL]
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

function hostSecretFromArgument(value: string | undefined): Buffer {
  if (value === undefined) return randomBytes(32);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("--host-secret must be base64url-encoded 32 bytes");
  const secret = Buffer.from(value, "base64url");
  if (secret.length !== 32) throw new Error("--host-secret must be exactly 32 bytes");
  return secret;
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
    if (noun === "route" && verb === "create") {
      const option = rest[0];
      if (option === "--host-secret" && (rest[1] === undefined || rest.length !== 2)) usage();
      if (option === undefined && rest.length !== 0) usage();
      const secret = option === "--host-secret" ? hostSecretFromArgument(rest[1]) : hostSecretFromArgument(undefined);
      if (option !== undefined && option !== "--host-secret") usage();
      const routeId = deriveRouteId(secret);
      await routes.createRoute(routeId);
      // The secret is intentionally emitted once for the host's local durable store; MySQL never sees it.
      process.stdout.write(`${JSON.stringify({ routeId, hostSecret: secret.toString("base64url") })}\n`);
      return;
    }
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
