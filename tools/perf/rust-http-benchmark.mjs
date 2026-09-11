import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch, cpus, totalmem, release } from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import assert from "node:assert/strict";
import { percentile } from "./workloads.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = path.join(root, "target/release", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const home = mkdtempSync(path.join(tmpdir(), "prospero-rust-http-perf-"));
const results = [];
const summarize = values => ({ valuesMs: values, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: percentile(values, 1) });

async function trial(directory, count) {
  const start = performance.now();
  const child = spawn(binary, ["serve", "--data-dir", directory], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("startup timeout")), 10000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`startup exited ${code}`)); });
      child.stdout.on("data", data => {
        output += data;
        if (output.length > 16384) { clearTimeout(timer); reject(new Error("unexpected startup output")); return; }
        if (output.split("\n").slice(0, -1).some(line => line.includes('"event":"ready"'))) { clearTimeout(timer); resolve(); }
      });
    });
    const startupMs = performance.now() - start;
    const connection = JSON.parse(readFileSync(path.join(directory, "connection.json"), "utf8"));
    assert.equal(connection.pid, child.pid);
    const request = async (route, init = {}) => {
      const response = await fetch(connection.baseUrl + route, { ...init, headers: { authorization: `Bearer ${connection.token}`, ...init.headers }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP benchmark failed: ${response.status}`);
      return response.json();
    };
    const health = await request("/v1/health");
    const query = []; const rename = []; const replay = [];
    let page;
    for (let index = 0; index < 31; index++) {
      const time = performance.now(); page = await request("/v1/sessions?limit=100&lifecycle=archived");
      query.push(performance.now() - time); assert.equal(page.items.length, 100);
    }
    const indexedQueries = {};
    for (const [name, route, expected] of [
      ["summary", "/v1/sessions/summary", count],
      ["workspace", "/v1/sessions?workspace=%2Fsynthetic&limit=100", count],
      ["searchSelective", `/v1/sessions?text=Archive%20${count - 1}&limit=100`, 1],
      ["searchBroad", "/v1/sessions?text=Archive&limit=100", count],
      ["searchBroadFiltered", "/v1/sessions?text=Archive&workspace=%2Fsynthetic&lifecycle=archived&limit=100", count],
    ]) {
      const times = [];
      for (let index = 0; index < 31; index++) {
        const time = performance.now(); const result = await request(route);
        times.push(performance.now() - time); assert.equal(result.total, expected);
        if (result.items) assert.ok(result.items.length <= 100);
      }
      indexedQueries[name] = summarize(times);
    }
    for (let index = 0; index < 9; index++) {
      const time = performance.now();
      await request(`/v1/sessions/${page.items[index].id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1, title: `Renamed ${index}` }) });
      rename.push(performance.now() - time);
    }
    const common = [];
    for (let index = 0; index < 31; index++) {
      const time = performance.now(); const result = await request("/v1/sessions?text=Archive&limit=100");
      common.push(performance.now() - time); assert.equal(result.total, count - 9);
      assert.equal(result.items.length, 100);
      assert.ok(result.items.every(item => item.title.startsWith("Archive ")));
    }
    indexedQueries.searchCommon = summarize(common);
    for (let index = 0; index < 31; index++) {
      const time = performance.now(); const events = await request("/v1/events?scope=sessions&afterSeq=0&limit=100");
      replay.push(performance.now() - time); assert.equal(events.items.length, 9);
    }
    const usage = process.platform === "win32" ? null : spawnSync("ps", ["-p", String(child.pid), "-o", "rss="], { encoding: "utf8" });
    const rss = usage?.status === 0 ? Number(usage.stdout.trim()) / 1024 : null;
    const exited = once(child, "exit"); await request("/v1/shutdown", { method: "POST" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const [code] = await exited; clearTimeout(timer); assert.equal(code, 0);
    return { startupMs, residentRssMiB: rss, activeRuntimeSessions: health.activeRuntimeSessions, query: summarize(query), indexedQueries, rename: summarize(rename), replay: summarize(replay) };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  }
}

try {
  for (const count of [10000, 100000]) {
    const source = path.join(home, `seed-${count}`);
    const seed = spawnSync(binary, ["seed-benchmark", "--data-dir", source, "--sessions", String(count)], { encoding: "utf8", timeout: 120000 });
    assert.equal(seed.status, 0, seed.stderr);
    const samples = [];
    for (let index = 0; index < 3; index++) {
      const directory = path.join(home, `${count}-${index}`); cpSync(source, directory, { recursive: true });
      samples.push(await trial(directory, count)); rmSync(directory, { recursive: true, force: true });
    }
    results.push({ count, samples });
  }
  const report = { schemaVersion: 2, backend: "rust-http", scope: "Real Rust process readiness, indexed search, summaries and authenticated HTTP metadata APIs; no Agent, PTY or Electron rendering workload. RSS sampled after requests, not peak RSS.", measuredAt: new Date().toISOString(), fixtureReset: "fresh copy per trial; OS caches are not forcibly evicted", environment: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: totalmem() / 1024 ** 3 }, results };
  const output = process.argv.indexOf("--output");
  const text = JSON.stringify(report, null, 2) + "\n";
  if (output >= 0) writeFileSync(process.argv[output + 1], text); else process.stdout.write(text);
} finally { rmSync(home, { recursive: true, force: true }); }
