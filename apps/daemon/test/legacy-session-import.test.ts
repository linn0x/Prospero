import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLegacySessionFile, streamJsonValues } from "../src/legacy-session-import.js";
import { SessionDatabase } from "../src/session-database.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(text: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "prospero-import-test-")); dirs.push(dir);
  const source = path.join(dir, "legacy.json"), database = path.join(dir, "sessions.sqlite");
  writeFileSync(source, text); return { dir, source, database };
}
function state(id = "synthetic") {
  return { version: 1, id, agent: "codex", title: "合成", cwd: "/synthetic", createdAt: 1,
    approvalPolicy: "standard", events: [{ kind: "text.delta", msgId: "m", text: "中文 🧪 \\ \" \n" }], evSeq: 5,
    preview: "", previewRaw: "", previewMsgId: "", totals: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    toolOutputs: [["tool", "工具全文 🧪\n"]], truncatedToolOutputs: ["tool"], adapterState: {},
    messageQueue: [{ id: "queued", displayText: "队列", text: "完整请求", outgoingText: "完整请求",
      kind: "queue", createdAt: 2, attachmentCount: 1, attachments: [{ nested: { value: ["🧪", { escaped: "\\\"" }] } }] }],
  };
}
async function values(file: string, select: (p: readonly (string | number)[]) => boolean) {
  const result: unknown[] = []; for await (const e of streamJsonValues(file, select)) result.push(e); return result;
}
function read(database: string, id = "synthetic") {
  const db = new SessionDatabase(database);
  try { return db.readSession(id, { limit: 100, maxBytes: 1024 * 1024 }); } finally { db.close(); }
}
describe("legacy JSON streaming import boundaries", () => {
  it("preserves Unicode, escapes, complete tools, nested queues and retained sequence", async () => {
    const original = state(), f = fixture(JSON.stringify(original));
    expect(await migrateLegacySessionFile(f.source, f.database, { array: false })).toEqual({ migrated: true, sessionCount: 1, eventCount: 1 });
    const restored = read(f.database)!;
    expect(restored.events).toEqual(original.events); expect(restored.toolOutputs).toEqual(original.toolOutputs);
    expect(restored.messageQueue).toEqual(original.messageQueue); expect(restored.truncatedToolOutputs).toEqual(["tool"]);
    expect(restored.evSeq).toBe(5); expect(restored.historyPage?.oldestSeq).toBe(5); expect(restored.historySummary).toBeDefined();
    expect(readFileSync(f.source, "utf8")).toBe(JSON.stringify(original));
  });
  it("selects parents once while observing nested shapes", async () => {
    const f = fixture('{"sessions":[{"events":[{"kind":"x","nested":[1,{"text":"\\uD83E\\uDDEA"}]}]}]}');
    const shapes: string[] = [], entries: unknown[] = [];
    for await (const e of streamJsonValues(f.source, p => p.length >= 4, { onContainer: (p, kind) => shapes.push(`${p.join(".")}:${kind}`) })) entries.push(e);
    expect(entries).toEqual([{ path: ["sessions", 0, "events", 0], value: { kind: "x", nested: [1, { text: "🧪" }] } }]);
    expect(shapes).toContain("sessions:array"); expect(shapes).toContain("sessions.0.events.0.nested:array");
  });
  it("keeps prototype-looking keys as ordinary own data", async () => {
    const text = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}';
    const f = fixture(text), entries = await values(f.source, p => p.length === 0) as { value: object }[];
    expect(Object.hasOwn(entries[0]!.value, "__proto__")).toBe(true); expect(JSON.stringify(entries[0]!.value)).toBe(text);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("never reads legacy JSON when the target already exists", async () => {
    const f = fixture("not JSON"); writeFileSync(f.database, "authoritative target");
    const guard = vi.fn(() => { throw Error("must not run"); });
    expect((await migrateLegacySessionFile(f.source, f.database, { array: false, isSafeToPublish: guard })).migrated).toBe(false);
    expect(guard).not.toHaveBeenCalled(); expect(readFileSync(f.database, "utf8")).toBe("authoritative target");
  });
  it("imports central arrays, excludes tombstones and is idempotent", async () => {
    const f = fixture(JSON.stringify([state("deleted"), state("retained")]));
    expect(await migrateLegacySessionFile(f.source, f.database, { array: true, excludeSessionIds: new Set(["deleted"]) })).toEqual({ migrated: true, sessionCount: 1, eventCount: 1 });
    expect(read(f.database, "deleted")).toBeNull(); expect(read(f.database, "retained")?.id).toBe("retained");
    expect((await migrateLegacySessionFile(f.source, f.database, { array: true })).migrated).toBe(false);
  });
  it.each(["", "[", '{"a":"unterminated', '{"a":1} trailing', '{"a":1}{"b":2}', '{"a":[1,]}'])("rejects malformed or incomplete JSON %j", async text => {
    const f = fixture(text); await expect(values(f.source, p => p.length === 1)).rejects.toThrow();
  });
  it("does not publish a valid prefix before a truncated later session", async () => {
    const text = `[${JSON.stringify(state("first"))},{"id":"second","events":[`, f = fixture(text);
    await expect(migrateLegacySessionFile(f.source, f.database, { array: true })).rejects.toThrow();
    expect(existsSync(f.database)).toBe(false); expect(readdirSync(f.dir)).toEqual(["legacy.json"]); expect(readFileSync(f.source, "utf8")).toBe(text);
  });
  it.each([{ ...state(), version: 2 }, { ...state(), events: null }, { ...state(), toolOutputs: {} }, { ...state(), messageQueue: "bad" }, { ...state(), evSeq: 0 }])("rejects unsupported schema or collection shapes", async invalid => {
    const f = fixture(JSON.stringify(invalid)); await expect(migrateLegacySessionFile(f.source, f.database, { array: false })).rejects.toThrow();
    expect(existsSync(f.database)).toBe(false); expect(readdirSync(f.dir)).toEqual(["legacy.json"]);
  });
  it("checks owner safety before opening and again before publication", async () => {
    const f = fixture(JSON.stringify(state()));
    expect((await migrateLegacySessionFile(f.source, f.database, { array: false, isSafeToPublish: () => false })).migrated).toBe(false);
    expect(readdirSync(f.dir)).toEqual(["legacy.json"]); let checks = 0;
    expect((await migrateLegacySessionFile(f.source, f.database, { array: false, isSafeToPublish: () => ++checks === 1 })).migrated).toBe(false);
    expect(checks).toBe(2); expect(readdirSync(f.dir)).toEqual(["legacy.json"]);
  });
  it("does not overwrite a target published by a competing migration", async () => {
    const f = fixture(JSON.stringify(state())); let checks = 0;
    expect((await migrateLegacySessionFile(f.source, f.database, { array: false, isSafeToPublish: () => { if (++checks === 2) writeFileSync(f.database, "other winner"); return true; } })).migrated).toBe(false);
    expect(readFileSync(f.database, "utf8")).toBe("other winner"); expect(readdirSync(f.dir).sort()).toEqual(["legacy.json", "sessions.sqlite"]);
  });
});
