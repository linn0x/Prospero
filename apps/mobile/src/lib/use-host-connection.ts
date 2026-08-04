import { useEffect, useState } from "react";
import {
  getConnection,
  peekConnection,
  wireAppStateReconnect,
  type HostConnection,
} from "./connection";
import { getDeviceKeys, getHosts } from "./hosts";
import { emptyRuntime, useApp, type HostRuntime } from "./store";
import type { StoredHost } from "./hosts";

/** 屏幕通用:定位主机(冷启动时从存储加载)、建立/复用连接 */
export function useHostConnection(hostId: string | undefined): {
  host: StoredHost | undefined;
  conn: HostConnection | null;
  runtime: HostRuntime;
} {
  const host = useApp((s) => s.hosts.find((h) => h.id === hostId));
  const setHosts = useApp((s) => s.setHosts);
  const [conn, setConn] = useState<HostConnection | null>(
    hostId ? peekConnection(hostId) : null,
  );

  useEffect(() => {
    if (!hostId) return;
    let cancelled = false;
    void (async () => {
      let h = host;
      if (!h) {
        const all = await getHosts();
        if (cancelled) return;
        setHosts(all);
        h = all.find((x) => x.id === hostId);
        if (!h) return;
      }
      const keys = await getDeviceKeys();
      if (cancelled) return;
      const c = getConnection(h, keys);
      wireAppStateReconnect();
      c.start();
      setConn(c);
    })();
    return () => {
      cancelled = true;
    };
  }, [hostId, host, setHosts]);

  const runtime =
    useApp((s) => (hostId ? s.runtimes[hostId] : undefined)) ?? emptyRuntime;
  return { host, conn, runtime };
}
