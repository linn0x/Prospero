import assert from "node:assert/strict";
import test from "node:test";
import { newFailureReport, recordFailure, serializeSafeFailureReport } from "./failure.mjs";

const forbidden = /host.?secret|token|ticket|credential|authorization|route.?id|\bws\b|websocket|socket|frame|buffer/i;

test("serializes a passed failure-harness record through the safe allowlist", () => {
  const report = newFailureReport();
  report.steps.push({ name: "initial_host_ready", pass: true, result: { ready: true } });
  report.finishedAt = new Date().toISOString();
  const serialized = serializeSafeFailureReport(report);
  assert.doesNotMatch(serialized, forbidden);
  assert.match(serialized, /"ready": true/);
});

test("serializes failed paths without retaining an error's sensitive marker", () => {
  const report = newFailureReport();
  recordFailure(report, "synthetic_failure", new Error("token marker from an internal callback"));
  report.steps.push({ name: "synthetic_failure", pass: false });
  report.finishedAt = new Date().toISOString();
  const serialized = serializeSafeFailureReport(report);
  assert.doesNotMatch(serialized, forbidden);
  assert.match(serialized, /"code": "operation_failed"/);
});

test("rejects report objects containing forbidden fields or markers", () => {
  const report = newFailureReport();
  report.steps.push({ name: "synthetic_failure", pass: false, result: { token: "not-allowed" } });
  assert.throws(() => serializeSafeFailureReport(report), /not allowlisted/);
});
