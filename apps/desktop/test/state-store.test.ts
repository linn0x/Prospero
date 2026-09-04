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
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Electron state snapshot caching", () => {
  it("preserves workflow templates up to the orchestration graph limits", () => {
    const store = new StateStore(testHome());
    const title = "t".repeat(2_000);
    const spec = "s".repeat(20_000);
    const nodes = Array.from({ length: 200 }, () => ({
      title,
      spec,
      dependencyIndexes: [],
      skills: [],
    }));

    const saved = store.saveWorkflowTemplate({
      id: "template-200",
      name: "Large template",
      description: "",
      nodes,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(saved.workflowTemplates[0]?.nodes).toHaveLength(200);
    expect(saved.workflowTemplates[0]?.nodes[0]).toMatchObject({ title, spec });
    expect(() => store.saveWorkflowTemplate({
      id: "template-201",
      name: "Too large",
      description: "",
      nodes: [...nodes, nodes[0]!],
      createdAt: 1,
      updatedAt: 1,
    })).toThrow("模板任务数量无效");
  });

  it("projects a stable opaque id for each paired device", () => {
    const home = testHome();
    writeJson(home, "devices.json", {
      devices: [{
        name: "My phone",
        token: "device-secret",
        allowShell: true,
        createdAt: 1,
      }],
    });

    const snapshot = new StateStore(home).snapshot();

    expect(snapshot.devices[0]?.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(snapshot.devices)).not.toContain("device-secret");
  });

  it("never projects the relay host secret into the renderer snapshot", () => {
    const home = testHome();
    writeJson(home, "config.json", {
      relay: { enabled: true, url: "wss://relay.example", hostSecret: "relay-host-secret" },
    });

    const relay = new StateStore(home).snapshot().daemon.relay;

    expect(relay).toMatchObject({ enabled: true, state: "offline", url: "wss://relay.example" });
    expect(JSON.stringify(relay)).not.toContain("relay-host-secret");
  });

  it("reads settings without constructing the full desktop snapshot", () => {
    const home = testHome();
    writeJson(home, "desktop.json", {
      settings: { theme: "dark" },
    });
    const store = new StateStore(home);
    const settings = store.settingsSnapshot();

    expect(settings.theme).toBe("dark");
    settings.theme = "light";
    expect(store.settingsSnapshot().theme).toBe("dark");
  });

  it("reuses the snapshot while external inputs are unchanged", () => {
    const home = testHome();
    writeJson(home, "config.json", { port: 7423 });
    writeJson(home, "orchestration-desktop.json", { version: 1, runs: [{ id: "run-1" }] });
    const store = new StateStore(home);

    const first = store.snapshot();

    expect(store.snapshot()).toBe(first);
    expect(store.snapshot()).toBe(first);
  });

  it("publishes changed external JSON once and then becomes stable again", () => {
    const home = testHome();
    writeJson(home, "orchestration-desktop.json", { version: 1, runs: [{ id: "run-1" }] });
    const store = new StateStore(home);
    const first = store.snapshot();

    writeJson(home, "orchestration-desktop.json", { version: 1, runs: [{ id: "run-1" }, { id: "run-2" }] });
    const changed = store.snapshot();

    expect(changed).not.toBe(first);
    expect(changed?.orchestration.runs.map((run) => run["id"])).toEqual(["run-1", "run-2"]);
    expect(store.snapshot()).toBe(changed);
  });

  it("reads the compact desktop orchestration projection", () => {
    const home = testHome();
    writeJson(home, "orchestration.json", {
      runs: { "run-1": { id: "run-1", objective: "full" } },
      tasks: { "task-1": { id: "task-1", runId: "run-1", spec: "full task specification" } },
    });
    writeJson(home, "orchestration-desktop.json", {
      version: 1,
      runs: [{ id: "run-1", objective: "compact" }],
      tasks: [{ id: "task-1", runId: "run-1", spec: "preview", specTruncated: true }],
      dispatches: [],
      gates: [],
      worktreeAssets: [],
    });
    const store = new StateStore(home);

    expect(store.snapshot().orchestration.runs[0]?.["objective"]).toBe("compact");
    expect(store.snapshot().orchestration.tasks[0]?.["spec"]).toBe("preview");
  });

  it("uses an available projection without synchronously reading the full source", () => {
    const home = testHome();
    writeJson(home, "orchestration-desktop.json", {
      version: 1,
      runs: [{ id: "run-1", objective: "stale" }],
    });
    writeJson(home, "orchestration.json", {
      runs: [{ id: "run-1", objective: "current" }],
    });
    expect(new StateStore(home).snapshot().orchestration.runs[0]?.["objective"]).toBe("stale");
  });

  it("does not read the full orchestration source when no projection exists", () => {
    const home = testHome();
    writeJson(home, "orchestration.json", {
      runs: [{ id: "run-1", objective: "full" }],
    });

    expect(new StateStore(home).snapshot().orchestration.runs).toEqual([]);
  });

  it("keeps unchanged top-level slices stable across external updates", () => {
    const home = testHome();
    writeJson(home, "status.json", { port: 7423, sessions: [] });
    writeJson(home, "orchestration-desktop.json", { version: 1, runs: [{ id: "run-1" }] });
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

  it("batches log updates and bounds a single unbroken line", () => {
    vi.useFakeTimers();
    const store = new StateStore(testHome());
    store.snapshot();
    let changes = 0;
    store.on("changed", () => { changes += 1; });

    store.appendLog("first");
    store.appendLog("second");
    expect(changes).toBe(0);
    vi.advanceTimersByTime(120);
    expect(changes).toBe(1);
    expect(store.snapshot().logs).toBe("firstsecond");

    store.appendLog("x".repeat(600_000));
    vi.advanceTimersByTime(120);
    expect(store.snapshot().logs).toHaveLength(500_000);
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
        {
          id: "attention",
          cwd: home,
          agent: "codex",
          kind: "structured",
          status: "waiting_input",
          pendingQuestions: 1,
          busySince: 10,
          messageQueue: [{ id: "queue-1", text: "next", kind: "queue", createdAt: 11, attachmentCount: 0 }],
        },
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
    expect(current.daemon.sessions[0]).toMatchObject({
      busySince: 10,
      messageQueue: [{ id: "queue-1", text: "next", kind: "queue" }],
    });
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

  it("keeps display titles for paged historical sessions", () => {
    const home = testHome();
    const store = new StateStore(home);
    store.hydrateSessions([{ id: "historical" }]);

    store.renameSession("historical", "Renamed history");

    expect(store.sessionTitle("historical")).toBe("Renamed history");
    expect(new StateStore(home).sessionTitle("historical")).toBe("Renamed history");
  });

  it("archives a session locally without touching the daemon session list", () => {
    // 归档只是桌面端的一个标记:会话仍在 daemon 里活着,只是从侧栏主列表收起。
    // 它必须能持久化,否则重启一次归档就白做了。
    const home = testHome();
    writeJson(home, "status.json", {
      sessions: [{ id: "live", cwd: home, agent: "codex", kind: "structured", status: "running" }],
    });
    const store = new StateStore(home);
    store.snapshot();

    store.setSessionArchived("live", true);
    expect(store.snapshot().archivedSessionIds).toEqual(["live"]);
    expect(store.snapshot().daemon.sessions.map((session) => session.id)).toEqual(["live"]);

    expect(new StateStore(home).snapshot().archivedSessionIds).toEqual(["live"]);

    store.setSessionArchived("live", false);
    expect(store.snapshot().archivedSessionIds).toEqual([]);
    expect(() => store.setSessionArchived("missing", true)).toThrow();
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
