import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import { SessionDatabase, SessionDatabaseError } from "../src/session-database.js";
import { openPrivateSqlite, sqliteSupportsSafeWal } from "../src/private-sqlite.js";
import type { QueuedChatPersistent, StructuredSessionPersistentState } from "../src/structured-session.js";

const directories: string[] = [];
const connections: { close(): void }[] = [];
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "prospero-session-db-"));
  directories.push(directory);
  return { directory, file: path.join(directory, "sessions.sqlite") };
}
function database(file: string, readOnly = false): SessionDatabase {
  const db = new SessionDatabase(file, { readOnly }); connections.push(db); return db;
}
function raw(file: string): DatabaseSync {
  const db = new DatabaseSync(file); connections.push(db); return db;
}
function event(index: number, text = `synthetic event ${index}`): AgentEventBody {
  return { kind: "user.message", msgId: `m${index}`, text };
}
function queued(id: string, text = "queued fixture"): QueuedChatPersistent {
  return { id, displayText: text, outgoingText: text, kind: "queue", createdAt: 1, attachmentCount: 0, attachments: [] };
}
function state(overrides: Partial<StructuredSessionPersistentState> = {}): StructuredSessionPersistentState {
  return {
    version: 1, id: "session", agent: "codex", title: "Synthetic session", cwd: "/synthetic",
    createdAt: 1, approvalPolicy: "standard", events: [], evSeq: 0,
    preview: "", previewRaw: "", previewMsgId: "", totals: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    toolOutputs: [], adapterState: { threadId: "synthetic-thread" }, messageQueue: [], ...overrides,
  };
}
afterEach(() => {
  for (const db of connections.splice(0).reverse()) { try { db.close(); } catch { /* Already closed by test. */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SessionDatabase", () => {
  it("preserves durable history when later snapshots retain only a suffix", () => {
    const { file } = fixture(); const db = database(file);
    db.saveSession(state({ events: [event(1), event(2)], evSeq: 2 }));
    db.saveSession(state({ events: [event(3)], evSeq: 3 }));
    db.saveSession(state({ events: [], evSeq: 3, title: "Renamed" }));
    expect(db.readEventsPage("session").events.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(db.readSession("session")).toMatchObject({ title: "Renamed", evSeq: 3, adapterState: { threadId: "synthetic-thread" } });
  });

  it("does not reserialize old event bodies during incremental saves", () => {
    const { file } = fixture(); const db = database(file);
    db.saveSession(state({ events: [event(1)], evSeq: 1 }));
    const old = { ...event(1), toJSON() { throw new Error("old body must not be visited"); } };
    db.saveSession(state({ events: [old, event(2)], evSeq: 2 }));
    expect(db.readEventsPage("session").events.map((row) => row.body)).toEqual([event(1), event(2)]);
  });

  it("merges tool rows, replaces the ordered queue, and preserves resume metadata", () => {
    const { file } = fixture(); const db = database(file);
    db.saveSession(state({ toolOutputs: [["old", "old full output"]], messageQueue: [queued("a"), queued("b")] }));
    db.saveSession(state({ toolOutputs: [["new", "new full output"]], messageQueue: [queued("b"), queued("c")], adapterState: { threadId: "next-thread" } }));
    expect(db.toolOutput("session", "old")?.output).toBe("old full output");
    expect(db.readSession("session")).toMatchObject({
      toolOutputs: [["new", "new full output"], ["old", "old full output"]],
      messageQueue: [queued("b"), queued("c")], adapterState: { threadId: "next-thread" },
    });
    db.saveSession(state({ messageQueue: undefined }));
    expect(db.readSession("session")?.messageQueue).toHaveLength(2);
  });

  it("rolls back metadata, cursor, events, tools and queue together on a late failure", () => {
    const { file } = fixture(); const db = database(file);
    const initial = state({ events: [event(1)], evSeq: 1, toolOutputs: [["tool", "old"]], messageQueue: [queued("old")] });
    db.saveSession(initial);
    expect(() => db.saveSession(state({ title: "uncommitted", events: [event(2)], evSeq: 2,
      toolOutputs: [["tool", "uncommitted"]], messageQueue: [queued("duplicate"), queued("duplicate")] }))).toThrow(SessionDatabaseError);
    expect(db.readSession("session")).toMatchObject(initial);
    db.close();
    expect(database(file).readSession("session")).toMatchObject(initial);
  });

  it("rejects cursor rollback and gaps instead of silently losing new events", () => {
    const { file } = fixture(); const db = database(file);
    db.saveSession(state({ events: [event(1)], evSeq: 1 }));
    expect(() => db.saveSession(state())).toThrow(/backwards/);
    expect(() => db.saveSession(state({ events: [event(4)], evSeq: 4 }))).toThrow(/missing new events/);
    expect(db.readSession("session")?.evSeq).toBe(1);
  });

  it("pages in sequence order across SQL batches without reading total history", () => {
    const { file } = fixture(); const db = database(file);
    db.saveSession(state({ events: Array.from({ length: 701 }, (_, index) => event(index + 1)), evSeq: 701 }));
    const first = db.readEventsPage("session", { limit: 600, maxBytes: 100_000 });
    expect(first.events).toHaveLength(600); expect(first.oldestSeq).toBe(102); expect(first.hasMore).toBe(true);
    const older = db.readEventsPage("session", { beforeSeq: first.oldestSeq, limit: 600, maxBytes: 100_000 });
    expect(older.events).toHaveLength(101); expect(older.oldestSeq).toBe(1); expect(older.hasMore).toBe(false);
    expect(older.lastSeq).toBe(701);
    expect([...older.events, ...first.events].map((row) => row.seq)).toEqual(Array.from({ length: 701 }, (_, i) => i + 1));
  });

  it("uses byte budgets and explicitly reports a single oversized event", () => {
    const { file } = fixture(); const db = database(file);
    const giant = event(2, "x".repeat(20_000));
    db.saveSession(state({ events: [event(1), giant, event(3)], evSeq: 3 }));
    const latest = db.readEventsPage("session", { maxBytes: 1_000 });
    expect(latest.events.map((row) => row.seq)).toEqual([3]);
    expect(latest).toMatchObject({ hasMore: true, oversized: { seq: 2, bytes: Buffer.byteLength(JSON.stringify(giant)) } });
    const blocked = db.readEventsPage("session", { beforeSeq: 3, maxBytes: 1_000 });
    expect(blocked.events).toEqual([]); expect(blocked.oldestSeq).toBe(0); expect(blocked.oversized?.seq).toBe(2);
    const expanded = db.readEventsPage("session", { beforeSeq: 3, maxBytes: 30_000 });
    expect(expanded.events.map((row) => row.body)).toEqual([event(1), giant]);
  });

  it("does not materialize an oversized body even when that stored JSON is malformed", () => {
    const { file } = fixture(); const db = database(file);
    db.saveSession(state({ events: [event(1, "x".repeat(10_000))], evSeq: 1 }));
    raw(file).prepare("UPDATE session_events SET body=? WHERE session_id=?").run("INVALID_SYNTHETIC_JSON", "session");
    expect(db.readEventsPage("session", { maxBytes: 1_000 }).oversized?.seq).toBe(1);
    expect(() => db.readEventsPage("session", { maxBytes: 20_000 })).toThrow(/invalid JSON/);
  });

  it("reads a single tool under a UTF-8 byte limit while retaining the full durable value", () => {
    const { file } = fixture(); const db = database(file); db.saveSession(state());
    db.saveToolOutput("session", "工具'--", "中😀文XYZ");
    expect(db.toolOutput("session", "工具'--", { maxBytes: 5 })).toEqual({ output: "中", truncated: true });
    expect(db.toolOutput("session", "工具'--", { maxBytes: 100 })).toEqual({ output: "中😀文XYZ", truncated: false });
    db.saveToolOutput("session", "legacy", "already cut", true);
    expect(db.toolOutput("session", "legacy")?.truncated).toBe(true);
    expect(db.toolOutput("session", "missing")).toBeNull();
  });

  it("stores large tool output in bounded chunks and preserves characters across chunk boundaries", () => {
    const { file } = fixture(); const db = database(file); db.saveSession(state());
    const output = `${"a".repeat(16_383)}😀${"中".repeat(40_000)}`;
    db.saveToolOutput("session", "large", output);
    const inspection = raw(file);
    const stats = inspection.prepare("SELECT max(length(body)) AS maximum,count(*) AS chunks FROM session_tool_output_chunks").get();
    expect(Number(stats?.["maximum"])).toBeLessThanOrEqual(65_536); expect(Number(stats?.["chunks"])).toBeGreaterThan(2);
    expect(db.toolOutput("session", "large", { maxBytes: 16_385 })).toEqual({ output: "a".repeat(16_383), truncated: true });
    expect(db.toolOutput("session", "large", { maxBytes: 1_000_000 })).toEqual({ output, truncated: false });
    // Corruption beyond the requested prefix must not cause an eager full read.
    inspection.exec("DELETE FROM session_tool_output_chunks WHERE part>=2");
    expect(db.toolOutput("session", "large", { maxBytes: 1_000 })?.output).toHaveLength(1_000);
    expect(() => db.toolOutput("session", "large", { maxBytes: 1_000_000 })).toThrow(/tool chunk/);
  });

  it.each([
    ["ASCII", "x".repeat(200_001)],
    ["Chinese", "中".repeat(200_001)],
    ["emoji", "😀".repeat(100_001)],
    ["UTF-16 boundary", `${"x".repeat(199_999)}😀`],
  ])("preserves the public 200,000-character limit for %s tool output", (_name, output) => {
    const { file } = fixture(); const db = database(file); db.saveSession(state());
    db.saveToolOutput("session", "tool", output);
    expect(db.toolOutput("session", "tool")).toEqual({ output: output.slice(0, 200_000), truncated: true });
    expect(db.toolOutput("session", "tool", { maxBytes: 1_000_000 })).toEqual({ output, truncated: false });
  });

  it("does not truncate an exact default character limit or reinterpret explicit byte budgets", () => {
    const { file } = fixture(); const db = database(file); db.saveSession(state());
    const output = "中".repeat(200_000);
    db.saveToolOutput("session", "tool", output);
    expect(db.toolOutput("session", "tool")).toEqual({ output, truncated: false });
    expect(db.toolOutput("session", "tool", { maxBytes: 5 })).toEqual({ output: "中", truncated: true });
  });

  it("updates queue ordering and content without rewriting unchanged metadata checkpoints", () => {
    const { file } = fixture(); const db = database(file);
    db.saveSession(state({ messageQueue: [queued("a"), queued("b")] }));
    const connection = raw(file);
    const before = connection.prepare("PRAGMA data_version").get()?.["data_version"];
    db.saveSession(state({ messageQueue: [queued("a"), queued("b")] }));
    expect(connection.prepare("PRAGMA data_version").get()?.["data_version"]).toBe(before);
    db.saveSession(state({ messageQueue: [queued("b", "updated"), queued("a")] }));
    expect(db.readSession("session")?.messageQueue).toEqual([queued("b", "updated"), queued("a")]);
  });

  it("restores metadata without loading event or tool bodies", () => {
    const { file } = fixture(); const db = database(file);
    db.saveSession(state({ events: [event(1)], evSeq: 1, toolOutputs: [["huge", "x".repeat(2_000_000)]] }));
    raw(file).exec("UPDATE session_events SET body='malformed'");
    expect(db.readSession("session", { events: false, toolOutputs: false })).toMatchObject({ events: [], toolOutputs: [], evSeq: 1 });
  });

  it("fails explicitly for an oversized authoritative queue instead of returning partial state", () => {
    const { file } = fixture(); const db = database(file);
    db.saveSession(state({ messageQueue: [queued("a", "x".repeat(2_000))] }));
    expect(() => db.readSession("session", { maxBytes: 512 })).toThrow(/queue exceeds/);
    expect(db.readSession("session", { maxBytes: 10_000 })?.messageQueue?.[0]?.outgoingText).toHaveLength(2_000);
  });

  it("reads a bounded display-only queue without loading or exposing its full body", () => {
    const { file } = fixture(); const db = database(file);
    const item = { ...queued("a", `${"x".repeat(998)}😀${"中".repeat(700_000)}`),
      outgoingText: "SYNTHETIC_OUTGOING_ONLY", attachmentCount: 1,
      attachments: [{ id: "image", mimeType: "image/png" as const, path: "/synthetic/private/image" }] };
    db.saveSession(state({ messageQueue: [item] }));
    const summary = db.readQueueSummary("session");
    expect(summary).toEqual([{ id: "a", displayText: `${"x".repeat(998)}…`, kind: "queue", createdAt: 1, attachmentCount: 1 }]);
    expect(JSON.stringify(summary)).not.toContain("outgoingText");
    expect(JSON.stringify(summary)).not.toContain("private/image");
    expect(db.readSession("session", { maxBytes: 10_000_000 })?.messageQueue).toEqual([item]);
    // The display projection survives an unreadable full-body row because it
    // is separate indexed data; opening real queue state still fails closed.
    raw(file).exec("UPDATE session_message_queue SET body='INVALID_SYNTHETIC_JSON'");
    expect(db.readQueueSummary("session")).toEqual(summary);
    expect(() => db.readSession("session", { maxBytes: 10_000_000 })).toThrow(/invalid JSON/);
    db.close();
    expect(database(file, true).readQueueSummary("session")).toEqual(summary);
  });

  it("updates imported queue summaries in the same transaction and preserves display order", () => {
    const { file } = fixture(); const db = database(file); const token = db.beginSessionImport();
    db.appendSessionImportQueueEntry(token, queued("one", "a".repeat(2_000)));
    db.appendSessionImportQueueEntry(token, queued("two", "short"));
    db.finishSessionImport(token, state());
    expect(db.readQueueSummary("session").map((item) => [item.id, item.displayText.length])).toEqual([["one", 1000], ["two", 5]]);
    expect(() => db.saveSession(state({ messageQueue: [queued("duplicate"), queued("duplicate")] }))).toThrow();
    expect(db.readQueueSummary("session").map((item) => item.id)).toEqual(["one", "two"]);
    db.saveSession(state({ messageQueue: [queued("two", "updated"), queued("one", "last")] }));
    expect(db.readQueueSummary("session").map((item) => [item.id, item.displayText])).toEqual([["two", "updated"], ["one", "last"]]);
  });

  it("shows only committed changes to a live read-only connection and can reopen a closed archive", () => {
    const { file } = fixture(); const writer = database(file); writer.saveSession(state());
    const reader = database(file, true);
    const token = writer.beginSessionImport(); writer.appendSessionImportEvent(token, event(1));
    expect(reader.listSessionIds()).toEqual(["session"]);
    writer.finishSessionImport(token, state({ id: "imported", evSeq: 1 }));
    expect(reader.readSession("imported")?.events).toEqual([event(1)]);
    expect(() => reader.saveSession(state())).toThrow(/read-only/);
    reader.close(); writer.close();
    expect(database(file, true).listSessionIds()).toEqual(["imported", "session"]);
  });

  it("imports a retained suffix, late truncation flags, queue and metadata atomically", () => {
    const { file } = fixture(); const db = database(file); const token = db.beginSessionImport();
    db.appendSessionImportEvent(token, event(11)); db.appendSessionImportEvent(token, event(12));
    db.setSessionImportToolOutput(token, "tool", "legacy output"); db.appendSessionImportQueueEntry(token, queued("q"));
    db.finishSessionImport(token, state({ evSeq: 12, truncatedToolOutputs: ["tool"], terminal: true }));
    expect(db.readEventsPage("session").events.map((entry) => entry.seq)).toEqual([11, 12]);
    expect(db.readSession("session")).toMatchObject({ terminal: true, messageQueue: [queued("q")], truncatedToolOutputs: ["tool"] });
  });
  it("binds identity before bulk writes and asynchronously preserves retained cursor and all collections", async () => {
    const { file } = fixture(); const db = database(file); const token = db.beginSessionImport();
    db.identifySessionImport(token, "early-identity");
    for (let index = 1; index <= 2000; index++) db.appendSessionImportEvent(token, event(index));
    db.setSessionImportToolOutput(token, "tool", "complete tool output 🧪");
    db.appendSessionImportQueueEntry(token, queued("q"));
    await db.finishSessionImportAsync(token, state({ id: "early-identity", evSeq: 3000, truncatedToolOutputs: ["tool"] }));
    const stored = db.readSession("early-identity", { limit: 3000, maxBytes: Number.MAX_SAFE_INTEGER });
    expect(stored?.events).toHaveLength(2000);
    expect(stored?.historyPage?.oldestSeq).toBe(1001);
    expect(stored?.messageQueue).toEqual([queued("q")]);
    expect(stored?.toolOutputs).toEqual([["tool", "complete tool output 🧪"]]);
    expect(stored?.truncatedToolOutputs).toEqual(["tool"]);
    expect(db.listSessionIds()).toEqual(["early-identity"]);
  });

  it("rolls back invalid imports and close rolls back an unfinished import", () => {
    const { file } = fixture(); const db = database(file); db.saveSession(state());
    let token = db.beginSessionImport(); db.appendSessionImportEvent(token, event(1));
    expect(() => db.finishSessionImport(token, state({ id: "invalid", evSeq: 0 }))).toThrow(/cursor/);
    expect(db.listSessionIds()).toEqual(["session"]);
    token = db.beginSessionImport(); db.appendSessionImportEvent(token, event(1)); db.close();
    expect(database(file).listSessionIds()).toEqual(["session"]);
  });

  it("keeps ids parameterized and deletion cascades to all row collections", () => {
    const { file } = fixture(); const db = database(file); const id = "session'); DROP TABLE sessions; --";
    db.saveSession(state({ id, events: [event(1)], evSeq: 1, toolOutputs: [["call", "output"]], messageQueue: [queued("q")] }));
    expect(db.hasSession(id)).toBe(true); db.deleteSession(id); expect(db.hasSession(id)).toBe(false);
    for (const table of ["session_events", "session_tool_outputs", "session_tool_output_chunks", "session_message_queue"]) {
      expect(raw(file).prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]).toBe(0);
    }
    expect(db.readSession(id)).toBeNull();
  });

  it("rejects corrupt headers, unknown versions and unknown schema without initializing empty history", () => {
    let { file } = fixture(); writeFileSync(file, "SYNTHETIC_INVALID_DATABASE", { mode: 0o600 });
    expect(() => database(file)).toThrow(); expect(readFileSync(file, "utf8")).toBe("SYNTHETIC_INVALID_DATABASE");
    ({ file } = fixture()); const db = database(file); db.saveSession(state()); db.close();
    const writer = raw(file); writer.exec("PRAGMA user_version=999"); writer.close();
    expect(() => database(file)).toThrow(/version/);
    ({ file } = fixture()); const unknown = raw(file); unknown.exec("CREATE TABLE unknown(value TEXT)"); unknown.close(); chmodSync(file, 0o600);
    expect(() => database(file)).toThrow(/format or version/);
  });

  it("does not expose stored JSON fragments in errors", () => {
    const { file } = fixture(); const db = database(file); db.saveSession(state());
    raw(file).prepare("UPDATE sessions SET metadata=?").run("NOT_JSON_SYNTHETIC_SENSITIVE_FRAGMENT");
    try { db.readSession("session"); throw new Error("expected failure"); }
    catch (error) { expect(String(error)).toContain("invalid JSON"); expect(String(error)).not.toContain("SENSITIVE_FRAGMENT"); }
  });
});

describe("private SQLite boundary", () => {
  it("uses bounded caches and a supported durable journal", () => {
    const { file, directory } = fixture(); const db = openPrivateSqlite(file); connections.push(db);
    db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('synthetic')");
    expect(db.prepare("PRAGMA cache_size").get()?.["cache_size"]).toBe(-2048);
    expect(db.prepare("PRAGMA mmap_size").get()?.["mmap_size"]).toBe(0);
    expect(db.prepare("PRAGMA synchronous").get()?.["synchronous"]).toBe(2);
    const version = String(db.prepare("SELECT sqlite_version() AS v").get()?.["v"]);
    expect(db.prepare("PRAGMA journal_mode").get()?.["journal_mode"]).toBe(sqliteSupportsSafeWal(version) ? "wal" : "delete");
    if (process.platform !== "win32") {
      expect(lstatSync(directory).mode & 0o777).toBe(0o700);
      for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) expect(lstatSync(file + suffix).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    ["3.44.5", false], ["3.44.6", true], ["3.45.9", false], ["3.49.9", false], ["3.50.6", false],
    ["3.50.7", true], ["3.51.2", false], ["3.51.3", true], ["3.53.0", true], ["invalid", false],
  ])("allows WAL only on fixed SQLite %s: %s", (version, expected) => {
    expect(sqliteSupportsSafeWal(version)).toBe(expected);
  });

  it("read-only open never creates a missing database or its directory", () => {
    const { directory } = fixture(); const target = path.join(directory, "absent", "session.sqlite");
    expect(() => openPrivateSqlite(target, { readOnly: true })).toThrow();
    expect(existsSync(path.dirname(target))).toBe(false);
    expect(() => openPrivateSqlite(path.join(directory, "missing.sqlite"), { readOnly: true })).toThrow();
    expect(existsSync(path.join(directory, "missing.sqlite"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects database, sidecar and ancestor symlinks", () => {
    const { file, directory } = fixture(); const target = path.join(directory, "target"); writeFileSync(target, "untouched", { mode: 0o600 });
    symlinkSync(target, file); expect(() => openPrivateSqlite(file)).toThrow(/Unsafe/); expect(readFileSync(target, "utf8")).toBe("untouched");
    rmSync(file); const db = database(file); db.close(); symlinkSync(target, `${file}-wal`);
    expect(() => openPrivateSqlite(file)).toThrow(/Unsafe/); rmSync(`${file}-wal`);
    mkdirSync(path.join(directory, "real")); symlinkSync(path.join(directory, "real"), path.join(directory, "alias"));
    expect(() => openPrivateSqlite(path.join(directory, "alias", "nested", "db.sqlite"))).toThrow(/Unsafe/);
  });
});
