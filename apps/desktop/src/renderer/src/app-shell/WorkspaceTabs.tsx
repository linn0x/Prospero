import { Pin, X } from "lucide-react";
import type { DesktopSnapshot } from "../../../shared/types";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { sessionLabel, SessionAgentIcon } from "../workspace/session-presentation";

export function WorkspaceTabs({ snapshot, openIds, activeId, onActivate, onClose, onTogglePin }: { snapshot: DesktopSnapshot; openIds: string[]; activeId: string | undefined; onActivate: (id: string) => void; onClose: (id: string) => void; onTogglePin: (id: string) => void }) {
  const { t } = useLocale();
  const sessions = new Map(snapshot.daemon.sessions.map((session) => [session.id, session]));
  const ids = openIds.filter((id) => sessions.has(id));
  const focus = (id: string | undefined): void => { if (id) { onActivate(id); window.requestAnimationFrame(() => document.getElementById(`workspace-tab-${id}`)?.focus()); } };
  return <div className="workspace-tabs topbar-workspace-tabs" role="tablist" aria-label={t("打开的会话", "Open sessions")}>
    {ids.map((id, index) => {
      const session = sessions.get(id)!;
      const pinned = snapshot.pinnedSessionIds.includes(id);
      const label = sessionLabel(session);
      return <div key={id} className={cn("workspace-tab", id === activeId && "is-active")}>
        <button type="button" data-slot="workspace-tab-main" data-liquid-glass="tab" className="workspace-tab-main" id={`workspace-tab-${id}`} role="tab" aria-controls="workspace-session-panel" aria-selected={id === activeId} tabIndex={id === activeId || !activeId && index === 0 ? 0 : -1} title={label} onClick={() => onActivate(id)} onKeyDown={(event) => {
          const next = event.key === "ArrowLeft" ? ids[(index - 1 + ids.length) % ids.length] : event.key === "ArrowRight" ? ids[(index + 1) % ids.length] : event.key === "Home" ? ids[0] : event.key === "End" ? ids.at(-1) : undefined;
          if (next) { event.preventDefault(); focus(next); }
          if (event.key === "Delete") { event.preventDefault(); onClose(id); focus(ids[index + 1] ?? ids[index - 1]); }
        }}><SessionAgentIcon agent={session.agent} /><span className="truncate">{label}</span></button>
        <button type="button" data-slot="workspace-tab-pin" data-testid="workspace-tab-pin" className={cn("workspace-tab-action", pinned && "is-pinned")} aria-pressed={pinned} aria-label={pinned ? t(`取消置顶 ${label}`, `Unpin ${label}`) : t(`置顶 ${label}`, `Pin ${label}`)} onClick={() => onTogglePin(id)}><Pin aria-hidden="true" /></button>
        <button type="button" data-slot="workspace-tab-close" data-testid="workspace-tab-close" className="workspace-tab-action" aria-label={t(`关闭 ${label}`, `Close ${label}`)} onClick={() => onClose(id)}><X aria-hidden="true" /></button>
      </div>;
    })}
  </div>;
}
