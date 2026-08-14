#!/usr/bin/env node
/**
 * Repeatable relay capacity runner.
 *
 * It intentionally creates one route per host control connection. That keeps
 * MAX_STREAMS_PER_ROUTE meaningful while exercising 5,000 independently
 * authenticated hosts and 1,000 independent client/host data pairs.
 *
 * This runner never treats a reduced invocation as a qualification pass. The
 * JSON report records the requested and achieved scale separately and is only
 * `passed` for the full 5k/1k, ten-minute, 8-vCPU/16-GiB environment.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const FULL_HOSTS = 5_000;
const FULL_STREAMS = 1_000;
const FULL_DURATION_SECONDS = 600;
const KIB = 1024;
const GIB = 1024 ** 3;
const HOST_HEARTBEAT_INTERVAL_MS = 8_000;
const HOST_HEARTBEAT_ACK_TIMEOUT_MS = 16_000;
const ROUTE_ID_DOMAIN = "prospero.relay.v1.route-id\\0";
const CREDENTIAL_DOMAIN = "prospero.relay.v1.device-credential\\0";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** All CLI artifact paths are repository-root relative, regardless of npm's workspace cwd. */
export function resolveRepositoryPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(REPOSITORY_ROOT, value);
}

// Like the fault harness, load artifacts are aggregate-only evidence.  Keep
// in-memory authentication and transport state out of persisted JSON by
// default-denying unknown fields and sensitive field names/value markers.
const LOAD_REPORT_KEYS = new Set([
  "schemaVersion", "kind", "status", "executionStatus", "qualificationStatus", "startedAt", "finishedAt",
  "qualification", "fullScaleInvocation", "dockerEightCpuSixteenGiBOrMore", "directBaseline", "reason", "value", "source", "errorCode",
  "target", "requested", "achieved", "hostControls", "activeDataPairs", "holdSeconds", "perDirectionBytesPerSecond", "burstBytes", "setupConcurrency", "burstSeconds", "drainMs",
  "hostEstablished", "hostFailed", "streamEstablished", "streamFailed", "unexpectedDisconnects", "hostHeartbeatsSent", "hostHeartbeatsAcked", "hostHeartbeatsMissed", "hostSuccessRate", "streamSuccessRate",
  "latency", "streamOpenMs", "relayRoundTripMs", "directBaselineRoundTripMs", "addedRttMs", "count", "p50", "p95", "p99", "max", "formula",
  "throughput", "clientToHostSent", "clientToHostReceived", "hostToClientSent", "hostToClientReceived", "clientContinuousSent", "clientBurstSent", "clientRttSent", "hostContinuousSent", "hostBurstSent", "hostRttEchoSent", "clientPayloadUnitsReceived", "hostPayloadUnitsReceived", "payloadIntegrityFailures", "ticksWithAllPairs", "ticksWithMissingPairs", "trafficElapsedSeconds", "clientToHostSentBytesPerSecond", "hostToClientSentBytesPerSecond", "relayForwardedBytes", "clientToHost", "hostToClient",
  "runtime", "relayCpuPercent", "relayRssPeakBytes", "relayOpenFdsPeak", "relayEventLoopLagP99Ms", "runnerEventLoopLagMs", "sendEvidence", "queuedWritePeakBytes", "sendCallbackErrors", "synchronousSendErrors", "pendingCallbacks", "drainCompleted", "metricSampleCount", "metricErrorCount",
  "environment", "node", "platform", "hostLogicalCpus", "hostMemoryBytes", "docker", "available", "cpus", "memoryBytes",
  "executionChecks", "qualificationChecks", "failures", "notes", "name", "expected", "actual", "pass", "code",
]);
const FORBIDDEN_LOAD_REPORT_KEY = /(?:host.?secret|token|ticket|credential|authorization|route.?id|(?:^|[_-])(?:ws|websocket|socket|frame|buffer)(?:$|[_-]))/i;
const FORBIDDEN_LOAD_REPORT_MARKER = /(?:host.?secret|token|ticket|credential|authorization|route.?id|\bws\b|websocket|socket|frame|buffer)/i;

