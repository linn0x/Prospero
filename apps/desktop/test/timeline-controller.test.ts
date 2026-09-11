import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventPage, TimelinePage, TimelineQuery, TimelineRecord } from "@prospero/protocol/rust-daemon";
import { TimelineController, TimelineViewCache, timelineEvent } from "../src/renderer/src/timeline-controller";

function entry(position: number, revision = 1, preview = `Record ${position}`): TimelineRecord {
  return { id: `record-${position}`, turnId: `turn-${Math.floor(position / 4)}`, position, revision, body: { kind: "message", role: "assistant", finalAnswer: true }, preview, bytes: preview.length, generation: 1, truncated: false };
}
function page(query: TimelineQuery, total = 100000, revision = 10): TimelinePage {
  const start = query.after !== null ? query.after + 1 : Math.max(1, (query.before ?? total + 1) - 40);
  const end = Math.min(total, start + 39);
  return { items: Array.from({ length: end - start + 1 }, (_, index) => entry(start + index)), older: start > 1 ? start : null, newer: end < total ? end : null, latestPosition: total, revision };
}
function changes(nextSeq: number, positions: number[] = [], gap = false): EventPage {
  return { items: positions.map(position => ({ scope: "timeline:session", seq: nextSeq, kind: "timeline.updated", entityId: `record-${position}`, data: { position, revision: 2 } })), nextSeq, latestSeq: nextSeq, floorSeq: gap ? nextSeq - 1 : 0, hasMore: false, resyncRequired: gap };
}
afterEach(() => vi.useRealTimers());

describe("paged materialized timelines", () => {
  it("refreshes only changed records and preserves the visible history window", async () => {
    vi.useFakeTimers();
    const api = {
      readTimeline: vi.fn(async (_id: string, query: TimelineQuery) => page(query)),
      readTimelineChanges: vi.fn().mockResolvedValueOnce(changes(11, [100001])).mockResolvedValueOnce(changes(12, [99930])).mockResolvedValue(changes(12)),
      lookupTimeline: vi.fn(async () => ({ items: [entry(99930, 2, "Updated")], latestPosition: 100001, revision: 12 })),
      cancelSessionPage: vi.fn(async () => {}),
    };
    const controller = new TimelineController(api, "session");
    controller.start(); await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().page?.items[0]?.position).toBe(99961);
    await controller.older();
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot().page?.items[0]?.position).toBe(99921);
    expect(api.readTimeline).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot().page?.items.find(item => item.position === 99930)?.preview).toBe("Updated");
    expect(api.lookupTimeline.mock.calls[0]?.[1]).toEqual(["record-99930"]);
    expect(controller.getSnapshot().page?.items).toHaveLength(40);
    expect(api.readTimeline).toHaveBeenCalledTimes(2);
    controller.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("reloads a frozen window after retention gaps and returns to live tail explicitly", async () => {
    vi.useFakeTimers();
    let total = 100000;
    const api = { readTimeline: vi.fn(async (_id: string, query: TimelineQuery) => page(query, total)), readTimelineChanges: vi.fn(async () => changes(1000, [], true)), lookupTimeline: vi.fn(), cancelSessionPage: vi.fn(async () => {}) };
    const controller = new TimelineController(api, "session");
    controller.start(); await vi.advanceTimersByTimeAsync(0); controller.freeze();
    total += 10000;
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.getSnapshot().page?.items[0]?.position).toBe(99961);
    expect(controller.getSnapshot().live).toBe(false);
    await controller.latest();
    expect(controller.getSnapshot().page?.items.at(-1)?.position).toBe(110000);
    expect(controller.getSnapshot().live).toBe(true);
    controller.stop();
  });

  it("cancels outstanding reads and ignores late responses after a tab closes", async () => {
    vi.useFakeTimers();
    let finish!: (value: TimelinePage) => void;
    const pending = new Promise<TimelinePage>(resolve => { finish = resolve; });
    const api = { readTimeline: vi.fn(() => pending), readTimelineChanges: vi.fn(), lookupTimeline: vi.fn(), cancelSessionPage: vi.fn(async () => {}) };
    const controller = new TimelineController(api, "session");
    controller.start(); await vi.advanceTimersByTimeAsync(0); controller.stop();
    finish(page({ before: null, after: null, limit: 40 })); await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().page).toBeUndefined();
    expect(api.cancelSessionPage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed history navigation at the requested cursor", async () => {
    vi.useFakeTimers();
    let fail = false;
    const api = { readTimeline: vi.fn(async (_id: string, query: TimelineQuery) => { if (fail) throw new Error("fixture"); return page(query); }), readTimelineChanges: vi.fn(async () => changes(10)), lookupTimeline: vi.fn(), cancelSessionPage: vi.fn(async () => {}) };
    const controller = new TimelineController(api, "session");
    controller.start(); await vi.advanceTimersByTimeAsync(0);
    fail = true; await controller.older(); expect(controller.getSnapshot().error).toBeDefined();
    fail = false; await controller.retry();
    expect(controller.getSnapshot().page?.items[0]?.position).toBe(99921);
    expect(controller.getSnapshot().error).toBeUndefined();
    controller.stop();
  });
});

describe("timeline view projection", () => {
  it("retains unchanged render records and drops cached history outside the current page", () => {
    const cache = new TimelineViewCache();
    const original = page({ before: null, after: null, limit: 40 });
    const first = cache.project(original);
    const changed = cache.project({ ...original, items: [entry(original.items[0]!.position, 2), ...original.items.slice(1)], revision: 11 });
    expect(changed.items[1]).toBe(first.items[1]);
    expect(changed.items[0]).not.toBe(first.items[0]);
    cache.project(page({ before: original.older, after: null, limit: 40 }));
    expect(cache.project(original).items[1]).not.toBe(first.items[1]);
    expect(timelineEvent({ ...entry(1), body: { kind: "tool", name: "Example", summary: "Done", state: "success" } })).toMatchObject({ kind: "tool.end", hasMore: true, bodyRecordId: "record-1" });
  });
});
