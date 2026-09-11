import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { RustClient } from "../src/main/rust-client";
import { StateStore } from "../src/main/state-store";
import { RequestRegistry } from "../src/main/request-registry";
import { WorkspaceSessionPager } from "../src/renderer/src/workspace-session-pager";

const binary = resolve("../../target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const fixtures: { directory: string; runtime: RustRuntime }[] = [];

function fixture(count = 0) {
  const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-desktop-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  if (count) {
    const seeded = spawnSync(binary, ["seed-benchmark", "--data-dir", dataDir, "--sessions", String(count)], { encoding: "utf8", timeout: 30000 });
    expect(seeded.status, seeded.stderr).toBe(0);
  }
  return { directory, dataDir, store, runtime };
}

afterEach(async () => {
  for (const { directory, runtime } of fixtures.splice(0)) {
    expect((await runtime.stop()).ok).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("existing desktop shell with the real Rust runtime", () => {
  it("loads a bounded window, pages history and applies external commits without legacy projections", async () => {
    const { dataDir, store, runtime } = fixture(10000);
    writeFileSync(resolve(store.home, "status.json"), JSON.stringify({ pid: process.pid, sessions: [{ id: "legacy-must-not-load" }] }));
    const started = await Promise.all(Array.from({ length: 4 }, () => runtime.start()));
    expect(started.every(result => result.ok)).toBe(true);
    const snapshot = store.snapshot();
    expect(snapshot.daemon.managed).toBe(true);
    expect(snapshot.daemon.sessions).toHaveLength(20);
    expect(snapshot.daemon.sessionSummary).toMatchObject({ total: 10000, terminal: 10000, included: 20, omitted: 9980 });
    expect(snapshot.projects).toEqual(["/synthetic"]);
    expect(snapshot.daemon.workspaceCounts?.["/synthetic"]?.total).toBe(10000);
    expect(snapshot.daemon.sessions.every(head => head.kind === "structured")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("token");
    const first = await runtime.listSessions({ limit: 7 });
    const second = await runtime.listSessions({ cursor: first.nextCursor, limit: 7 });
    expect(first.total).toBe(10000);
    expect(new Set([...first.items, ...second.items].map(head => head.id)).size).toBe(14);
    const pinned = await runtime.listSessions({ ids: ["session-000000001", "missing", "session-000000002", "session-000000003"], limit: 1 });
    expect(pinned.items[0]?.id).toBe("session-000000001");
    expect(pinned.total).toBe(3);
    const next = await runtime.listSessions({ ids: ["session-000000001", "missing", "session-000000002", "session-000000003"], limit: 1, cursor: pinned.nextCursor });
    expect(next.items[0]?.id).toBe("session-000000002");
    await expect(runtime.listSessions({ ids: ["session-000000004"], cursor: pinned.nextCursor })).rejects.toThrow("不匹配");
    const connection = JSON.parse(readFileSync(resolve(dataDir, "connection.json"), "utf8"));
    const client = new RustClient(connection.baseUrl, connection.token);
    const id = first.items[0]!.id;
    await client.rename(id, { revision: 1, title: "External update" });
    await vi.waitFor(() => expect(store.snapshot().daemon.sessions.find(head => head.id === id)?.title).toBe("External update"), { timeout: 3000 });
    const changed = vi.fn(); store.on("changed", changed);
    await new Promise(done => setTimeout(done, 1200));
    expect(changed).not.toHaveBeenCalled();
    await runtime.rename("session-000000001", "Renamed archive");
    expect((await runtime.listSessions({ query: "Renamed archive" })).items[0]?.title).toBe("Renamed archive");
    const pid = store.snapshot().daemon.pid;
    expect((await runtime.restart()).ok).toBe(true);
    expect(store.snapshot().daemon.pid).not.toBe(pid);
    expect((await runtime.listSessions({ ids: ["session-000000001"] })).items[0]?.title).toBe("Renamed archive");
    await expect(runtime.request("/_prospero/control/session/create")).rejects.toThrow("尚未接入");
    expect((await runtime.stop()).ok).toBe(true);
    expect(store.snapshot().daemon.running).toBe(false);
    expect(runtime.managed).toBe(false);
  }, 45000);

  it("rejects a second owner and can recover after an unexpected process exit", async () => {
    const { directory, dataDir, runtime, store } = fixture();
    expect((await runtime.start()).ok).toBe(true);
    const second = new RustRuntime(new StateStore(resolve(directory, "second-desktop"), "api"), binary, dataDir);
    try { expect((await second.start()).ok).toBe(false); } finally { await second.stop(); }
    expect(runtime.managed).toBe(true);
    process.kill(store.snapshot().daemon.pid!, "SIGKILL");
    await vi.waitFor(() => expect(runtime.managed).toBe(false));
    expect(store.snapshot().daemon.running).toBe(false);
    expect((await runtime.start()).ok).toBe(true);
  }, 15000);

  it("cancels startup, releases ownership and starts again without a stale pending launch", async () => {
    const { runtime, store } = fixture();
    const starting = runtime.start();
    expect((await runtime.stop()).ok).toBe(true);
    expect((await starting).ok).toBe(false);
    expect(runtime.managed).toBe(false);
    expect(store.snapshot().daemon.running).toBe(false);
    expect((await runtime.start()).ok).toBe(true);
  }, 15000);

  it("pages real workspace history forwards and backwards while keeping desktop state bounded", async () => {
    const { runtime, store } = fixture(10000);
    expect((await runtime.start()).ok).toBe(true);
    const registry = new RequestRegistry();
    const pager = new WorkspaceSessionPager({
      listSessions: request => registry.run(request!.requestId!, async signal => {
        const page = await runtime.listSessions(request!, signal);
        store.hydrateSessions(page.items);
        return page;
      }),
      cancelSessionPage: async id => registry.cancel(id),
    }, "/synthetic");
    try {
      pager.setActive(true);
      await vi.waitFor(() => expect(pager.getSnapshot().page?.total).toBe(10000));
      expect(pager.getSnapshot().page?.items).toHaveLength(6);
      await pager.expand();
      for (let index = 0; index < 30; index++) {
        await pager.next();
        expect(pager.getSnapshot().page?.items).toHaveLength(24);
      }
      expect(pager.getSnapshot().page?.items[0]?.id).toBe("session-000009279");
      await pager.previous();
      expect(pager.getSnapshot().page?.items[0]?.id).toBe("session-000009303");
      const id = pager.getSnapshot().page!.items[0]!.id;
      await runtime.rename(id, "Visible page update");
      expect(store.snapshot().daemon.workspaceCounts?.["/synthetic"]?.revision).toBe(10001);
      pager.setRevision(String(store.snapshot().daemon.workspaceCounts?.["/synthetic"]?.revision));
      await vi.waitFor(() => expect(pager.getSnapshot().page?.items[0]?.title).toBe("Visible page update"));
      expect(store.snapshot().daemon.sessions).toHaveLength(20);
      await pager.first();
      expect(pager.getSnapshot().page?.previousCursor).toBeUndefined();
      const cancelled = new AbortController(); cancelled.abort();
      await expect(runtime.listSessions({ workspace: "/synthetic" }, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
      await expect(runtime.listSessions({ workspace: "/different", cursor: pager.getSnapshot().page?.nextCursor })).rejects.toThrow();
    } finally { pager.setActive(false); registry.cancelAll(); }
  }, 45000);
});
