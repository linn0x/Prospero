import { useCallback, useMemo, useState } from "react";
import * as Clipboard from "expo-clipboard";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { randomUUID } from "expo-crypto";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import Svg, { Path } from "react-native-svg";
import type {
  AgentAccount,
  AgentKind,
  ApprovalPolicy,
  OrchestrationRun,
  OrchestrationTask,
  OrchestrationWorktreeAsset,
} from "@prospero/protocol";
import { AgentIcon } from "@/components/AgentIcon";
import { Icon } from "@/components/Icon";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { primaryPaneWidth, useAdaptiveLayout } from "@/lib/adaptive-layout";
import { useHostConnection } from "@/lib/use-host-connection";
import {
  groupOrchestrationRuns,
  orchestrationConnectionNotice,
  selectedRouteRunId,
} from "@/lib/orchestration-overview";
import { useOrchestrationSnapshot } from "@/lib/use-orchestration-snapshot";
import {
  worktreeAssetPresentation,
  worktreeCanClean,
  worktreeInspectionSummary,
} from "@/lib/worktree-assets";
import { color, font, radius, space, statusColor } from "@/lib/theme";

const WORKER_AGENTS: AgentKind[] = ["claude", "codex", "opencode", "grok", "trae"];
const POLICIES: ApprovalPolicy[] = ["strict", "standard", "yolo"];

type Editor =
  | { kind: "graph" }
  | { kind: "run" }
  | { kind: "task" }
  | { kind: "automation" }
  | { kind: "worker"; taskId: string }
  | null;

interface DraftNode {
  id: string;
  title: string;
  spec: string;
  deps: string[];
}

interface DraftSnapshot {
  objective: string;
  nodes: DraftNode[];
}

interface TopologyNode {
  id: string;
  title: string;
  deps: string[];
  status?: OrchestrationTask["status"];
  incomplete?: boolean;
  locked?: boolean;
}

const GRAPH_NODE_WIDTH = 148;
const GRAPH_NODE_HEIGHT = 68;
const GRAPH_COLUMN_GAP = 50;
const GRAPH_ROW_GAP = 18;
const GRAPH_PADDING = 14;

function draftNode(index: number): DraftNode {
  return { id: randomUUID(), title: `任务 ${index}`, spec: "", deps: [] };
}

function cloneDraftNodes(nodes: DraftNode[]): DraftNode[] {
  return nodes.map((node) => ({ ...node, deps: [...node.deps] }));
}

function draftNodesEqual(left: DraftNode[], right: DraftNode[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((node, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && node.id === candidate.id
      && node.title === candidate.title
      && node.spec === candidate.spec
      && node.deps.length === candidate.deps.length
      && node.deps.every((dependency, dependencyIndex) => dependency === candidate.deps[dependencyIndex]);
  });
}

function transitivelyDepends(nodes: DraftNode[], start: string, target: string): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return byId.get(id)?.deps.some(visit) ?? false;
  };
  return visit(start);
}

function graphHasCycle(nodes: DraftNode[]): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const cycle = byId.get(id)?.deps.some(visit) ?? false;
    visiting.delete(id);
    visited.add(id);
    return cycle;
  };
  return nodes.some((node) => visit(node.id));
}

