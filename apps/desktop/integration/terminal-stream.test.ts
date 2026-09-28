import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { expect, it } from "vitest";
import { decodeTerminalFrame, encodeTerminalFrame, TerminalStreamKind as K, type TerminalStreamFrame } from "../src/shared/terminal-stream";
import { cleanupTerminalHosts } from "./terminal-host-cleanup";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const body = (frame: TerminalStreamFrame) => JSON.parse(new TextDecoder().decode(frame.payload));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class Peer {
  readonly frames: TerminalStreamFrame[] = [];
  private nextOperation = 0;
  private changed = new Set<() => void>();
  constructor(readonly socket: WebSocket, readonly acknowledge = true) {
    socket.on("message", (data, binary) => {
      if (!binary) return;
      const frame = decodeTerminalFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), "server");
      this.frames.push(frame);
      if (acknowledge && [K.Snapshot, K.Output, K.Resize].includes(frame.kind as typeof K.Output)) {
        this.send(K.Applied, frame.sequence, new Uint8Array());
      }
      for (const notify of this.changed) notify();
    });
    socket.on("error", () => { for (const notify of this.changed) notify(); });
  }
  send(kind: TerminalStreamFrame["kind"], sequence: number, payload: Uint8Array) {
    this.socket.send(encodeTerminalFrame({ kind, sequence, payload }));
  }
  async wait(predicate: (frame: TerminalStreamFrame) => boolean, timeout = 10000): Promise<TerminalStreamFrame> {
    const existing = this.frames.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.changed.delete(check); reject(new Error(`stream wait timed out; frame kinds: ${this.frames.map(f => f.kind).join(",")}`)); }, timeout);
      const check = () => { const found = this.frames.find(predicate); if (found) { clearTimeout(timer); this.changed.delete(check); resolve(found); } };
      this.changed.add(check); check();
    });
  }
  async operation(kind: TerminalStreamFrame["kind"], payload = new Uint8Array()) {
    const sequence = ++this.nextOperation;
    this.send(kind, sequence, payload);
    return body(await this.wait(frame => frame.kind === K.Result && frame.sequence === sequence));
  }
  get output() { return this.frames.filter(f => f.kind === K.Output || f.kind === K.Snapshot).map(f => new TextDecoder().decode(f.payload)).join(""); }
}

