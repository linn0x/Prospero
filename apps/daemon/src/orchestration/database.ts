import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync, renameSync, rmSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { openPrivateSqlite } from "../private-sqlite.js";
import { streamJsonValues } from "../legacy-session-import.js";

export const orchestrationCollections = ["runs", "tasks", "dispatches", "messages", "gates", "operations", "worktreeAssets"] as const;
type Collection = typeof orchestrationCollections[number];
type Row = Record<string, unknown>;
type State = Record<string, unknown>;
const APPLICATION_ID = 0x504f5243;

function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
  return value;
}

export class OrchestrationDatabase {
  readonly db: DatabaseSync;
  private previous = new Map<string, Row>();
  private revision = 0;

  constructor(readonly file: string) {
    this.db = openPrivateSqlite(file);
    try {
      const application = this.db.prepare("PRAGMA application_id").get()!["application_id"];
      const version = this.db.prepare("PRAGMA user_version").get()!["user_version"];
      if (application === 0 && version === 0 && !this.db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get()) {
        this.db.exec("BEGIN IMMEDIATE; CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");
        for (const table of orchestrationCollections) this.db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, run_id TEXT, data TEXT NOT NULL CHECK(json_valid(data))) STRICT; CREATE INDEX ${table}_run ON ${table}(run_id);`);
        this.db.exec(`CREATE TABLE task_dependencies(task_id TEXT NOT NULL, dependency_id TEXT NOT NULL, PRIMARY KEY(task_id,dependency_id)) STRICT;
          CREATE INDEX dependencies_reverse ON task_dependencies(dependency_id);
          CREATE TABLE task_lineage(task_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL) STRICT;
          CREATE INDEX lineage_parent ON task_lineage(parent_id);
          CREATE TABLE events(seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
          CREATE INDEX events_run ON events(run_id,seq);
          CREATE TABLE desktop_projection(entity TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(entity,id)) STRICT;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1; COMMIT;`);
      } else if (application !== APPLICATION_ID || version !== 1) throw new Error("Unsupported orchestration database");
      this.revision = Number(this.meta("storageRevision") ?? 0);
    } catch (error) { this.db.close(); throw error; }
  }

  meta(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }

  setMeta(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  }

  insert(table: Collection, id: string, value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as Row).id !== id) throw new Error(`Invalid orchestration record in ${table}`);
    const row = value as Row;
    this.db.prepare(`INSERT INTO ${table}(id,run_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,data=excluded.data`).run(id, typeof row.runId === "string" ? row.runId : null, JSON.stringify(row));
    if (table === "tasks") {
      this.db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(id);
      if (!Array.isArray(row.deps) || row.deps.some(dep => typeof dep !== "string")) throw new Error("Invalid task dependencies");
      const statement = this.db.prepare("INSERT OR IGNORE INTO task_dependencies VALUES(?,?)");
      for (const dep of row.deps as string[]) statement.run(id, dep);
      this.db.prepare("DELETE FROM task_lineage WHERE task_id=?").run(id);
      if (typeof row.parentId === "string") this.db.prepare("INSERT INTO task_lineage VALUES(?,?)").run(id, row.parentId);
    }
  }

  load(): State {
    const state: State = { version: this.meta("version") ?? 2, eventSeq: this.meta("eventSeq") ?? 0, eventBaseSeq: this.meta("eventBaseSeq") ?? 0 };
    for (const table of orchestrationCollections) {
      const rows: Record<string, Row> = {};
      for (const row of this.db.prepare(`SELECT id,data FROM ${table}`).iterate()) {
        const value = JSON.parse(String(row.data)) as Row;
        Object.defineProperty(rows, String(row.id), { value, enumerable: true, configurable: true, writable: true });
        this.previous.set(`${table}:${String(row.id)}`, copy(value));
      }
      state[table] = rows;
    }
    state.events = this.db.prepare("SELECT data FROM events ORDER BY seq").all().map(row => JSON.parse(String(row.data)));
    if (!this.db.prepare("SELECT 1 FROM desktop_projection LIMIT 1").get()) this.previous.clear();
    return state;
  }

  save(state: State, projection: (table: Collection, row: Row) => Row | undefined): void {
    const next = new Map<string, Row>();
    const changed: Array<[Collection, string, Row]> = [];
    for (const table of orchestrationCollections) for (const [id, row] of Object.entries(state[table] as Record<string, Row>)) {
      const key = `${table}:${id}`;
      const previous = this.previous.get(key);
      if (!previous || !isDeepStrictEqual(previous, row)) { changed.push([table, id, row]); next.set(key, copy(row)); }
      else next.set(key, previous);
    }
    if (changed.length === 0 && next.size === this.previous.size && this.meta("storageRevision") !== undefined && this.meta("version") === state.version && this.meta("eventSeq") === state.eventSeq && this.meta("eventBaseSeq") === state.eventBaseSeq) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (Number(this.meta("storageRevision") ?? 0) !== this.revision) throw new Error("Orchestration database changed in another writer; restart before writing");
      for (const [table, id, row] of changed) {
        this.insert(table, id, row);
        const view = projection(table, row);
        if (view) this.db.prepare("INSERT INTO desktop_projection VALUES(?,?,?) ON CONFLICT(entity,id) DO UPDATE SET data=excluded.data").run(table, id, JSON.stringify(view));
      }
      for (const key of this.previous.keys()) if (!next.has(key)) {
        const colon = key.indexOf(":");
        const table = key.slice(0, colon) as Collection, id = key.slice(colon + 1);
        this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
        this.db.prepare("DELETE FROM desktop_projection WHERE entity=? AND id=?").run(table, id);
        if (table === "tasks") {
          this.db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(id);
          this.db.prepare("DELETE FROM task_lineage WHERE task_id=?").run(id);
        }
      }
      this.db.exec("DELETE FROM events");
      for (const event of (state.events ?? []) as Row[]) this.db.prepare("INSERT INTO events VALUES(?,?,?)").run(Number(event.seq), String(event.runId), JSON.stringify(event));
      for (const key of ["version", "eventSeq", "eventBaseSeq"]) this.setMeta(key, state[key]);
      this.setMeta("storageRevision", this.revision + 1);
      this.db.exec("COMMIT");
      this.revision++;
      this.previous = next;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  check(): Record<string, number> {
    if (this.db.prepare("PRAGMA integrity_check").get()!["integrity_check"] !== "ok") throw new Error("Orchestration database integrity check failed");
    return Object.fromEntries(orchestrationCollections.map(table => [table, Number(this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)]));
  }

  close(): void { this.db.close(); }
}

async function importOrchestration(home: string): Promise<void> {
  const target = path.join(home, "orchestration.sqlite");
  if (existsSync(target)) return;
  const source = path.join(home, "orchestration.json");
  if (!existsSync(source)) return;
  const before = statSync(source, { bigint: true });
  const temporary = `${target}.import-${randomUUID()}`;
  const database = new OrchestrationDatabase(temporary);
  const counts: Record<string, number> = Object.fromEntries(orchestrationCollections.map(table => [table, 0]));
  const hashes = new Map(orchestrationCollections.map(table => [table, createHash("sha256")]));
  let closed = false;
  try {
    database.db.exec("BEGIN IMMEDIATE");
    for await (const entry of streamJsonValues(source, keys => keys.length === 1 && ["version", "eventSeq", "eventBaseSeq"].includes(String(keys[0])) || keys.length === 2 && [...orchestrationCollections, "events"].includes(String(keys[0])))) {
      const collection = String(entry.path[0]);
      if (entry.path.length === 1) database.setMeta(collection, entry.value);
      else if (collection === "events") {
        const event = entry.value as Row;
        database.db.prepare("INSERT INTO events VALUES(?,?,?)").run(Number(event.seq), String(event.runId), JSON.stringify(event));
      } else {
        const table = collection as Collection, id = String(entry.path[1]);
        database.insert(table, id, entry.value);
        counts[table]!++;
        hashes.get(table)!.update(JSON.stringify([id, entry.value]));
      }
    }
    if (![1, 2].includes(Number(database.meta("version")))) throw new Error("Unsupported legacy orchestration version");
    const after = statSync(source, { bigint: true });
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw new Error("Legacy orchestration changed during import; stop the old daemon and retry");
    for (const table of orchestrationCollections) {
      const actual = createHash("sha256");
      for (const row of database.db.prepare(`SELECT id,data FROM ${table} ORDER BY rowid`).iterate()) actual.update(JSON.stringify([row.id, JSON.parse(String(row.data))]));
      if (actual.digest("hex") !== hashes.get(table)!.digest("hex")) throw new Error(`Migration verification failed for ${table}`);
    }
    database.setMeta("migration", { source: "orchestration.json", bytes: Number(before.size), importedAt: Date.now(), counts });
    database.db.exec("COMMIT");
    if (!isDeepStrictEqual(database.check(), counts)) throw new Error("Migration counts differ");
    database.close(); closed = true;
    if (existsSync(target)) throw new Error("Orchestration database appeared during migration");
    renameSync(temporary, target);
    if (process.platform !== "win32") { const fd = openSync(home, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
  } finally {
    if (!closed) database.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(temporary + suffix, { force: true });
  }
}

export async function migrateOrchestration(home: string): Promise<void> {
  if (existsSync(path.join(home, "orchestration.sqlite")) || !existsSync(path.join(home, "orchestration.json"))) return;
  const statusFile = path.join(home, "status.json");
  if (existsSync(statusFile)) {
    const status = JSON.parse(readFileSync(statusFile, "utf8")) as { pid?: number };
    if (Number.isInteger(status.pid) && status.pid! > 0 && status.pid !== process.pid) {
      let live = true;
      try { process.kill(status.pid!, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") live = false; }
      if (live) throw new Error("Stop the existing daemon before migrating orchestration");
    }
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = path.join(home, ".orchestration-migration.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid orchestration migration lock");
    try { process.kill(pid, 0); throw new Error("Orchestration migration already running"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    rmSync(lock);
  }
  const handle = openSync(lock, "wx", 0o600);
  try { writeFileSync(handle, String(process.pid)); fsyncSync(handle); await importOrchestration(home); }
  finally { closeSync(handle); rmSync(lock, { force: true }); }
}
