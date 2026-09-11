import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft } from "lucide-react";
import type { SessionInfo } from "../../shared/types";
import { SidebarMenuSubItem } from "./components/ui/sidebar";
import { Spinner } from "./components/ui/spinner";
import { useLocale } from "./locale";
import { WORKSPACE_PREVIEW_SIZE, WorkspaceSessionPager } from "./workspace-session-pager";
import { sortSidebarSessions } from "./workspace-sidebar-state";

export function WorkspaceHistory({ workspace, name, enabled, revision, preview, activeId, pinned, unread, archived, onTotal, renderRow }: {
  workspace: string; name: string; enabled: boolean; revision: string | undefined; preview: SessionInfo[]; activeId: string | undefined;
  pinned: string[]; unread: string[]; archived: string[]; onTotal: (workspace: string, total: number) => void; renderRow: (session: SessionInfo) => ReactNode;
}) {
  const { t } = useLocale();
  const pager = useMemo(() => new WorkspaceSessionPager(window.prospero, workspace), [workspace]);
  const state = useSyncExternalStore(pager.subscribe, pager.getSnapshot, pager.getSnapshot);
  useEffect(() => pager.setRevision(revision), [pager, revision]);
  useEffect(() => { pager.setActive(enabled); return () => pager.setActive(false); }, [pager, enabled]);
  const total = state.page?.total;
  useEffect(() => { if (total !== undefined) onTotal(workspace, total); }, [onTotal, total, workspace]);
  const items = state.expanded ? state.page?.items ?? [] : [...new Map([...preview, ...(state.page?.items ?? [])].map(item => [item.id, item])).values()];
  const visible = sortSidebarSessions(items.filter(item => item.id === activeId || !archived.includes(item.id)), activeId, pinned, unread).slice(0, state.expanded ? 24 : WORKSPACE_PREVIEW_SIZE);
  return <>
    {visible.map(renderRow)}
    {state.loading && <SidebarMenuSubItem className="workspace-search-summary" aria-live="polite"><Spinner /><span>{t("正在载入会话…", "Loading sessions…")}</span></SidebarMenuSubItem>}
    {state.error && <SidebarMenuSubItem className="workspace-session-more-item"><button type="button" className="workspace-session-more" disabled={state.loading} onClick={() => void pager.retry()}>{t("加载失败，点击重试", "Load failed, retry")}</button></SidebarMenuSubItem>}
    {!state.expanded && (total ?? preview.length) > WORKSPACE_PREVIEW_SIZE && <SidebarMenuSubItem className="workspace-session-more-item">
      <button type="button" className="workspace-session-more" data-slot="workspace-session-more" disabled={state.loading} aria-label={t(`显示 ${name} 的更多会话`, `Show more sessions in ${name}`)} onClick={() => void pager.expand()}><ChevronRight aria-hidden="true" /><span>{t(`显示更多 · 共 ${total ?? preview.length} 个`, `Show more · ${total ?? preview.length} total`)}</span></button>
    </SidebarMenuSubItem>}
    {state.expanded && <>
      {state.page?.previousCursor && <SidebarMenuSubItem className="workspace-session-more-item"><button type="button" className="workspace-session-more" disabled={state.loading} aria-label={t(`${name} 的第一页`, `First page in ${name}`)} onClick={() => void pager.first()}><ChevronsLeft aria-hidden="true" /><span>{t("第一页", "First page")}</span></button></SidebarMenuSubItem>}
      {state.page?.previousCursor && <SidebarMenuSubItem className="workspace-session-more-item"><button type="button" className="workspace-session-more" disabled={state.loading} aria-label={t(`${name} 的上一页`, `Previous page in ${name}`)} onClick={() => void pager.previous()}><ChevronLeft aria-hidden="true" /><span>{t("上一页", "Previous page")}</span></button></SidebarMenuSubItem>}
      {state.page?.nextCursor && <SidebarMenuSubItem className="workspace-session-more-item"><button type="button" className="workspace-session-more" data-slot="workspace-session-more" disabled={state.loading} aria-label={t(`${name} 的下一页`, `Next page in ${name}`)} onClick={() => void pager.next()}><ChevronRight aria-hidden="true" /><span>{t("下一页", "Next page")}</span></button></SidebarMenuSubItem>}
      <SidebarMenuSubItem className="workspace-session-more-item"><button type="button" className="workspace-session-more" disabled={state.loading} aria-label={t(`收起 ${name} 的会话`, `Show fewer sessions in ${name}`)} onClick={() => void pager.collapse()}><ChevronLeft aria-hidden="true" /><span>{t("收起会话", "Show fewer")}</span></button></SidebarMenuSubItem>
    </>}
  </>;
}
