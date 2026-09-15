import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateOrchestration, OrchestrationDatabase } from "../src/orchestration/database.js";
import { OrchestrationStore } from "../src/orchestration/store.js";

const homes: string[] = [];
function home(): string { const value = mkdtempSync(path.join(os.tmpdir(), "prospero-orchestration-db-")); homes.push(value); return value; }
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("SQLite orchestration migration", () => {
  it("preserves legacy records, dependencies, journal and source bytes", async () => {
    const directory = home();
    const source = new OrchestrationStore();
    const run = source.createRun({ objective: "Example" });
    const a = source.createTask({ runId: run.id, title: "A", spec: "Unicode 你好 😀" });
    const b = source.createTask({ runId: run.id, title: "B", spec: "B", deps: [a.id] });
    const state = source.snapshot();
    const file = path.join(directory, "orchestration.json");
    const original = JSON.stringify({ ...state, eventSeq: 1, eventBaseSeq: 0, events: [{ seq: 1, runId: run.id, entity: "task", entityId: b.id, operation: "upsert", value: b, occurredAt: 1 }] });
    writeFileSync(file, original);
    await migrateOrchestration(directory);
    const store = new OrchestrationStore(directory);
    expect(store.snapshot()).toEqual(state);
    expect(store.eventsSince(run.id, 0).events).toHaveLength(1);
    store.close();
    const database = new OrchestrationDatabase(path.join(directory, "orchestration.sqlite"));
    expect(database.check().tasks).toBe(2);
    expect(database.db.prepare("SELECT * FROM task_dependencies").all()).toEqual([{ task_id: b.id, dependency_id: a.id }]);
    expect(database.db.prepare("SELECT count(*) AS n FROM desktop_projection WHERE entity='tasks'").get()!.n).toBe(2);
    database.close();
    await migrateOrchestration(directory);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it.each(['{"version":2,"tasks":', '{"version":2,"tasks":{"a":{"id":"a","deps":[]},"a":{"id":"a","deps":[]}}}', '{"version":99}'])("does not publish partial or invalid imports", async value => {
    const directory = home();
    writeFileSync(path.join(directory, "orchestration.json"), value);
    await expect(migrateOrchestration(directory)).rejects.toThrow();
    expect(existsSync(path.join(directory, "orchestration.sqlite"))).toBe(false);
    expect(readdirSync(directory)).toEqual(["orchestration.json"]);
    expect(readFileSync(path.join(directory, "orchestration.json"), "utf8")).toBe(value);
  });

  it("writes only changed records and rejects stale writers", () => {
    const directory = home();
    const first = new OrchestrationStore(directory);
    const run = first.createRun({ objective: "One" }); first.persistNow();
    const second = new OrchestrationStore(directory);
    const database = new OrchestrationDatabase(path.join(directory, "orchestration.sqlite"));
    database.db.exec("CREATE TABLE test_updates(n INTEGER); CREATE TRIGGER count_updates AFTER UPDATE ON runs BEGIN INSERT INTO test_updates VALUES(1); END;");
    first.persistNow();
    expect(database.db.prepare("SELECT count(*) AS n FROM test_updates").get()!.n).toBe(0);
    first.updateRun(run.id, { objective: "Changed" }); first.persistNow();
    expect(database.db.prepare("SELECT count(*) AS n FROM test_updates").get()!.n).toBe(1);
    second.createRun({ objective: "Stale" });
    expect(() => second.persistNow()).toThrow("another writer");
    expect(() => second.close()).toThrow();
    first.close(); database.close();
  });

  it.skipIf(process.env.PROSPERO_LARGE_MIGRATION_TEST !== "1")("streams a legacy file larger than the V8 string limit", async () => {
    const directory = home();
    const file = path.join(directory, "orchestration.json");
    writeFileSync(file, '{"version":2,"messages":{');
    const body = "x".repeat(1024 * 1024);
    for (let index = 0; index < 520; index++) appendFileSync(file, `${index ? "," : ""}${JSON.stringify(`message-${index}`)}:${JSON.stringify({ id: `message-${index}`, runId: "run-example", body })}`);
    appendFileSync(file, '}}');
    await migrateOrchestration(directory);
    const database = new OrchestrationDatabase(path.join(directory, "orchestration.sqlite"));
    expect(database.check().messages).toBe(520);
    expect(database.db.prepare("SELECT length(json_extract(data,'$.body')) AS n FROM messages WHERE id='message-519'").get()!.n).toBe(body.length);
    database.close();
  }, 180_000);
});
