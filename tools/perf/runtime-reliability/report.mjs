import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const matrixPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "fault-matrix.json");
const argumentsList = process.argv.slice(2);
const strict = argumentsList.includes("--strict");
const outputIndex = argumentsList.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(argumentsList[outputIndex + 1]) : undefined;
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
const expectedIds = Array.from({ length: 29 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`);
const ids = matrix.cases.map(testCase => testCase.id);
assert.deepEqual(ids, expectedIds, "fault matrix must contain F01 through F29 once and in order");

const allowedStatuses = new Set(["not_run", "fixture_only", "passed", "failed", "blocked"]);
for (const testCase of matrix.cases) {
  assert.ok(allowedStatuses.has(testCase.releaseStatus), `${testCase.id} has invalid release status`);
  assert.ok(testCase.injectAt && testCase.requiredState && testCase.assertion && testCase.cleanup);
  assert.ok(Array.isArray(testCase.fixtureEvidence));
  if (testCase.releaseStatus === "passed") {
    assert.ok(testCase.releaseEvidence, `${testCase.id} passed requires release evidence`);
    assert.equal(testCase.releaseEvidence.kind, "integrated");
    assert.ok(testCase.releaseEvidence.commit && testCase.releaseEvidence.test);
  }
}

const counts = Object.fromEntries([...allowedStatuses].map(status => [status, 0]));
for (const testCase of matrix.cases) counts[testCase.releaseStatus] += 1;
const blockers = matrix.cases.filter(testCase => testCase.releaseBlocker && testCase.releaseStatus !== "passed");
const report = {
  schemaVersion: 1,
  baselineCommit: matrix.baselineCommit,
  releaseEvidence: matrix.releaseEvidence,
  caseCount: matrix.cases.length,
  counts,
  casesWithFixtureEvidence: matrix.cases.filter(testCase => testCase.fixtureEvidence.length > 0).map(testCase => testCase.id),
  releaseReady: blockers.length === 0 && matrix.releaseEvidence === "complete",
  blockerIds: blockers.map(testCase => testCase.id),
  cases: matrix.cases,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) writeFileSync(outputPath, serialized, { flag: "wx" });
else process.stdout.write(serialized);
if (strict && !report.releaseReady) process.exitCode = 1;
