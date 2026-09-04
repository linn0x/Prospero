import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, Bot, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Clock3, Columns3, GitBranch, GitPullRequestArrow, LibraryBig, LoaderCircle, Network, PanelLeftClose, PanelLeftOpen, Pause, Play, Plus, RefreshCw, Rocket, Save, ShieldQuestion, Sparkles, Square, Trash2, Workflow } from "lucide-react";
import type { DesktopSnapshot, JsonObject, WorkflowTemplate } from "../../shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { RunGraph } from "./RunGraph";
import { array, displayError, number, record, text } from "./state";
import { useLocale } from "./locale";
import { deriveTaskBoardStates, prioritizeRuns, prioritizeWorktrees, runListLabel, runTimelineItems, worktreeNeedsAttention, type TaskBoardColumnId } from "./orchestration-utils";
import {
  defaultSessionLaunchAccountId,
  isLaunchableWorktreeAsset,
  sessionLaunchAccounts,
} from "../../shared/session-launch-options";
import {
  automationStartParams,
  type OrchestrationWorkerAgent,
  workerStartParams,
} from "./orchestration-launch";

const operationId = (): string => crypto.randomUUID();

type RunView = "board" | "dag" | "timeline";
const COMPACT_RUN_LIST_QUERY = "(max-width: 1349px)";
const WORKTREE_PAGE_SIZE = 12;
const WORKTREE_ATTENTION_PREVIEW = 5;
const BOARD_COLUMN_PAGE_SIZE = 8;
const TIMELINE_PAGE_SIZE = 120;
const DEPENDENCY_OPTION_LIMIT = 80;

function initialRunView(): RunView {
  try {
    const saved = localStorage.getItem("prospero.run-task-view");
    return saved === "board" || saved === "timeline" || saved === "dag" ? saved : "dag";
  } catch {
    return "dag";
  }
}

function FreeformGateDecision({
  submitting,
  onResolve,
}: {
  submitting: boolean;
  onResolve: (decision: string) => Promise<void>;
}) {
  const { t } = useLocale();
  const [decision, setDecision] = useState("");

  const submit = async (): Promise<void> => {
    const value = decision.trim();
    if (!value || submitting) return;
    await onResolve(value);
  };

  return <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <Input
      value={decision}
      maxLength={20_000}
      disabled={submitting}
      onChange={(event) => setDecision(event.target.value)}
      aria-label={t("输入 Gate 决策", "Enter gate decision")}
      placeholder={t("输入决定或补充说明", "Enter a decision or additional context")}
    />
    <button type="submit" disabled={!decision.trim() || submitting}>{submitting ? t("提交中…", "Submitting…") : t("确认", "Confirm")}</button>
  </form>;
}

