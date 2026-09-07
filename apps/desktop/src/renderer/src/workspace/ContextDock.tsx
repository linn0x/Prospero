import { useEffect, useState } from "react";
import { FileDiff, FolderOpen, ListChecks } from "lucide-react";
import type { DesktopSnapshot, JsonObject, SessionInfo, UsageReport } from "../../../shared/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useLocale } from "../locale";
import { displayError, shortPath, text } from "../state";
import { type DockState, openDockTool } from "./dock-state";
import { ContextTabs } from "./ContextTabs";
import { DockTerminal } from "./DockTerminal";
import { StatusMark } from "./session-presentation";

export function ContextDock({ session, snapshot, state, onChange }: { session: SessionInfo; snapshot: DesktopSnapshot; state: DockState; onChange: (value: DockState) => void }) {
  const { t, status } = useLocale();
  const [usage, setUsage] = useState<UsageReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const dispatch = snapshot.orchestration.dispatches.find((item) => text(item["sessionId"]) === session.id);
  const preview = snapshot.orchestration.tasks.find((item) => text(item["id"]) === text(dispatch?.["taskId"]));
  const taskId = text(preview?.["id"]);
  const updatedAt = Number(preview?.["updatedAt"]) || 0;
  const truncated = preview?.["specTruncated"] === true;
  const [fullTask, setFullTask] = useState<{ id: string; updatedAt: number; task: JsonObject }>();
  useEffect(() => { setLoading(false); setError(undefined); }, [state.active]);
  useEffect(() => {
    let active = true;
    if (state.active !== "execution") return;
    setLoading(true);
    setError(undefined);
    void window.prospero.getUsage(session.id).then((value) => { if (active) setUsage(value); }).catch((reason) => { if (active) setError(displayError(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [session.id, state.active, revision]);
  useEffect(() => {
    let active = true;
    if (!taskId || !truncated || state.active !== "task") return;
    setLoading(true);
    setError(undefined);
    void window.prospero.getOrchestrationTask(taskId).then((task) => { if (active) setFullTask({ id: taskId, updatedAt, task }); }).catch((reason) => { if (active) setError(displayError(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [taskId, truncated, updatedAt, state.active, revision]);
  const task = preview && fullTask?.id === taskId && fullTask.updatedAt === updatedAt ? { ...fullTask.task, ...preview, spec: fullTask.task["spec"] } : preview;
  const reveal = async (): Promise<void> => {
    setError(undefined);
    setLoading(true);
    try {
      const result = await window.prospero.revealPath(text(dispatch?.["worktreePath"], session.cwd));
      if (!result.ok) throw new Error(result.error || t("无法打开工作区", "Unable to open workspace"));
    } catch (reason) { setError(displayError(reason)); } finally { setLoading(false); }
  };
  return <div className="context-dock">
    <ContextTabs state={state} onChange={onChange} onHide={() => onChange({ ...state, visible: false })} />
    {state.active ? <div className="context-dock-panel" role="tabpanel" id={`dock-panel-${state.active}`} aria-labelledby={`dock-tab-${state.active}`} tabIndex={0}>
      {state.active === "terminal" ? <DockTerminal session={session} snapshot={snapshot} /> : <div className="context-dock-content">
        {error && <div className="workspace-action-error" role="alert"><span>{error}</span><Button size="xs" variant="ghost" disabled={loading} onClick={() => state.active === "diff" ? void reveal() : setRevision((value) => value + 1)}>{t("重试", "Retry")}</Button></div>}
        {state.active === "task" && (task ? <>
          <div className="dock-task-title"><Badge variant="secondary">{status(text(task["status"]))}</Badge><strong>{text(task["title"])}</strong></div>
          <p className="dock-task-spec">{text(task["spec"])}</p>
          {loading && <p role="status">{t("正在加载任务…", "Loading task…")}</p>}
          <dl className="detail-list"><div><dt>Agent</dt><dd>{session.agent}</dd></div><div><dt>{t("分支", "Branch")}</dt><dd>{text(dispatch?.["branch"], "workspace")}</dd></div><div><dt>Worktree</dt><dd title={text(dispatch?.["worktreePath"], session.cwd)}>{shortPath(text(dispatch?.["worktreePath"], session.cwd))}</dd></div><div><dt>{t("依赖", "Dependencies")}</dt><dd>{Array.isArray(task["deps"]) ? task["deps"].length : 0}</dd></div></dl>
        </> : <div className="dock-empty"><ListChecks /><strong>{t("未关联任务", "No linked task")}</strong><p>{t("此会话可独立使用；关联编排任务后会在这里显示。", "This session can be used independently. Linked orchestration tasks appear here.")}</p></div>)}
        {state.active === "diff" && <div className="dock-empty"><FileDiff /><strong>{t("暂无结构化 Diff", "No structured diff available")}</strong><p>{t("打开工作树查看当前文件变更。", "Open the worktree to inspect current file changes.")}</p><Button size="sm" variant="outline" disabled={loading} onClick={() => void reveal()}><FolderOpen />{t("打开工作树", "Open worktree")}</Button></div>}
        {state.active === "execution" && <><dl className="detail-list"><div><dt>{t("状态", "Status")}</dt><dd><StatusMark status={session.status} />{status(session.status)}</dd></div><div><dt>{t("模式", "Mode")}</dt><dd>{session.kind === "pty" ? t("PTY 终端", "PTY terminal") : t("结构化会话", "Structured conversation")}</dd></div><div><dt>Agent</dt><dd>{session.agent}</dd></div><div><dt>{t("账号", "Account")}</dt><dd>{session.accountName || t("本地环境", "Local environment")}</dd></div><div><dt>{t("审批", "Approval")}</dt><dd>{session.approvalPolicy || "standard"}</dd></div><div><dt>Tokens</dt><dd>{loading ? "…" : usage?.available ? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)).toLocaleString() : t("不可用", "Unavailable")}</dd></div><div><dt>{t("会话", "Session")}</dt><dd title={session.id}>{session.id.slice(0, 12)}</dd></div></dl><div className="context-actions"><Button size="sm" variant="outline" disabled={loading} onClick={() => void reveal()}><FolderOpen />{t("打开工作区", "Open workspace")}</Button></div></>}
      </div>}
    </div> : <div className="dock-empty"><p>{t("工具标签已关闭，任务与终端会继续运行。", "Tool tabs are closed. Tasks and terminals keep running.")}</p><Button variant="outline" size="sm" onClick={() => onChange(openDockTool(state, "task"))}>{t("打开任务", "Open task")}</Button></div>}
  </div>;
}
