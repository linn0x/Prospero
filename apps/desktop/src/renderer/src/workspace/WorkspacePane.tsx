import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Files, FolderKanban, FolderPlus, GitBranch, Plus, Search } from "lucide-react";
import type { DesktopSnapshot, SessionInfo } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { text } from "../state";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { fileName } from "../project-tools/tool-state";
import type { ProjectTool } from "../../../shared/project-tools";
import { workspaceChromeVisible } from "../workspace-sidebar-state";
import { ContextDock } from "./ContextDock";
import { clampDockWidth, DOCK_DEFAULT_WIDTH, DOCK_MIN_WIDTH, workspaceDockLayout, openDockTool, sessionDockState, supportsTrajectory, readDockPreferences, updateDockPreferences, writeDockPreferences, type DockState } from "./dock-state";
import { DockSlot } from "./DockSlot";
import { SessionToolbar } from "./SessionToolbar";
import { sessionLabel } from "./session-presentation";

const ChatPane = lazy(() => import("../ChatPane").then((module) => ({ default: module.ChatPane })));
const TerminalPane = lazy(() => import("../TerminalPane").then((module) => ({ default: module.TerminalPane })));

function WorkspaceSession({ session, snapshot, focus, onOpenRun, onToggleFocus, empty }: { session: SessionInfo | undefined; empty?: ReactNode; snapshot: DesktopSnapshot; focus: boolean; onOpenRun: (id?: string) => void; onToggleFocus: () => void }) {
  const { t } = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [width, setWidth] = useState(() => readDockPreferences().width);
  const [autoWidth, setAutoWidth] = useState(() => readDockPreferences().autoWidth === true);
  const trajectory = Boolean(session && supportsTrajectory(session));
  const dockId = session?.id ?? "local-project-tools";
  const dispatch = snapshot.orchestration.dispatches.find((item) => Boolean(session) && text(item["sessionId"]) === session?.id);
  const [selectedRoot, setSelectedRoot] = useState(snapshot.projects[0] ?? "");
  const root = session ? text(dispatch?.["worktreePath"], session.cwd) : selectedRoot || snapshot.projects[0] || "";
  const { width: effectiveWidth, maxWidth, overlay } = workspaceDockLayout(available, autoWidth ? available * .48 : width);
  const [dock, setDock] = useState<DockState>(() => sessionDockState(readDockPreferences().sessions.find((item) => item.id === dockId)?.state, trajectory));
  const [trajectoryHost, setTrajectoryHost] = useState<HTMLDivElement | null>(null);
  const [dockContainer] = useState(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.className = "workspace-dock-host";
    return element;
  });
  const [dockVisited, setDockVisited] = useState(false);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; width: number; autoWidth: boolean } | undefined>(undefined);
  const widthRef = useRef(width);
  widthRef.current = width;
  const chromeVisible = workspaceChromeVisible(focus);
  const visible = chromeVisible && dock.visible && available > 0;
  useEffect(() => { if (visible) setDockVisited(true); }, [visible]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setAvailable(entry.contentRect.width); });
    observer.observe(element);
    setAvailable(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  const setState = useCallback((next: DockState): void => {
    setDock(next);
    writeDockPreferences(updateDockPreferences(readDockPreferences(), dockId, next));
  }, [dockId]);
  const openTool = (mode: ProjectTool): void => {
    setDock(current => {
      const next = openDockTool(current, mode === "git" ? "diff" : mode);
      writeDockPreferences(updateDockPreferences(readDockPreferences(), dockId, next));
      return next;
    });
    if (focus) onToggleFocus();
  };
  useEffect(() => {
    const open = (event: Event): void => {
      const detail = (event as CustomEvent<{ root: string; mode: ProjectTool }>).detail;
      if (!detail || typeof detail.root !== "string" || !["files", "search", "git"].includes(detail.mode)) return;
      if (!session) setSelectedRoot(detail.root);
      openTool(detail.mode);
    };
    const search = (event: KeyboardEvent): void => {
      if ((window.prospero.platform === "darwin" ? event.metaKey : event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault(); openTool("search");
      }
    };
    window.addEventListener("prospero:project-tools", open);
    window.addEventListener("keydown", search);
    return () => { window.removeEventListener("prospero:project-tools", open); window.removeEventListener("keydown", search); };
  }, [dockId, focus, onToggleFocus]);
  const saveWidth = (next: number): void => {
    const value = clampDockWidth(next);
    widthRef.current = value;
    setWidth(value);
    setAutoWidth(false);
    writeDockPreferences({ ...readDockPreferences(), width: value, autoWidth: false });
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>, cancel: boolean): void => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    drag.current = undefined;
    if (cancel) { setWidth(start.width); setAutoWidth(start.autoWidth); } else saveWidth(widthRef.current);
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const account = snapshot.accounts.find((item) => text(item["id"]) === session?.accountId);
  const toolbar = <>
    {chromeVisible && session && <SessionToolbar session={session} account={account} unread={snapshot.unreadSessionIds.includes(session.id)} contextVisible={dock.visible} onToggleContext={() => setState({ ...dock, visible: !dock.visible })} onToggleFocus={onToggleFocus} />}
    {chromeVisible && !session && <header className="pane-toolbar project-workspace-toolbar">
      <NativeSelect size="sm" aria-label={t("当前项目", "Current project")} value={root} onChange={event => setSelectedRoot(event.target.value)}>
        {!root && <NativeSelectOption value="">{t("选择项目", "Select project")}</NativeSelectOption>}
        {[...new Set([root, ...snapshot.projects].filter(Boolean))].map(project => <NativeSelectOption key={project} value={project}>{snapshot.projectAliases[project.toLowerCase()] || fileName(project)}</NativeSelectOption>)}
      </NativeSelect>
      <div className="pane-toolbar-actions">
        <Button variant="ghost" size="icon-sm" disabled={!root} aria-label={t("浏览项目文件", "Browse project files")} onClick={() => openTool("files")}><Files /></Button>
        <Button variant="ghost" size="icon-sm" disabled={!root} aria-label={t("搜索项目内容", "Search project contents")} onClick={() => openTool("search")}><Search /></Button>
        <Button variant="ghost" size="icon-sm" disabled={!root} aria-label={t("查看 Git 变更", "Review Git changes")} onClick={() => openTool("git")}><GitBranch /></Button>
      </div>
    </header>}
  </>;
  return <div ref={host} className={cn("pane-workspace workspace-session-layout", focus && "is-focus")} data-dock-resizing={resizing || undefined}>
    <div className={cn("workspace-grid", visible && !overlay && "has-dock")} style={{ "--context-dock-width": `${effectiveWidth}px` } as CSSProperties}>
      <main id="workspace-session-panel" role="tabpanel" aria-labelledby={chromeVisible && session ? `workspace-tab-${session.id}` : undefined} aria-label={focus && session ? sessionLabel(session) : undefined} className="workspace-primary">
        {toolbar}
        <Suspense fallback={<div className="dock-empty" role="status">{t("正在加载会话…", "Loading session…")}</div>}>
          {!session ? empty : session.kind === "pty" ? <TerminalPane key={session.id} session={session} fontFamily={snapshot.settings.terminalFontFamily} fontSize={snapshot.settings.terminalFontSize} /> : <ChatPane key={session.id} session={session} account={account} trajectoryHost={trajectory ? trajectoryHost : null} onOpenGoal={() => onOpenRun(text(dispatch?.["runId"]) || undefined)} />}
        </Suspense>
      </main>
      {visible && !overlay && <>
        <div className="context-dock-resizer" role="separator" aria-orientation="vertical" aria-label={t("调整工具栏宽度", "Resize tools")} aria-valuemin={DOCK_MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={effectiveWidth} tabIndex={0} onDoubleClick={() => saveWidth(DOCK_DEFAULT_WIDTH)} onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = { pointerId: event.pointerId, startX: event.clientX, width: effectiveWidth, autoWidth };
          widthRef.current = effectiveWidth;
          setWidth(effectiveWidth);
          setAutoWidth(false);
          event.currentTarget.setPointerCapture(event.pointerId);
          event.currentTarget.focus();
          setResizing(true);
        }} onPointerMove={(event) => {
          const start = drag.current;
          if (start?.pointerId === event.pointerId) {
            const next = Math.min(maxWidth, clampDockWidth(start.width + start.startX - event.clientX));
            widthRef.current = next;
            setWidth(next);
          }
        }} onPointerUp={(event) => endDrag(event, false)} onPointerCancel={(event) => endDrag(event, true)} onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) endDrag(event, true); }} onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) { event.preventDefault(); setWidth(drag.current.width); setAutoWidth(drag.current.autoWidth); drag.current = undefined; setResizing(false); return; }
          const next = event.key === "Home" ? DOCK_MIN_WIDTH : event.key === "End" ? maxWidth : event.key === "ArrowLeft" ? effectiveWidth + 20 : event.key === "ArrowRight" ? effectiveWidth - 20 : undefined;
          if (next !== undefined) { event.preventDefault(); saveWidth(Math.min(maxWidth, next)); }
        }} />
        <aside className="workspace-dock-aside" aria-label={t("会话工具", "Session tools")}><DockSlot container={dockContainer} /></aside>
      </>}
    </div>
    <Sheet open={visible && overlay} onOpenChange={(next) => setState({ ...dock, visible: next })}>
      <SheetContent side="right" className="workspace-dock-sheet" showCloseButton={false}>
        <SheetHeader className="sr-only"><SheetTitle>{t("会话工具", "Session tools")}</SheetTitle><SheetDescription>{t("文件、搜索、Git 与会话工具", "Files, search, Git and session tools")}</SheetDescription></SheetHeader>
        {overlay && <DockSlot container={dockContainer} />}
      </SheetContent>
    </Sheet>
    {dockContainer && (visible || dockVisited) && createPortal(<ContextDock session={session} root={root} snapshot={snapshot} state={dock} active={visible} onChange={setState} onTrajectoryHost={setTrajectoryHost} />, dockContainer)}
  </div>;
}