type AttachOptions = { acknowledge?: boolean; wantControl?: boolean; afterSeq?: number; epoch?: string };
type Fixture = { restart: () => Promise<void>; connectOwner: (id: string, options?: AttachOptions) => Promise<Peer>; request: (path: string, data?: unknown, method?: string) => Promise<Response>; connect: (id: string, options?: { acknowledge?: boolean; wantControl?: boolean; afterSeq?: number; epoch?: string }) => Promise<Peer> };
async function fixture(run: (fixture: Fixture) => Promise<void>) {
  const directory = await mkdtemp(resolve(tmpdir(), "prospero-stream-"));
  const peers: Peer[] = [];
  let daemon: ChildProcess | undefined;
  let connection: { baseUrl: string; token: string } | undefined;
  const launch = async () => {
    daemon = spawn(process.env.PROSPERO_TEST_DAEMON || resolve("../../target/debug/prosperod-rs"), ["serve", "--data-dir", directory], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((done, fail) => {
      let stdout = "", stderr = "";
      const timer = setTimeout(() => fail(new Error(`daemon startup timeout: ${stderr}`)), 15000);
      daemon!.stderr!.on("data", chunk => { stderr += chunk; });
      daemon!.once("error", error => { clearTimeout(timer); fail(error); });
      daemon!.once("exit", () => { clearTimeout(timer); fail(new Error(`daemon exited: ${stderr}`)); });
      daemon!.stdout!.on("data", chunk => { stdout += chunk; if (stdout.includes('"event":"ready"')) { clearTimeout(timer); done(); } });
    });
    connection = JSON.parse(await readFile(resolve(directory, "connection.json"), "utf8"));
  };
  try {
    await launch();
    const request = (path: string, data?: unknown, method?: string) => fetch(connection!.baseUrl + path, { method: method || (data === undefined ? "GET" : "POST"), headers: { authorization: `Bearer ${connection!.token}`, "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) });
    const connectTo = async (url: string, token: string, options: AttachOptions = {}) => {
      const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      const peer = new Peer(socket, options.acknowledge ?? true); peers.push(peer);
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(() => fail(new Error("websocket open timeout")), 10000);
        socket.once("open", () => { clearTimeout(timer); done(); });
        socket.once("error", error => { clearTimeout(timer); fail(error); });
      });
      peer.send(K.Attach, 0, json({ wantControl: options.wantControl ?? true, ...(options.afterSeq === undefined ? {} : { afterSeq: options.afterSeq }), ...(options.epoch ? { epoch: options.epoch } : {}) }));
      return peer;
    };
    const connect = (id: string, options?: AttachOptions) => connectTo(`${connection!.baseUrl.replace(/^http/, "ws")}/v1/terminals/${id}/stream`, connection!.token, options);
    const connectOwner = async (id: string, options?: AttachOptions) => {
      const host = JSON.parse(await readFile(resolve(directory,"terminal-hosts",id,"host.json"),"utf8"));
      expect(new URL(host.base_url).hostname).toBe("127.0.0.1");
      return connectTo(`${host.base_url.replace(/^http/, "ws").replace(/\/$/, "")}/stream`, host.token, options);
    };
    const restart = async () => {
      const exited = once(daemon!, "exit"); daemon!.kill("SIGKILL"); await exited;
      await launch();
    };
    const api: Fixture = { request, connect, connectOwner, restart };
    // Tests supply only fixture-local workspace paths.
    const originalRequest = api.request;
    api.request = (path, data, method) => originalRequest(path, path === "/v1/terminals" && data ? { ...(data as object), workspace: directory } : data, method);
    await run(api);
  } finally {
    for (const peer of peers) peer.socket.terminate();
    await cleanupTerminalHosts(directory);
    if (connection) await fetch(connection.baseUrl + "/v1/shutdown", { method: "POST", headers: { authorization: `Bearer ${connection.token}` } }).catch(() => {});
    if (daemon && daemon.exitCode === null) { const exited = once(daemon, "exit"); const timer = setTimeout(() => daemon?.kill("SIGKILL"), 3000); await exited; clearTimeout(timer); }
    await rm(directory, { recursive: true, force: true });
  }
}

it("streams a real hosted PTY, arbitrates controllers, and prevents legacy writes bypassing the lease", async () => fixture(async ({ request, connect }) => {
  const response = await request("/v1/terminals", { title: "stream ownership", agent: "custom", size: { cols: 80, rows: 24 }, command: "stty raw -echo; printf READY; cat" });
  expect(response.ok).toBe(true); const session = await response.json();
  const owner = await connect(session.id); const hello = body(await owner.wait(f => f.kind === K.Hello));
  await owner.wait(f => f.kind === K.Ready);
  expect(hello.controllerId).toBe(hello.clientId);
  const observer = await connect(session.id); const other = body(await observer.wait(f => f.kind === K.Hello));
  await observer.wait(f => f.kind === K.Ready);
  expect(other.epoch).toBe(hello.epoch); expect(other.controllerId).toBe(hello.clientId);
  expect((await request(`/v1/terminals/${session.id}/input`, { dataB64: Buffer.from("bypass").toString("base64") })).status).toBe(409);
  expect((await observer.operation(K.Input, new TextEncoder().encode("observer"))).ok).toBe(false);
  expect((await observer.operation(K.Acquire, json({ takeover: true }))).ok).toBe(true);
  await owner.wait(f => f.kind === K.State && body(f).controllerId === other.clientId);
  expect((await owner.operation(K.Input, new TextEncoder().encode("revoked"))).ok).toBe(false);
  expect((await observer.operation(K.Input, new TextEncoder().encode("stream-ok"))).ok).toBe(true);
  for (let attempt = 0; attempt < 100 && !owner.output.includes("stream-ok"); attempt++) await sleep(20);
  expect(owner.output).toContain("stream-ok"); expect(owner.output).not.toContain("bypass"); expect(owner.output).not.toContain("revoked");
  const resize = new Uint8Array([0, 100, 0, 30]);
  expect((await observer.operation(K.ResizeRequest, resize)).ok).toBe(true);
  await owner.wait(f => f.kind === K.Resize && f.payload[1] === 100 && f.payload[3] === 30);
  observer.socket.close();
  await owner.wait(f => f.kind === K.State && body(f).controllerId === null);
  expect((await owner.operation(K.Acquire, json({ takeover: false }))).ok).toBe(true);
  expect((await owner.operation(K.Release)).ok).toBe(true);
  expect((await request(`/v1/terminals/${session.id}/input`, { dataB64: Buffer.from("legacy-ok").toString("base64") })).ok).toBe(true);
}), 45000);

it("records written-input acknowledgement latency for persistent streams versus existing HTTP", async () => fixture(async ({ request, connect }) => {
  const response = await request("/v1/terminals", { title: "stream timing", agent: "custom", size: { cols: 80, rows: 24 }, command: "stty raw -echo; printf READY; cat" });
  expect(response.ok).toBe(true); const session = await response.json();
  const http: number[] = [], stream: number[] = [];
  const input = Buffer.from("latency-probe");
  for (let index = 0; index < 25; index++) {
    const start = performance.now();
    const ack = await request(`/v1/terminals/${session.id}/input`, { dataB64: input.toString("base64") });
    expect(ack.ok).toBe(true); await ack.json();
    if (index >= 5) http.push(performance.now() - start);
  }
  const peer = await connect(session.id); await peer.wait(frame => frame.kind === K.Ready);
  for (let index = 0; index < 25; index++) {
    const start = performance.now();
    expect((await peer.operation(K.Input, input)).ok).toBe(true);
    if (index >= 5) stream.push(performance.now() - start);
  }
  const summary = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return { samples: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }; };
  const output = resolve("../../output/desktop-terminal"); await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "stream-benchmark.json"), JSON.stringify({ scope: "Isolated real PTY, input written ACK latency; debug daemon, not paint latency", http: summary(http), stream: summary(stream), raw: { http, stream } }, null, 2));
}), 45000);

