import { useEffect, useMemo, useSyncExternalStore } from "react";
import { TimelineController, TimelineViewCache } from "./timeline-controller";

export function usePagedTimeline(sessionId: string, enabled: boolean) {
  const controller = useMemo(() => new TimelineController(window.prospero, sessionId), [sessionId]);
  const cache = useMemo(() => new TimelineViewCache(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { if (enabled) controller.start(); return () => controller.stop(); }, [controller, enabled]);
  const timeline = useMemo(() => cache.project(state.page), [cache, state.page]);
  return { enabled, controller, state, timeline };
}
