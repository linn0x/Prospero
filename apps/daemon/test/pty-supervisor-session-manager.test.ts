import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/session-manager.js";

const homes: string[] = [];
const live: Array<{ manager: SessionManager; sid: string }> = [];

function home(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), "prospero-pty-host-"));
  homes.push(value);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(async () => {
  for (const { manager, sid } of live.splice(0)) {
    await manager.kill(sid).catch(() => {});
    await manager.disposeAll().catch(() => {});
  }
  for (const value of homes.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("detached PTY session host", () => {
  it.skipIf(process.platform === "win32")("keeps the PTY, xterm snapshot and output cursor alive across daemon facade disposal", async () => {
    const value = home();
    const first = new SessionManager({ home: value, ptySupervisor: true });
    const created = await first.create({
      agent: "custom",
      command: "printf 'READY\\n'; while IFS= read -r line; do printf 'ECHO:%s\\n' \"$line\"; done",
      cwd: value,
      cols: 80,
      rows: 24,
      allowShell: true,
    });
    live.push({ manager: first, sid: created.id });
    const manifestFile = path.join(value, "pty-supervisor", created.id, "manifest.json");
    await eventually(() => existsSync(manifestFile), "host manifest");
    const before = first.requirePty(created.id);
    await eventually(async () => (await before.snapshot()).ansi.includes("READY"), "initial PTY output");
    const originalPid = Number((JSON.parse(readFileSync(manifestFile, "utf8")) as { supervisorPid?: number }).supervisorPid);
    expect(Number.isSafeInteger(originalPid)).toBe(true);

    // Normal daemon shutdown is only a facade disconnect, never a kill RPC.
    await first.disposeAll();
    live.splice(live.findIndex((item) => item.manager === first), 1);
    try { process.kill(originalPid, 0); } catch { throw new Error("detached PTY owner died with daemon facade"); }

    const second = new SessionManager({ home: value, ptySupervisor: true });
    live.push({ manager: second, sid: created.id });
    const restored = await second.restorePtySupervisors();
    expect(restored).toEqual([expect.objectContaining({ id: created.id, kind: "pty" })]);
    const terminal = second.requirePty(created.id);
    await terminal.writeInput("again\n");
    await eventually(async () => (await terminal.snapshot()).ansi.includes("ECHO:again"), "reconnected input/output");
    const replay = await terminal.subscribe(0);
    expect(replay.gap).toBe(false);
    expect(replay.events.map((event) => event.seq)).toEqual(
      [...replay.events].map((event) => event.seq).sort((a, b) => a - b),
    );
    expect(replay.lastSeq).toBeGreaterThanOrEqual(replay.events.at(-1)?.seq ?? 0);

    await second.kill(created.id);
    live.splice(live.findIndex((item) => item.manager === second), 1);
    await eventually(() => {
      try { process.kill(originalPid, 0); return false; }
      catch { return true; }
    }, "explicit kill owner exit");
    expect(existsSync(path.dirname(manifestFile))).toBe(false);
    await second.disposeAll();

    const third = new SessionManager({ home: value, ptySupervisor: true });
    expect(await third.restorePtySupervisors()).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(value, "deleted-sessions.json"), "utf8")))
      .toEqual({ version: 1, ids: [] });
    await third.disposeAll();
  });

  it.skipIf(process.platform === "win32")("exposes a stale owner as failed history and never launches a duplicate", async () => {
    const value = home();
    const root = path.join(value, "pty-supervisor", "stale-owner");
    const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    writeFileSync(path.join(root, "token"), "not-used\n", { mode: 0o600 });
    chmodSync(path.join(root, "token"), 0o600);
    writeFileSync(path.join(root, "manifest.json"), JSON.stringify({
      version: 1, protocolVersion: 1, implementation: "pty-supervisor", sessionId: "stale-owner",
      agent: "custom", title: "stale", cwd: value, createdAt: 1, cols: 80, rows: 24,
      socket: path.join(root, "missing.sock"), tokenFile: "token", sessionDir: root,
      supervisorPid: 999_999_999, lifecycleEpoch: "stale", ownerState: "active", status: "running",
    }), { mode: 0o600 });
    chmodSync(path.join(root, "manifest.json"), 0o600);

    const manager = new SessionManager({ home: value, ptySupervisor: true });
    const restored = await manager.restorePtySupervisors();
    expect(restored).toEqual([expect.objectContaining({ id: "stale-owner", status: "died" })]);
    await expect(manager.requirePty("stale-owner").snapshot()).rejects.toThrow(/unavailable|disconnected/i);
    await manager.disposeAll();
  });
});
