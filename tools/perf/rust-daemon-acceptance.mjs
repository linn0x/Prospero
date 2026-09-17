import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch, release, cpus, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { once } from "node:events";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const releaseBinary = args.includes("--release");
const soakSeconds = numberArg("--seconds", 20);
const sessions = numberArg("--sessions", 8);
const binary = valueArg("--binary") ?? path.join(root, "target", releaseBinary ? "release" : "debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const outputPath = valueArg("--output");
const keepHome = args.includes("--keep-home");
const home = valueArg("--data-dir") ?? mkdtempSync(path.join(tmpdir(), "prospero-rust-acceptance-"));
const workspace = path.join(home, "workspace");
let child;
let output = "";
let errors = "";
const marks = [];
const userFlows = [];

function valueArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function numberArg(name, fallback) {
  const value = Number(valueArg(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function smokeCommand(index) {
  const marker = `PROSPERO_ACCEPTANCE_${index}`;
  const script = process.platform === "win32"
    ? `echo ${marker} & set /p answer= & echo ${marker}_INPUT:%answer% & ping -n 60 127.0.0.1 > nul`
    : `printf '${marker}\\n'; read answer; printf '${marker}_INPUT:%s\\n' "$answer"; sleep 60`;
  return { marker, script };
}

function headers(connection) {
  return { authorization: `Bearer ${connection.token}` };
}

async function request(connection, route, init = {}) {
  const response = await fetch(connection.baseUrl + route, {
    ...init,
    headers: { ...headers(connection), ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 10000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${route} failed ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function startDaemon() {
  const start = performance.now();
  output = "";
  errors = "";
  child = spawn(binary, ["serve", "--data-dir", home], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-8192); });
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); });
  const ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`daemon startup timeout: ${errors}`)), 15000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`daemon exited ${code}: ${errors}`)); });
    child.stdout.on("data", () => {
      for (const line of output.split(/\r?\n/)) {
        if (!line.includes('"event":"ready"')) continue;
        clearTimeout(timer);
        resolveReady(JSON.parse(line));
        return;
      }
    });
  });
  const connection = JSON.parse(readFileSync(path.join(home, "connection.json"), "utf8"));
  assert.equal(connection.pid, child.pid);
  assert.equal(connection.baseUrl, ready.baseUrl);
  return { ...connection, startupMs: performance.now() - start };
}

async function stopDaemon(connection) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  await fetch(connection.baseUrl + "/v1/shutdown", { method: "POST", headers: headers(connection), signal: AbortSignal.timeout(5000) }).catch(() => {});
  const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
  await exited.catch(() => {});
  clearTimeout(timer);
}

async function terminalSmoke(connection, index) {
  const { marker, script } = smokeCommand(index);
  const head = await request(connection, "/v1/terminals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `acceptance-${index}`, workspace, size: { cols: 80, rows: 24 }, agent: "custom", command: script }),
  });
  await request(connection, `/v1/terminals/${head.id}/resize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cols: 100, rows: 30 }),
  });
  await request(connection, `/v1/terminals/${head.id}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataB64: Buffer.from(process.platform === "win32" ? "typed-from-acceptance\r\n" : "typed-from-acceptance\n").toString("base64") }),
  });
  let cursor = 0;
  let terminalOutput = "";
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !terminalOutput.includes(`${marker}_INPUT:typed-from-acceptance`)) {
    const page = await request(connection, `/v1/terminals/${head.id}/output?afterSeq=${cursor}&waitMs=250`);
    cursor = page.nextSeq;
    for (const event of page.events ?? []) {
      if (event.type === "output") terminalOutput += Buffer.from(event.dataB64, "base64").toString("utf8");
    }
  }
  assert(terminalOutput.includes(marker), terminalOutput);
  assert(terminalOutput.includes(`${marker}_INPUT:typed-from-acceptance`), terminalOutput);
  const closed = await request(connection, `/v1/terminals/${head.id}/close`, { method: "POST" });
  assert.equal(closed.ok, true);
  const archivedBy = Date.now() + 10000;
  while (Date.now() < archivedBy) {
    const page = await request(connection, `/v1/terminals/${head.id}/output?afterSeq=${cursor}&waitMs=250`);
    cursor = page.nextSeq;
    if (page.exited) break;
  }
  const final = await request(connection, `/v1/terminals/${head.id}/output?afterSeq=${cursor}&waitMs=0`);
  assert.equal(final.exited, true);
  const lookup = await request(connection, "/v1/sessions/lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [head.id] }),
  });
  assert.equal(lookup.items[0]?.lifecycle, "archived");
  marks.push({ id: head.id, marker, seq: cursor });
  userFlows.push({
    name: "terminal-round-trip",
    sessionId: head.id,
    platform: process.platform,
    transport: process.platform === "win32" ? "ConPTY" : "Unix PTY",
    created: true,
    resized: true,
    inputEchoed: true,
    closed: true,
    archived: true,
  });
}

function rssMiB(pid) {
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "rss="], { encoding: "utf8" });
  return result.status === 0 ? Number(result.stdout.trim()) / 1024 : null;
}

try {
  if (!existsSync(binary)) throw new Error(`Rust daemon binary does not exist: ${binary}`);
  mkdirSync(workspace, { recursive: true });
  const connection = await startDaemon();
  const health = await request(connection, "/v1/health");
  assert.equal(health.backend, "rust");
  assert.equal(health.persistence.structured, true);
  assert(health.capabilities.includes("terminal.pty"));
  if (process.platform === "win32") assert(health.capabilities.includes("terminal.windows.conpty"));
  const startedAt = performance.now();
  let iteration = 0;
  do {
    await terminalSmoke(connection, iteration);
    iteration += 1;
  } while (iteration < sessions || performance.now() - startedAt < soakSeconds * 1000);
  const summary = await request(connection, "/v1/sessions/summary");
  const beforeRestartPid = connection.pid;
  await stopDaemon(connection);
  const restarted = await startDaemon();
  assert.notEqual(restarted.pid, beforeRestartPid);
  const afterRestart = await request(restarted, "/v1/sessions/summary");
  assert(afterRestart.total >= summary.total);
  const restartedRssMiB = rssMiB(restarted.pid);
  await stopDaemon(restarted);
  userFlows.push({
    name: "restart-recovery",
    beforeRestartPid,
    afterRestartPid: restarted.pid,
    preservedSessionCount: afterRestart.total,
  });
  const report = {
    ok: true,
    scenario: "rust-daemon-acceptance",
    binary,
    home,
    environment: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: totalmem() / 1024 ** 3 },
    startupMs: connection.startupMs,
    restartStartupMs: restarted.startupMs,
    terminalSessions: marks.length,
    userFlows,
    activeRuntimeSessions: health.activeRuntimeSessions,
    capabilities: health.capabilities,
    persistence: health.persistence,
    rssMiB: restartedRssMiB,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, text);
  else process.stdout.write(text);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (!keepHome) rmSync(home, { recursive: true, force: true });
}
