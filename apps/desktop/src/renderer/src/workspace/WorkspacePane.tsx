import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, CircleAlert, Columns2, Files, Folder, FolderPlus, ListChecks, MessageSquare, Plus, WifiOff, X } from "lucide-react";
import type { DesktopSnapshot, NativeTerminalState, SessionInfo } from "../../../shared/types";
import { attentionSummary, pendingRequests } from "../attention/attention-state";
import { Button } from "../components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { shortPath, text } from "../state";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select";
import { fileName } from "../project-tools/tool-state";
import type { ProjectTool } from "../../../shared/project-tools";
import { projectForSession, sortProjectsByRecentActivity, sortSidebarSessions, workspaceChromeVisible } from "../workspace-sidebar-state";
import { ContextDock } from "./ContextDock";
import { clampDockWidth, DOCK_DEFAULT_WIDTH, DOCK_MIN_WIDTH, workspaceDockLayout, openDockTool, sessionDockState, supportsTrajectory, readDockPreferences, updateDockPreferences, writeDockPreferences, type DockState } from "./dock-state";
import { DockSlot } from "./DockSlot";
import {
  clampSplitRatio,
  initialSplitLayoutState,
  reduceSplitLayout,
  resolveEffectiveFocusedSessionId,
  resolveSplitPeerId,
  SPLIT_RATIO_DEFAULT,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_MIN,
  SPLIT_STACKED_BREAKPOINT,
} from "./pane-layout-state";
import { SessionToolbar } from "./SessionToolbar";
import { NativeTerminalPane, supportsNativeTerminal } from "../NativeTerminalPane";
import { retainTerminalIds } from "./retained-terminals";
import { isProsperoBotSession, sessionLabel, SessionAgentIcon, StatusMark } from "./session-presentation";
import { readTerminalMousePreference, TerminalMouseToggle, TERMINAL_MOUSE_MODE_EVENT } from "./TerminalMouseToggle";

const ChatPane = lazy(() => import("../ChatPane").then((module) => ({ default: module.ChatPane })));
const TerminalPane = lazy(() => import("../TerminalPane").then((module) => ({ default: module.TerminalPane })));

