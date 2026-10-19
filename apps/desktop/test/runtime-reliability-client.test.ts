import { describe, expect, it } from "vitest";
import { RustClient } from "../src/main/rust-client";

function fixture(state: string) {
  const requests: Array<{ path: string; method: string }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ path: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ operationId: "op-test", state, retryAfterMs: 100 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { requests, client: new RustClient("http://127.0.0.1:8000", "a".repeat(64), fetcher as typeof fetch) };
}

describe("durable operation waits", () => {
  it("keeps an unknown operation queryable when waiting expires", async () => {
    const { requests, client } = fixture("OUTCOME_UNKNOWN");
    const result = await client.waitOperation("op-test", 30);
    expect(result.waitTimedOut).toBe(true);
    expect(result.operationId).toBe("op-test");
    expect(result.operation?.state).toBe("OUTCOME_UNKNOWN");
    expect(requests.every(request => request.method === "GET")).toBe(true);
  });

  it("returns terminal operation without cancellation", async () => {
    const { requests, client } = fixture("SUCCEEDED");
    expect((await client.waitOperation("op-test")).waitTimedOut).toBe(false);
    expect(requests).toEqual([{ path: "http://127.0.0.1:8000/v1/operations/op-test", method: "GET" }]);
  });

  it("does not send any mutation when the caller cancels waiting", async () => {
    const { requests, client } = fixture("RUNNING");
    const abort = new AbortController();
    abort.abort();
    await expect(client.waitOperation("op-test", 1000, abort.signal)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
