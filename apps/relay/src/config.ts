import { resolve } from "node:path";
import { isIP } from "node:net";

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const source = env[name];
  if (source === undefined || source === "") return fallback;
  const value = Number(source);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function bool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const source = env[name];
  if (source === undefined || source === "") return fallback;
  if (source === "true" || source === "1") return true;
  if (source === "false" || source === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function ipList(env: NodeJS.ProcessEnv, name: string): string[] {
  const source = env[name];
  if (source === undefined || source.trim() === "") return [];
  const values = source.split(",").map((value) => value.trim());
  if (values.some((value) => value === "" || isIP(value) === 0)) {
    throw new Error(`${name} must be a comma-separated list of IP addresses`);
  }
  return [...new Set(values.map((value) => value.replace(/^::ffff:/, "")))];
}

export interface RelayConfig {
  host: string;
  port: number;
  mysqlUrl: string;
  redisUrl: string;
  migrationDir: string;
  metricsToken?: string;
  metricsInternalOnly: boolean;
  maxStreamsPerRoute: number;
  authTimeoutMs: number;
  ticketTimeoutMs: number;
  credentialCacheTtlSeconds: number;
  presenceTtlSeconds: number;
  authRatePerMinute: number;
  connectionRatePerMinute: number;
  cleanupIntervalMs: number;
  logLevel: string;
  /** Exact proxy source addresses permitted to supply the sanitized client IP header. */
  trustedProxyIps?: readonly string[];
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
    const metricsToken = env.METRICS_TOKEN;
    if (metricsToken !== undefined && metricsToken.length < 24) {
      throw new Error("METRICS_TOKEN must be at least 24 characters");
    }
    if (metricsToken === undefined && bool(env, "METRICS_INTERNAL_ONLY", true) === false) {
      throw new Error("METRICS_TOKEN is required when METRICS_INTERNAL_ONLY=false");
    }
    return {
      host: env.RELAY_HOST ?? "0.0.0.0",
      port: integer(env, "RELAY_PORT", 8787, 1, 65535),
      mysqlUrl: env.MYSQL_URL ?? "mysql://prospero:prospero@127.0.0.1:3306/prospero_relay",
      redisUrl: env.REDIS_URL ?? "redis://127.0.0.1:6379",
      migrationDir: env.MIGRATIONS_DIR ?? resolve(process.cwd(), "migrations"),
      ...(metricsToken === undefined ? {} : { metricsToken }),
      metricsInternalOnly: bool(env, "METRICS_INTERNAL_ONLY", metricsToken === undefined),
      maxStreamsPerRoute: integer(env, "MAX_STREAMS_PER_ROUTE", 8, 1, 128),
      authTimeoutMs: integer(env, "AUTH_TIMEOUT_MS", 10_000, 1_000, 60_000),
      ticketTimeoutMs: integer(env, "TICKET_TIMEOUT_MS", 15_000, 1_000, 60_000),
      credentialCacheTtlSeconds: integer(env, "CREDENTIAL_CACHE_TTL_SECONDS", 60, 5, 3600),
      presenceTtlSeconds: integer(env, "PRESENCE_TTL_SECONDS", 45, 10, 300),
      authRatePerMinute: integer(env, "AUTH_RATE_PER_MINUTE", 20, 1, 10_000),
      connectionRatePerMinute: integer(env, "CONNECTION_RATE_PER_MINUTE", 60, 1, 10_000),
      cleanupIntervalMs: integer(env, "CLEANUP_INTERVAL_MS", 3_600_000, 60_000, 86_400_000),
      logLevel: env.LOG_LEVEL ?? "info",
      trustedProxyIps: ipList(env, "RELAY_TRUSTED_PROXY_IPS"),
    };
}
