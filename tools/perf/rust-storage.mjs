import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, arch, platform, release, cpus, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { percentile } from "./workloads.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = path.join(root, "target/release", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const home = mkdtempSync(path.join(tmpdir(), "prospero-rust-perf-"));
const output = process.argv.indexOf("--output");
const results = [];
function execute(args) {
  const child = spawnSync(binary, args, { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 });
  if (child.status !== 0 || child.error) throw new Error(`Rust benchmark failed: ${child.status} ${child.error?.code ?? ""} ${child.stderr}`);
  return JSON.parse(child.stdout);
}
try {
  for (const count of [10000, 100000]) {
    const source = path.join(home, `seed-${count}`);
    execute(["seed-benchmark", "--data-dir", source, "--sessions", String(count)]);
    const samples = [];
    for (let trial = 0; trial < 3; trial++) {
      const directory = path.join(home, `trial-${count}-${trial}`);
      cpSync(source, directory, { recursive: true });
      const sample = execute(["benchmark", "--data-dir", directory]);
      samples.push({ ...sample, query: { samples: sample.queryMs.length, p50Ms: percentile(sample.queryMs, 0.5), p95Ms: percentile(sample.queryMs, 0.95), maxMs: percentile(sample.queryMs, 1) } });
      rmSync(directory, { recursive: true, force: true });
    }
    results.push({ case: "archive-storage", count, samples });
  }
  const report = { schemaVersion: 1, backend: "rust-storage", measuredAt: new Date().toISOString(), scope: "Storage initialization and bounded archive metadata paging, not complete daemon startup, HTTP or Electron rendering", fixtureReset: "fresh copy for every trial; OS disk caches are not forcibly evicted", environment: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: totalmem() / 1024 ** 3, rust: spawnSync("rustc", ["--version"], { encoding: "utf8" }).stdout.trim() }, results };
  const body = JSON.stringify(report, null, 2) + "\n";
  if (output >= 0) writeFileSync(process.argv[output + 1], body);
  else process.stdout.write(body);
} finally { rmSync(home, { recursive: true, force: true }); }
