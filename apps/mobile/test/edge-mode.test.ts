import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@prospero/protocol";

import { createEdgePreferencesStore, normalizeEdgePreferences, selectedEdgeHosts } from "../src/lib/edge-preferences";
import { buildEdgeDashboard, createEdgeRecentReader, edgeItemKey } from "../src/lib/edge-dashboard";
import { emptyRuntime, type HostRuntime } from "../src/lib/store";
import type { StoredHost } from "../src/lib/hosts";
import type { RecentSession } from "../src/lib/recent-sessions";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: vi.fn(), setItem: vi.fn() } }));

const host = (id: string): StoredHost => ({ id, name: id, addrs: [], port: 7423, token: "test", daemonPub: "test", pairedAt: 1, connectionMode: "direct" });
const hosts = [host("mac"), host("pc")];
const session = (id: string, createdAt: number, cwd = "/work/repo"): SessionInfo => ({ id, title: id, agent: "codex", kind: "structured", status: "idle", createdAt, cwd, cols: 80, rows: 24 });
const runtime = (...sessions: SessionInfo[]): HostRuntime => ({ ...emptyRuntime, status: "connected", sessionsLoaded: true, sessions: Object.fromEntries(sessions.map((value) => [value.id, value])) });
const recent = (hostId: string, sessionId: string, openedAt: number): RecentSession => ({ hostId, sessionId, openedAt, activityAt: 0, summaryAt: 0, summary: "" });

describe("Edge device preferences", () => {
  it("starts with every paired device and respects explicit empty selections", () => {
    expect(selectedEdgeHosts(hosts, normalizeEdgePreferences(null).selectedHostIds)).toEqual(hosts);
    expect(selectedEdgeHosts(hosts, [])).toEqual([]);
    expect(selectedEdgeHosts(hosts, ["pc", "gone", "pc"])).toEqual([hosts[1]]);
    expect(selectedEdgeHosts(hosts, ["gone"])).toEqual([]);
  });

  it("includes new pairings by default but preserves an explicitly saved selection", () => {
    const expanded = [...hosts, host("linux")];
    expect(selectedEdgeHosts(expanded, null)).toHaveLength(3);
    expect(selectedEdgeHosts(expanded, ["mac", "pc"])).toEqual(hosts);
  });

  it("restores the last mode and device list after a cold start", async () => {
    let raw: string | null = null;
    const storage = { getItem: async () => raw, setItem: vi.fn(async (_key: string, value: string) => { raw = value; }) };
    const first = createEdgePreferencesStore(storage);
    await first.getState().hydrate();
    first.getState().setMode("edge");
    first.getState().selectHosts(["pc"]);
    first.getState().setMode("normal");
    first.getState().setMode("edge");
    await vi.waitFor(() => expect(JSON.parse(raw!)).toEqual({ mode: "edge", selectedHostIds: ["pc"] }));
    const second = createEdgePreferencesStore(storage);
    await second.getState().hydrate();
    expect(second.getState()).toMatchObject({ mode: "edge", selectedHostIds: ["pc"], hydrated: true });
  });

  it("serializes rapid writes even when an earlier write is slow or fails", async () => {
    let release!: () => void;
    const storage = { getItem: async () => null, setItem: vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockRejectedValueOnce(new Error("disk unavailable"))
      .mockResolvedValue(undefined) };
    const store = createEdgePreferencesStore(storage);
    await store.getState().hydrate();
    store.getState().selectHosts(["pc"]);
    store.getState().selectHosts([]);
    store.getState().selectHosts(["mac"]);
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
    release();
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(3));
    expect(JSON.parse(storage.setItem.mock.calls[2]![1])).toEqual({ mode: "normal", selectedHostIds: ["mac"] });
  });

  it("does not replace a new selection with delayed persisted data", async () => {
    let resolveRead!: (raw: string) => void;
    const store = createEdgePreferencesStore({ getItem: () => new Promise((resolve) => { resolveRead = resolve; }), setItem: async () => {} });
    const pending = store.getState().hydrate();
    store.getState().selectHosts([]);
    resolveRead(JSON.stringify({ mode: "edge", selectedHostIds: ["mac"] }));
    await pending;
    expect(store.getState().selectedHostIds).toEqual([]);
  });

  it("recovers from corrupt or unavailable preference storage", async () => {
    for (const getItem of [async () => "{broken", async () => { throw new Error("unavailable"); }]) {
      const store = createEdgePreferencesStore({ getItem, setItem: async () => {} });
      await store.getState().hydrate();
      expect(store.getState()).toMatchObject({ mode: "normal", selectedHostIds: null, hydrated: true });
    }
    expect(normalizeEdgePreferences({ mode: "unexpected", selectedHostIds: ["pc", null, "pc", 2, ""] }))
      .toEqual({ mode: "normal", selectedHostIds: ["pc"] });
  });
});