export function OrchestrationPane({ snapshot, onOpenSession, onNewSession, coordinatorSessionId, initialRunId, initialTaskId }: { snapshot: DesktopSnapshot; onOpenSession: (id: string) => void; onNewSession: (workspace: string) => void; coordinatorSessionId?: string | undefined; initialRunId?: string | undefined; initialTaskId?: string | undefined }) {
  const { t, status } = useLocale();
  const { runs, tasks, dispatches, gates, worktreeAssets } = snapshot.orchestration;
  const orderedRuns = useMemo(() => prioritizeRuns(runs), [runs]);
  const [selectedRunId, setSelectedRunId] = useState<string>(
    initialRunId ?? text(orderedRuns[0]?.["id"]),
  );
  const [showCreate, setShowCreate] = useState(false);
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [objective, setObjective] = useState("");
  const [nodeLines, setNodeLines] = useState(() => t("分析需求\n实现功能\n验证与交付", "Analyze requirements\nImplement the feature\nValidate and deliver"));
  const [taskTitle, setTaskTitle] = useState("");
  const [taskSpec, setTaskSpec] = useState("");
  const [taskDeps, setTaskDeps] = useState<string[]>([]);
  const [taskDependencyQuery, setTaskDependencyQuery] = useState("");
  const [taskSkills, setTaskSkills] = useState("");
  const [graphSkills, setGraphSkills] = useState("");
  const [workerAgent, setWorkerAgent] = useState<OrchestrationWorkerAgent>("codex");
  const [workerProject, setWorkerProject] = useState(snapshot.projects[0] ?? "");
  const [workerAccountId, setWorkerAccountId] = useState(
    () => defaultSessionLaunchAccountId(snapshot.accounts, "codex") ?? "",
  );
  const [error, setError] = useState<string>();
  const [createError, setCreateError] = useState<string>();
  const [taskCreateError, setTaskCreateError] = useState<string>();
  const [saveTemplateError, setSaveTemplateError] = useState<string>();
  const [templateRunError, setTemplateRunError] = useState<string>();
  const [abandonError, setAbandonError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const busyRef = useRef<string | undefined>(undefined);
  const gateSubmissionRef = useRef(new Set<string>());
  const [gateSubmissions, setGateSubmissions] = useState<Record<string, string>>({});
  const [abandonRun, setAbandonRun] = useState<{ id: string; objective: string }>();
  // SwiftUI 默认并持久化依赖图视图；Electron 保持相同习惯，避免每次进 Run 都先切 Tab。
  const [runView, setRunView] = useState<RunView>(initialRunView);
  const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate>();
  const [templateToDelete, setTemplateToDelete] = useState<WorkflowTemplate>();
  const [templateDeleteError, setTemplateDeleteError] = useState<string>();
  const [templateObjective, setTemplateObjective] = useState("");
  const [taskDetail, setTaskDetail] = useState<{ task: JsonObject; loading: boolean; full: boolean; previewUpdatedAt: number; error?: string }>();
  const taskDetailRequest = useRef(0);
  const openedInitialRunId = useRef<string | undefined>(undefined);
  const openedInitialTaskId = useRef<string | undefined>(undefined);
  const [taskWindow, setTaskWindow] = useState<{ runId: string; board: Partial<Record<TaskBoardColumnId, number>>; timeline: number }>({ runId: "", board: {}, timeline: TIMELINE_PAGE_SIZE });
  const [runListOpen, setRunListOpen] = useState(() => {
    try { return !window.matchMedia(COMPACT_RUN_LIST_QUERY).matches; }
    catch { return true; }
  });
  const selectedRun = orderedRuns.find((run) => text(run["id"]) === selectedRunId) ?? orderedRuns[0];
  const runId = text(selectedRun?.["id"]);
  const activeRunIds = useMemo(() => new Set(runs.filter((run) => text(run["status"]) === "active").map((run) => text(run["id"]))), [runs]);
  const activeTasks = useMemo(() => tasks.filter((task) => activeRunIds.has(text(task["runId"]))), [activeRunIds, tasks]);
  const activeGates = useMemo(() => gates.filter((gate) => activeRunIds.has(text(gate["runId"]))), [activeRunIds, gates]);
  const taskCountsByRun = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const taskRunId = text(task["runId"]);
      counts.set(taskRunId, (counts.get(taskRunId) ?? 0) + 1);
    }
    return counts;
  }, [tasks]);
  const [worktreeView, setWorktreeView] = useState({ runId, expanded: false, limit: WORKTREE_PAGE_SIZE });
  const worktreesExpanded = worktreeView.runId === runId && worktreeView.expanded;
  const worktreeLimit = worktreeView.runId === runId ? worktreeView.limit : WORKTREE_PAGE_SIZE;
  const boardLimits = taskWindow.runId === runId ? taskWindow.board : {};
  const timelineLimit = taskWindow.runId === runId ? taskWindow.timeline : TIMELINE_PAGE_SIZE;
  useEffect(() => {
    if (!initialRunId || openedInitialRunId.current === initialRunId || !runs.some((run) => text(run["id"]) === initialRunId)) return;
    openedInitialRunId.current = initialRunId;
    setSelectedRunId(initialRunId);
  }, [initialRunId, runs]);
  const runTasks = useMemo(() => tasks.filter((task) => text(task["runId"]) === runId), [tasks, runId]);
  const taskBoardStates = useMemo(() => deriveTaskBoardStates(runTasks), [runTasks]);
  const dependencyTasks = useMemo(() => {
    const query = taskDependencyQuery.trim().toLocaleLowerCase();
    return runTasks
      .filter((task) => !query || `${text(task["title"])} ${text(task["id"])}`.toLocaleLowerCase().includes(query))
      .slice(0, DEPENDENCY_OPTION_LIMIT);
  }, [runTasks, taskDependencyQuery]);
  const runGates = useMemo(() => gates.filter((gate) => text(gate["runId"]) === runId), [gates, runId]);
  const pendingRunGates = useMemo(() => runGates.filter((gate) => text(gate["status"]) === "pending"), [runGates]);
  const timelineEntries = useMemo(() => runTimelineItems(runTasks, runGates), [runGates, runTasks]);
  const runDispatches = useMemo(() => dispatches.filter((dispatch) => text(dispatch["runId"]) === runId), [dispatches, runId]);
  const dispatchByTaskId = useMemo(() => {
    const latest = new Map<string, JsonObject>();
    for (const dispatch of runDispatches) {
      const taskId = text(dispatch["taskId"]);
      const previous = latest.get(taskId);
      if (!previous || number(dispatch["startedAt"]) >= number(previous["startedAt"])) latest.set(taskId, dispatch);
    }
    return latest;
  }, [runDispatches]);
  const tasksByBoardColumn = useMemo(() => {
    const grouped = new Map<TaskBoardColumnId, JsonObject[]>();
    for (const task of runTasks) {
      const column = taskBoardStates.get(text(task["id"]));
      if (!column) continue;
      const group = grouped.get(column);
      if (group) group.push(task);
      else grouped.set(column, [task]);
    }
    return grouped;
  }, [runTasks, taskBoardStates]);
  const runWorktrees = useMemo(
    () => prioritizeWorktrees(worktreeAssets.filter((asset) => text(asset["runId"]) === runId)),
    [runId, worktreeAssets],
  );
  const attentionWorktrees = useMemo(
    () => runWorktrees.filter(worktreeNeedsAttention),
    [runWorktrees],
  );
  const visibleWorktrees = worktreesExpanded
    ? runWorktrees.slice(0, worktreeLimit)
    : attentionWorktrees.slice(0, WORKTREE_ATTENTION_PREVIEW);
  const workerAccounts = useMemo(
    () => sessionLaunchAccounts(snapshot.accounts, workerAgent),
    [snapshot.accounts, workerAgent],
  );
  const selectedWorkerAccountId = workerAccounts.some((account) => account.id === workerAccountId)
    ? workerAccountId
    : defaultSessionLaunchAccountId(snapshot.accounts, workerAgent) ?? "";
  const workerSelection = {
    agent: workerAgent,
    cwd: workerProject,
    ...(selectedWorkerAccountId ? { accountId: selectedWorkerAccountId } : {}),
  };
  useEffect(() => {
    const query = window.matchMedia(COMPACT_RUN_LIST_QUERY);
    const update = (event: MediaQueryListEvent): void => setRunListOpen(!event.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    setWorkerProject((current) => snapshot.projects.includes(current) ? current : snapshot.projects[0] ?? "");
  }, [snapshot.projects]);
  useEffect(() => {
    setWorkerAccountId(selectedWorkerAccountId);
  }, [selectedWorkerAccountId]);
  const parseSkills = (value: string): string[] => [...new Set(value.split(/[,\s]+/).map((skill) => skill.trim().replace(/^\$/, "")).filter(Boolean))].slice(0, 5);

  const perform = async (
    key: string,
    method: string,
    params: JsonObject,
    reportError: (message?: string) => void = setError,
  ): Promise<JsonObject | undefined> => {
    if (busyRef.current) return undefined;
    busyRef.current = key;
    setBusy(key);
    try { const result = await window.prospero.orchestrationAction(method, params); reportError(undefined); return result; }
    catch (reason) { reportError(displayError(reason)); return undefined; }
    finally { busyRef.current = undefined; setBusy(undefined); }
  };

  const openTaskDetail = useCallback(async (task: JsonObject): Promise<void> => {
    const request = taskDetailRequest.current + 1;
    taskDetailRequest.current = request;
    const needsFull = task["specTruncated"] === true || task["resultTruncated"] === true;
    const previewUpdatedAt = number(task["updatedAt"]);
    setTaskDetail({ task, loading: needsFull, full: !needsFull, previewUpdatedAt });
    if (!needsFull) return;
    try {
      const full = await window.prospero.getOrchestrationTask(text(task["id"]));
      if (taskDetailRequest.current === request) setTaskDetail({ task: full, loading: false, full: true, previewUpdatedAt });
    } catch (reason) {
      if (taskDetailRequest.current === request) setTaskDetail({ task, loading: false, full: false, previewUpdatedAt, error: displayError(reason) });
    }
  }, []);

  const taskDetailId = text(taskDetail?.task["id"]);
  const liveTaskDetail = tasks.find((task) => text(task["id"]) === taskDetailId);
  const taskDetailUpdatedAt = taskDetail?.previewUpdatedAt ?? 0;
  useEffect(() => {
    if (!taskDetailId) return;
    if (!liveTaskDetail) {
      taskDetailRequest.current += 1;
      setTaskDetail(undefined);
      return;
    }
    if (number(liveTaskDetail["updatedAt"]) === taskDetailUpdatedAt) return;
    void openTaskDetail(liveTaskDetail);
  }, [liveTaskDetail, openTaskDetail, taskDetailId, taskDetailUpdatedAt]);

  const closeTaskDetail = (): void => {
    taskDetailRequest.current += 1;
    setTaskDetail(undefined);
  };

  useEffect(() => {
    if (!initialTaskId || openedInitialTaskId.current === initialTaskId) return;
    const task = tasks.find((candidate) => text(candidate["id"]) === initialTaskId);
    if (!task) return;
    openedInitialTaskId.current = initialTaskId;
    setSelectedRunId(text(task["runId"]));
    void openTaskDetail(task);
  }, [initialTaskId, openTaskDetail, tasks]);

  const createGraph = async (): Promise<void> => {
    const titles = nodeLines.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!objective.trim() || titles.length === 0) return;
    if (objective.trim().length > 20_000) { setCreateError(t("目标不能超过 20,000 个字符", "The goal cannot exceed 20,000 characters")); return; }
    if (titles.length > 200) { setCreateError(t("一次最多创建 200 个任务", "You can create up to 200 tasks at once")); return; }
    if (titles.some((title) => title.length > 2_000)) { setCreateError(t("单个任务标题不能超过 2,000 个字符", "Task titles cannot exceed 2,000 characters")); return; }
    const nodes = titles.map((title, index) => ({
      clientId: `task-${String(index + 1)}`,
      title,
      spec: title,
      deps: index === 0 ? [] : [`task-${String(index)}`],
      ...(parseSkills(graphSkills).length ? { skills: parseSkills(graphSkills) } : {}),
    }));
    const result = await perform("create", "graph.create", { operationId: operationId(), objective: objective.trim(), nodes, ...(coordinatorSessionId ? { coordinatorSessionId } : {}) }, setCreateError);
    if (!result) return;
    const createdRunId = text(record(result["run"])["id"]);
    if (createdRunId) setSelectedRunId(createdRunId);
    setCreateError(undefined);
    setShowCreate(false);
    setObjective("");
  };

  const startWorker = async (task: JsonObject): Promise<void> => {
    if (taskBoardStates.get(text(task["id"])) !== "ready") return;
    if (!workerProject) { setError(t("请先添加一个项目作为 worker 工作目录", "Add a project to use as the worker directory first")); return; }
    await perform(
      text(task["id"]),
      "worker.start",
      workerStartParams(workerSelection, text(task["id"]), operationId()),
    );
  };

  const resolveGate = async (gateId: string, decision: string): Promise<void> => {
    if (gateSubmissionRef.current.has(gateId)) return;
    gateSubmissionRef.current.add(gateId);
    setGateSubmissions((current) => ({ ...current, [gateId]: decision }));
    try {
      await window.prospero.resolveGate(gateId, decision);
      setError(undefined);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      gateSubmissionRef.current.delete(gateId);
      setGateSubmissions((current) => {
        const next = { ...current };
        delete next[gateId];
        return next;
      });
    }
  };

  const createTask = async (): Promise<void> => {
    if (!runId || !taskTitle.trim() || !taskSpec.trim()) return;
    if (taskTitle.trim().length > 2_000 || taskSpec.trim().length > 20_000) { setTaskCreateError(t("任务标题最多 2,000 字符，要求最多 20,000 字符", "Task titles are limited to 2,000 characters and requirements to 20,000")); return; }
    if (!await perform("task-create", "task.create", { operationId: operationId(), runId, title: taskTitle.trim(), spec: taskSpec.trim(), deps: taskDeps, ...(parseSkills(taskSkills).length ? { skills: parseSkills(taskSkills) } : {}) }, setTaskCreateError)) return;
    setTaskCreateError(undefined); setShowTaskCreate(false); setTaskTitle(""); setTaskSpec(""); setTaskDeps([]); setTaskSkills(""); setTaskDependencyQuery("");
  };

  const saveRunTemplate = async (): Promise<void> => {
    if (!templateName.trim() || runTasks.length === 0 || busyRef.current) return;
    busyRef.current = "template-save";
    setBusy("template-save");
    setSaveTemplateError(undefined);
    try {
      const sourceTasks = await window.prospero.getOrchestrationRunTasks(runId);
      const indexes = new Map(sourceTasks.map((task, index) => [text(task["id"]), index]));
      await window.prospero.saveWorkflowTemplate({
        id: crypto.randomUUID(),
        name: templateName.trim(),
        description: templateDescription.trim(),
        nodes: sourceTasks.map((task) => ({
          title: text(task["title"]),
          spec: text(task["spec"], text(task["title"])),
          dependencyIndexes: array(task["deps"]).map(String).map((id) => indexes.get(id)).filter((index): index is number => index !== undefined),
          skills: array(task["skills"]).map(String),
        })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      setSaveTemplateOpen(false);
      setTemplateName("");
      setTemplateDescription("");
      setSaveTemplateError(undefined);
    } catch (reason) { setSaveTemplateError(displayError(reason)); }
    finally { busyRef.current = undefined; setBusy(undefined); }
  };

  const runTemplate = async (): Promise<void> => {
    if (!selectedTemplate || !templateObjective.trim()) return;
    if (templateObjective.trim().length > 20_000) { setTemplateRunError(t("目标不能超过 20,000 个字符", "The goal cannot exceed 20,000 characters")); return; }
    const nodes = selectedTemplate.nodes.map((node, index) => ({
      clientId: `template-task-${String(index + 1)}`,
      title: node.title,
      spec: node.spec,
      deps: node.dependencyIndexes.map((dependency) => `template-task-${String(dependency + 1)}`),
      ...(node.skills.length ? { skills: node.skills } : {}),
    }));
    const result = await perform("template-run", "graph.create", { operationId: operationId(), objective: templateObjective.trim(), nodes, ...(coordinatorSessionId ? { coordinatorSessionId } : {}) }, setTemplateRunError);
    if (!result) return;
    const createdRunId = text(record(result["run"])["id"]);
    if (createdRunId) setSelectedRunId(createdRunId);
    setSelectedTemplate(undefined);
    setTemplateObjective("");
    setTemplateLibraryOpen(false);
  };

  const deleteTemplate = async (): Promise<void> => {
    if (!templateToDelete || busyRef.current) return;
    busyRef.current = "template-delete";
    setBusy("template-delete");
    setTemplateDeleteError(undefined);
    try {
      await window.prospero.deleteWorkflowTemplate(templateToDelete.id);
      setTemplateToDelete(undefined);
      setTemplateLibraryOpen(true);
      setError(undefined);
    } catch (reason) {
      setTemplateDeleteError(displayError(reason));
    } finally {
      busyRef.current = undefined;
      setBusy(undefined);
    }
  };

  const completeCount = runTasks.filter((task) => ["done", "completed", "succeeded", "cancelled"].includes(text(task["status"]))).length;
  const runProgress = runTasks.length ? Math.round((completeCount / runTasks.length) * 100) : 0;
  const boardColumns: Array<{ id: TaskBoardColumnId; label: string }> = [
    { id: "queued", label: t("排队", "Queued") },
    { id: "ready", label: t("就绪", "Ready") },
    { id: "running", label: t("运行中", "Running") },
    { id: "review", label: t("待检查", "Review") },
    { id: "done", label: t("已完成", "Done") },
  ];
  const detailedTask = taskDetail?.full && liveTaskDetail
    ? {
        ...taskDetail.task,
        ...liveTaskDetail,
        ...(liveTaskDetail["specTruncated"] === true
          ? { spec: taskDetail.task["spec"] }
          : {}),
        ...(liveTaskDetail["resultTruncated"] === true
          ? { result: taskDetail.task["result"] }
          : {}),
      }
    : liveTaskDetail ?? taskDetail?.task;
  const detailedTaskId = text(detailedTask?.["id"]);
  const detailedDispatch = dispatchByTaskId.get(detailedTaskId);
  const detailedBoardState = detailedTaskId ? taskBoardStates.get(detailedTaskId) : undefined;

  const taskCard = (task: JsonObject) => {
    const taskId = text(task["id"]); const deps = array(task["deps"]).map(String); const dispatch = dispatchByTaskId.get(taskId);
    return <Card size="sm" className="run-task-card" key={taskId}><CardHeader><div className="flex items-start justify-between gap-2"><CardTitle>{text(task["title"])}</CardTitle><span className={`status-dot ${text(task["status"])}`} /></div><CardDescription>{text(task["spec"])}</CardDescription></CardHeader><CardContent className="flex flex-col gap-2">{deps.length > 0 && <Badge variant="outline" className="w-fit"><GitPullRequestArrow />{deps.length} {t("个依赖", "dependencies")}</Badge>}{dispatch && <div className="task-assignee"><Bot /><span>{text(dispatch["agent"], workerAgent)}</span><small>{text(dispatch["branch"], t("隔离工作树", "isolated worktree"))}</small></div>}</CardContent><CardFooter className="flex-wrap">
      <Button variant="ghost" size="sm" onClick={() => void openTaskDetail(task)}>{t("详情", "Details")}</Button>
      {taskBoardStates.get(taskId) === "ready" && <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void startWorker(task)}><Bot data-icon="inline-start" />{t("启动", "Start")}</Button>}
      {text(task["status"]) === "failed" && <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => void perform(taskId, "task.retry", { operationId: operationId(), taskId })}><RefreshCw data-icon="inline-start" />{t("重试", "Retry")}</Button>}
      {dispatch && <Button variant="ghost" size="sm" onClick={() => onOpenSession(text(dispatch["sessionId"]))}>{t("打开会话", "Open session")}</Button>}
      {text(task["status"]) === "dispatched" && <Button variant="destructive" size="sm" disabled={Boolean(busy)} onClick={() => void perform(taskId, "worker.stop", { operationId: operationId(), taskId, reason: "Stopped from Prospero desktop" })}><Square data-icon="inline-start" />{t("停止", "Stop")}</Button>}
    </CardFooter></Card>;
  };

  const gateCard = (gate: JsonObject) => {
    const gateId = text(gate["id"]);
    const options = array(gate["options"]).map(String);
    const submitting = gateSubmissions[gateId];
    return <article className="gate-card" key={gateId}>
      <strong>{text(gate["question"])}</strong>
      <div className="button-row compact">
        {text(gate["status"]) !== "pending"
          ? <span className="resolved"><CheckCircle2 size={13} />{text(gate["decision"], t("已处理", "Resolved"))}</span>
          : options.length > 0
            ? options.map((option) => <Button variant="outline" size="sm" key={option} disabled={Boolean(submitting)} onClick={() => void resolveGate(gateId, option)}>{submitting === option && <LoaderCircle className="animate-spin" data-icon="inline-start" />}{option}</Button>)
            : <FreeformGateDecision submitting={Boolean(submitting)} onResolve={(decision) => resolveGate(gateId, decision)} />}
      </div>
    </article>;
  };

  const changeRunView = (value: string | null): void => {
    if (value !== "board" && value !== "dag" && value !== "timeline") return;
    setRunView(value);
    try { localStorage.setItem("prospero.run-task-view", value); } catch { /* 偏好写入失败不影响看图。 */ }
  };

  return <div className={`page orchestration-page${runView === "dag" ? " dag-active" : ""}`}>
    <header className="orchestration-header"><div className="orchestration-header-title"><h1>{t("目标与编排中心", "Runs & orchestration")}</h1><div className="orchestration-stats"><span>{t("运行", "Runs")}<b>{runs.length}</b></span><span>{t("运行中任务", "Active")}<b>{activeTasks.filter((task) => ["dispatched", "running", "starting"].includes(text(task["status"]))).length}</b></span><span>{t("等待检查", "Needs review")}<b>{activeTasks.filter((task) => ["blocked", "failed", "waiting_approval"].includes(text(task["status"]))).length + activeGates.filter((gate) => text(gate["status"]) === "pending").length}</b></span><span>{t("模板", "Templates")}<b>{snapshot.workflowTemplates.length}</b></span></div></div><div className="flex flex-wrap items-end gap-2"><label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t("项目", "Project")}<NativeSelect value={workerProject} onChange={(event) => setWorkerProject(event.target.value)}>{snapshot.projects.map((project) => <NativeSelectOption value={project} key={project}>{project.split(/[\\/]/).at(-1)}</NativeSelectOption>)}</NativeSelect></label><label className="flex flex-col gap-1.5 text-xs text-muted-foreground">Worker<NativeSelect value={workerAgent} onChange={(event) => { const agent = event.target.value as OrchestrationWorkerAgent; setWorkerAgent(agent); setWorkerAccountId(defaultSessionLaunchAccountId(snapshot.accounts, agent) ?? ""); }}><NativeSelectOption value="codex">Codex</NativeSelectOption><NativeSelectOption value="claude">Claude</NativeSelectOption><NativeSelectOption value="deepseek">DeepSeek</NativeSelectOption><NativeSelectOption value="opencode">OpenCode</NativeSelectOption></NativeSelect></label>{(workerAgent === "codex" || workerAgent === "claude") && <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t("账号", "Account")}<NativeSelect value={selectedWorkerAccountId} onChange={(event) => setWorkerAccountId(event.target.value)}>{workerAccounts.length === 0 && <NativeSelectOption value="">{t("默认 CLI 环境", "Default CLI environment")}</NativeSelectOption>}{workerAccounts.map((account) => <NativeSelectOption value={account.id} key={account.id}>{account.name}{account.isDefault ? t("（默认）", " (default)") : ""}</NativeSelectOption>)}</NativeSelect></label>}<Button variant="outline" onClick={() => setTemplateLibraryOpen(true)}><LibraryBig data-icon="inline-start" />{t("模板库", "Templates")}</Button><Button onClick={() => setShowCreate(true)}><Plus data-icon="inline-start" />{t("新建目标", "New goal")}</Button></div></header>
    {error && <Alert variant="destructive" className="mx-7 mt-5 w-auto"><CircleDot /><AlertTitle>{t("编排操作失败", "Orchestration action failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    <div className={`orchestration-layout${runListOpen ? "" : " run-list-collapsed"}`}>
      <aside className="run-list"><div className="section-label run-list-heading"><span>{t("运行", "RUNS")} · {runs.length}</span><button type="button" className="run-list-collapse" aria-label={t("收起运行列表", "Collapse runs")} title={t("收起运行列表", "Collapse runs")} onClick={() => setRunListOpen(false)}><PanelLeftClose size={13} /></button></div>{orderedRuns.length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><Workflow /></EmptyMedia><EmptyTitle>{t("还没有编排 Run", "No orchestration runs yet")}</EmptyTitle><EmptyDescription>{t("创建目标后，任务图会显示在这里。", "Create a goal and its task graph will appear here.")}</EmptyDescription></EmptyHeader></Empty>}{orderedRuns.map((run) => { const objective = text(run["objective"]); const taskCount = taskCountsByRun.get(text(run["id"])) ?? 0; return <Button variant={text(run["id"]) === runId ? "secondary" : "ghost"} key={text(run["id"])} className="h-auto w-full justify-start px-3 py-2 text-left" title={objective} onClick={() => setSelectedRunId(text(run["id"]))}><span className={`status-dot ${text(run["status"])}`} /><span className="flex min-w-0 flex-col items-start gap-1"><strong className="max-w-full truncate">{runListLabel(objective)}</strong><small className="text-muted-foreground">{status(text(run["status"]))} · {t(`${String(taskCount)} 个任务`, `${String(taskCount)} tasks`)} · rev {number(run["graphRevision"])}</small></span></Button>; })}</aside>
      <main className={`run-detail${runView === "dag" ? " run-detail-dag" : ""}`}>{selectedRun ? <>
        <div className="run-hero"><div className="run-hero-copy"><div className="section-label">{t("当前运行", "CURRENT RUN")}</div><h2 title={text(selectedRun["objective"])}>{text(selectedRun["objective"])}</h2><div className="run-progress-line"><Progress value={runProgress} /><span>{completeCount} / {runTasks.length} {t("已完成", "complete")}</span></div></div><div className="button-row">
          {!runListOpen && <button className="run-list-toggle" aria-expanded={runListOpen} onClick={() => setRunListOpen(true)}><PanelLeftOpen size={14} />{t("显示运行列表", "Show runs")}</button>}
          {runTasks.length > 0 && <button onClick={() => { setTemplateName(text(selectedRun["objective"])); setTemplateDescription(""); setSaveTemplateError(undefined); setSaveTemplateOpen(true); }}><Save size={14} />{t("保存为模板", "Save template")}</button>}
          {text(record(selectedRun["automation"])["state"]) !== "running" && text(selectedRun["status"]) === "active" && <button onClick={() => { setTaskCreateError(undefined); setShowTaskCreate(true); }}><Plus size={14} />{t("添加任务", "Add task")}</button>}
          {text(record(selectedRun["automation"])["state"]) === "running" ? <button disabled={Boolean(busy)} onClick={() => void perform("automation", "automation.pause", { operationId: operationId(), runId })}><Pause size={14} />{t("暂停自动执行", "Pause automation")}</button> : <button onClick={() => void perform("automation", "automation.start", automationStartParams(workerSelection, runId, operationId()))} disabled={!workerProject || Boolean(busy)}><Play size={14} />{t("自动执行 DAG", "Run DAG automatically")}</button>}
          {text(selectedRun["status"]) === "active" && <button disabled={Boolean(busy)} onClick={() => void perform("complete", "run.complete", { operationId: operationId(), runId })}><CheckCircle2 size={14} />{t("标记完成", "Mark complete")}</button>}
          {text(selectedRun["status"]) === "active" && <button className="danger" disabled={Boolean(busy)} onClick={() => setAbandonRun({ id: runId, objective: text(selectedRun["objective"]) })}><Ban size={14} />{t("放弃", "Abandon")}</button>}
          {text(selectedRun["status"]) !== "active" && <button className="danger" disabled={Boolean(busy)} onClick={() => void perform("delete", "run.delete", { operationId: operationId(), runId })}><Trash2 size={14} />{t("删除记录", "Delete record")}</button>}
        </div></div>
        <Tabs value={runView} onValueChange={changeRunView} className={`run-views${runView === "dag" ? " run-views-dag" : ""}`}>
          <TabsList variant="line">
            <TabsTrigger value="board"><Columns3 />{t("看板", "Board")}</TabsTrigger>
            <TabsTrigger value="dag"><Network />DAG</TabsTrigger>
            <TabsTrigger value="timeline"><Clock3 />{t("时间线", "Timeline")}</TabsTrigger>
          </TabsList>
          {runView === "board" && <TabsContent value="board" className="run-view-content">
            <div className="run-board">{boardColumns.map((column) => {
              const columnTasks = tasksByBoardColumn.get(column.id) ?? [];
              const boardLimit = boardLimits[column.id] ?? BOARD_COLUMN_PAGE_SIZE;
              const visibleTasks = columnTasks.slice(0, boardLimit);
              return <section className="board-column" key={column.id}><header><span>{column.label}</span><Badge variant="outline">{columnTasks.length}</Badge></header><div>{visibleTasks.map(taskCard)}{columnTasks.length === 0 && <div className="board-empty">{t("暂无任务", "No tasks")}</div>}{visibleTasks.length < columnTasks.length && <Button variant="ghost" size="sm" className="w-full" onClick={() => setTaskWindow({ runId, board: { ...boardLimits, [column.id]: boardLimit + BOARD_COLUMN_PAGE_SIZE }, timeline: timelineLimit })}>{t("显示更多", "Show more")} · {columnTasks.length - visibleTasks.length}</Button>}</div></section>;
            })}</div>
          </TabsContent>}
          {runView === "dag" && <TabsContent value="dag" className="run-view-content run-view-content-dag">
            {runTasks.length > 0 ? <RunGraph runId={runId} tasks={runTasks} dispatches={runDispatches} onActivateTask={(taskId) => { const task = runTasks.find((candidate) => text(candidate["id"]) === taskId); if (task) void openTaskDetail(task); }} /> : <Empty><EmptyHeader><EmptyMedia variant="icon"><Network /></EmptyMedia><EmptyTitle>{t("暂无 DAG 节点", "No DAG nodes")}</EmptyTitle><EmptyDescription>{t("添加任务后，依赖图会显示在这里。", "Add tasks to populate the dependency graph.")}</EmptyDescription></EmptyHeader></Empty>}
          </TabsContent>}
          {runView === "timeline" && <TabsContent value="timeline" className="run-view-content">
            <div className="run-timeline">{timelineEntries.slice(0, timelineLimit).map((entry) => entry.kind === "task" ? <div key={`task:${entry.id}`}><span className={`status-dot ${text(entry.item["status"])}`} /><div><button type="button" data-slot="timeline-task" className="block border-0 bg-transparent p-0 text-left text-inherit" onClick={() => void openTaskDetail(entry.item)}><strong>{text(entry.item["title"])}</strong></button><p>{t("任务", "Task")} {status(text(entry.item["status"]))}{entry.time ? ` · ${new Date(entry.time).toLocaleString()}` : ""}</p></div></div> : <div key={`gate:${entry.id}`}><span className={`status-dot ${text(entry.item["status"])}`} /><div><strong>{text(entry.item["question"], t("请求审批", "Gate requested"))}</strong><p>{text(entry.item["status"]) === "pending" ? t("等待用户决定", "Waiting for a decision") : `${t("决定", "Decision")} · ${text(entry.item["decision"])}`}{entry.time ? ` · ${new Date(entry.time).toLocaleString()}` : ""}</p></div></div>)}{timelineEntries.length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><Clock3 /></EmptyMedia><EmptyTitle>{t("暂无事件", "No events yet")}</EmptyTitle><EmptyDescription>{t("Run 的重要事件会按时间显示。", "Important run events appear here in chronological order.")}</EmptyDescription></EmptyHeader></Empty>}{timelineLimit < timelineEntries.length && <Button variant="ghost" size="sm" onClick={() => setTaskWindow({ runId, board: boardLimits, timeline: timelineLimit + TIMELINE_PAGE_SIZE })}>{t("显示更多", "Show more")} · {timelineEntries.length - timelineLimit}</Button>}</div>
          </TabsContent>}
        </Tabs>
        {pendingRunGates.length > 0 && <section className="dashboard-section"><div className="section-title"><ShieldQuestion size={16} />{t("待处理 Gate", "Pending gates")} <span>{pendingRunGates.length}</span></div><div className="card-grid">{pendingRunGates.map(gateCard)}</div></section>}
        {runWorktrees.length > 0 && <section className="dashboard-section"><div className="section-title"><GitBranch size={16} />Worktrees <span>{runWorktrees.length}</span><span className="ml-auto text-xs font-normal text-muted-foreground">{attentionWorktrees.length} {t("待处理", "need attention")} · {runWorktrees.length - attentionWorktrees.length} {t("已归档", "archived")}</span><Button variant="ghost" size="sm" className="ml-2" aria-expanded={worktreesExpanded} onClick={() => setWorktreeView({ runId, expanded: !worktreesExpanded, limit: WORKTREE_PAGE_SIZE })}>{worktreesExpanded ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}{worktreesExpanded ? t("收起", "Collapse") : t("查看全部", "View all")}</Button></div>{visibleWorktrees.length > 0 ? <div className="worktree-list">{visibleWorktrees.map((asset) => { const inspection = record(asset["lastInspection"]); const safe = ["safe_to_clean", "equivalent"].includes(text(inspection["state"])); const assetId = text(asset["id"]); const assetBusy = busy === assetId; const launchable = isLaunchableWorktreeAsset(asset); return <article className="worktree-row" key={assetId}><GitBranch size={15} /><div><strong>{text(asset["branch"], t("工作树", "Worktree"))}</strong><small>{text(asset["path"])}</small></div><span className="pill">{status(text(asset["state"]))}</span><button disabled={!launchable || assetBusy} title={launchable ? t("在这个 worktree 中启动 Agent", "Start an agent in this worktree") : t("工作树目录不可用", "The worktree directory is unavailable")} onClick={() => onNewSession(text(asset["path"]))}><Bot size={13} />{t("运行 Agent", "Run agent")}</button><button disabled={assetBusy} onClick={() => void perform(assetId, "worktree.inspect", { assetId })}>{t("检查", "Inspect")}</button><button className="danger" disabled={!safe || assetBusy} title={safe ? t("清理已确认安全的工作树", "Clean this verified worktree") : t("必须先通过安全检查", "Run a safety check first")} onClick={() => void perform(assetId, "worktree.cleanup", { operationId: operationId(), assetId, ...(text(inspection["targetRef"]) ? { targetRef: text(inspection["targetRef"]) } : {}), confirm: true, deleteBranch: false })}><Trash2 size={13} />{t("安全清理", "Safe cleanup")}</button></article>; })}</div> : <p className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">{t("当前没有需要处理的 Worktree；展开后可查看已清理或已缺失的历史记录。", "No worktrees need attention. Expand to inspect cleaned or missing history.")}</p>}{worktreesExpanded && visibleWorktrees.length < runWorktrees.length && <div className="mt-3 flex justify-center"><Button variant="outline" size="sm" onClick={() => setWorktreeView({ runId, expanded: true, limit: worktreeLimit + WORKTREE_PAGE_SIZE })}>{t("显示更多", "Show more")} · {runWorktrees.length - visibleWorktrees.length}</Button></div>}</section>}
      </> : <Empty><EmptyHeader><EmptyMedia variant="icon"><Workflow /></EmptyMedia><EmptyTitle>{t("选择或创建一个 Run", "Choose or create a run")}</EmptyTitle><EmptyDescription>{t("用 DAG 拆解任务，再把独立节点派给并行 Agent。", "Break work into a DAG and dispatch independent nodes to agents in parallel.")}</EmptyDescription></EmptyHeader></Empty>}</main>
    </div>
    <Dialog open={Boolean(taskDetail)} onOpenChange={(open) => { if (!open) closeTaskDetail(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{text(detailedTask?.["title"], t("任务详情", "Task details"))}</DialogTitle>
          <DialogDescription>{detailedTaskId} · {status(text(detailedTask?.["status"]))}</DialogDescription>
        </DialogHeader>
        {taskDetail?.loading ? <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground"><LoaderCircle className="animate-spin" />{t("正在读取完整任务…", "Loading full task…")}</div> : <div className="grid min-h-0 gap-4"><section className="grid gap-2"><strong>{t("任务要求", "Requirements")}</strong><pre className="max-h-[38vh] overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs leading-relaxed">{text(detailedTask?.["spec"], t("暂无要求", "No requirements"))}</pre></section>{text(detailedTask?.["result"]) && <section className="grid gap-2"><strong>{t("执行结果", "Result")}</strong><pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs leading-relaxed">{text(detailedTask?.["result"])}</pre></section>}</div>}
        {taskDetail?.error && <Alert variant="destructive"><CircleDot /><AlertTitle>{t("无法读取完整任务", "Unable to load full task")}</AlertTitle><AlertDescription>{taskDetail.error}</AlertDescription></Alert>}
        <DialogFooter className="flex-wrap">
          {detailedBoardState === "ready" && detailedTask && <Button variant="outline" disabled={Boolean(busy)} onClick={() => void startWorker(detailedTask)}><Bot data-icon="inline-start" />{t("启动", "Start")}</Button>}
          {text(detailedTask?.["status"]) === "failed" && <Button variant="outline" disabled={Boolean(busy)} onClick={() => void perform(detailedTaskId, "task.retry", { operationId: operationId(), taskId: detailedTaskId })}><RefreshCw data-icon="inline-start" />{t("重试", "Retry")}</Button>}
          {detailedDispatch && <Button variant="outline" onClick={() => onOpenSession(text(detailedDispatch["sessionId"]))}>{t("打开会话", "Open session")}</Button>}
          <Button onClick={closeTaskDetail}>{t("关闭", "Close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={templateLibraryOpen} onOpenChange={setTemplateLibraryOpen}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("工作流模板库", "Workflow templates")}</DialogTitle>
          <DialogDescription>{t("像 Runbook 一样复用任务结构、依赖与绑定的 Skills；每次运行时再填写具体目标。", "Reuse task structure, dependencies, and bound skills like a runbook, then provide a fresh objective for each run.")}</DialogDescription>
        </DialogHeader>
        <div className="template-library">
          {snapshot.workflowTemplates.map((template) => <Card size="sm" key={template.id}>
            <CardHeader><div className="flex items-start justify-between gap-3"><div className="min-w-0"><CardTitle>{template.name}</CardTitle><CardDescription>{template.description || t("可复用的 Agent 工作流", "Reusable agent workflow")}</CardDescription></div><Badge variant="outline">{template.nodes.length} {t("个任务", "tasks")}</Badge></div></CardHeader>
            <CardContent><div className="template-node-preview">{template.nodes.slice(0, 4).map((node, index) => <span key={`${template.id}:${String(index)}`}>{String(index + 1)}. {node.title}</span>)}</div></CardContent>
            <CardFooter className="justify-between"><Button variant="ghost" size="sm" disabled={Boolean(busy)} onClick={() => { setTemplateDeleteError(undefined); setTemplateToDelete(template); setTemplateLibraryOpen(false); }}><Trash2 data-icon="inline-start" />{t("删除", "Delete")}</Button><Button size="sm" disabled={Boolean(busy)} onClick={() => { setSelectedTemplate(template); setTemplateObjective(""); setTemplateLibraryOpen(false); }}><Rocket data-icon="inline-start" />{t("使用模板", "Use template")}</Button></CardFooter>
          </Card>)}
          {snapshot.workflowTemplates.length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><LibraryBig /></EmptyMedia><EmptyTitle>{t("还没有模板", "No templates yet")}</EmptyTitle><EmptyDescription>{t("打开一个已有 Run，选择“保存为模板”。", "Open an existing run and choose Save template.")}</EmptyDescription></EmptyHeader></Empty>}
        </div>
        <DialogFooter><Button variant="outline" onClick={() => setTemplateLibraryOpen(false)}>{t("关闭", "Close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(templateToDelete)} onOpenChange={(open) => { if (!open && busy !== "template-delete") { setTemplateDeleteError(undefined); setTemplateToDelete(undefined); setTemplateLibraryOpen(true); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t("删除这个模板？", "Delete this template?")}</DialogTitle><DialogDescription>{t("模板会从这台设备移除，已有 Run 不受影响。", "The template will be removed from this device. Existing runs are unaffected.")}</DialogDescription></DialogHeader>
        <p className="truncate text-sm font-medium" title={templateToDelete?.name}>{templateToDelete?.name}</p>
        {templateDeleteError && <Alert variant="destructive"><CircleDot /><AlertTitle>{t("无法删除模板", "Unable to delete template")}</AlertTitle><AlertDescription>{templateDeleteError}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" disabled={busy === "template-delete"} onClick={() => { setTemplateDeleteError(undefined); setTemplateToDelete(undefined); setTemplateLibraryOpen(true); }}>{t("取消", "Cancel")}</Button><Button variant="destructive" disabled={busy === "template-delete"} onClick={() => void deleteTemplate()}>{busy === "template-delete" ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}{busy === "template-delete" ? t("正在删除…", "Deleting…") : t("确认删除", "Delete template")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={saveTemplateOpen} onOpenChange={(open) => { setSaveTemplateOpen(open); if (!open) setSaveTemplateError(undefined); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{t("保存工作流模板", "Save workflow template")}</DialogTitle><DialogDescription>{t("保存当前 Run 的任务、依赖关系和 Skills，不保存运行状态或会话。", "Save tasks, dependencies, and skills from this run without runtime state or sessions.")}</DialogDescription></DialogHeader>
        <FieldGroup><Field><FieldLabel htmlFor="template-name">{t("模板名称", "Template name")}</FieldLabel><Input id="template-name" maxLength={120} value={templateName} onChange={(event) => setTemplateName(event.target.value)} autoFocus /></Field><Field><FieldLabel htmlFor="template-description">{t("说明", "Description")}</FieldLabel><Textarea id="template-description" maxLength={500} rows={3} value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} placeholder={t("何时使用这个模板", "When to use this template")} /><FieldDescription>{runTasks.length} {t("个任务会被保存", "tasks will be saved")}</FieldDescription></Field></FieldGroup>
        {saveTemplateError && <Alert variant="destructive"><CircleDot /><AlertTitle>{t("无法保存模板", "Unable to save template")}</AlertTitle><AlertDescription>{saveTemplateError}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" onClick={() => { setSaveTemplateOpen(false); setSaveTemplateError(undefined); }}>{t("取消", "Cancel")}</Button><Button disabled={!templateName.trim() || busy === "template-save"} onClick={() => void saveRunTemplate()}><Save data-icon="inline-start" />{t("保存模板", "Save template")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(selectedTemplate)} onOpenChange={(open) => { if (!open) { setSelectedTemplate(undefined); setTemplateRunError(undefined); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{selectedTemplate?.name}</DialogTitle><DialogDescription>{t("为这次运行填写可验收的最终目标，模板中的 DAG 与 Skills 会被复制到新 Run。", "Enter a verifiable outcome for this run. The template DAG and skills will be copied into a new run.")}</DialogDescription></DialogHeader>
        <Field><FieldLabel htmlFor="template-objective">{t("本次目标", "Run objective")}</FieldLabel><Textarea id="template-objective" maxLength={20_000} rows={4} value={templateObjective} onChange={(event) => setTemplateObjective(event.target.value)} autoFocus placeholder={t("描述这一次要交付的具体结果", "Describe the concrete result to deliver this time")} /><FieldDescription>{selectedTemplate?.nodes.length ?? 0} {t("个任务将被创建", "tasks will be created")}</FieldDescription></Field>
        {templateRunError && <Alert variant="destructive"><CircleDot /><AlertTitle>{t("无法运行模板", "Unable to run template")}</AlertTitle><AlertDescription>{templateRunError}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" onClick={() => { setSelectedTemplate(undefined); setTemplateRunError(undefined); }}>{t("取消", "Cancel")}</Button><Button disabled={!templateObjective.trim() || busy === "template-run"} onClick={() => void runTemplate()}><Rocket data-icon="inline-start" />{t("从模板运行", "Run from template")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(abandonRun)} onOpenChange={(open) => { if (!open) { setAbandonRun(undefined); setAbandonError(undefined); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{t("放弃这个运行？", "Abandon this run?")}</DialogTitle><DialogDescription>{t("运行会停止继续派发任务，已有记录仍会保留。", "The run will stop dispatching tasks, while its history remains available.")}</DialogDescription></DialogHeader>
        <p className="truncate text-sm font-medium" title={abandonRun?.objective}>{abandonRun?.objective}</p>
        {abandonError && <Alert variant="destructive"><CircleDot /><AlertTitle>{t("无法放弃运行", "Unable to abandon run")}</AlertTitle><AlertDescription>{abandonError}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" disabled={busy === "abandon"} onClick={() => { setAbandonRun(undefined); setAbandonError(undefined); }}>{t("取消", "Cancel")}</Button><Button variant="destructive" disabled={busy === "abandon"} onClick={() => { if (!abandonRun) return; void perform("abandon", "run.abandon", { operationId: operationId(), runId: abandonRun.id }, setAbandonError).then((done) => { if (done) setAbandonRun(undefined); }); }}><Ban data-icon="inline-start" />{busy === "abandon" ? t("正在放弃…", "Abandoning…") : t("确认放弃", "Abandon run")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={showCreate} onOpenChange={(open) => { setShowCreate(open); if (!open) setCreateError(undefined); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>{t("创建目标任务图", "Create goal graph")}</DialogTitle><DialogDescription>{t("每行一个任务，默认按顺序建立依赖；Skill 会冻结到每个 worker。", "Enter one task per line. Dependencies follow the listed order and skills are pinned to each worker.")}</DialogDescription></DialogHeader>
        <FieldGroup>
          <Field><FieldLabel htmlFor="run-objective">{t("总体目标", "Goal")}</FieldLabel><Textarea id="run-objective" maxLength={20_000} rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} autoFocus placeholder={t("描述可以验收的最终结果", "Describe a verifiable final outcome")} /></Field>
          <Field><FieldLabel htmlFor="run-initial-tasks">{t("初始任务", "Initial tasks")}</FieldLabel><Textarea id="run-initial-tasks" rows={7} value={nodeLines} onChange={(event) => setNodeLines(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="run-skills"><Sparkles />{t("绑定 Skill（最多 5 个）", "Bind skills (up to 5)")}</FieldLabel><Input id="run-skills" value={graphSkills} onChange={(event) => setGraphSkills(event.target.value)} placeholder="$frontend-design, $playwright" /></Field>
        </FieldGroup>
        {parseSkills(graphSkills).length > 0 && <div className="skill-chip-row">{parseSkills(graphSkills).map((skill) => <span key={skill}>${skill}</span>)}</div>}
        {createError && <Alert variant="destructive"><CircleDot /><AlertTitle>{t("无法创建任务图", "Unable to create graph")}</AlertTitle><AlertDescription>{createError}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" disabled={Boolean(busy)} onClick={() => { setShowCreate(false); setCreateError(undefined); }}>{t("取消", "Cancel")}</Button><Button onClick={() => void createGraph()} disabled={!objective.trim() || Boolean(busy)}><CircleDot data-icon="inline-start" />{busy === "create" ? t("正在创建…", "Creating…") : t("创建目标与 DAG", "Create goal and DAG")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={showTaskCreate} onOpenChange={(open) => { setShowTaskCreate(open); if (!open) setTaskCreateError(undefined); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>{t("添加任务", "Add task")}</DialogTitle><DialogDescription>{t("选择前置任务和 Skill，daemon 会校验 DAG 并冻结 Skill 来源。", "Choose dependencies and skills. The daemon validates the DAG and pins skill sources.")}</DialogDescription></DialogHeader>
        <FieldGroup>
          <Field><FieldLabel htmlFor="task-title">{t("任务标题", "Task title")}</FieldLabel><Input id="task-title" maxLength={2_000} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} autoFocus /></Field>
          <Field><FieldLabel htmlFor="task-spec">{t("任务要求", "Task requirements")}</FieldLabel><Textarea id="task-spec" maxLength={20_000} rows={5} value={taskSpec} onChange={(event) => setTaskSpec(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="task-skills"><Sparkles />{t("任务 Skill", "Task skills")}</FieldLabel><Input id="task-skills" value={taskSkills} onChange={(event) => setTaskSkills(event.target.value)} placeholder={t("$skill-name，空格或逗号分隔", "$skill-name, separated by spaces or commas")} /></Field>
        </FieldGroup>
        {parseSkills(taskSkills).length > 0 && <div className="skill-chip-row">{parseSkills(taskSkills).map((skill) => <span key={skill}>${skill}</span>)}</div>}
        {runTasks.length > 0 && <div className="grid gap-2"><div className="section-label">{t("前置依赖", "Dependencies")}</div><Input value={taskDependencyQuery} onChange={(event) => setTaskDependencyQuery(event.target.value)} placeholder={t("搜索任务标题或 ID", "Search task title or ID")} /><div className="dependency-picker">{dependencyTasks.map((task) => { const id = text(task["id"]); return <label className="check-row" key={id}><input type="checkbox" checked={taskDeps.includes(id)} onChange={(event) => setTaskDeps((current) => event.target.checked ? [...current, id] : current.filter((item) => item !== id))} />{text(task["title"])}</label>; })}</div>{dependencyTasks.length < runTasks.length && <small className="text-muted-foreground">{t(`显示前 ${String(dependencyTasks.length)} 个匹配任务`, `Showing the first ${String(dependencyTasks.length)} matching tasks`)}</small>}</div>}
        {taskCreateError && <Alert variant="destructive"><CircleDot /><AlertTitle>{t("无法添加任务", "Unable to add task")}</AlertTitle><AlertDescription>{taskCreateError}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" disabled={Boolean(busy)} onClick={() => { setShowTaskCreate(false); setTaskCreateError(undefined); }}>{t("取消", "Cancel")}</Button><Button onClick={() => void createTask()} disabled={!taskTitle.trim() || !taskSpec.trim() || Boolean(busy)}><Plus data-icon="inline-start" />{busy === "task-create" ? t("正在添加…", "Adding…") : t("添加任务", "Add task")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
