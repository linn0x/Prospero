import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { FolderKanban, FolderPlus, Plus } from "lucide-react";
import type { DesktopSnapshot, SessionInfo } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { text } from "../state";
import { workspaceChromeVisible } from "../workspace-sidebar-state";
import { ContextDock } from "./ContextDock";
import { clampDockWidth, defaultDockState, dockNeedsOverlay, readDockPreferences, updateDockPreferences, writeDockPreferences, type DockState } from "./dock-state";
import { SessionToolbar } from "./SessionToolbar";
import { sessionLabel } from "./session-presentation";

const ChatPane = lazy(() => import("../ChatPane").then((module) => ({ default: module.ChatPane })));
const TerminalPane = lazy(() => import("../TerminalPane").then((module) => ({ default: module.TerminalPane })));

function WorkspaceSession({ session, snapshot, focus, onOpenRun, onToggleFocus }: { session: SessionInfo; snapshot: DesktopSnapshot; focus: boolean; onOpenRun: (id?: string) => void; onToggleFocus: () => void }) {
  const { t } = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [width, setWidth] = useState(() => readDockPreferences().width);
  const [dock, setDock] = useState<DockState>(() => readDockPreferences().sessions.find((item) => item.id === session.id)?.state ?? defaultDockState());
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; width: number } | undefined>(undefined);
  const widthRef = useRef(width);
  widthRef.current = width;
  const chromeVisible = workspaceChromeVisible(focus);
  const overlay = dockNeedsOverlay(available, width);
  const visible = chromeVisible && dock.visible && available > 0;
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setAvailable(entry.contentRect.width); });
    observer.observe(element);
    setAvailable(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const setState = (next: DockState): void => {
    setDock(next);
    writeDockPreferences(updateDockPreferences(readDockPreferences(), session.id, next));
  };
  const saveWidth = (next: number): void => {
    const value = clampDockWidth(next);
    setWidth(value);
    writeDockPreferences({ ...readDockPreferences(), width: value });
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>, cancel: boolean): void => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (cancel) setWidth(start.width); else saveWidth(widthRef.current);
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const dispatch = snapshot.orchestration.dispatches.find((item) => text(item["sessionId"]) === session.id);
  const account = snapshot.accounts.find((item) => text(item["id"]) === session.accountId);
  return <div ref={host} className={cn("pane-workspace workspace-session-layout", focus && "is-focus")} data-dock-resizing={resizing || undefined}>
    {chromeVisible && <SessionToolbar session={session} account={account} contextVisible={dock.visible} onToggleContext={() => setState({ ...dock, visible: !dock.visible })} onToggleFocus={onToggleFocus} />}
    <div className={cn("workspace-grid", visible && !overlay && "has-dock")} style={{ "--context-dock-width": `${width}px` } as CSSProperties}>
      <main id="workspace-session-panel" role="tabpanel" aria-labelledby={chromeVisible ? `workspace-tab-${session.id}` : undefined} aria-label={focus ? sessionLabel(session) : undefined} className="workspace-primary">
        <Suspense fallback={<div className="dock-empty" role="status">{t("正在加载会话…", "Loading session…")}</div>}>
          {session.kind === "pty" ? <TerminalPane key={session.id} session={session} fontFamily={snapshot.settings.terminalFontFamily} fontSize={snapshot.settings.terminalFontSize} /> : <ChatPane key={session.id} session={session} onOpenGoal={() => onOpenRun(text(dispatch?.["runId"]) || undefined)} />}
        </Suspense>
      </main>
      {visible && !overlay && <>
        <div className="context-dock-resizer" role="separator" aria-orientation="vertical" aria-label={t("调整工具栏宽度", "Resize tools")} aria-valuemin={300} aria-valuemax={560} aria-valuenow={width} tabIndex={0} onDoubleClick={() => saveWidth(360)} onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = { pointerId: event.pointerId, startX: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          setResizing(true);
        }} onPointerMove={(event) => {
          const start = drag.current;
          if (start?.pointerId === event.pointerId) setWidth(clampDockWidth(Math.min(available - 428, start.width + start.startX - event.clientX)));
        }} onPointerUp={(event) => endDrag(event, false)} onPointerCancel={(event) => endDrag(event, true)} onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) endDrag(event, true); }} onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) { event.preventDefault(); setWidth(drag.current.width); drag.current = undefined; setResizing(false); return; }
          const next = event.key === "Home" ? 300 : event.key === "End" ? 560 : event.key === "ArrowLeft" ? width + 20 : event.key === "ArrowRight" ? width - 20 : undefined;
          if (next !== undefined) { event.preventDefault(); saveWidth(Math.min(available - 428, next)); }
        }} />
        <aside className="workspace-dock-aside" aria-label={t("会话工具", "Session tools")}><ContextDock session={session} snapshot={snapshot} state={dock} onChange={setState} /></aside>
      </>}
    </div>
    <Sheet open={visible && overlay} onOpenChange={(next) => setState({ ...dock, visible: next })}>
      <SheetContent side="right" className="workspace-dock-sheet" showCloseButton={false}>
        <SheetHeader className="sr-only"><SheetTitle>{t("会话工具", "Session tools")}</SheetTitle><SheetDescription>{t("任务、Diff、执行与工作区终端", "Task, diff, execution and workspace terminal")}</SheetDescription></SheetHeader>
        {visible && overlay && <ContextDock session={session} snapshot={snapshot} state={dock} onChange={setState} />}
      </SheetContent>
    </Sheet>
  </div>;
}

export function WorkspacePane({ snapshot, activeId, onNewSession, onOpenRun, onToggleFocus, onAddWorkspace, focus }: { snapshot: DesktopSnapshot; activeId: string | undefined; openIds: string[]; onActivate: (id: string) => void; onClose: (id: string) => void; onNewSession: (project?: string) => void; onOpenRun: (id?: string) => void; onTogglePin: (id: string) => void; onToggleFocus: () => void; onAddWorkspace: () => void; focus: boolean }) {
  const { t } = useLocale();
  const session = snapshot.daemon.sessions.find((item) => item.id === activeId);
  return <div className="workspace-view workspace-view-single">
    {session ? <WorkspaceSession key={session.id} session={session} snapshot={snapshot} focus={focus} onOpenRun={onOpenRun} onToggleFocus={onToggleFocus} /> : <Empty className="workspace-empty"><EmptyHeader><EmptyMedia variant="icon"><FolderKanban /></EmptyMedia><EmptyTitle>{t("选择工作上下文", "Choose a work context")}</EmptyTitle><EmptyDescription>{t("打开已有会话，或在项目中创建新的 Agent 会话。", "Open an existing session or create a new agent session in a project.")}</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={() => onNewSession()}><Plus />{t("新建会话", "New session")}</Button><Button variant="outline" onClick={onAddWorkspace}><FolderPlus />{t("添加工作区", "Add workspace")}</Button></EmptyContent></Empty>}
  </div>;
}
