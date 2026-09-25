import { describe, expect, it } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { orchestrationAction, readOrchestrationWindow } from "../src/main/rust-orchestration";
import type { StateStore } from "../src/main/state-store";

describe("Rust desktop control routes", () => {
  it("reads orchestration projection through run-scoped bounded pages", async () => {
    const calls: unknown[] = [];
    const runs = Array.from({ length: 105 }, (_, index) => ({
      id: `run-${String(index).padStart(3, "0")}`,
      objective: `Run ${index}`,
      status: index < 102 ? "active" : "completed",
      graphRevision: 1,
      createdAt: index,
      updatedAt: index,
    }));
    const client = {
      listRuns: async () => runs,
      listTasks: async (runId?: string) => {
        calls.push({ listTasks: runId });
        if (!runId) throw new Error("unbounded tasks request");
        return [{ id: `task-${runId}`, runId, title: "Task", spec: "Spec", status: "pending", deps: [], skills: [], createdAt: 1, updatedAt: 1 }];
      },
      listDispatches: async (runId?: string) => {
        calls.push({ listDispatches: runId });
        if (!runId) throw new Error("unbounded dispatches request");
        return [];
      },
      listGates: async (runId?: string) => {
        calls.push({ listGates: runId });
        if (!runId) throw new Error("unbounded gates request");
        return [];
      },
      listWorktreeAssets: async (runId?: string) => {
        calls.push({ listWorktreeAssets: runId });
        if (!runId) throw new Error("unbounded worktrees request");
        return [];
      },
    };
    const projection = await readOrchestrationWindow(client as never, AbortSignal.timeout(1000), 9);
    expect((projection["runs"] as unknown[])).toHaveLength(100);
    expect((projection["tasks"] as unknown[])).toHaveLength(100);
    expect(calls).not.toContainEqual({ listTasks: undefined });
    expect(calls.filter(call => "listTasks" in (call as object))).toHaveLength(100);
  });

  it("passes non-Claude worker agents through to the Rust daemon", async () => {
    const calls: unknown[] = [];
    const client = {
      startWorker: async (input: unknown) => {
        calls.push(input);
        return { ok: true };
      },
    };
    await expect(orchestrationAction(client as never, "worker.start", {
      taskId: "task-1",
      agent: "deepseek",
      cwd: "/repo",
      worktree: "none",
      kind: "structured",
      skills: ["audit"],
      operationId: "op-1",
    }, AbortSignal.timeout(1000))).resolves.toMatchObject({ ok: true });
    expect(calls[0]).toMatchObject({
      taskId: "task-1",
      agent: "deepseek",
      kind: "structured",
      skills: ["audit"],
    });
  });

  it("maps plugin and schedule control paths to Rust HTTP client methods", async () => {
    const calls: unknown[] = [];
    const client = {
      plugins: async () => ({ items: [], errors: [] }),
      pluginServices: async () => ({ items: [{ pluginId: "prospero-demo", serviceId: "bridge", status: "stopped" }], errors: [] }),
      pluginServiceAction: async (plugin: string, service: string, action: string) => {
        calls.push({ plugin, service, action });
        return { pluginId: plugin, serviceId: service, status: action === "stop" ? "stopped" : "running" };
      },
      schedules: async () => [{ id: "daily-check", status: "ENABLED" }],
      createSchedule: async (input: unknown) => {
        calls.push({ createSchedule: input });
        return { id: "daily-check", status: "PAUSED" };
      },
      updateSchedule: async (id: string, input: unknown) => {
        calls.push({ updateSchedule: id, input });
        return { id, status: "ENABLED" };
      },
      pauseSchedule: async (id: string) => ({ id, status: "PAUSED" }),
      resumeSchedule: async (id: string) => ({ id, status: "ENABLED" }),
      deleteSchedule: async (id: string) => ({ id, deleted: true }),
      runSchedule: async (id: string) => ({ task: { id }, session: { id: "session-1" }, queued: false }),
    };
    const store = { backend: "api", setManagedState: () => undefined, setApiState: () => undefined } as unknown as StateStore;
    const runtime = new RustRuntime(store, "/opt/prosperod-rs", "/tmp/prospero-rust/daemon");
    (runtime as unknown as { connection: unknown }).connection = { client, pid: 10, baseUrl: "http://127.0.0.1:7423" };
    (runtime as unknown as { refresh: () => Promise<void> }).refresh = async () => undefined;

    await expect(runtime.request("/_prospero/control/plugins")).resolves.toMatchObject({ items: [], errors: [] });
    await expect(runtime.request("/_prospero/control/plugin/prospero-demo/service/bridge/start", { method: "POST" })).resolves.toMatchObject({ status: "running" });
    await expect(runtime.request("/_prospero/control/schedules")).resolves.toMatchObject({ items: [{ id: "daily-check" }] });
    await expect(runtime.request("/_prospero/control/schedules", { method: "POST", body: { id: "daily-check", name: "Daily", prompt: "Check", rrule: "FREQ=DAILY", cwd: process.cwd(), status: "PAUSED" } })).resolves.toMatchObject({ status: "PAUSED" });
    await expect(runtime.request("/_prospero/control/schedule/daily-check/update", { method: "POST", body: { clearModel: true } })).resolves.toMatchObject({ status: "ENABLED" });
    expect(calls).toEqual([
      { plugin: "prospero-demo", service: "bridge", action: "start" },
      { createSchedule: expect.objectContaining({ id: "daily-check", cwd: process.cwd(), status: "PAUSED" }) },
      { updateSchedule: "daily-check", input: expect.objectContaining({ id: "daily-check", model: null }) },
    ]);
  });


  it("maps Rust paired devices into the desktop API snapshot", async () => {
    const client = {
      events: async () => ({ latestSeq: 0, events: [], resyncRequired: false }),
      summary: async () => ({ total: 0, active: 0, archived: 0, attention: 0, latestSeq: 0 }),
      sidebarSessions: async () => ({ items: [], total: 0, latestSeq: 0 }),
      workspaces: async () => ({ items: [], latestSeq: 0 }),
      health: async () => ({ capabilities: [], persistence: { pty: true, structured: true }, daemonVersion: "test" }),
      devices: async () => ({ items: [{ id: "device-1", name: "Android", allowShell: true, allowOrchestration: true, bound: true, relayReady: true, createdAt: 1, lastSeenAt: 2 }] }),
      schedules: async () => [],
      agentQueues: async () => ({ queues: [] }),
      agentControls: async () => ({ controls: [] }),
    };
    const calls: unknown[] = [];
    const store = {
      backend: "api",
      setManagedState: () => undefined,
      appendLog: () => undefined,
      setApiState: (state: unknown) => calls.push(state),
    } as unknown as StateStore;
    const runtime = new RustRuntime(store, "/opt/prosperod-rs", "/tmp/prospero-rust/daemon");
    (runtime as unknown as { connection: unknown }).connection = { client, pid: 10, baseUrl: "http://127.0.0.1:7423" };

    await (runtime as unknown as { refresh: () => Promise<void> }).refresh();

    expect(calls[0]).toMatchObject({ devices: { items: [{ id: "device-1", relayReady: true }] } });
  });

  it("passes Codex PTY API Profile account selection to Rust", async () => {
    const calls: unknown[] = [];
    const client = {
      createTerminal: async (input: unknown) => {
        calls.push(input);
        return { id: "session-1", agent: "codex", kind: "pty", title: "Codex", workspace: process.cwd(), status: "running", createdAt: 1 };
      },
    };
    const store = { backend: "api", setManagedState: () => undefined, setApiState: () => undefined } as unknown as StateStore;
    const runtime = new RustRuntime(store, "/opt/prosperod-rs", "/tmp/prospero-rust/daemon");
    (runtime as unknown as { connection: unknown }).connection = { client, pid: 10, baseUrl: "http://127.0.0.1:7423" };
    (runtime as unknown as { refresh: () => Promise<void> }).refresh = async () => undefined;

    await expect(runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "pty", agent: "codex", cwd: process.cwd(), accountId: "work-codex", cols: 120, rows: 40 },
    })).resolves.toMatchObject({ id: "session-1" });
    expect(calls[0]).toMatchObject({ agent: "codex", accountId: "work-codex" });
  });
});