function WorkspaceEmptyWorkbench({
  snapshot,
  onActivate,
  onNewSession,
  onOpenRun,
  onAddWorkspace,
}: {
  snapshot: DesktopSnapshot;
  onActivate: (id: string) => void;
  onNewSession: (project?: string) => void;
  onOpenRun: (runId?: string) => void;
  onAddWorkspace: () => void;
}) {
  const { t, status } = useLocale();
  const attention = useMemo(() => attentionSummary(snapshot), [snapshot]);
  const nonBotSessions = useMemo(
    () => snapshot.daemon.sessions.filter((item) => !isProsperoBotSession(item) && !item.archived && !snapshot.archivedSessionIds.includes(item.id)),
    [snapshot.archivedSessionIds, snapshot.daemon.sessions],
  );
  const activeSessions = useMemo(
    () => sortSidebarSessions(
      nonBotSessions.filter((item) => ["running", "starting", "waiting_approval", "waiting_input"].includes(item.status)),
      undefined,
      snapshot.pinnedSessionIds,
      snapshot.unreadSessionIds,
    ),
    [nonBotSessions, snapshot.pinnedSessionIds, snapshot.unreadSessionIds],
  );
  const recentSessions = useMemo(
    () => (activeSessions.length > 0 ? activeSessions : sortSidebarSessions(nonBotSessions, undefined, snapshot.pinnedSessionIds, snapshot.unreadSessionIds)).slice(0, 6),
    [activeSessions, nonBotSessions, snapshot.pinnedSessionIds, snapshot.unreadSessionIds],
  );
  const recentProjects = useMemo(
    () => sortProjectsByRecentActivity(snapshot.projects, snapshot.daemon.sessions).slice(0, 8),
    [snapshot.daemon.sessions, snapshot.projects],
  );
  const shortcutHint = window.prospero.platform === "darwin" ? "⌘N" : "Ctrl+N";

  return (
    <div className="workspace-empty workspace-empty-workbench">
      <div className="workbench-inner">
        <header className="workbench-header">
          <div>
            <h2>{t("工作台", "Workbench")}</h2>
            <p>{t("选择工作区或恢复会话，快速进入开发状态", "Resume a recent session or launch a new workspace context")}</p>
          </div>
          <div className="workbench-actions">
            <Button size="sm" onClick={() => onNewSession()}>
              <Plus data-icon="inline-start" />
              {t("新建会话", "New session")}
              <kbd className="workbench-kbd">{shortcutHint}</kbd>
            </Button>
            <Button variant="outline" size="sm" onClick={onAddWorkspace}>
              <FolderPlus data-icon="inline-start" />
              {t("添加工作区", "Add workspace")}
            </Button>
          </div>
        </header>

        {(attention.total > 0 || !snapshot.daemon.running) && (
          <section className="workbench-section" aria-label={t("待处理事项", "Needs attention")}>
            <div className="workbench-section-head">
              <span>{t("待处理", "Needs attention")}</span>
              <span>{!snapshot.daemon.running ? Math.max(1, attention.total) : attention.total}</span>
            </div>
            <div className="workbench-list">
              {!snapshot.daemon.running && (
                <button
                  type="button"
                  className="workbench-row is-danger"
                  disabled={snapshot.daemon.starting}
                  onClick={() => void window.prospero.startDaemon()}
                >
                  <WifiOff className="workbench-row-icon tone-danger" />
                  <strong className="truncate">{snapshot.daemon.starting ? t("正在连接本地服务…", "Connecting to local daemon…") : t("Daemon 离线", "Daemon is offline")}</strong>
                  <span className="workbench-path">{snapshot.daemon.lastError || t("点击启动服务以继续会话", "Click to reconnect local runtime")}</span>
                  <span className="workbench-status">{snapshot.daemon.starting ? t("启动中", "Starting") : t("重连", "Reconnect")}</span>
                </button>
              )}
              {attention.approvalSessions.slice(0, 3).map((item) => (
                <button type="button" key={`wb-app:${item.id}`} className="workbench-row" onClick={() => onActivate(item.id)}>
                  <ListChecks className="workbench-row-icon tone-warning" />
                  <strong className="truncate">{sessionLabel(item)}</strong>
                  <span className="workbench-tag">{t(`${pendingRequests(item, "approvals")} 项确认`, `${pendingRequests(item, "approvals")} approval`)}</span>
                  <span className="workbench-path">{shortPath(item.cwd)}</span>
                  <ArrowRight className="workbench-arrow" />
                </button>
              ))}
              {attention.questionSessions.slice(0, 3).map((item) => (
                <button type="button" key={`wb-q:${item.id}`} className="workbench-row" onClick={() => onActivate(item.id)}>
                  <MessageSquare className="workbench-row-icon tone-warning" />
                  <strong className="truncate">{sessionLabel(item)}</strong>
                  <span className="workbench-tag">{t(`${pendingRequests(item, "questions")} 个回复`, `${pendingRequests(item, "questions")} reply`)}</span>
                  <span className="workbench-path">{shortPath(item.cwd)}</span>
                  <ArrowRight className="workbench-arrow" />
                </button>
              ))}
              {attention.gates.slice(0, 2).map((gate) => (
                <button type="button" key={`wb-gate:${text(gate["id"])}`} className="workbench-row" onClick={() => onOpenRun(text(gate["runId"]))}>
                  <ListChecks className="workbench-row-icon tone-warning" />
                  <strong className="truncate">{attention.context(gate).title || text(gate["question"], t("任务需要确认", "Gate pending"))}</strong>
                  <span className="workbench-tag">Gate</span>
                  <span className="workbench-path">{attention.context(gate).project}</span>
                  <ArrowRight className="workbench-arrow" />
                </button>
              ))}
              {attention.tasks.slice(0, 2).map((task) => (
                <button type="button" key={`wb-task:${text(task["id"])}`} className="workbench-row" onClick={() => onOpenRun(text(task["runId"]))}>
                  <CircleAlert className="workbench-row-icon tone-danger" />
                  <strong className="truncate">{text(task["title"], t("任务失败", "Task failed"))}</strong>
                  <span className="workbench-tag">{status(text(task["status"]))}</span>
                  <span className="workbench-path">{attention.context(task).project}</span>
                  <ArrowRight className="workbench-arrow" />
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="workbench-section" aria-label={activeSessions.length > 0 ? t("活跃会话", "Active sessions") : t("最近会话", "Recent sessions")}>
          <div className="workbench-section-head">
            <span>{activeSessions.length > 0 ? t("活跃会话", "Active sessions") : t("最近会话", "Recent sessions")}</span>
            <span>{recentSessions.length}</span>
          </div>
          {recentSessions.length > 0 ? (
            <div className="workbench-list">
              {recentSessions.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="workbench-row"
                  title={`${sessionLabel(item)} · ${item.cwd}`}
                  onClick={() => onActivate(item.id)}
                >
                  <SessionAgentIcon agent={item.agent} unread={snapshot.unreadSessionIds.includes(item.id)} />
                  <strong className="truncate">{sessionLabel(item)}</strong>
                  <span className="workbench-tag">{item.kind === "pty" ? (item.agent === "shell" ? "Shell" : "TUI") : "Chat"}</span>
                  <span className="workbench-path">{shortPath(item.cwd)}</span>
                  <StatusMark status={item.status} unread={snapshot.unreadSessionIds.includes(item.id)} pendingPermissions={item.pendingPermissions} pendingQuestions={item.pendingQuestions} busySince={item.busySince} />
                  <span className="workbench-status">{status(item.status)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="workbench-empty-hint">
              {t("暂无进行中或最近的会话，点击上方「新建会话」开始。", "No active or recent sessions yet. Click New session above to begin.")}
            </div>
          )}
        </section>

        <section className="workbench-section" aria-label={t("工作区", "Workspaces")}>
          <div className="workbench-section-head">
            <span>{t("最近工作区", "Recent workspaces")}</span>
            <span>{snapshot.projects.length}</span>
          </div>
          {recentProjects.length > 0 ? (
            <div className="workbench-list">
              {recentProjects.map((project) => {
                const name = snapshot.projectAliases[project.toLowerCase()] || fileName(project) || project;
                const projectSessions = nonBotSessions
                  .filter((item) => projectForSession([project], item))
                  .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
                const latest = projectSessions[0];
                const runningCount = projectSessions.filter((item) => ["running", "starting", "waiting_approval", "waiting_input"].includes(item.status)).length;
                return (
                  <div key={project} className="workbench-project-row">
                    <button
                      type="button"
                      className="workbench-row"
                      title={project}
                      onClick={() => (latest ? onActivate(latest.id) : onNewSession(project))}
                    >
                      <Folder className="workbench-row-icon" />
                      <strong className="truncate">{name}</strong>
                      <span className="workbench-path">{shortPath(project)}</span>
                      <span className="workbench-status">
                        {runningCount > 0
                          ? t(`${runningCount} 活跃`, `${runningCount} active`)
                          : t(`${projectSessions.length} 会话`, `${projectSessions.length} sessions`)}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="workbench-project-add"
                      aria-label={t(`在 ${name} 中新建会话`, `New session in ${name}`)}
                      title={t(`在 ${name} 中新建会话`, `New session in ${name}`)}
                      onClick={() => onNewSession(project)}
                    >
                      <Plus />
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="workbench-empty-hint">
              <span>{t("尚未添加工作区，选择一个本地项目文件夹即可启动 Agent。", "No workspaces added yet. Add a local folder to get started.")}</span>
              <Button variant="outline" size="xs" onClick={onAddWorkspace}>
                <FolderPlus data-icon="inline-start" />
                {t("选择文件夹", "Choose folder")}
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function WorkspaceSession({ session, snapshot, focus, onOpenRun, onOpenSession, onSwitchBotSession, onToggleFocus, onMissingSession, onNativeFocus, empty, onSplit, active = true, focused = true, primary = true }: { onSplit?: (() => void) | undefined; active?: boolean; focused?: boolean; primary?: boolean; session: SessionInfo | undefined; empty?: ReactNode; snapshot: DesktopSnapshot; focus: boolean; onOpenRun: (id?: string) => void; onOpenSession?: (id: string) => void; onSwitchBotSession?: ((session: SessionInfo) => void) | undefined; onToggleFocus: () => void; onMissingSession: (id: string) => void; onNativeFocus?: (id: string) => void }) {
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
  const [localSelection, setLocalSelection] = useState(() => readTerminalMousePreference(undefined, session?.id));
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [nativeState, setNativeState] = useState<NativeTerminalState>({ connected: false, syncing: true, controller: false, exited: false, readOnly: true });
  const updateNativeAvailability = useCallback((available: boolean): void => setNativeAvailable(available), []);
  const updateNativeState = useCallback((state: NativeTerminalState): void => setNativeState(state), []);
  const nativeAction = useCallback((action: "acquire" | "takeover" | "release" | "reconnect"): void => {
    if (!session) return;
    window.dispatchEvent(new CustomEvent("prospero:native-terminal-action", { detail: { sessionId: session.id, action } }));
  }, [session?.id]);
  useEffect(() => {
    setLocalSelection(readTerminalMousePreference(undefined, session?.id));
    const sync = (event: Event): void => {
      if (event.type === "storage") { setLocalSelection(readTerminalMousePreference(undefined, session?.id)); return; }
      const value = (event as CustomEvent<{ sessionId?: string; localSelection?: boolean }>).detail;
      if (value?.sessionId === session?.id && typeof value.localSelection === "boolean") setLocalSelection(value.localSelection);
    };
    window.addEventListener(TERMINAL_MOUSE_MODE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(TERMINAL_MOUSE_MODE_EVENT, sync); window.removeEventListener("storage", sync); };
  }, [session?.id]);
  const [trajectoryHost, setTrajectoryHost] = useState<HTMLDivElement | null>(null);
  const [dockContainer] = useState(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.className = "workspace-dock-host";
    return element;
  });
  const [dockVisited, setDockVisited] = useState(false);
  const [resizing, setResizing] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const resizerRef = useRef<HTMLDivElement>(null);
  const dockDragFrame = useRef<number | undefined>(undefined);
  const drag = useRef<{ pointerId: number; startX: number; width: number; autoWidth: boolean } | undefined>(undefined);
  const widthRef = useRef(width);
  widthRef.current = width;
  useEffect(() => () => { if (dockDragFrame.current !== undefined) cancelAnimationFrame(dockDragFrame.current); }, []);
  const chromeVisible = workspaceChromeVisible(focus);
  const sessionRuntimeKey = session ? `${session.id}:${session.nativeSession?.runtimeId ?? "legacy"}` : undefined;
  const liveNativeSessionKeyRef = useRef<string | undefined>(undefined);
  if (session && supportsNativeTerminal(session)) {
    liveNativeSessionKeyRef.current = sessionRuntimeKey;
  } else if (!session || session.kind !== "pty" || session.terminalMode !== "events" || liveNativeSessionKeyRef.current !== sessionRuntimeKey) {
    liveNativeSessionKeyRef.current = undefined;
  }
  const nativeTerminal = Boolean(session && (supportsNativeTerminal(session) || liveNativeSessionKeyRef.current === sessionRuntimeKey));
  useEffect(() => {
    if (!nativeTerminal) {
      setNativeAvailable(false);
      setNativeState({ connected: false, syncing: true, controller: false, exited: false, readOnly: true });
    }
  }, [nativeTerminal]);
  const visible = active && focused && chromeVisible && dock.visible && available > 0;
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
      if (!active || !focused) return;
      const detail = (event as CustomEvent<{ root: string; mode: ProjectTool }>).detail;
      if (!detail || typeof detail.root !== "string" || !["files", "search", "git"].includes(detail.mode)) return;
      if (!session) setSelectedRoot(detail.root);
      openTool(detail.mode);
    };
    const search = (event: KeyboardEvent): void => {
      if (!active || !focused || event.defaultPrevented || event.isComposing || event.altKey) return;
      if ((window.prospero.platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault(); openTool("search");
      }
    };
    window.addEventListener("prospero:project-tools", open);
    window.addEventListener("keydown", search);
    return () => { window.removeEventListener("prospero:project-tools", open); window.removeEventListener("keydown", search); };
  }, [active, focused, dockId, focus, onToggleFocus]);
  const applyDockDragWidth = (next: number): void => {
    resizerRef.current?.setAttribute("aria-valuenow", String(Math.round(next)));
    gridRef.current?.style.setProperty("--context-dock-width", `${next}px`);
  };
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
    if (dockDragFrame.current !== undefined) {
      cancelAnimationFrame(dockDragFrame.current);
      dockDragFrame.current = undefined;
    }
    if (cancel) {
      widthRef.current = start.width;
      applyDockDragWidth(start.width);
      setWidth(start.width);
      setAutoWidth(start.autoWidth);
    } else {
      applyDockDragWidth(widthRef.current);
      saveWidth(widthRef.current);
    }
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const account = snapshot.accounts.find((item) => text(item["id"]) === session?.accountId);
  const toolbar = <>
    {chromeVisible && session && <SessionToolbar onSplit={onSplit} localSelection={localSelection} onLocalSelectionChange={setLocalSelection} nativeTerminal={nativeAvailable} nativeTerminalState={nativeState} onNativeTerminalAction={nativeAction} session={session} account={account} unread={snapshot.unreadSessionIds.includes(session.id)} contextVisible={dock.visible} onToggleContext={() => setState({ ...dock, visible: !dock.visible })} onToggleFocus={onToggleFocus} />}
    {chromeVisible && !session && <header className="pane-toolbar project-workspace-toolbar">
      <NativeSelect size="sm" aria-label={t("当前项目", "Current project")} value={root} onChange={event => setSelectedRoot(event.target.value)}>
        {!root && <NativeSelectOption value="">{t("选择项目", "Select project")}</NativeSelectOption>}
        {[...new Set([root, ...snapshot.projects].filter(Boolean))].map(project => <NativeSelectOption key={project} value={project}>{snapshot.projectAliases[project.toLowerCase()] || fileName(project)}</NativeSelectOption>)}
      </NativeSelect>
      <div className="pane-toolbar-actions">
        <Button variant="ghost" size="sm" disabled={!root} aria-label={t("切换工具栏", "Toggle tools")} aria-pressed={dock.visible} onClick={() => setState({ ...dock, visible: !dock.visible })}><Files />{t("工具", "Tools")}</Button>
      </div>
    </header>}
  </>;
  return <div ref={host} className={cn("pane-workspace workspace-session-layout", focus && "is-focus")} data-dock-resizing={resizing || undefined}>
    <div ref={gridRef} className={cn("workspace-grid", visible && !overlay && "has-dock")} style={{ "--context-dock-width": `${effectiveWidth}px` } as CSSProperties}>
      <main id={active ? primary ? "workspace-session-panel" : "workspace-secondary-panel" : undefined} role="tabpanel" aria-labelledby={chromeVisible && session ? `workspace-tab-${session.id}` : undefined} aria-label={focus && session ? sessionLabel(session) : undefined} className="workspace-primary">
        {toolbar}
        {focus && session?.kind === "pty" && !nativeAvailable && <div className="workspace-focus-controls"><TerminalMouseToggle sessionId={session.id} localSelection={localSelection} onChange={setLocalSelection} /></div>}
        <Suspense fallback={<div className="dock-empty" role="status">{t("正在加载会话…", "Loading session…")}</div>}>
          {!session ? empty : session.kind === "pty" ? nativeTerminal ? <NativeTerminalPane localSelection={localSelection} key={`${session.id}:${session.nativeSession?.runtimeId ?? "legacy"}`} session={session} fontFamily={snapshot.settings.terminalFontFamily} fontSize={snapshot.settings.terminalFontSize} active={active} focused={focused} onMissingSession={onMissingSession} onToggleFocus={onToggleFocus} onNativeFocus={onNativeFocus ?? (() => undefined)} onNativeAvailabilityChange={updateNativeAvailability} onNativeStateChange={updateNativeState} /> : <TerminalPane localSelection={localSelection} key={`${session.id}:${session.nativeSession?.runtimeId ?? "legacy"}`} session={session} fontFamily={snapshot.settings.terminalFontFamily} fontSize={snapshot.settings.terminalFontSize} active={active} focused={focused} onMissingSession={onMissingSession} /> : <ChatPane key={`${session.id}:${session.nativeSession?.runtimeId ?? "legacy"}`} session={session} account={account} snapshot={snapshot} onOpenSession={onOpenSession} onSwitchBotSession={onSwitchBotSession} trajectoryHost={trajectory ? trajectoryHost : null} onOpenGoal={text(dispatch?.["runId"]) ? () => onOpenRun(text(dispatch?.["runId"])) : undefined} onMissingSession={onMissingSession} />}
        </Suspense>
      </main>
      {visible && !overlay && <>
        <div ref={resizerRef} className="context-dock-resizer" role="separator" aria-orientation="vertical" aria-label={t("调整工具栏宽度", "Resize tools")} aria-valuemin={DOCK_MIN_WIDTH} aria-valuemax={maxWidth} aria-valuenow={effectiveWidth} tabIndex={0} onDoubleClick={() => saveWidth(DOCK_DEFAULT_WIDTH)} onPointerDown={(event) => {
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
            resizerRef.current?.setAttribute("aria-valuenow", String(Math.round(next)));
            if (dockDragFrame.current === undefined) {
              dockDragFrame.current = requestAnimationFrame(() => {
                dockDragFrame.current = undefined;
                gridRef.current?.style.setProperty("--context-dock-width", `${widthRef.current}px`);
              });
            }
          }
        }} onPointerUp={(event) => endDrag(event, false)} onPointerCancel={(event) => endDrag(event, true)} onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) endDrag(event, true); }} onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) {
            event.preventDefault();
            if (dockDragFrame.current !== undefined) {
              cancelAnimationFrame(dockDragFrame.current);
              dockDragFrame.current = undefined;
            }
            widthRef.current = drag.current.width;
            applyDockDragWidth(drag.current.width);
            setWidth(drag.current.width);
            setAutoWidth(drag.current.autoWidth);
            drag.current = undefined;
            setResizing(false);
            return;
          }
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

type WorkspacePaneProps = {
  active?: boolean;
  snapshot: DesktopSnapshot;
  activeId: string | undefined;
  openIds: string[];
  onFocusedSessionChange?: (id: string | undefined) => void;
  onActivate: (id: string) => void;
  onSwitchBotSession?: ((session: SessionInfo) => void) | undefined;
  onClose: (id: string) => void;
  onNewSession: (project?: string) => void;
  onOpenRun: (id?: string) => void;
  onTogglePin: (id: string) => void;
  onToggleFocus: () => void;
  onAddWorkspace: () => void;
  onMissingSession: (id: string) => void;
  focus: boolean;
};

export const WorkspacePane = memo(function WorkspacePane({ active = true, snapshot, activeId, openIds, onActivate, onSwitchBotSession, onNewSession, onOpenRun, onToggleFocus, onAddWorkspace, onMissingSession, onFocusedSessionChange, focus }: WorkspacePaneProps) {
  const { t } = useLocale();
  const session = snapshot.daemon.sessions.find(item => item.id === activeId);
  const [splitLayout, dispatchSplitLayout] = useReducer(reduceSplitLayout, activeId, initialSplitLayoutState);
  const { focusedId, ratio, stacked } = splitLayout;
  const [splitResizing, setSplitResizing] = useState(false);
  const stack = useRef<HTMLDivElement>(null);
  const splitResizerRef = useRef<HTMLDivElement>(null);
  const splitDragFrame = useRef<number | undefined>(undefined);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const drag = useRef<{ pointer: number; ratio: number } | undefined>(undefined);
  useEffect(() => () => { if (splitDragFrame.current !== undefined) cancelAnimationFrame(splitDragFrame.current); }, []);
  const candidates = openIds.map(id => snapshot.daemon.sessions.find(item => item.id === id && id !== activeId)).filter((item): item is SessionInfo => Boolean(item));
  const peerId = resolveSplitPeerId(splitLayout, activeId);
  const splitSession = session ? candidates.find(item => item.id === peerId) : undefined;
  const [recentTerminals, setRecentTerminals] = useState<string[]>([]);
  const retained = retainTerminalIds(retainTerminalIds(recentTerminals, splitSession?.kind === "pty" ? splitSession.id : undefined), session?.kind === "pty" ? session.id : undefined);
  if (retained.length !== recentTerminals.length || retained.some((id, index) => id !== recentTerminals[index])) setRecentTerminals(retained);
  const terminalSessions = retained.map(id => snapshot.daemon.sessions.find(item => item.id === id && item.kind === "pty")).filter((item): item is SessionInfo => Boolean(item));
  useEffect(() => {
    dispatchSplitLayout({ type: "sync_active", activeId });
  }, [activeId]);
  useEffect(() => {
    dispatchSplitLayout({ type: "reconcile_visible", splitSessionId: splitSession?.id });
  }, [activeId, focusedId, splitSession?.id]);
  useEffect(() => {
    const element = stack.current;
    if (!element) return;
    const measure = (): void => dispatchSplitLayout({ type: "set_stacked", stacked: element.clientWidth < SPLIT_STACKED_BREAKPOINT });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    onFocusedSessionChange?.(resolveEffectiveFocusedSessionId({ active, activeId, focusedId, splitSessionId: splitSession?.id }));
  }, [active, activeId, focusedId, splitSession?.id, onFocusedSessionChange]);
  const focusSession = (id: string): void => {
    dispatchSplitLayout({ type: "focus_session", sessionId: id });
    onFocusedSessionChange?.(id);
    if (snapshot.unreadSessionIds.includes(id)) void window.prospero.setSessionUnread(id, false);
  };
  const applySplitRatio = (next: number): void => {
    splitResizerRef.current?.setAttribute("aria-valuenow", String(Math.round(next)));
    stack.current?.style.setProperty(stacked ? "grid-template-rows" : "grid-template-columns", `${next}fr 6px ${100 - next}fr`);
  };
  const closeSplit = (): void => { dispatchSplitLayout({ type: "close_split" }); };
  const endDrag = (event: PointerEvent<HTMLDivElement>, cancel: boolean): void => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = undefined;
    if (splitDragFrame.current !== undefined) {
      cancelAnimationFrame(splitDragFrame.current);
      splitDragFrame.current = undefined;
    }
    const nextRatio = cancel ? current.ratio : ratioRef.current;
    ratioRef.current = nextRatio;
    applySplitRatio(nextRatio);
    dispatchSplitLayout({ type: "set_ratio", ratio: nextRatio });
    setSplitResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const primaryNonPtyFocused = splitSession ? focusedId === session?.id : true;
  return <div className="workspace-view workspace-view-single workspace-multipane" data-split-resizing={splitResizing || undefined}>
    {session && splitSession && <div className="workspace-split-controls">
      <span className="workspace-split-label"><Columns2 />{t("分屏", "Split view")}</span>
      {splitSession && <><NativeSelect size="sm" aria-label={t("分屏会话", "Split session")} value={splitSession.id} onChange={event => dispatchSplitLayout({ type: "open_split", splitId: event.target.value })}>{candidates.map(item => <NativeSelectOption key={item.id} value={item.id}>{sessionLabel(item)}</NativeSelectOption>)}</NativeSelect><Button size="icon-xs" variant="ghost" aria-label={t("关闭分屏", "Close split view")} onClick={closeSplit}><X /></Button></>}
    </div>}
    <div ref={stack} className={cn("workspace-session-stack", splitSession && "is-split", stacked && "is-stacked")} style={splitSession ? { [stacked ? "gridTemplateRows" : "gridTemplateColumns"]: `${ratio}fr 6px ${100 - ratio}fr` } : undefined}>
      {terminalSessions.map(item => {
        const primary = item.id === activeId;
        const visible = active && (primary || item.id === splitSession?.id);
        return <div key={item.id} className="workspace-session-slot" data-position={primary ? "primary" : "secondary"} data-focused={focusedId === item.id || undefined} inert={!visible} aria-hidden={!visible} style={visible ? undefined : { position: "absolute", inset: 0, visibility: "hidden", pointerEvents: "none" }} onPointerDownCapture={() => visible && focusSession(item.id)} onFocusCapture={() => visible && focusSession(item.id)}>
          <WorkspaceSession onSplit={primary && !splitSession && candidates.length > 0 ? () => dispatchSplitLayout({ type: "open_split", splitId: candidates[0]?.id }) : undefined} session={item} active={visible} focused={focusedId === item.id} primary={primary} snapshot={snapshot} focus={focus} onOpenRun={onOpenRun} onOpenSession={onActivate} onSwitchBotSession={onSwitchBotSession} onToggleFocus={onToggleFocus} onMissingSession={onMissingSession} onNativeFocus={focusSession} />
        </div>;
      })}
      {splitSession && <div ref={splitResizerRef} className="workspace-split-resizer" role="separator" aria-orientation={stacked ? "horizontal" : "vertical"} aria-label={t("调整分屏大小", "Resize split view")} aria-valuemin={SPLIT_RATIO_MIN} aria-valuemax={SPLIT_RATIO_MAX} aria-valuenow={Math.round(ratio)} tabIndex={0} onDoubleClick={() => dispatchSplitLayout({ type: "set_ratio", ratio: SPLIT_RATIO_DEFAULT })} onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag.current = { pointer: event.pointerId, ratio };
        ratioRef.current = ratio;
        setSplitResizing(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
      }} onPointerMove={event => {
        if (drag.current?.pointer !== event.pointerId || !stack.current) return;
        const rect = stack.current.getBoundingClientRect();
        const next = clampSplitRatio(100 * (stacked ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width));
        ratioRef.current = next;
        splitResizerRef.current?.setAttribute("aria-valuenow", String(Math.round(next)));
        if (splitDragFrame.current === undefined) {
          splitDragFrame.current = requestAnimationFrame(() => {
            splitDragFrame.current = undefined;
            applySplitRatio(ratioRef.current);
          });
        }
      }} onPointerUp={event => endDrag(event, false)} onPointerCancel={event => endDrag(event, true)} onLostPointerCapture={event => endDrag(event, true)} onKeyDown={event => {
        if (event.key === "Escape" && drag.current) {
          if (splitDragFrame.current !== undefined) {
            cancelAnimationFrame(splitDragFrame.current);
            splitDragFrame.current = undefined;
          }
          ratioRef.current = drag.current.ratio;
          applySplitRatio(drag.current.ratio);
          dispatchSplitLayout({ type: "set_ratio", ratio: drag.current.ratio });
          setSplitResizing(false);
          drag.current = undefined;
          event.preventDefault();
          return;
        }
        const next = event.key === "Home" ? SPLIT_RATIO_MIN : event.key === "End" ? SPLIT_RATIO_MAX : ["ArrowLeft", "ArrowUp"].includes(event.key) ? ratio - 5 : ["ArrowRight", "ArrowDown"].includes(event.key) ? ratio + 5 : undefined;
        if (next !== undefined) { event.preventDefault(); dispatchSplitLayout({ type: "set_ratio", ratio: next }); }
      }} />}
      {session?.kind !== "pty" && <div className="workspace-session-slot" data-position="primary" data-focused={primaryNonPtyFocused || undefined} onPointerDownCapture={() => active && session && focusSession(session.id)} onFocusCapture={() => active && session && focusSession(session.id)}><WorkspaceSession key={session?.id ?? "empty"} onSplit={session && !splitSession && candidates.length > 0 ? () => dispatchSplitLayout({ type: "open_split", splitId: candidates[0]?.id }) : undefined} active={active} focused={primaryNonPtyFocused} primary={true} snapshot={snapshot} session={session} focus={focus} onOpenRun={onOpenRun} onOpenSession={onActivate} onSwitchBotSession={onSwitchBotSession} onToggleFocus={onToggleFocus} onMissingSession={onMissingSession} empty={<WorkspaceEmptyWorkbench snapshot={snapshot} onActivate={onActivate} onNewSession={onNewSession} onOpenRun={onOpenRun} onAddWorkspace={onAddWorkspace} />} /></div>}
      {splitSession && splitSession.kind !== "pty" && <div key={splitSession.id} className="workspace-session-slot" data-position="secondary" data-focused={focusedId === splitSession.id || undefined} inert={!active} aria-hidden={!active} onPointerDownCapture={() => active && focusSession(splitSession.id)} onFocusCapture={() => active && focusSession(splitSession.id)}><WorkspaceSession session={splitSession} active={active} focused={focusedId === splitSession.id} primary={false} snapshot={snapshot} focus={focus} onOpenRun={onOpenRun} onOpenSession={onActivate} onSwitchBotSession={onSwitchBotSession} onToggleFocus={onToggleFocus} onMissingSession={onMissingSession} /></div>}
    </div>
  </div>;
}, (previous, next) => {
  if (!previous.active && !next.active && previous.activeId === next.activeId) return true;
  return previous.active === next.active
    && previous.snapshot === next.snapshot
    && previous.activeId === next.activeId
    && previous.openIds === next.openIds
    && previous.focus === next.focus
    && previous.onActivate === next.onActivate
    && previous.onSwitchBotSession === next.onSwitchBotSession
    && previous.onClose === next.onClose
    && previous.onNewSession === next.onNewSession
    && previous.onOpenRun === next.onOpenRun
    && previous.onTogglePin === next.onTogglePin
    && previous.onToggleFocus === next.onToggleFocus
    && previous.onAddWorkspace === next.onAddWorkspace
    && previous.onMissingSession === next.onMissingSession
    && previous.onFocusedSessionChange === next.onFocusedSessionChange;
});
