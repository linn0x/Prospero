import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import {
  createRecentSessionStore,
  RECENT_SESSION_HOST_LIMIT,
  RECENT_SESSION_LIMIT,
  RECENT_SUMMARY_LIMIT,
  recentSessionSummary,
  recentSessions,
  sessionActivityChanged,
} from "../src/lib/recent-sessions";
import { homeRecentSessions, homeRecentSummary } from "../src/lib/home-dashboard";
import { useApp } from "../src/lib/store";

function session(id: string, createdAt = 10): SessionInfo {
  return { id, agent: "codex", kind: "structured", title: "Codex", cwd: "/work", status: "idle", createdAt, cols: 80, rows: 24 };
}

function fixture() {
  let time = 100;
  let raw: string | null = null;
  const storage = {
    getItem: vi.fn(async () => raw),
    setItem: vi.fn(async (_key: string, value: string) => { raw = value; }),
  };
  const store = createRecentSessionStore(storage, () => time);
  return { store, storage, raw: () => raw, time: (value: number) => { time = value; } };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("recent conversation index", () => {
  it("moves an old conversation above new creations when opened or used, independently per host", async () => {
    const f = fixture();
    const sessions = { old: session("old"), newer: session("newer", 50) };
    f.store.opened("mac", "old");
    f.store.activity("pc", "newer", "Windows build failure");
    expect(homeRecentSessions(sessions, 2, f.store.getHost("mac")).map((s) => s.id)).toEqual(["old", "newer"]);
    expect(homeRecentSessions(sessions, 2, f.store.getHost("pc")).map((s) => s.id)).toEqual(["newer", "old"]);
    f.time(110);
    f.store.activity("mac", "newer", "Fix connection timeout");
    expect(homeRecentSessions(sessions, 1, f.store.getHost("mac"))[0]?.id).toBe("newer");
    expect(f.store.getHost("mac").newer?.summary).toBe("Fix connection timeout");
    expect(f.store.getHost("pc").newer?.summary).toBe("Windows build failure");
    await f.store.flush();
  });

  it("uses the actual existing turn timestamp without treating synchronization as a new event", () => {
    const old = { ...session("old"), busySince: 70 };
    const newer = session("newer", 50);
    expect(homeRecentSessions({ old, newer }, 2).map((s) => s.id)).toEqual(["old", "newer"]);
    expect(sessionActivityChanged(undefined, old)).toBe(false);
    expect(sessionActivityChanged(old, { ...old })).toBe(false);
    expect(sessionActivityChanged(old, { ...old, status: "running", accountName: "Renamed", title: "New title" })).toBe(false);
    expect(sessionActivityChanged(old, { ...old, preview: "A new response" })).toBe(true);
    expect(sessionActivityChanged(old, { ...old, busySince: 80 })).toBe(true);
    expect(sessionActivityChanged(old, { ...old, totals: { costUsd: 0, inputTokens: 1, outputTokens: 1 } })).toBe(true);
  });

  it("never records hello/reconnect snapshots or status-only updates as current activity", () => {
    const activity = vi.spyOn(recentSessions, "activity").mockImplementation(() => {});
    useApp.setState({ runtimes: {} });
    const app = useApp.getState();
    const baseline = { ...session("old"), preview: "Earlier response" };
    app.setSessions("mac", [baseline]);
    app.patchRuntime("mac", { status: "connected" });
    app.upsertSession("mac", { ...baseline, status: "running" });
    expect(activity).not.toHaveBeenCalled();
    app.upsertSession("mac", { ...baseline, preview: "Live new response" });
    expect(activity).toHaveBeenCalledExactlyOnceWith("mac", "old", "Live new response");
    activity.mockClear();
    app.patchRuntime("mac", { status: "reconnecting" });
    const reconnect = { ...baseline, preview: "Work completed while disconnected", totals: { costUsd: 0, inputTokens: 100, outputTokens: 200 } };
    app.setSessions("mac", [reconnect]);
    app.patchRuntime("mac", { status: "connected" });
    app.upsertSession("mac", { ...reconnect });
    app.upsertSession("mac", { ...reconnect, status: "idle", cols: 120 });
    expect(activity).not.toHaveBeenCalled();
    app.setSessions("pc", [baseline]);
    app.upsertSession("pc", { ...baseline, preview: "Offline data" });
    expect(activity).not.toHaveBeenCalled();
    useApp.setState({ runtimes: {} });
  });

  it("restores recent usage across process launches and preserves an open during late hydration", async () => {
    const f = fixture();
    f.store.activity("mac", "old", "Previous short summary");
    await f.store.flush();
    let release!: (value: string | null) => void;
    const reading = new Promise<string | null>((resolve) => { release = resolve; });
    const restored = createRecentSessionStore({ ...f.storage, getItem: () => reading }, () => 500);
    const loading = restored.load();
    restored.opened("mac", "old");
    restored.activity("pc", "old", "Different host");
    release(f.raw());
    await loading;
    expect(restored.getHost("mac").old).toMatchObject({ openedAt: 500, activityAt: 100, summary: "Previous short summary" });
    expect(restored.getHost("pc").old?.summary).toBe("Different host");
    await restored.flush();
    const nextLaunch = createRecentSessionStore(f.storage);
    await nextLaunch.load();
    expect(nextLaunch.getHost("mac").old?.openedAt).toBe(500);
  });

  it("bounds record count, per-host capacity and multi-megabyte message summaries", async () => {
    const f = fixture();
    const message = "修复连接🙂 ".repeat(300_000);
    for (let i = 0; i < RECENT_SESSION_LIMIT + 50; i++) {
      f.time(i + 1);
      f.store.activity(i < 150 ? "mac" : `host-${i}`, `session-${i}`, message);
    }
    await f.store.flush();
    expect(Object.keys(f.store.getHost("mac"))).toHaveLength(RECENT_SESSION_HOST_LIMIT);
    const persisted = JSON.parse(f.raw()!);
    expect(persisted.entries).toHaveLength(RECENT_SESSION_LIMIT);
    expect(persisted.entries.every((item: { summary: string }) => item.summary.length <= RECENT_SUMMARY_LIMIT)).toBe(true);
    expect(f.raw()!.length).toBeLessThan(256 * 1024);
    expect(f.raw()).not.toContain(message);
  });

  it("bounds and distinguishes metadata/local summaries without requiring conversation history", async () => {
    const f = fixture();
    f.store.activity("mac", "one", "Investigate websocket reconnects");
    f.store.activity("mac", "two", "Fix calendar sync");
    expect(homeRecentSummary(session("one"), f.store.getHost("mac").one)).toBe("Investigate websocket reconnects");
    expect(homeRecentSummary(session("two"), f.store.getHost("mac").two)).toBe("Fix calendar sync");
    expect(homeRecentSummary({ ...session("one"), preview: "##  Connection\n repaired" }, f.store.getHost("mac").one)).toBe("Connection repaired");
    expect(recentSessionSummary("a".repeat(158) + "🙂" + "tail")).toBe("a".repeat(158) + "…");
    expect(homeRecentSummary(session("empty"))).toBe("尚无内容摘要");
    await f.store.flush();
  });

  it("serializes slow writes so an older save cannot replace a later open", async () => {
    const f = fixture();
    await f.store.load();
    const original = f.storage.setItem.getMockImplementation()!;
    let release!: () => void;
    f.storage.setItem.mockImplementationOnce(async (key, value) => {
      await new Promise<void>((resolve) => { release = resolve; });
      await original(key, value);
    });
    f.store.opened("mac", "old");
    const first = f.store.flush();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.time(900);
    f.store.opened("mac", "new");
    const second = f.store.flush();
    release();
    await Promise.all([first, second]);
    const restored = createRecentSessionStore(f.storage);
    await restored.load();
    expect(restored.getHost("mac").new?.openedAt).toBe(900);
    expect(restored.getHost("mac").old?.openedAt).toBe(100);
  });

  it("coalesces sustained activity and concurrent flushes while storage is blocked", async () => {
    const f = fixture();
    await f.store.load();
    const original = f.storage.setItem.getMockImplementation()!;
    const releases: (() => void)[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    f.storage.setItem.mockImplementation(async (key, value) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      await original(key, value);
      inFlight--;
    });
    f.store.activity("mac", "old", "initial");
    const flushes = [f.store.flush()];
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    for (let i = 1; i <= 100; i++) {
      f.time(i + 100);
      f.store.activity("mac", "old", `update ${i}`);
      flushes.push(f.store.flush());
    }
    await Promise.resolve();
    expect(f.storage.setItem).toHaveBeenCalledTimes(1);
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(JSON.parse(f.storage.setItem.mock.calls[1]![1]).entries[0].summary).toBe("update 100");
    for (let i = 101; i <= 200; i++) {
      f.time(i + 100);
      f.store.activity("mac", "old", `update ${i}`);
      flushes.push(f.store.flush());
    }
    await Promise.resolve();
    expect(f.storage.setItem).toHaveBeenCalledTimes(2);
    releases[1]!();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    expect(JSON.parse(f.storage.setItem.mock.calls[2]![1]).entries[0].summary).toBe("update 200");
    releases[2]!();
    await Promise.all(flushes);
    expect(maxInFlight).toBe(1);
    expect(f.storage.setItem).toHaveBeenCalledTimes(3);
    expect(JSON.parse(f.raw()!).entries[0].summary).toBe("update 200");
  });

  it("preserves unrelated host snapshot references, including while writes are pending", async () => {
    const f = fixture();
    f.store.opened("mac", "same-id");
    f.store.opened("pc", "same-id");
    await f.store.flush();
    const mac = f.store.getHost("mac");
    const pc = f.store.getHost("pc");
    const empty = f.store.getHost("missing");
    let observedMacChange = false;
    const unsubscribe = f.store.subscribe(() => {
      observedMacChange ||= f.store.getHost("mac") !== mac;
    });
    f.time(200);
    f.store.activity("pc", "same-id", "PC work");
    f.store.opened("pc", "second");
    expect(f.store.getHost("mac")).toBe(mac);
    expect(f.store.getHost("pc")).not.toBe(pc);
    expect(f.store.getHost("missing")).toBe(empty);
    expect(observedMacChange).toBe(false);
    await f.store.flush();
    expect(f.store.getHost("mac")).toBe(mac);
    unsubscribe();
    f.store.activity("mac", "same-id", "Mac work");
    expect(f.store.getHost("mac")).not.toBe(mac);
    await f.store.flush();
  });

  it("invalidates a cached host snapshot when capacity eviction removes its last record", async () => {
    const f = fixture();
    f.store.opened("old-host", "old-session");
    const before = f.store.getHost("old-host");
    for (let i = 0; i < RECENT_SESSION_LIMIT; i++) {
      f.time(i + 101);
      f.store.opened(`host-${i}`, `session-${i}`);
    }
    expect(f.store.getHost("old-host")).not.toBe(before);
    expect(f.store.getHost("old-host")).toEqual({});
    await f.store.flush();
  });

  it("treats unreadable/corrupt storage as an empty index and keeps new opens usable", async () => {
    const f = fixture();
    f.storage.getItem.mockResolvedValueOnce("{broken");
    await f.store.load();
    expect(f.store.getHost("mac")).toEqual({});
    f.storage.setItem.mockRejectedValueOnce(new Error("storage unavailable"));
    f.store.opened("mac", "old");
    await f.store.flush();
    expect(f.store.getHost("mac").old?.openedAt).toBe(100);
    await f.store.flush();
    expect(f.raw()).toContain('"sessionId":"old"');
  });
});
