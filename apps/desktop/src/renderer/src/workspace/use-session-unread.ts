import { useEffect, useRef } from "react";
import type { SessionInfo } from "../../../shared/types";
import { sessionIndicator, unreadCompletions, type SessionIndicator } from "./session-status";

/** Mark newly completed background answers, not historical sessions at startup. */
export function useSessionUnread(sessions: SessionInfo[], unreadIds: string[], visibleId: string | undefined) {
  const previous = useRef(new Map<string, SessionIndicator["state"]>());
  const latest = useRef({ visibleId, unreadIds }); latest.current = { visibleId, unreadIds };
  const readable = () => document.visibilityState === "visible" && document.hasFocus();
  useEffect(() => {
    const ids = unreadCompletions(previous.current, sessions, readable() ? visibleId : undefined);
    previous.current = new Map(sessions.map(session => [session.id, sessionIndicator(session).state]));
    for (const id of ids) {
      if (!unreadIds.includes(id)) void window.prospero.setSessionUnread(id, true).catch(() => {});
    }
  }, [sessions, visibleId, unreadIds]);
  useEffect(() => {
    const onFocus = () => {
      const { visibleId, unreadIds } = latest.current;
      if (readable() && visibleId && unreadIds.includes(visibleId)) void window.prospero.setSessionUnread(visibleId, false).catch(() => {});
    };
    window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onFocus);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, []);
}
