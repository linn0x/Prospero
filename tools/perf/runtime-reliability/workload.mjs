import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const profile = option("--profile") ?? "diagnostic";
assert.ok(["diagnostic", "24h", "72h"].includes(profile));
const concurrency = Number(option("--concurrency") ?? 40);
assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 40);
const duration = profile === "24h" ? 86_400 : profile === "72h" ? 259_200 : Number(option("--duration-seconds") ?? 60);
assert.ok(Number.isFinite(duration) && duration > 0);
if (profile !== "diagnostic") assert.equal(option("--duration-seconds"), undefined);
const maxCycles = Number(option("--max-cycles") ?? Infinity);
if (profile !== "diagnostic") assert.equal(option("--max-cycles"), undefined);
const runtime = path.resolve(option("--runtime-dir") ?? path.join(root, "target/debug"));
const binary = name => path.join(runtime, name);
for (const name of ["prosperod-rs", "prospero", "prospero-execution-host", "prospero-budget-host"]) assert.ok(existsSync(binary(name)), `missing built runtime ${name}`);
if (process.platform === "win32") throw new Error("hosted workload acceptance is currently Unix only");
const output = option("--output-dir") ? path.resolve(option("--output-dir")) : mkdtempSync(path.join(os.tmpdir(), "prospero-runtime-workload-"));
if (!existsSync(output)) mkdirSync(output, { mode: 0o700 });
const home = path.join(output, "isolated-home");
const directory = path.join(home, "daemon");
const budget = path.join(home, "budget");
const workspaces = path.join(output, "workspaces");
for (const entry of [home, directory, workspaces]) mkdirSync(entry, { mode: 0o700 });
const fake = path.join(output, "fake-native-claude.py");
writeFileSync(fake, `#!/usr/bin/env python3
import json, os, subprocess, sys, time
print(json.dumps({"type":"system","subtype":"init","session_id":"workload-fake-native"}), flush=True)
for line in sys.stdin:
    if json.loads(line).get("type") != "user":
        continue
    identity=json.loads(os.environ["PROSPERO_EXECUTION_IDENTITY_JSON"])
    time.sleep(0.1)
    result=subprocess.run([os.environ["PROSPERO_W09_CONTROL_BIN"],"task","done","--id",identity["taskId"],"--body","deterministic workload deliverable"],text=True,capture_output=True,timeout=15)
    if result.returncode != 0:
        print(result.stderr[:4096], file=sys.stderr, flush=True)
        sys.exit(result.returncode)
    print(json.dumps({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"durable fixture delivery submitted"}]}}),flush=True)
    while True:
        time.sleep(1)
`, { mode: 0o700 });
chmodSync(fake, 0o700);
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
const environment = {
  ...process.env, HOME: home, USERPROFILE: home, PROSPERO_HOME: home,
  PROSPERO_EXECUTION_MODE: "hosted", PROSPERO_CLAUDE_BIN: fake,
  PROSPERO_EXECUTION_HOST_BINARY: binary("prospero-execution-host"),
  PROSPERO_EXECUTION_BUDGET_BINARY: binary("prospero-budget-host"),
  PROSPERO_EXECUTION_BUDGET_DIR: budget, PROSPERO_EXECUTION_BUDGET_CAPACITY: String(concurrency),
  PROSPERO_W09_CONTROL_BIN: binary("prospero"),
};
const child = spawn(binary("prosperod-rs"), ["serve", "--data-dir", directory], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
let daemonExit;
let diagnostics = "";
child.on("error", error => { daemonExit = { error: error.message }; });
child.on("exit", (code, signal) => { daemonExit = { code, signal }; });
for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-64 * 1024); });
const started = Date.now();
const finish = started + duration * 1000;
let connection;
let accepted = 0;
let completed = 0;
let failed = 0;
let active = 0;
let maxActive = 0;
let maxRssKb = 0;
let maxProcesses = 0;
let samples = 0;
let maxBudgetHeld = 0;
let fatal;
let finalBudget;
let remainingHostSockets;
const failures = [];
const hosts = new Set();
const latencies = Array(8).fill(0);
const bounds = [100, 250, 500, 1000, 2000, 5000, 10_000, Infinity];
let sampler;
let samplingBudget = false;
const logBytes = new Map();
let droppedLogBytes = 0;
function appendLog(name, value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const used = logBytes.get(name) ?? 0;
  if (used + bytes.length > 64 * 1024 * 1024) { droppedLogBytes += bytes.length; return; }
  appendFileSync(path.join(output, name), bytes);
  logBytes.set(name, used + bytes.length);
}
try {
  connection = await waitFor(async () => {
    if (daemonExit) throw new Error(`test daemon exited before ready: ${JSON.stringify(daemonExit)} ${diagnostics}`);
    if (!existsSync(path.join(directory, "connection.json"))) return;
    const state = JSON.parse(readFileSync(path.join(directory, "connection.json"), "utf8"));
    if (state.pid !== child.pid) return;
    try { await request(state, "/v1/health"); return state; } catch { return; }
  }, 25_000);
  sampler = setInterval(() => {
    try { sample(); } catch (error) { fatal ??= error; stopping = true; }
    if (!samplingBudget && existsSync(path.join(budget, "manifest.json"))) {
      samplingBudget = true;
      budgetRequest("health").then(response => {
        assert.equal(response.responseType, "health");
        maxBudgetHeld = Math.max(maxBudgetHeld, response.status.held + response.status.quarantined);
        assert.ok(maxBudgetHeld <= concurrency, "shared budget exceeded capacity");
        appendLog("budget.jsonl", { timestamp: new Date().toISOString(), ...response.status });
      }).catch(error => { fatal ??= error; stopping = true; }).finally(() => { samplingBudget = false; });
    }
  }, profile === "diagnostic" ? 1000 : 5000);
  await Promise.all(Array.from({ length: concurrency }, (_, lane) => worker(lane)));
  await waitFor(async () => {
    const status = await budgetRequest("health");
    maxBudgetHeld = Math.max(maxBudgetHeld, status.status.held + status.status.quarantined);
    assert.ok(maxBudgetHeld <= concurrency, "shared budget exceeded the frozen workload capacity");
    return status.status.held === 0 && status.status.quarantined === 0;
  }, 30_000);
} catch (error) { fatal = error; failed += 1; }
finally {
  if (sampler) clearInterval(sampler);
  finalBudget = await budgetRequest("health").then(response => response.status).catch(() => null);
  remainingHostSockets = [...hosts].filter(entry => {
    const manifest = path.join(entry, "manifest.json");
    return existsSync(manifest) && existsSync(privateJson(manifest).socketPath);
  }).length;
  stopping = true;
  if (connection && !daemonExit) {
    await request(connection, "/v1/shutdown", { method: "POST" }).catch(() => {});
    await waitFor(() => daemonExit, 10_000).catch(() => {});
  }
  for (const host of hosts) await shutdownDirectory(host, "socketPath").catch(() => {});
  await shutdownDirectory(budget, "socket").catch(() => {});
  if (!daemonExit) { child.kill("SIGKILL"); await waitFor(() => daemonExit, 5000).catch(() => {}); }
}
const elapsedSeconds = (Date.now() - started) / 1000;
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", maxBuffer: 4096 });
const summary = {
  schemaVersion: 1, profile, releaseEvidence: false, commit: commit.status === 0 ? commit.stdout.trim() : null,
  status: fatal || failed ? "failed" : profile === "diagnostic" ? "diagnostic_only" : elapsedSeconds >= duration ? "completed_pending_review" : "incomplete",
  workload: "one persistent real daemon, independent execution Host and budget broker, fake native CLI, Host CLI delivery, result acceptance and verified stop",
  targetConcurrency: concurrency, maxActive, accepted, completed, failed, durationTargetSeconds: duration, elapsedSeconds,
  maxObservedTreeRssKb: maxRssKb, maxObservedProcessCount: maxProcesses, maxBudgetHeld, resourceSamples: samples,
  logBudgetBytesPerFile: 64 * 1024 * 1024, retainedLogBytes: Object.fromEntries(logBytes), droppedLogBytes,
  controlLatencyBucketsMs: bounds.map(value => Number.isFinite(value) ? value : "over_10000"), controlLatencyCounts: latencies,
  fatal: fatal ? String(fatal.stack ?? fatal) : null, failures, daemonExit, finalBudget, remainingHostSockets,
  outputDirectory: output, limitations: ["No real model traffic", "24h/72h evidence requires this exact integrated commit, successful invariant review, and completed elapsed duration"],
};
writeFileSync(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
writeFileSync(path.join(output, "daemon.tail.log"), diagnostics);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (fatal || failed) process.exitCode = 1;

async function worker(lane) {
  while (!stopping && Date.now() < finish && accepted < maxCycles) {
    const index = accepted++;
    const id = `cycle-${index}-${lane}`;
    const workspace = path.join(workspaces, id);
    mkdirSync(workspace, { mode: 0o700 });
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      const graph = await request(connection, "/v1/runs/graph", { method: "POST", body: { objective: "runtime workload", operationId: `graph-${id}`, nodes: [{ clientId: "a", title: id, spec: "submit one deterministic fixture delivery" }] } });
      await request(connection, "/v1/workers/start", { method: "POST", body: { operationId: `start-${id}`, taskId: graph.idMap.a, agent: "claude", cwd: workspace, worktree: "none", approvalPolicy: "standard" } });
      const operation = await waitFor(async () => {
        const state = await request(connection, `/v1/operations/start-${id}`);
        if (["FAILED", "CANCELLED"].includes(state.state)) throw new Error(`start rejected ${JSON.stringify(state)}`);
        return state.attemptId ? state : undefined;
      }, 60_000);
      let completedHost;
      await waitFor(async () => {
        const execution = await request(connection, `/v1/executions/${operation.attemptId}`);
        if (execution.identity?.host) {
          completedHost = path.join(directory, "execution-hosts", execution.identity.host.hostId, execution.identity.host.hostEpoch);
          hosts.add(completedHost);
        }
        if (execution.state === "FINALIZED") {
          assert.equal(execution.resultState, "ACCEPTED");
          assert.ok(execution.exitProofId, "execution finalized without a verified exit proof");
          return true;
        }
      }, 90_000);
      if (completedHost) {
        await waitFor(() => {
          const manifest = path.join(completedHost, "manifest.json");
          return existsSync(manifest) && !existsSync(privateJson(manifest).socketPath);
        }, 15_000);
        hosts.delete(completedHost);
      }
      const task = await request(connection, `/v1/tasks/${graph.idMap.a}`);
      assert.equal(task.status, "done");
      completed += 1;
      appendLog("cycles.jsonl", { cycle: id, attemptId: operation.attemptId, completedAt: new Date().toISOString() });
    } catch (error) {
      failed += 1;
      if (failures.length < 64) failures.push({ cycle: id, error: String(error.stack ?? error) });
      stopping = true;
    } finally { active -= 1; }
  }
}

