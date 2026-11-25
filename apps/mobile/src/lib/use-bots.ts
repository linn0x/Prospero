import { useCallback, useEffect, useState } from "react";
import type { BotAction, BotActionResult, PublicBot } from "@prospero/protocol";
import type { HostConnection } from "./connection";
import type { ConnStatus } from "./store";

export function useMobileBots(
  conn: HostConnection | null,
  status: ConnStatus,
  hostCapabilities?: readonly string[] | null,
) {
  const [bots, setBots] = useState<PublicBot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasBotCapability = hostCapabilities
    ? hostCapabilities.includes("bots.v1")
    : Boolean(conn?.supportsBots);
  const supported = Boolean(conn && status === "connected" && hasBotCapability);

  const refresh = useCallback(async () => {
    if (!conn || status !== "connected" || !hasBotCapability) return;
    setLoading(true);
    setError(null);
    try {
      const res = await conn.botAction({ kind: "list" });
      if (res.bots) setBots(res.bots);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载个人 Bot 失败");
    } finally {
      setLoading(false);
    }
  }, [conn, hasBotCapability, status]);

  useEffect(() => {
    if (!supported || !conn) return;
    let cancelled = false;
    void conn
      .botAction({ kind: "list" })
      .then((res) => {
        if (!cancelled && res.bots) setBots(res.bots);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "加载个人 Bot 失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [conn, supported]);

  useEffect(() => {
    if (!conn) return;
    return conn.events.on("botsChanged", (msg) => {
      if (Array.isArray(msg.bots)) {
        setBots(msg.bots as PublicBot[]);
      }
    });
  }, [conn]);

  const runAction = useCallback(
    async (action: BotAction): Promise<BotActionResult> => {
      if (!conn) throw new Error("主机未连接");
      const res = await conn.botAction(action);
      if (res.bots) setBots(res.bots);
      return res;
    },
    [conn],
  );

  return {
    supported,
    bots,
    loading,
    error,
    refresh,
    runAction,
  };
}
