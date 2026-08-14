import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  launchStructuredSupervisor,
  RemoteStructuredSession,
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
  it("reaps only its new detached group after a short attach timeout and preserves an audit manifest", async () => {
    const home = temp("prospero-launch-rollback-home-");
    const fakeBin = temp("prospero-launch-rollback-bin-");
    installHangingCodex(fakeBin);
    const attachSocket = path.join(home, "attach.sock");
    await startHangingSocket(attachSocket);
    const providerPidFile = path.join(home, "provider.pid");
    const sessionId = "launch-rollback-fixture";
    const root = path.join(home, "structured-supervisor");

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

    expect(manifest.status).toBe("died");
    expect(existsSync(manifest.socket)).toBe(false);
    expect(existsSync(path.dirname(manifest.socket))).toBe(false);
    expect(readdirSync(sessionDir).some((entry) => entry.startsWith(".bootstrap-"))).toBe(false);
    // The 0700 directory, manifest, and protected token remain as audit-only
    // history; rollback never deletes broad roots or discovers other PIDs.
    expect(existsSync(path.join(sessionDir, "token"))).toBe(true);
  });
});
