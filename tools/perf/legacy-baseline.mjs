import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync, openSync, writeSync, closeSync, cpSync } from "node:fs";
import { tmpdir, cpus, totalmem, platform, arch, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { session, task, run, taskId, percentile } from "./workloads.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const self = fileURLToPath(import.meta.url);
const marker = "PROSPERO_PERF_RESULT ";
const moduleUrl = name => new URL(`../../apps/daemon/dist/${name}.js`, import.meta.url);

function measure(action, count = 31) {
  const values = [];
  for (let index = 0; index < count; index++) {
    const start = performance.now(); action(index); values.push(performance.now() - start);
  }
  return { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: percentile(values, 1) };
}

async function archiveFixture(home, count) {
  const { SessionDatabase } = await import(moduleUrl("session-database"));
  const file = path.join(home, "sessions.sqlite");
  new SessionDatabase(file).close();
  const db = new DatabaseSync(file);
  const insert = db.prepare("INSERT INTO sessions VALUES(?,?,?,?)");
  const event = db.prepare("INSERT INTO session_events VALUES(?,?,?,?)");
  db.exec("BEGIN");
  const body = JSON.stringify({ kind: "user.message", msgId: "fixture", text: "x".repeat(1024) });
  for (let index = 0; index < count; index++) {
    const { events, toolOutputs, messageQueue, ...state } = session(index);
    const metadata = JSON.stringify(state);
    insert.run(state.id, metadata, Buffer.byteLength(metadata), 1);
    event.run(state.id, 1, body, Buffer.byteLength(body));
  }
  db.exec("COMMIT"); db.close();
}

function graphFixture(home, count) {
  const file = openSync(path.join(home, "orchestration.json"), "wx", 0o600);
  try {
    writeSync(file, '{"version":2,"runs":{');
    for (let index = 0; index < count; index += 100) {
      const row = run(index); writeSync(file, `${index ? "," : ""}${JSON.stringify(row.id)}:${JSON.stringify(row)}`);
    }
    writeSync(file, '},"tasks":{');
    for (let index = 0; index < count; index++) {
      const row = task(index); writeSync(file, `${index ? "," : ""}${JSON.stringify(row.id)}:${JSON.stringify(row)}`);
    }
    writeSync(file, '},"dispatches":{},"messages":{},"gates":{},"operations":{},"worktreeAssets":{}}');
  } finally { closeSync(file); }
}

async function worker(kind, home, count) {
  if (kind === "seed-archive") { await archiveFixture(home, count); return { seeded: count }; }
  if (kind === "seed-graph") { graphFixture(home, count); return { seeded: count }; }
  if (kind === "archive") {
    const { SessionManager } = await import(moduleUrl("session-manager"));
    const { pageSessions } = await import(moduleUrl("session-list"));
    const { CodexAdapter } = await import(moduleUrl("adapters/codex"));
    let adapterObjects = 0;
    const manager = new SessionManager({ home, supervisor: false, ptySupervisor: false, adapterFactory: () => {
      adapterObjects++;
      const adapter = new CodexAdapter();
      adapter.start = async () => { throw new Error("Archived sessions must not launch agent processes"); };
      return adapter;
    } });
    const start = performance.now();
    const restored = await manager.restoreStructured();
    const startupMs = performance.now() - start;
    if (restored.length !== count) throw new Error(`Restored ${restored.length}; expected ${count}`);
    const query = measure(() => {
      const page = pageSessions(manager.list(), { limit: 100 });
      if (page.items.length !== Math.min(count, 100)) throw new Error("Incorrect page size");
    });
    const result = { startupMs, residentSessionObjects: manager.list().length, adapterObjects, query };
    global.gc?.(); result.heapMiB = process.memoryUsage().heapUsed / 1024 ** 2; result.residentRssMiB = process.memoryUsage().rss / 1024 ** 2;
    await manager.disposeAll();
    return result;
  }
  if (kind === "graph") {
    const { OrchestrationStore } = await import(moduleUrl("orchestration/store"));
    const start = performance.now(); const store = new OrchestrationStore(home);
    const startupMs = performance.now() - start;
    const query = measure(index => {
      if (store.listTasks(run(Math.floor(index % (count / 100)) * 100).id).length !== 100) throw new Error("Incorrect graph page");
    });
    const update = measure(index => {
      store.setTaskStatus(taskId(index), store.getTask(taskId(index)).status === "pending" ? "blocked" : "pending"); store.persistNow();
    }, 9);
    const result = { startupMs, query, update };
    global.gc?.(); result.heapMiB = process.memoryUsage().heapUsed / 1024 ** 2;
    store.close(); return result;
  }
  if (kind === "terminal") {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const { Terminal } = require("@xterm/headless");
    const { SerializeAddon } = require("@xterm/addon-serialize");
    const terminal = new Terminal({ cols: 120, rows: 40, scrollback: 2000, allowProposedApi: true });
    const serializer = new SerializeAddon(); terminal.loadAddon(serializer);
    const data = "\u001b[32mhello 你好 😀\u001b[0m\r\n".repeat(4096);
    const start = performance.now();
    for (let index = 0; index < 64; index++) await new Promise(resolve => terminal.write(data, resolve));
    const parseMs = performance.now() - start;
    const snapshot = measure(() => serializer.serialize({ scrollback: 0 }));
    const result = { bytes: Buffer.byteLength(data) * 64, parseMs, snapshot, retainedLines: terminal.buffer.active.length };
    terminal.dispose(); return result;
  }
  throw new Error("Unknown benchmark case");
}

if (process.argv[2] === "--worker") {
  const result = await worker(process.argv[3], process.argv[4], Number(process.argv[5]));
  process.stdout.write(`${marker}${JSON.stringify({ ...result, peakRssMiB: process.resourceUsage().maxRSS / 1024 })}\n`);
} else {
  const countArg = process.argv.indexOf("--counts");
  const counts = countArg < 0 ? [10_000, 100_000] : process.argv[countArg + 1].split(",").map(Number);
  if (counts.some(value => !Number.isSafeInteger(value) || value < 100 || value > 100_000 || value % 100)) throw new Error("Counts must be multiples of 100, up to 100000");
  const outputArg = process.argv.indexOf("--output");
  const home = mkdtempSync(path.join(tmpdir(), "prospero-legacy-perf-"));
  const results = [];
  const execute = (kind, directory, count) => {
    const child = spawnSync(process.execPath, ["--expose-gc", self, "--worker", kind, directory, String(count)], {
      cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "", VITEST: "true" },
    });
    const line = child.stdout?.split("\n").find(line => line.startsWith(marker));
    if (child.status !== 0 || !line) return { status: child.error?.code === "ETIMEDOUT" ? "timeout" : "failed", exitCode: child.status, detail: child.stderr?.slice(-1200).replaceAll(home, "<fixture>").replaceAll(root, "<repo>") };
    return { status: "ok", ...JSON.parse(line.slice(marker.length)) };
  };
  try {
    for (const count of counts) for (const kind of ["archive", "graph"]) {
      const { mkdirSync } = await import("node:fs");
      const directory = path.join(home, `${kind}-${count}`); mkdirSync(directory, { mode: 0o700 });
      const seeded = execute(`seed-${kind}`, directory, count);
      if (seeded.status !== "ok") throw new Error(JSON.stringify(seeded));
      const samples = [];
      for (let trial = 0; trial < 3; trial++) {
        process.stderr.write(`Baseline ${kind} count=${count} trial=${trial + 1}\n`);
        const trialDirectory = `${directory}-trial-${trial}`;
        cpSync(directory, trialDirectory, { recursive: true });
        const sample = execute(kind, trialDirectory, count); samples.push(sample);
        rmSync(trialDirectory, { recursive: true, force: true });
        if (sample.status !== "ok") break;
      }
      results.push({ case: kind, count, samples });
    }
    results.push({ case: "terminal", count: 1, samples: [execute("terminal", home, 1)] });
    const report = { schemaVersion: 1, backend: "node-legacy", baseline: "2e2d94479a8496d273ace12dfaf092003cd6a7d7", measuredAt: new Date().toISOString(), fixtureReset: "fresh copy for every trial; OS disk caches are not forcibly evicted", environment: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryGiB: totalmem() / 1024 ** 3, node: process.version }, results };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outputArg >= 0) writeFileSync(process.argv[outputArg + 1], serialized);
    else process.stdout.write(serialized);
    if (results.some(result => result.samples.some(sample => sample.status === "failed"))) process.exitCode = 1;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
