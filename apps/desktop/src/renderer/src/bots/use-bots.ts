import { useCallback, useEffect, useRef, useState } from "react";
import type { BotAction, BotActionResult, PublicBot } from "../../../shared/types";
import { displayError } from "../state";

export async function runBotAction(action: BotAction): Promise<BotActionResult> {
  if (typeof window.prospero?.botAction !== "function") {
    throw new Error("当前运行环境暂不支持 Bot 模式");
  }
  const result = await window.prospero.botAction(action);
  if (!result.ok) {
    throw new Error(result.error?.message ?? "Bot 操作失败");
  }
  return result;
}

export type BotsCatalogState =
  | { phase: "disabled"; bots: PublicBot[] }
  | { phase: "loading_initial"; bots: PublicBot[] }
  | { phase: "ready"; bots: PublicBot[] }
  | { phase: "revalidating"; bots: PublicBot[]; previousError?: string }
  | { phase: "stale_error"; bots: PublicBot[]; error: string }
  | { phase: "failed"; bots: PublicBot[]; error: string };

export function reduceBotsCatalog(
  current: BotsCatalogState,
  event:
    | { type: "disable" }
    | { type: "start_request"; background?: boolean }
    | { type: "resolve"; bots: PublicBot[] }
    | { type: "reject"; error: string },
): BotsCatalogState {
  switch (event.type) {
    case "disable":
      return { phase: "disabled", bots: current.bots };
    case "start_request":
      if (current.bots.length > 0) {
        return {
          phase: "revalidating",
          bots: current.bots,
          ...(event.background && (current.phase === "stale_error" || current.phase === "failed")
            ? { previousError: current.error }
            : {}),
        };
      }
      return { phase: "loading_initial", bots: [] };
    case "resolve":
      return { phase: "ready", bots: event.bots };
    case "reject":
      if (current.bots.length > 0) {
        return {
          phase: "stale_error",
          bots: current.bots,
          error: event.error,
        };
      }
      return { phase: "failed", bots: [], error: event.error };
  }
}

export function useBots(
  supported: boolean,
  sessionSignature?: string,
) {
  const [catalog, setCatalog] = useState<BotsCatalogState>(() =>
    supported ? { phase: "loading_initial", bots: [] } : { phase: "disabled", bots: [] },
  );
  const generation = useRef(0);

  const applyBots = useCallback((next: PublicBot[]) => {
    generation.current++;
    setCatalog((current) => reduceBotsCatalog(current, { type: "resolve", bots: next }));
  }, []);

  const refresh = useCallback(async (background = false) => {
    if (!supported || typeof window.prospero?.botAction !== "function") return;
    const token = ++generation.current;
    setCatalog((current) => reduceBotsCatalog(current, { type: "start_request", background }));
    try {
      const result = await runBotAction({ kind: "list" });
      if (generation.current === token) {
        setCatalog((current) =>
          reduceBotsCatalog(current, { type: "resolve", bots: result.bots ?? [] }),
        );
      }
    } catch (reason) {
      if (generation.current === token) {
        setCatalog((current) =>
          reduceBotsCatalog(current, { type: "reject", error: displayError(reason) }),
        );
      }
    }
  }, [supported]);

  useEffect(() => {
    if (!supported) {
      generation.current++;
      setCatalog((current) => reduceBotsCatalog(current, { type: "disable" }));
      return;
    }
    void refresh(false);
    const unsubscribe =
      typeof window.prospero?.subscribeBots === "function"
        ? window.prospero.subscribeBots((next) => {
            generation.current++;
            setCatalog((current) => reduceBotsCatalog(current, { type: "resolve", bots: next }));
          })
        : () => {};
    const onFocus = () => {
      void refresh(true);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      generation.current++;
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, supported]);

  useEffect(() => {
    if (!supported || !sessionSignature) return;
    void refresh(true);
  }, [refresh, sessionSignature, supported]);

  return {
    phase: catalog.phase,
    bots: catalog.bots,
    loading: catalog.phase === "loading_initial",
    revalidating: catalog.phase === "revalidating",
    error: catalog.phase === "failed" || catalog.phase === "stale_error" ? catalog.error : undefined,
    refresh: () => refresh(false),
    applyBots,
  };
}
