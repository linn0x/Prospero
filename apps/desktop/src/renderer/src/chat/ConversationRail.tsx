import { useEffect, useRef } from "react";
import { useMessageScroller, useMessageScrollerVisibility } from "../components/ui/message-scroller";
import { useLocale } from "../locale";
import { text } from "../state";
import type { ChatTimelineItem } from "../chat-events";

export function ConversationRail({ points, pendingKey, revision, onJump, onJumped }: { points: ChatTimelineItem[]; pendingKey?: string | undefined; revision: string; onJump: (key: string) => void; onJumped: () => void }) {
  const { t } = useLocale();
  const { scrollToMessage } = useMessageScroller();
  const { currentAnchorId, visibleMessageIds } = useMessageScrollerVisibility();
  const activeKey = points.find((point) => point.key === currentAnchorId)?.key ?? points.find((point) => visibleMessageIds.includes(point.key))?.key;
  const rail = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pendingKey) return;
    const frame = requestAnimationFrame(() => {
      if (scrollToMessage(pendingKey, { align: "start", behavior: "instant", scrollMargin: 20 })) onJumped();
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingKey, revision, scrollToMessage, onJumped]);
  useEffect(() => {
    const element = rail.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (element && rail.current) {
      const offset = element.offsetTop;
      if (offset < rail.current.scrollTop || offset + element.offsetHeight > rail.current.scrollTop + rail.current.clientHeight) rail.current.scrollTop = offset - rail.current.clientHeight / 2;
    }
  }, [activeKey]);
  return <nav className="conversation-rail" ref={rail} aria-label={t("快速回溯对话", "Conversation navigation")}>{points.map((point, index) => {
    const preview = text(point.event.text, text(point.event.title, text(point.event.summary, text(point.event.tool)))).replace(/\s+/g, " ").slice(0, 90);
    const label = `${index + 1}. ${preview || t("会话记录", "Conversation event")}`;
    return <button type="button" data-slot="conversation-marker" key={point.key} aria-label={label} aria-current={activeKey === point.key ? "true" : undefined} title={label} tabIndex={activeKey === point.key || !activeKey && index === 0 ? 0 : -1} onClick={() => onJump(point.key)} onKeyDown={(event) => {
      const next = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? points.length - 1 : undefined;
      if (next === undefined) return;
      event.preventDefault();
      const destination = Math.max(0, Math.min(points.length - 1, next));
      rail.current?.querySelectorAll<HTMLButtonElement>("button")[destination]?.focus();
      onJump(points[destination]!.key);
    }}><span aria-hidden="true" /></button>;
  })}</nav>;
}
