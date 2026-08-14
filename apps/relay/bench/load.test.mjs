import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildReport, metricValuesByDirection, parseArgs, readDirectBaseline, resolveRepositoryPath, serializeSafeLoadReport } from "./load.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function successfulRunner() {
  return {
    startedAt: 0,
    trafficStartedAt: 0,
    trafficEndedAt: 1_000,
    metrics: [
      { atMs: 0, cpuSeconds: 1, rssBytes: 100, openFds: 10, eventLoopLagSeconds: 0.001, eventLoopLagP99Seconds: 0.002, forwardedClientToHostBytes: 0, forwardedHostToClientBytes: 0 },
      { atMs: 1_000, cpuSeconds: 1.1, rssBytes: 101, openFds: 11, eventLoopLagSeconds: 0.001, eventLoopLagP99Seconds: 0.002, forwardedClientToHostBytes: 4_104, forwardedHostToClientBytes: 4_104 },
    ],
    eventLoopLagMs: [1, 2],
    counts: { hostEstablished: 1, hostFailed: 0, streamEstablished: 1, streamFailed: 0, unexpectedDisconnects: 0 },
    bytes: { clientToHostSent: 4_104, clientToHostReceived: 4_104, hostToClientSent: 4_104, hostToClientReceived: 4_104 },
    traffic: { clientContinuousSent: 4_096, clientBurstSent: 0, clientRttSent: 8, hostContinuousSent: 4_096, hostBurstSent: 0, hostRttEchoSent: 8, clientPayloadUnitsReceived: 1, hostPayloadUnitsReceived: 1, payloadIntegrityFailures: 0, ticksWithAllPairs: 1, ticksWithMissingPairs: 0 },
    sendEvidence: { queuedWritePeakBytes: 0, sendCallbackErrors: 0, synchronousSendErrors: 0, pendingCallbacks: 0, drainCompleted: true },
    failures: [],
    openLatencies: [10],
    rtts: [4],
  };
}

const options = { hosts: 1, streams: 1, durationSeconds: 1, concurrency: 1, burstSeconds: 30, drainMs: 10 };
const environment = { docker: { available: false, cpus: null, memoryBytes: null } };

test("parses relay byte counters by direction", () => {
  const values = metricValuesByDirection([
    "prospero_relay_forwarded_bytes_total{direction=\"client_to_host\"} 123",
    "prospero_relay_forwarded_bytes_total{direction=\"host_to_client\"} 456",
  ].join("\n"));
  assert.deepEqual(values, { client_to_host: 123, host_to_client: 456 });
});

test("normalizes report and baseline paths from the repository root, not npm workspace cwd", () => {
  const parsed = parseArgs([
    "--url", "ws://localhost:8787",
    "--report", "apps/relay/reports/result.json",
    "--direct-baseline-report", "apps/relay/bench/fixtures/direct-baseline.json",
  ]);
  assert.equal(parsed.report, resolveRepositoryPath("apps/relay/reports/result.json"));
  assert.equal(parsed.directBaselineReport, resolveRepositoryPath("apps/relay/bench/fixtures/direct-baseline.json"));
  assert.equal(parseArgs(["--url", "ws://localhost:8787"]).report, resolveRepositoryPath("apps/relay/reports/latest-load-report.json"));
});

test("reads the direct baseline fixture and keeps scale qualification separate from execution", async () => {
  const baseline = await readDirectBaseline(join(here, "fixtures", "direct-baseline.json"));
  assert.equal(baseline.value, 2.5);
  const report = buildReport(options, successfulRunner(), environment, Date.now(), baseline);
  assert.equal(report.executionStatus, "passed");
  assert.equal(report.qualificationStatus, "inconclusive");
  assert.equal(report.latency.addedRttMs.p95, 1.5);
  assert.equal(report.throughput.trafficElapsedSeconds, 1);
});

test("never hides setup or delivery failures behind an inconclusive qualification", () => {
  const runner = successfulRunner();
  runner.counts.hostEstablished = 0;
  runner.counts.hostFailed = 1;
  runner.failures.push({ code: "connection_closed" });
  const report = buildReport(options, runner, environment, Date.now(), { value: 2.5, source: "fixture" });
  assert.equal(report.executionStatus, "failed");
  assert.equal(report.qualificationStatus, "failed");
});

test("requires each sent host heartbeat to be acknowledged without misses", () => {
  const runner = successfulRunner();
  runner.hostHeartbeatsSent = 3;
  runner.hostHeartbeatsAcked = 3;
  runner.hostHeartbeatsMissed = 0;
  const report = buildReport(options, runner, environment, Date.now(), { value: null, errorCode: "not_supplied" });
  assert.equal(report.executionChecks.find((check) => check.name === "host_heartbeat_acknowledgements")?.pass, true);
  assert.equal(report.executionChecks.find((check) => check.name === "host_heartbeat_misses_zero")?.pass, true);

  runner.hostHeartbeatsMissed = 1;
  const missed = buildReport(options, runner, environment, Date.now(), { value: null, errorCode: "not_supplied" });
  assert.equal(missed.executionStatus, "failed");
});

test("projects passed and failed load reports through the aggregate-only safety gate", () => {
  const passed = buildReport(options, successfulRunner(), environment, Date.now(), { value: 2.5, source: "fixture" });
  const passedJson = serializeSafeLoadReport(passed);
  assert.doesNotMatch(passedJson, /host.?secret|token|ticket|credential|authorization|route.?id|\bws\b|websocket|socket|frame|buffer/i);

  const failedRunner = successfulRunner();
  failedRunner.failures.push({ code: "operation_failed" });
  const failed = buildReport(options, failedRunner, environment, Date.now(), { value: null, errorCode: "not_supplied" });
  const failedJson = serializeSafeLoadReport(failed);
  assert.doesNotMatch(failedJson, /host.?secret|token|ticket|credential|authorization|route.?id|\bws\b|websocket|socket|frame|buffer/i);
});
