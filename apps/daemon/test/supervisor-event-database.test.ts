import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSupervisorReplay, SupervisorEventDatabase, type ReplayEvent, type ReplaySession } from "../src/supervisor-event-database.js";

const homes: string[] = [];
function home(): string { const directory = mkdtempSync(path.join(tmpdir(), "prospero-replay-sqlite-")); homes.push(directory); return directory; }
function event(seq: number, sessionId = "session"): ReplayEvent {
  return { sessionId, seq, at: seq, body: { kind: "text.delta", msgId: "m", textId: "t", delta: `中文 😀 ${seq}` } };
}
function session(lastSeq = 0): ReplaySession { return { id: "session", status: "running", oldestSeq: 0, lastSeq }; }
function legacy(directory: string, value: unknown, journal = ""): void {
  writeFileSync(path.join(directory, "state.json"), JSON.stringify(value), { mode: 0o600 });
  writeFileSync(path.join(directory, "events.jsonl"), journal, { mode: 0o600 });
}
afterEach(() => { for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("SQLite supervisor replay", () => {
  it("commits event and cursor together and rejects duplicate, gap, and killed writes", () => {
    const directory = home(); const file = path.join(directory, "supervisor.sqlite");
    const database = new SupervisorEventDatabase(file);
    try {
      database.saveSession(session()); database.append(event(1), session());
      expect(() => database.append(event(3), session(1))).toThrow("cursor");
      expect(() => database.append(event(1), session(1))).toThrow("cursor");
      expect(database.sessions()).toEqual([session(1)]);
      database.saveSession({ ...session(1), status: "killed" });
      expect(() => database.append(event(2), session(1))).toThrow("fence");
      expect(database.countEvents("session")).toBe(1);
    } finally { database.close(); }
    const reopened = new SupervisorEventDatabase(file, { readOnly: true });
    try {
      expect(reopened.sessions()[0]?.status).toBe("killed");
      expect(reopened.replay(session(1), 0)).toEqual([event(1)]);
    } finally { reopened.close(); }
  });

  it("migrates a snapshot and contiguous journal tail while preserving legacy bytes and kill fences", async () => {
    const directory = home();
    legacy(directory, { version: 1, sessions: [
      { ...session(2), events: [event(1), event(2)] },
      { id: "killed", status: "killed", oldestSeq: 0, lastSeq: 1, events: [event(1, "killed")] },
    ] }, [event(1), event(2), event(3), event(2, "killed")].map((item) => JSON.stringify(item)).join("\n") + '\n{"incomplete":');
    const originals = ["state.json", "events.jsonl"].map((name) => readFileSync(path.join(directory, name)));
    await migrateSupervisorReplay(directory);
    const database = new SupervisorEventDatabase(path.join(directory, "supervisor.sqlite"), { readOnly: true });
    try {
      expect(database.sessions()).toEqual([
        { id: "killed", status: "killed", oldestSeq: 0, lastSeq: 1 }, session(3),
      ]);
      expect(database.replay(session(3), 0)).toEqual([event(1), event(2), event(3)]);
      expect(database.countEvents("killed")).toBe(1);
    } finally { database.close(); }
    expect(["state.json", "events.jsonl"].map((name) => readFileSync(path.join(directory, name)))).toEqual(originals);
    expect(readdirSync(directory).some((name) => name.includes(".import-"))).toBe(false);
    // Once published, old JSON can never replace a newer authoritative cursor.
    legacy(directory, { version: 1, sessions: [] });
    await migrateSupervisorReplay(directory);
    const again = new SupervisorEventDatabase(path.join(directory, "supervisor.sqlite"), { readOnly: true });
    try { expect(again.sessions().find((item) => item.id === "session")?.lastSeq).toBe(3); }
    finally { again.close(); }
  });

  it("recovers journal records omitted by an old metadata-only snapshot", async () => {
    const directory = home();
    legacy(directory, { version: 1, sessions: [{ ...session(2), events: [] }] },
      [event(1), event(2), event(4), event(3)].map((item) => JSON.stringify(item)).join("\n"));
    await migrateSupervisorReplay(directory);
    const database = new SupervisorEventDatabase(path.join(directory, "supervisor.sqlite"), { readOnly: true });
    try {
      expect(database.sessions()).toEqual([session(3)]);
      expect(database.replay(session(3), 0)).toEqual([event(1), event(2), event(3)]);
    } finally { database.close(); }
  });

  it.each([
    '{"version":1,"sessions":[',
    JSON.stringify({ version: 2, sessions: [] }),
    JSON.stringify({ version: 1, sessions: "invalid" }),
    JSON.stringify({ version: 1, sessions: [{ ...session(1), events: [event(1, "other")] }] }),
  ])("retains invalid legacy input without publishing a database", async (source) => {
    const directory = home(); const file = path.join(directory, "state.json");
    writeFileSync(file, source, { mode: 0o600 });
    await expect(migrateSupervisorReplay(directory)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(source);
    expect(existsSync(path.join(directory, "supervisor.sqlite"))).toBe(false);
    expect(readdirSync(directory)).toEqual(["state.json"]);
  });

  it("rejects a future database schema instead of importing stale JSON over it", async () => {
    const directory = home(); const file = path.join(directory, "supervisor.sqlite");
    const initial = new SupervisorEventDatabase(file); initial.close();
    const raw = new DatabaseSync(file); raw.exec("PRAGMA user_version=99"); raw.close();
    legacy(directory, { version: 1, sessions: [{ ...session(), events: [] }] });
    await migrateSupervisorReplay(directory);
    expect(() => new SupervisorEventDatabase(file)).toThrow("incompatible");
    const verify = new DatabaseSync(file, { readOnly: true });
    try { expect(verify.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(99); }
    finally { verify.close(); }
  });
});
