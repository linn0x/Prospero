import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { RustClient } from "../src/main/rust-client";
import { StateStore } from "../src/main/state-store";
import { RequestRegistry } from "../src/main/request-registry";
import { WorkspaceSessionPager } from "../src/renderer/src/workspace-session-pager";
import { TimelineController } from "../src/renderer/src/timeline-controller";

const binary = resolve("../../target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const fixtures: { directory: string; runtime: RustRuntime }[] = [];

function fixture(count = 0, turns = 0) {
  const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-desktop-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  if (count) {
    const seeded = spawnSync(binary, ["seed-benchmark", "--data-dir", dataDir, "--sessions", String(count)], { encoding: "utf8", timeout: 30000 });
    expect(seeded.status, seeded.stderr).toBe(0);
  }
  if (turns) {
    const seeded = spawnSync(binary, ["seed-conversation", "--data-dir", dataDir, "--turns", String(turns)], { encoding: "utf8", timeout: 30000 });
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
  it.skipIf(process.platform === "win32")("preserves committed live output when the daemon is killed and recovers without rerunning the shell", async () => {
    const { directory, dataDir, runtime, store } = fixture(10000);
    expect((await runtime.start()).ok).toBe(true);
    const head = await runtime.request("/_prospero/control/session/create", { method: "POST", body: { agent: "shell", kind: "pty", cwd: directory, cols: 80, rows: 24 } });
    const id = String(head!["id"]);
    await runtime.request(`/_prospero/control/session/${id}/interact`, { method: "POST", body: { type: "term.input", dataB64: Buffer.from("printf 'committed-live-marker\\n'; read answer\n").toString("base64") } });
    const database = new DatabaseSync(resolve(dataDir, "prospero.sqlite"), { readOnly: true });
    let seq = 0;
    try {
      await vi.waitFor(() => {
        const row = database.prepare("SELECT latest_seq,snapshot FROM terminal_runs WHERE session_id=? AND active=1").get(id)!;
        const snapshot = JSON.parse(String(row["snapshot"]));
        expect(Buffer.from(snapshot.dataB64, "base64").toString("utf8")).toContain("committed-live-marker");
        seq = Number(row["latest_seq"]); expect(snapshot.seq).toBe(seq);
      }, { timeout: 5000 });
      process.kill(store.snapshot().daemon.pid!, "SIGKILL");
      await vi.waitFor(() => expect(runtime.managed).toBe(false));
      expect((await runtime.start()).ok).toBe(true);
      const connection = JSON.parse(readFileSync(resolve(dataDir, "connection.json"), "utf8"));
      const client = new RustClient(connection.baseUrl, connection.token);
      expect((await client.health()).activeRuntimeSessions).toBe(0);
      expect((await client.session(id)).status).toBe("failed");
      const snapshot = await client.terminalSnapshot(id);
      expect(snapshot?.seq).toBeGreaterThanOrEqual(seq);
      expect(Buffer.from(snapshot!.dataB64, "base64").toString("utf8")).toContain("committed-live-marker");
      const output = await client.terminalOutput(id, { afterSeq: 0, waitMs: 0 });
      expect(output.exited).toBe(true);
      expect(output.events.length).toBeGreaterThan(0);
      const ahead = await runtime.request(`/_prospero/control/session/${id}/view?outputAfterSeq=${output.latestSeq + 100}`);
      expect(ahead?.["mode"]).toBe("snapshot");
      expect(ahead?.["seq"]).toBe(output.latestSeq);
    } finally { database.close(); }
  }, 15000);

  it.skipIf(process.platform === "win32")("serializes long Unicode pastes without duplicating or interleaving their chunks", async () => {
    const { directory, runtime } = fixture();
    expect((await runtime.start()).ok).toBe(true);
    const head = await runtime.request("/_prospero/control/session/create", { method: "POST", body: { agent: "shell", kind: "pty", cwd: directory, cols: 80, rows: 24 } });
    const id = String(head!["id"]);
    const first = Buffer.from("\x1b[200~" + "中文🦀\n".repeat(1200) + "\x1b[201~");
    const second = Buffer.from("second\n".repeat(1300));
    const interact = (bytes: Buffer) => runtime.request(`/_prospero/control/session/${id}/interact`, { method: "POST", body: { type: "term.input", dataB64: bytes.toString("base64") } });
    await interact(Buffer.from(`stty raw -echo; : > ready-paste; head -c ${first.length + second.length} > paste.bin; stty sane\n`));
    await vi.waitFor(() => expect(existsSync(resolve(directory, "ready-paste"))).toBe(true));
    await Promise.all([interact(first), interact(second)]);
    await vi.waitFor(() => expect(readFileSync(resolve(directory, "paste.bin"))).toEqual(Buffer.concat([first, second])), { timeout: 5000 });
  }, 15000);

  it.skipIf(process.platform === "win32")("recovers a cursor older than the output ring using a bounded screen checkpoint", async () => {
    const { directory, runtime } = fixture();
    expect((await runtime.start()).ok).toBe(true);
    const head = await runtime.request("/_prospero/control/session/create", { method: "POST", body: { agent: "shell", kind: "pty", cwd: directory, cols: 80, rows: 24 } });
    const id = String(head!["id"]);
    await runtime.request(`/_prospero/control/session/${id}/interact`, { method: "POST", body: { type: "term.input", dataB64: Buffer.from("dd if=/dev/zero bs=65536 count=20 2>/dev/null | tr '\\000' x; printf 'resync-marker\\n'; sleep 60\n").toString("base64") } });
    await vi.waitFor(async () => {
      const frame = await runtime.request(`/_prospero/control/session/${id}/view?outputAfterSeq=0`);
      expect(frame?.["mode"]).toBe("snapshot");
      const bytes = Buffer.from(String(frame!["dataB64"]), "base64");
      expect(bytes.length).toBeLessThan(100_000);
      expect(bytes.toString("utf8")).toContain("resync-marker");
    }, { timeout: 8000, interval: 100 });
  }, 15000);

  it.skipIf(process.platform === "win32")("owns real terminal processes and archives them before managed shutdown", async () => {
    const { directory, dataDir, runtime, store } = fixture();
    expect((await runtime.start()).ok).toBe(true);
    const connection = JSON.parse(readFileSync(resolve(dataDir, "connection.json"), "utf8"));
    const client = new RustClient(connection.baseUrl, connection.token);
    const head = await client.createTerminal({ title: "Terminal integration", workspace: directory, size: { cols: 80, rows: 24 } });
    expect(head.kind).toBe("pty");
    expect((await client.health()).activeRuntimeSessions).toBe(1);
    await client.terminalResize(head.id, { cols: 100, rows: 30 });
    await client.terminalInput(head.id, Buffer.from("printf 'PTY_PID:%s\\n' $$; sleep 60\n"));
    let cursor = 0; let output = ""; let pid: number | undefined;
    await vi.waitFor(async () => {
      const page = await client.terminalOutput(head.id, { afterSeq: cursor, waitMs: 100 });
      expect(page.resyncRequired).toBe(false);
      cursor = page.nextSeq;
      for (const event of page.events) if (event.type === "output") output += Buffer.from(event.dataB64, "base64").toString("utf8");
      pid = Number(/PTY_PID:(\d+)/.exec(output)?.[1]);
      expect(pid).toBeGreaterThan(0);
    }, { timeout: 5000 });
    await vi.waitFor(() => expect(store.snapshot().daemon.sessions.some(session => session.id === head.id)).toBe(true));
    expect((await runtime.stop()).ok).toBe(true);
    await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 2000 });
    expect((await runtime.start()).ok).toBe(true);
    const restarted = JSON.parse(readFileSync(resolve(dataDir, "connection.json"), "utf8"));
    const next = new RustClient(restarted.baseUrl, restarted.token);
    expect((await next.health()).activeRuntimeSessions).toBe(0);
    expect((await next.session(head.id)).lifecycle).toBe("archived");
    expect((await next.terminalSnapshot(head.id))?.seq).toBeGreaterThanOrEqual(cursor);
    expect((await next.terminalOutput(head.id, { afterSeq: cursor, waitMs: 0 })).exited).toBe(true);
  }, 15000);

  it.skipIf(process.platform === "win32")("opens shell sessions through the existing control bridge and restores live snapshots", async () => {
    const { directory, runtime, store } = fixture();
    expect((await runtime.start()).ok).toBe(true);
    const created = await runtime.request("/_prospero/control/session/create", { method: "POST", body: { agent: "shell", kind: "pty", cwd: directory, cols: 80, rows: 24 } });
    const id = String(created!["id"]);
    expect(created?.["terminalMode"]).toBe("events");
    expect(store.snapshot().daemon.sessions.find(session => session.id === id)?.terminalMode).toBe("events");
    await runtime.request(`/_prospero/control/session/${id}/interact`, { method: "POST", body: { type: "term.input", dataB64: Buffer.from("printf '\\033[?1049h\\033[2;4Hrestored-marker'; sleep 60\n").toString("base64") } });
    await vi.waitFor(async () => {
      const frame = await runtime.request(`/_prospero/control/session/${id}/view`);
      expect(frame?.["mode"]).toBe("snapshot");
      expect(Buffer.from(String(frame?.["dataB64"]), "base64").toString("utf8")).toContain("restored-marker");
    }, { timeout: 5000 });
    const frame = await runtime.request(`/_prospero/control/session/${id}/view`);
    const controller = new AbortController();
    const waiting = runtime.request(`/_prospero/control/session/${id}/view?outputAfterSeq=${String(frame!["seq"])}&waitMs=5000`, { signal: controller.signal });
    controller.abort(); await expect(waiting).rejects.toThrow();
    await runtime.request(`/_prospero/control/session/${id}/kill`, { method: "POST" });
    await vi.waitFor(async () => expect((await runtime.listSessions({ ids: [id], terminal: true })).total).toBe(1));
  }, 15000);

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

  it("reads durable conversation pages and full Unicode bodies through the existing desktop data bridge", async () => {
    const { runtime, store } = fixture(0, 2600);
    expect((await runtime.start()).ok).toBe(true);
    const session = store.snapshot().daemon.sessions[0]!;
    expect(session.historyMode).toBe("paged");
    const registry = new RequestRegistry();
    const controller = new TimelineController({
      readTimeline: (sid, query, id) => registry.run(id, signal => runtime.readTimeline(sid, query, signal)),
      readTimelineChanges: (sid, after, id) => registry.run(id, signal => runtime.readTimelineChanges(sid, after, signal)),
      lookupTimeline: (sid, ids, id) => registry.run(id, signal => runtime.lookupTimeline(sid, ids, signal)),
      cancelSessionPage: async id => registry.cancel(id),
    }, session.id);
    try {
      controller.start();
      await vi.waitFor(() => expect(controller.getSnapshot().page?.latestPosition).toBe(10400));
      expect(controller.getSnapshot().page?.items).toHaveLength(40);
      expect(controller.getSnapshot().page?.items[0]?.position).toBe(10361);
      await controller.older();
      expect(controller.getSnapshot().page?.items[0]?.position).toBe(10321);
      await controller.latest();
      const answer = controller.getSnapshot().page!.items.at(-2)!;
      expect(answer.truncated).toBe(true);
      const signal = new AbortController().signal;
      let body = "", part = 0;
      for (;;) {
        const page = await runtime.readTimelineText(session.id, answer.id, { part, generation: 1 }, signal);
        expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(65539);
        body += page.text;
        if (page.nextPart === null) break;
        part = page.nextPart;
      }
      expect(body).toBe("Synthetic response 2599. 中文 🦀\n".repeat(5000));
      expect(part).toBeGreaterThan(0);
      const oldest = await runtime.readTimeline(session.id, { before: 5, after: null, limit: 40 }, signal);
      expect(oldest.items[0]?.position).toBe(1);
      expect(store.snapshot().daemon.sessions).toHaveLength(1);
    } finally { controller.stop(); registry.cancelAll(); }
  }, 45000);
});
