import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = await mkdtemp(path.join(os.tmpdir(), "prospero-session-lifecycle-"));
const home = path.join(fixture, "daemon");
const history = path.join(fixture, "native.json");
const cli = path.join(root, "apps/mobile/scripts/native-session-fixture.cjs");
const binary = process.env.PROSPERO_TEST_DAEMON || path.join(root, "target/debug/prosperod-rs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let connection;
let stderr = "";
const sessions = new Set();
const checks = [];
async function until(read, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(50); }
  throw new Error(`Timed out: ${stderr.slice(-1500)}`);
}
async function request(route, data, allowError = false) {
  const response = await fetch(connection.baseUrl + route, { method: data === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(60_000) });
  const value = await response.json();
  if (!allowError) assert(response.ok, `${route}: ${JSON.stringify(value)}`);
  return { status: response.status, value };
}
async function head(id) { return (await request(`/v1/sessions/${id}`)).value; }
async function bound(id) { return until(async () => { const value = await head(id); return value.nativeSession?.state === "running" && value.nativeSession.nativeId && value; }); }
async function start() {
  child = spawn(binary, ["serve", "--data-dir", home], { env: { ...process.env, PROSPERO_CODEX_BIN: cli, PROSPERO_CLAUDE_BIN: cli, PROSPERO_NATIVE_FIXTURE: history }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-8000); });
  connection = await until(async () => { try { const c = JSON.parse(await readFile(path.join(home, "connection.json"), "utf8")); return c.pid === child.pid && c; } catch { return undefined; } });
}
async function stop() {
  const exited = once(child, "exit");
  await request("/v1/shutdown", {}).catch(() => {});
  await Promise.race([exited, delay(7000)]);
  if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([exited, delay(3000)]); }
}
try {
  await mkdir(home);
  await start();
  const { value: empty } = await request("/v1/terminals", { agent: "codex", title: "Empty lifecycle fixture", workspace: fixture, size: { cols: 96, rows: 32 } });
  sessions.add(empty.id);
  await request(`/v1/sessions/${empty.id}/archive`, {});
  const emptyRestored = (await request(`/v1/sessions/${empty.id}/resume`, {})).value;
  assert.equal(emptyRestored.id, empty.id);
  assert.equal(emptyRestored.nativeSession.nativeId, null);
  assert.notEqual(emptyRestored.nativeSession.runtimeId, empty.nativeSession.runtimeId);
  await request(`/v1/sessions/${empty.id}/archive`, {});
  checks.push("an unused managed terminal can archive and reopen without inventing saved history");
  const { value: legacy } = await request("/v1/terminals", { agent: "codex", command: "cat", title: "Legacy lifecycle fixture", workspace: fixture, size: { cols: 96, rows: 32 } });
  sessions.add(legacy.id);
  const unbound = await request(`/v1/sessions/${legacy.id}/archive`, {}, true);
  assert.equal(unbound.value.code, "session_binding_required");
  assert.equal((await head(legacy.id)).lifecycle, "active");
  await request(`/v1/terminals/${legacy.id}/close`, {});
  await until(async () => (await request("/v1/health")).value.control.terminalSessionsActive === 0);
  checks.push("an unbound legacy terminal is preserved until its native conversation is selected");
  for (const agent of ["codex", "claude"]) {
    const { value: created } = await request("/v1/terminals", { agent, title: "Lifecycle fixture", workspace: fixture, size: { cols: 96, rows: 32 }, approvalPolicy: "strict" });
    sessions.add(created.id);
    await until(async () => {
      const page = (await request(`/v1/terminals/${created.id}/output?afterSeq=0`)).value;
      return page.events.some(event => event.type === "output" && Buffer.from(event.dataB64, "base64").toString().includes("NATIVE="));
    });
    await request(`/v1/terminals/${created.id}/input`, { dataB64: Buffer.from("before archive\n").toString("base64") });
    let active = await bound(created.id);
    const firstId = active.nativeSession.nativeId;
    await until(async () => JSON.parse(await readFile(history, "utf8"))[firstId]?.messages.length === 1);
    await request(`/v1/terminals/${created.id}/input`, { dataB64: Buffer.from("/clear\n").toString("base64") });
    await delay(500);
    await request(`/v1/terminals/${created.id}/input`, { dataB64: Buffer.from("retained context\n").toString("base64") });
    active = await until(async () => { const h = await head(created.id); return h.nativeSession?.nativeId && h.nativeSession.nativeId !== firstId && h; });
    const nativeId = active.nativeSession.nativeId;
    await until(async () => JSON.parse(await readFile(history, "utf8"))[nativeId]?.messages.length === 1);
    const beforeSeq = (await request(`/v1/terminals/${created.id}/snapshot`)).value.seq;
    const archived = (await request(`/v1/sessions/${created.id}/archive`, {})).value;
    assert.equal(archived.lifecycle, "archived");
    assert.equal(archived.nativeSession.nativeId, nativeId);
    assert.equal((await request("/v1/health")).value.control.terminalSessionsActive, 0);
    checks.push(`${agent}: exact ID capture, temporary-thread isolation, /clear tracking and resource release`);
    await stop(); await start();
    const attempts = await Promise.all([request(`/v1/sessions/${created.id}/resume`, {}, true), request(`/v1/sessions/${created.id}/resume`, {}, true)]);
    assert.equal(attempts.filter(result => result.status === 200).length, 1);
    const resumed = attempts.find(result => result.status === 200).value;
    assert.equal(resumed.id, created.id);
    assert.equal(resumed.nativeSession.nativeId, nativeId);
    assert.notEqual(resumed.nativeSession.runtimeId, active.nativeSession.runtimeId);
    assert((await request(`/v1/terminals/${created.id}/snapshot`)).value.seq > beforeSeq);
    assert.deepEqual(JSON.parse(await readFile(history, "utf8"))[nativeId].messages, ["retained context"]);
    await request(`/v1/terminals/${created.id}/input`, { dataB64: Buffer.from("after resume\n").toString("base64") });
    await until(async () => JSON.parse(await readFile(history, "utf8"))[nativeId].messages.length === 2);
    checks.push(`${agent}: same logical session, same native history, new instance and monotonic output`);
    await request(`/v1/sessions/${created.id}/archive`, {});
    const data = JSON.parse(await readFile(history, "utf8")); delete data[nativeId]; await writeFile(history, JSON.stringify(data));
    const failed = await request(`/v1/sessions/${created.id}/resume`, {}, true);
    assert(failed.status >= 400);
    assert.equal((await head(created.id)).lifecycle, "archived");
    assert.deepEqual(Object.keys(JSON.parse(await readFile(history, "utf8"))).sort(), Object.keys(data).sort());
    checks.push(`${agent}: missing native history never falls back to a fresh conversation`);
  }
  console.log(JSON.stringify({ ok: true, isolated: true, checks }, null, 2));
} finally {
  if (connection) {
    for (const id of sessions) await request(`/v1/terminals/${id}/close`, {}, true).catch(() => {});
    await stop().catch(() => {});
  }
  for (const name of await readdir(path.join(home, "terminal-hosts")).catch(() => [])) {
    const host = JSON.parse(await readFile(path.join(home, "terminal-hosts", name, "host.json"), "utf8").catch(() => "null"));
    if (!host) continue;
    for (const action of ["close", "release"]) await fetch(new URL(action, host.base_url), { method: "POST", headers: { authorization: `Bearer ${host.token}` }, signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
  if (process.env.PROSPERO_KEEP_FIXTURE) console.log(JSON.stringify({ fixture }));
  else await rm(fixture, { recursive: true, force: true });
}
