import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch, cpus, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import assert from "node:assert/strict";
import { percentile } from "./workloads.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = path.join(root, "target/release", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const directory = mkdtempSync(path.join(tmpdir(), "prospero-timeline-perf-"));
const summarize = values => ({ valuesMs: values, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: percentile(values, 1) });

async function trial(home, sessionId, count) {
  const start = performance.now();
  const child = spawn(binary, ["serve", "--data-dir", home], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  try {
    await new Promise((resolve, reject) => {
      let text = ""; const timer = setTimeout(() => reject(new Error("startup timeout")), 10000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("startup failed")); });
      child.stdout.on("data", value => { text += value; if (text.length > 16384) { clearTimeout(timer); reject(new Error("startup output exceeded limit")); } else if (text.includes('"event":"ready"') && text.endsWith("\n")) { clearTimeout(timer); resolve(); } });
    });
    const startupMs = performance.now() - start;
    const connection = JSON.parse(readFileSync(path.join(home, "connection.json"), "utf8"));
    assert.equal(connection.pid, child.pid);
    const request = async (route, init = {}) => {
      const response = await fetch(connection.baseUrl + route, { ...init, redirect: "error", headers: { authorization: `Bearer ${connection.token}`, ...init.headers }, signal: AbortSignal.timeout(5000) });
      assert.ok(response.ok, `request returned ${response.status}`); return response.json();
    };
    const base = `/v1/sessions/${sessionId}/timeline`;
    const current = await request(base);
    assert.equal(current.latestPosition, count); assert.equal(current.items.length, 40);
    const last = current.items.at(-2);
    const measurements = {};
    for (const [name, route] of [
      ["latest", `${base}?limit=40`], ["oldest", `${base}?before=41&limit=40`],
      ["body", `${base}/${last.id}/body?part=0&generation=1`],
    ]) {
      const values = [];
      for (let index = 0; index < 31; index++) {
        const start = performance.now(); const result = await request(route); values.push(performance.now() - start);
        if (name === "body") { assert.ok(Buffer.byteLength(result.text) <= 65539); assert.ok(result.nextPart !== null); }
        else { assert.equal(result.items.length, 40); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1048576); }
      }
      measurements[name] = summarize(values);
    }
    const usage = process.platform === "win32" ? null : spawnSync("ps", ["-p", String(child.pid), "-o", "rss="], { encoding: "utf8" });
    const rss = usage?.status === 0 ? Number(usage.stdout.trim()) / 1024 : null;
    const exited = once(child, "exit"); await request("/v1/shutdown", { method: "POST" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const [code] = await exited; clearTimeout(timer); assert.equal(code, 0);
    return { startupMs, residentRssMiB: rss, measurements };
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } }
}

try {
  const results = [];
  for (const count of [10000, 100000]) {
    const source = path.join(directory, `seed-${count}`);
    const seed = spawnSync(binary, ["seed-conversation", "--data-dir", source, "--turns", String(count / 4)], { encoding: "utf8", timeout: 120000 });
    assert.equal(seed.status, 0, seed.stderr);
    const sessionId = JSON.parse(seed.stdout).sessionId;
    const samples = [];
    for (let index = 0; index < 3; index++) {
      const home = path.join(directory, `trial-${count}-${index}`); cpSync(source, home, { recursive: true });
      samples.push(await trial(home, sessionId, count)); rmSync(home, { recursive: true, force: true });
    }
    results.push({ records: count, samples });
  }
  const report = { schemaVersion: 1, backend: "rust-timeline", scope: "Synthetic persisted timeline metadata and Unicode body HTTP pages; no real Agent, PTY or Electron rendering. RSS is sampled after requests, not peak RSS.", measuredAt: new Date().toISOString(), fixtureReset: "fresh copy per trial; OS caches are not forcibly evicted", environment: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model }, results };
  const output = process.argv.indexOf("--output"); const json = JSON.stringify(report, null, 2) + "\n";
  if (output >= 0) writeFileSync(process.argv[output + 1], json); else process.stdout.write(json);
} finally { rmSync(directory, { recursive: true, force: true }); }
