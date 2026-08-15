import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  launchStructuredSupervisor,
  RemoteStructuredSession,
  rollbackFailedStructuredSupervisorLaunch,
  type StructuredSupervisorManifest,
} from "../src/structured-supervisor-client.js";

const temporary: string[] = [];
const ownedGroups = new Set<number>();
const servers: Server[] = [];

function temp(prefix: string): string {
  const value = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(value);
  return value;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(check: () => boolean, label: string, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startHangingSocket(socketPath: string): Promise<Server> {
  const server = createServer((socket) => socket.resume());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  servers.push(server);
  return server;
}

async function startDetachedSentinel(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 1) {
    throw new Error("sentinel spawn returned no process group id");
  }
  child.unref();
  ownedGroups.add(child.pid);
  await eventually(() => processAlive(child.pid!), "independent detached sentinel start");
  return child.pid;
}

async function stopOwnedGroup(groupId: number): Promise<void> {
  // The test knows this PGID from its own detached spawn.  Never enumerate or
  // infer a process group while cleaning up a regression fixture.
  try { process.kill(-groupId, "SIGKILL"); } catch { /* already gone */ }
  await eventually(() => !processAlive(groupId), `owned process group ${String(groupId)} exit`);
  ownedGroups.delete(groupId);
}

function installHangingCodex(bin: string): void {
  const fixture = path.join(import.meta.dirname, "fixtures", "hanging-codex-app-server.mjs");
  const executable = path.join(bin, "codex");
  writeFileSync(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
}

function installFakeCodex(bin: string): void {
  const fixture = path.join(import.meta.dirname, "fixtures", "fake-codex-app-server.mjs");
  const executable = path.join(bin, "codex");
  writeFileSync(
    executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`,
    { mode: 0o700 },
  );
  chmodSync(executable, 0o700);
}

function writePrivateJson(file: string, value: unknown): void {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  chmodSync(file, 0o600);
}

interface LegacyRunnerFixture {
  bootstrap: string;
  manifest: StructuredSupervisorManifest;
  socketDir: string;
}

function legacyRunnerFixture(home: string, sessionId: string, environment: Record<string, string>): LegacyRunnerFixture {
  const sessionDir = path.join(home, sessionId);
  mkdirSync(sessionDir, { mode: 0o700 });
  chmodSync(sessionDir, 0o700);
  const socketDir = mkdtempSync("/tmp/prospero-legacy-supervisor-");
  temporary.push(socketDir);
  chmodSync(socketDir, 0o700);
  const createdAt = Date.now();
  const socket = path.join(socketDir, "s.sock");
  const manifest: StructuredSupervisorManifest = {
    version: 1,
    protocolVersion: 1,
    implementation: "supervisor",
    sessionId,
    agent: "codex",
    title: "legacy launcher fixture",
    cwd: home,
    createdAt,
    approvalPolicy: "standard",
    socket,
    transport: "unix_socket",
    tokenFile: "token",
    sessionDir,
    lifecycleEpoch: "legacy-lifecycle-epoch",
    status: "starting",
  };
  writePrivateJson(path.join(sessionDir, "manifest.json"), manifest);
  writeFileSync(path.join(sessionDir, "token"), `${"t".repeat(48)}\n`, { mode: 0o600 });
  chmodSync(path.join(sessionDir, "token"), 0o600);
  const bootstrap = path.join(sessionDir, ".bootstrap-legacy.json");
  // This is the precise old live-launcher shape: it predates transport and
  // lifecycleEpoch, while the private manifest already holds both values.
  writePrivateJson(bootstrap, {
    version: 1,
    sessionId,
    agent: "codex",
    title: manifest.title,
    cwd: home,
    createdAt,
    approvalPolicy: "standard",
    sessionDir,
    attachmentRoot: path.join(sessionDir, "attachments"),
    socketPath: socket,
    socketDir,
    environment,
  });
  return { bootstrap, manifest, socketDir };
}

function compiledRunner(): string {
  return path.join(import.meta.dirname, "..", "dist", "structured-supervisor-runner.js");
}

async function spawnRunner(bootstrap: string, detached: boolean): Promise<ChildProcess> {
  const child = spawn(process.execPath, [compiledRunner()], {
    detached,
    stdio: "ignore",
    env: { ...process.env, PROSPERO_STRUCTURED_SUPERVISOR_CONFIG: bootstrap },
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
}

afterEach(async () => {
  for (const groupId of ownedGroups) {
    try { process.kill(-groupId, "SIGKILL"); } catch { /* already gone */ }
  }
  ownedGroups.clear();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("structured supervisor launch rollback", () => {
  it.skipIf(process.platform === "win32")("recovers an exact legacy live bootstrap only from its matching private manifest", async () => {
    const home = temp("prospero-legacy-live-launcher-");
    const fakeBin = temp("prospero-legacy-live-bin-");
    installFakeCodex(fakeBin);
    const fixture = legacyRunnerFixture(home, "legacy-live-launcher", {
      PATH: `${fakeBin}${path.delimiter}${process.env["PATH"] ?? ""}`,
    });
    const child = await spawnRunner(fixture.bootstrap, true);
    if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 1) {
      throw new Error("legacy runner returned no process group id");
    }
    const groupId = child.pid;
    ownedGroups.add(groupId);
    child.unref();
    try {
      let session: RemoteStructuredSession | null = null;
      const deadline = Date.now() + 3_000;
      while (!session && Date.now() < deadline) {
        try {
          session = await RemoteStructuredSession.attach(fixture.manifest, 300);
        } catch {
          await delay(20);
        }
      }
      if (!session) throw new Error("legacy runner did not become ready");
      expect(existsSync(fixture.bootstrap)).toBe(false);
      const recovered = JSON.parse(readFileSync(path.join(fixture.manifest.sessionDir!, "manifest.json"), "utf8")) as StructuredSupervisorManifest;
      expect(recovered.lifecycleEpoch).toBe(fixture.manifest.lifecycleEpoch);
      expect(recovered.transport).toBe("unix_socket");
      await session.kill();
      await eventually(() => !processAlive(groupId), "legacy runner process group exit", 3_000);
    } finally {
      if (processAlive(groupId)) await stopOwnedGroup(groupId);
      else ownedGroups.delete(groupId);
    }
  });

  it.skipIf(process.platform === "win32")("rejects legacy bootstrap identity mismatches and unknown fields", async () => {
    const home = temp("prospero-legacy-reject-");
    for (const [index, mutate] of [
      (value: Record<string, unknown>) => { value["socketPath"] = path.join(home, "wrong.sock"); },
      (value: Record<string, unknown>) => { value["unexpected"] = true; },
    ].entries()) {
      const fixture = legacyRunnerFixture(home, `legacy-reject-${String(index)}`, {});
      const bootstrap = JSON.parse(readFileSync(fixture.bootstrap, "utf8")) as Record<string, unknown>;
      mutate(bootstrap);
      writePrivateJson(fixture.bootstrap, bootstrap);
      const child = await spawnRunner(fixture.bootstrap, false);
      await expect(waitForExit(child)).resolves.toBe(1);
      expect(existsSync(fixture.bootstrap)).toBe(false);
      expect(existsSync(fixture.manifest.socket)).toBe(false);
    }
  });

  it.skipIf(process.platform === "win32")("reaps only its new detached group after a short attach timeout and preserves an audit manifest", async () => {
    const home = temp("prospero-launch-rollback-home-");
    const fakeBin = temp("prospero-launch-rollback-bin-");
    installHangingCodex(fakeBin);
    const attachSocket = path.join(home, "attach.sock");
    await startHangingSocket(attachSocket);
    const providerPidFile = path.join(home, "provider.pid");
    const sessionId = "launch-rollback-fixture";
    const root = path.join(home, "structured-supervisor");
    // This is deliberately unrelated to the launch under test.  It models a
    // pre-existing detached supervisor and proves rollback never picks it.
    const sentinelGroup = await startDetachedSentinel();

    // The real RemoteStructuredSession client connects to this owned fixture
    // endpoint, which accepts the Unix connection but never replies. The
    // spawned runner itself still starts the hanging fake Codex child.
    const realAttach = RemoteStructuredSession.attach.bind(RemoteStructuredSession);
    const attach = vi.spyOn(RemoteStructuredSession, "attach").mockImplementation(
      (manifest: StructuredSupervisorManifest, timeoutMs?: number) => realAttach({ ...manifest, socket: attachSocket }, timeoutMs),
    );
    try {
      await expect(launchStructuredSupervisor({
        root,
        sessionId,
        agent: "codex",
        title: "launch rollback fixture",
        cwd: home,
        createdAt: Date.now(),
        environment: {
          PATH: `${fakeBin}${path.delimiter}${process.env["PATH"] ?? ""}`,
          PROSPERO_TEST_PROVIDER_PID_FILE: providerPidFile,
        },
        // Much shorter than production's eight seconds, while long enough for
        // the runner to spawn and block in its real Codex initialize request.
        startupTimeoutMs: 1_500,
      })).rejects.toThrow(/supervisor did not become ready/);
    } finally {
      attach.mockRestore();
    }

    const sessionDir = path.join(root, sessionId);
    const manifest = JSON.parse(readFileSync(path.join(sessionDir, "manifest.json"), "utf8")) as StructuredSupervisorManifest;
    const providerPid = Number(readFileSync(providerPidFile, "utf8").trim());
    expect(manifest.supervisorPid).toBeTypeOf("number");
    const runnerPid = manifest.supervisorPid!;
    ownedGroups.add(runnerPid);
    expect(Number.isSafeInteger(providerPid)).toBe(true);
    await eventually(
      () => !processAlive(runnerPid) && !processAlive(providerPid),
      "new runner and provider child exit",
    );
    ownedGroups.delete(runnerPid);

    // A failed launch may only target the exact newly spawned PGID.  The
    // independent sentinel must survive, then is removed by this test using
    // its exact recorded PGID.
    expect(processAlive(sentinelGroup)).toBe(true);
    await stopOwnedGroup(sentinelGroup);

    expect(manifest.status).toBe("died");
    expect(existsSync(manifest.socket)).toBe(false);
    expect(existsSync(path.dirname(manifest.socket))).toBe(false);
    expect(readdirSync(sessionDir).some((entry) => entry.startsWith(".bootstrap-"))).toBe(false);
    // The 0700 directory, manifest, and protected token remain as audit-only
    // history; rollback never deletes broad roots or discovers other PIDs.
    expect(existsSync(path.join(sessionDir, "token"))).toBe(true);
  });

  it("continues credential cleanup and audit preservation after rollback operations fail", async () => {
    const home = temp("prospero-launch-rollback-errors-");
    const bootstrap = path.join(home, ".bootstrap-account.json");
    writeFileSync(bootstrap, JSON.stringify({ environment: { ACCOUNT_TOKEN: "secret" } }), { mode: 0o600 });
    const manifest: StructuredSupervisorManifest = {
      version: 1,
      protocolVersion: 1,
      implementation: "supervisor",
      sessionId: "rollback-error-fixture",
      agent: "codex",
      title: "rollback error fixture",
      cwd: home,
      createdAt: 1,
      approvalPolicy: "standard",
      socket: path.join(home, "s.sock"),
      tokenFile: "token",
      lifecycleEpoch: "fixture",
    };
    let socketCleanupCalled = false;
    let manifestWriteCalled = false;

    const rollback = await rollbackFailedStructuredSupervisorLaunch({
      groupId: 41_424,
      spawnAttempted: true,
      bootstrap,
      socketPath: manifest.socket,
      socketDir: home,
      manifestFile: path.join(home, "manifest.json"),
      manifest,
    }, {
      // Simulates a failure in the TERM/KILL/wait escalation path.  The
      // independent bootstrap and manifest operations must still run.
      terminateGroup: async () => { throw new Error("TERM/KILL/wait failed"); },
      removeSocket: () => { socketCleanupCalled = true; },
      readManifest: () => manifest,
      writeManifest: () => {
        manifestWriteCalled = true;
        throw new Error("manifest update failed");
      },
    });

    expect(rollback.groupExited).toBe(false);
    expect(existsSync(bootstrap)).toBe(false);
    expect(socketCleanupCalled).toBe(false);
    expect(manifestWriteCalled).toBe(true);
    expect(rollback.errors.map((error) => error.message)).toEqual(expect.arrayContaining([
      expect.stringContaining("terminate new supervisor process group"),
      expect.stringContaining("retained launch socket/runtime directory"),
      expect.stringContaining("preserve failed launch manifest"),
    ]));
  });
});
