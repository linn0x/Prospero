import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteWorkspace } from "../../../shared/types";
import { reportError } from "../state";

export function useRemoteWorkspaces() {
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([]);
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    setLoading(true);
    try {
      const next = await window.prospero.listRemoteWorkspaces();
      if (token === generation.current) { setWorkspaces(next); setError(undefined); setReady(true); }
    } catch (reason) {
      if (token === generation.current) setError(reportError(reason));
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const unsubscribe = window.prospero.subscribeRemoteWorkspaces(next => {
      generation.current++;
      setWorkspaces(next);
      setError(undefined);
      setReady(true);
      setLoading(false);
    });
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    return () => { generation.current++; window.removeEventListener("focus", focus); unsubscribe(); };
  }, [refresh]);
  const upsert = useCallback((workspace: RemoteWorkspace) => {
    generation.current++;
    setLoading(false);
    setWorkspaces(current => [workspace, ...current.filter(item => item.id !== workspace.id)]);
  }, []);
  const forget = useCallback(async (id: string) => {
    await window.prospero.forgetRemoteWorkspace(id);
    generation.current++;
    setWorkspaces(current => current.filter(workspace => workspace.id !== id));
  }, []);
  return { workspaces, error, ready, loading, refresh, upsert, forget };
}
