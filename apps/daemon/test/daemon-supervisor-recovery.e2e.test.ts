/**
 * Full-process recovery acceptance.  This intentionally launches a compiled
 * daemon with a temporary HOME/repository/ports and a fake `codex app-server`.
 * It never observes or modifies a user's daemon, session, Codex installation,
 * account, or provider connection.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

interface DaemonProcess {
  child: ChildProcess;
  port: number;
  stdout: () => string;
  stderr: () => string;
}

interface SessionView {
  kind: "structured";
  evSeq: number;
  events: Array<Record<string, unknown>>;
}

interface StatusFile {
  sessions: Array<{
    id: string;
    status: string;
    pendingPermissions: number;
    pendingQuestions: number;
  }>;
}

interface Manifest {
  supervisorPid?: number;
  status?: string;
  socket: string;
  sessionDir?: string;
}

interface SupervisorArtifact {
  supervisorPid: number | undefined;
  socket: string;
  socketDir: string;
  sessionDir: string;
}

const temporary: string[] = [];
const daemons: DaemonProcess[] = [];
const supervisorGroups = new Set<number>();
const supervisorArtifacts = new Map<string, SupervisorArtifact>();

function temp(prefix: string): string {
  const value = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(value);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${String(last)}` : ""}`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a loopback port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupAlive(groupId: number | undefined): boolean {
  if (!groupId || !Number.isSafeInteger(groupId) || groupId <= 1) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(child: ChildProcess, label: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    delay(10_000).then(() => { throw new Error(`${label} did not exit`); }),
  ]);
}

async function stopDaemon(daemon: DaemonProcess, signal: NodeJS.Signals): Promise<void> {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) return;
  daemon.child.kill(signal);
  await waitForExit(daemon.child, `daemon ${String(daemon.child.pid)}`);
}

function token(home: string): string {
  return readFileSync(path.join(home, "control.token"), "utf8").trim();
}

async function control(
  home: string,
  port: number,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token(home)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.text() };
}

async function controlJson<T>(
  home: string,
  port: number,
  pathname: string,
  body?: unknown,
): Promise<T> {
  const response = await control(home, port, body === undefined ? "GET" : "POST", pathname, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${pathname} returned ${String(response.status)}: ${response.body}`);
  }
  return JSON.parse(response.body) as T;
}

async function action<T>(home: string, port: number, method: string, params: Record<string, unknown>): Promise<T> {
  return controlJson<T>(home, port, "/_prospero/control/orchestration/action", { method, params });
}

function status(home: string): StatusFile {
  return JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as StatusFile;
}

function manifest(home: string, sessionId: string): Manifest {
  const value = JSON.parse(readFileSync(
    path.join(home, "structured-supervisor", sessionId, "manifest.json"),
    "utf8",
  )) as Manifest;
  if (typeof value.socket !== "string" || value.socket.length === 0) {
    throw new Error(`manifest for ${sessionId} did not record a socket`);
  }
  const sessionDir = typeof value.sessionDir === "string"
    ? value.sessionDir
    : path.join(home, "structured-supervisor", sessionId);
  supervisorArtifacts.set(value.socket, {
    supervisorPid: value.supervisorPid,
    socket: value.socket,
    socketDir: path.dirname(value.socket),
    sessionDir,
  });
  return value;
}

async function socketHasListener(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      probe?.destroy();
      resolve(listening);
    };
    let probe: Socket | undefined;
    try {
      probe = createConnection(socketPath);
    } catch {
      resolve(false);
      return;
    }
    probe.once("connect", () => finish(true));
    probe.once("error", () => finish(false));
  });
}

async function removeConfirmedOrphanRuntime(artifact: SupervisorArtifact): Promise<void> {
  // The path comes from this exact temporary session manifest.  Do not remove
  // it until both its recorded owner and the endpoint listener are gone.
  expect(processAlive(artifact.supervisorPid)).toBe(false);
  expect(processGroupAlive(artifact.supervisorPid)).toBe(false);
  await eventually(async () => !(await socketHasListener(artifact.socket)), "orphan socket listener exit");
  if (existsSync(artifact.socket)) {
    expect(lstatSync(artifact.socket).isSocket()).toBe(true);
    rmSync(artifact.socket, { force: true });
  }
  if (existsSync(artifact.socketDir)) {
    const metadata = lstatSync(artifact.socketDir);
    expect(metadata.isDirectory()).toBe(true);
    expect(metadata.isSymbolicLink()).toBe(false);
    rmdirSync(artifact.socketDir);
  }
}

async function assertNoSupervisorResiduals(): Promise<void> {
  for (const artifact of supervisorArtifacts.values()) {
    await eventually(
      () => !processAlive(artifact.supervisorPid) && !processGroupAlive(artifact.supervisorPid),
      `runner and fake provider process group ${String(artifact.supervisorPid)} exit`,
    );
    expect(existsSync(artifact.socket)).toBe(false);
    expect(existsSync(artifact.socketDir)).toBe(false);
    if (existsSync(artifact.sessionDir)) {
      expect(readdirSync(artifact.sessionDir).some((entry) => entry.startsWith(".bootstrap-"))).toBe(false);
    }
  }
}

async function sessionView(home: string, port: number, sessionId: string): Promise<SessionView> {
  return controlJson<SessionView>(
    home,
    port,
    `/_prospero/control/session/${encodeURIComponent(sessionId)}/view`,
  );
}

function markerDeltas(view: SessionView, marker: string): string[] {
  return view.events.flatMap((event) =>
    event["kind"] === "text.delta" && typeof event["delta"] === "string" && event["delta"].startsWith(marker)
      ? [event["delta"]]
      : [],
  );
}

function eventCount(view: SessionView, kind: string, requestId: string): number {
  return view.events.filter((event) => event["kind"] === kind && event["reqId"] === requestId).length;
}

function daemonCli(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
}

function daemonRunner(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "structured-supervisor-runner.js");
}

function runtimeSnapshots(): string[] {
  const runtimeRoot = path.join(path.dirname(path.dirname(daemonRunner())), ".prospero-runtime");
  if (!existsSync(runtimeRoot)) return [];
  return readdirSync(runtimeRoot).filter((entry) => entry.startsWith("structured-supervisor-"));
}

async function startDaemon(home: string, port: number, fakeBin: string): Promise<DaemonProcess> {
  let stdout = "";
  let stderr = "";
  // `createDaemonServer` keeps in-process adapters for Vitest's normal unit
  // servers.  This child is specifically the production process boundary.
  const { VITEST: _vitest, ...outsideTestEnvironment } = process.env;
  const child = spawn(process.execPath, [daemonCli(), "start", "--port", String(port), "--bind", "127.0.0.1", "--dev", "--no-bonjour"], {
    env: {
      ...outsideTestEnvironment,
      // The temporary HOME ensures both Prospero and Codex cannot find a user
      // account/configuration.  The first PATH entry is our fake executable.
      // `prosperoHome()` appends `.prospero`; `home` in this test names that
      // final private directory, so pass its parent as the process HOME.
      HOME: path.dirname(home),
      PATH: `${fakeBin}${path.delimiter}${process.env["PATH"] ?? ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const daemon = { child, port, stdout: () => stdout, stderr: () => stderr };
  daemons.push(daemon);
  try {
    await eventually(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`daemon exited: ${stdout}\n${stderr}`);
      }
      if (!existsSync(path.join(home, "control.token"))) return false;
      const health = await control(home, port, "GET", "/_prospero/control/health");
      return health.status === 200;
    }, `daemon at ${String(port)}`);
  } catch (error) {
    throw new Error(`${String(error)}\ndaemon stdout:\n${stdout}\ndaemon stderr:\n${stderr}`);
  }
  return daemon;
}

function installFakeCodex(bin: string): void {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs");
  const executable = path.join(bin, "codex");
  writeFileSync(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
}

async function createDispatchedWorker(home: string, port: number, repo: string): Promise<{ sessionId: string; taskId: string; dispatchId: string }> {
  const run = await action<{ id: string }>(home, port, "run.create", { objective: "T7 daemon restart acceptance" });
  const task = await action<{ id: string }>(home, port, "task.create", {
    runId: run.id,
    title: "recover fake Codex worker",
    spec: "T7 isolated recovery validation",
    deps: [],
  });
  const started = await action<{
    session: { id: string };
    dispatch: { id: string };
  }>(home, port, "worker.start", {
    taskId: task.id,
    agent: "codex",
    worktree: "none",
    cwd: repo,
    kind: "structured",
    approvalPolicy: "standard",
  });
  return { sessionId: started.session.id, taskId: task.id, dispatchId: started.dispatch.id };
}

async function sendChat(home: string, port: number, sessionId: string, text: string): Promise<void> {
  const result = await control(home, port, "POST", `/_prospero/control/session/${encodeURIComponent(sessionId)}/interact`, {
    type: "chat.send",
    text,
  });
  if (result.status !== 204) throw new Error(`chat.send returned ${String(result.status)}: ${result.body}`);
}

async function interact(home: string, port: number, sessionId: string, message: Record<string, unknown>): Promise<void> {
  const result = await control(home, port, "POST", `/_prospero/control/session/${encodeURIComponent(sessionId)}/interact`, message);
  if (result.status !== 204) throw new Error(`interaction returned ${String(result.status)}: ${result.body}`);
}

async function waitForSessionStatus(
  home: string,
  sessionId: string,
  expected: Partial<StatusFile["sessions"][number]>,
): Promise<void> {
  await eventually(() => {
    const found = status(home).sessions.find((session) => session.id === sessionId);
    return found !== undefined && Object.entries(expected).every(([key, value]) => found[key as keyof typeof found] === value);
  }, `session ${sessionId} status ${JSON.stringify(expected)}`);
}

async function exerciseSignalRecovery(signal: NodeJS.Signals): Promise<void> {
  const home = path.join(temp(`prospero-t7-${signal.toLowerCase()}-home-`), ".prospero");
  const repo = temp(`prospero-t7-${signal.toLowerCase()}-repo-`);
  const fakeBin = temp(`prospero-t7-${signal.toLowerCase()}-bin-`);
  installFakeCodex(fakeBin);
  const git = spawn("git", ["init", "--quiet", repo], { stdio: "ignore" });
  await waitForExit(git, "temporary git init");
  if (git.exitCode !== 0) throw new Error("temporary git init failed");

  const port1 = await freePort();
  const port2 = await freePort();
  const port3 = await freePort();
  const first = await startDaemon(home, port1, fakeBin);
  const { sessionId, taskId, dispatchId } = await createDispatchedWorker(home, first.port, repo);

  // The fake worker's prompt completes one turn.  The Dispatch must still be
  // running: `completed` is a reusable structured session, never task.done.
  await eventually(async () => (await sessionView(home, first.port, sessionId)).events.some(
    (event) => event["kind"] === "turn.end",
  ), "worker prompt turn completion");
  await waitForSessionStatus(home, sessionId, { status: "completed" });
  const initialStore = JSON.parse(readFileSync(path.join(home, "orchestration.json"), "utf8")) as {
    tasks: Record<string, { status: string }>;
    dispatches: Record<string, { state: string }>;
  };
  expect(initialStore.tasks[taskId]?.status).toBe("dispatched");
  expect(initialStore.dispatches[dispatchId]?.state).toBe("running");

  const longMarker = `${signal.slice(3)}_LONG_${Date.now().toString(36)}`;
  await sendChat(home, first.port, sessionId, `T7_LONG_${longMarker}`);
  await eventually(async () => markerDeltas(await sessionView(home, first.port, sessionId), longMarker)
    .includes(`${longMarker}:middle`), `${signal} long turn progress`);

  const firstManifest = manifest(home, sessionId);
  expect(processAlive(firstManifest.supervisorPid)).toBe(true);
  supervisorGroups.add(firstManifest.supervisorPid!);
  await stopDaemon(first, signal);
  // No daemon cleanup path is allowed to terminate a detached owner.
  expect(processAlive(firstManifest.supervisorPid)).toBe(true);

  const second = await startDaemon(home, port2, fakeBin);
  expect(processAlive(firstManifest.supervisorPid)).toBe(true);
  await eventually(async () => markerDeltas(await sessionView(home, second.port, sessionId), longMarker)
    .includes(`${longMarker}:finished`), `${signal} long turn completion after reattach`);
  const recoveredView = await sessionView(home, second.port, sessionId);
  expect(markerDeltas(recoveredView, longMarker)).toEqual([
    `${longMarker}:started`,
    `${longMarker}:middle`,
    `${longMarker}:finished`,
  ]);
  expect(new Set(markerDeltas(recoveredView, longMarker)).size).toBe(3);
  await waitForSessionStatus(home, sessionId, { status: "completed" });
  const recoveredStore = JSON.parse(readFileSync(path.join(home, "orchestration.json"), "utf8")) as {
    tasks: Record<string, { status: string }>;
    dispatches: Record<string, { state: string }>;
  };
  expect(recoveredStore.tasks[taskId]?.status).toBe("dispatched");
  expect(recoveredStore.dispatches[dispatchId]?.state).toBe("running");

  // A second disconnected daemon exercises the native approval/question
  // callbacks, not just a streaming turn.  While offline the fake server has
  // no response and the supervisor must leave both requests pending.
  const waitMarker = `${signal.slice(3)}_WAIT_${Date.now().toString(36)}`;
  await sendChat(home, second.port, sessionId, `T7_WAIT_${waitMarker}`);
  const approvalId = `approval-${waitMarker}`;
  const questionId = `question-${waitMarker}`;
  await eventually(async () => {
    const view = await sessionView(home, second.port, sessionId);
    return eventCount(view, "permission.request", approvalId) === 1 &&
      eventCount(view, "question.request", questionId) === 1;
  }, "approval and question requests");
  await waitForSessionStatus(home, sessionId, {
    status: "waiting_approval", pendingPermissions: 1, pendingQuestions: 1,
  });
  await stopDaemon(second, signal);
  await delay(180);
  const offlineState = JSON.parse(readFileSync(
    path.join(home, "structured-supervisor", sessionId, "session.json"),
    "utf8",
  )) as { events: Array<Record<string, unknown>> };
  expect(offlineState.events.filter((event) => event["kind"] === "permission.resolved" && event["reqId"] === approvalId)).toHaveLength(0);
  expect(offlineState.events.filter((event) => event["kind"] === "question.resolved" && event["reqId"] === questionId)).toHaveLength(0);

  const third = await startDaemon(home, port3, fakeBin);
  await waitForSessionStatus(home, sessionId, {
    status: "waiting_approval", pendingPermissions: 1, pendingQuestions: 1,
  });
  const replayedPending = await sessionView(home, third.port, sessionId);
  expect(eventCount(replayedPending, "permission.request", approvalId)).toBe(1);
  expect(eventCount(replayedPending, "question.request", questionId)).toBe(1);
  await interact(home, third.port, sessionId, { type: "permission.respond", reqId: approvalId, reply: "once" });
  await waitForSessionStatus(home, sessionId, {
    status: "waiting_input", pendingPermissions: 0, pendingQuestions: 1,
  });
  await interact(home, third.port, sessionId, {
    type: "question.respond",
    reqId: questionId,
    answers: [{ questionId: "continue", values: ["yes"] }],
  });
  await eventually(async () => {
    const view = await sessionView(home, third.port, sessionId);
    return eventCount(view, "permission.resolved", approvalId) === 1 &&
      eventCount(view, "question.resolved", questionId) === 1 &&
      view.events.some((event) => event["kind"] === "turn.end");
  }, "reconnected approval and question resolution");

  // This is deliberately different from daemon shutdown: a local explicit
  // session.kill must terminate the runner and its native fake app-server.
  const liveManifest = manifest(home, sessionId);
  expect(processAlive(liveManifest.supervisorPid)).toBe(true);
  const killed = await control(home, third.port, "POST", `/_prospero/control/session/${encodeURIComponent(sessionId)}/kill`, {});
  expect(killed.status).toBe(204);
  await eventually(
    () => !processAlive(liveManifest.supervisorPid) && !processGroupAlive(liveManifest.supervisorPid),
    "explicit session.kill supervisor and fake provider termination",
  );
  supervisorGroups.delete(liveManifest.supervisorPid!);
  await stopDaemon(third, "SIGTERM");
  await assertNoSupervisorResiduals();
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) {
    if (daemon.child.exitCode === null && daemon.child.signalCode === null) {
      daemon.child.kill("SIGKILL");
      await Promise.race([waitForExit(daemon.child, "test daemon cleanup"), delay(2_000)]);
    }
  }
  // Runners are launched detached.  Test cleanup addresses only the known
  // temporary supervisor process groups; it never scans or touches user PIDs.
  for (const pid of supervisorGroups) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }
  supervisorGroups.clear();

  // A test can fail before its success-path cleanup.  Every entry here came
  // from this test's private manifest, so reap and remove only that exact
  // process group/runtime endpoint; never enumerate user processes or glob
  // /tmp.  This keeps failed test runs as clean as successful ones.
  for (const artifact of supervisorArtifacts.values()) {
    if (processGroupAlive(artifact.supervisorPid)) {
      try { process.kill(-(artifact.supervisorPid!), "SIGKILL"); } catch { /* already gone */ }
    }
    await eventually(
      () => !processAlive(artifact.supervisorPid) && !processGroupAlive(artifact.supervisorPid),
      `fixture supervisor process group ${String(artifact.supervisorPid)} exit`,
    );
    await removeConfirmedOrphanRuntime(artifact);
  }
  supervisorArtifacts.clear();
  // Every entry was created with mkdtempSync by this test.  This is never a
  // glob or a user-owned runtime root; production-residual assertions happen
  // in the test body before this final isolated fixture cleanup.
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.sequential("daemon supervisor SIGTERM/SIGKILL full-process recovery", () => {
  it.skipIf(process.platform === "win32")("launches a new owner from the daemon-start runtime snapshot after dist is overwritten", async () => {
    const home = path.join(temp("prospero-snapshot-home-"), ".prospero");
    const repo = temp("prospero-snapshot-repo-");
    const fakeBin = temp("prospero-snapshot-bin-");
    installFakeCodex(fakeBin);
    const git = spawn("git", ["init", "--quiet", repo], { stdio: "ignore" });
    await waitForExit(git, "snapshot temporary git init");
    if (git.exitCode !== 0) throw new Error("snapshot temporary git init failed");

    const before = new Set(runtimeSnapshots());
    const daemon = await startDaemon(home, await freePort(), fakeBin);
    const createdSnapshots = runtimeSnapshots().filter((entry) => !before.has(entry));
    expect(createdSnapshots).toHaveLength(1);
    const snapshotRunner = path.join(
      path.dirname(path.dirname(daemonRunner())),
      ".prospero-runtime",
      createdSnapshots[0]!,
      "dist",
      "structured-supervisor-runner.js",
    );
    expect(readFileSync(snapshotRunner, "utf8")).toContain("runStructuredSupervisor");

    const runner = daemonRunner();
    const original = readFileSync(runner, "utf8");
    try {
      // The daemon has already started. A direct dist launch would now exit
      // immediately; the only successful route is its frozen snapshot.
      writeFileSync(runner, "throw new Error('mutable dist runner must not be used');\n");
      const created = await controlJson<{ id: string }>(home, daemon.port, "/_prospero/control/session/create", {
        agent: "codex",
        kind: "structured",
        cwd: repo,
        cols: 80,
        rows: 24,
      });
      const owned = manifest(home, created.id);
      expect(processAlive(owned.supervisorPid)).toBe(true);
      supervisorGroups.add(owned.supervisorPid!);
      const killed = await control(home, daemon.port, "POST", `/_prospero/control/session/${encodeURIComponent(created.id)}/kill`, {});
      expect(killed.status).toBe(204);
      await eventually(
        () => !processAlive(owned.supervisorPid) && !processGroupAlive(owned.supervisorPid),
        "snapshot-owned runner exit",
      );
      supervisorGroups.delete(owned.supervisorPid!);
    } finally {
      writeFileSync(runner, original);
      await stopDaemon(daemon, "SIGTERM");
    }
  });

  it.skipIf(process.platform === "win32")("SIGTERM preserves the long turn, ordered replay, pending interactions, and dispatch", async () => {
    await exerciseSignalRecovery("SIGTERM");
  });

  it.skipIf(process.platform === "win32")("SIGKILL preserves the long turn, ordered replay, pending interactions, and dispatch", async () => {
    await exerciseSignalRecovery("SIGKILL");
  });

  it.skipIf(process.platform === "win32")("keeps legacy in-process history readable and exposes a killed supervisor as a real read-only died session", async () => {
    const legacyHome = path.join(temp("prospero-t7-legacy-home-"), ".prospero");
    const fakeBin = temp("prospero-t7-legacy-bin-");
    installFakeCodex(fakeBin);
    mkdirSync(legacyHome, { recursive: true, mode: 0o700 });
    const legacyId = "legacy-in-process-history";
    writeFileSync(path.join(legacyHome, "structured-sessions.json"), JSON.stringify([{
      version: 1,
      id: legacyId,
      agent: "codex",
      title: "legacy structured history",
      cwd: legacyHome,
      createdAt: 1,
      approvalPolicy: "standard",
      events: [{ kind: "text.delta", msgId: "legacy", textId: "legacy", delta: "legacy preserved" }],
      evSeq: 1,
      preview: "legacy preserved",
      previewRaw: "legacy preserved",
      previewMsgId: "legacy",
      totals: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      toolOutputs: [],
      adapterState: { nativeId: "old-in-process-adapter" },
      messageQueue: [],
      terminal: true,
    }]), { mode: 0o600 });
    const legacyDaemon = await startDaemon(legacyHome, await freePort(), fakeBin);
    await waitForSessionStatus(legacyHome, legacyId, { status: "done" });
    expect((await sessionView(legacyHome, legacyDaemon.port, legacyId)).events)
      .toContainEqual(expect.objectContaining({ kind: "text.delta", delta: "legacy preserved" }));
    await stopDaemon(legacyDaemon, "SIGTERM");

    const orphanHome = path.join(temp("prospero-t7-orphan-home-"), ".prospero");
    const orphanRepo = temp("prospero-t7-orphan-repo-");
    const orphanBin = temp("prospero-t7-orphan-bin-");
    installFakeCodex(orphanBin);
    const git = spawn("git", ["init", "--quiet", orphanRepo], { stdio: "ignore" });
    await waitForExit(git, "orphan temporary git init");
    if (git.exitCode !== 0) throw new Error("orphan temporary git init failed");
    const first = await startDaemon(orphanHome, await freePort(), orphanBin);
    const created = await controlJson<{ id: string }>(orphanHome, first.port, "/_prospero/control/session/create", {
      agent: "codex",
      kind: "structured",
      cwd: orphanRepo,
      cols: 80,
      rows: 24,
    });
    await sendChat(orphanHome, first.port, created.id, "T7 orphan cache");
    await eventually(async () => (await sessionView(orphanHome, first.port, created.id)).events.some(
      (event) => event["kind"] === "turn.end",
    ), "orphan cache turn completion");
    const owned = manifest(orphanHome, created.id);
    expect(processAlive(owned.supervisorPid)).toBe(true);
    supervisorGroups.add(owned.supervisorPid!);
    // This is a supervisor crash, not session.kill.  On the next daemon boot
    // it must remain an inspectable `died` history rather than a new turn.
    process.kill(-(owned.supervisorPid!), "SIGKILL");
    await eventually(
      () => !processAlive(owned.supervisorPid) && !processGroupAlive(owned.supervisorPid),
      "simulated supervisor and fake provider crash",
    );
    supervisorGroups.delete(owned.supervisorPid!);
    const orphanRuntime: SupervisorArtifact = {
      supervisorPid: owned.supervisorPid,
      socket: owned.socket,
      socketDir: path.dirname(owned.socket),
      sessionDir: owned.sessionDir ?? path.join(orphanHome, "structured-supervisor", created.id),
    };
    // SIGKILL bypasses runner cleanup.  Remove only this recorded endpoint,
    // after proving its exact owner and listener are both gone.
    await removeConfirmedOrphanRuntime(orphanRuntime);
    await stopDaemon(first, "SIGTERM");

    const second = await startDaemon(orphanHome, await freePort(), orphanBin);
    await waitForSessionStatus(orphanHome, created.id, { status: "died" });
    const historical = await sessionView(orphanHome, second.port, created.id);
    expect(historical.events).toContainEqual(expect.objectContaining({ kind: "turn.end" }));
    const rejected = await control(
      orphanHome,
      second.port,
      "POST",
      `/_prospero/control/session/${encodeURIComponent(created.id)}/interact`,
      { type: "chat.send", text: "must not create a replacement turn" },
    );
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatch(/disconnected|unavailable/i);
    await stopDaemon(second, "SIGTERM");
    await assertNoSupervisorResiduals();
  });
});
