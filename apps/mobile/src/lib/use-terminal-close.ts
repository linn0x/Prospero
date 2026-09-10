import { useEffect, useRef, useState } from "react";
import type { HostConnection } from "./connection";

export function useTerminalClose(conn: HostConnection | null, sid: string) {
  const [state, setState] = useState<{ conn: HostConnection | null; sid: string; closing: boolean; error: string | null }>({ conn, sid, closing: false, error: null });
  const currentState = state.conn === conn && state.sid === sid ? state : { closing: false, error: null };
  const attempt = useRef<object | null>(null);
  useEffect(() => () => { attempt.current = null; }, [conn, sid]);
  const close = async (): Promise<boolean> => {
    if (!conn || !sid || attempt.current) return false;
    const current = {};
    attempt.current = current;
    setState({ conn, sid, closing: true, error: null });
    try {
      await conn.closeTerminal(sid);
      return attempt.current === current;
    } catch (failure) {
      if (attempt.current === current) setState({ conn, sid, closing: false, error: failure instanceof Error ? failure.message : String(failure) });
      return false;
    } finally {
      if (attempt.current === current) {
        attempt.current = null;
        setState((previous) => ({ ...previous, closing: false }));
      }
    }
  };
  return { ...currentState, close };
}
