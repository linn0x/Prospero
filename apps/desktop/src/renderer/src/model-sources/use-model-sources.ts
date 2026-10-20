import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelSource } from "../../../shared/types";
import { reportError } from "../state";

import { createSourceRequester } from "./source-requests";

export const runModelSourceAction = createSourceRequester(action => window.prospero.modelSourceAction(action));

export function useModelSources(supported: boolean) {
  const [sources, setSources] = useState<ModelSource[]>([]);
  const [loading, setLoading] = useState(supported);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!supported) return;
    const token = ++generation.current;
    setLoading(true); setError(undefined);
    try {
      const result = await runModelSourceAction({ kind: "list" });
      if (generation.current === token) setSources(result.sources ?? []);
    } catch (reason) { if (generation.current === token) setError(reportError(reason)); }
    finally { if (generation.current === token) setLoading(false); }
  }, [supported]);
  useEffect(() => {
    if (!supported) { generation.current++; setLoading(false); return; }
    void refresh();
    const unsubscribe = window.prospero.subscribeModelSources(next => {
      generation.current++;
      setSources(next); setLoading(false); setError(undefined);
    });
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { generation.current++; unsubscribe(); window.removeEventListener("focus", focus); };
  }, [refresh, supported]);
  return { sources, loading, error, refresh };
}
