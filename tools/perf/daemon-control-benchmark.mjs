import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const binary = resolve(option("--binary", "target/release/prosperod-rs"));
const scenario = option("--scenario", "schedules");
const trials = Number(option("--trials", "3"));
const count = Number(option("--count", scenario === "plugins" ? "20" : "300"));
if (!["schedules", "plugins"].includes(scenario) || !Number.isInteger(trials) || trials < 1 || trials > 10 || !Number.isInteger(count) || count < 1 || count > (scenario === "plugins" ? 32 : 2000)) throw new Error("Invalid benchmark options");
if (scenario === "plugins" && platform() === "win32") throw new Error("The synthetic sleep service fixture currently requires Unix");

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: sorted.length, p50Ms: +sorted[Math.floor(sorted.length * .5)].toFixed(2), p95Ms: +sorted[Math.floor(sorted.length * .95)].toFixed(2), maxMs: +sorted.at(-1).toFixed(2) };
}

async function trial() {
  const root = mkdtempSync(join(tmpdir(), "prospero-control-benchmark-"));
  const home = join(root, "daemon"), configRoot = join(root, "codex"), workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  if (scenario === "schedules") {
    for (let i = 0; i < count; i++) {
      const id = `fixture-${String(i).padStart(4, "0")}`;
      const dir = join(configRoot, "automations", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "automation.toml"), `version = 1\nid = "${id}"\nkind = "cron"\nname = "Synthetic schedule ${i}"\nprompt = "${"benchmark ".repeat(400)}"\nstatus = "PAUSED"\nrrule = "FREQ=HOURLY;INTERVAL=1"\nagent = "claude"\ncwd = ${JSON.stringify(workspace)}\ncreated_at = 1000\nupdated_at = 1000\nnext_run_at = 9000000000000\n`);
    }
  } else {
    const dir = join(home, "plugins", "fixture-plugin");
    mkdirSync(join(dir, "runtime"), { recursive: true });
    writeFileSync(join(dir, "prospero-plugin.json"), JSON.stringify({
      schema_version: "prospero-plugin/v1", name: "fixture-plugin",
      services: Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, mode: "manual", command: ["sleep", "120"], cwd: "runtime", port_env: "PORT" })),
    }));
  }
  // Only the child gets a private scheduling configuration; never run the
  // user's real automations or import their legacy data in a benchmark.
  const env = { ...process.env, CODEX_HOME: configRoot };
  delete env.PROSPERO_LEGACY_HOME;
  const start = performance.now();
  const child = spawn(binary, ["serve", "--data-dir", home], { env, stdio: ["ignore", "pipe", "pipe"] });
  let connection;
  const request = async (route, method = "GET") => {
    const response = await fetch(connection.baseUrl + route, { method, headers: { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
    return response.json();
  };
  try {
    await new Promise((done, fail) => {
      let output = "";
      const timer = setTimeout(() => fail(new Error("Daemon startup timed out")), 15000);
      child.once("error", error => { clearTimeout(timer); fail(error); });
      child.once("exit", () => { clearTimeout(timer); fail(new Error("Daemon exited before ready")); });
      child.stdout.on("data", chunk => {
        output = (output + chunk.toString()).slice(-8192);
        if (output.includes('"event":"ready"')) { clearTimeout(timer); done(); }
      });
      child.stderr.on("data", () => {});
    });
    connection = JSON.parse(readFileSync(join(home, "connection.json"), "utf8"));
    const startupMs = +(performance.now() - start).toFixed(2);
    if (scenario === "plugins") for (let i = 0; i < count; i++) await request(`/v1/plugin/fixture-plugin/service/fixture-${i}/start`, "POST");
    const latency = [];
    let rewritten = 0;
    const stateFile = join(home, "plugin-services", "state.json");
    for (let i = 0; i < 23; i++) {
      const before = scenario === "plugins" ? statSync(stateFile).mtimeMs : 0;
      const start = performance.now();
      const result = await request(scenario === "plugins" ? "/v1/plugin-services" : "/v1/schedules");
      if ((scenario === "plugins" ? result.items.length : result.length) !== count) throw new Error("Incomplete fixture results");
      if (i >= 3) {
        latency.push(performance.now() - start);
        if (scenario === "plugins" && statSync(stateFile).mtimeMs !== before) rewritten++;
      }
    }
    if (scenario === "plugins") return { startupMs, query: stats(latency), requestsThatRewroteState: rewritten };
    const health = [];
    for (let i = 0; i < 12; i++) {
      const load = Promise.all(Array.from({ length: 6 }, () => request("/v1/schedules")));
      const start = performance.now();
      await request("/v1/health"); health.push(performance.now() - start);
      await load;
    }
    return { startupMs, query: stats(latency), healthDuringSixConcurrentLists: stats(health) };
  } finally {
    if (connection) await fetch(connection.baseUrl + "/v1/shutdown", { method: "POST", headers: { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(10000) }).catch(() => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    clearTimeout(timer);
    rmSync(root, { recursive: true, force: true });
  }
}

const results = [];
for (let i = 0; i < trials; i++) results.push(await trial());
const report = {
  schemaVersion: 1, scenario, count,
  scope: "Isolated synthetic paused schedules or manual sleep services. No real agents, plugins or automations. Excludes desktop rendering and external model latency.",
  environment: { platform: platform(), arch: arch(), os: release(), cpu: cpus()[0]?.model, node: process.version },
  binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  results,
};
const output = `${JSON.stringify(report, null, 2)}\n`;
const file = option("--output");
if (file) writeFileSync(file, output); else process.stdout.write(output);
