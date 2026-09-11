import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { once } from "node:events";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = path.join(root, "target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const directory = mkdtempSync(path.join(tmpdir(), "prospero-rust-http-"));
let child;
const controller = new AbortController();
try {
  const seed = spawnSync(binary, ["seed-benchmark", "--data-dir", directory, "--sessions", "100"], { encoding: "utf8", timeout: 10000 });
  assert.equal(seed.status, 0, seed.stderr);
  child = spawn(binary, ["serve", "--data-dir", directory], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let errors = "";
  child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-4096); });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("daemon startup timed out")), 10000);
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`daemon exited ${code}: ${errors}`)); });
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 16384) { clearTimeout(timeout); reject(new Error("startup output exceeded limit")); return; }
      const line = output.split("\n").slice(0, -1).find(line => line.startsWith('{"apiVersion"') || line.includes('"event":"ready"'));
      if (line) { clearTimeout(timeout); resolve(JSON.parse(line)); }
    });
  });
  const connection = JSON.parse(readFileSync(path.join(directory, "connection.json"), "utf8"));
  assert.equal(connection.pid, child.pid);
  assert.equal(connection.baseUrl, ready.baseUrl);
  assert.ok(!output.includes(connection.token));
  const headers = { authorization: `Bearer ${connection.token}` };
  const request = (route, init = {}) => fetch(connection.baseUrl + route, { ...init, headers: { ...headers, ...init.headers }, signal: init.signal ?? AbortSignal.timeout(5000) });
  assert.equal((await fetch(connection.baseUrl + "/v1/health")).status, 401);
  assert.equal((await request("/v1/health", { headers: { origin: "https://example.invalid" } })).status, 403);
  const health = await (await request("/v1/health")).json();
  assert.equal(health.backend, "rust");
  const page = await (await request("/v1/sessions?limit=10")).json();
  assert.equal(page.items.length, 10);
  assert.ok(page.hasMore);
  assert.equal(page.total, 100);
  assert.equal(page.latestSeq, 0);
  const summary = await (await request("/v1/sessions/summary")).json();
  assert.deepEqual(summary, { revision: 100, total: 100, active: 0, archived: 100, attention: 0, latestSeq: 0 });
  const workspaces = await (await request("/v1/workspaces?limit=1")).json();
  assert.equal(workspaces.items[0].workspace, "/synthetic");
  assert.equal(workspaces.items[0].summary.total, 100);
  assert.equal(workspaces.hasMore, false);
  const second = await (await request(`/v1/sessions?limit=10&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
  assert.equal(new Set([...page.items, ...second.items].map(item => item.id)).size, 20);
  const stream = await request("/v1/events/stream?scope=sessions&afterSeq=0", { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const initial = await reader.read(); assert.ok(new TextDecoder().decode(initial.value).includes("connected"));
  const id = page.items[0].id;
  const renamed = await request(`/v1/sessions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: 1, title: "HTTP integration" }) });
  assert.equal(renamed.status, 200);
  const next = await reader.read();
  assert.ok(new TextDecoder().decode(next.value).includes("session.updated"));
  const replay = await (await request("/v1/events?scope=sessions&afterSeq=0")).json();
  assert.equal(replay.items[0].data.title, "HTTP integration");
  const search = await (await request("/v1/sessions?text=HTTP%20integ&workspace=%2Fsynthetic")).json();
  assert.equal(search.total, 1);
  assert.equal(search.items[0].id, id);
  assert.equal(search.latestSeq, 1);
  const lookup = await (await request("/v1/sessions/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id, "missing", id] }) })).json();
  assert.deepEqual(lookup.items.map(item => item.id), [id]);
  assert.deepEqual(lookup.missingIds, ["missing"]);
  assert.equal(lookup.latestSeq, 1);
  const content = await request(`/v1/sessions/${id}/content/history?offset=0`);
  assert.equal((await content.arrayBuffer()).byteLength, 1024);
  const contentList = await (await request(`/v1/sessions/${id}/contents?limit=1`)).json();
  assert.deepEqual(contentList.items, [{ id: "history", bytes: 1024 }]);
  controller.abort(); await reader.cancel().catch(() => {});
  const exited = once(child, "exit");
  assert.equal((await request("/v1/shutdown", { method: "POST" })).status, 202);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  const [code] = await exited; clearTimeout(timeout);
  assert.equal(code, 0);
  assert.ok(!existsSync(path.join(directory, "connection.json")));
  console.log(JSON.stringify({ ok: true, authentication: true, paging: true, summary: true, workspacePaging: true, search: true, lookup: true, committedReplay: true, liveEvents: true, contentChunks: true, gracefulShutdown: true }));
} finally {
  controller.abort();
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
  rmSync(directory, { recursive: true, force: true });
}