function projectLoadReport(value, pathName = "report") {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (FORBIDDEN_LOAD_REPORT_MARKER.test(value)) throw new Error(`forbidden report marker at ${pathName}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => projectLoadReport(entry, `${pathName}[${index}]`));
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`non-plain report value at ${pathName}`);
  const projection = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!LOAD_REPORT_KEYS.has(key) || FORBIDDEN_LOAD_REPORT_KEY.test(key)) throw new Error(`report key is not allowlisted at ${pathName}`);
    projection[key] = projectLoadReport(entry, `${pathName}.${key}`);
  }
  return projection;
}

export function serializeSafeLoadReport(report) {
  return `${JSON.stringify(projectLoadReport(report), null, 2)}\n`;
}

function loadFailureCode(stage, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return "timeout";
  if (/closed|disconnect/i.test(message)) return "connection_closed";
  if (/integrity/i.test(message)) return "payload_integrity";
  if (/send/i.test(message)) return "send_failed";
  if (/metrics/i.test(stage)) return "metrics_failed";
  return "operation_failed";
}

function usage() {
  process.stderr.write(`Usage: node apps/relay/bench/load.mjs --url <ws[s]://relay> [options]\n\n` +
    `  --hosts <n>                 Host controls (default: ${FULL_HOSTS})\n` +
    `  --streams <n>               Active client/host data pairs (default: ${FULL_STREAMS})\n` +
    `  --duration-seconds <n>      Hold time after setup (default: ${FULL_DURATION_SECONDS})\n` +
    `  --concurrency <n>           Concurrent setup operations (default: 128)\n` +
    `  --metrics-url <http[s]://>  Internal /metrics URL (optional)\n` +
    `  --metrics-token <token>     Bearer token for metrics (optional)\n` +
    "  --direct-baseline-report <path>  Machine-readable direct-path RTT report\n" +
    `  --report <path>             JSON output (default: apps/relay/reports/latest-load-report.json)\n` +
    `  --burst-seconds <n>         256 KiB burst cadence (default: 30)\n` +
    "  --drain-ms <n>              Post-traffic delivery drain (default: 5000)\n" +
    `  --connect-timeout-ms <n>    Per socket deadline (default: 15000)\n`);
}

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg.slice(2), value);
    index += 1;
  }
  const integer = (name, fallback, minimum) => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`--${name} must be an integer >= ${minimum}`);
    return value;
  };
  const url = values.get("url");
  if (!url) throw new Error("--url is required");
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error("--url must use ws: or wss:");
  if (parsed.pathname !== "/" && parsed.pathname !== "") throw new Error("--url must be the relay origin without a path");
  const report = resolveRepositoryPath(values.get("report") ?? "apps/relay/reports/latest-load-report.json");
  return {
    url: url.replace(/\/$/, ""),
    hosts: integer("hosts", FULL_HOSTS, 1),
    streams: integer("streams", FULL_STREAMS, 1),
    durationSeconds: integer("duration-seconds", FULL_DURATION_SECONDS, 1),
    concurrency: integer("concurrency", 128, 1),
    burstSeconds: integer("burst-seconds", 30, 1),
    drainMs: integer("drain-ms", 5_000, 100),
    connectTimeoutMs: integer("connect-timeout-ms", 15_000, 100),
    metricsUrl: values.get("metrics-url"),
    metricsToken: values.get("metrics-token"),
    directBaselineReport: values.has("direct-baseline-report") ? resolveRepositoryPath(values.get("direct-baseline-report")) : undefined,
    report,
  };
}

function opaque(bytes) { return randomBytes(bytes).toString("base64url"); }
function routeIdFor(secret) {
  return createHash("sha256").update(ROUTE_ID_DOMAIN, "utf8").update(Buffer.from(secret, "base64url")).digest("base64url");
}
function credentialDigest(token) {
  return createHash("sha256").update(CREDENTIAL_DOMAIN, "utf8").update(token, "utf8").digest("base64url");
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}
function max(values) { return values.length === 0 ? null : Math.max(...values); }
function wireBytes(value) {
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((sum, part) => sum + part.length, 0);
  return Buffer.byteLength(value);
}
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Array.isArray(value)) return Buffer.concat(value);
  return Buffer.from(value);
}
function bufferedAmount(ws) {
  const value = ws?.bufferedAmount;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function command(command, args) {
  try { return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
function dockerEnvironment() {
  const raw = command("docker", ["info", "--format", "{{json .}}"]) ?? "";
  try {
    const info = JSON.parse(raw);
    return { available: true, cpus: Number(info.NCPU) || null, memoryBytes: Number(info.MemTotal) || null };
  } catch {
    return { available: false, cpus: null, memoryBytes: null };
  }
}
function metricValue(text, suffix) {
  let total = 0;
  let found = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{[^}]*\})?\s+([0-9.eE+-]+)$/);
    if (!match || !match[1].endsWith(suffix)) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) { total += value; found = true; }
  }
  return found ? total : null;
}
/** Parse the small Prometheus label subset emitted by this relay metric. */
export function metricValuesByDirection(text, suffix = "prospero_relay_forwarded_bytes_total") {
  const values = { client_to_host: null, host_to_client: null };
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)\{([^}]*)\}\s+([0-9.eE+-]+)$/);
    if (!match || match[1] !== suffix) continue;
    const direction = match[2].match(/(?:^|,)direction="(client_to_host|host_to_client)"(?:,|$)/)?.[1];
    const value = Number(match[3]);
    if (direction && Number.isFinite(value)) values[direction] = value;
  }
  return values;
}
export async function readDirectBaseline(reportPath) {
  if (!reportPath) return { value: null, errorCode: "not_supplied" };
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const value = report?.latency?.roundTripMs?.p95;
    if (!Number.isFinite(value) || value < 0) throw new Error("latency.roundTripMs.p95 must be a non-negative number");
    return { value, source: path.relative(REPOSITORY_ROOT, reportPath) || "." };
  } catch {
    return { value: null, errorCode: "invalid_or_unreadable", source: path.relative(REPOSITORY_ROOT, reportPath) || "." };
  }
}
async function sampleMetrics(options, samples, startedAt) {
  if (!options.metricsUrl) return;
  try {
    const headers = options.metricsToken ? { authorization: `Bearer ${options.metricsToken}` } : undefined;
    const response = await fetch(options.metricsUrl, { headers, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`metrics HTTP ${response.status}`);
    const text = await response.text();
    const forwarded = metricValuesByDirection(text);
    samples.push({
      atMs: Math.round(performance.now() - startedAt),
      cpuSeconds: metricValue(text, "process_cpu_seconds_total"),
      rssBytes: metricValue(text, "process_resident_memory_bytes"),
      openFds: metricValue(text, "process_open_fds"),
      eventLoopLagSeconds: metricValue(text, "nodejs_eventloop_lag_seconds"),
      eventLoopLagP99Seconds: metricValue(text, "nodejs_eventloop_lag_p99_seconds"),
      forwardedClientToHostBytes: forwarded.client_to_host,
      forwardedHostToClientBytes: forwarded.host_to_client,
    });
  } catch (error) {
    samples.push({ atMs: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message : String(error) });
  }
}

async function mapConcurrent(count, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= count) return;
      await operation(index);
    }
  });
  await Promise.all(workers);
}