it("retains the host epoch and ownership across a control-daemon restart", async () => fixture(async ({ request, connect, connectOwner, restart }) => {
  const created = await request("/v1/terminals", { title: "host authority", agent: "custom", size: { cols: 80, rows: 24 }, command: "stty raw -echo; printf READY; cat" });
  expect(created.ok).toBe(true); const session = await created.json();
  const owner = await connectOwner(session.id); const hello = body(await owner.wait(f => f.kind === K.Hello)); await owner.wait(f => f.kind === K.Ready);
  await restart();
  expect((await request(`/v1/terminals/${session.id}/input`, { dataB64: Buffer.from("bypass-after-restart").toString("base64") })).status).toBe(409);
  const observer = await connect(session.id, { wantControl: false }); const resumed = body(await observer.wait(f => f.kind === K.Hello));
  await observer.wait(f => f.kind === K.Ready);
  expect(resumed.epoch).toBe(hello.epoch); expect(resumed.controllerId).toBe(hello.clientId);
  expect((await owner.operation(K.Input, new TextEncoder().encode("after-daemon-restart"))).ok).toBe(true);
  for (let n = 0; n < 100 && !observer.output.includes("after-daemon-restart"); n++) await sleep(20);
  expect(observer.output).toContain("after-daemon-restart");
}), 45000);

it("resumes only after the committed cursor and rejects stale epochs, duplicate input and future acknowledgements", async () => fixture(async ({ request, connect }) => {
  const created = await request("/v1/terminals", { title: "stream continuity", agent: "custom", size: { cols: 80, rows: 24 }, command: "stty raw -echo; printf READY; cat" });
  expect(created.ok).toBe(true); const session = await created.json();
  const owner = await connect(session.id); const hello = body(await owner.wait(f => f.kind === K.Hello)); await owner.wait(f => f.kind === K.Ready);
  expect((await owner.operation(K.Input, new TextEncoder().encode("BEFORE"))).ok).toBe(true);
  for (let n=0;n<100&&!owner.output.includes("BEFORE");n++) await sleep(20);
  expect(owner.output).toContain("BEFORE");
  const cursor = Math.max(...owner.frames.filter(f => [K.Snapshot,K.Output,K.Resize].includes(f.kind as typeof K.Output)).map(f=>f.sequence));
  const resumed = await connect(session.id, { epoch: hello.epoch, afterSeq: cursor, wantControl: false }); await resumed.wait(f => f.kind === K.Ready);
  expect(resumed.frames.some(f => f.kind === K.Snapshot)).toBe(false);
  expect((await owner.operation(K.Input, new TextEncoder().encode("AFTER"))).ok).toBe(true);
  for (let n=0;n<100&&!resumed.output.includes("AFTER");n++) await sleep(20);
  expect(resumed.output).toContain("AFTER"); expect(resumed.output).not.toContain("BEFORE");
  const stale = await connect(session.id,{epoch:"stale-epoch",afterSeq:cursor,wantControl:false});
  expect(body(await stale.wait(f=>f.kind===K.Error)).code).toBe("epoch_mismatch");
  resumed.send(K.Applied, Number.MAX_SAFE_INTEGER, new Uint8Array());
  expect(body(await resumed.wait(f=>f.kind===K.Error)).code).toBe("protocol_error");
  owner.send(K.Input, 2, new TextEncoder().encode("DUPLICATE"));
  expect(body(await owner.wait(f=>f.kind===K.Error)).code).toBe("protocol_error");
  const observer = await connect(session.id,{wantControl:false}); await observer.wait(f=>f.kind===K.Ready);
  expect(observer.output).not.toContain("DUPLICATE");
}), 45000);

