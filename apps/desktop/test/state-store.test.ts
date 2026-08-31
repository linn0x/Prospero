import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSnapshot, JsonObject } from "../src/shared/types";
import { StateStore } from "../src/main/state-store";

const homes: string[] = [];

function testHome(): string {
  const home = mkdtempSync(resolve(tmpdir(), "prospero-desktop-state-"));
  homes.push(home);
  return home;
}

function writeJson(home: string, name: string, value: JsonObject): void {
  writeFileSync(resolve(home, name), JSON.stringify(value), "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Electron state snapshot caching", () => {
  it("reuses the snapshot while external inputs are unchanged", () => {
    const home = testHome();
    writeJson(home, "config.json", { port: 7423 });
    writeJson(home, "orchestration.json", { runs: [{ id: "run-1" }] });
    const store = new StateStore(home);

    const first = store.snapshot();

    expect(store.snapshot()).toBe(first);
    expect(store.snapshot()).toBe(first);
  });

  it("publishes changed external JSON once and then becomes stable again", () => {
    const home = testHome();
    writeJson(home, "orchestration.json", { runs: [{ id: "run-1" }] });
    const store = new StateStore(home);
    const first = store.snapshot();

    writeJson(home, "orchestration.json", { runs: [{ id: "run-1" }, { id: "run-2" }] });
    const changed = store.snapshot();

    expect(changed).not.toBe(first);
    expect(changed?.orchestration.runs.map((run) => run["id"])).toEqual(["run-1", "run-2"]);
    expect(store.snapshot()).toBe(changed);
  });

  it("keeps unchanged top-level slices stable across external updates", () => {
    const home = testHome();
    writeJson(home, "status.json", { port: 7423, sessions: [] });
    writeJson(home, "orchestration.json", { runs: [{ id: "run-1" }] });
    const store = new StateStore(home);
    const first = store.snapshot();

    writeJson(home, "status.json", { port: 7524, sessions: [] });
    const changed = store.snapshot();

    expect(changed).not.toBe(first);
    expect(changed.daemon).not.toBe(first.daemon);
    expect(changed.orchestration).toBe(first.orchestration);
    expect(changed.devices).toBe(first.devices);
    expect(changed.settings).toBe(first.settings);
  });

  it("ignores external rewrites that do not change the projected snapshot", () => {
    const home = testHome();
    writeJson(home, "status.json", { port: 7423, controlToken: "first", sessions: [] });
    const store = new StateStore(home);
    const first = store.snapshot();

    writeJson(home, "status.json", { port: 7423, controlToken: "second", sessions: [] });

    expect(store.snapshot()).toBe(first);
  });

  it("does not publish when a file is rewritten with identical content", () => {
    const home = testHome();
    const orchestration = JSON.stringify({ runs: [{ id: "run-1" }] });
    writeFileSync(resolve(home, "orchestration.json"), orchestration, "utf8");
    const store = new StateStore(home);
    const first = store.snapshot();

    writeFileSync(resolve(home, "orchestration.json"), orchestration, "utf8");

    expect(store.snapshot()).toBe(first);
    expect(store.snapshot()).toBe(first);
  });

  it("emits internal changes immediately and keeps the resulting snapshot stable", () => {
    const store = new StateStore(testHome());
    store.snapshot();
    let emitted: DesktopSnapshot | undefined;
    store.once("changed", (snapshot: DesktopSnapshot) => { emitted = snapshot; });

    const updated = store.updateSettings({ theme: "dark" });

    expect(emitted).toBe(updated);
    expect(updated.settings.theme).toBe("dark");
    expect(store.snapshot()).toBe(updated);
  });

  it("detects daemon liveness changes even when status.json is unchanged", () => {
    const home = testHome();
    writeJson(home, "status.json", { pid: 424_242, sessions: [] });
    let alive = true;
    vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
      if (pid === 424_242 && alive) return true;
      throw new Error("not running");
    }) as typeof process.kill);
    const store = new StateStore(home);

    expect(store.snapshot().daemon.running).toBe(true);
    alive = false;
    const changed = store.snapshot();

    expect(changed?.daemon.running).toBe(false);
    expect(store.snapshot()).toBe(changed);
  });

  it("projects only the daemon's bounded live session slice while retaining global counts", () => {
    const home = testHome();
    writeJson(home, "status.json", {
      sessions: [
        { id: "attention", cwd: home, agent: "codex", kind: "structured", status: "waiting_input", pendingQuestions: 1 },
        { id: "recent", cwd: home, agent: "codex", kind: "structured", status: "completed" },
      ],
      sessionSummary: {
        total: 3_742,
        active: 7,
        attention: 1,
        terminal: 3_729,
        included: 2,
        omitted: 3_740,
        activeLimit: 200,
        attentionLimit: 100,
        recentTerminalLimit: 50,
        truncated: true,
      },
    });
    const store = new StateStore(home);

    const current = store.snapshot();

    expect(current.daemon.sessions.map((session) => session.id)).toEqual(["attention", "recent"]);
    expect(current.daemon.sessionSummary).toEqual({
      total: 3_742,
      active: 7,
      attention: 1,
      terminal: 3_729,
      included: 2,
      omitted: 3_740,
      activeLimit: 200,
      attentionLimit: 100,
      recentTerminalLimit: 50,
      truncated: true,
    });
  });

  it("accepts recent paged-history IDs for local actions without widening the live snapshot", () => {
    const home = testHome();
    writeJson(home, "status.json", {
      sessions: [{ id: "live", cwd: home, agent: "codex", kind: "structured", status: "running" }],
      sessionSummary: { total: 3_742, active: 1, attention: 0, terminal: 3_741, included: 1, omitted: 3_741, activeLimit: 200, attentionLimit: 100, recentTerminalLimit: 50, truncated: true },
    });
    const store = new StateStore(home);
    store.snapshot();

    store.hydrateSessions([{ id: "historical" }]);
    store.setSessionPinned("historical", true);

    expect(store.snapshot().pinnedSessionIds).toEqual(["historical"]);
    expect(store.snapshot().daemon.sessions.map((session) => session.id)).toEqual(["live"]);
    expect(store.isKnownSession("historical")).toBe(true);
    expect(store.isKnownSession("missing")).toBe(false);
  });

  it("discovers a session project when its directory appears after the status update", () => {
    const home = testHome();
    const project = resolve(home, "late-project");
    writeJson(home, "status.json", {
      sessions: [{ id: "session-1", cwd: project, agent: "codex", kind: "structured" }],
    });
    const store = new StateStore(home);

    expect(store.snapshot().projects).not.toContain(project);
    mkdirSync(project);
    const changed = store.snapshot();

    expect(changed?.projects).toContain(project);
    expect(store.snapshot()).toBe(changed);
  });
});