function deadline(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

class Runner {
  constructor(options) {
    this.options = options;
    this.hosts = [];
    this.pairs = [];
    this.failures = [];
    this.openLatencies = [];
    this.rtts = [];
    this.metrics = [];
    this.eventLoopLagMs = [];
    this.bytes = { clientToHostSent: 0, clientToHostReceived: 0, hostToClientSent: 0, hostToClientReceived: 0 };
    this.counts = { hostEstablished: 0, hostFailed: 0, streamEstablished: 0, streamFailed: 0, unexpectedDisconnects: 0 };
    this.traffic = {
      clientContinuousSent: 0, clientBurstSent: 0, clientRttSent: 0,
      hostContinuousSent: 0, hostBurstSent: 0, hostRttEchoSent: 0,
      clientPayloadUnitsReceived: 0, hostPayloadUnitsReceived: 0,
      payloadIntegrityFailures: 0, ticksWithAllPairs: 0, ticksWithMissingPairs: 0,
    };
    this.sendEvidence = { queuedWritePeakBytes: 0, sendCallbackErrors: 0, synchronousSendErrors: 0, pendingCallbacks: 0, drainCompleted: false };
    this.trafficStartedAt = null;
    this.trafficEndedAt = null;
    this.heartbeatTimer = undefined;
    this.hostHeartbeatsSent = 0;
    this.hostHeartbeatsAcked = 0;
    this.hostHeartbeatsMissed = 0;
    this.stopping = false;
  }

  failure(stage, error) {
    if (this.failures.length < 100) this.failures.push({ code: loadFailureCode(stage, error) });
  }

  send(ws, payload, direction, stage) {
    this.sendEvidence.queuedWritePeakBytes = Math.max(this.sendEvidence.queuedWritePeakBytes, bufferedAmount(ws));
    try {
      this.sendEvidence.pendingCallbacks += 1;
      ws.send(payload, { binary: true, compress: false }, (error) => {
        this.sendEvidence.pendingCallbacks -= 1;
        this.sendEvidence.queuedWritePeakBytes = Math.max(this.sendEvidence.queuedWritePeakBytes, bufferedAmount(ws));
        if (error) {
          this.sendEvidence.sendCallbackErrors += 1;
          this.failure(`${stage}:send-callback`, error);
        }
      });
      this.sendEvidence.queuedWritePeakBytes = Math.max(this.sendEvidence.queuedWritePeakBytes, bufferedAmount(ws));
      return true;
    } catch (error) {
      this.sendEvidence.synchronousSendErrors += 1;
      this.failure(`${stage}:send`, error);
      return false;
    }
  }

  sendControl(ws, control, stage) {
    this.sendEvidence.queuedWritePeakBytes = Math.max(this.sendEvidence.queuedWritePeakBytes, bufferedAmount(ws));
    try {
      this.sendEvidence.pendingCallbacks += 1;
      ws.send(JSON.stringify(control), { binary: false, compress: false }, (error) => {
        this.sendEvidence.pendingCallbacks -= 1;
        this.sendEvidence.queuedWritePeakBytes = Math.max(this.sendEvidence.queuedWritePeakBytes, bufferedAmount(ws));
        if (error) {
          this.sendEvidence.sendCallbackErrors += 1;
          this.failure(`${stage}:send-callback`, error);
        }
      });
      this.sendEvidence.queuedWritePeakBytes = Math.max(this.sendEvidence.queuedWritePeakBytes, bufferedAmount(ws));
      return true;
    } catch (error) {
      this.sendEvidence.synchronousSendErrors += 1;
      this.failure(`${stage}:send`, error);
      return false;
    }
  }

  sendHostHeartbeats() {
    const now = performance.now();
    for (const host of this.hosts) {
      if (!host?.online || host.ws.readyState !== WebSocket.OPEN) continue;
      if (host.heartbeatAckDeadline !== undefined) {
        if (now >= host.heartbeatAckDeadline) {
          this.hostHeartbeatsMissed += 1;
          host.heartbeatAckDeadline = undefined;
          this.failure(`host-heartbeat-timeout:${host.index}`, new Error("heartbeat acknowledgement timed out"));
        } else continue;
      }
      if (this.sendControl(host.ws, { type: "host.heartbeat", v: 1, generation: 1 }, `host-heartbeat:${host.index}`)) {
        host.heartbeatAckDeadline = now + HOST_HEARTBEAT_ACK_TIMEOUT_MS;
        this.hostHeartbeatsSent += 1;
      }
    }
  }

  validatePayload(body, expectedDirection) {
    const validSize = body.length === 4 * KIB || body.length === 256 * KIB;
    const valid = validSize && body.subarray(0, 4).toString("ascii") === "T8LD" && body[4] === expectedDirection;
    if (!valid) this.traffic.payloadIntegrityFailures += 1;
    return valid;
  }

  payload(size, direction, sequence) {
    const payload = Buffer.alloc(size, sequence & 0xff);
    payload.write("T8LD", 0, "ascii");
    payload[4] = direction;
    payload.writeUInt32BE(sequence >>> 0, 5);
    return payload;
  }

  async socket(pathname) {
    const ws = new WebSocket(`${this.options.url}${pathname}`, { perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
    await deadline(new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("close", (code) => reject(new Error(`${pathname} closed during open (${code})`)));
    }), this.options.connectTimeoutMs, `${pathname} connect`);
    return ws;
  }

  async openHost(index) {
    const hostSecret = opaque(32);
    const host = {
      index,
      routeId: routeIdFor(hostSecret),
      hostSecret,
      deviceId: opaque(16),
      token: opaque(32),
      ws: undefined,
      online: false,
      streams: new Map(),
      heartbeatAckDeadline: undefined,
      readyResolve: undefined,
      readyReject: undefined,
    };
    const ready = new Promise((resolve, reject) => { host.readyResolve = resolve; host.readyReject = reject; });
    try {
      const ws = await this.socket("/v1/host");
      host.ws = ws;
      ws.on("message", (raw, binary) => this.onHostMessage(host, raw, binary));
      ws.once("error", (error) => { if (!this.stopping && !host.online) host.readyReject?.(error); });
      ws.once("close", (code) => {
        if (!this.stopping) {
          if (host.online) this.counts.unexpectedDisconnects += 1;
          else host.readyReject?.(new Error(`host control closed (${code})`));
        }
        host.online = false;
      });
      ws.send(JSON.stringify({ v: 1, routeId: host.routeId, hostSecret }));
      ws.send(JSON.stringify({ type: "host.device-sync", v: 1, generation: 1, credentials: [{ deviceId: host.deviceId, credentialDigest: credentialDigest(host.token) }] }));
      await deadline(ready, this.options.connectTimeoutMs, `host ${index} ready`);
      host.online = true;
      this.hosts[index] = host;
      this.counts.hostEstablished += 1;
    } catch (error) {
      this.counts.hostFailed += 1;
      this.failure(`host:${index}`, error);
      host.ws?.terminate();
    }
  }

  async onHostMessage(host, raw, binary) {
    if (binary) return;
    let message;
    try { message = JSON.parse(toBuffer(raw).toString("utf8")); }
    catch { return; }
    if (message.type === "host.ready" && message.generation === 1) {
      host.readyResolve?.();
      return;
    }
    if (message.type === "host.heartbeat.ack") {
      if (message.generation === 1 && host.heartbeatAckDeadline !== undefined) {
        host.heartbeatAckDeadline = undefined;
        this.hostHeartbeatsAcked += 1;
      } else if (message.generation !== 1) {
        this.hostHeartbeatsMissed += 1;
        this.failure(`host-heartbeat-generation:${host.index}`, new Error("unexpected heartbeat acknowledgement generation"));
      }
      return;
    }
    if (message.type === "error") {
      host.readyReject?.(new Error(`host error: ${message.code ?? "unknown"}`));
      return;
    }
    if (message.type === "stream.offer") {
      try { await this.acceptOffer(host, message); }
      catch (error) { this.failure(`stream-accept:${host.index}`, error); }
    }
  }

  async acceptOffer(host, offer) {
    const ws = await this.socket("/v1/stream");
    const data = { ws, ready: false };
    host.streams.set(offer.streamId, data);
    ws.on("message", (raw, binary) => {
      if (!data.ready) {
        if (!binary) {
          try {
            const message = JSON.parse(toBuffer(raw).toString("utf8"));
            if (message.type === "stream.ready" && message.streamId === offer.streamId) data.ready = true;
          } catch { /* close below on an invalid setup reply */ }
        }
        return;
      }
      const body = toBuffer(raw);
      this.bytes.clientToHostReceived += wireBytes(raw);
      if (body.subarray(0, 4).toString("ascii") === "RTT:") {
        if (this.send(ws, body, "host_to_client", `host-rtt:${host.index}`)) {
          this.bytes.hostToClientSent += body.length;
          this.traffic.hostRttEchoSent += body.length;
        }
      } else if (this.validatePayload(body, 0x43)) {
        this.traffic.hostPayloadUnitsReceived += 1;
      }
    });
    ws.once("close", () => {
      host.streams.delete(offer.streamId);
      if (!this.stopping && data.ready) this.counts.unexpectedDisconnects += 1;
    });
    ws.once("error", (error) => { if (!this.stopping) this.failure(`stream-socket:${host.index}`, error); });
    ws.send(JSON.stringify({ type: "stream.accept", v: 1, streamId: offer.streamId, ticket: offer.ticket }));
    await deadline(new Promise((resolve, reject) => {
      const poll = () => data.ready ? resolve() : ws.readyState === WebSocket.CLOSED ? reject(new Error("host stream closed before ready")) : setTimeout(poll, 2);
      poll();
    }), this.options.connectTimeoutMs, `host stream ${host.index} ready`);
    return data;
  }

  async openPair(index) {
    const host = this.hosts[index];
    if (!host?.online) { this.counts.streamFailed += 1; this.failure(`pair:${index}`, new Error("corresponding host is unavailable")); return; }
    const started = performance.now();
    let ws;
    try {
      ws = await this.socket("/v1/client");
      const pair = { index, host, ws, streamId: undefined, ready: false, rttSent: new Map() };
      const ready = new Promise((resolve, reject) => {
        ws.on("message", (raw, binary) => {
          if (!pair.ready) {
            if (binary) { reject(new Error("binary control reply")); return; }
            try {
              const message = JSON.parse(toBuffer(raw).toString("utf8"));
              if (message.type === "client.status") { pair.streamId = message.streamId; return; }
              if (message.type === "stream.ready") { pair.streamId ??= message.streamId; pair.ready = true; resolve(); return; }
              if (message.type === "error" || message.type === "stream.close") { reject(new Error(`client control: ${message.code ?? message.type}`)); }
            } catch { reject(new Error("invalid client control reply")); }
            return;
          }
          const body = toBuffer(raw);
          this.bytes.hostToClientReceived += wireBytes(raw);
          const key = body.subarray(0, 4).toString("ascii") === "RTT:" ? body.toString("utf8") : undefined;
          if (key) {
            const sentAt = pair.rttSent.get(key);
            if (sentAt !== undefined) {
              pair.rttSent.delete(key);
              this.rtts.push(performance.now() - sentAt);
            }
          } else if (this.validatePayload(body, 0x48)) {
            this.traffic.clientPayloadUnitsReceived += 1;
          }
        });
      });
      ws.once("close", (code) => {
        if (!this.stopping && pair.ready) this.counts.unexpectedDisconnects += 1;
        if (!pair.ready) this.failure(`client-close:${index}`, new Error(`closed before ready (${code})`));
      });
      ws.once("error", (error) => { if (!this.stopping) this.failure(`client-socket:${index}`, error); });
      ws.send(JSON.stringify({ type: "client.open", v: 1, routeId: host.routeId, deviceId: host.deviceId, token: host.token }));
      await deadline(ready, this.options.connectTimeoutMs, `stream ${index} ready`);
      await deadline(new Promise((resolve, reject) => {
        const waitForHostData = () => {
          const data = pair.streamId === undefined ? undefined : host.streams.get(pair.streamId);
          if (data?.ready) resolve();
          else if (ws.readyState === WebSocket.CLOSED) reject(new Error("client closed before host data stream was ready"));
          else setTimeout(waitForHostData, 2);
        };
        waitForHostData();
      }), this.options.connectTimeoutMs, `host data stream ${index} ready`);
      this.openLatencies.push(performance.now() - started);
      this.pairs[index] = pair;
      this.counts.streamEstablished += 1;
    } catch (error) {
      this.counts.streamFailed += 1;
      this.failure(`pair:${index}`, error);
      ws?.terminate();
    }
  }

  sendTraffic(second) {
    let readyPairs = 0;
    for (const pair of this.pairs) {
      if (!pair?.ready || pair.ws.readyState !== WebSocket.OPEN) continue;
      const hostData = pair.host.streams.get(pair.streamId);
      if (!hostData?.ready || hostData.ws.readyState !== WebSocket.OPEN) continue;
      readyPairs += 1;
      const clientContinuous = this.payload(4 * KIB, 0x43, second);
      const hostContinuous = this.payload(4 * KIB, 0x48, second);
      if (this.send(pair.ws, clientContinuous, "client_to_host", `client-continuous:${pair.index}`)) {
        this.bytes.clientToHostSent += clientContinuous.length;
        this.traffic.clientContinuousSent += clientContinuous.length;
      }
      if (this.send(hostData.ws, hostContinuous, "host_to_client", `host-continuous:${pair.index}`)) {
        this.bytes.hostToClientSent += hostContinuous.length;
        this.traffic.hostContinuousSent += hostContinuous.length;
      }
      const ping = `RTT:${opaque(12)}`;
      pair.rttSent.set(ping, performance.now());
      const pingBytes = Buffer.from(ping, "utf8");
      if (this.send(pair.ws, pingBytes, "client_to_host", `client-rtt:${pair.index}`)) {
        this.bytes.clientToHostSent += pingBytes.length;
        this.traffic.clientRttSent += pingBytes.length;
      }
      if (second > 0 && second % this.options.burstSeconds === 0) {
        const clientBurst = this.payload(256 * KIB, 0x43, second);
        const hostBurst = this.payload(256 * KIB, 0x48, second);
        if (this.send(pair.ws, clientBurst, "client_to_host", `client-burst:${pair.index}`)) {
          this.bytes.clientToHostSent += clientBurst.length;
          this.traffic.clientBurstSent += clientBurst.length;
        }
        if (this.send(hostData.ws, hostBurst, "host_to_client", `host-burst:${pair.index}`)) {
          this.bytes.hostToClientSent += hostBurst.length;
          this.traffic.hostBurstSent += hostBurst.length;
        }
      }
    }
    if (readyPairs === this.counts.streamEstablished) this.traffic.ticksWithAllPairs += 1;
    else this.traffic.ticksWithMissingPairs += 1;
  }

  async drainTraffic() {
    const deadlineAt = performance.now() + this.options.drainMs;
    while (performance.now() < deadlineAt) {
      const buffered = [
        ...this.pairs.map((pair) => bufferedAmount(pair?.ws)),
        ...this.hosts.flatMap((host) => [...(host?.streams.values() ?? [])].map((data) => bufferedAmount(data.ws))),
      ];
      this.sendEvidence.queuedWritePeakBytes = Math.max(this.sendEvidence.queuedWritePeakBytes, ...buffered);
      const delivered = this.bytes.clientToHostSent === this.bytes.clientToHostReceived && this.bytes.hostToClientSent === this.bytes.hostToClientReceived;
      if (delivered && this.sendEvidence.pendingCallbacks === 0 && buffered.every((value) => value === 0)) {
        this.sendEvidence.drainCompleted = true;
        return;
      }
      await sleep(20);
    }
    this.failure("traffic-drain", new Error("timed out waiting for bidirectional delivery, callbacks, and bufferedAmount to drain"));
  }

  async run() {
    this.startedAt = performance.now();
    const monitor = setInterval(() => void sampleMetrics(this.options, this.metrics, this.startedAt), 1_000);
    let lagMonitor;
    try {
      await sampleMetrics(this.options, this.metrics, this.startedAt);
      await mapConcurrent(this.options.hosts, this.options.concurrency, async (index) => this.openHost(index));
      // Relay host presence is intentionally fail-closed after 45s without a
      // heartbeat.  A long-running capacity test must exercise the real host
      // maintenance contract instead of silently allowing those controls to expire.
      this.sendHostHeartbeats();
      this.heartbeatTimer = setInterval(() => this.sendHostHeartbeats(), HOST_HEARTBEAT_INTERVAL_MS);
      await mapConcurrent(Math.min(this.options.streams, this.hosts.length), this.options.concurrency, async (index) => this.openPair(index));
      this.trafficStartedAt = performance.now();
      // Startup naturally creates short scheduling stalls.  Report runner
      // event-loop lag only for the same hold window used by throughput.
      let expectedTick = performance.now() + 1_000;
      lagMonitor = setInterval(() => {
        const now = performance.now();
        this.eventLoopLagMs.push(Math.max(0, now - expectedTick));
        expectedTick += 1_000;
      }, 1_000);
      for (let second = 1; second <= this.options.durationSeconds; second += 1) {
        this.sendTraffic(second);
        await sleep(1_000);
      }
      this.trafficEndedAt = performance.now();
      await this.drainTraffic();
      await sampleMetrics(this.options, this.metrics, this.startedAt);
    } finally {
      clearInterval(monitor);
      if (lagMonitor !== undefined) clearInterval(lagMonitor);
      if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
      this.stopping = true;
      for (const pair of this.pairs) pair?.ws.terminate();
      for (const host of this.hosts) {
        for (const data of host?.streams.values() ?? []) data.ws.terminate();
        host?.ws?.terminate();
      }
    }
  }
}

function metricDelta(samples, field) {
  const values = samples.map((sample) => sample[field]).filter((value) => typeof value === "number");
  return values.length >= 2 ? values.at(-1) - values[0] : null;
}

export function buildReport(options, runner, environment, startedAt, baseline) {
  const trafficElapsedSeconds = runner.trafficStartedAt !== null && runner.trafficEndedAt !== null
    ? Math.max(0.001, (runner.trafficEndedAt - runner.trafficStartedAt) / 1_000)
    : 0;
  const rssValues = runner.metrics.map((sample) => sample.rssBytes).filter((value) => typeof value === "number");
  const fdValues = runner.metrics.map((sample) => sample.openFds).filter((value) => typeof value === "number");
  const lagValues = runner.metrics.map((sample) => sample.eventLoopLagP99Seconds ?? sample.eventLoopLagSeconds).filter((value) => typeof value === "number");
  const cpuSamples = runner.metrics.filter((sample) => typeof sample.cpuSeconds === "number" && typeof sample.atMs === "number");
  let cpuPercent = null;
  if (cpuSamples.length >= 2) {
    const first = cpuSamples[0]; const last = cpuSamples.at(-1);
    cpuPercent = ((last.cpuSeconds - first.cpuSeconds) / ((last.atMs - first.atMs) / 1_000)) * 100;
  }
  const fullScale = options.hosts === FULL_HOSTS && options.streams === FULL_STREAMS && options.durationSeconds >= FULL_DURATION_SECONDS;
  const resourceSufficient = environment.docker.available && environment.docker.cpus >= 8 && environment.docker.memoryBytes >= 16 * GIB;
  const openP95 = percentile(runner.openLatencies, 0.95);
  const relayRoundTripP95 = percentile(runner.rtts, 0.95);
  const addedRttP95 = relayRoundTripP95 === null || baseline.value === null ? null : relayRoundTripP95 - baseline.value;
  const activePairs = runner.counts.streamEstablished;
  const expectedContinuousBytes = activePairs * 4 * KIB * options.durationSeconds;
  const expectedBurstBytes = activePairs * 256 * KIB * Math.floor(options.durationSeconds / options.burstSeconds);
  const expectedPayloadUnits = activePairs * (options.durationSeconds + Math.floor(options.durationSeconds / options.burstSeconds));
  const trafficChecks = [
    { name: "continuous_client_to_host_4_kib_per_second", expected: expectedContinuousBytes, actual: runner.traffic.clientContinuousSent, pass: runner.traffic.clientContinuousSent === expectedContinuousBytes },
    { name: "continuous_host_to_client_4_kib_per_second", expected: expectedContinuousBytes, actual: runner.traffic.hostContinuousSent, pass: runner.traffic.hostContinuousSent === expectedContinuousBytes },
    { name: "periodic_client_to_host_256_kib_bursts", expected: expectedBurstBytes, actual: runner.traffic.clientBurstSent, pass: runner.traffic.clientBurstSent === expectedBurstBytes },
    { name: "periodic_host_to_client_256_kib_bursts", expected: expectedBurstBytes, actual: runner.traffic.hostBurstSent, pass: runner.traffic.hostBurstSent === expectedBurstBytes },
    { name: "client_to_host_delivery_exact_after_drain", expected: runner.bytes.clientToHostSent, actual: runner.bytes.clientToHostReceived, pass: runner.sendEvidence.drainCompleted && runner.bytes.clientToHostSent === runner.bytes.clientToHostReceived },
    { name: "host_to_client_delivery_exact_after_drain", expected: runner.bytes.hostToClientSent, actual: runner.bytes.hostToClientReceived, pass: runner.sendEvidence.drainCompleted && runner.bytes.hostToClientSent === runner.bytes.hostToClientReceived },
    { name: "payload_integrity", expected: 0, actual: runner.traffic.payloadIntegrityFailures, pass: runner.traffic.payloadIntegrityFailures === 0 && runner.traffic.clientPayloadUnitsReceived === expectedPayloadUnits && runner.traffic.hostPayloadUnitsReceived === expectedPayloadUnits },
    { name: "all_active_pairs_sent_each_tick", expected: options.durationSeconds, actual: runner.traffic.ticksWithAllPairs, pass: runner.traffic.ticksWithAllPairs === options.durationSeconds && runner.traffic.ticksWithMissingPairs === 0 },
    { name: "send_callbacks_and_queued_writes_drained", expected: 0, actual: runner.sendEvidence.sendCallbackErrors + runner.sendEvidence.synchronousSendErrors + runner.sendEvidence.pendingCallbacks, pass: runner.sendEvidence.drainCompleted && runner.sendEvidence.sendCallbackErrors === 0 && runner.sendEvidence.synchronousSendErrors === 0 && runner.sendEvidence.pendingCallbacks === 0 },
  ];
  const executionChecks = [
    { name: "requested_host_controls_established", expected: options.hosts, actual: runner.counts.hostEstablished, pass: runner.counts.hostEstablished === options.hosts },
    { name: "requested_data_pairs_established", expected: options.streams, actual: runner.counts.streamEstablished, pass: runner.counts.streamEstablished === options.streams },
    { name: "unexpected_disconnects_zero", expected: 0, actual: runner.counts.unexpectedDisconnects, pass: runner.counts.unexpectedDisconnects === 0 },
    { name: "host_heartbeat_acknowledgements", expected: runner.hostHeartbeatsSent ?? 0, actual: runner.hostHeartbeatsAcked ?? 0, pass: (runner.hostHeartbeatsSent ?? 0) === (runner.hostHeartbeatsAcked ?? 0) },
    { name: "host_heartbeat_misses_zero", expected: 0, actual: runner.hostHeartbeatsMissed ?? 0, pass: (runner.hostHeartbeatsMissed ?? 0) === 0 },
    { name: "harness_failures_zero", expected: 0, actual: runner.failures.length, pass: runner.failures.length === 0 },
    ...trafficChecks,
  ];
  const executionStatus = executionChecks.every((check) => check.pass) ? "passed" : "failed";
  const qualificationChecks = [
    { name: "full_5k_host_controls", expected: FULL_HOSTS, actual: runner.counts.hostEstablished, pass: runner.counts.hostEstablished === FULL_HOSTS },
    { name: "full_1k_active_data_pairs", expected: FULL_STREAMS, actual: runner.counts.streamEstablished, pass: runner.counts.streamEstablished === FULL_STREAMS },
    { name: "hold_duration_seconds", expected: FULL_DURATION_SECONDS, actual: options.durationSeconds, pass: options.durationSeconds >= FULL_DURATION_SECONDS },
    { name: "docker_8_vcpu_16_gib", expected: { cpus: 8, memoryBytes: 16 * GIB }, actual: environment.docker, pass: resourceSufficient },
    { name: "stream_open_p95_ms_lt_500", expected: 500, actual: openP95, pass: openP95 !== null && openP95 < 500 },
    { name: "direct_baseline_present", expected: "latency.roundTripMs.p95", actual: baseline.value, pass: baseline.value !== null },
    { name: "added_rtt_p95_ms_lt_100", expected: 100, actual: addedRttP95, pass: addedRttP95 !== null && addedRttP95 < 100 },
    { name: "unexpected_disconnects_zero", expected: 0, actual: runner.counts.unexpectedDisconnects, pass: runner.counts.unexpectedDisconnects === 0 },
    { name: "relay_rss_peak_lt_2_gib", expected: 2 * GIB, actual: max(rssValues), pass: rssValues.length > 0 && max(rssValues) < 2 * GIB },
    { name: "relay_metrics_collected", expected: true, actual: runner.metrics.some((sample) => sample.rssBytes !== null && sample.openFds !== null), pass: runner.metrics.some((sample) => sample.rssBytes !== null && sample.openFds !== null) && runner.metrics.every((sample) => !sample.error) },
  ];
  const qualificationStatus = executionStatus === "failed" || (fullScale && resourceSufficient && qualificationChecks.some((check) => !check.pass))
    ? "failed"
    : fullScale && resourceSufficient && qualificationChecks.every((check) => check.pass) ? "passed" : "inconclusive";
  return {
    schemaVersion: 1,
    kind: "prospero-relay-load-report",
    status: qualificationStatus,
    executionStatus,
    qualificationStatus,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    qualification: {
      fullScaleInvocation: fullScale,
      dockerEightCpuSixteenGiBOrMore: resourceSufficient,
      directBaseline: baseline,
      reason: !resourceSufficient ? "Docker engine does not expose the required 8 vCPU / 16 GiB capacity" : !fullScale ? "invocation is intentionally below the required 5k/1k/10-minute threshold" : baseline.value === null ? "full qualification requires a machine-readable direct baseline report" : undefined,
    },
    target: { hostControls: FULL_HOSTS, activeDataPairs: FULL_STREAMS, holdSeconds: FULL_DURATION_SECONDS, perDirectionBytesPerSecond: 4 * KIB, burstBytes: 256 * KIB },
    requested: { hostControls: options.hosts, activeDataPairs: options.streams, holdSeconds: options.durationSeconds, setupConcurrency: options.concurrency, burstSeconds: options.burstSeconds, drainMs: options.drainMs },
    achieved: { ...runner.counts, hostHeartbeatsSent: runner.hostHeartbeatsSent ?? 0, hostHeartbeatsAcked: runner.hostHeartbeatsAcked ?? 0, hostHeartbeatsMissed: runner.hostHeartbeatsMissed ?? 0, hostSuccessRate: runner.counts.hostEstablished / options.hosts, streamSuccessRate: runner.counts.streamEstablished / options.streams },
    latency: { streamOpenMs: { count: runner.openLatencies.length, p50: percentile(runner.openLatencies, 0.5), p95: openP95, p99: percentile(runner.openLatencies, 0.99), max: max(runner.openLatencies) }, relayRoundTripMs: { count: runner.rtts.length, p50: percentile(runner.rtts, 0.5), p95: relayRoundTripP95, p99: percentile(runner.rtts, 0.99), max: max(runner.rtts) }, directBaselineRoundTripMs: baseline.value === null ? null : { p95: baseline.value, source: baseline.source }, addedRttMs: { p95: addedRttP95, formula: "relayRoundTripMs.p95 - directBaselineRoundTripMs.p95" } },
    throughput: { ...runner.bytes, ...runner.traffic, trafficElapsedSeconds, clientToHostSentBytesPerSecond: trafficElapsedSeconds === 0 ? null : runner.bytes.clientToHostSent / trafficElapsedSeconds, hostToClientSentBytesPerSecond: trafficElapsedSeconds === 0 ? null : runner.bytes.hostToClientSent / trafficElapsedSeconds, relayForwardedBytes: { clientToHost: metricDelta(runner.metrics, "forwardedClientToHostBytes"), hostToClient: metricDelta(runner.metrics, "forwardedHostToClientBytes") } },
    runtime: { relayCpuPercent: cpuPercent, relayRssPeakBytes: max(rssValues), relayOpenFdsPeak: max(fdValues), relayEventLoopLagP99Ms: max(lagValues) === null ? null : max(lagValues) * 1_000, runnerEventLoopLagMs: { p95: percentile(runner.eventLoopLagMs, 0.95), max: max(runner.eventLoopLagMs) }, sendEvidence: runner.sendEvidence, metricSampleCount: runner.metrics.length, metricErrorCount: runner.metrics.filter((sample) => sample.error).length },
    environment: { node: process.version, platform: `${process.platform}/${process.arch}`, hostLogicalCpus: os.cpus().length, hostMemoryBytes: os.totalmem(), docker: environment.docker },
    executionChecks,
    qualificationChecks,
    failures: runner.failures,
    notes: ["`addedRttMs` is only calculated from the supplied direct baseline; raw relay round-trip is never used as an added-RTT substitute.", "Report contains aggregate counters and safe projections only."],
  };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { usage(); throw error; }
  if (options.help) { usage(); return; }
  if (options.streams > options.hosts) throw new Error("--streams cannot exceed --hosts because this harness opens one stream per host route");
  const startedAt = Date.now();
  const environment = { docker: dockerEnvironment() };
  const runner = new Runner(options);
  try { await runner.run(); }
  catch (error) { runner.failure("runner", error); }
  const baseline = await readDirectBaseline(options.directBaselineReport);
  const report = buildReport(options, runner, environment, startedAt, baseline);
  await mkdir(path.dirname(options.report), { recursive: true });
  let serialized;
  try {
    serialized = serializeSafeLoadReport(report);
  } catch {
    const safetyFailure = {
      schemaVersion: 1,
      kind: "prospero-relay-load-report",
      status: "failed",
      executionStatus: "failed",
      qualificationStatus: "failed",
      startedAt: report.startedAt,
      finishedAt: new Date().toISOString(),
      failures: [{ code: "unsafe_report_projection" }],
      notes: ["Report safety validation rejected an unsafe projection."],
    };
    serialized = serializeSafeLoadReport(safetyFailure);
  }
  await writeFile(options.report, serialized, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, executionStatus: report.executionStatus, qualificationStatus: report.qualificationStatus, report: options.report, achieved: report.achieved, executionChecks: report.executionChecks, qualificationChecks: report.qualificationChecks }, null, 2)}\n`);
  if (report.executionStatus === "failed" || report.qualificationStatus === "failed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(async (error) => {
  process.stderr.write(`relay load harness failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 2;
});
