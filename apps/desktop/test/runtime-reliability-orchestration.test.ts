import { describe, expect, it, vi } from "vitest";
import { RustClient } from "../src/main/rust-client";
import { orchestrationAction, readOrchestrationWindow } from "../src/main/rust-orchestration";

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
});
