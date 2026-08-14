#!/usr/bin/env node
/**
 * Disruptive compose acceptance checks. Run only against an isolated relay
 * project: this script deliberately stops dependencies and recreates relay
 * tables while proving backup/restore.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROUTE_ID_DOMAIN = "prospero.relay.v1.route-id\\0";
const CREDENTIAL_DOMAIN = "prospero.relay.v1.device-credential\\0";
const DAY_MS = 24 * 60 * 60 * 1_000;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
function resolveRepositoryPath(value) { return path.isAbsolute(value) ? value : path.resolve(REPOSITORY_ROOT, value); }
const ownedSockets = new Set();
let activeReport;

// Reports are reviewable evidence, not a debugging dump.  The harness keeps
// credentials and WebSocket objects in memory, but report serialization is
// deliberately default-deny so neither can escape into an artifact.
const SAFE_REPORT_KEYS = new Set([
  "schemaVersion", "kind", "startedAt", "finishedAt", "status", "steps", "failures", "recovery",
  "name", "pass", "result", "skipped", "code", "blockedBy", "live", "ready", "reconnect",
  "readinessDuringFault", "rejected", "restoredRouteCount", "staleRouteDeleted", "service", "restored",
  "onlyCaddy", "has80And443", "handshake",
]);
const FORBIDDEN_REPORT_KEY = /(?:host.?secret|token|ticket|credential|authorization|route.?id|(?:^|[_-])(?:ws|websocket|socket|frame|buffer)(?:$|[_-]))/i;
const FORBIDDEN_REPORT_MARKER = /(?:host.?secret|token|ticket|credential|authorization|route.?id|\bws\b|websocket|socket|frame|buffer)/i;

function safeFailureCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return "timeout";
  if (/expected close/i.test(message)) return "unexpected_close_code";
  if (/fetch failed|request failed/i.test(message)) return "health_request_failed";
  if (/disabled tombstone/i.test(message)) return "tombstone_rejection_failed";
  return "operation_failed";
}

function projectReportValue(value, pathName = "report") {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (FORBIDDEN_REPORT_MARKER.test(value)) throw new Error(`forbidden report marker at ${pathName}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => projectReportValue(entry, `${pathName}[${index}]`));
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`non-plain report value at ${pathName}`);
  const projection = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!SAFE_REPORT_KEYS.has(key) || FORBIDDEN_REPORT_KEY.test(key)) throw new Error(`report key is not allowlisted at ${pathName}`);
    projection[key] = projectReportValue(entry, `${pathName}.${key}`);
  }
  return projection;
}

export function serializeSafeFailureReport(report) {
  return `${JSON.stringify(projectReportValue(report), null, 2)}\n`;
}

export function newFailureReport() {
  return { schemaVersion: 1, kind: "prospero-relay-failure-report", startedAt: new Date().toISOString(), status: "passed", steps: [], failures: [] };
}

export function recordFailure(report, name, error, blockedBy) {
  report.status = "failed";
  report.failures.push({ name, code: safeFailureCode(error), ...(blockedBy ? { blockedBy } : {}) });
}

// A rejected WebSocket callback must become report evidence, never a silent
// process-level warning that leaves a disruptive test without its report.
process.on("unhandledRejection", (reason) => {
  if (activeReport) {
    recordFailure(activeReport, "unhandled_promise_rejection", reason);
  } else {
    process.stderr.write("relay failure harness unhandled rejection after report finalization\n");
  }
});

function usage() {
  process.stderr.write(`Usage: node apps/relay/bench/failure.mjs --url <ws://relay> --compose-file <file> --project <name> --confirm-disruption [options]\n\n` +
    "  --env-file <file>       Compose env file, if required\n" +
    "  --public-wss-url <url>  Optional deployed wss:// endpoint to handshake-test\n" +
    "  --skip-public-deployment  Record Caddy/TLS as skipped for an isolated non-Caddy stack\n" +
    "  --report <path>         JSON output (default: apps/relay/reports/latest-failure-report.json)\n" +
    "  --skip-backup-restore    Skip the destructive mysqldump/restore proof\n" +
    "  --skip-cleanup           Skip the 65-second scheduled 30-day cleanup proof\n");
}

function parseArgs(argv) {
  const values = new Map(); const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    if (["--confirm-disruption", "--skip-backup-restore", "--skip-cleanup", "--skip-public-deployment"].includes(arg)) { flags.add(arg.slice(2)); continue; }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg.slice(2), value); i += 1;
  }
  for (const required of ["url", "compose-file", "project"]) if (!values.has(required)) throw new Error(`--${required} is required`);
  if (!flags.has("confirm-disruption")) throw new Error("--confirm-disruption is required because this test stops services and restores MySQL");
  return {
    url: values.get("url").replace(/\/$/, ""), composeFile: resolveRepositoryPath(values.get("compose-file")), project: values.get("project"), envFile: values.has("env-file") ? resolveRepositoryPath(values.get("env-file")) : undefined, publicWssUrl: values.get("public-wss-url"),
    report: resolveRepositoryPath(values.get("report") ?? "apps/relay/reports/latest-failure-report.json"), skipBackupRestore: flags.has("skip-backup-restore"), skipCleanup: flags.has("skip-cleanup"), skipPublicDeployment: flags.has("skip-public-deployment"),
  };
}

function opaque(bytes) { return randomBytes(bytes).toString("base64url"); }
function routeIdFor(secret) { return createHash("sha256").update(ROUTE_ID_DOMAIN, "utf8").update(Buffer.from(secret, "base64url")).digest("base64url"); }
function credentialDigest(token) { return createHash("sha256").update(CREDENTIAL_DOMAIN, "utf8").update(token, "utf8").digest("base64url"); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function raw(data) { return Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data); }
function waitFor(check, description, timeoutMs = 30_000) {
  return (async () => {
    const until = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < until) {
      try { if (await check()) return; } catch (error) { lastError = error; }
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
  })();
}
function composeArgs(options, args) {
  const prefix = ["compose", "--project-name", options.project, "--file", options.composeFile];
  if (options.envFile) prefix.push("--env-file", options.envFile);
  return [...prefix, ...args];
}
function docker(options, args, env) {
  return execFileSync("docker", composeArgs(options, args), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }).trim();
}
async function health(origin, pathName) {
  const response = await fetch(`${origin}${pathName}`, { signal: AbortSignal.timeout(5_000) });
  return response.status;
}
async function readinessDuringFault(origin) {
  try { return await health(origin, "/health/ready"); }
  catch { return "request_failed"; }
}

async function hostControl(origin, prior) {
  const hostSecret = prior?.hostSecret ?? opaque(32);
  const host = { hostSecret, routeId: prior?.routeId ?? routeIdFor(hostSecret), deviceId: prior?.deviceId ?? opaque(16), token: prior?.token ?? opaque(32), ws: undefined, online: false, closeCode: undefined };
  const ready = new Promise((resolve, reject) => {
    const ws = new WebSocket(`${origin}/v1/host`, { perMessageDeflate: false });
    host.ws = ws;
    ownedSockets.add(ws);
    ws.once("open", () => {
      try {
        ws.send(JSON.stringify({ v: 1, routeId: host.routeId, hostSecret }));
        ws.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 1, credentials: [{ deviceId: host.deviceId, credentialDigest: credentialDigest(host.token) }] }));
      } catch (error) { reject(error); }
    });
    ws.on("message", (data, binary) => {
      if (binary) return;
      try {
        const message = JSON.parse(raw(data).toString("utf8"));
        if (message.type === "host.ready") { host.online = true; resolve(); }
        if (message.type === "error") reject(new Error(`host error: ${message.code}`));
      } catch { reject(new Error("invalid host control response")); }
    });
    ws.on("error", (error) => { if (!host.online) reject(error); });
    ws.once("close", (code) => {
      ownedSockets.delete(ws);
      host.online = false; host.closeCode = code;
      reject(new Error(`host control closed before ready (${code})`));
    });
  });
  try {
    await Promise.race([ready, sleep(15_000).then(() => { throw new Error("host did not reach ready"); })]);
  } catch (error) {
    host.ws?.terminate();
    throw error;
  }
  return host;
}
async function waitClose(host, expected, description) {
  await waitFor(() => host.ws.readyState === WebSocket.CLOSED, description, 20_000);
  if (!expected.includes(host.closeCode)) throw new Error(`${description}: expected close ${expected.join(" or ")}, got ${host.closeCode}`);
}
async function openWss(url) {
  const ws = new WebSocket(`${url.replace(/\/$/, "")}/v1/host`, { perMessageDeflate: false, rejectUnauthorized: true });
  ws.on("error", () => undefined);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.terminate();
}

async function staticDeploymentCheck(options) {
  const config = JSON.parse(docker(options, ["config", "--format", "json"]));
  const services = config.services ?? {};
  const publicServices = Object.entries(services).filter(([, service]) => Array.isArray(service.ports) && service.ports.length > 0).map(([name, service]) => ({ name, ports: service.ports }));
  const caddy = services.caddy;
  const onlyCaddy = publicServices.length === 1 && publicServices[0].name === "caddy";
  const caddyPorts = Array.isArray(caddy?.ports) ? caddy.ports.map((entry) => typeof entry === "string" ? entry : `${entry.published}:${entry.target}`) : [];
  const has80And443 = caddyPorts.some((port) => port.startsWith("80:")) && caddyPorts.some((port) => port.startsWith("443:"));
  return { pass: onlyCaddy && has80And443, onlyCaddy, has80And443 };
}

async function backupRestore(options, routeId) {
  const backup = "/tmp/prospero-relay-t8-backup.sql";
  // routeId is generated base64url and therefore safe inside this fixed shell.
  const script = [
    "set -eu",
    `mysqldump --add-drop-table -uroot -p\"$MYSQL_ROOT_PASSWORD\" \"$MYSQL_DATABASE\" > ${backup}`,
    `mysql -uroot -p\"$MYSQL_ROOT_PASSWORD\" \"$MYSQL_DATABASE\" -e \"DELETE FROM routes WHERE route_id='${routeId}'\"`,
    `mysql -uroot -p\"$MYSQL_ROOT_PASSWORD\" \"$MYSQL_DATABASE\" < ${backup}`,
    `mysql -N -uroot -p\"$MYSQL_ROOT_PASSWORD\" \"$MYSQL_DATABASE\" -e \"SELECT COUNT(*) FROM routes WHERE route_id='${routeId}'\"`,
    `rm -f ${backup}`,
  ].join("; ");
  const output = docker(options, ["stop", "relay"]);
  void output;
  const restoredCount = docker(options, ["exec", "-T", "mysql", "sh", "-ec", script]);
  docker(options, ["start", "relay"]);
  await waitFor(async () => (await health(options.url.replace(/^ws/, "http"), "/health/ready")) === 200, "relay after database restore", 60_000);
  if (restoredCount.trim() !== "1") throw new Error(`backup restore expected one route, got ${restoredCount}`);
  return { pass: true, restoredRouteCount: Number(restoredCount) };
}

async function cleanupProof(options) {
  const stale = await hostControl(options.url);
  stale.ws.terminate();
  const oldDate = new Date(Date.now() - 31 * DAY_MS).toISOString().slice(0, 23).replace("T", " ");
  const ageScript = `mysql -uroot -p\"$MYSQL_ROOT_PASSWORD\" \"$MYSQL_DATABASE\" -e \"UPDATE routes SET last_seen_at='${oldDate}' WHERE route_id='${stale.routeId}'\"`;
  docker(options, ["exec", "-T", "mysql", "sh", "-ec", ageScript]);
  // The production default is hourly. Recreating just relay with the minimum
  // valid interval is an accelerated scheduler test; retention is still 30d.
  docker(options, ["up", "-d", "--force-recreate", "relay"], { CLEANUP_INTERVAL_MS: "60000" });
  await waitFor(async () => (await health(options.url.replace(/^ws/, "http"), "/health/ready")) === 200, "relay after cleanup test restart", 60_000);
  await sleep(65_000);
  const countScript = `mysql -N -uroot -p\"$MYSQL_ROOT_PASSWORD\" \"$MYSQL_DATABASE\" -e \"SELECT COUNT(*) FROM routes WHERE route_id='${stale.routeId}'\"`;
  const count = docker(options, ["exec", "-T", "mysql", "sh", "-ec", countScript]);
  if (count.trim() !== "0") throw new Error(`30-day cleanup did not delete stale active route (${count})`);
  return { pass: true, staleRouteDeleted: true };
}

async function recoverServices(options, report) {
  const results = [];
  for (const service of ["mysql", "redis", "relay"]) {
    try { docker(options, ["start", service]); results.push({ service, restored: true }); }
    catch { results.push({ service, restored: false, code: "recovery_command_failed" }); }
  }
  report.recovery = results;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { usage(); throw error; }
  if (options.help) { usage(); return; }
  const report = newFailureReport();
  activeReport = report;
  const step = async (name, operation, redactResult) => {
    try {
      const result = await operation();
      if (result?.pass === false) throw new Error(`${name} reported a failed assertion`);
      report.steps.push({ name, pass: true, result: redactResult ? redactResult(result) : result });
      return result;
    }
    catch (error) { recordFailure(report, name, error); report.steps.push({ name, pass: false }); return undefined; }
  };
  const blocked = (name, blockedBy) => report.steps.push({ name, pass: null, blockedBy });
  try {
    const httpOrigin = options.url.replace(/^ws/, "http");
    if (options.skipPublicDeployment) report.steps.push({ name: "compose_public_ports_only_caddy_80_443", pass: null, skipped: "isolated local stack has no Caddy; production Caddy validation remains required" });
    else await step("compose_public_ports_only_caddy_80_443", () => staticDeploymentCheck(options));
    await step("live_and_ready", async () => {
      const live = await health(httpOrigin, "/health/live"); const ready = await health(httpOrigin, "/health/ready");
      if (live !== 200 || ready !== 200) throw new Error(`expected live/ready 200, got ${live}/${ready}`);
      return { live, ready };
    });
    if (options.publicWssUrl) await step("caddy_tls_wss_handshake", async () => { await openWss(options.publicWssUrl); return { handshake: true }; });
    else report.steps.push({ name: "caddy_tls_wss_handshake", pass: null, skipped: "no public WSS URL supplied" });

    let host = await step("initial_host_ready", () => hostControl(options.url), () => ({ ready: true }));
    if (host) {
      const redisRecovery = await step("redis_fail_closed", async () => {
        docker(options, ["stop", "redis"]);
        let unavailable;
        try {
          unavailable = await readinessDuringFault(httpOrigin);
          if (unavailable === 200) throw new Error("relay remained ready while Redis was stopped");
          await waitClose(host, [1013], "host close after Redis fault");
        } finally { docker(options, ["start", "redis"]); }
        await waitFor(async () => (await health(httpOrigin, "/health/ready")) === 200, "Redis recovery");
        host = await hostControl(options.url, host);
        return { readinessDuringFault: unavailable, reconnect: host.online };
      });
      if (!redisRecovery?.reconnect) {
        blocked("mysql_fail_closed", "redis_fail_closed");
        blocked("relay_graceful_restart_and_host_reconnect", "redis_fail_closed");
        blocked("disabled_tombstone_rejects_existing_host", "redis_fail_closed");
        if (!options.skipBackupRestore) blocked("mysql_backup_restore_preserves_tombstone", "redis_fail_closed");
        if (!options.skipCleanup) blocked("scheduled_30_day_cleanup", "redis_fail_closed");
        return;
      }
      const mysqlRecovery = await step("mysql_fail_closed", async () => {
        docker(options, ["stop", "mysql"]);
        let unavailable;
        try {
          unavailable = await readinessDuringFault(httpOrigin);
          if (unavailable === 200) throw new Error("relay remained ready while MySQL was stopped");
          await waitClose(host, [1013], "host close after MySQL fault");
        } finally { docker(options, ["start", "mysql"]); }
        await waitFor(async () => (await health(httpOrigin, "/health/ready")) === 200, "MySQL recovery", 90_000);
        host = await hostControl(options.url, host);
        return { readinessDuringFault: unavailable, reconnect: host.online };
      });
      if (!mysqlRecovery?.reconnect) {
        blocked("relay_graceful_restart_and_host_reconnect", "mysql_fail_closed");
        blocked("disabled_tombstone_rejects_existing_host", "mysql_fail_closed");
        if (!options.skipBackupRestore) blocked("mysql_backup_restore_preserves_tombstone", "mysql_fail_closed");
        if (!options.skipCleanup) blocked("scheduled_30_day_cleanup", "mysql_fail_closed");
        return;
      }
      const relayRecovery = await step("relay_graceful_restart_and_host_reconnect", async () => {
        docker(options, ["restart", "relay"]);
        await waitClose(host, [1012, 1006], "host close during relay restart");
        await waitFor(async () => (await health(httpOrigin, "/health/ready")) === 200, "relay restart readiness", 60_000);
        host = await hostControl(options.url, host);
        return { reconnect: host.online };
      });
      if (!relayRecovery?.reconnect) {
        blocked("disabled_tombstone_rejects_existing_host", "relay_graceful_restart_and_host_reconnect");
        if (!options.skipBackupRestore) blocked("mysql_backup_restore_preserves_tombstone", "relay_graceful_restart_and_host_reconnect");
        if (!options.skipCleanup) blocked("scheduled_30_day_cleanup", "relay_graceful_restart_and_host_reconnect");
        return;
      }
      const tombstone = await step("disabled_tombstone_rejects_existing_host", async () => {
        docker(options, ["exec", "-T", "relay", "node", "dist/admin.js", "route", "disable", host.routeId]);
        await waitClose(host, [1008], "host close after route disable");
        let rejected = false;
        try { await hostControl(options.url, host); } catch { rejected = true; }
        if (!rejected) throw new Error("disabled tombstone accepted a valid host secret");
        return { rejected };
      });
      if (!tombstone?.rejected) {
        if (!options.skipBackupRestore) blocked("mysql_backup_restore_preserves_tombstone", "disabled_tombstone_rejects_existing_host");
        if (!options.skipCleanup) blocked("scheduled_30_day_cleanup", "disabled_tombstone_rejects_existing_host");
        return;
      }
      if (!options.skipBackupRestore) await step("mysql_backup_restore_preserves_tombstone", () => backupRestore(options, host.routeId));
      if (!options.skipCleanup) await step("scheduled_30_day_cleanup", () => cleanupProof(options));
    } else {
      blocked("redis_fail_closed", "initial_host_ready");
      blocked("mysql_fail_closed", "initial_host_ready");
      blocked("relay_graceful_restart_and_host_reconnect", "initial_host_ready");
      blocked("disabled_tombstone_rejects_existing_host", "initial_host_ready");
      if (!options.skipBackupRestore) blocked("mysql_backup_restore_preserves_tombstone", "initial_host_ready");
      if (!options.skipCleanup) blocked("scheduled_30_day_cleanup", "initial_host_ready");
    }
  } catch (error) {
    recordFailure(report, "unhandled_runner_error", error);
  } finally {
    for (const ws of ownedSockets) { try { ws.terminate(); } catch { /* already gone */ } }
    await recoverServices(options, report);
    report.finishedAt = new Date().toISOString();
    await mkdir(path.dirname(options.report), { recursive: true });
    let serialized;
    try {
      serialized = serializeSafeFailureReport(report);
    } catch {
      report.status = "failed";
      report.steps = [];
      report.failures = [{ name: "report_safety_check", code: "unsafe_report_projection" }];
      report.recovery = report.recovery?.map(({ service, restored, code }) => ({ service, restored, ...(code ? { code } : {}) }));
      serialized = serializeSafeFailureReport(report);
    }
    await writeFile(options.report, serialized, { mode: 0o600 });
    activeReport = undefined;
    process.stdout.write(`${JSON.stringify({ status: report.status, report: options.report, steps: report.steps, recovery: report.recovery }, null, 2)}\n`);
    if (report.status !== "passed") process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write("relay failure harness failed before structured report finalization\n");
    process.exitCode = 2;
  });
}
