import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import type { AdapterContext, AgentAdapter } from "../src/adapters/types.js";
import { QUEUE_DISPLAY_TEXT_LIMIT, QUEUE_DISPLAY_TRUNCATION_MARKER } from "../src/queue-display.js";
import { SessionDatabase } from "../src/session-database.js";
import { SessionManager } from "../src/session-manager.js";
import { deriveStructuredHistorySummary, StructuredSession, StructuredSessionWriteFence, type StructuredSessionPersistentState } from "../src/structured-session.js";
import { reconnectStructuredSupervisors, RemoteStructuredSession, type StructuredSupervisorManifest } from "../src/structured-supervisor-client.js";
import { startStructuredSupervisor } from "../src/structured-supervisor.js";
import { SupervisorEventDatabase } from "../src/supervisor-event-database.js";

const temporary: string[] = [];
const managers: SessionManager[] = [];
function home(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-session-sqlite-"));
  temporary.push(dir);
  return dir;
}
function manager(dir: string, adapter = new FakeAdapter()): SessionManager {
  const value = new SessionManager({ home: dir, adapterFactory: () => adapter });
  managers.push(value);
  return value;
}
function database<T>(dir: string, read: (db: SessionDatabase) => T): T {
  const db = new SessionDatabase(path.join(dir, "sessions.sqlite"), { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
function state(id: string, events: AgentEventBody[] = []): StructuredSessionPersistentState {
  return {
    version: 1, id, agent: "codex", title: "Durable history", cwd: "/tmp", createdAt: 1,
    approvalPolicy: "standard", events, evSeq: events.length, preview: "Preview", previewRaw: "Preview", previewMsgId: "answer",
    totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, toolOutputs: [], adapterState: { threadId: "native-1" },
    messageQueue: [], terminal: true, historySummary: deriveStructuredHistorySummary(events),
  };
}
class FakeAdapter implements AgentAdapter {
  context?: AdapterContext;
  starts = 0;
  sends: string[] = [];
  async start(context: AdapterContext) { this.context = context; this.starts++; }
  async send(text: string) { this.sends.push(text); }
  async respondPermission() {}
  async interrupt() {}
  async dispose() { this.context = undefined; }
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const value of managers.splice(0)) await value.disposeAll().catch(() => {});
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("authoritative session SQLite integration", () => {
  it.each(["event", "tool"] as const)("permanently fences a failed %s write before late callbacks or queue mutations, while disposal still cancels", async (failureKind) => {
    const adapter = new FakeAdapter();
    const disposed = vi.spyOn(adapter, "dispose");
    const cancellation = vi.fn();
    const fence = new StructuredSessionWriteFence(cancellation);
    let fail = false;
    let writes = 0;
    const write = () => { writes++; if (fail) throw new Error("synthetic disk failure"); };
    const session = new StructuredSession({
      id: "fenced", agent: "codex", title: "fixture", cwd: home(), adapter,
      storage: {
        assertWritable: () => fence.assertWritable(),
        historyPage: () => ({ events: [], lastSeq: 0, oldestSeq: 0, hasMore: false }),
        readEvents: () => ({ events: [], evSeq: 0 }),
        toolOutput: () => null,
        saveToolOutput: () => fence.run(write),
      },
    });
    const persist = () => fence.run(() => {
      write();
      session.acknowledgePersistence(session.persistentState({ incremental: true }).evSeq);
    });
    session.on("state", persist);
    session.on("event", persist);
    session.on("persist", persist);
    const forwarded = vi.fn();
    session.on("event", forwarded);
    await session.start();
    const context = adapter.context!;
    fail = true;
    const event: AgentEventBody = { kind: "text.delta", msgId: "a", textId: "t", delta: "late" };
    expect(() => failureKind === "event" ? context.emit(event) : context.recordOutput!("tool", "body")).toThrow("持久化失败");
    const attemptedWrites = writes;
    const failedCursor = session.persistentState({ incremental: true }).evSeq;
    fail = false; // Disk recovery alone must never remove the permanent fence.
    for (let index = 0; index < 100; index++) expect(() => context.emit(event)).toThrow("持久化失败");
    expect(() => context.recordOutput!("later-tool", "body")).toThrow("持久化失败");
    expect(() => context.persistState!({ threadId: "must-not-change" })).toThrow("持久化失败");
    await expect(session.send("must-not-queue", undefined, "queue")).rejects.toThrow("持久化失败");
    await expect(session.guideQueued("missing")).rejects.toThrow("持久化失败");
    expect(() => session.removeQueued("missing")).toThrow("持久化失败");
    expect(session.persistentState({ incremental: true }).evSeq).toBe(failedCursor);
    expect(session.persistentState({ incremental: true }).events).toHaveLength(failureKind === "event" ? 1 : 0);
    expect(writes).toBe(attemptedWrites);
    expect(forwarded).not.toHaveBeenCalled();
    expect(cancellation).toHaveBeenCalledTimes(1);
    await expect(session.dispose()).rejects.toThrow("持久化失败");
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("appends beyond the UI window and keeps complete tool bodies without rewriting JSON", async () => {
    const dir = home();
    const adapter = new FakeAdapter();
    const owner = manager(dir, adapter);
    const created = await owner.create({ agent: "codex", kind: "structured", cwd: dir, cols: 80, rows: 24, allowShell: false });
    for (let n = 0; n < 4_012; n++) adapter.context!.emit({ kind: "text.delta", msgId: "answer", textId: "text", delta: String(n) });
    const fullOutput = "完整工具输出".repeat(100_000);
    adapter.context!.recordOutput!("tool-large", fullOutput);
    await owner.flushPersistence();
    expect(existsSync(path.join(dir, "structured-sessions.json"))).toBe(false);
    expect(owner.requireStructured(created.id).snapshot().events).toHaveLength(4_000);
    expect(owner.requireStructured(created.id).toolOutput("tool-large")?.truncated).toBe(true);
    database(dir, (db) => {
      const page = db.readEventsPage(created.id, { limit: 5_000, maxBytes: Number.MAX_SAFE_INTEGER });
      expect(page.events).toHaveLength(4_012);
      expect(page.events[0]?.seq).toBe(1);
      expect(page.lastSeq).toBe(4_012);
      expect(db.toolOutput(created.id, "tool-large", { maxBytes: Number.MAX_SAFE_INTEGER })).toEqual({ output: fullOutput, truncated: false });
    });
    adapter.context!.emit({ kind: "turn.end", msgId: "answer", inputTokens: 3, outputTokens: 4 });
    await owner.flushPersistence();
    expect(database(dir, (db) => db.readEventsPage(created.id, { beforeSeq: 2 }).events[0]?.body))
      .toEqual({ kind: "text.delta", msgId: "answer", textId: "text", delta: "0" });
  });

  it("restores metadata lazily, preserves a large queued body, and loads complete history only on attach", async () => {
    const dir = home();
    const fullText = "历史正文".repeat(180_000);
    const events: AgentEventBody[] = [
      { kind: "text.delta", msgId: "answer", textId: "text", delta: fullText },
      { kind: "permission.request", reqId: "pending", action: "read", resources: ["/tmp/example"], summary: "Review permission" },
    ];
    const stored = state("lazy", events);
    stored.messageQueue = [{ id: "large-queue", displayText: "队列内容".repeat(150_000), outgoingText: "queued", kind: "queue", createdAt: 3, attachmentCount: 0, attachments: [] }];
    const db = new SessionDatabase(path.join(dir, "sessions.sqlite"));
    db.saveSession(stored);
    db.close();
    const reads = vi.spyOn(SessionDatabase.prototype, "readSession");
    const adapter = new FakeAdapter();
    const owner = manager(dir, adapter);
    await owner.restoreStructured();
    expect(adapter.starts).toBe(0);
    expect(reads.mock.calls.every(([, options]) => options?.events === false && options.toolOutputs === false)).toBe(true);
    const preview = owner.infoOf("lazy").messageQueue?.[0]?.text;
    expect(preview).toHaveLength(QUEUE_DISPLAY_TEXT_LIMIT);
    expect(preview?.endsWith(QUEUE_DISPLAY_TRUNCATION_MARKER)).toBe(true);
    expect(stored.messageQueue[0]!.displayText.startsWith(preview!.slice(0, -QUEUE_DISPLAY_TRUNCATION_MARKER.length))).toBe(true);
    const snapshot = owner.requireStructured("lazy").snapshot();
    expect(snapshot.events[0]).toEqual(events[0]);
    expect(snapshot.events).toContainEqual({ kind: "permission.resolved", reqId: "pending", reply: "reject" });
    expect(snapshot.evSeq).toBe(3);
    expect(database(dir, (database) => database.readSession("lazy", { events: false, toolOutputs: false, maxBytes: Number.MAX_SAFE_INTEGER })?.messageQueue?.[0]?.displayText))
      .toBe(stored.messageQueue[0]!.displayText);
  });

  it("streams legacy import once, preserves tombstones and never replays the retained backup", async () => {
    const dir = home();
    const legacy = path.join(dir, "structured-sessions.json");
    const retained = state("retained", [{ kind: "user.message", msgId: "user", text: "Keep this exact history" }]);
    const deleted = state("deleted");
    delete retained.historySummary;
    writeFileSync(legacy, JSON.stringify([retained, deleted]), { mode: 0o600 });
    writeFileSync(path.join(dir, "deleted-sessions.json"), JSON.stringify({ version: 1, ids: ["deleted"] }), { mode: 0o600 });
    const original = readFileSync(legacy, "utf8");
    const first = manager(dir);
    expect((await first.restoreStructured()).map((item) => item.id)).toEqual(["retained"]);
    expect(first.requireStructured("retained").snapshot().events).toEqual(retained.events);
    await first.kill("retained");
    await first.disposeAll();
    managers.splice(managers.indexOf(first), 1);
    expect(readFileSync(legacy, "utf8")).toBe(original);
    expect(database(dir, (db) => db.listSessionIds())).toEqual([]);
    const second = manager(dir);
    expect(await second.restoreStructured()).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(dir, "deleted-sessions.json"), "utf8")).ids.sort()).toEqual(["deleted", "retained"]);
  });

  it("does not fall back to stale JSON when authoritative SQLite is corrupt", async () => {
    const dir = home();
    const legacy = path.join(dir, "structured-sessions.json");
    writeFileSync(legacy, JSON.stringify([state("must-not-revive")]), { mode: 0o600 });
    writeFileSync(path.join(dir, "sessions.sqlite"), "corrupt SQLite", { mode: 0o600 });
    const adapter = new FakeAdapter();
    const owner = manager(dir, adapter);
    expect(await owner.restoreStructured()).toEqual([]);
    await expect(owner.flushPersistence()).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(adapter.starts).toBe(0);
    expect(readFileSync(path.join(dir, "sessions.sqlite"), "utf8")).toBe("corrupt SQLite");
  });
});

function ownerManifest(root: string, id: string, pid: number): StructuredSupervisorManifest {
  const dir = path.join(root, id);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  const manifest: StructuredSupervisorManifest = {
    version: 1, protocolVersion: 1, implementation: "supervisor", sessionId: id, agent: "codex", title: "Owner history", cwd: root,
    createdAt: 1, approvalPolicy: "standard", socket: path.join(dir, "s.sock"), transport: "unix_socket", tokenFile: "token", sessionDir: dir,
    supervisorPid: pid, lifecycleEpoch: `epoch-${id}`, status: "died",
  };
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  writeFileSync(path.join(dir, "session.json"), JSON.stringify(state(id, [{ kind: "user.message", msgId: "u", text: "Owner text" }])), { mode: 0o600 });
  return manifest;
}

describe.skipIf(process.platform === "win32")("owner migration continuity", () => {
  it("skips duplicate central history before loading its complete queue", async () => {
    const dir = home();
    const root = path.join(dir, "structured-supervisor");
    mkdirSync(root, { mode: 0o700 });
    const id = "duplicate-owner";
    const manifest = ownerManifest(root, id, process.pid);
    manifest.storageVersion = 2;
    writeFileSync(path.join(manifest.sessionDir!, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const archive = new SessionDatabase(path.join(manifest.sessionDir!, "session.sqlite"));
    archive.saveSession(state(id)); archive.close();
    const central = new SessionDatabase(path.join(dir, "sessions.sqlite"));
    central.saveSession(state(id)); central.close();
    const reads = vi.spyOn(SessionDatabase.prototype, "readSession");
    const owner = new SessionManager({ home: dir, supervisor: true });
    managers.push(owner);
    expect((await owner.restoreStructured()).map(session => session.id)).toEqual([id]);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]?.[1]?.messageQueue).toBe(false);
  });
  it("opens SQLite metadata once per reconnect without delayed archive rereads", async () => {
    const root = home();
    for (let index = 0; index < 3; index++) {
      const id = `sqlite-archive-${index}`;
      const manifest = ownerManifest(root, id, process.pid);
      manifest.storageVersion = 2;
      writeFileSync(path.join(manifest.sessionDir!, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
      const db = new SessionDatabase(path.join(manifest.sessionDir!, "session.sqlite"));
      db.saveSession(state(id)); db.close();
      writeFileSync(path.join(manifest.sessionDir!, "session.json"), "must not read legacy JSON", { mode: 0o600 });
    }
    const reads = vi.spyOn(SessionDatabase.prototype, "readSession");
    const refresh = vi.spyOn(RemoteStructuredSession.prototype, "refreshArchiveMetadata");
    for (let attempt = 0; attempt < 2; attempt++) {
      const sessions = await reconnectStructuredSupervisors(root, 5, { archiveMigrationDelayMs: 0 });
      expect(sessions).toHaveLength(3);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(reads).toHaveBeenCalledTimes((attempt + 1) * 3);
      expect(refresh).not.toHaveBeenCalled();
      expect(reads.mock.calls.every(([, options]) => options?.events === false && options.toolOutputs === false && options.messageQueue === false)).toBe(true);
      for (const session of sessions) await session.dispose();
    }
  });
  it("reattaches a live SQLite owner despite central corruption without loading history or losing a concurrent tail", async () => {
    const dir = home();
    const root = path.join(dir, "structured-supervisor");
    mkdirSync(root, { mode: 0o700 });
    const manifest = ownerManifest(root, "live-sqlite", process.pid);
    manifest.status = "idle";
    manifest.storageVersion = 2;
    const socketDir = mkdtempSync("/tmp/prospero-sqlite-ipc-");
    temporary.push(socketDir);
    manifest.socket = path.join(socketDir, "s.sock");
    const token = "synthetic-local-token";
    writeFileSync(path.join(manifest.sessionDir!, "token"), token, { mode: 0o600 });
    writeFileSync(path.join(manifest.sessionDir!, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const fullEvent: AgentEventBody = { kind: "text.delta", msgId: "answer", textId: "text", delta: "完整历史".repeat(180_000) };
    const stored = state(manifest.sessionId, [fullEvent]);
    delete stored.terminal;
    const db = new SessionDatabase(path.join(manifest.sessionDir!, "session.sqlite"));
    db.saveSession(stored);
    const supervisor = await startStructuredSupervisor({ home: manifest.sessionDir!, socketPath: manifest.socket, token });
    let emit: ((event: AgentEventBody) => void) | undefined;
    await supervisor.createSession(manifest.sessionId, {
      async start(context) { emit = context.emit; context.emit(fullEvent); },
      async call(method) {
        if (method === "info") return { id: manifest.sessionId, agent: "codex", kind: "structured", title: manifest.title, cwd: dir, createdAt: 1, status: "idle", cols: 80, rows: 24 };
        throw new Error(`unexpected history RPC during startup: ${method}`);
      },
    });
    writeFileSync(path.join(dir, "sessions.sqlite"), "broken central archive", { mode: 0o600 });
    const reads = vi.spyOn(SessionDatabase.prototype, "readSession");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const replays = vi.spyOn(SupervisorEventDatabase.prototype, "replay");
    const owner = manager(dir);
    try {
      expect((await owner.restoreStructured()).map((info) => info.id)).toEqual([manifest.sessionId]);
      expect(reads.mock.calls.every(([, options]) => options?.events === false && options.toolOutputs === false)).toBe(true);
      expect(replays).not.toHaveBeenCalled();
      const remote = owner.requireStructured(manifest.sessionId);
      const observed: AgentEventBody[] = [];
      remote.on("event", (body) => observed.push(body));
      const tail: AgentEventBody = { kind: "text.delta", msgId: "answer", textId: "text", delta: "concurrent-tail" };
      db.saveSession({ ...stored, evSeq: 2, events: [tail] });
      emit!(tail);
      await vi.waitFor(() => expect(observed).toEqual([tail]));
      expect(remote.snapshot()).toEqual({ events: [fullEvent, tail], evSeq: 2 });
      expect(remote.snapshot().events.filter((event) => event.kind === "text.delta" && event.delta === "concurrent-tail")).toHaveLength(1);
      await expect(owner.flushPersistence()).rejects.toMatchObject({ code: "storage_unavailable" });
    } finally {
      await owner.disposeAll();
      managers.splice(managers.indexOf(owner), 1);
      await supervisor.close();
      db.close();
    }
  });

  it("migrates only a verified-dead owner and leaves live legacy owners untouched", async () => {
    const root = home();
    const deadPid = 2_147_480_001;
    const inaccessiblePid = 2_147_480_002;
    ownerManifest(root, "dead", deadPid);
    ownerManifest(root, "live", process.pid);
    ownerManifest(root, "unknown", inaccessiblePid);
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid && signal === 0) throw Object.assign(new Error("not running"), { code: "ESRCH" });
      if (pid === inaccessiblePid && signal === 0) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      return kill(pid, signal);
    }) as typeof process.kill);
    const sessions = await reconnectStructuredSupervisors(root, undefined, {
      archiveMigrationDelayMs: 0,
    });
    expect(sessions).toHaveLength(3);
    // Archive discovery must publish before background SQLite work begins.
    // With thousands of dead owners, eagerly opening every staging database
    // here starves daemon startup and prevents status.json publication.
    expect(existsSync(path.join(root, "dead", "session.sqlite"))).toBe(false);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(path.join(root, "dead", "manifest.json"), "utf8")).storageVersion).toBe(2));
    expect(existsSync(path.join(root, "dead", "session.sqlite"))).toBe(true);
    expect(existsSync(path.join(root, "live", "session.sqlite"))).toBe(false);
    expect(existsSync(path.join(root, "unknown", "session.sqlite"))).toBe(false);
    expect(sessions.find((session) => session.id === "dead")!.snapshot().events[0]).toEqual({ kind: "user.message", msgId: "u", text: "Owner text" });
    expect(sessions.find((session) => session.id === "live")!.snapshot().events[0]).toEqual({ kind: "user.message", msgId: "u", text: "Owner text" });
    for (const session of sessions) await session.dispose();
  });
  it("migrates one archive at a time and checkpoints each completed owner", async () => {
    const root = home();
    const deadPid = 2_147_480_003;
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === deadPid && signal === 0) throw Object.assign(new Error("not running"), { code: "ESRCH" });
      return kill(pid, signal);
    }) as typeof process.kill);
    for (const id of ["archive-a", "archive-b", "archive-c"]) ownerManifest(root, id, deadPid);
    let active = 0, peak = 0;
    const begin = SessionDatabase.prototype.beginSessionImport;
    const finish = SessionDatabase.prototype.finishSessionImportAsync;
    vi.spyOn(SessionDatabase.prototype, "beginSessionImport").mockImplementation(function (this: SessionDatabase) {
      const token = begin.call(this);
      peak = Math.max(peak, ++active);
      return token;
    });
    vi.spyOn(SessionDatabase.prototype, "finishSessionImportAsync").mockImplementation(async function (this: SessionDatabase, ...args: Parameters<SessionDatabase["finishSessionImportAsync"]>) {
      try { await finish.apply(this, args); } finally { active--; }
    });
    const sessions = await reconnectStructuredSupervisors(root, 5, { archiveMigrationDelayMs: 0 });
    await vi.waitFor(() => {
      for (const id of ["archive-a", "archive-b", "archive-c"]) expect(JSON.parse(readFileSync(path.join(root, id, "manifest.json"), "utf8")).storageVersion).toBe(2);
    });
    expect(peak).toBe(1);
    expect(active).toBe(0);
    for (const session of sessions) await session.dispose();
  });

  it("keeps corrupt owner databases read-only and never uses the retained JSON tool/history", () => {
    const root = home();
    const manifest = ownerManifest(root, "corrupt", process.pid);
    manifest.storageVersion = 2;
    writeFileSync(path.join(manifest.sessionDir!, "session.sqlite"), "broken database", { mode: 0o600 });
    const session = RemoteStructuredSession.unavailable(manifest);
    expect(session.info().preview).toContain("历史数据库不可用");
    expect(() => session.snapshot()).toThrow("未读取迁移前备份");
    expect(() => session.toolOutput("tool")).toThrow();
    expect(readFileSync(path.join(manifest.sessionDir!, "session.sqlite"), "utf8")).toBe("broken database");
  });
});
