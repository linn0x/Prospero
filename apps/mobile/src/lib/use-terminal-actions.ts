import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { HostConnection } from "./connection";

interface Attempt { sid: string; kind: "restart" | "delete"; cancel?: () => void }

/** One user action at a time; late replies must never navigate a blurred page. */
export function useTerminalActions(conn: HostConnection | null, scope = conn?.host.id ?? "") {
  const attempt = useRef<Attempt | null>(null);
  const active = useRef(false);
  const [busy, setBusy] = useState<Attempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    active.current = conn !== null && scope.length > 0;
    setBusy(null); setError(null);
    return () => { active.current = false; attempt.current?.cancel?.(); attempt.current = null; };
  }, [conn, scope]));

  const run = async <T,>(sid: string, kind: Attempt["kind"], operation: (connection: HostConnection, job: Attempt) => Promise<T>): Promise<T | null> => {
    if (!conn || !active.current || attempt.current) return null;
    const job: Attempt = { sid, kind };
    attempt.current = job;
    setBusy(job); setError(null);
    try {
      const result = await operation(conn, job);
      return attempt.current === job ? result : null;
    } catch (failure) {
      if (attempt.current === job) setError(failure instanceof Error ? failure.message : String(failure));
      return null;
    } finally {
      if (attempt.current === job) { attempt.current = null; setBusy(null); }
    }
  };

  return {
    busy, error,
    restart: (sid: string) => run(sid, "restart", (connection, job) => {
      const task = connection.restartTerminal(sid);
      job.cancel = () => task.cancel();
      return task.completion;
    }),
    remove: (sid: string) => run(sid, "delete", async (connection) => { await connection.deleteTerminal(sid); return true; }),
  };
}