it("bounds an unacknowledged observer without stalling a consuming client", async () => fixture(async ({ request, connect }) => {
  const response = await request("/v1/terminals", { title: "stream pressure", agent: "custom", size: { cols: 80, rows: 24 }, command: "stty -echo; printf READY; read line; python3 -u -c 'import sys; sys.stdout.write(\"x\" * 700000 + \"STREAM_END\"); sys.stdout.flush()'; sleep 5" });
  expect(response.ok).toBe(true); const session = await response.json();
  const fast = await connect(session.id); await fast.wait(f => f.kind === K.Ready);
  const slow = await connect(session.id, { acknowledge: false, wantControl: false });
  const hello = body(await slow.wait(f => f.kind === K.Hello)); await slow.wait(f => f.kind === K.Ready);
  expect((await fast.operation(K.Input, new TextEncoder().encode("go\n"))).ok).toBe(true);
  for (let attempt = 0; attempt < 400 && !fast.output.includes("STREAM_END"); attempt++) await sleep(25);
  expect(fast.output).toContain("STREAM_END");
  const retained = slow.frames.filter(f => [K.Output, K.Snapshot, K.Resize].includes(f.kind as typeof K.Output)).reduce((sum, f) => sum + f.payload.byteLength, 0);
  expect(retained).toBeLessThanOrEqual(hello.windowBytes);
  expect(retained).toBeLessThan(700000);
}), 45000);

it("reports a pruned resume cursor explicitly and permits an authoritative fresh snapshot", async () => fixture(async ({ request, connect }) => {
  const created = await request("/v1/terminals", { title: "stream history", agent: "custom", size: { cols: 80, rows: 24 }, command: "stty -echo; printf READY; read line; python3 -u -c 'import sys,time; [(sys.stdout.write(\"x\"*4096),sys.stdout.flush(),time.sleep(.002)) for _ in range(300)]; sys.stdout.write(\"HISTORY_END\"); sys.stdout.flush()'; sleep 10" });
  expect(created.ok).toBe(true); const session = await created.json();
  const live = await connect(session.id); const hello = body(await live.wait(f=>f.kind===K.Hello)); await live.wait(f=>f.kind===K.Ready);
  expect((await live.operation(K.Input,new TextEncoder().encode("go\n"))).ok).toBe(true);
  for(let n=0;n<500&&!live.output.includes("HISTORY_END");n++)await sleep(20);
  expect(live.output).toContain("HISTORY_END");
  const stale = await connect(session.id,{wantControl:false,epoch:hello.epoch,afterSeq:0});
  expect(body(await stale.wait(f=>f.kind===K.Error)).code).toBe("history_gap");
  expect(stale.frames.some(f=>f.kind===K.Snapshot||f.kind===K.Output)).toBe(false);
  const fresh = await connect(session.id,{wantControl:false}); await fresh.wait(f=>f.kind===K.Ready);
  expect(body(await fresh.wait(f=>f.kind===K.Hello)).epoch).toBe(hello.epoch);
  expect(fresh.frames.some(f=>f.kind===K.Snapshot)).toBe(true);
  expect(fresh.output).toContain("HISTORY_END");
}),45000);
