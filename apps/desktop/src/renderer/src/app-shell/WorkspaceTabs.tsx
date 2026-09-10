import { Pin, X } from "lucide-react";
import { TabStrip } from "../components/TabStrip";
import type { DesktopSnapshot } from "../../../shared/types";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { sessionLabel, SessionAgentIcon } from "../workspace/session-presentation";

export function WorkspaceTabs({ snapshot, openIds, activeId, onActivate, onClose, onTogglePin, onReorder }: { snapshot: DesktopSnapshot; openIds: string[]; activeId: string | undefined; onActivate: (id: string) => void; onClose: (id: string) => void; onTogglePin: (id: string) => void; onReorder: (ids: string[]) => void }) {
  const { t } = useLocale();
  const sessions = new Map(snapshot.daemon.sessions.map((session) => [session.id, session]));
  const ids = openIds.filter((id) => sessions.has(id));
  return <TabStrip className="topbar-workspace-tabs" listClassName="workspace-tabs" label={t("打开的会话", "Open sessions")} items={ids.map(id => ({ id, label: sessionLabel(sessions.get(id)!), onSelect: () => onActivate(id), onClose: () => onClose(id) }))} activeId={activeId} onReorder={onReorder}>
    {ids.map((id, index) => {
      const session = sessions.get(id)!;
      const pinned = snapshot.pinnedSessionIds.includes(id);
      const label = sessionLabel(session);
      return <div key={id} data-tab-id={id} data-liquid-glass="tab" className={cn("workspace-tab", id === activeId && "is-active")}>
        <button type="button" data-tab-handle data-slot="workspace-tab-main" className="workspace-tab-main" id={`workspace-tab-${id}`} role="tab" aria-controls="workspace-session-panel" aria-selected={id === activeId} tabIndex={id === activeId || !activeId && index === 0 ? 0 : -1} title={label} onClick={() => onActivate(id)} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(id); } }}><SessionAgentIcon agent={session.agent} /><span className="truncate">{label}</span></button>
        <button type="button" data-slot="workspace-tab-pin" data-testid="workspace-tab-pin" className={cn("workspace-tab-action", pinned && "is-pinned")} aria-pressed={pinned} aria-label={pinned ? t(`取消置顶 ${label}`, `Unpin ${label}`) : t(`置顶 ${label}`, `Pin ${label}`)} onClick={() => onTogglePin(id)}><Pin aria-hidden="true" /></button>
        <button type="button" data-slot="workspace-tab-close" data-testid="workspace-tab-close" className="workspace-tab-action" aria-label={t(`关闭 ${label}`, `Close ${label}`)} onClick={() => onClose(id)}><X aria-hidden="true" /></button>
      </div>;
    })}
  </TabStrip>;
}
