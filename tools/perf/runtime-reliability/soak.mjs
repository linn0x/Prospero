import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../../..");
const args = process.argv.slice(2);
const profile = value("--profile");
const diagnosticSeconds = positiveNumber("--duration-seconds");
const sampleSeconds = positiveNumber("--sample-seconds") ?? 60;
const logBudgetBytes = positiveNumber("--max-log-bytes") ?? 8 * 1024 * 1024;
const requestedOutput = value("--output-dir");
const commandIndex = args.indexOf("--");
const command = commandIndex >= 0 ? args.slice(commandIndex + 1) : [];

assert.ok(["24h", "72h", "diagnostic"].includes(profile), "--profile must be 24h, 72h, or diagnostic");
assert.ok(command.length > 0, "provide a workload command after --");
assert.ok(sampleSeconds >= 1, "--sample-seconds must be at least 1");
if (profile === "diagnostic") assert.ok(diagnosticSeconds, "diagnostic profile requires --duration-seconds");
else assert.equal(diagnosticSeconds, undefined, "24h and 72h profiles use fixed durations");
if (process.platform === "win32") throw new Error("process-tree resource sampling is not implemented on Windows");

const durationSeconds = profile === "24h" ? 24 * 60 * 60 : profile === "72h" ? 72 * 60 * 60 : diagnosticSeconds;
const outputDirectory = path.resolve(requestedOutput ?? path.join(os.tmpdir(), `prospero-runtime-reliability-${Date.now()}`));
mkdirSync(outputDirectory, { recursive: false });
const isolatedHome = path.join(outputDirectory, "isolated-home");
const isolatedTmp = path.join(outputDirectory, "isolated-tmp");
mkdirSync(isolatedHome);
mkdirSync(isolatedTmp);
const samplePath = path.join(outputDirectory, "resources.jsonl");
const stdoutPath = path.join(outputDirectory, "workload.stdout.log");
const stderrPath = path.join(outputDirectory, "workload.stderr.log");
const summaryPath = path.join(outputDirectory, "summary.json");
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
const child = spawn(command[0], command.slice(1), {
  cwd: repoRoot,
  env: {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    PROSPERO_HOME: isolatedHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
    XDG_DATA_HOME: path.join(isolatedHome, ".local", "share"),
    TMPDIR: isolatedTmp,
    TMP: isolatedTmp,
    TEMP: isolatedTmp,
    PROSPERO_RUNTIME_RELIABILITY_PROFILE: profile,
    PROSPERO_RUNTIME_RELIABILITY_HOME: isolatedHome,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdoutSize = 0;
let stderrSize = 0;
let stdoutDroppedBytes = 0;
let stderrDroppedBytes = 0;
let childExit;
const startedAt = Date.now();
child.once("error", error => { childExit = { error: error.message, code: null, signal: null }; });
child.once("exit", (code, signal) => { childExit = { code, signal }; });
child.stdout.on("data", chunk => {
  const remaining = Math.max(0, logBudgetBytes - stdoutSize);
  const retained = chunk.subarray(0, remaining);
  if (retained.length > 0) appendFileSync(stdoutPath, retained);
  stdoutSize += retained.length;
  stdoutDroppedBytes += chunk.length - retained.length;
});
child.stderr.on("data", chunk => {
  const remaining = Math.max(0, logBudgetBytes - stderrSize);
  const retained = chunk.subarray(0, remaining);
  if (retained.length > 0) appendFileSync(stderrPath, retained);
  stderrSize += retained.length;
  stderrDroppedBytes += chunk.length - retained.length;
});

let maxRssKb = 0;
let maxProcessCount = 0;
let samples = 0;
let terminationSignal;
const finishAt = startedAt + durationSeconds * 1000;
while (Date.now() < finishAt && !childExit) {
  const processTree = readProcessTree(child.pid);
  const rssKb = processTree.reduce((sum, process) => sum + process.rssKb, 0);
  maxRssKb = Math.max(maxRssKb, rssKb);
  maxProcessCount = Math.max(maxProcessCount, processTree.length);
  appendFileSync(samplePath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    elapsedSeconds: (Date.now() - startedAt) / 1000,
    rootPid: child.pid,
    processCount: processTree.length,
    rssKb,
  })}\n`);
  samples += 1;
  await delay(Math.min(sampleSeconds * 1000, Math.max(1, finishAt - Date.now())));
}

const elapsedSeconds = (Date.now() - startedAt) / 1000;
const reachedDuration = Date.now() >= finishAt;
const exitedEarly = Boolean(childExit) && !reachedDuration;
if (!childExit) {
  terminationSignal = "SIGTERM";
  if (!childExit) child.kill("SIGTERM");
  await waitForExit(10_000);
  if (!childExit) {
    terminationSignal = "SIGKILL";
    child.kill("SIGKILL");
    await waitForExit(5_000);
  }
}

const leaderExited = Boolean(childExit);
const orphanCleanupUnknown = leaderExited && maxProcessCount > 1;

const status = profile === "diagnostic"
  ? "diagnostic_only"
  : childExit && !exitedEarly && childExit.code === 0 && !orphanCleanupUnknown ? "completed" : "failed";
const summary = {
  schemaVersion: 1,
  profile,
  status,
  evidenceGrade: profile === "diagnostic" ? "short_diagnostic_not_release_evidence" : "long_run_process_soak_only",
  releaseEvidence: false,
  commit: commit.status === 0 ? commit.stdout.trim() : null,
  platform: { platform: process.platform, arch: process.arch, release: os.release() },
  command: command[0],
  rootPid: child.pid,
  durationTargetSeconds: durationSeconds,
  elapsedSeconds,
  sampleIntervalSeconds: sampleSeconds,
  samples,
  maxObservedProcessCount: maxProcessCount,
  maxObservedTreeRssKb: maxRssKb,
  stdoutBytes: stdoutSize,
  stderrBytes: stderrSize,
  stdoutDroppedBytes,
  stderrDroppedBytes,
  logBudgetBytesPerStream: logBudgetBytes,
  childExit,
  terminationSignal,
  orphanCleanupUnknown,
  isolatedHome,
  isolatedTmp,
  resourceSamples: samplePath,
  stdoutLog: stdoutPath,
  stderrLog: stderrPath,
  limitation: "This runner measures a test-owned workload process tree; it does not prove F01-F29 behavior or application recovery semantics.",
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (status === "failed") process.exitCode = 1;

function value(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveNumber(name) {
  const input = value(name);
  if (input === undefined) return undefined;
  const number = Number(input);
  assert.ok(Number.isFinite(number) && number > 0, `${name} must be positive`);
  return number;
}

function readProcessTree(rootPid) {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
  const processes = result.stdout.split(/\r?\n/).flatMap(line => {
    const columns = line.trim().split(/\s+/).map(Number);
    return columns.length === 3 && columns.every(Number.isFinite)
      ? [{ pid: columns[0], ppid: columns[1], rssKb: columns[2] }]
      : [];
  });
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (!included.has(process.pid) && included.has(process.ppid)) {
        included.add(process.pid);
        changed = true;
      }
    }
  }
  return processes.filter(process => included.has(process.pid));
}

async function waitForExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!childExit && Date.now() < deadline) await delay(20);
}
