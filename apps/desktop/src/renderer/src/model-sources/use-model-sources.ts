import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelSource } from "../../../shared/types";
import { reportError } from "../state";

import { createSourceRequester } from "./source-requests";

export const runModelSourceAction = createSourceRequester(action => window.prospero.modelSourceAction(action));

/**
 * Explicit Stale-While-Revalidate state machine for the model sources catalog.
 * Prevents background focus revalidations from locking the UI or wiping cached
 * sources when a transient error occurs.
 */
export type ModelSourceCatalogState =
  | { phase: "disabled"; sources: ModelSource[] }
  | { phase: "loading_initial"; sources: ModelSource[] }
  | { phase: "ready"; sources: ModelSource[] }
  | { phase: "revalidating"; sources: ModelSource[]; previousError?: string }
  | { phase: "stale_error"; sources: ModelSource[]; error: string }
  | { phase: "failed"; sources: ModelSource[]; error: string };

export function reduceModelSourceCatalog(
  current: ModelSourceCatalogState,
  event:
    | { type: "disable" }
    | { type: "start_request"; background?: boolean }
    | { type: "resolve"; sources: ModelSource[] }
    | { type: "reject"; error: string; background?: boolean },
): ModelSourceCatalogState {
  switch (event.type) {
    case "disable":
      return { phase: "disabled", sources: current.sources };
    case "start_request":
      if (current.sources.length > 0) {
        return {
          phase: "revalidating",
          sources: current.sources,
          ...(event.background && (current.phase === "stale_error" || current.phase === "failed")
            ? { previousError: current.error }
            : {}),
        };
      }
      return { phase: "loading_initial", sources: [] };
    case "resolve":
      return { phase: "ready", sources: event.sources };
    case "reject":
      if (current.sources.length > 0) {
        // Keep cached sources usable while recording the stale error.
        return {
          phase: "stale_error",
          sources: current.sources,
          error: event.error,
        };
      }
      return { phase: "failed", sources: [], error: event.error };
  }
}

export function useModelSources(supported: boolean) {
  const [catalog, setCatalog] = useState<ModelSourceCatalogState>(() =>
    supported ? { phase: "loading_initial", sources: [] } : { phase: "disabled", sources: [] },
  );
  const generation = useRef(0);
  const refresh = useCallback(async (background = false) => {
    if (!supported) return;
    const token = ++generation.current;
    setCatalog(current => reduceModelSourceCatalog(current, { type: "start_request", background }));
    try {
      const result = await runModelSourceAction({ kind: "list" });
      if (generation.current === token) {
        setCatalog(current => reduceModelSourceCatalog(current, { type: "resolve", sources: result.sources ?? [] }));
      }
    } catch (reason) {
      if (generation.current === token) {
        setCatalog(current => reduceModelSourceCatalog(current, { type: "reject", error: reportError(reason), background }));
      }
    }
  }, [supported]);
  useEffect(() => {
    if (!supported) {
      generation.current++;
      setCatalog(current => reduceModelSourceCatalog(current, { type: "disable" }));
      return;
    }
    void refresh(false);
    const unsubscribe = window.prospero.subscribeModelSources(next => {
      generation.current++;
      setCatalog(current => reduceModelSourceCatalog(current, { type: "resolve", sources: next }));
    });
    const focus = () => { void refresh(true); };
    window.addEventListener("focus", focus);
    return () => { generation.current++; unsubscribe(); window.removeEventListener("focus", focus); };
  }, [refresh, supported]);

  const loading = catalog.phase === "loading_initial";
  const revalidating = catalog.phase === "revalidating";
  const error = catalog.phase === "failed" || catalog.phase === "stale_error" ? catalog.error : undefined;
  return {
    phase: catalog.phase,
    sources: catalog.sources,
    loading,
    revalidating,
    error,
    refresh: () => refresh(false),
  };
}