const taskStatusLabel: Record<OrchestrationTask["status"], string> = {
  pending: "待派发",
  dispatched: "执行中",
  blocked: "等待决策",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const runStatusLabel: Record<OrchestrationRun["status"], string> = {
  active: "进行中",
  completed: "已完成",
  abandoned: "已放弃",
};

function isTaskReady(task: OrchestrationTask, tasks: OrchestrationTask[]): boolean {
  if (task.status !== "pending") return false;
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return task.deps.every((id) => byId.get(id)?.status === "done");
}

function runLabel(run: OrchestrationRun): string {
  return run.coordinatorSessionId === null ? "手工" : "协调者";
}

export default function OrchestrationScreen() {
  const { hostId, runId } = useLocalSearchParams<{ hostId: string; runId?: string | string[] }>();
  const { host, conn, runtime } = useHostConnection(hostId);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editor, setEditor] = useState<Editor>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [taskView, setTaskView] = useState<"graph" | "list">("graph");
  const [selectedTopologyTaskId, setSelectedTopologyTaskId] = useState<string | null>(null);

  const [objective, setObjective] = useState("");
  const [draftNodes, setDraftNodes] = useState<DraftNode[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [graphOperationId, setGraphOperationId] = useState("");
  const [graphEditingRunId, setGraphEditingRunId] = useState<string | null>(null);
  const [graphBaseRevision, setGraphBaseRevision] = useState(0);
  const [graphPersistedIds, setGraphPersistedIds] = useState<string[]>([]);
  const [graphLockedIds, setGraphLockedIds] = useState<string[]>([]);
  const [graphBaseline, setGraphBaseline] = useState<DraftNode[]>([]);
  const [undoStack, setUndoStack] = useState<DraftSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<DraftSnapshot[]>([]);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskSpec, setTaskSpec] = useState("");
  const [taskDeps, setTaskDeps] = useState<string[]>([]);
  const [workerAgent, setWorkerAgent] = useState<AgentKind>("codex");
  const [workerAccountId, setWorkerAccountId] = useState<string | undefined>();
  const [workerCwd, setWorkerCwd] = useState("");
  const [automationAgent, setAutomationAgent] = useState<AgentKind>("codex");
  const [automationAccountId, setAutomationAccountId] = useState<string | undefined>();
  const [automationCwd, setAutomationCwd] = useState("");
  const [automationWorkspace, setAutomationWorkspace] = useState<"run" | "current">("run");
  const [automationPolicy, setAutomationPolicy] = useState<ApprovalPolicy>("standard");
  const [workspacePath, setWorkspacePath] = useState("");
  const [worktree, setWorktree] = useState<"new" | "none">("new");
  const [policy, setPolicy] = useState<ApprovalPolicy>("standard");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [agentAccounts, setAgentAccounts] = useState<AgentAccount[]>([]);
  const adaptiveLayout = useAdaptiveLayout();
  const contentPaneWidth = primaryPaneWidth(adaptiveLayout.width, adaptiveLayout.verticalPanes);
  const snapshot = useOrchestrationSnapshot(conn, runtime.status, 5_000, setBanner);

  useFocusEffect(
    useCallback(() => {
      if (!conn || runtime.status !== "connected" || !conn.supportsAgentAccounts) return undefined;
      let cancelled = false;
      void conn.agentAccounts().then((accounts) => {
        if (!cancelled) setAgentAccounts(accounts);
      }).catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [conn, runtime.status]),
  );

  const runGroups = useMemo(
    () => groupOrchestrationRuns(snapshot?.runs ?? []),
    [snapshot],
  );
  const runs = runGroups.all;
  const accountsFor = (agent: AgentKind): AgentAccount[] =>
    agent === "claude" || agent === "codex"
      ? agentAccounts.filter((account) => account.agent === agent)
      : [];
  const defaultAccountId = (agent: AgentKind): string | undefined =>
    accountsFor(agent).find((account) => account.isDefault)?.id ?? accountsFor(agent)[0]?.id;

  const requestedRunId = selectedRouteRunId(runId, runs);
  const selectedRunCandidate = selectedRunId
    ? runs.find((run) => run.id === selectedRunId)
    : undefined;
  const activeRunId = selectedRunCandidate &&
    (selectedRunCandidate.status === "active" || historyOpen)
    ? selectedRunId
    : requestedRunId ?? runGroups.active[0]?.id ?? (historyOpen ? runGroups.history[0]?.id ?? null : null);
  const selectedRun = runs.find((run) => run.id === activeRunId) ?? null;
  const tasks = useMemo(
    () => (snapshot?.tasks ?? []).filter((task) => task.runId === activeRunId),
    [snapshot, activeRunId],
  );
  const dispatches = useMemo(
    () => (snapshot?.dispatches ?? []).filter((dispatch) => dispatch.runId === activeRunId),
    [snapshot, activeRunId],
  );
  const worktreeAssets = useMemo(
    () => (snapshot?.worktreeAssets ?? []).filter((asset) => asset.runId === activeRunId),
    [snapshot, activeRunId],
  );
  const pendingGates = (snapshot?.gates ?? []).filter(
    (gate) => gate.runId === activeRunId && gate.status === "pending",
  );
  const manualRun = selectedRun?.coordinatorSessionId === null;
  const canMutate = runtime.status === "connected" && conn?.supportsManualOrchestration === true;
  const canCreateGraph = runtime.status === "connected" && conn?.supportsGraphOrchestration === true;
  const canAutomate = runtime.status === "connected" && conn?.supportsAutomationOrchestration === true;
  const canManage = runtime.status === "connected" && conn?.supportsOrchestrationManagement === true;
  const canManageLifecycle = runtime.status === "connected" && conn?.supportsOrchestrationLifecycle === true;
  const canManageRunLifecycle = runtime.status === "connected" &&
    conn?.supportsOrchestrationRunLifecycle === true;
  const canManageWorktrees = runtime.status === "connected" &&
    conn?.supportsOrchestrationWorktrees === true;
  const connectionNotice = orchestrationConnectionNotice(
    runtime.status,
    runtime.lastError,
    host?.name,
  );
  const automationRunning = selectedRun?.automation?.state === "running";
  const activeTopologyTaskId = selectedTopologyTaskId && tasks.some(
    (task) => task.id === selectedTopologyTaskId,
  ) ? selectedTopologyTaskId : tasks[0]?.id ?? null;
  const selectedDraft = draftNodes.find((node) => node.id === selectedDraftId) ?? null;
  const graphIsEditing = graphEditingRunId !== null;
  const lockedDraftIds = useMemo(() => new Set(graphLockedIds), [graphLockedIds]);
  const editableDraftNodes = graphIsEditing
    ? draftNodes.filter((node) => !lockedDraftIds.has(node.id))
    : draftNodes;
  const deletedPersistedIds = graphIsEditing
    ? graphPersistedIds.filter((id) => !draftNodes.some((node) => node.id === id))
    : [];
  const graphHasChanges = !graphIsEditing || !draftNodesEqual(draftNodes, graphBaseline);
  const graphIssue = objective.trim().length === 0
    ? "先填写编排目标"
    : editableDraftNodes.length === 0 && deletedPersistedIds.length === 0
      ? "没有可编辑的待派发任务；可以先添加新任务"
      : editableDraftNodes.some((node) => node.title.trim().length === 0)
      ? "每个任务都需要标题"
      : editableDraftNodes.some((node) => node.spec.trim().length === 0)
        ? "每个任务都需要交付说明"
        : graphHasCycle(draftNodes)
          ? "依赖关系不能形成环"
          : !graphHasChanges
            ? "尚未修改"
          : null;

  const graphSnapshot = (): DraftSnapshot => ({
    objective,
    nodes: cloneDraftNodes(draftNodes),
  });

  const recordGraphChange = (): void => {
    setUndoStack((current) => [...current, graphSnapshot()].slice(-80));
    setRedoStack([]);
  };

  const selectAvailableDraft = (nodes: DraftNode[], preferredId: string | null): void => {
    setSelectedDraftId(nodes.some((node) => node.id === preferredId) ? preferredId : nodes[0]?.id ?? null);
  };

  const undoGraph = (): void => {
    const previous = undoStack.at(-1);
    if (!previous) return;
    setRedoStack((current) => [...current, graphSnapshot()].slice(-80));
    setUndoStack((current) => current.slice(0, -1));
    setObjective(previous.objective);
    const restored = cloneDraftNodes(previous.nodes);
    setDraftNodes(restored);
    selectAvailableDraft(restored, selectedDraftId);
  };

  const redoGraph = (): void => {
    const next = redoStack.at(-1);
    if (!next) return;
    setUndoStack((current) => [...current, graphSnapshot()].slice(-80));
    setRedoStack((current) => current.slice(0, -1));
    setObjective(next.objective);
    const restored = cloneDraftNodes(next.nodes);
    setDraftNodes(restored);
    selectAvailableDraft(restored, selectedDraftId);
  };

  const resetGraphHistory = (): void => {
    setUndoStack([]);
    setRedoStack([]);
  };

  const openRunEditor = (): void => {
    setObjective("");
    if (canCreateGraph) {
      const first = draftNode(1);
      setDraftNodes([first]);
      setSelectedDraftId(first.id);
      setGraphOperationId(randomUUID());
      setGraphEditingRunId(null);
      setGraphBaseRevision(0);
      setGraphPersistedIds([]);
      setGraphLockedIds([]);
      setGraphBaseline([]);
      resetGraphHistory();
      setEditor({ kind: "graph" });
    } else {
      setEditor({ kind: "run" });
    }
  };

  const openExistingGraphEditor = (): void => {
    if (
      !selectedRun ||
      selectedRun.status !== "active" ||
      !manualRun ||
      !canCreateGraph ||
      automationRunning
    ) return;
    const existing = tasks.map((task) => ({
      id: task.id,
      title: task.title,
      spec: task.spec,
      deps: [...task.deps],
    }));
    const initial = existing.length > 0 ? existing : [draftNode(1)];
    setObjective(selectedRun.objective);
    setDraftNodes(cloneDraftNodes(initial));
    setSelectedDraftId(initial[0]?.id ?? null);
    setGraphOperationId(randomUUID());
    setGraphEditingRunId(selectedRun.id);
    setGraphBaseRevision(selectedRun.graphRevision ?? 0);
    setGraphPersistedIds(existing.map((node) => node.id));
    setGraphLockedIds(tasks.filter((task) => task.status !== "pending").map((task) => task.id));
    setGraphBaseline(cloneDraftNodes(existing));
    resetGraphHistory();
    setEditor({ kind: "graph" });
  };

  const openTaskEditor = (): void => {
    if (selectedRun?.status !== "active" || automationRunning) return;
    setTaskTitle("");
    setTaskSpec("");
    setTaskDeps([]);
    setEditor({ kind: "task" });
  };

  const openWorkerEditor = (taskId: string): void => {
    if (selectedRun?.status !== "active") return;
    setWorkerAgent("codex");
    setWorkerAccountId(defaultAccountId("codex"));
    setWorktree("new");
    setPolicy("standard");
    setEditor({ kind: "worker", taskId });
  };

  const openAutomationEditor = (): void => {
    if (
      !selectedRun ||
      selectedRun.status !== "active" ||
      !manualRun ||
      !canAutomate ||
      automationRunning
    ) return;
    const existing = selectedRun.automation;
    setAutomationAgent(
      existing && WORKER_AGENTS.includes(existing.agent) ? existing.agent : "codex",
    );
    const nextAgent = existing && WORKER_AGENTS.includes(existing.agent) ? existing.agent : "codex";
    setAutomationAccountId(existing?.accountId ?? defaultAccountId(nextAgent));
    setAutomationCwd(existing?.cwd ?? "");
    setAutomationWorkspace(existing?.workspace ?? "run");
    setAutomationPolicy(existing?.approvalPolicy ?? "standard");
    setWorkspacePath("");
    setEditor({ kind: "automation" });
  };

  const createRun = (): void => {
    const value = objective.trim();
    if (!conn || value.length === 0) return;
    if (!conn.createOrchestrationRun(value)) {
      setBanner("daemon 还不支持人工编排，或这台设备没有权限。");
      return;
    }
    setSelectedRunId(null);
    setEditor(null);
  };

  const publishGraph = (): void => {
    if (!conn || graphIssue !== null || graphOperationId.length === 0) return;
    const nodes = editableDraftNodes.map((node) => ({
        clientId: node.id,
        title: node.title.trim(),
        spec: node.spec.trim(),
        deps: node.deps,
      }));
    const accepted = graphEditingRunId === null
      ? conn.createOrchestrationGraph({
        operationId: graphOperationId,
        objective: objective.trim(),
        nodes,
      })
      : conn.applyOrchestrationGraph({
        runId: graphEditingRunId,
        baseRevision: graphBaseRevision,
        operationId: graphOperationId,
        nodes,
        deleteTaskIds: deletedPersistedIds,
      });
    if (!accepted) {
      setBanner("无法发布任务图，请检查连接、daemon 版本与人工编排权限。");
      return;
    }
    if (!graphIsEditing) setSelectedRunId(null);
    setEditor(null);
  };

  const updateDraft = (id: string, patch: Partial<Pick<DraftNode, "title" | "spec" | "deps">>): void => {
    if (lockedDraftIds.has(id)) return;
    recordGraphChange();
    setDraftNodes((current) => current.map((node) => node.id === id ? { ...node, ...patch } : node));
  };

  const addDraftNode = (): void => {
    const node = draftNode(draftNodes.length + 1);
    recordGraphChange();
    setDraftNodes((current) => [...current, node]);
    setSelectedDraftId(node.id);
  };

  const removeDraftNode = (id: string): void => {
    if (lockedDraftIds.has(id) || (!graphIsEditing && draftNodes.length <= 1)) return;
    recordGraphChange();
    const next = draftNodes
      .filter((node) => node.id !== id)
      .map((node) => ({ ...node, deps: node.deps.filter((dep) => dep !== id) }));
    setDraftNodes(next);
    setSelectedDraftId(next[0]?.id ?? null);
  };

  const createTask = (): void => {
    if (!conn || !selectedRun) return;
    const title = taskTitle.trim();
    const spec = taskSpec.trim();
    if (title.length === 0 || spec.length === 0) return;
    if (!conn.createOrchestrationTask({
      runId: selectedRun.id,
      title,
      spec,
      deps: taskDeps,
    })) {
      setBanner("无法创建任务，请检查人工编排权限。");
      return;
    }
    setEditor(null);
  };

  const startWorker = (): void => {
    if (!conn || editor?.kind !== "worker") return;
    const cwd = workerCwd.trim();
    if (cwd.length === 0) return;
    if (!conn.startOrchestrationWorker({
      taskId: editor.taskId,
      agent: workerAgent,
      ...(workerAccountId ? { accountId: workerAccountId } : {}),
      worktree,
      cwd,
      approvalPolicy: policy,
    })) {
      setBanner("无法派发 worker，请检查连接与人工编排权限。");
      return;
    }
    setEditor(null);
  };

  const startAutomation = (): void => {
    if (!conn || !selectedRun) return;
    const cwd = automationCwd.trim();
    if (cwd.length === 0) return;
    if (!conn.startOrchestrationAutomation({
      runId: selectedRun.id,
      agent: automationAgent,
      ...(automationAccountId ? { accountId: automationAccountId } : {}),
      approvalPolicy: automationPolicy,
      workspace: automationWorkspace,
      cwd,
    })) {
      setBanner("无法启动自动执行，请检查 daemon 版本、项目目录与编排权限。");
      return;
    }
    setEditor(null);
  };

  const pauseAutomation = (): void => {
    if (!conn || !selectedRun) return;
    if (!conn.pauseOrchestrationAutomation(selectedRun.id)) {
      setBanner("无法暂停自动执行，请检查连接与 daemon 版本。");
    }
  };

  const inspectWorktree = (asset: OrchestrationWorktreeAsset): void => {
    if (!conn || !canManageWorktrees) return;
    if (!conn.inspectOrchestrationWorktree(asset.id)) {
      setBanner("无法检查工作树，请检查连接、daemon 版本与编排权限。");
    }
  };

  const confirmCleanupWorktree = (asset: OrchestrationWorktreeAsset): void => {
    if (!conn || !canManageWorktrees || !worktreeCanClean(asset)) return;
    Alert.alert(
      "清理这个工作树？",
      `将移除主机上的工作树目录：\n${asset.path}\n\n服务端会在删除前再次检查。分支会保留，方便恢复。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "清理工作树",
          style: "destructive",
          onPress: () => {
            if (!conn.cleanupOrchestrationWorktree({ assetId: asset.id })) {
              setBanner("无法清理工作树，请检查连接、daemon 版本与编排权限。");
            }
          },
        },
      ],
    );
  };

  const copyWorktreePath = (asset: OrchestrationWorktreeAsset): void => {
    void Clipboard.setStringAsync(asset.path);
    setBanner("工作树路径已复制到剪贴板。");
  };

  const showWorktreeSummary = (asset: OrchestrationWorktreeAsset): void => {
    Alert.alert(
      "工作树摘要",
      `路径：${asset.path}\n\n${worktreeInspectionSummary(asset)}`,
      [
        { text: "关闭", style: "cancel" },
        { text: "重新检查", onPress: () => inspectWorktree(asset) },
      ],
    );
  };

  const openWorktreePath = (asset: OrchestrationWorktreeAsset): void => {
    const linkedDispatch = asset.dispatchId
      ? dispatches.find((dispatch) => dispatch.id === asset.dispatchId)
      : dispatches.find((dispatch) => dispatch.worktreePath === asset.path);
    if (linkedDispatch) {
      router.push(`/host/${hostId}/files/${linkedDispatch.sessionId}`);
      return;
    }
    copyWorktreePath(asset);
  };

  const relatedWorktreeNotice = (): string => {
    const preservedAssets = worktreeAssets.filter((asset) => asset.state !== "cleaned");
    if (preservedAssets.length === 0) return "";
    const workerCount = preservedAssets.filter((asset) => asset.kind === "worker").length;
    const locations = preservedAssets.map((asset) => {
      const task = asset.taskId ? tasks.find((candidate) => candidate.id === asset.taskId) : undefined;
      const owner = asset.kind === "run" ? "共享 Run" : `worker：${task?.title ?? asset.taskId ?? "已删除任务"}`;
      return `${owner}\n${asset.path}`;
    }).join("\n\n");
    return `\n\n删除编排不会清理全部 ${String(preservedAssets.length)} 个关联工作树（其中 ${String(workerCount)} 个 worker 工作树）。它们会保留在主机上：\n${locations}`;
  };

  const confirmDeleteRun = (): void => {
    if (!conn || !selectedRun || !canManage) return;
    const activeWorkers = dispatches.filter(
      (dispatch) => dispatch.state === "starting" || dispatch.state === "running",
    );
    if (activeWorkers.length > 0) {
      Alert.alert(
        "暂时不能删除",
        `还有 ${activeWorkers.length} 个 worker 正在运行。请先完成或停止这些会话，再删除编排。`,
      );
      return;
    }
    const workspaceNotice = relatedWorktreeNotice();
    Alert.alert(
      "删除这条编排？",
      `“${selectedRun.objective}”及其任务、消息和 Gate 会从编排列表中删除。${workspaceNotice}`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => {
            if (!conn.deleteOrchestrationRun(selectedRun.id)) {
              setBanner("无法删除编排，请检查连接、daemon 版本与权限。");
              return;
            }
            setEditor(null);
            setSelectedRunId(null);
          },
        },
      ],
    );
  };

  const confirmCompleteRun = (): void => {
    if (!conn || !selectedRun || !canManageRunLifecycle) return;
    const activeWorkers = dispatches.filter(
      (dispatch) => dispatch.state === "starting" || dispatch.state === "running",
    );
    const unfinished = tasks.filter(
      (task) => task.status !== "done" && task.status !== "cancelled",
    );
    const blockers = [
      activeWorkers.length > 0 ? `${String(activeWorkers.length)} 个 worker 仍在运行` : null,
      unfinished.length > 0 ? `${String(unfinished.length)} 个任务尚未结束` : null,
      pendingGates.length > 0 ? `${String(pendingGates.length)} 个 Gate 待处理` : null,
      automationRunning ? "自动执行仍在运行" : null,
    ].filter((item): item is string => item !== null);
    if (blockers.length > 0) {
      Alert.alert("暂时不能完成", `${blockers.join("；")}。请先处理后再完成 Goal。`);
      return;
    }
    Alert.alert(
      "标记为已完成？",
      `“${selectedRun.objective}”会进入只读历史，关联会话默认折叠。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "完成",
          onPress: () => {
            if (!conn.completeOrchestrationRun(selectedRun.id)) {
              setBanner("无法完成 Goal，请升级并重启 daemon 后重试。");
              return;
            }
            setHistoryOpen(true);
            setEditor(null);
          },
        },
      ],
    );
  };

  const confirmAbandonRun = (): void => {
    if (!conn || !selectedRun || !canManageRunLifecycle) return;
    const activeWorkers = dispatches.filter(
      (dispatch) => dispatch.state === "starting" || dispatch.state === "running",
    );
    if (activeWorkers.length > 0) {
      Alert.alert(
        "暂时不能放弃",
        `还有 ${String(activeWorkers.length)} 个 worker 正在运行。请先停止它们，避免留下游离工作。`,
      );
      return;
    }
    Alert.alert(
      "放弃这条 Goal？",
      `“${selectedRun.objective}”会进入只读历史；尚未执行的任务和待处理 Gate 会一并取消。`,
      [
        { text: "返回", style: "cancel" },
        {
          text: "放弃 Goal",
          style: "destructive",
          onPress: () => {
            if (!conn.abandonOrchestrationRun(selectedRun.id)) {
              setBanner("无法放弃 Goal，请升级并重启 daemon 后重试。");
              return;
            }
            setHistoryOpen(true);
            setEditor(null);
          },
        },
      ],
    );
  };

  const confirmStopWorker = (task: OrchestrationTask): void => {
    if (!conn || !canManageLifecycle) return;
    Alert.alert(
      "停止这个 worker？",
      `“${task.title}”当前会话会被终止，本次派发记为已放弃，任务进入失败状态后可以重试。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "停止 worker",
          style: "destructive",
          onPress: () => {
            if (!conn.stopOrchestrationWorker(task.id, "由移动端用户停止 worker")) {
              setBanner("无法停止 worker，请检查连接、daemon 版本与权限。");
            }
          },
        },
      ],
    );
  };

  const confirmCancelTask = (task: OrchestrationTask): void => {
    if (!conn || !canManageLifecycle) return;
    Alert.alert(
      "取消这个任务？",
      `“${task.title}”会变为已取消；依赖它的下游任务不会自动放行。`,
      [
        { text: "返回", style: "cancel" },
        {
          text: "取消任务",
          style: "destructive",
          onPress: () => {
            if (!conn.cancelOrchestrationTask(task.id, "由移动端用户取消")) {
              setBanner("无法取消任务，请检查连接、daemon 版本与权限。");
            }
          },
        },
      ],
    );
  };

  const retryTask = (task: OrchestrationTask): void => {
    if (!conn || !canManageLifecycle) return;
    if (!conn.retryOrchestrationTask(task.id)) {
      setBanner("无法重试任务，请检查连接、daemon 版本与权限。");
    }
  };

  const openWorkerSession = (taskId: string): void => {
    const dispatch = [...dispatches]
      .filter((candidate) => candidate.taskId === taskId)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
    if (dispatch) router.push(`/host/${hostId}/session/${dispatch.sessionId}`);
  };

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen
        options={{
          title: "Agent 编排",
          headerRight: () => canMutate ? (
            <Pressable
              onPress={openRunEditor}
              hitSlop={10}
              accessibilityLabel={canCreateGraph ? "可视化新建编排" : "新建手工 Run"}
            >
              <Icon name="plus" size={19} color={color.accent} weight="semibold" />
            </Pressable>
          ) : null,
        }}
      />

      <View
        style={[
          styles.contentPane,
          adaptiveLayout.verticalPanes && { alignSelf: "flex-start", width: contentPaneWidth },
        ]}
      >
        {banner !== null && (
          <Pressable style={styles.banner} onPress={() => setBanner(null)}>
            <Text style={styles.bannerText}>{banner}（点击关闭）</Text>
          </Pressable>
        )}

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Icon name="point.3.connected.trianglepath.dotted" size={24} color={color.accent} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={styles.heroTitle}>画出依赖，再指定 Agent 执行</Text>
            <Text style={styles.heroDetail}>
              可视化任务图会原子保存在电脑端；worker 只有显式交付才会完成任务。
            </Text>
          </View>
        </View>

        {connectionNotice !== null ? (
          <View
            style={[
              styles.notice,
              connectionNotice.tone === "danger" && styles.noticeDanger,
              connectionNotice.tone === "quiet" && styles.noticeQuiet,
            ]}
            accessibilityLiveRegion={connectionNotice.tone === "danger" ? "assertive" : "polite"}
          >
            <Text
              style={[
                styles.noticeText,
                connectionNotice.tone === "danger" && styles.noticeDangerText,
                connectionNotice.tone === "quiet" && styles.noticeQuietText,
              ]}
            >
              {connectionNotice.text}
            </Text>
            {connectionNotice.canRetry && (
              <Pressable
                style={styles.noticeRetry}
                onPress={() => conn?.kick()}
                accessibilityRole="button"
                accessibilityLabel={`重试连接 ${host?.name ?? "电脑"}`}
                accessibilityHint="重新连接后刷新编排状态"
              >
                <Text style={styles.noticeRetryText}>重试连接</Text>
              </Pressable>
            )}
          </View>
        ) : !conn?.supportsOrchestrationSnapshot ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>电脑端 daemon 版本过旧，升级后现有配对会自动保留。</Text>
          </View>
        ) : null}

        {conn?.supportsOrchestrationSnapshot && !conn.supportsManualOrchestration && (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              当前只能查看编排和处理 Gate。请升级 daemon，或为该设备开启人工编排权限。
            </Text>
          </View>
        )}

        {editor?.kind === "graph" && (
          <EditorCard
            title={graphIsEditing ? "编辑任务图" : "可视化新建编排"}
            onCancel={() => setEditor(null)}
          >
            <TextInput
              value={objective}
              onChangeText={(value) => {
                recordGraphChange();
                setObjective(value);
              }}
              style={[styles.multilineInput, graphIsEditing && styles.readOnlyInput]}
              placeholder="最终目标，例如：完成协议兼容并发布移动端与桌面端"
              placeholderTextColor={color.textFaint}
              selectionColor={color.accent}
              multiline
              editable={!graphIsEditing}
              autoFocus={!graphIsEditing}
            />
            {graphIsEditing && (
              <Text style={styles.graphHint}>
                基于 r{graphBaseRevision} 编辑 · {graphLockedIds.length} 个运行中或已结束节点只读
              </Text>
            )}

            <View style={styles.graphEditorToolbar}>
              <View style={styles.graphEditorCopy}>
                <Text style={styles.fieldLabel}>任务依赖图</Text>
                <Text style={styles.graphHint}>连线从前置任务指向后续任务</Text>
              </View>
              <View style={styles.graphToolbarActions}>
                <Pressable
                  disabled={undoStack.length === 0}
                  style={[styles.historyAction, undoStack.length === 0 && styles.disabled]}
                  onPress={undoGraph}
                >
                  <Text style={styles.historyActionText}>撤销</Text>
                </Pressable>
                <Pressable
                  disabled={redoStack.length === 0}
                  style={[styles.historyAction, redoStack.length === 0 && styles.disabled]}
                  onPress={redoGraph}
                >
                  <Text style={styles.historyActionText}>重做</Text>
                </Pressable>
                <Pressable style={styles.smallAction} onPress={addDraftNode}>
                  <Icon name="plus" size={13} color={color.accent} />
                  <Text style={styles.smallActionText}>任务</Text>
                </Pressable>
              </View>
            </View>

            <TaskTopology
              nodes={draftNodes.map((node) => ({
                ...node,
                incomplete: node.title.trim().length === 0 || node.spec.trim().length === 0,
                locked: lockedDraftIds.has(node.id),
              }))}
              selectedId={selectedDraftId}
              onSelect={setSelectedDraftId}
            />

            {selectedDraft && (
              <View style={styles.draftInspector}>
                <View style={styles.editorHeader}>
                  <View style={styles.inspectorTitleRow}>
                    <Text style={styles.editorTitle}>任务设置</Text>
                    {lockedDraftIds.has(selectedDraft.id) && (
                      <Text style={styles.lockedBadge}>只读</Text>
                    )}
                  </View>
                  <Pressable
                    disabled={lockedDraftIds.has(selectedDraft.id)
                      || (!graphIsEditing && draftNodes.length <= 1)}
                    onPress={() => removeDraftNode(selectedDraft.id)}
                    style={(lockedDraftIds.has(selectedDraft.id)
                      || (!graphIsEditing && draftNodes.length <= 1)) && styles.disabled}
                    accessibilityLabel="删除任务"
                  >
                    <Icon name="trash" size={16} color={color.danger} />
                  </Pressable>
                </View>
                <TextInput
                  value={selectedDraft.title}
                  onChangeText={(value) => updateDraft(selectedDraft.id, { title: value })}
                  style={styles.input}
                  placeholder="任务标题"
                  placeholderTextColor={color.textFaint}
                  selectionColor={color.accent}
                  editable={!lockedDraftIds.has(selectedDraft.id)}
                />
                <TextInput
                  value={selectedDraft.spec}
                  onChangeText={(value) => updateDraft(selectedDraft.id, { spec: value })}
                  style={styles.multilineInput}
                  placeholder="交付说明与验收条件"
                  placeholderTextColor={color.textFaint}
                  selectionColor={color.accent}
                  multiline
                  editable={!lockedDraftIds.has(selectedDraft.id)}
                />
                {draftNodes.length > 1 && (
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>前置依赖（可多选）</Text>
                    <View style={styles.wrapRow}>
                      {draftNodes.filter((node) => node.id !== selectedDraft.id).map((candidate) => {
                        const selected = selectedDraft.deps.includes(candidate.id);
                        const wouldCycle = !selected && transitivelyDepends(
                          draftNodes,
                          candidate.id,
                          selectedDraft.id,
                        );
                        return (
                          <Pressable
                            key={candidate.id}
                            disabled={lockedDraftIds.has(selectedDraft.id) || wouldCycle}
                            style={[
                              styles.choice,
                              selected && styles.choiceActive,
                              (lockedDraftIds.has(selectedDraft.id) || wouldCycle) && styles.disabled,
                            ]}
                            onPress={() => updateDraft(selectedDraft.id, {
                              deps: selected
                                ? selectedDraft.deps.filter((id) => id !== candidate.id)
                                : [...selectedDraft.deps, candidate.id],
                            })}
                          >
                            <Text style={[styles.choiceText, selected && styles.choiceTextActive]}>
                              {candidate.title.trim() || "未命名任务"}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                )}
              </View>
            )}

            <Text style={[styles.graphValidation, graphIssue === null && styles.graphValidationReady]}>
              {graphIssue ?? (graphIsEditing
                ? `将原子更新 ${editableDraftNodes.length} 个待派发任务，删除 ${deletedPersistedIds.length} 个`
                : `将一次性创建 ${draftNodes.length} 个任务`)}
            </Text>
            <PrimaryButton
              label={graphIsEditing ? "保存任务图" : "发布任务图"}
              disabled={graphIssue !== null || !canCreateGraph}
              onPress={publishGraph}
            />
          </EditorCard>
        )}

        {editor?.kind === "run" && (
          <EditorCard title="新建手工 Run" onCancel={() => setEditor(null)}>
            <TextInput
              value={objective}
              onChangeText={setObjective}
              style={styles.multilineInput}
              placeholder="写下最终目标，例如：完成协议兼容并发布 iOS"
              placeholderTextColor={color.textFaint}
              selectionColor={color.accent}
              multiline
              autoFocus
            />
            <PrimaryButton
              label="创建 Run"
              disabled={objective.trim().length === 0 || !canMutate}
              onPress={createRun}
            />
          </EditorCard>
        )}

        {runGroups.active.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.runStrip}
          >
            {runGroups.active.map((run) => (
              <Pressable
                key={run.id}
                onPress={() => {
                  setSelectedRunId(run.id);
                  setSelectedTopologyTaskId(null);
                  setEditor(null);
                }}
                style={[styles.runChip, activeRunId === run.id && styles.runChipActive]}
              >
                <Text
                  style={[styles.runChipTitle, activeRunId === run.id && styles.runChipTitleActive]}
                  numberOfLines={1}
                >
                  {run.objective}
                </Text>
                <Text style={styles.runChipMeta}>{runLabel(run)} · {run.status}</Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {runGroups.history.length > 0 && (
          <View style={styles.runHistory}>
            <Pressable
              style={({ pressed }) => [
                styles.runHistoryToggle,
                pressed && styles.runHistoryTogglePressed,
              ]}
              onPress={() => {
                const next = !historyOpen;
                setHistoryOpen(next);
                if (!next && selectedRun?.status !== "active") {
                  setSelectedRunId(runGroups.active[0]?.id ?? null);
                  setSelectedTopologyTaskId(null);
                  setEditor(null);
                }
              }}
              accessibilityRole="button"
              accessibilityState={{ expanded: historyOpen }}
              accessibilityLabel={`${historyOpen ? "折叠" : "展开"}已结束的 Goal 编排`}
            >
              <Icon
                name={historyOpen ? "chevron.down" : "chevron.right"}
                size={13}
                color={color.textDim}
              />
              <Text style={styles.runHistoryTitle}>已结束的 Goal 编排</Text>
              <Text style={styles.runHistoryCount}>{String(runGroups.history.length)}</Text>
            </Pressable>
            {historyOpen && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.runHistoryStrip}
              >
                {runGroups.history.map((run) => (
                  <Pressable
                    key={run.id}
                    onPress={() => {
                      setSelectedRunId(run.id);
                      setSelectedTopologyTaskId(null);
                      setEditor(null);
                    }}
                    style={[styles.runChip, activeRunId === run.id && styles.runChipActive]}
                  >
                    <Text
                      style={[
                        styles.runChipTitle,
                        activeRunId === run.id && styles.runChipTitleActive,
                      ]}
                      numberOfLines={1}
                    >
                      {run.objective}
                    </Text>
                    <Text style={styles.runChipMeta}>
                      {runLabel(run)} · {runStatusLabel[run.status]}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        )}

        {runs.length === 0 && editor?.kind !== "run" && conn?.supportsOrchestrationSnapshot && (
          <View style={styles.empty}>
            <Icon name="square.stack.3d.up" size={30} color={color.textFaint} />
            <Text style={styles.emptyTitle}>还没有编排 Run</Text>
            <Text style={styles.emptyDetail}>在画布上添加任务和依赖，再一次性发布整张图。</Text>
            {canMutate && (
              <PrimaryButton
                label={canCreateGraph ? "可视化新建" : "新建手工 Run"}
                onPress={openRunEditor}
              />
            )}
          </View>
        )}

        {selectedRun && (
          <View style={styles.runSection}>
            <View style={styles.runHeader}>
              <View style={styles.runHeaderCopy}>
                <View style={styles.badgeRow}>
                  <Text style={styles.badge}>{runLabel(selectedRun)}</Text>
                  <Text style={[styles.badge, styles.statusBadge]}>
                    {runStatusLabel[selectedRun.status]}
                  </Text>
                  <Text style={styles.revisionBadge}>r{selectedRun.graphRevision ?? 0}</Text>
                  {pendingGates.length > 0 && (
                    <Text style={[styles.badge, styles.gateBadge]}>{pendingGates.length} 个 Gate</Text>
                  )}
                </View>
                <Text style={styles.runObjective}>{selectedRun.objective}</Text>
              </View>
              {((manualRun && canMutate && selectedRun.status === "active") ||
                canManage ||
                (canManageRunLifecycle && selectedRun.status === "active")) && (
                <View style={styles.runHeaderActions}>
                  {manualRun && canMutate && canAutomate && selectedRun.status === "active" && (
                    <Pressable
                      style={[styles.smallAction, automationRunning && styles.pauseAction]}
                      onPress={automationRunning ? pauseAutomation : openAutomationEditor}
                    >
                      <Text style={automationRunning ? styles.pauseActionText : styles.smallActionText}>
                        {automationRunning
                          ? "暂停自动"
                          : selectedRun.automation?.state === "paused" ? "继续自动" : "自动运行"}
                      </Text>
                    </Pressable>
                  )}
                  {manualRun && canMutate && !automationRunning &&
                    selectedRun.status === "active" && (
                    <>
                      {canCreateGraph && (
                        <Pressable style={styles.smallAction} onPress={openExistingGraphEditor}>
                          <Text style={styles.smallActionText}>编辑图</Text>
                        </Pressable>
                      )}
                      <Pressable style={styles.smallAction} onPress={openTaskEditor}>
                        <Icon name="plus" size={13} color={color.accent} />
                        <Text style={styles.smallActionText}>任务</Text>
                      </Pressable>
                    </>
                  )}
                  {canManageRunLifecycle && selectedRun.status === "active" && (
                    <View style={styles.runLifecycleActions}>
                      <Pressable
                        style={[styles.smallAction, styles.completeRunAction]}
                        onPress={confirmCompleteRun}
                        accessibilityLabel="标记 Goal 已完成"
                      >
                        <Icon name="checkmark.circle.fill" size={12} color={color.success} />
                        <Text style={styles.completeRunActionText}>完成</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.smallAction, styles.abandonRunAction]}
                        onPress={confirmAbandonRun}
                        accessibilityLabel="放弃 Goal"
                      >
                        <Text style={styles.abandonRunActionText}>放弃</Text>
                      </Pressable>
                    </View>
                  )}
                  {canManage && (
                    <Pressable
                      style={styles.deleteRunAction}
                      onPress={confirmDeleteRun}
                      accessibilityLabel="删除编排"
                    >
                      <Icon name="trash" size={14} color={color.danger} />
                    </Pressable>
                  )}
                </View>
              )}
            </View>

            {selectedRun.automation && (
              <View style={styles.automationStatus}>
                <View style={styles.automationStatusHeader}>
                  <Text style={styles.automationStatusTitle}>
                    自动执行 · {selectedRun.automation.state}
                  </Text>
                  <Text style={styles.automationStatusMeta}>{selectedRun.automation.agent}</Text>
                </View>
                <Text style={styles.graphHint} numberOfLines={2}>
                  {selectedRun.automation.workspace === "run" ? "共享 Run worktree" : "当前目录"}
                  {` · ${selectedRun.automation.workspacePath}`}
                </Text>
                {selectedRun.automation.lastError && (
                  <Text style={styles.automationError}>{selectedRun.automation.lastError}</Text>
                )}
              </View>
            )}

            {(worktreeAssets.length > 0 || canManageWorktrees) && (
              <WorktreeAssets
                assets={worktreeAssets}
                tasks={tasks}
                canManage={canManageWorktrees}
                onInspect={inspectWorktree}
                onShowSummary={showWorktreeSummary}
                onOpenPath={openWorktreePath}
                onClean={confirmCleanupWorktree}
              />
            )}

            {!manualRun && (
              <Text style={styles.coordinatorNote}>
                此 Run 由协调者会话维护任务图；你仍可查看 worker，并在主机页处理 Gate。
              </Text>
            )}

            {tasks.length > 0 && (
              <View style={styles.viewSwitch}>
                <Pressable
                  onPress={() => setTaskView("graph")}
                  style={[styles.viewSwitchButton, taskView === "graph" && styles.viewSwitchButtonActive]}
                >
                  <Text style={[styles.viewSwitchText, taskView === "graph" && styles.viewSwitchTextActive]}>
                    拓扑
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setTaskView("list")}
                  style={[styles.viewSwitchButton, taskView === "list" && styles.viewSwitchButtonActive]}
                >
                  <Text style={[styles.viewSwitchText, taskView === "list" && styles.viewSwitchTextActive]}>
                    列表
                  </Text>
                </Pressable>
              </View>
            )}

            {taskView === "graph" && tasks.length > 0 && (
              <>
                <TaskTopology
                  nodes={tasks}
                  selectedId={activeTopologyTaskId}
                  onSelect={setSelectedTopologyTaskId}
                />
                <Text style={styles.graphHint}>点选节点查看说明、派发或打开 worker。</Text>
              </>
            )}

            {editor?.kind === "task" && (
              <EditorCard title="添加任务" onCancel={() => setEditor(null)}>
                <TextInput
                  value={taskTitle}
                  onChangeText={setTaskTitle}
                  style={styles.input}
                  placeholder="任务标题"
                  placeholderTextColor={color.textFaint}
                  selectionColor={color.accent}
                  autoFocus
                />
                <TextInput
                  value={taskSpec}
                  onChangeText={setTaskSpec}
                  style={styles.multilineInput}
                  placeholder="交付要求与验收条件"
                  placeholderTextColor={color.textFaint}
                  selectionColor={color.accent}
                  multiline
                />
                {tasks.length > 0 && (
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>前置依赖（可多选）</Text>
                    <View style={styles.wrapRow}>
                      {tasks.map((task) => {
                        const selected = taskDeps.includes(task.id);
                        return (
                          <Pressable
                            key={task.id}
                            style={[styles.choice, selected && styles.choiceActive]}
                            onPress={() => setTaskDeps((current) =>
                              selected
                                ? current.filter((id) => id !== task.id)
                                : [...current, task.id],
                            )}
                          >
                            <Text style={[styles.choiceText, selected && styles.choiceTextActive]}>
                              {task.title}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                )}
                <PrimaryButton
                  label="添加到任务图"
                  disabled={taskTitle.trim().length === 0 || taskSpec.trim().length === 0}
                  onPress={createTask}
                />
              </EditorCard>
            )}

            {editor?.kind === "automation" && (
              <EditorCard
                title={selectedRun.automation?.state === "paused" ? "继续自动执行" : "一键运行任务图"}
                onCancel={() => setEditor(null)}
              >
                <Text style={styles.coordinatorNote}>
                  daemon 会按依赖逐个派发；只有 worker 显式交付后才启动下游任务。
                  整张 Run 共用一个工作区，确保下游能看到上游改动。
                </Text>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>默认 Agent</Text>
                  <View style={styles.wrapRow}>
                    {WORKER_AGENTS.map((agent) => (
                      <Pressable
                        key={agent}
                        style={[styles.choice, automationAgent === agent && styles.choiceActive]}
                        onPress={() => {
                          setAutomationAgent(agent);
                          setAutomationAccountId(defaultAccountId(agent));
                        }}
                      >
                        <AgentIcon agent={agent} size={14} />
                        <Text style={[
                          styles.choiceText,
                          automationAgent === agent && styles.choiceTextActive,
                        ]}>
                          {agent}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
                {accountsFor(automationAgent).length > 0 && (
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>账号环境</Text>
                    <View style={styles.wrapRow}>
                      {accountsFor(automationAgent).map((account) => (
                        <Choice
                          key={account.id}
                          active={automationAccountId === account.id}
                          label={account.name}
                          onPress={() => setAutomationAccountId(account.id)}
                        />
                      ))}
                    </View>
                    <Text style={styles.graphHint}>账号环境独立；整张图仍在下方选择的同一个项目工作区中运行。</Text>
                  </View>
                )}
                <View style={styles.cwdRow}>
                  <TextInput
                    value={automationCwd}
                    onChangeText={(value) => {
                      setAutomationCwd(value);
                      setWorkspacePath("");
                    }}
                    style={[styles.input, styles.cwdInput]}
                    placeholder="电脑上的项目完整路径"
                    placeholderTextColor={color.textFaint}
                    selectionColor={color.accent}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Pressable style={styles.browseButton} onPress={() => setPickerOpen(true)}>
                    <Text style={styles.browseText}>浏览</Text>
                  </Pressable>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>整张图的工作区</Text>
                  <View style={styles.wrapRow}>
                    <Choice
                      active={automationWorkspace === "run"}
                      label="Run worktree（推荐）"
                      onPress={() => setAutomationWorkspace("run")}
                    />
                    <Choice
                      active={automationWorkspace === "current"}
                      label="当前目录"
                      onPress={() => setAutomationWorkspace("current")}
                    />
                  </View>
                  <Text style={styles.graphHint}>
                    Run worktree 隔离整张编排，但所有节点共享它；当前目录会直接修改原工作区。
                  </Text>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>审批策略</Text>
                  <View style={styles.wrapRow}>
                    {POLICIES.map((candidate) => (
                      <Choice
                        key={candidate}
                        active={automationPolicy === candidate}
                        label={candidate}
                        onPress={() => setAutomationPolicy(candidate)}
                      />
                    ))}
                  </View>
                </View>
                <PrimaryButton
                  label={selectedRun.automation?.state === "paused" ? "继续执行" : "开始自动执行"}
                  disabled={automationCwd.trim().length === 0}
                  onPress={startAutomation}
                />
              </EditorCard>
            )}

            {editor?.kind === "worker" && (
              <EditorCard
                title={`派发：${tasks.find((task) => task.id === editor.taskId)?.title ?? "任务"}`}
                onCancel={() => setEditor(null)}
              >
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>Agent</Text>
                  <View style={styles.wrapRow}>
                    {WORKER_AGENTS.map((agent) => (
                      <Pressable
                        key={agent}
                        style={[styles.choice, workerAgent === agent && styles.choiceActive]}
                        onPress={() => {
                          setWorkerAgent(agent);
                          setWorkerAccountId(defaultAccountId(agent));
                        }}
                      >
                        <AgentIcon agent={agent} size={14} />
                        <Text style={[styles.choiceText, workerAgent === agent && styles.choiceTextActive]}>
                          {agent}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
                {accountsFor(workerAgent).length > 0 && (
                  <View style={styles.fieldGroup}>
                    <Text style={styles.fieldLabel}>账号环境</Text>
                    <View style={styles.wrapRow}>
                      {accountsFor(workerAgent).map((account) => (
                        <Choice
                          key={account.id}
                          active={workerAccountId === account.id}
                          label={account.name}
                          onPress={() => setWorkerAccountId(account.id)}
                        />
                      ))}
                    </View>
                  </View>
                )}
                <View style={styles.cwdRow}>
                  <TextInput
                    value={workerCwd}
                    onChangeText={(value) => {
                      setWorkerCwd(value);
                      setWorkspacePath("");
                    }}
                    style={[styles.input, styles.cwdInput]}
                    placeholder="电脑上的项目完整路径"
                    placeholderTextColor={color.textFaint}
                    selectionColor={color.accent}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Pressable style={styles.browseButton} onPress={() => setPickerOpen(true)}>
                    <Text style={styles.browseText}>浏览</Text>
                  </Pressable>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>工作目录</Text>
                  <View style={styles.wrapRow}>
                    <Choice
                      active={worktree === "new"}
                      label="新 worktree（隔离）"
                      onPress={() => setWorktree("new")}
                    />
                    <Choice
                      active={worktree === "none"}
                      label="当前目录"
                      onPress={() => setWorktree("none")}
                    />
                  </View>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.fieldLabel}>审批策略</Text>
                  <View style={styles.wrapRow}>
                    {POLICIES.map((candidate) => (
                      <Choice
                        key={candidate}
                        active={policy === candidate}
                        label={candidate}
                        onPress={() => setPolicy(candidate)}
                      />
                    ))}
                  </View>
                </View>
                <PrimaryButton
                  label="启动 worker"
                  disabled={workerCwd.trim().length === 0}
                  onPress={startWorker}
                />
              </EditorCard>
            )}

            <View style={styles.taskList}>
              {(taskView === "list"
                ? tasks
                : tasks.filter((task) => task.id === activeTopologyTaskId)
              ).map((task) => {
                const ready = isTaskReady(task, tasks);
                const dependencyNames = task.deps
                  .map((id) => tasks.find((candidate) => candidate.id === id)?.title ?? id)
                  .join("、");
                const dispatch = [...dispatches]
                  .filter((candidate) => candidate.taskId === task.id)
                  .sort((a, b) => b.startedAt - a.startedAt)[0];
                const workerActive = dispatch?.state === "starting" || dispatch?.state === "running";
                return (
                  <View key={task.id} style={styles.taskCard}>
                    <View style={styles.taskTop}>
                      <View
                        style={[
                          styles.statusDot,
                          { backgroundColor: statusColor[task.status] ?? color.textFaint },
                        ]}
                      />
                      <View style={styles.taskCopy}>
                        <Text style={styles.taskTitle}>{task.title}</Text>
                        <Text style={styles.taskMeta}>
                          {ready ? "Ready" : taskStatusLabel[task.status]}
                          {dependencyNames ? ` · 依赖：${dependencyNames}` : ""}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.taskSpec}>{task.spec}</Text>
                    {task.result && <Text style={styles.taskResult}>{task.result}</Text>}
                    <View style={styles.taskActions}>
                      {selectedRun.status === "active" && canManageLifecycle && workerActive && (
                        <Pressable
                          style={[styles.taskButton, styles.taskButtonDanger]}
                          onPress={() => confirmStopWorker(task)}
                        >
                          <Icon name="stop.circle" size={11} color={color.danger} />
                          <Text style={styles.taskButtonDangerText}>停止</Text>
                        </Pressable>
                      )}
                      {selectedRun.status === "active" && canManageLifecycle && !workerActive &&
                        (task.status === "pending" || task.status === "blocked") && (
                        <Pressable
                          style={[styles.taskButton, styles.taskButtonDanger]}
                          onPress={() => confirmCancelTask(task)}
                        >
                          <Text style={styles.taskButtonDangerText}>取消任务</Text>
                        </Pressable>
                      )}
                      {selectedRun.status === "active" && canManageLifecycle &&
                        task.status === "failed" && (
                        <Pressable style={styles.taskButton} onPress={() => retryTask(task)}>
                          <Icon name="arrow.clockwise" size={11} color={color.accent} />
                          <Text style={styles.taskButtonText}>重试</Text>
                        </Pressable>
                      )}
                      {selectedRun.status === "active" && manualRun && !automationRunning &&
                        ready && canMutate && (
                        <Pressable style={styles.taskButton} onPress={() => openWorkerEditor(task.id)}>
                          <Icon name="play.fill" size={11} color={color.accent} />
                          <Text style={styles.taskButtonText}>派发</Text>
                        </Pressable>
                      )}
                      {dispatch && (
                        <Pressable style={styles.taskButton} onPress={() => openWorkerSession(task.id)}>
                          <Icon name="bubble.left.and.text.bubble.right" size={12} color={color.textDim} />
                          <Text style={styles.taskButtonMuted}>打开 worker</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                );
              })}
              {tasks.length === 0 && (
                <Text style={styles.noTasks}>
                  {manualRun ? "还没有任务。先添加任务，再选择 Agent 派发。" : "协调者还没有创建任务。"}
                </Text>
              )}
            </View>
          </View>
        )}
        </ScrollView>
      </View>

      {conn && (
        <WorkspacePicker
          visible={pickerOpen}
          conn={conn}
          initialPath={workspacePath}
          onClose={() => setPickerOpen(false)}
          onSelect={(selection) => {
            setWorkspacePath(selection.path);
            if (editor?.kind === "automation") {
              setAutomationCwd(selection.cwd);
            } else {
              setWorkerCwd(selection.cwd);
            }
            setPickerOpen(false);
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

function WorktreeAssets({
  assets,
  tasks,
  canManage,
  onInspect,
  onShowSummary,
  onOpenPath,
  onClean,
}: {
  assets: OrchestrationWorktreeAsset[];
  tasks: OrchestrationTask[];
  canManage: boolean;
  onInspect: (asset: OrchestrationWorktreeAsset) => void;
  onShowSummary: (asset: OrchestrationWorktreeAsset) => void;
  onOpenPath: (asset: OrchestrationWorktreeAsset) => void;
  onClean: (asset: OrchestrationWorktreeAsset) => void;
}) {
  return (
    <View style={styles.worktreeSection}>
      <View style={styles.worktreeHeader}>
        <View>
          <Text style={styles.worktreeTitle}>工作树</Text>
          <Text style={styles.worktreeSubtitle}>检查结果由主机 Git 只读核验</Text>
        </View>
        <Text style={styles.worktreeCount}>{String(assets.length)}</Text>
      </View>
      {assets.length === 0 ? (
        <Text style={styles.worktreeEmpty}>这个 Run 尚未登记独立工作树。</Text>
      ) : assets.map((asset) => {
        const task = asset.taskId ? tasks.find((candidate) => candidate.id === asset.taskId) : undefined;
        const owner = asset.kind === "run"
          ? "共享 Run 工作树"
          : task?.title ?? `worker · ${asset.taskId ?? "已删除任务"}`;
        const presentation = worktreeAssetPresentation(asset);
        const statusStyle = presentation.tone === "success"
          ? styles.worktreeStateSuccess
          : presentation.tone === "warning"
            ? styles.worktreeStateWarning
            : presentation.tone === "danger"
              ? styles.worktreeStateDanger
              : styles.worktreeStateMuted;
        return (
          <View key={asset.id} style={styles.worktreeCard}>
            <View style={styles.worktreeTop}>
              <Text style={styles.worktreeOwner} numberOfLines={1}>{owner}</Text>
              <Text style={[styles.worktreeState, statusStyle]}>{presentation.label}</Text>
            </View>
            <Text style={styles.worktreeBranch} numberOfLines={1}>
              {asset.branch ? `分支 · ${asset.branch}` : "分支 · detached"}
            </Text>
            <Text style={styles.worktreePath} selectable numberOfLines={2}>{asset.path}</Text>
            <Text style={styles.worktreeDetail}>{presentation.detail}</Text>
            <View style={styles.worktreeActions}>
              <Pressable style={styles.worktreeAction} onPress={() => onOpenPath(asset)}>
                <Text style={styles.worktreeActionText}>打开路径</Text>
              </Pressable>
              <Pressable style={styles.worktreeAction} onPress={() => onShowSummary(asset)}>
                <Text style={styles.worktreeActionText}>查看摘要</Text>
              </Pressable>
              <Pressable
                disabled={!canManage}
                style={[styles.worktreeAction, !canManage && styles.disabled]}
                onPress={() => onInspect(asset)}
              >
                <Text style={styles.worktreeActionText}>检查</Text>
              </Pressable>
              {canManage && worktreeCanClean(asset) && (
                <Pressable
                  style={[styles.worktreeAction, styles.worktreeCleanAction]}
                  onPress={() => onClean(asset)}
                >
                  <Text style={styles.worktreeCleanActionText}>清理</Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function TaskTopology({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: TopologyNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const layout = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const memo = new Map<string, number>();
    const level = (id: string, stack = new Set<string>()): number => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      if (stack.has(id)) return 0;
      const node = byId.get(id);
      if (!node) return 0;
      const next = new Set(stack);
      next.add(id);
      const value = node.deps.length === 0
        ? 0
        : Math.max(...node.deps.map((dep) => level(dep, next))) + 1;
      memo.set(id, value);
      return value;
    };

    const rows = new Map<number, number>();
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      const column = level(node.id);
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      positions.set(node.id, {
        x: GRAPH_PADDING + GRAPH_NODE_WIDTH / 2 + column * (GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP),
        y: GRAPH_PADDING + GRAPH_NODE_HEIGHT / 2 + row * (GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP),
      });
    }
    const columns = Math.max(1, ...Array.from(memo.values(), (value) => value + 1));
    const rowCount = Math.max(1, ...rows.values());
    return {
      positions,
      width: GRAPH_PADDING * 2 + columns * GRAPH_NODE_WIDTH + (columns - 1) * GRAPH_COLUMN_GAP,
      height: GRAPH_PADDING * 2 + rowCount * GRAPH_NODE_HEIGHT + (rowCount - 1) * GRAPH_ROW_GAP,
    };
  }, [nodes]);

  return (
    <View style={styles.topologyFrame}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.topologyScroll}
      >
        <View style={{ width: layout.width, height: layout.height }}>
          <Svg
            pointerEvents="none"
            width={layout.width}
            height={layout.height}
            style={StyleSheet.absoluteFill}
          >
            {nodes.flatMap((node) => {
              const end = layout.positions.get(node.id);
              if (!end) return [];
              return node.deps.flatMap((dependency) => {
                const start = layout.positions.get(dependency);
                if (!start) return [];
                const fromX = start.x + GRAPH_NODE_WIDTH / 2;
                const toX = end.x - GRAPH_NODE_WIDTH / 2;
                const bend = (fromX + toX) / 2;
                const key = `${dependency}-${node.id}`;
                return [
                  <Path
                    key={`${key}-line`}
                    d={`M ${fromX} ${start.y} C ${bend} ${start.y}, ${bend} ${end.y}, ${toX} ${end.y}`}
                    fill="none"
                    stroke={color.textFaint}
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  />,
                  <Path
                    key={`${key}-arrow`}
                    d={`M ${toX} ${end.y} L ${toX - 7} ${end.y - 4} L ${toX - 7} ${end.y + 4} Z`}
                    fill={color.textFaint}
                  />,
                ];
              });
            })}
          </Svg>

          {nodes.map((node) => {
            const position = layout.positions.get(node.id);
            if (!position) return null;
            const nodeColor = node.locked
              ? color.textFaint
              : node.incomplete
                ? color.warn
                : node.status
                  ? (statusColor[node.status] ?? color.textFaint)
                  : color.accent;
            return (
              <Pressable
                key={node.id}
                onPress={() => onSelect(node.id)}
                accessibilityRole="button"
                accessibilityLabel={`任务 ${node.title || "未命名"}，${node.deps.length} 个依赖${node.locked ? "，只读" : ""}`}
                style={[
                  styles.topologyNode,
                  selectedId === node.id && styles.topologyNodeActive,
                  {
                    left: position.x - GRAPH_NODE_WIDTH / 2,
                    top: position.y - GRAPH_NODE_HEIGHT / 2,
                  },
                ]}
              >
                <View style={styles.topologyNodeTitleRow}>
                  <View style={[styles.topologyDot, { backgroundColor: nodeColor }]} />
                  <Text style={styles.topologyNodeTitle} numberOfLines={1}>
                    {node.title.trim() || "未命名任务"}
                  </Text>
                </View>
                <Text style={styles.topologyNodeMeta} numberOfLines={1}>
                  {node.locked
                    ? "只读"
                    : node.status
                      ? taskStatusLabel[node.status]
                      : node.incomplete ? "待完善" : "草稿"}
                  {` · ${node.deps.length} 个依赖`}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function EditorCard({
  title,
  onCancel,
  children,
}: {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.editor}>
      <View style={styles.editorHeader}>
        <Text style={styles.editorTitle}>{title}</Text>
        <Pressable onPress={onCancel} hitSlop={8}>
          <Text style={styles.cancel}>取消</Text>
        </Pressable>
      </View>
      {children}
    </View>
  );
}

function PrimaryButton({
  label,
  disabled = false,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        disabled && styles.disabled,
        pressed && styles.primaryPressed,
      ]}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

function Choice({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable style={[styles.choice, active && styles.choiceActive]} onPress={onPress}>
      <Text style={[styles.choiceText, active && styles.choiceTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  contentPane: { flex: 1, minWidth: 0, overflow: "hidden" },
  content: { padding: space.lg, paddingBottom: 48, gap: space.lg },
  banner: { backgroundColor: color.warnBg, paddingHorizontal: space.lg, paddingVertical: space.sm },
  bannerText: { color: color.warn, fontSize: 12, lineHeight: 17 },
  hero: {
    flexDirection: "row",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  heroIcon: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accentBg,
  },
  heroCopy: { flex: 1, gap: 5 },
  heroTitle: { ...font.body, fontWeight: "700" },
  heroDetail: { ...font.sub, lineHeight: 19 },
  notice: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.warnBg,
  },
  noticeQuiet: { backgroundColor: color.surfaceRaised },
  noticeDanger: { backgroundColor: color.dangerBg },
  noticeText: { color: color.warn, fontSize: 12, lineHeight: 18 },
  noticeQuietText: { color: color.textDim },
  noticeDangerText: { color: color.danger },
  noticeRetry: {
    alignSelf: "flex-start",
    minHeight: 36,
    justifyContent: "center",
    marginTop: space.sm,
    paddingHorizontal: space.md,
    borderRadius: 18,
    backgroundColor: color.surface,
  },
  noticeRetryText: { color: color.accent, fontSize: 13, fontWeight: "700" },
  runStrip: { gap: space.sm, paddingRight: space.lg },
  runChip: {
    width: 180,
    padding: space.md,
    gap: 4,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  runChipActive: { backgroundColor: color.accentBg },
  runChipTitle: { color: color.textDim, fontSize: 13, fontWeight: "600" },
  runChipTitleActive: { color: color.text },
  runChipMeta: { ...font.meta },
  runHistory: {
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
    overflow: "hidden",
  },
  runHistoryToggle: {
    minHeight: 46,
    paddingHorizontal: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  runHistoryTogglePressed: { backgroundColor: color.pressed },
  runHistoryTitle: { flex: 1, color: color.textDim, fontSize: 13, fontWeight: "600" },
  runHistoryCount: {
    minWidth: 24,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: color.surface,
    color: color.textDim,
    fontSize: 10,
    textAlign: "center",
  },
  runHistoryStrip: { gap: space.sm, paddingHorizontal: space.sm, paddingBottom: space.sm },
  empty: {
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: 36,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  emptyTitle: { ...font.body, fontWeight: "700" },
  emptyDetail: { ...font.sub, textAlign: "center", lineHeight: 19 },
  runSection: { gap: space.md },
  runHeader: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  runHeaderCopy: { flex: 1, gap: space.sm },
  runHeaderActions: { alignItems: "flex-end", gap: space.sm },
  runLifecycleActions: { flexDirection: "row", gap: space.sm },
  completeRunAction: { backgroundColor: color.successBg },
  completeRunActionText: { color: color.success, fontSize: 12, fontWeight: "700" },
  abandonRunAction: { backgroundColor: color.dangerBg },
  abandonRunActionText: { color: color.danger, fontSize: 12, fontWeight: "700" },
  deleteRunAction: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    backgroundColor: color.dangerBg,
  },
  pauseAction: { backgroundColor: color.warnBg },
  pauseActionText: { color: color.warn, fontSize: 12, fontWeight: "700" },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  badge: {
    color: color.accent,
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 9,
    backgroundColor: color.accentBg,
    overflow: "hidden",
  },
  statusBadge: { color: color.success, backgroundColor: color.successBg },
  gateBadge: { color: color.warn, backgroundColor: color.warnBg },
  revisionBadge: {
    color: color.textFaint,
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  runObjective: { color: color.text, fontSize: 20, lineHeight: 27, fontWeight: "700" },
  automationStatus: {
    gap: 5,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.accentBg,
  },
  automationStatusHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  automationStatusTitle: { color: color.accent, fontSize: 12, fontWeight: "700" },
  automationStatusMeta: { color: color.textDim, fontSize: 11, fontWeight: "600" },
  automationError: { color: color.warn, fontSize: 12, lineHeight: 17 },
  worktreeSection: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  worktreeHeader: { flexDirection: "row", alignItems: "center", gap: space.sm },
  worktreeTitle: { color: color.text, fontSize: 13, fontWeight: "700" },
  worktreeSubtitle: { color: color.textFaint, fontSize: 10, marginTop: 2 },
  worktreeCount: {
    minWidth: 22,
    marginLeft: "auto",
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 9,
    backgroundColor: color.surfaceRaised,
    color: color.textDim,
    fontSize: 10,
    fontWeight: "700",
    textAlign: "center",
  },
  worktreeEmpty: { ...font.meta, color: color.textDim, paddingVertical: space.xs },
  worktreeCard: {
    gap: 4,
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceRaised,
  },
  worktreeTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  worktreeOwner: { flex: 1, color: color.text, fontSize: 12, fontWeight: "700" },
  worktreeState: {
    overflow: "hidden",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    fontSize: 10,
    fontWeight: "700",
  },
  worktreeStateMuted: { color: color.textFaint, backgroundColor: color.surface },
  worktreeStateWarning: { color: color.warn, backgroundColor: color.warnBg },
  worktreeStateSuccess: { color: color.success, backgroundColor: color.successBg },
  worktreeStateDanger: { color: color.danger, backgroundColor: color.dangerBg },
  worktreeBranch: { color: color.textDim, fontSize: 10, fontWeight: "600" },
  worktreePath: { color: color.textFaint, fontSize: 10, lineHeight: 14 },
  worktreeDetail: { color: color.textDim, fontSize: 10, lineHeight: 14 },
  worktreeActions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  worktreeAction: {
    minHeight: 28,
    justifyContent: "center",
    paddingHorizontal: space.sm,
    borderRadius: 14,
    backgroundColor: color.surface,
  },
  worktreeActionText: { color: color.accent, fontSize: 11, fontWeight: "700" },
  worktreeCleanAction: { backgroundColor: color.dangerBg },
  worktreeCleanActionText: { color: color.danger, fontSize: 11, fontWeight: "700" },
  smallAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: space.md,
    minHeight: 34,
    borderRadius: 17,
    backgroundColor: color.accentBg,
  },
  smallActionText: { color: color.accent, fontSize: 12, fontWeight: "700" },
  coordinatorNote: { ...font.sub, lineHeight: 19 },
  viewSwitch: {
    alignSelf: "flex-start",
    flexDirection: "row",
    padding: 3,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  viewSwitchButton: {
    minWidth: 66,
    minHeight: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  viewSwitchButtonActive: { backgroundColor: color.surfaceRaised },
  viewSwitchText: { color: color.textFaint, fontSize: 12, fontWeight: "600" },
  viewSwitchTextActive: { color: color.text },
  editor: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  editorHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  editorTitle: { ...font.body, fontWeight: "700" },
  cancel: { color: color.accent, fontSize: 13 },
  graphEditorToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  graphEditorCopy: { flex: 1, gap: 3 },
  graphToolbarActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  historyAction: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  historyActionText: { color: color.textDim, fontSize: 11, fontWeight: "600" },
  graphHint: { ...font.meta, color: color.textDim, lineHeight: 16 },
  draftInspector: {
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
  },
  inspectorTitleRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  lockedBadge: {
    color: color.textFaint,
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 9,
    backgroundColor: color.surface,
    overflow: "hidden",
  },
  graphValidation: { color: color.warn, fontSize: 12, lineHeight: 17 },
  graphValidationReady: { color: color.success },
  input: {
    minHeight: 46,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    color: color.text,
    fontSize: 14,
    backgroundColor: color.surfaceRaised,
  },
  multilineInput: {
    minHeight: 92,
    padding: space.md,
    borderRadius: radius.md,
    color: color.text,
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: "top",
    backgroundColor: color.surfaceRaised,
  },
  readOnlyInput: { color: color.textDim, opacity: 0.75 },
  fieldGroup: { gap: space.sm },
  fieldLabel: { ...font.meta, color: color.textDim },
  wrapRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  choice: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: space.md,
    justifyContent: "center",
    borderRadius: 17,
    backgroundColor: color.surfaceRaised,
  },
  choiceActive: { backgroundColor: color.accentDim },
  choiceText: { color: color.textDim, fontSize: 12, fontWeight: "600" },
  choiceTextActive: { color: color.text },
  cwdRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  cwdInput: { flex: 1 },
  browseButton: {
    minHeight: 46,
    paddingHorizontal: space.md,
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: color.accentBg,
  },
  browseText: { color: color.accent, fontSize: 13, fontWeight: "600" },
  primaryButton: {
    minHeight: 46,
    paddingHorizontal: space.lg,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: color.accent,
  },
  primaryText: { color: "#08101F", fontSize: 14, fontWeight: "800" },
  primaryPressed: { opacity: 0.82 },
  disabled: { opacity: 0.35 },
  topologyFrame: {
    minHeight: GRAPH_NODE_HEIGHT + GRAPH_PADDING * 2,
    borderRadius: radius.md,
    overflow: "hidden",
    backgroundColor: color.surface,
  },
  topologyScroll: { minWidth: "100%" },
  topologyNode: {
    position: "absolute",
    width: GRAPH_NODE_WIDTH,
    height: GRAPH_NODE_HEIGHT,
    justifyContent: "center",
    gap: 7,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
  },
  topologyNodeActive: {
    borderWidth: 2,
    borderColor: color.accent,
    backgroundColor: color.accentBg,
  },
  topologyNodeTitleRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  topologyDot: { width: 7, height: 7, borderRadius: 4 },
  topologyNodeTitle: { flex: 1, color: color.text, fontSize: 12, fontWeight: "700" },
  topologyNodeMeta: { color: color.textFaint, fontSize: 10 },
  taskList: { gap: space.sm },
  taskCard: {
    gap: space.sm,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  taskTop: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  statusDot: { width: 8, height: 8, marginTop: 5, borderRadius: 4 },
  taskCopy: { flex: 1, gap: 3 },
  taskTitle: { ...font.body, fontWeight: "700" },
  taskMeta: { ...font.meta, color: color.textDim },
  taskSpec: { ...font.sub, lineHeight: 19 },
  taskResult: {
    color: color.success,
    fontSize: 12,
    lineHeight: 18,
    padding: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.successBg,
  },
  taskActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  taskButton: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: space.md,
    borderRadius: 16,
    backgroundColor: color.surfaceRaised,
  },
  taskButtonText: { color: color.accent, fontSize: 12, fontWeight: "700" },
  taskButtonDanger: { backgroundColor: color.dangerBg },
  taskButtonDangerText: { color: color.danger, fontSize: 12, fontWeight: "700" },
  taskButtonMuted: { color: color.textDim, fontSize: 12, fontWeight: "600" },
  noTasks: { ...font.sub, textAlign: "center", paddingVertical: 28 },
});
