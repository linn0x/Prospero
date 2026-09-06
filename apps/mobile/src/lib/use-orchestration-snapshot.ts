import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import type { OrchestrationSnapshot } from "@prospero/protocol";
import type { HostConnection } from "@/lib/connection";
import type { ConnStatus } from "@/lib/store";

/**
 * Snapshot polling is foreground-only. The explicit active cleanup guard keeps
 * a focus transition or reconnect from accumulating duplicate event listeners.
 */
export function useOrchestrationSnapshot(
  conn: HostConnection | null,
  status: ConnStatus,
  refreshEveryMs: number,
  onServerError?: (message: string) => void,
): OrchestrationSnapshot | null {
  const [received, setReceived] = useState<{ conn: HostConnection; snapshot: OrchestrationSnapshot } | null>(null);
  const activeCleanup = useRef<(() => void) | null>(null);

  useFocusEffect(
    useCallback(() => {
      activeCleanup.current?.();
      activeCleanup.current = null;
      if (!conn || status !== "connected" || !conn.supportsOrchestrationSnapshot) {
        return undefined;
      }

      let active = true;
      const refresh = (): void => conn.orchestrationSnapshot();
      const offSnapshot = conn.events.on("orchestrationSnapshot", (message) => {
        if (active) setReceived({ conn, snapshot: message.snapshot });
      });
      const offError = onServerError
        ? conn.events.on("serverError", (message) => {
          if (active) onServerError(message.message);
        })
        : undefined;
      refresh();
      const timer = setInterval(refresh, refreshEveryMs);
      const cleanup = (): void => {
        if (!active) return;
        active = false;
        offSnapshot();
        offError?.();
        clearInterval(timer);
        if (activeCleanup.current === cleanup) activeCleanup.current = null;
      };
      activeCleanup.current = cleanup;
      return cleanup;
    }, [conn, onServerError, refreshEveryMs, status]),
  );

  // Switching hosts must not briefly classify the new host using the old host's worktrees.
  return received?.conn === conn ? received.snapshot : null;
}
