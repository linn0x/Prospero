import { describe, expect, it, vi } from "vitest";
import type { SessionPage, SessionPageRequest } from "../src/shared/types";
import { RequestQueue } from "../src/renderer/src/request-queue";
import { WorkspaceSessionPager } from "../src/renderer/src/workspace-session-pager";

function page(start: number, count: number, label = "Archive", total = 100000): SessionPage {
  return { items: Array.from({ length: Math.min(count, total - start) }, (_, offset) => ({ id: `session-${start + offset}`, title: `${label} ${start + offset}`, agent: "codex", kind: "structured", status: "completed", cwd: "/workspace" })), total, active: 0, terminal: total,
    ...(start > 0 ? { previousCursor: String(Math.max(0, start - count)) } : {}), ...(start + count < total ? { nextCursor: String(start + count) } : {}),
  };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("bounded workspace history", () => {
  it("walks arbitrary history in both directions without accumulating records", async () => {
    let label = "Archive";
    const api = { listSessions: vi.fn(async (request: SessionPageRequest = {}) => page(Number(request.cursor ?? 0), request.limit!, label)), cancelSessionPage: vi.fn(async () => {}) };
    const pager = new WorkspaceSessionPager(api, "/workspace");
    pager.setActive(true);
    await vi.waitFor(() => expect(pager.getSnapshot().page?.items.length).toBe(6));
    await pager.expand();
    for (let index = 0; index < 100; index++) {
      await pager.next();
      expect(pager.getSnapshot().page?.items).toHaveLength(24);
    }
    expect(pager.getSnapshot().page?.items[0]?.id).toBe("session-2400");
    label = "Updated"; pager.setRevision("next");
    await vi.waitFor(() => expect(pager.getSnapshot().page?.items[0]?.title).toBe("Updated 2400"));
    const reads = api.listSessions.mock.calls.length;
    pager.setRevision("next");
    await Promise.resolve();
    expect(api.listSessions).toHaveBeenCalledTimes(reads);
    await pager.previous();
    expect(pager.getSnapshot().page?.items[0]?.id).toBe("session-2376");
    await pager.first();
    expect(pager.getSnapshot().page?.previousCursor).toBeUndefined();
    await pager.collapse();
    expect(pager.getSnapshot().page?.items).toHaveLength(6);
    expect(api.listSessions.mock.calls.every(([request]) => request.workspace === "/workspace" && request.requestId)).toBe(true);
    pager.setActive(false);
    expect(pager.getSnapshot().page).toBeUndefined();
  });

  it("cancels superseded requests and discards late replies after collapse", async () => {
    const first = deferred<SessionPage>(); const second = deferred<SessionPage>(); const third = deferred<SessionPage>();
    const api = { listSessions: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise), cancelSessionPage: vi.fn(async () => {}) };
    const pager = new WorkspaceSessionPager(api, "/workspace");
    pager.setActive(true);
    await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(1));
    pager.setRevision("new");
    await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
    second.resolve(page(0, 6, "New"));
    await vi.waitFor(() => expect(pager.getSnapshot().page?.items[0]?.title).toBe("New 0"));
    first.resolve(page(0, 6, "Old")); await first.promise;
    expect(pager.getSnapshot().page?.items[0]?.title).toBe("New 0");
    const expanding = pager.expand();
    await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(3));
    pager.setActive(false); third.resolve(page(0, 24)); await expanding;
    expect(pager.getSnapshot().page).toBeUndefined();
    expect(api.cancelSessionPage).toHaveBeenCalledTimes(2);
  });

  it("retries failures and recovers an empty cursor page without an unbounded loop", async () => {
    const api = { listSessions: vi.fn().mockRejectedValueOnce(new Error("fixture")).mockResolvedValueOnce(page(0, 6)).mockResolvedValueOnce(page(0, 24)).mockResolvedValueOnce({ ...page(0, 0), items: [] }).mockResolvedValueOnce(page(0, 24)), cancelSessionPage: vi.fn(async () => {}) };
    const pager = new WorkspaceSessionPager(api, "/workspace");
    pager.setActive(true);
    await vi.waitFor(() => expect(pager.getSnapshot().error).toBeDefined());
    await pager.retry(); await pager.expand(); await pager.next();
    expect(api.listSessions).toHaveBeenCalledTimes(5);
    expect(pager.getSnapshot().page?.items[0]?.id).toBe("session-0");
    expect(pager.getSnapshot().error).toBeUndefined();
    pager.setActive(false);
  });
});

describe("sidebar request scheduling", () => {
  it("bounds concurrency and queue size and removes cancelled waiting work", async () => {
    const queue = new RequestQueue(1, 1);
    const barrier = deferred<void>();
    const first = queue.run(new AbortController().signal, () => barrier.promise);
    const waiting = new AbortController(); const work = vi.fn(async () => 2);
    const second = queue.run(waiting.signal, work);
    const cancelled = expect(second).rejects.toMatchObject({ name: "AbortError" });
    await expect(queue.run(new AbortController().signal, work)).rejects.toThrow("队列已满");
    waiting.abort(); await cancelled;
    const third = queue.run(new AbortController().signal, work);
    expect(work).not.toHaveBeenCalled();
    barrier.resolve(); await first;
    expect(await third).toBe(2);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
