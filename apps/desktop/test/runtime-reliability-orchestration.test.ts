import { describe, expect, it, vi } from "vitest";
import { RustClient } from "../src/main/rust-client";
import { ORCHESTRATION_FETCH_CONCURRENCY, orchestrationAction, readOrchestrationWindow } from "../src/main/rust-orchestration";

it("forwards the original stop operation ID without generating a second control request", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
  const client = new RustClient("http://127.0.0.1:9001", "a".repeat(64), fetcher);
  await orchestrationAction(client, "worker.stop", { operationId: "original-stop", taskId: "task", reason: "stop" }, new AbortController().signal);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({ operationId: "original-stop", taskId: "task" });
});

describe("runtime activity projection", () => {
  it("preserves execution uncertainty and resource occupancy alongside business completion", async () => {
    const task = { id: "task", runId: "run", status: "done", title: "Delivered", spec: "test", result: "accepted", deps: [], createdAt: 1, updatedAt: 2 };
    const execution = { identity: { taskId: "task", attemptId: "attempt", executionEpoch: 1 }, state: "STOP_UNKNOWN", resultState: "ACCEPTED" };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async request => {
      const path = new URL(String(request)).pathname;
      const value = path === "/v1/runs" ? [{ id: "run", status: "active", createdAt: 1, updatedAt: 2 }]
        : path === "/v1/tasks" ? [task]
          : path.endsWith("/task-activities") ? { activities: [{ task, execution, latestOperation: null, reservedResources: 1, quarantinedResources: 1, executionUnknown: false, observedAt: 3 }] }
            : [];
      return new Response(JSON.stringify(value));
    });
    const client = new RustClient("http://127.0.0.1:9001", "a".repeat(64), fetcher);
    const projected = await readOrchestrationWindow(client, new AbortController().signal, 1);
    expect(projected["tasks"]).toEqual([expect.objectContaining({ status: "done", runtime: expect.objectContaining({ execution, reservedResources: 1, quarantinedResources: 1 }) })]);
  });

  it("caches terminal and unchanged runs across refreshes and bounds per-run HTTP concurrency", async () => {
    let activeRunUpdatedAt = 10;
    let inFlightSubRequests = 0;
    let peakSubRequests = 0;
    let runSubRequestCalls = 0;

    const runs = () => [
      ...Array.from({ length: 18 }, (_, index) => ({
        id: `done-run-${index}`,
        status: index % 2 === 0 ? "completed" : "failed",
        createdAt: 1,
        updatedAt: 5,
      })),
      { id: "active-run", status: "active", createdAt: 2, updatedAt: activeRunUpdatedAt },
    ];

    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (request) => {
      const url = new URL(String(request));
      if (url.pathname === "/v1/runs") {
        return new Response(JSON.stringify(runs()));
      }
      runSubRequestCalls += 1;
      inFlightSubRequests += 1;
      peakSubRequests = Math.max(peakSubRequests, inFlightSubRequests);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlightSubRequests -= 1;
      if (url.pathname === "/v1/tasks") {
        const runId = url.searchParams.get("runId") ?? "run";
        return new Response(
          JSON.stringify([
            { id: `task-${runId}`, runId, status: "done", title: `Task ${runId}`, spec: "ok", deps: [], createdAt: 1, updatedAt: activeRunUpdatedAt },
          ]),
        );
      }
      if (url.pathname.endsWith("/task-activities")) {
        return new Response(JSON.stringify({ activities: [] }));
      }
      return new Response(JSON.stringify([]));
    });

    const client = new RustClient("http://127.0.0.1:9001", "a".repeat(64), fetcher);
    const first = await readOrchestrationWindow(client, new AbortController().signal, 1);
    expect((first["runs"] as unknown[]).length).toBe(19);
    // 19 runs * 5 sub-endpoints = 95 sub-requests on cold load, bounded by ORCHESTRATION_FETCH_CONCURRENCY (6 runs * 5 endpoints <= 30)
    expect(runSubRequestCalls).toBe(19 * 5);
    expect(peakSubRequests).toBeLessThanOrEqual(ORCHESTRATION_FETCH_CONCURRENCY * 5);
    // Bounded concurrency means multiple runs were fetched in parallel (> 5 concurrent sub-requests)
    expect(peakSubRequests).toBeGreaterThan(5);

    // Second refresh with identical updatedAt hits cache for all 18 terminal runs AND unchanged active run
    runSubRequestCalls = 0;
    const second = await readOrchestrationWindow(client, new AbortController().signal, 1);
    expect(runSubRequestCalls).toBe(0);
    expect((second["tasks"] as unknown[]).length).toBe(19);

    // Updating active-run's updatedAt refetches ONLY active-run (5 sub-requests), keeping 18 terminal runs cached
    activeRunUpdatedAt = 25;
    runSubRequestCalls = 0;
    await readOrchestrationWindow(client, new AbortController().signal, 2);
    expect(runSubRequestCalls).toBe(5);
  });
});
