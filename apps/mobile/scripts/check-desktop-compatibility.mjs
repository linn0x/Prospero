import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { clientHandshakeStart, clientHandshakeFinish, generateKeyPairB64, parseS2C } from "@prospero/protocol";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = await mkdtemp(path.join(os.tmpdir(), "prospero-mobile-parity-"));
const home = path.join(fixture, "daemon");
const binary = process.env.PROSPERO_TEST_DAEMON || path.join(root, "target/debug/prosperod-rs");
const identity = generateKeyPairB64();
const clients = [];
const deviceKeys = new Map();
const sessions = new Set();
const checks = [];
let child;
let connection;
let remoteUrl;
let stderr = "";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`Compatibility fixture timed out: ${stderr.slice(-2000)}`);
}
async function request(route, body) {
  const response = await fetch(connection.baseUrl + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
  });
  assert(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
async function connect(token) {
  const ws = new WebSocket(remoteUrl.replace(/^http/, "ws") + "/ws");
  clients.push(ws);
  const frames = [];
  ws.on("message", bytes => frames.push(bytes.toString()));
  await once(ws, "open");
  const start = clientHandshakeStart();
  ws.send(start.frame);
  const proof = await until(() => frames.shift());
  const keys = deviceKeys.get(token) ?? generateKeyPairB64();
  deviceKeys.set(token, keys);
  const { channel, frame } = clientHandshakeFinish(start.state, proof, identity.publicKey, {
    type: "hello", token, clientPubKey: keys.publicKey, clientInfo: { platform: "android", appVersion: "compatibility-test" },
  });
  ws.send(frame);
  const messages = [];
  const receive = async predicate => until(() => {
    while (frames.length) messages.push(parseS2C(channel.open(frames.shift())));
    const index = messages.findIndex(predicate);
    return index < 0 ? undefined : messages.splice(index, 1)[0];
  });
  const hello = await receive(message => message.type === "hello.ok");
  return { hello, receive, send: message => ws.send(channel.seal(message)), close: () => ws.close() };
}

try {
  await mkdir(home);
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const remotePort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  remoteUrl = `http://127.0.0.1:${remotePort}`;
  await writeFile(path.join(home, "config.json"), JSON.stringify({ port: remotePort, bind: "127.0.0.1" }));
  await writeFile(path.join(home, "identity.json"), JSON.stringify(identity), { mode: 0o600 });
  await writeFile(path.join(home, "devices.json"), JSON.stringify({ devices: [
    { name: "fixture", token: "fixture-mobile-parity", allowShell: true, createdAt: 1 },
    { name: "restricted", token: "fixture-no-shell", allowShell: false, createdAt: 1 },
  ] }), { mode: 0o600 });
  const cli = path.join(fixture, "codex-fixture.py");
  await writeFile(cli, `#!/usr/bin/env python3\nimport json,sys,time\nwith open(${JSON.stringify(path.join(fixture, "launches.jsonl"))}, "a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\nprint("MOBILE_RESTORE_中文", flush=True)\nfor line in sys.stdin: print("ACK_"+line.strip(), flush=True)\n`, { mode: 0o700 });
  child = spawn(binary, ["serve", "--data-dir", home, "--remote-ws"], { env: { ...process.env, PROSPERO_CODEX_BIN: cli }, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-8000); });
  connection = await until(async () => {
    try { return JSON.parse(await readFile(path.join(home, "connection.json"), "utf8")); } catch { return undefined; }
  });
  assert.equal((await fetch(remoteUrl + "/v1/health")).status, 404);
  checks.push("separate remote listener exposes only encrypted WebSocket");
  const mobile = await connect("fixture-mobile-parity");
  for (const capability of ["session.fork.v1", "terminal.remote.v1", "agent.accounts.v1", "orchestration.snapshot.v1", "operations.query.v1"]) {
    assert(mobile.hello.host.capabilities.includes(capability), capability);
  }
  checks.push("encrypted handshake and feature negotiation");
  const source = await request("/v1/terminals", { agent: "codex", title: "Mobile parity", workspace: fixture, size: { cols: 96, rows: 32 } });
  sessions.add(source.id);
  await until(async () => {
    const snapshot = await request(`/v1/terminals/${source.id}/snapshot`);
    return snapshot && Buffer.from(snapshot.dataB64, "base64").toString().includes("MOBILE_RESTORE_中文");
  });
  mobile.send({ type: "session.attach", sid: source.id });
  const snapshot = await mobile.receive(message => message.type === "term.snapshot" && message.sid === source.id);
  assert(Buffer.from(snapshot.dataB64, "base64").toString().includes("MOBILE_RESTORE_中文"));
  assert(snapshot.ansi.includes("MOBILE_RESTORE_中文"));
  assert.equal(snapshot.cols, 96);
  checks.push("cold terminal snapshot preserves Unicode for new and legacy clients");
  mobile.send({ type: "term.input", sid: source.id, dataB64: Buffer.from("INPUT_PROBE\n").toString("base64") });
  let output = "";
  await until(async () => {
    const message = await mobile.receive(message => message.type === "term.output" && message.sid === source.id);
    output += Buffer.from(message.dataB64, "base64").toString();
    mobile.send({ type: "term.ack", sid: source.id, seq: message.seq });
    return output.includes("ACK_INPUT_PROBE");
  });
  checks.push("terminal keyboard input and output acknowledgement");
  const fork = { type: "session.fork", sid: source.id, requestId: "fork-once" };
  mobile.send(fork);
  mobile.send(fork);
  mobile.send({ type: "connection.ping", id: "fork-ping" });
  await mobile.receive(message => message.type === "connection.pong" && message.id === "fork-ping");
  const branched = await mobile.receive(message => message.type === "session.fork.result" && message.requestId === fork.requestId);
  assert.equal(branched.ok, true, branched.error);
  assert.notEqual(branched.session.id, source.id);
  sessions.add(branched.session.id);
  await until(async () => (await readFile(path.join(fixture, "launches.jsonl"), "utf8")).includes('"fork"'));
  const launches = (await readFile(path.join(fixture, "launches.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(launches.filter(args => args[0] === "fork").length, 1);
  assert(!launches.some(args => args.includes("--last") || args.includes("--continue")));
  checks.push("native terminal fork, duplicate suppression and responsive heartbeat");
  const restricted = await connect("fixture-no-shell");
  restricted.send({ ...fork, requestId: "denied-fork" });
  const denied = await restricted.receive(message => message.type === "session.fork.result" && message.requestId === "denied-fork");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "shell_not_allowed");
  checks.push("shell permission enforced for branch picker");
  mobile.send({ type: "session.kill", sid: source.id });
  await mobile.receive(message => message.type === "session.state" && message.session.id === source.id && ["done", "died"].includes(message.session.status));
  const reopened = await connect("fixture-mobile-parity");
  assert(reopened.hello.sessions.some(session => session.id === source.id && ["done", "died"].includes(session.status)));
  checks.push("terminal completion and recent history survive reconnect");
  const burst = path.join(fixture, "replay-fixture.py");
  await writeFile(burst, `import sys,time
print("\\x1b]9;notification\\x07REPLAY_START", flush=True)
for line in sys.stdin:
 for i in range(150):
  print(str(i)+":"+"x"*8192, flush=True)
  time.sleep(0.004)
 print("REPLAY_END_中文", flush=True)
`);
  const raw = await request("/v1/terminals", { agent: "shell", command: `python3 -u '${burst}'`, title: "Replay fixture", workspace: fixture, size: { cols: 96, rows: 32 } });
  sessions.add(raw.id);
  await delay(400);
  await request(`/v1/terminals/${raw.id}/resize`, { cols: 100, rows: 34 });
  await request(`/v1/terminals/${raw.id}/input`, { dataB64: Buffer.from("burst\n").toString("base64") });
  await delay(1500);
  assert.equal(await request(`/v1/terminals/${raw.id}/snapshot`), null);
  mobile.send({ type: "session.attach", sid: raw.id });
  const reset = await mobile.receive(message => message.type === "term.snapshot" && message.sid === raw.id);
  assert.equal(reset.dataB64, "");
  let restored = "", pages = 0, sawResize = false, cursor = reset.seq;
  await until(async () => {
    const page = await mobile.receive(message => message.type === "term.output" && message.sid === raw.id);
    assert(page.seq > cursor); cursor = page.seq; pages++;
    assert.equal(page.replay, true);
    sawResize ||= page.events.some(event => event.type === "resize" && event.size.cols === 100);
    restored += Buffer.from(page.dataB64, "base64").toString();
    mobile.send({ type: "term.ack", sid: raw.id, seq: page.seq });
    return restored.includes("REPLAY_END_中文");
  });
  assert(pages > 4); assert(sawResize); assert(restored.includes("REPLAY_START"));
  for (let i=0; i<150; i++) assert(restored.includes(`${i}:` + "x".repeat(8192)));
  checks.push("cold replay without snapshots preserves all pages, resize order and replay suppression");
  console.log(JSON.stringify({ ok: true, isolated: true, checks }, null, 2));
} finally {
  for (const client of clients) client.close();
  if (connection) {
    for (const id of sessions) await request(`/v1/terminals/${id}/close`, {}).catch(() => {});
    await request("/v1/shutdown", {}).catch(() => {});
  }
  if (child && child.exitCode === null) {
    await Promise.race([once(child, "exit"), delay(5000)]);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  const hosts = path.join(home, "terminal-hosts");
  for (const name of await readdir(hosts).catch(() => [])) {
    const host = JSON.parse(await readFile(path.join(hosts, name, "host.json"), "utf8").catch(() => "null"));
    if (!host) continue;
    for (const action of ["close", "release"]) await fetch(new URL(action, host.base_url), {
      method: "POST", headers: { authorization: `Bearer ${host.token}` }, signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
  await rm(fixture, { recursive: true, force: true });
}