async function request(state, route, input = {}) {
  const begin = Date.now();
  const response = await fetch(state.baseUrl + route, {
    method: input.method ?? "GET", headers: { authorization: `Bearer ${state.token}`, prefer: "respond-async", ...(input.body ? { "content-type": "application/json" } : {}) },
    body: input.body ? JSON.stringify(input.body) : undefined, signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json();
  latencies[bounds.findIndex(bound => Date.now() - begin <= bound)] += 1;
  assert.ok(response.ok, `${route} ${response.status} ${JSON.stringify(value)}`);
  return value;
}

async function waitFor(callback, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { const value = await callback(); if (value) return value; await delay(50); }
  throw new Error(`condition did not complete within ${milliseconds}ms`);
}

function privateJson(file) { const bytes = readFileSync(file); assert.ok(bytes.length <= 16384); return JSON.parse(bytes.toString()); }
async function shutdownDirectory(entry, key) {
  if (!existsSync(path.join(entry, "manifest.json"))) return;
  const manifest = privateJson(path.join(entry, "manifest.json"));
  if (!existsSync(manifest[key])) return;
  await uds(manifest[key], { requestType: "shutdown", token: readFileSync(path.join(entry, "token"), "utf8") });
}
async function budgetRequest(requestType) {
  const manifest = privateJson(path.join(budget, "manifest.json"));
  return uds(manifest.socket, { requestType, token: readFileSync(path.join(budget, "token"), "utf8") });
}
async function uds(socketPath, value) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let bytes = Buffer.alloc(0);
    socket.setTimeout(3000, () => socket.destroy(new Error("test IPC timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 65536) return socket.destroy(new Error("test IPC response exceeds limit"));
      if (bytes.includes(10)) { const response = JSON.parse(bytes.toString()); socket.end(); resolve(response); }
    });
  });
}
function sample() {
  const ps = spawnSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 3000 });
  assert.equal(ps.status, 0, "test resource sampling failed");
  const rows = ps.stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number)).filter(row => row.length === 3 && row.every(Number.isFinite));
  const owned = new Set([child.pid]);
  let changed = true;
  while (changed) { changed = false; for (const [pid, parent] of rows) if (!owned.has(pid) && owned.has(parent)) { owned.add(pid); changed = true; } }
  const processes = rows.filter(([pid]) => owned.has(pid));
  const rssKb = processes.reduce((sum, row) => sum + row[2], 0);
  maxRssKb = Math.max(maxRssKb, rssKb); maxProcesses = Math.max(maxProcesses, processes.length); samples += 1;
  appendLog("resources.jsonl", { timestamp: new Date().toISOString(), elapsedSeconds: (Date.now() - started) / 1000, active, completed, processCount: processes.length, rssKb });
}
