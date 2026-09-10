import { useCallback, useEffect, useState } from "react";
import { FolderOpen, ListChecks } from "lucide-react";
import type { DesktopSnapshot, JsonObject, SessionInfo, UsageReport } from "../../../shared/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useLocale } from "../locale";
import { reportError, shortPath, text } from "../state";
import { type DockState, openDockTool, supportsTrajectory } from "./dock-state";
import { ContextTabs } from "./ContextTabs";
import { DockTerminal } from "./DockTerminal";
import { StatusMark } from "./session-presentation";
import { ProjectToolsSlot } from "../project-tools/ProjectToolsHost";
import type { DocumentTabs } from "../components/TabStrip";

export function ContextDock({ session, root, snapshot, state, active = true, onChange, onTrajectoryHost }: { session: SessionInfo | undefined; root: string; snapshot: DesktopSnapshot; state: DockState; active?: boolean; onChange: (value: DockState) => void; onTrajectoryHost?: (host: HTMLDivElement | null) => void }) {
  const { t, status } = useLocale();
  const [usage, setUsage] = useState<UsageReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [tabsHost, setTabsHost] = useState<HTMLDivElement | null>(null);
  const [documents, setDocuments] = useState<DocumentTabs>();
  const [terminalVisited, setTerminalVisited] = useState(false);
  const projectTool = state.active === "files" || state.active === "search" || state.active === "diff";
  const [projectMode, setProjectMode] = useState<"files" | "search" | "git">("files");
  const mode = projectTool ? state.active === "diff" ? "git" : state.active as "files" | "search" : projectMode;
  useEffect(() => { if (projectTool) setProjectMode(mode); }, [projectTool, mode]);
  useEffect(() => { if (state.active === "terminal") setTerminalVisited(true); }, [state.active]);
  const activateFile = useCallback(() => onChange(openDockTool(state, mode === "git" ? "diff" : mode)), [state, mode, onChange]);
  const dispatch = snapshot.orchestration.dispatches.find((item) => text(item["sessionId"]) === session?.id);
  const preview = snapshot.orchestration.tasks.find((item) => text(item["id"]) === text(dispatch?.["taskId"]));
  const taskId = text(preview?.["id"]);
  const updatedAt = Number(preview?.["updatedAt"]) || 0;
  const truncated = preview?.["specTruncated"] === true;
  const [fullTask, setFullTask] = useState<{ id: string; updatedAt: number; task: JsonObject }>();
  useEffect(() => { setLoading(false); setError(undefined); }, [state.active]);
  useEffect(() => {
    let active = true;
    if (!session || state.active !== "execution") return;
    setLoading(true);
    setError(undefined);
    void window.prospero.getUsage(session.id).then((value) => { if (active) setUsage(value); }).catch((reason) => { if (active) setError(reportError(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session?.id, state.active, revision]);
  useEffect(() => {
    let active = true;
    if (!taskId || !truncated || state.active !== "task") return;
    setLoading(true);
    setError(undefined);
    void window.prospero.getOrchestrationTask(taskId).then((task) => { if (active) setFullTask({ id: taskId, updatedAt, task }); }).catch((reason) => { if (active) setError(reportError(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [taskId, truncated, updatedAt, state.active, revision]);
  const task = preview && fullTask?.id === taskId && fullTask.updatedAt === updatedAt ? { ...fullTask.task, ...preview, spec: fullTask.task["spec"] } : preview;
  const reveal = async (): Promise<void> => {
    setError(undefined);
    setLoading(true);
    try {
      const result = await window.prospero.revealPath(root);
      if (!result.ok) throw new Error(result.error || t("无法打开工作区", "Unable to open workspace"));
    } catch (reason) { setError(reportError(reason)); } finally { setLoading(false); }
  };
  return <div className="context-dock" data-liquid-glass-scope="plain">
    <ContextTabs state={state} onChange={onChange} onHide={() => onChange({ ...state, visible: false })} onDocumentTabsHost={setTabsHost} documents={documents} trajectory={Boolean(session && supportsTrajectory(session))} />
    <div className="context-dock-panel" hidden={!projectTool} role="tabpanel" id={`dock-panel-${projectTool ? state.active : "files"}`} aria-labelledby={`dock-tab-${projectTool ? state.active : "files"}`}>
      {root ? <ProjectToolsSlot root={root} mode={mode} active={active && projectTool} tabsHost={tabsHost} onActivate={activateFile} onDocumentTabs={setDocuments} /> : <div className="dock-empty"><FolderOpen /><p>{t("添加工作区后即可浏览文件。", "Add a workspace to browse its files.")}</p></div>}
    </div>
    {session && (terminalVisited || state.active === "terminal") && <div className="context-dock-panel" hidden={state.active !== "terminal"} role="tabpanel" id="dock-panel-terminal" aria-labelledby="dock-tab-terminal"><DockTerminal session={session} root={root} snapshot={snapshot} /></div>}
    {state.active && !projectTool && state.active !== "terminal" ? <div className="context-dock-panel" role="tabpanel" id={`dock-panel-${state.active}`} aria-labelledby={`dock-tab-${state.active}`} tabIndex={0}>
      {state.active === "trajectory" && Boolean(session && supportsTrajectory(session)) ? <div className="context-trajectory-host" ref={onTrajectoryHost} /> : <div className="context-dock-content">
        {error && <div className="workspace-action-error" role="alert"><span>{error}</span><Button size="xs" variant="ghost" disabled={loading} onClick={() => state.active === "diff" ? void reveal() : setRevision((value) => value + 1)}>{t("重试", "Retry")}</Button></div>}
        {state.active === "task" && (task && session ? <>
          <div className="dock-task-title"><Badge variant="secondary">{status(text(task["status"]))}</Badge><strong>{text(task["title"])}</strong></div>
          <p className="dock-task-spec">{text(task["spec"])}</p>
          {loading && <p role="status">{t("正在加载任务…", "Loading task…")}</p>}
          <dl className="detail-list"><div><dt>Agent</dt><dd>{session.agent}</dd></div><div><dt>{t("分支", "Branch")}</dt><dd>{text(dispatch?.["branch"], "workspace")}</dd></div><div><dt>Worktree</dt><dd title={root}>{shortPath(root)}</dd></div><div><dt>{t("依赖", "Dependencies")}</dt><dd>{Array.isArray(task["deps"]) ? task["deps"].length : 0}</dd></div></dl>
        </> : <div className="dock-empty"><ListChecks /><strong>{t("未关联任务", "No linked task")}</strong><p>{t("此会话可独立使用；关联编排任务后会在这里显示。", "This session can be used independently. Linked orchestration tasks appear here.")}</p></div>)}
        {state.active === "execution" && session && <><dl className="detail-list"><div><dt>{t("状态", "Status")}</dt><dd><StatusMark status={session.status} />{status(session.status)}</dd></div><div><dt>{t("模式", "Mode")}</dt><dd>{session.kind === "pty" ? t("PTY 终端", "PTY terminal") : t("结构化会话", "Structured conversation")}</dd></div><div><dt>Agent</dt><dd>{session.agent}</dd></div><div><dt>{t("账号", "Account")}</dt><dd>{session.accountName || t("本地环境", "Local environment")}</dd></div><div><dt>{t("审批", "Approval")}</dt><dd>{session.approvalPolicy || "standard"}</dd></div><div><dt>Tokens</dt><dd>{loading ? "…" : usage?.available ? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)).toLocaleString() : t("不可用", "Unavailable")}</dd></div><div><dt>{t("会话", "Session")}</dt><dd title={session.id}>{session.id.slice(0, 12)}</dd></div></dl><div className="context-actions"><Button size="sm" variant="outline" disabled={loading} onClick={() => void reveal()}><FolderOpen />{t("打开工作区", "Open workspace")}</Button></div></>}
      </div>}
    </div> : !state.active ? <div className="dock-empty"><p>{t("工具标签已关闭，任务与终端会继续运行。", "Tool tabs are closed. Tasks and terminals keep running.")}</p><Button variant="outline" size="sm" onClick={() => onChange(openDockTool(state, "task"))}>{t("打开任务", "Open task")}</Button></div> : null}
  </div>;
}
