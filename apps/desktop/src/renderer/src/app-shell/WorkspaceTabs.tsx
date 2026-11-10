import { sessionTabLabels } from "../workspace/session-tab-labels";
import { projectForSession } from "../workspace-sidebar-state";
import "./workspace-tabs.css";
import { Bot, Pin, Plus, X } from "lucide-react";
import { TabStrip } from "../components/TabStrip";
import type { DesktopSnapshot, SessionInfo } from "../../../shared/types";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { isProsperoBotSession, sessionLabel, sessionStatusLabel, SessionAgentIcon, StatusMark } from "../workspace/session-presentation";
import { Spinner } from "../components/ui/spinner";

export function WorkspaceTabs({ snapshot, openIds, activeId, botSession, botBusy = false, onSelectBot, onActivate, onClose, onTogglePin, onReorder, onNewSession }: { snapshot: DesktopSnapshot; openIds: string[]; activeId: string | undefined; botSession?: SessionInfo | undefined; botBusy?: boolean | undefined; onSelectBot?: (() => void) | undefined; onActivate: (id: string) => void; onClose: (id: string) => void; onTogglePin: (id: string) => void; onReorder: (ids: string[]) => void; onNewSession?: (project?: string) => void }) {
  const { t } = useLocale();
  const sessions = new Map(snapshot.daemon.sessions.map((session) => [session.id, session]));
  const labels = sessionTabLabels(snapshot.daemon.sessions);
  const allIds = openIds.filter((id) => {
    const candidate = sessions.get(id);
    return Boolean(candidate && id !== botSession?.id && !isProsperoBotSession(candidate));
  });
  const activeSession = activeId ? sessions.get(activeId) : undefined;
  const isBotActive = Boolean(botSession && activeId === botSession.id);
  const botModelRaw = botSession?.agentControls?.currentModel ?? botSession?.model ?? "gpt-6-astra";
  const botBadgeLabel = botModelRaw === "gpt-6-astra" ? "Astra" : (botModelRaw.split("/").at(-1) ?? botModelRaw);
  const activeWorkspace = activeSession && !isBotActive ? (projectForSession(snapshot.projects, activeSession) ?? activeSession.cwd) : undefined;
  const workspaceScopedIds = activeWorkspace
    ? allIds.filter((id) => {
        const candidate = sessions.get(id);
        return candidate && (projectForSession(snapshot.projects, candidate) ?? candidate.cwd) === activeWorkspace;
      })
    : allIds;
  const ids = workspaceScopedIds.length > 0 ? workspaceScopedIds : allIds;
  return <TabStrip className="topbar-workspace-tabs" listClassName="workspace-tabs" label={t("打开的会话", "Open sessions")} items={ids.map(id => ({ id, label: `${labels.get(id)} · ${sessionStatusLabel(sessions.get(id)!, snapshot.unreadSessionIds.includes(id), t)} — ${sessions.get(id)!.cwd}`, onSelect: () => onActivate(id), onClose: () => onClose(id) }))} activeId={activeId} onReorder={onReorder}>
    {onSelectBot && (
      <button
        type="button"
        data-testid="workspace-bot-tab"
        data-liquid-glass="tab"
        role="tab"
        aria-controls="workspace-session-panel"
        aria-selected={isBotActive}
        disabled={botBusy}
        className={cn("workspace-tab workspace-bot-tab", isBotActive && "is-active")}
        title={`${t("主会话 · Prospero Bot", "Master Session · Prospero Bot")} (${botSession?.agent ?? "codex"} · ${botModelRaw} · Chat UI)`}
        onClick={onSelectBot}
      >
        {botBusy ? <Spinner className="size-3.5 shrink-0" /> : <Bot className="size-3.5 shrink-0" aria-hidden="true" />}
        <span className="truncate font-medium">{t("主会话", "Master")}</span>
        <span className="workspace-bot-tab-badge">{botBadgeLabel}</span>
        {botSession && (
          <StatusMark
            status={botSession.status}
            unread={snapshot.unreadSessionIds.includes(botSession.id)}
            pendingPermissions={botSession.pendingPermissions}
            pendingQuestions={botSession.pendingQuestions}
            busySince={botSession.busySince}
          />
        )}
      </button>
    )}
    {ids.map((id, index) => {
      const session = sessions.get(id)!;
      const pinned = snapshot.pinnedSessionIds.includes(id);
      const unread = snapshot.unreadSessionIds.includes(id);
      const label = labels.get(id)!;
      const fullLabel = `${sessionLabel(session)}\n${session.cwd}`;
      return <div key={id} data-tab-id={id} data-liquid-glass="tab" className={cn("workspace-tab", id === activeId && "is-active")}>
        <button type="button" data-tab-handle data-slot="workspace-tab-main" className="workspace-tab-main" id={`workspace-tab-${id}`} role="tab" aria-controls="workspace-session-panel" aria-selected={id === activeId} tabIndex={id === activeId || !activeId && index === 0 ? 0 : -1} title={fullLabel} onClick={() => onActivate(id)} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(id); } }}><SessionAgentIcon agent={session.agent} unread={unread} /><span className="truncate">{label}</span><StatusMark status={session.status} unread={unread} pendingPermissions={session.pendingPermissions} pendingQuestions={session.pendingQuestions} busySince={session.busySince} /></button>
        <button type="button" data-slot="workspace-tab-pin" data-testid="workspace-tab-pin" className={cn("workspace-tab-action", pinned && "is-pinned")} aria-pressed={pinned} aria-label={pinned ? t(`取消置顶 ${label}`, `Unpin ${label}`) : t(`置顶 ${label}`, `Pin ${label}`)} onPointerDown={event => event.stopPropagation()} onClick={event => { event.preventDefault(); event.stopPropagation(); onTogglePin(id); }}><Pin aria-hidden="true" /></button>
        <button type="button" data-slot="workspace-tab-close" data-testid="workspace-tab-close" className="workspace-tab-action" aria-label={t(`关闭 ${label}`, `Close ${label}`)} onPointerDown={event => event.stopPropagation()} onClick={event => { event.preventDefault(); event.stopPropagation(); onClose(id); }}><X aria-hidden="true" /></button>
      </div>;
    })}
    {onNewSession && (
      <button
        type="button"
        className="workspace-tab-new"
        aria-label={t("新建会话标签页", "New session tab")}
        title={t("在当前工作区新建会话 (⌘N)", "New session in current workspace (⌘N)")}
        onClick={() => onNewSession(activeSession?.cwd)}
      >
        <Plus aria-hidden="true" />
      </button>
    )}
  </TabStrip>;
}