describe("Edge aggregation", () => {
  it("publishes a stable selected-host snapshot and reacts to activity on every selected host", () => {
    const usage: Record<string, Record<string, RecentSession>> = { mac: {}, pc: {}, excluded: {} };
    const read = createEdgeRecentReader(hosts, (id) => usage[id]!);
    const initial = read();
    expect(read()).toBe(initial);
    usage.excluded = { task: recent("excluded", "task", 5) };
    expect(read()).toBe(initial);
    usage.pc = { task: recent("pc", "task", 7) };
    expect(read()).not.toBe(initial);
    expect(read()[1]!.task!.openedAt).toBe(7);
  });

  it("globally sorts by activity before applying the shared recent limit", () => {
    const runtimes = { mac: runtime(session("same", 1), session("old", 2)), pc: runtime(session("same", 90), session("new", 80)) };
    const data = buildEdgeDashboard(hosts, runtimes, 2, (id): Record<string, RecentSession> => id === "mac" ? { same: recent("mac", "same", 100) } : {});
    expect(data.recent.map((value) => [value.host.id, value.session.id])).toEqual([["mac", "same"], ["pc", "same"]]);
    expect(data.recent[0]!.key).not.toBe(data.recent[1]!.key);
    expect(buildEdgeDashboard(hosts, runtimes, 0, () => ({})).recent).toEqual([]);
  });

  it("keeps identical paths separate and applies managed workspaces per host", () => {
    const runtimes = { mac: runtime(session("same", 1)), pc: runtime(session("same", 2)) };
    const data = buildEdgeDashboard(hosts, runtimes, 5, () => ({}), { mac: ["/work/repo"] });
    expect(data.projects).toHaveLength(2);
    expect(data.projects.find((value) => value.host.id === "mac")!.managed).toBe(true);
    expect(data.projects.find((value) => value.host.id === "pc")!.managed).toBe(false);
    expect(new Set(data.projects.map((value) => value.key)).size).toBe(2);
    expect(edgeItemKey("a:b", "c")).not.toBe(edgeItemKey("a", "b:c"));
  });

  it("retains offline cached data without blocking connected hosts and excludes unchecked devices", () => {
    const runtimes = { mac: runtime(session("mac-task", 1)), pc: { ...runtime(session("pc-task", 2)), status: "failed" as const } };
    expect(buildEdgeDashboard([...hosts, host("loading")], runtimes, 5, () => ({})).recent).toHaveLength(2);
    const data = buildEdgeDashboard(selectedEdgeHosts(hosts, ["mac"]), runtimes, 5, () => ({}));
    expect(data.recent.map((value) => value.session.id)).toEqual(["mac-task"]);
    expect(data.projects.map((value) => value.host.id)).toEqual(["mac"]);
    expect(buildEdgeDashboard([], runtimes, 5, () => ({}))).toEqual({ recent: [], approvals: [], projects: [] });
  });

  it("collects approvals across hosts without treating questions as approvals", () => {
    const waiting = { ...session("approval", 1), status: "waiting_approval" as const };
    const explicit = { ...session("permission", 2), pendingPermissions: 3 };
    const question = { ...session("question", 3), status: "waiting_input" as const, pendingQuestions: 1 };
    const data = buildEdgeDashboard(hosts, { mac: runtime(waiting), pc: runtime(explicit, question) }, 5, () => ({}));
    expect(data.approvals.map((value) => [value.host.id, value.session.id])).toEqual([["pc", "permission"], ["mac", "approval"]]);
  });
});
