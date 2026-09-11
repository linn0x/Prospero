import { test } from "node:test";
import assert from "node:assert/strict";
import { session, task, percentile } from "./workloads.mjs";

test("archive fixtures never require an agent or personal workspace", () => {
  const row = session(99999);
  assert.equal(row.terminal, true);
  assert.equal(row.cwd, "/synthetic");
  assert.equal(row.id, "session-000099999");
});

test("each run has an independent acyclic chain", () => {
  const rows = Array.from({ length: 200 }, (_, index) => task(index));
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    assert.deepEqual(row.deps, index % 100 ? [rows[index - 1].id] : []);
    if (row.deps.length) assert.equal(row.runId, rows[index - 1].runId);
  }
  assert.notEqual(rows[99].runId, rows[100].runId);
});

test("percentiles use the complete sample distribution", () => {
  assert.equal(percentile([4, 2, 1, 3], 0.5), 2);
  assert.equal(percentile([4, 2, 1, 3], 0.95), 4);
  assert.equal(percentile([], 0.95), null);
});