export function WorkspacePane({ snapshot, activeId, onNewSession, onOpenRun, onToggleFocus, onAddWorkspace, focus }: { snapshot: DesktopSnapshot; activeId: string | undefined; openIds: string[]; onActivate: (id: string) => void; onClose: (id: string) => void; onNewSession: (project?: string) => void; onOpenRun: (id?: string) => void; onTogglePin: (id: string) => void; onToggleFocus: () => void; onAddWorkspace: () => void; focus: boolean }) {
  const { t } = useLocale();
  const session = snapshot.daemon.sessions.find((item) => item.id === activeId);
  return <div className="workspace-view workspace-view-single">
    {<WorkspaceSession key={session?.id ?? "empty"} session={session} snapshot={snapshot} focus={focus} onOpenRun={onOpenRun} onToggleFocus={onToggleFocus} empty={<Empty className="workspace-empty"><EmptyHeader><EmptyMedia variant="icon"><FolderKanban /></EmptyMedia><EmptyTitle>{t("选择工作上下文", "Choose a work context")}</EmptyTitle><EmptyDescription>{t("打开已有会话，或在项目中创建新的 Agent 会话。", "Open an existing session or create a new agent session in a project.")}</EmptyDescription></EmptyHeader><EmptyContent><Button onClick={() => onNewSession()}><Plus />{t("新建会话", "New session")}</Button><Button variant="outline" onClick={onAddWorkspace}><FolderPlus />{t("添加工作区", "Add workspace")}</Button></EmptyContent></Empty>} />}
  </div>;
}
