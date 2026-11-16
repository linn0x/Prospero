import type { TimelinePage } from "@prospero/protocol/rust-daemon";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { TimelineController, TimelineViewCache } from "./timeline-controller";

export const RETAINED_TIMELINE_LIMIT = 24;

type RetainedTimelineEntry = {
  page?: TimelinePage;
  viewCache: TimelineViewCache;
};

const retainedTimelines = new Map<string, RetainedTimelineEntry>();

function getOrCreateRetainedTimeline(sessionId: string): RetainedTimelineEntry {
  const existing = retainedTimelines.get(sessionId);
  if (existing) {
    retainedTimelines.delete(sessionId);
    retainedTimelines.set(sessionId, existing);
    return existing;
  }
  const created: RetainedTimelineEntry = { viewCache: new TimelineViewCache() };
  retainedTimelines.set(sessionId, created);
  while (retainedTimelines.size > RETAINED_TIMELINE_LIMIT) {
    const oldestKey = retainedTimelines.keys().next().value;
    if (oldestKey === undefined) break;
    retainedTimelines.delete(oldestKey);
  }
  return created;
}

export function clearRetainedTimelines(): void {
  retainedTimelines.clear();
}

export function usePagedTimeline(sessionId: string, enabled: boolean) {
  const retained = useMemo(() => getOrCreateRetainedTimeline(sessionId), [sessionId]);
  const controller = useMemo(
    () =>
      new TimelineController(window.prospero, sessionId, {
        ...(retained.page ? { initialPage: retained.page } : {}),
        onPage: page => {
          retained.page = page;
          retainedTimelines.delete(sessionId);
          retainedTimelines.set(sessionId, retained);
        },
      }),
    [retained, sessionId],
  );
  const cache = retained.viewCache;
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { if (enabled) controller.start(); return () => controller.stop(); }, [controller, enabled]);
  const timeline = useMemo(() => cache.project(state.page), [cache, state.page]);
  return { enabled, controller, state, timeline };
}
