import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore, type ApiState } from "../src/main/state-store";

const homes: string[] = [];
function home(): string { const path = mkdtempSync(resolve(tmpdir(), "prospero-api-state-")); homes.push(path); return path; }
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });
const data = (): ApiState => ({ running: true, config: {}, status: { pid: process.pid, port: 12345, bind: "127.0.0.1", metadataRevision: "test:1", sessions: [{ id: "fixture", kind: "structured", title: "API title", cwd: "/synthetic" }], sessionSummary: { total: 100000, active: 1, terminal: 99999 } }, devices: {}, orchestration: {}, projects: ["/synthetic"] });

describe("API-only desktop state", () => {
  it("ignores legacy daemon files while preserving local shell preferences", () => {
    const directory = home();
    for (const file of ["config.json", "status.json", "devices.json", "orchestration-desktop.json"]) writeFileSync(resolve(directory, file), JSON.stringify({ pid: process.pid, port: 7423, controlToken: "private", version: 1, sessions: [{ id: "legacy" }], tasks: [{ id: "legacy" }] }));
    writeFileSync(resolve(directory, "desktop.json"), JSON.stringify({ settings: { theme: "dark", terminalFontFamily: "Example Mono" }, sessionTitles: { fixture: "Stale local alias" } }));
    const store = new StateStore(directory, "api");
    const reader = vi.spyOn(store as unknown as { readExternalJson(path: string): unknown }, "readExternalJson");
    expect(store.snapshot().daemon.running).toBe(false);
    store.setManagedState(process.pid, false);
    store.setApiState(data());
    const snapshot = store.snapshot();
    expect(snapshot.daemon.sessions).toHaveLength(1);
    expect(snapshot.daemon.sessions[0]?.title).toBe("API title");
    expect(snapshot.daemon.sessionSummary).toMatchObject({ total: 100000, omitted: 99999 });
    expect(snapshot.orchestration.tasks).toEqual([]);
    expect(snapshot.projects).toEqual(["/synthetic"]);
    expect(snapshot.settings).toMatchObject({ theme: "dark", terminalFontFamily: "Example Mono" });
    for (let i = 0; i < 100; i++) expect(store.snapshot()).toBe(snapshot);
    expect(() => store.controlCredentials()).toThrow("owned by the runtime");
    expect(() => store.renameSession("fixture", "Local alias")).toThrow("daemon API");
    expect(reader).not.toHaveBeenCalled();
  });

  it("does not broadcast unchanged API windows or grow them during history hydration", () => {
    const store = new StateStore(home(), "api");
    store.setApiState(data());
    const changed = vi.fn(); store.on("changed", changed);
    const snapshot = store.snapshot();
    store.setApiState(data());
    expect(store.snapshot()).toBe(snapshot);
    expect(changed).not.toHaveBeenCalled();
    store.hydrateSessions(Array.from({ length: 10000 }, (_, index) => ({ id: `archive-${index}`, agent: "codex", kind: "structured", title: "History", cwd: "/synthetic", status: "completed" })));
    expect(store.snapshot().daemon.sessions).toHaveLength(1);
    store.setApiState({
      ...data(),
      status: {
        ...data().status,
        sessions: Array.from({ length: 600 }, (_, index) => ({
          id: `session-${index}`,
          kind: "structured",
          title: `Session ${index}`,
          cwd: "/synthetic",
        })),
      },
    });
    expect(store.snapshot().daemon.sessions).toHaveLength(600);
    expect(() => store.setApiState({ ...data(), status: { sessions: Array(601).fill({}) } })).toThrow("page limit");
    expect(() => store.setApiState({ ...data(), projects: Array(101).fill("/synthetic") })).toThrow("page limit");
    expect(() => new StateStore(home()).setApiState(data())).toThrow("not enabled");
  });

  it("accepts multi-megabyte API windows above 2 MiB and compacts heavy preview payloads before hitting 16 MiB", () => {
    const store = new StateStore(home(), "api");
    const fourMiBTasks = Array.from({ length: 40 }, (_, index) => ({
      id: `task-${index}`,
      runId: "run-1",
      title: `Task ${index}`,
      status: "running",
      spec: "s".repeat(110_000),
    }));
    expect(() =>
      store.setApiState({
        ...data(),
        orchestration: { runs: [{ id: "run-1", status: "active" }], tasks: fourMiBTasks },
      }),
    ).not.toThrow();
    expect(store.snapshot().orchestration.tasks).toHaveLength(40);

    // Build an oversized >16 MiB payload full of heavy preview/spec strings and verify graceful compaction
    const hugeSessions = Array.from({ length: 200 }, (_, index) => ({
      id: `heavy-session-${index}`,
      kind: "structured",
      title: `Heavy ${index}`,
      cwd: "/synthetic",
      preview: "p".repeat(30_000),
      lastMessagePreview: "m".repeat(30_000),
    }));
    const hugeTasks = Array.from({ length: 120 }, (_, index) => ({
      id: `heavy-task-${index}`,
      runId: "run-1",
      title: `Heavy Task ${index}`,
      status: "done",
      spec: "x".repeat(60_000),
      result: "r".repeat(60_000),
    }));
    const rawPayload: ApiState = {
      ...data(),
      status: { ...data().status, sessions: hugeSessions },
      orchestration: { runs: [{ id: "run-1", status: "completed", objective: "o".repeat(50_000) }], tasks: hugeTasks },
    };
    expect(Buffer.byteLength(JSON.stringify(rawPayload))).toBeGreaterThan(16 * 1024 * 1024);
    expect(() => store.setApiState(rawPayload)).not.toThrow();
    expect(store.snapshot().daemon.sessions).toHaveLength(200);
    expect(store.snapshot().orchestration.tasks).toHaveLength(120);
  });
});
