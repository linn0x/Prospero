import { useMemo, useState } from "react";
import { Ban, Bot, CheckCircle2, CircleDot, Clock3, Columns3, GitBranch, GitPullRequestArrow, LibraryBig, Network, Pause, Play, Plus, RefreshCw, Rocket, Save, ShieldQuestion, Sparkles, Square, Trash2, Workflow } from "lucide-react";
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

const operationId = (): string => crypto.randomUUID();

export function OrchestrationPane({ snapshot, onOpenSession, coordinatorSessionId }: { snapshot: DesktopSnapshot; onOpenSession: (id: string) => void; coordinatorSessionId?: string | undefined }) {
  const { t, status } = useLocale();
  const { runs, tasks, dispatches, gates, worktreeAssets } = snapshot.orchestration;
  const [selectedRunId, setSelectedRunId] = useState<string>(text(runs[0]?.["id"]));
  const [showCreate, setShowCreate] = useState(false);
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [objective, setObjective] = useState("");
  const [nodeLines, setNodeLines] = useState(() => t("分析需求\n实现功能\n验证与交付", "Analyze requirements\nImplement the feature\nValidate and deliver"));
  const [taskTitle, setTaskTitle] = useState("");
  const [taskSpec, setTaskSpec] = useState("");
  const [taskDeps, setTaskDeps] = useState<string[]>([]);
  const [taskSkills, setTaskSkills] = useState("");
  const [graphSkills, setGraphSkills] = useState("");
  const [workerAgent, setWorkerAgent] = useState("codex");
  const [workerProject, setWorkerProject] = useState(snapshot.projects[0] ?? "");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [runView, setRunView] = useState("board");
  const [templateLibraryOpen, setTemplateLibraryOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplate>();
  const [templateObjective, setTemplateObjective] = useState("");
  const selectedRun = runs.find((run) => text(run["id"]) === selectedRunId) ?? runs[0];
  const runId = text(selectedRun?.["id"]);
  const runTasks = useMemo(() => tasks.filter((task) => text(task["runId"]) === runId), [tasks, runId]);
  const runGates = gates.filter((gate) => text(gate["runId"]) === runId);
  const runDispatches = dispatches.filter((dispatch) => text(dispatch["runId"]) === runId);
  const runWorktrees = worktreeAssets.filter((asset) => text(asset["runId"]) === runId);
  const parseSkills = (value: string): string[] => [...new Set(value.split(/[,\s]+/).map((skill) => skill.trim().replace(/^\$/, "")).filter(Boolean))].slice(0, 5);

  const perform = async (key: string, method: string, params: JsonObject): Promise<void> => {
    setBusy(key);
    try { await window.prospero.orchestrationAction(method, params); setError(undefined); }
    catch (reason) { setError(displayError(reason)); }
    finally { setBusy(undefined); }
  };

  const createGraph = async (): Promise<void> => {
    const titles = nodeLines.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!objective.trim() || titles.length === 0) return;
    const nodes = titles.map((title, index) => ({
      clientId: `task-${String(index + 1)}`,
      title,
      spec: title,
      deps: index === 0 ? [] : [`task-${String(index)}`],
      ...(parseSkills(graphSkills).length ? { skills: parseSkills(graphSkills) } : {}),
    }));
    await perform("create", "graph.create", { operationId: operationId(), objective: objective.trim(), nodes, ...(coordinatorSessionId ? { coordinatorSessionId } : {}) });
    setShowCreate(false);
    setObjective("");
  };

  const startWorker = async (task: JsonObject): Promise<void> => {
    const cwd = workerProject || snapshot.projects[0];
    if (!cwd) { setError(t("请先添加一个项目作为 worker 工作目录", "Add a project to use as the worker directory first")); return; }
    await perform(text(task["id"]), "worker.start", { operationId: operationId(), taskId: text(task["id"]), agent: workerAgent, cwd, worktree: "new", kind: "structured", approvalPolicy: "standard" });
  };

  const createTask = async (): Promise<void> => {
    if (!runId || !taskTitle.trim() || !taskSpec.trim()) return;
    await perform("task-create", "task.create", { operationId: operationId(), runId, title: taskTitle.trim(), spec: taskSpec.trim(), deps: taskDeps, ...(parseSkills(taskSkills).length ? { skills: parseSkills(taskSkills) } : {}) });
    setShowTaskCreate(false); setTaskTitle(""); setTaskSpec(""); setTaskDeps([]); setTaskSkills("");
  };

  const saveRunTemplate = async (): Promise<void> => {
    if (!templateName.trim() || runTasks.length === 0) return;
    const indexes = new Map(runTasks.map((task, index) => [text(task["id"]), index]));
    setBusy("template-save");
    try {
      await window.prospero.saveWorkflowTemplate({
        id: crypto.randomUUID(),
        name: templateName.trim(),
        description: templateDescription.trim(),
        nodes: runTasks.map((task) => ({
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
      setError(undefined);
    } catch (reason) { setError(displayError(reason)); }
    finally { setBusy(undefined); }
  };

  const runTemplate = async (): Promise<void> => {
    if (!selectedTemplate || !templateObjective.trim()) return;
    const nodes = selectedTemplate.nodes.map((node, index) => ({
      clientId: `template-task-${String(index + 1)}`,
      title: node.title,
      spec: node.spec,
      deps: node.dependencyIndexes.map((dependency) => `template-task-${String(dependency + 1)}`),
      ...(node.skills.length ? { skills: node.skills } : {}),
    }));
    await perform("template-run", "graph.create", { operationId: operationId(), objective: templateObjective.trim(), nodes, ...(coordinatorSessionId ? { coordinatorSessionId } : {}) });
    setSelectedTemplate(undefined);
    setTemplateObjective("");
    setTemplateLibraryOpen(false);
  };

  const completeCount = runTasks.filter((task) => ["done", "completed", "succeeded"].includes(text(task["status"]))).length;
  const runProgress = runTasks.length ? Math.round((completeCount / runTasks.length) * 100) : 0;
  const boardColumns = [
    { id: "queued", label: t("排队", "Queued"), statuses: ["pending"] },
    { id: "ready", label: t("就绪", "Ready"), statuses: ["ready"] },
    { id: "running", label: t("运行中", "Running"), statuses: ["dispatched", "running", "starting"] },
    { id: "review", label: t("待检查", "Review"), statuses: ["blocked", "failed", "waiting_approval"] },
    { id: "done", label: t("已完成", "Done"), statuses: ["done", "completed", "succeeded", "cancelled"] },
  ];

  const taskCard = (task: JsonObject) => {
    const taskId = text(task["id"]); const deps = array(task["deps"]).map(String); const dispatch = runDispatches.find((item) => text(item["taskId"]) === taskId);
    return <Card size="sm" className="run-task-card" key={taskId}><CardHeader><div className="flex items-start justify-between gap-2"><CardTitle>{text(task["title"])}</CardTitle><span className={`status-dot ${text(task["status"])}`} /></div><CardDescription>{text(task["spec"])}</CardDescription></CardHeader><CardContent className="flex flex-col gap-2">{deps.length > 0 && <Badge variant="outline" className="w-fit"><GitPullRequestArrow />{deps.length} {t("个依赖", "dependencies")}</Badge>}{dispatch && <div className="task-assignee"><Bot /><span>{text(dispatch["agent"], workerAgent)}</span><small>{text(dispatch["branch"], t("隔离工作树", "isolated worktree"))}</small></div>}</CardContent><CardFooter className="flex-wrap">
      {["pending", "blocked", "ready"].includes(text(task["status"])) && <Button variant="outline" size="sm" disabled={busy === taskId} onClick={() => void startWorker(task)}><Bot data-icon="inline-start" />{t("启动", "Start")}</Button>}
      {text(task["status"]) === "failed" && <Button variant="outline" size="sm" onClick={() => void perform(taskId, "task.retry", { operationId: operationId(), taskId })}><RefreshCw data-icon="inline-start" />{t("重试", "Retry")}</Button>}
      {dispatch && <Button variant="ghost" size="sm" onClick={() => onOpenSession(text(dispatch["sessionId"]))}>{t("打开会话", "Open session")}</Button>}
      {text(task["status"]) === "dispatched" && <Button variant="destructive" size="sm" onClick={() => void perform(taskId, "worker.stop", { operationId: operationId(), taskId, reason: "Stopped from Prospero Windows" })}><Square data-icon="inline-start" />{t("停止", "Stop")}</Button>}
    </CardFooter></Card>;
  };

  return <div className="page orchestration-page">
    <header className="flex flex-wrap items-start justify-between gap-6 border-b bg-background px-7 py-6"><div className="flex min-w-0 flex-col gap-2"><Badge variant="outline" className="w-fit">{t("目标与 Agent 编排", "GOAL & AGENT ORCHESTRATION")}</Badge><h1 className="text-2xl font-semibold tracking-tight">{t("目标与编排中心", "Runs & orchestration")}</h1><p className="max-w-2xl text-sm text-muted-foreground">{t("使用可复用 Runbook 模板，把目标拆成 DAG、绑定 Skills，并行派发隔离的 Agent worker。", "Use reusable runbook templates to break goals into DAGs, bind skills, and dispatch isolated agent workers in parallel.")}{coordinatorSessionId && <span> {t("当前会话将成为目标协调者。", "The current session will coordinate this goal.")}</span>}</p></div><div className="flex flex-wrap items-end gap-2"><label className="flex flex-col gap-1.5 text-xs text-muted-foreground">{t("项目", "Project")}<NativeSelect value={workerProject} onChange={(event) => setWorkerProject(event.target.value)}>{snapshot.projects.map((project) => <NativeSelectOption value={project} key={project}>{project.split(/[\\/]/).at(-1)}</NativeSelectOption>)}</NativeSelect></label><label className="flex flex-col gap-1.5 text-xs text-muted-foreground">Worker<NativeSelect value={workerAgent} onChange={(event) => setWorkerAgent(event.target.value)}><NativeSelectOption value="codex">Codex</NativeSelectOption><NativeSelectOption value="claude">Claude</NativeSelectOption><NativeSelectOption value="deepseek">DeepSeek</NativeSelectOption><NativeSelectOption value="opencode">OpenCode</NativeSelectOption></NativeSelect></label><Button variant="outline" onClick={() => setTemplateLibraryOpen(true)}><LibraryBig data-icon="inline-start" />{t("模板库", "Templates")}</Button><Button onClick={() => setShowCreate(true)}><Plus data-icon="inline-start" />{t("新建目标", "New goal")}</Button></div></header>
    {error && <Alert variant="destructive" className="mx-7 mt-5 w-auto"><CircleDot /><AlertTitle>{t("编排操作失败", "Orchestration action failed")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="orchestration-summary"><Card size="sm"><CardHeader><CardDescription>{t("运行", "Runs")}</CardDescription><CardTitle>{runs.length}</CardTitle></CardHeader></Card><Card size="sm"><CardHeader><CardDescription>{t("运行中任务", "Active tasks")}</CardDescription><CardTitle>{tasks.filter((task) => ["dispatched", "running", "starting"].includes(text(task["status"]))).length}</CardTitle></CardHeader></Card><Card size="sm"><CardHeader><CardDescription>{t("等待检查", "Needs review")}</CardDescription><CardTitle>{tasks.filter((task) => ["blocked", "failed", "waiting_approval"].includes(text(task["status"]))).length + gates.filter((gate) => text(gate["status"]) === "pending").length}</CardTitle></CardHeader></Card><Card size="sm"><CardHeader><CardDescription>{t("已保存模板", "Saved templates")}</CardDescription><CardTitle>{snapshot.workflowTemplates.length}</CardTitle></CardHeader></Card></div>
    <div className="orchestration-layout">
      <aside className="run-list"><div className="section-label">{t("运行", "RUNS")} · {runs.length}</div>{runs.length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><Workflow /></EmptyMedia><EmptyTitle>{t("还没有编排 Run", "No orchestration runs yet")}</EmptyTitle><EmptyDescription>{t("创建目标后，任务图会显示在这里。", "Create a goal and its task graph will appear here.")}</EmptyDescription></EmptyHeader></Empty>}{runs.map((run) => <Button variant={text(run["id"]) === runId ? "secondary" : "ghost"} key={text(run["id"])} className="h-auto w-full justify-start px-3 py-2 text-left" onClick={() => setSelectedRunId(text(run["id"]))}><span className={`status-dot ${text(run["status"])}`} /><span className="flex min-w-0 flex-col items-start gap-1"><strong className="max-w-full truncate">{text(run["objective"])}</strong><small className="text-muted-foreground">{status(text(run["status"]))} · rev {number(run["graphRevision"])}</small></span></Button>)}</aside>
      <main className="run-detail">{selectedRun ? <>
        <div className="run-hero"><div className="run-hero-copy"><div className="section-label">{t("当前运行", "CURRENT RUN")}</div><h2>{text(selectedRun["objective"])}</h2><div className="run-progress-line"><Progress value={runProgress} /><span>{completeCount} / {runTasks.length} {t("已完成", "complete")}</span></div></div><div className="button-row">
          {runTasks.length > 0 && <button onClick={() => { setTemplateName(text(selectedRun["objective"])); setTemplateDescription(""); setSaveTemplateOpen(true); }}><Save size={14} />{t("保存为模板", "Save template")}</button>}
          {text(record(selectedRun["automation"])["state"]) !== "running" && text(selectedRun["status"]) === "active" && <button onClick={() => setShowTaskCreate(true)}><Plus size={14} />{t("添加任务", "Add task")}</button>}
          {text(record(selectedRun["automation"])["state"]) === "running" ? <button onClick={() => void perform("automation", "automation.pause", { operationId: operationId(), runId })}><Pause size={14} />{t("暂停自动执行", "Pause automation")}</button> : <button onClick={() => void perform("automation", "automation.start", { operationId: operationId(), runId, agent: "codex", approvalPolicy: "standard", workspace: "run", cwd: snapshot.projects[0] ?? "." })} disabled={!snapshot.projects[0]}><Play size={14} />{t("自动执行 DAG", "Run DAG automatically")}</button>}
          {text(selectedRun["status"]) === "active" && <button onClick={() => void perform("complete", "run.complete", { operationId: operationId(), runId })}><CheckCircle2 size={14} />{t("标记完成", "Mark complete")}</button>}
          {text(selectedRun["status"]) === "active" && <button className="danger" onClick={() => void perform("abandon", "run.abandon", { operationId: operationId(), runId })}><Ban size={14} />{t("放弃", "Abandon")}</button>}
          {text(selectedRun["status"]) !== "active" && <button className="danger" onClick={() => void perform("delete", "run.delete", { operationId: operationId(), runId })}><Trash2 size={14} />{t("删除记录", "Delete record")}</button>}
        </div></div>
        <Tabs value={runView} onValueChange={(value) => setRunView(value ?? "board")} className="run-views"><TabsList variant="line"><TabsTrigger value="board"><Columns3 />{t("看板", "Board")}</TabsTrigger><TabsTrigger value="dag"><Network />DAG</TabsTrigger><TabsTrigger value="timeline"><Clock3 />{t("时间线", "Timeline")}</TabsTrigger></TabsList>
          <TabsContent value="board" className="run-view-content"><div className="run-board">{boardColumns.map((column) => { const columnTasks = runTasks.filter((task) => column.statuses.includes(text(task["status"]))); return <section className="board-column" key={column.id}><header><span>{column.label}</span><Badge variant="outline">{columnTasks.length}</Badge></header><div>{columnTasks.map(taskCard)}{columnTasks.length === 0 && <div className="board-empty">{t("暂无任务", "No tasks")}</div>}</div></section>; })}</div></TabsContent>
          <TabsContent value="dag" className="run-view-content">{runTasks.length > 0 ? <RunGraph tasks={runTasks} dispatches={runDispatches} /> : <Empty><EmptyHeader><EmptyMedia variant="icon"><Network /></EmptyMedia><EmptyTitle>{t("暂无 DAG 节点", "No DAG nodes")}</EmptyTitle><EmptyDescription>{t("添加任务后依赖图会显示在这里。", "Add tasks to populate the dependency graph.")}</EmptyDescription></EmptyHeader></Empty>}</TabsContent>
          <TabsContent value="timeline" className="run-view-content"><div className="run-timeline">{[...runTasks].reverse().map((task) => <div key={text(task["id"])}><span className={`status-dot ${text(task["status"])}`} /><div><strong>{text(task["title"])}</strong><p>{t("任务", "Task")} {status(text(task["status"]))}{text(task["updatedAt"]) ? ` · ${text(task["updatedAt"])}` : ""}</p></div></div>)}{runGates.map((gate) => <div key={text(gate["id"])}><span className={`status-dot ${text(gate["status"])}`} /><div><strong>{text(gate["question"], t("请求审批", "Gate requested"))}</strong><p>{text(gate["status"]) === "pending" ? t("等待用户决定", "Waiting for a decision") : `${t("决定", "Decision")} · ${text(gate["decision"])}`}</p></div></div>)}{runTasks.length === 0 && runGates.length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><Clock3 /></EmptyMedia><EmptyTitle>{t("暂无事件", "No events yet")}</EmptyTitle><EmptyDescription>{t("Run 的重要事件会按时间显示。", "Important run events appear here in chronological order.")}</EmptyDescription></EmptyHeader></Empty>}</div></TabsContent>
        </Tabs>
        {runGates.length > 0 && <section className="dashboard-section"><div className="section-title"><ShieldQuestion size={16} />{t("决策 Gate", "Decision gates")} <span>{runGates.length}</span></div><div className="card-grid">{runGates.map((gate) => <article className="gate-card" key={text(gate["id"])}><strong>{text(gate["question"])}</strong><div className="button-row compact">{text(gate["status"]) === "pending" ? array(gate["options"]).map(String).map((option) => <button key={option} onClick={() => void window.prospero.resolveGate(text(gate["id"]), option).catch((reason) => setError(displayError(reason)))}>{option}</button>) : <span className="resolved"><CheckCircle2 size={13} />{text(gate["decision"], t("已处理", "Resolved"))}</span>}</div></article>)}</div></section>}
        {runWorktrees.length > 0 && <section className="dashboard-section"><div className="section-title"><GitBranch size={16} />Worktrees <span>{runWorktrees.length}</span></div><div className="worktree-list">{runWorktrees.map((asset) => { const inspection = record(asset["lastInspection"]); const safe = ["safe_to_clean", "equivalent"].includes(text(inspection["state"])); return <article className="worktree-row" key={text(asset["id"])}><GitBranch size={15} /><div><strong>{text(asset["branch"], t("工作树", "Worktree"))}</strong><small>{text(asset["path"])}</small></div><span className="pill">{status(text(asset["state"]))}</span><button onClick={() => void perform(text(asset["id"]), "worktree.inspect", { assetId: text(asset["id"]), targetRef: "main" })}>{t("检查", "Inspect")}</button><button className="danger" disabled={!safe} title={safe ? t("清理已确认安全的工作树", "Clean this verified worktree") : t("必须先通过安全检查", "Run a safety check first")} onClick={() => void perform(text(asset["id"]), "worktree.cleanup", { operationId: operationId(), assetId: text(asset["id"]), targetRef: text(inspection["targetRef"], "main"), confirm: true, deleteBranch: false })}><Trash2 size={13} />{t("安全清理", "Safe cleanup")}</button></article>; })}</div></section>}
      </> : <Empty><EmptyHeader><EmptyMedia variant="icon"><Workflow /></EmptyMedia><EmptyTitle>{t("选择或创建一个 Run", "Choose or create a run")}</EmptyTitle><EmptyDescription>{t("用 DAG 拆解任务，再把独立节点派给并行 Agent。", "Break work into a DAG and dispatch independent nodes to agents in parallel.")}</EmptyDescription></EmptyHeader></Empty>}</main>
    </div>
    <Dialog open={templateLibraryOpen} onOpenChange={setTemplateLibraryOpen}><DialogContent className="sm:max-w-3xl"><DialogHeader><DialogTitle>{t("工作流模板库", "Workflow templates")}</DialogTitle><DialogDescription>{t("像 Runbook 一样复用任务结构、依赖与绑定的 Skills；每次运行时再填写具体目标。", "Reuse task structure, dependencies, and bound skills like a runbook, then provide a fresh objective for each run.")}</DialogDescription></DialogHeader><div className="template-library">{snapshot.workflowTemplates.map((template) => <Card size="sm" key={template.id}><CardHeader><div className="flex items-start justify-between gap-3"><div className="min-w-0"><CardTitle>{template.name}</CardTitle><CardDescription>{template.description || t("可复用的 Agent 工作流", "Reusable agent workflow")}</CardDescription></div><Badge variant="outline">{template.nodes.length} {t("个任务", "tasks")}</Badge></div></CardHeader><CardContent><div className="template-node-preview">{template.nodes.slice(0, 4).map((node, index) => <span key={`${template.id}:${String(index)}`}>{String(index + 1)}. {node.title}</span>)}</div></CardContent><CardFooter className="justify-between"><Button variant="ghost" size="sm" onClick={() => void window.prospero.deleteWorkflowTemplate(template.id).catch((reason) => setError(displayError(reason)))}><Trash2 data-icon="inline-start" />{t("删除", "Delete")}</Button><Button size="sm" onClick={() => { setSelectedTemplate(template); setTemplateObjective(""); setTemplateLibraryOpen(false); }}><Rocket data-icon="inline-start" />{t("使用模板", "Use template")}</Button></CardFooter></Card>)}{snapshot.workflowTemplates.length === 0 && <Empty><EmptyHeader><EmptyMedia variant="icon"><LibraryBig /></EmptyMedia><EmptyTitle>{t("还没有模板", "No templates yet")}</EmptyTitle><EmptyDescription>{t("打开一个已有 Run，选择“保存为模板”。", "Open an existing run and choose Save template.")}</EmptyDescription></EmptyHeader></Empty>}</div><DialogFooter><Button variant="outline" onClick={() => setTemplateLibraryOpen(false)}>{t("关闭", "Close")}</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={saveTemplateOpen} onOpenChange={setSaveTemplateOpen}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t("保存工作流模板", "Save workflow template")}</DialogTitle><DialogDescription>{t("保存当前 Run 的任务、依赖关系和 Skills，不保存运行状态或会话。", "Save tasks, dependencies, and skills from this run without runtime state or sessions.")}</DialogDescription></DialogHeader><FieldGroup><Field><FieldLabel htmlFor="template-name">{t("模板名称", "Template name")}</FieldLabel><Input id="template-name" value={templateName} onChange={(event) => setTemplateName(event.target.value)} autoFocus /></Field><Field><FieldLabel htmlFor="template-description">{t("说明", "Description")}</FieldLabel><Textarea id="template-description" rows={3} value={templateDescription} onChange={(event) => setTemplateDescription(event.target.value)} placeholder={t("何时使用这个模板", "When to use this template")} /><FieldDescription>{runTasks.length} {t("个任务会被保存", "tasks will be saved")}</FieldDescription></Field></FieldGroup><DialogFooter><Button variant="outline" onClick={() => setSaveTemplateOpen(false)}>{t("取消", "Cancel")}</Button><Button disabled={!templateName.trim() || busy === "template-save"} onClick={() => void saveRunTemplate()}><Save data-icon="inline-start" />{t("保存模板", "Save template")}</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={Boolean(selectedTemplate)} onOpenChange={(open) => { if (!open) setSelectedTemplate(undefined); }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{selectedTemplate?.name}</DialogTitle><DialogDescription>{t("为这次运行填写可验收的最终目标，模板中的 DAG 与 Skills 会被复制到新 Run。", "Enter a verifiable outcome for this run. The template DAG and skills will be copied into a new run.")}</DialogDescription></DialogHeader><Field><FieldLabel htmlFor="template-objective">{t("本次目标", "Run objective")}</FieldLabel><Textarea id="template-objective" rows={4} value={templateObjective} onChange={(event) => setTemplateObjective(event.target.value)} autoFocus placeholder={t("描述这一次要交付的具体结果", "Describe the concrete result to deliver this time")} /><FieldDescription>{selectedTemplate?.nodes.length ?? 0} {t("个任务将被创建", "tasks will be created")}</FieldDescription></Field><DialogFooter><Button variant="outline" onClick={() => setSelectedTemplate(undefined)}>{t("取消", "Cancel")}</Button><Button disabled={!templateObjective.trim() || busy === "template-run"} onClick={() => void runTemplate()}><Rocket data-icon="inline-start" />{t("从模板运行", "Run from template")}</Button></DialogFooter></DialogContent></Dialog>

    {showCreate && <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title"><Workflow size={18} /><div><h2>{t("创建目标任务图", "Create goal graph")}</h2><p>{t("每行一个任务，默认按顺序建立依赖；Skill 会冻结到每个 worker。", "Enter one task per line. Dependencies follow the listed order and skills are pinned to each worker.")}</p></div></div><label>{t("总体目标", "Goal")}<textarea rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} autoFocus placeholder={t("描述可以验收的最终结果", "Describe a verifiable final outcome")} /></label><label>{t("初始任务", "Initial tasks")}<textarea rows={7} value={nodeLines} onChange={(event) => setNodeLines(event.target.value)} /></label><label><span className="label-with-icon"><Sparkles size={13} />{t("绑定 Skill（最多 5 个）", "Bind skills (up to 5)")}</span><input value={graphSkills} onChange={(event) => setGraphSkills(event.target.value)} placeholder="$frontend-design, $playwright" /></label>{parseSkills(graphSkills).length > 0 && <div className="skill-chip-row">{parseSkills(graphSkills).map((skill) => <span key={skill}>${skill}</span>)}</div>}<div className="button-row modal-actions"><button onClick={() => setShowCreate(false)}>{t("取消", "Cancel")}</button><button className="primary" onClick={() => void createGraph()} disabled={!objective.trim() || busy === "create"}><CircleDot size={14} />{t("创建目标与 DAG", "Create goal and DAG")}</button></div></div></div>}
    {showTaskCreate && <div className="modal-backdrop" onMouseDown={() => setShowTaskCreate(false)}><div className="modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title"><Plus size={18} /><div><h2>{t("添加任务", "Add task")}</h2><p>{t("选择前置任务和 Skill，daemon 会校验 DAG 并冻结 Skill 来源。", "Choose dependencies and skills. The daemon validates the DAG and pins skill sources.")}</p></div></div><label>{t("任务标题", "Task title")}<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} autoFocus /></label><label>{t("任务要求", "Task requirements")}<textarea rows={5} value={taskSpec} onChange={(event) => setTaskSpec(event.target.value)} /></label><label><span className="label-with-icon"><Sparkles size={13} />{t("任务 Skill", "Task skills")}</span><input value={taskSkills} onChange={(event) => setTaskSkills(event.target.value)} placeholder={t("$skill-name，空格或逗号分隔", "$skill-name, separated by spaces or commas")} /></label>{parseSkills(taskSkills).length > 0 && <div className="skill-chip-row">{parseSkills(taskSkills).map((skill) => <span key={skill}>${skill}</span>)}</div>}{runTasks.length > 0 && <div><div className="section-label">{t("前置依赖", "Dependencies")}</div><div className="dependency-picker">{runTasks.map((task) => { const id = text(task["id"]); return <label className="check-row" key={id}><input type="checkbox" checked={taskDeps.includes(id)} onChange={(event) => setTaskDeps((current) => event.target.checked ? [...current, id] : current.filter((item) => item !== id))} />{text(task["title"])}</label>; })}</div></div>}<div className="button-row modal-actions"><button onClick={() => setShowTaskCreate(false)}>{t("取消", "Cancel")}</button><button className="primary" onClick={() => void createTask()} disabled={!taskTitle.trim() || !taskSpec.trim() || busy === "task-create"}><Plus size={14} />{t("添加任务", "Add task")}</button></div></div></div>}
  </div>;
}
