import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import { RemoteStructuredSession, reconnectStructuredSupervisors, type StructuredSupervisorManifest } from "../src/structured-supervisor-client.js";
import { startStructuredSupervisor, type StructuredSupervisor, type SupervisorAdapterContext } from "../src/structured-supervisor.js";

const homes: string[] = [];
const supervisors: StructuredSupervisor[] = [];
const remotes: RemoteStructuredSession[] = [];
const sockets: Server[] = [];
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!check()) { if (Date.now() > deadline) throw new Error("fixture condition did not arrive"); await delay(5); }
}
function home(): string { const value = mkdtempSync("/tmp/p-life-"); homes.push(value); return value; }
function manifest(root: string, id: string): StructuredSupervisorManifest {
  const directory = path.join(root, id); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const value: StructuredSupervisorManifest = { version: 1, protocolVersion: 1, implementation: "supervisor", sessionId: id, agent: "codex", title: "synthetic lifecycle", cwd: root, createdAt: Date.now(), approvalPolicy: "standard", socket: path.join(directory, "s.sock"), tokenFile: "token", sessionDir: directory, supervisorPid: process.pid, lifecycleEpoch: `test-${id}`, status: "starting" };
  writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(value), { mode: 0o600 });
  writeFileSync(path.join(directory, "token"), "synthetic-local-supervisor-token", { mode: 0o600 });
  return value;
}
async function fixture(notifications = true, root = home(), id = "session") {
  const owner = manifest(root, id);
  let info: SessionInfo = { id, agent: "codex", kind: "structured", title: "synthetic lifecycle", cwd: root, createdAt: owner.createdAt, cols: 80, rows: 24, status: "starting", pendingPermissions: 0, pendingQuestions: 0 };
  let context!: SupervisorAdapterContext;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let infoCalls = 0;
  let infoOverride: (() => Promise<SessionInfo>) | undefined;
  const supervisor = await startStructuredSupervisor({ home: owner.sessionDir!, socketPath: owner.socket, tokenPath: path.join(owner.sessionDir!, "token"), token: "synthetic-local-supervisor-token" }); supervisors.push(supervisor);
  const started = supervisor.createSession(id, {
    stateNotifications: notifications,
    async start(ctx) {
      context = ctx; await ready; info = { ...info, status: "idle" };
      if (notifications) ctx.state(info);
    },
    async call(method) {
      if (method === "info") { infoCalls += 1; return infoOverride ? infoOverride() : info; }
      if (method === "setModel") return { model: "fixture-model" };
      if (method === "snapshot") return { events: [], evSeq: 0 };
      throw new Error("unsupported synthetic control");
    },
  });
  await eventually(() => !!context);
  const remote = await RemoteStructuredSession.attach(owner); remotes.push(remote);
  return {
    owner, supervisor, remote, context, started, release,
    get infoCalls() { return infoCalls; },
    setInfo(next: Partial<SessionInfo>) { info = { ...info, ...next }; context.state(info); },
    blockInfo(handler: () => Promise<SessionInfo>) { infoOverride = handler; },
  };
}

afterEach(async () => {
  for (const remote of remotes.splice(0)) await remote.dispose();
  for (const supervisor of supervisors.splice(0)) await supervisor.close();
  for (const server of sockets.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("structured supervisor lifecycle metadata", () => {
  it("pushes starting to idle without any agent event and does not repeat identical metadata", async () => {
    const value = await fixture();
    expect(value.remote.info().status).toBe("starting");
    const states: SessionInfo[] = []; value.remote.on("state", (info) => states.push(info));
    value.release(); await value.started;
    await eventually(() => value.remote.info().status === "idle");
    value.setInfo({ status: "idle" }); value.setInfo({ status: "idle" });
    await delay(20);
    expect(value.remote.snapshot().evSeq).toBe(0);
    expect(states.map((info) => info.status)).toEqual(["idle"]);
    expect(value.infoCalls).toBe(1);
  });

  it("keeps every streamed event while avoiding one metadata broadcast per token", async () => {
    const value = await fixture(); value.release(); await value.started;
    await eventually(() => value.remote.info().status === "idle");
    let events = 0; let states = 0;
    value.remote.on("event", () => events++); value.remote.on("state", () => states++);
    for (let index = 0; index < 1000; index++) value.context.emit({ kind: "text.delta", msgId: "fixture", textId: "fixture", delta: "x" });
    await eventually(() => events === 1000);
    expect(value.remote.snapshot().evSeq).toBe(1000);
    expect(value.remote.info().status).toBe("running");
    expect(states).toBe(1);
    expect(value.infoCalls).toBe(1);
  });

  it("polls an older runner that has no lifecycle notification extension until initialization finishes", async () => {
    const value = await fixture(false);
    value.release(); await value.started;
    await eventually(() => value.remote.info().status === "idle");
    expect(value.infoCalls).toBeGreaterThanOrEqual(2);
  });

  it("does not overwrite a newer lifecycle push with an older in-flight info RPC", async () => {
    const value = await fixture(); value.release(); await value.started;
    await eventually(() => value.remote.info().status === "idle");
    let reply!: (info: SessionInfo) => void;
    value.blockInfo(() => new Promise((resolve) => { reply = resolve; }));
    await value.remote.setModel("fixture-model");
    await eventually(() => typeof reply === "function");
    const stale = value.remote.info();
    value.setInfo({ status: "completed", preview: "synthetic preview" });
    await eventually(() => value.remote.info().status === "completed");
    reply(stale); await delay(20);
    expect(value.remote.info().status).toBe("completed");
  });

  it("reports a lost owner as died instead of leaving an attached session starting forever", async () => {
    const value = await fixture(); value.release(); await value.started;
    await value.supervisor.close(); supervisors.splice(supervisors.indexOf(value.supervisor), 1);
    await eventually(() => value.remote.info().status === "died");
  });

  it("bounds a silent owner during restore without delaying healthy peers behind its timeout", async () => {
    const root = home();
    const stalled = manifest(root, "a-stalled");
    const server = createServer((socket) => socket.resume()); sockets.push(server);
    await new Promise<void>((resolve) => server.listen(stalled.socket, resolve)); chmodSync(stalled.socket, 0o600);
    const value = await fixture(true, root, "b-healthy"); value.release(); await value.started;
    const before = value.infoCalls;
    const pending = reconnectStructuredSupervisors(root, 250);
    await eventually(() => value.infoCalls > before);
    const restored = await pending; remotes.push(...restored);
    expect(restored.map((session) => ({ id: session.id, hosting: session.hosting }))).toEqual([
      { id: "a-stalled", hosting: "unavailable" }, { id: "b-healthy", hosting: "supervisor" },
    ]);
  });
});
