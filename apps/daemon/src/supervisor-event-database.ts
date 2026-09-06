/** Durable supervisor replay. Runtime objects retain cursors, never the full journal. */
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, linkSync, lstatSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import type { AgentEventBody } from "@prospero/protocol";
import { openPrivateSqlite } from "./private-sqlite.js";
import { streamJsonValues } from "./legacy-session-import.js";

const APPLICATION_ID = 0x50535250;
const VERSION = 1;
export const SUPERVISOR_REPLAY_LIMIT = 4_000;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

export interface ReplaySession {
  id: string;
  status: "created" | "running" | "killed" | "failed";
  oldestSeq: number;
  lastSeq: number;
}

export interface ReplayEvent {
  sessionId: string;
  seq: number;
  at: number;
  body: AgentEventBody;
}

export function isReplayEvent(value: unknown): value is ReplayEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<ReplayEvent>;
  return typeof event.sessionId === "string" && SESSION_ID.test(event.sessionId)
    && Number.isSafeInteger(event.seq) && Number(event.seq) > 0
    && typeof event.at === "number" && Number.isFinite(event.at)
    && !!event.body && typeof event.body === "object" && !Array.isArray(event.body);
}

function validSession(value: Partial<ReplaySession>): value is ReplaySession {
  return typeof value.id === "string" && SESSION_ID.test(value.id)
    && ["created", "running", "killed", "failed"].includes(value.status ?? "")
    && Number.isSafeInteger(value.oldestSeq) && Number(value.oldestSeq) >= 0
    && Number.isSafeInteger(value.lastSeq) && Number(value.lastSeq) >= Number(value.oldestSeq);
}

export class SupervisorEventDatabase {
  private readonly db: DatabaseSync;

  constructor(file: string, options: { readOnly?: boolean } = {}) {
    const db = openPrivateSqlite(file, options);
    this.db = db;
    try {
      const applicationId = Number(db.prepare("PRAGMA application_id").get()!["application_id"]);
      const version = Number(db.prepare("PRAGMA user_version").get()!["user_version"]);
      if (applicationId === 0 && version === 0 && !options.readOnly
        && Number(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()!["n"]) === 0) {
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE replay_sessions (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('created','running','killed','failed')),
            oldest_seq INTEGER NOT NULL CHECK (oldest_seq >= 0),
            last_seq INTEGER NOT NULL CHECK (last_seq >= oldest_seq)
          ) STRICT;
          CREATE TABLE replay_events (
            session_id TEXT NOT NULL REFERENCES replay_sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
            seq INTEGER NOT NULL CHECK (seq > 0),
            at REAL NOT NULL,
            body TEXT NOT NULL,
            byte_length INTEGER NOT NULL,
            PRIMARY KEY (session_id, seq)
          ) STRICT;
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = ${VERSION};
          COMMIT;`);
      } else if (applicationId !== APPLICATION_ID || version !== VERSION) {
        throw new Error("supervisor SQLite schema is incompatible; original data retained");
      }
    } catch (error) {
      db.close();
      throw error;
    }
  }

  sessions(): ReplaySession[] {
    return this.db.prepare("SELECT id, status, oldest_seq AS oldestSeq, last_seq AS lastSeq FROM replay_sessions ORDER BY id")
      .all() as unknown as ReplaySession[];
  }

  saveSession(session: ReplaySession): void {
    if (!validSession(session)) throw new Error("invalid supervisor replay metadata");
    this.db.prepare(`INSERT INTO replay_sessions VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, oldest_seq=excluded.oldest_seq, last_seq=excluded.last_seq`)
      .run(session.id, session.status, session.oldestSeq, session.lastSeq);
  }

  append(event: ReplayEvent, session: ReplaySession): void {
    if (!isReplayEvent(event) || event.sessionId !== session.id) throw new Error("invalid supervisor event");
    const body = JSON.stringify(event.body);
    this.transaction(() => {
      const current = this.db.prepare("SELECT status, last_seq FROM replay_sessions WHERE id=?").get(event.sessionId);
      if (!current || current["status"] === "killed" || Number(current["last_seq"]) + 1 !== event.seq) {
        throw new Error("supervisor event violates durable cursor or kill fence");
      }
      this.db.prepare("INSERT INTO replay_events VALUES (?, ?, ?, ?, ?)")
        .run(event.sessionId, event.seq, event.at, body, Buffer.byteLength(body));
      this.saveSession({ ...session, lastSeq: event.seq, oldestSeq: Math.max(session.oldestSeq, event.seq - SUPERVISOR_REPLAY_LIMIT) });
    });
  }

  /** Compatibility replay is capped by event count, exactly as protocol v1. */
  replay(session: ReplaySession, afterSeq: number): ReplayEvent[] {
    const floor = Math.max(afterSeq, session.oldestSeq, session.lastSeq - SUPERVISOR_REPLAY_LIMIT);
    const events: ReplayEvent[] = [];
    for (const row of this.db.prepare(`SELECT seq, at, body FROM replay_events
      WHERE session_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`)
      .iterate(session.id, floor, session.lastSeq, SUPERVISOR_REPLAY_LIMIT)) {
      events.push({ sessionId: session.id, seq: Number(row["seq"]), at: Number(row["at"]), body: JSON.parse(String(row["body"])) as AgentEventBody });
    }
    return events;
  }

  /** Used only by the unpublished import database; no adapter is running yet. */
  importEvent(event: ReplayEvent, sessionId = event.sessionId): void {
    const body = JSON.stringify(event.body);
    this.db.prepare("INSERT OR IGNORE INTO replay_events VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, event.seq, event.at, body, Buffer.byteLength(body));
  }

  renameImportedSession(from: string, session: ReplaySession): void {
    this.db.prepare("UPDATE replay_sessions SET id=?,status=?,oldest_seq=?,last_seq=? WHERE id=?")
      .run(session.id, session.status, session.oldestSeq, session.lastSeq, from);
  }

  countEvents(sessionId: string): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM replay_events WHERE session_id=?").get(sessionId)!["n"]);
  }

  validateImportedSessions(): void {
    for (const session of this.sessions()) {
      const bounds = this.db.prepare("SELECT count(*) AS n,min(seq) AS first,max(seq) AS last FROM replay_events WHERE session_id=?").get(session.id)!;
      const count = Number(bounds["n"]);
      if (count > 0 && (Number(bounds["last"]) !== session.lastSeq || count !== session.lastSeq - Number(bounds["first"]) + 1)) {
        throw new Error("supervisor legacy replay has inconsistent event sequences");
      }
      // Missing old history must force a snapshot, not masquerade as exact replay.
      this.saveSession({ ...session, oldestSeq: Math.max(session.oldestSeq,
        count ? Number(bounds["first"]) - 1 : session.lastSeq, session.lastSeq - SUPERVISOR_REPLAY_LIMIT) });
    }
  }

  private transaction(operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { operation(); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** A staged import has no readers; publish a self-contained database file. */
  finishImport(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    const result = this.db.prepare("PRAGMA quick_check").get();
    if (result?.["quick_check"] !== "ok") throw new Error("supervisor SQLite import integrity check failed");
  }

  close(): void { this.db.close(); }
}

/** Only invoked after the old endpoint has been proved inactive. Never changes legacy files. */
export async function migrateSupervisorReplay(home: string): Promise<void> {
  const file = `${home}/supervisor.sqlite`;
  if (existsSync(file)) return;
  const stateFile = `${home}/state.json`;
  if (!existsSync(stateFile)) return;
  for (const legacy of [stateFile, `${home}/events.jsonl`]) {
    if (!existsSync(legacy)) continue;
    const metadata = lstatSync(legacy);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("unsafe supervisor legacy file");
  }
  const temporary = `${file}.import-${process.pid}-${randomBytes(6).toString("hex")}`;
  const database = new SupervisorEventDatabase(temporary);
  let closed = false;
  try {
    let version: unknown;
    let sawSessions = false;
    const sessions = new Map<number, Partial<ReplaySession>>();
    const owners = new Map<number, Set<string>>();
    const ensure = (index: number): Partial<ReplaySession> => {
      let session = sessions.get(index);
      if (!session) {
        session = {};
        sessions.set(index, session);
        database.saveSession({ id: `import-${index}`, status: "created", oldestSeq: 0, lastSeq: 0 });
      }
      return session;
    };
    const observeShape = (parts: readonly (string | number)[], kind: string): void => {
      if (parts.length === 0 && kind !== "object") throw new Error("invalid supervisor snapshot root");
      if (parts.length === 1 && parts[0] === "sessions") {
        if (sawSessions || kind !== "array") throw new Error("invalid supervisor sessions array");
        sawSessions = true;
      }
      if (parts.length === 2 && parts[0] === "sessions") {
        if (kind !== "object") throw new Error("invalid supervisor legacy session");
        ensure(Number(parts[1]));
      }
      if (parts.length === 3 && parts[0] === "sessions" && parts[2] === "events" && kind !== "array") {
        throw new Error("invalid supervisor events array");
      }
    };
    for await (const item of streamJsonValues(stateFile, (parts) =>
      parts.length === 1 && parts[0] === "version"
      || parts.length === 3 && parts[0] === "sessions" && typeof parts[1] === "number" && parts[2] !== "events"
      || parts.length === 4 && parts[0] === "sessions" && typeof parts[1] === "number" && parts[2] === "events" && typeof parts[3] === "number", { onContainer: observeShape, onValue: observeShape })) {
      if (item.path[0] === "version") { version = item.value; continue; }
      const index = Number(item.path[1]);
      const session = ensure(index);
      if (item.path[2] === "events") {
        if (!isReplayEvent(item.value)) throw new Error("invalid supervisor legacy event");
        const ids = owners.get(index) ?? new Set<string>();
        ids.add(item.value.sessionId); owners.set(index, ids);
        database.importEvent(item.value, `import-${index}`);
      } else if (["id", "status", "oldestSeq", "lastSeq"].includes(String(item.path[2]))) {
        Object.defineProperty(session, String(item.path[2]), { value: item.value, enumerable: true, configurable: true, writable: true });
      }
    }
    if (!sawSessions || version !== 1) throw new Error("unsupported supervisor legacy version");
    for (const [index, session] of sessions) {
      if (!validSession(session) || [...(owners.get(index) ?? [])].some((id) => id !== session.id)) {
        throw new Error("invalid supervisor legacy session metadata");
      }
      database.renameImportedSession(`import-${index}`, session);
    }
    const imported = new Map(database.sessions().map((session) => [session.id, session]));
    const journal = `${home}/events.jsonl`;
    if (existsSync(journal)) {
      const input = createReadStream(journal, { encoding: "utf8", highWaterMark: 64 * 1024 });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          let event: unknown;
          try { event = JSON.parse(line); } catch { continue; } // Interrupted legacy tail, as before.
          if (!isReplayEvent(event)) continue;
          const session = imported.get(event.sessionId);
          if (!session) continue;
          if (event.seq <= session.lastSeq) { database.importEvent(event); continue; }
          if (session.status === "killed" || event.seq !== session.lastSeq + 1) continue;
          database.append(event, session);
          session.lastSeq = event.seq;
          session.oldestSeq = Math.max(session.oldestSeq, event.seq - SUPERVISOR_REPLAY_LIMIT);
        }
      } finally { lines.close(); input.destroy(); }
    }
    database.validateImportedSessions();
    database.finishImport();
    database.close(); closed = true;
    // Hard-link publication refuses to overwrite a concurrent importer/owner.
    try { linkSync(temporary, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    if (!closed) database.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${temporary}${suffix}`, { force: true });
  }
}
