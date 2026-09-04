import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import type {
  AgentAccount,
  AgentKind,
  AgentModel,
  AgentPreset,
  ApprovalPolicy,
  CodeAgentKind,
  OrchestrationSnapshot,
  ResumableConversation,
  SessionInfo,
  SessionKind,
  SubagentStatus,
} from "@prospero/protocol";
import { AgentIcon } from "@/components/AgentIcon";
import { HostSummary } from "@/components/HostSummary";
import { Icon } from "@/components/Icon";
import { Sheet, SheetAction } from "@/components/Sheet";
import { SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import {
  getSessionPreferences,
  setProjectCollapsed,
  setSessionArchived,
  setSessionHidden,
} from "@/lib/session-preferences";
import { groupSessionsByProject } from "@/lib/session-projects";
import {
  coordinatorRunsBySession,
  goalSessionGroups,
  goalSessionVisibility,
  goalRunOverview,
  orchestrationRoute,
  type GoalSessionGroup,
  type GoalWorkerSessionLink,
} from "@/lib/orchestration-overview";
import { sortSessions } from "@/lib/store";
import { useHostConnection } from "@/lib/use-host-connection";
import { useOrchestrationSnapshot } from "@/lib/use-orchestration-snapshot";
import type { DeliveryResult } from "@/lib/outbound-queue";
import * as theme from "@/lib/theme";
const { color, font, radius, space } = theme;

const AGENTS: AgentKind[] = [
  "claude", "codex", "deepseek", "opencode", "grok", "trae", "shell",
];
/** 有结构化适配器的 agent(会话会以对话形态呈现) */
const STRUCTURED: AgentKind[] = ["claude", "codex", "opencode", "deepseek"];
const RESUMABLE: AgentKind[] = ["claude", "codex", "deepseek"];
const PLAN_CAPABLE: AgentKind[] = ["claude", "codex"];
const APPROVAL_POLICIES: readonly {
  value: ApprovalPolicy;
  label: string;
  symbol: "checkmark.circle.fill" | "command" | "exclamationmark.triangle.fill";
}[] = [
  { value: "strict", label: "逐条", symbol: "checkmark.circle.fill" },
  { value: "standard", label: "半自动", symbol: "command" },
  { value: "yolo", label: "YOLO", symbol: "exclamationmark.triangle.fill" },
];
const approvalPolicyHelp: Record<ApprovalPolicy, string> = {
  strict: "每次工具操作都请求确认；新会话默认使用此策略。",
  standard: "只读操作自动放行；修改文件、执行命令和联网仍需确认。",
  yolo: "全部操作自动批准；Codex 同时启用完整访问，操作仍会记录。",
};

function sessionCreateFailureText(result: DeliveryResult): string {
  if (result.accepted) return "";
  if (result.reason === "queue_full") return "离线队列已满；创建设置已保留，请恢复连接后重试。";
  if (result.reason === "transport_error") return "连接刚刚中断；创建请求没有自动重发，请确认会话列表后重试。";
  return "主机未连接；创建设置已保留，请恢复连接后重试。";
}

const statusLabel: Record<SessionInfo["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting_approval: "待审批",
  waiting_input: "待回答",
  idle: "空闲就绪",
  completed: "运行完毕",
  done: "会话结束",
  died: "已退出",
};

const childStatusLabel: Record<SubagentStatus, string> = {
  starting: "启动中",
  running: "工作中",
  waiting_input: "待回答",
  idle: "可对话",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

/** 待审批用告警色而非中性色 —— 它是唯一在等你动手的状态 */
const statusColor: Record<SessionInfo["status"], string> = {
  ...theme.statusColor,
  waiting_approval: theme.color.danger,
  idle: theme.color.accent,
} as Record<SessionInfo["status"], string>;

function formatConversationDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${time}`;
}

function projectNameFor(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export default function HostScreen() {
  const { hostId, create, cmd, quickCreate, cwd: quickCreateCwd } = useLocalSearchParams<{
    hostId: string;
    create?: string;
    cmd?: string;
    quickCreate?: string;
    cwd?: string;
  }>();
  const { host, conn, runtime } = useHostConnection(hostId);
  const supportsDeepseekHarness =
    runtime.status === "connected" && conn?.supportsDeepseekHarness === true;
  const availableAgents = useMemo(
    () => AGENTS.filter((candidate) => candidate !== "deepseek" || supportsDeepseekHarness),
    [supportsDeepseekHarness],
  );
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [sessionKind, setSessionKind] = useState<SessionKind>("structured");
  const [launchMode, setLaunchMode] = useState<"default" | "plan">("default");
  const [launchIntent, setLaunchIntent] = useState<"conversation" | "goal">("conversation");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>("strict");
  const [createYoloConfirmOpen, setCreateYoloConfirmOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [cwd, setCwd] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | AgentKind>("all");
  const [composing, setComposing] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [resumeQuery, setResumeQuery] = useState("");
  const [resumeResults, setResumeResults] = useState<ResumableConversation[]>([]);
  const [selectedResume, setSelectedResume] = useState<ResumableConversation | null>(null);
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeLoaded, setResumeLoaded] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [agentAccounts, setAgentAccounts] = useState<AgentAccount[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<
    Partial<Record<CodeAgentKind, string>>
  >({});
  const [launchModels, setLaunchModels] = useState<AgentModel[]>([]);
  const [launchModelsLoading, setLaunchModelsLoading] = useState(false);
  const [launchModelsError, setLaunchModelsError] = useState<string | null>(null);
  const [selectedLaunchModel, setSelectedLaunchModel] = useState<string | null>(null);
  const [selectedLaunchEffort, setSelectedLaunchEffort] = useState<string | null>(null);
  const [launchPresets, setLaunchPresets] = useState<AgentPreset[]>([]);
  const [selectedLaunchPreset, setSelectedLaunchPreset] = useState<string | null>(null);
  const [launchModelsReload, setLaunchModelsReload] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => new Set());
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);
  const [resumeConflictTitle, setResumeConflictTitle] = useState<string | null>(null);
  const [createDelivery, setCreateDelivery] = useState<"sent" | "queued" | null>(null);
  const [manualCwdOpen, setManualCwdOpen] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [goalRunExpansionOverrides, setGoalRunExpansionOverrides] = useState<
    Record<string, boolean>
  >({});
  const pendingCreateRef = useRef(false);
  const pendingResumeTitleRef = useRef<string | null>(null);
  const deepLinkCreateRef = useRef<string | null>(null);
  const homeQuickCreateRef = useRef<string | null>(null);
  const resetPendingCreate = useCallback((): void => {
    pendingCreateRef.current = false;
    pendingResumeTitleRef.current = null;
    setCreateDelivery(null);
  }, []);
  const insets = useSafeAreaInsets();
  const { width, height, verticalPanes } = useAdaptiveLayout();
  const orchestration = useOrchestrationSnapshot(conn, runtime.status, 8_000);
  const coordinatorRuns = useMemo(
    () => coordinatorRunsBySession(orchestration?.runs ?? []),
    [orchestration],
  );
  const goalGroups = useMemo(() => goalSessionGroups(orchestration), [orchestration]);
  // 横屏手机、iPad、Android 平板用并列双栏；其余手机严格上下各占一半。
  const wideComposer =
    verticalPanes !== null || width >= 720 || (width >= 600 && width > height);
  const balancedPaneWidth = width / 2;
  const composerPaneWidths = verticalPanes ?? {
    start: balancedPaneWidth,
    end: width - balancedPaneWidth,
  };

  const canSearchResume =
    composing &&
    launchIntent === "conversation" &&
    sessionKind === "structured" &&
    RESUMABLE.includes(agent) &&
    runtime.status === "connected" &&
    conn !== null;
  const codeAgent = agent === "claude" || agent === "codex" ? agent : null;
  const launchCatalogAgent = codeAgent ?? (agent === "deepseek" ? "deepseek" : null);
  const matchingAccounts = codeAgent
    ? agentAccounts.filter((account) => account.agent === codeAgent)
    : [];
  const selectedAccount = codeAgent
    ? matchingAccounts.find((account) => account.id === selectedAccountIds[codeAgent]) ??
      matchingAccounts.find((account) => account.isDefault) ??
      matchingAccounts[0]
    : undefined;
  const selectedLaunchModelInfo = launchModels.find(
    (model) => model.id === selectedLaunchModel,
  );

  // 账号目录属于电脑端；每次回到主机页重读，确保账号管理页的新增/默认/删除立即生效。
  useFocusEffect(
    useCallback(() => {
      if (!conn || runtime.status !== "connected" || !conn.supportsAgentAccounts) {
        setAgentAccounts([]);
        return undefined;
      }
      let cancelled = false;
      void conn
        .agentAccounts()
        .then((next) => {
          if (cancelled) return;
          setAgentAccounts(next);
          setSelectedAccountIds((current) => {
            const updated = { ...current };
            for (const kind of ["claude", "codex"] as const) {
              const available = next.filter((account) => account.agent === kind);
              if (!available.some((account) => account.id === updated[kind])) {
                updated[kind] = available.find((account) => account.isDefault)?.id ?? available[0]?.id;
              }
            }
            return updated;
          });
        })
        .catch((failure: unknown) => {
          if (!cancelled) setBanner(`账号状态读取失败: ${failure instanceof Error ? failure.message : String(failure)}`);
        });
      return () => {
        cancelled = true;
      };
    }, [conn, runtime.status]),
  );

  // 模型目录来自 Agent 自己，不能在手机里硬编码。账号切换时重新读取，保证
  // 创建请求里的 model/effort 与即将启动的隔离环境属于同一份能力目录。
  useEffect(() => {
    if (
      !composing ||
      sessionKind !== "structured" ||
      launchCatalogAgent === null ||
      !conn?.supportsSessionCreateModel ||
      runtime.status !== "connected"
    ) {
      const reset = setTimeout(() => {
        setLaunchModels([]);
        setLaunchModelsLoading(false);
        setLaunchModelsError(null);
        setSelectedLaunchModel(null);
        setSelectedLaunchEffort(null);
        setLaunchPresets([]);
        setSelectedLaunchPreset(null);
      }, 0);
      return () => clearTimeout(reset);
    }
    let cancelled = false;
    // 切换 agent/账号后清空上一份模型目录，避免在读取新目录期间继续显示上一个
    // agent 的模型列表。重置与取数一起放进这个 timer：effect 体内同步 setState 会
    // 触发级联渲染(react-hooks/set-state-in-effect)，上面的早返回分支也是这么让开的。
    const timer = setTimeout(() => {
      setLaunchModels([]);
      setSelectedLaunchModel(null);
      setSelectedLaunchEffort(null);
      setLaunchPresets([]);
      setSelectedLaunchPreset(null);
      setLaunchModelsLoading(true);
      setLaunchModelsError(null);
      void conn
        .launchModels(launchCatalogAgent, selectedAccount?.id)
        .then((response) => {
          if (cancelled) return;
          setLaunchModels(response.models);
          const selected =
            response.models.find((model) => model.id === response.currentModel) ??
            response.models.find((model) => model.isDefault) ??
            response.models[0];
          setSelectedLaunchModel(selected?.id ?? null);
          setSelectedLaunchEffort(
            response.currentEffort ??
              selected?.defaultEffort ??
              selected?.supportedEfforts[0] ??
              null,
          );
          setLaunchPresets(response.presets ?? []);
          setSelectedLaunchPreset(
            response.currentPreset ??
              response.presets?.find((preset) => preset.isDefault)?.id ??
              response.presets?.[0]?.id ??
              null,
          );
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setLaunchModels([]);
          setSelectedLaunchModel(null);
          setSelectedLaunchEffort(null);
          setLaunchPresets([]);
          setSelectedLaunchPreset(null);
          setLaunchModelsError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!cancelled) setLaunchModelsLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    launchCatalogAgent,
    composing,
    conn,
    launchModelsReload,
    runtime.status,
    selectedAccount?.id,
    sessionKind,
  ]);

  // 空查询列最近会话；输入后做短 debounce，旧请求通过 effect cleanup 丢弃。
  useEffect(() => {
    if (!canSearchResume || !conn) {
      const reset = setTimeout(() => {
        setResumeLoading(false);
        setResumeError(null);
        setResumeResults([]);
        setResumeLoaded(false);
      }, 0);
      return () => clearTimeout(reset);
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setResumeLoading(true);
      setResumeError(null);
      void conn
        .localConversations(agent as ResumableConversation["agent"], resumeQuery, 20, selectedAccount?.id)
        .then((conversations) => {
          if (!cancelled) setResumeResults(conversations);
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setResumeResults([]);
            setResumeError(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          if (!cancelled) {
            setResumeLoading(false);
            setResumeLoaded(true);
          }
        });
    }, 280);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [agent, canSearchResume, conn, resumeQuery, selectedAccount?.id]);

  // 归档与项目展开状态属于这台手机的浏览偏好。每次从会话页回来都重读，
  // 这样在会话菜单里点“归档”后，主机页无需重建也能立刻同步。
  useFocusEffect(
    useCallback(() => {
      if (!hostId) return undefined;
      let cancelled = false;
      void getSessionPreferences(hostId)
        .then((preferences) => {
          if (cancelled) return;
          setArchivedIds(new Set(preferences.archivedSessionIds));
          setHiddenIds(new Set(preferences.hiddenSessionIds));
          setCollapsedProjects(new Set(preferences.collapsedProjects));
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setBanner(`会话偏好读取失败: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      return () => {
        cancelled = true;
      };
    }, [hostId]),
  );

  // 深链 prospero://host/<id>?create=shell&cmd=…:连上后自动建会话(自动化测试/快捷指令用)
  useEffect(() => {
    if (!conn || !create) return;
    const fireKey = `${create}:${typeof cmd === "string" ? cmd : ""}`;
    if (deepLinkCreateRef.current === fireKey) return;
    if (pendingCreateRef.current) return;
    if (runtime.status !== "connected") return;
    if (!availableAgents.includes(create as AgentKind) && create !== "custom") return;
    const timer = setTimeout(() => {
      deepLinkCreateRef.current = fireKey;
      pendingCreateRef.current = true;
      const result = conn.createSession(
        create as AgentKind,
        undefined,
        typeof cmd === "string" && cmd.length > 0 ? cmd : undefined,
      );
      if (!result.accepted) {
        resetPendingCreate();
        deepLinkCreateRef.current = null;
        setBanner(sessionCreateFailureText(result));
        return;
      }
      setCreateDelivery(result.disposition);
    }, 0);
    return () => clearTimeout(timer);
  }, [availableAgents, conn, create, cmd, resetPendingCreate, runtime.status]);

  // 首页快速入口复用完整创建器：指定目录时直接进入 Agent 设置，未指定目录或
  // 选择“新建目录”时先打开 WorkspacePicker（其中包含 mkdir）。
  useEffect(() => {
    if (!conn || runtime.status !== "connected") return;
    if (quickCreate !== "conversation" && quickCreate !== "directory") return;
    const requestedCwd = typeof quickCreateCwd === "string" ? quickCreateCwd.trim() : "";
    const fireKey = `${quickCreate}:${requestedCwd}`;
    if (homeQuickCreateRef.current === fireKey) return;
    homeQuickCreateRef.current = fireKey;
    const timer = setTimeout(() => {
      setLaunchIntent("conversation");
      setGoal("");
      setSelectedResume(null);
      setApprovalPolicy("strict");
      setCreateYoloConfirmOpen(false);
      setWorkspacePath("");
      setManualCwdOpen(false);
      if (requestedCwd) setCwd(requestedCwd);
      setComposing(true);
      if (quickCreate === "directory" || !requestedCwd) setPickerOpen(true);
    }, 0);
    return () => clearTimeout(timer);
  }, [conn, quickCreate, quickCreateCwd, runtime.status]);

  // 新建会话:创建后 daemon 自动 attach 并发快照(PTY 发 term.snapshot,
  // 结构化发 chat.snapshot)→ 以快照的 sid 进入会话页
  useEffect(() => {
    if (!conn) return;
    const enter = (sid: string): void => {
      if (!pendingCreateRef.current || !hostId) return;
      resetPendingCreate();
      setComposing(false);
      setSelectedResume(null);
      setLaunchIntent("conversation");
      setGoal("");
      setApprovalPolicy("strict");
      setCreateYoloConfirmOpen(false);
      router.push(`/host/${hostId}/session/${sid}`);
    };
    const offSnap = conn.events.on("snapshot", (m) => enter(m.sid));
    const offChat = conn.events.on("chatSnapshot", (m) => enter(m.sid));
    const offErr = conn.events.on("serverError", (m) => {
      const resumeTitle = pendingResumeTitleRef.current;
      resetPendingCreate();
      if (m.reason === "conversation_active_writer" && resumeTitle) {
        setResumeConflictTitle(resumeTitle);
        return;
      }
      setBanner(`${m.code}: ${m.message}`);
    });
    return () => {
      offSnap();
      offChat();
      offErr();
    };
  }, [conn, hostId, resetPendingCreate]);

  const all = useMemo(
    () => sortSessions(runtime.sessions).filter((session) => !hiddenIds.has(session.id)),
    [hiddenIds, runtime.sessions],
  );
  const currentSessions = useMemo(
    () => all.filter((session) => !archivedIds.has(session.id)),
    [all, archivedIds],
  );
  const archivedSessions = useMemo(
    () => all.filter((session) => archivedIds.has(session.id)),
    [all, archivedIds],
  );
  const selectedPool = showArchived ? archivedSessions : currentSessions;
  const sessions = useMemo(
    () => (filter === "all" ? selectedPool : selectedPool.filter((s) => s.agent === filter)),
    [selectedPool, filter],
  );
  const allSessionsById = useMemo(
    () => new Map(all.map((session) => [session.id, session])),
    [all],
  );
  const visibleSessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const goalVisibility = useMemo(
    () => goalSessionVisibility(
      goalGroups,
      new Set(visibleSessionsById.keys()),
      new Set(allSessionsById.keys()),
    ),
    [allSessionsById, goalGroups, visibleSessionsById],
  );
  const contextualGoalCoordinators = useMemo(
    () => Array.from(goalVisibility.contextualCoordinatorIds).flatMap((sessionId) => {
      const session = allSessionsById.get(sessionId);
      return session ? [session] : [];
    }),
    [allSessionsById, goalVisibility],
  );
  const topLevelSessions = useMemo(
    () => sortSessions(Object.fromEntries([
      ...sessions.filter((session) => !goalVisibility.nestedWorkerIds.has(session.id)),
      ...contextualGoalCoordinators,
    ].map((session) => [session.id, session]))),
    [contextualGoalCoordinators, goalVisibility, sessions],
  );
  const projects = useMemo(() => groupSessionsByProject(topLevelSessions), [topLevelSessions]);
  const runningCount = all.filter(
    (s) => s.status === "running" || s.status === "starting",
  ).length;
  // 账号与编排都是偶尔才用一次的功能。摆在列表上方会把每次都要看的会话推下去,
  // 收进标题栏菜单后开屏第一眼就是会话,说明文字也能在菜单里完整保留。
  const hasHostTools = Boolean(
    conn?.supportsAgentAccounts || conn?.supportsOrchestrationSnapshot,
  );
  const usedAgents = useMemo(
    () => [...new Set(selectedPool.map((s) => s.agent))],
    [selectedPool],
  );
  const selectedProjectSessions = useMemo(
    () => (cwd.trim() ? all.filter((session) => session.cwd === cwd.trim()) : []),
    [all, cwd],
  );

  // 只报延迟,不报地址 —— 地址是内网拓扑,截图分享时不该跟着出去,
  // 而且连哪条线路是竞速自动决定的,用户无从干预
  // 验收期要能直接读到 A1/A5 的数,不然只能填"主观秒开"
  const metrics: string[] = [];
  if (runtime.rttMs !== null) metrics.push(`${String(runtime.rttMs)}ms`);
  if (conn?.lastAttachMs != null) metrics.push(`上屏 ${String(conn.lastAttachMs)}ms`);
  if (conn?.lastResumeMs != null) metrics.push(`恢复 ${String(conn.lastResumeMs)}ms`);
  const quality = metrics.length > 0 ? ` · ${metrics.join(" · ")}` : "";
  const connText =
    runtime.status === "connected"
      ? `${runningCount} 个运行中 · ${String(currentSessions.length)} 个当前会话${
          archivedSessions.length > 0 ? ` · ${String(archivedSessions.length)} 个归档` : ""
        }${quality}`
      : runtime.status === "connecting"
        ? "连接中…"
        : runtime.status === "reconnecting"
          ? "重连中…"
          : runtime.status === "failed"
            ? (runtime.lastError ?? "连接失败")
            : "未连接";
  const createButtonLabel = createDelivery === "queued"
    ? "等待连接…"
    : createDelivery === "sent"
      ? "正在创建…"
      : launchIntent === "goal"
        ? "启动 Goal 协调者"
        : sessionKind === "structured" && selectedResume
          ? "恢复并打开对话"
          : sessionKind === "structured" && launchMode === "plan"
            ? "新建 Plan 会话"
            : "新建会话";

  const submitCreate = (): void => {
    if (!conn || runtime.status !== "connected" || pendingCreateRef.current) return;
    const projectPath = cwd.trim();
    if (projectPath.length === 0) {
      setBanner("请先选择项目目录，再新建会话。");
      setPickerOpen(true);
      return;
    }
    const objective = goal.trim();
    if (launchIntent === "goal" && objective.length === 0) {
      setBanner("请先写下 Goal，协调者才知道要完成什么。");
      return;
    }
    pendingCreateRef.current = true;
    const accountOption = selectedAccount ? { accountId: selectedAccount.id } : {};
    const modelOption =
      sessionKind === "structured" &&
      launchCatalogAgent !== null &&
      selectedLaunchModelInfo !== undefined
        ? {
            model: selectedLaunchModelInfo.id,
            ...(selectedLaunchEffort ? { effort: selectedLaunchEffort } : {}),
          }
        : {};
    const sessionOptions:
      | {
          mode?: "default" | "plan";
          resume?: { id: string; title?: string };
          goal?: string;
          accountId?: string;
          approvalPolicy?: ApprovalPolicy;
          model?: string;
          effort?: string;
          agentPreset?: string;
        }
      | undefined =
      launchIntent === "goal"
          ? {
              ...accountOption,
              ...modelOption,
              ...(agent === "deepseek" && selectedLaunchPreset ? { agentPreset: selectedLaunchPreset } : {}),
              approvalPolicy,
              goal: objective,
            ...(PLAN_CAPABLE.includes(agent) ? { mode: "plan" as const } : {}),
          }
        : sessionKind === "structured" && RESUMABLE.includes(agent)
            ? {
                ...accountOption,
                ...modelOption,
                ...(agent === "deepseek" && selectedLaunchPreset ? { agentPreset: selectedLaunchPreset } : {}),
                approvalPolicy,
                ...(PLAN_CAPABLE.includes(agent) ? { mode: launchMode } : {}),
              ...(selectedResume
                ? { resume: { id: selectedResume.id, title: selectedResume.title } }
                : {}),
            }
          : sessionKind === "structured"
            ? {
                ...accountOption,
                ...modelOption,
                ...(agent === "deepseek" && selectedLaunchPreset ? { agentPreset: selectedLaunchPreset } : {}),
                approvalPolicy,
              }
            : selectedAccount
              ? accountOption
              : undefined;
    const createKind = launchIntent === "goal"
      ? "structured"
      : STRUCTURED.includes(agent)
        ? sessionKind
        : "pty";
    const sendCreate = (options: typeof sessionOptions): void => {
      const result = conn.createSession(agent, projectPath, undefined, createKind, 80, 24, options);
      if (!result.accepted) {
        resetPendingCreate();
        setBanner(sessionCreateFailureText(result));
        return;
      }
      setCreateDelivery(result.disposition);
    };
    pendingResumeTitleRef.current =
      agent === "codex" && sessionOptions?.resume
        ? sessionOptions.resume.title ?? "这条 Codex 对话"
        : null;
    sendCreate(sessionOptions);
  };

  const leaveHost = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const changeArchive = useCallback((sessionId: string, archived: boolean): void => {
    setArchivedIds((current) => {
      const next = new Set(current);
      if (archived) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
    void setSessionArchived(hostId, sessionId, archived).catch((error: unknown) => {
      // 写盘失败时撤回乐观更新；会话本身从未被终止。
      setArchivedIds((current) => {
        const next = new Set(current);
        if (archived) next.delete(sessionId);
        else next.add(sessionId);
        return next;
      });
      setBanner(`归档状态保存失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [hostId]);

  const deleteSession = (session: SessionInfo): void => {
    setDeleteTarget(null);
    setHiddenIds((current) => new Set(current).add(session.id));
    // “删除”必须结束 Prospero 持有的原生 writer；仅隐藏请使用“归档”。
    // 否则一个看不见的 Codex app-server 仍会让电脑端永久显示占用中。
    conn?.kill(session.id);
    void setSessionHidden(hostId, session.id, true).catch((error: unknown) => {
      setHiddenIds((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
      setBanner(`删除状态保存失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  // SessionRow 的 memo 比较会读这个引用;写成普通函数的话每次渲染都换新的,
  // 所有行都会被判定为 props 变化,memo 等于没做。
  const sessionSwipeActions = useCallback((session: SessionInfo): SwipeAction[] => {
    const archived = archivedIds.has(session.id);
    return [
      {
        id: "toggle-archive",
        label: archived ? "恢复" : "归档",
        symbol: "archivebox",
        color: "#766A45",
        onPress: () => changeArchive(session.id, !archived),
      },
      {
        id: "open-files",
        label: "文件",
        symbol: "doc.on.doc",
        color: "#3a6ea5",
        onPress: () => router.push(`/host/${hostId}/files/${session.id}`),
      },
      {
        id: "end-session",
        label: "删除",
        symbol: "trash",
        color: "#e5534b",
        onPress: () => setDeleteTarget(session),
      },
    ];
  }, [archivedIds, changeArchive, hostId]);

  const toggleGoalWorkers = useCallback((runId: string, expanded: boolean): void => {
    setGoalRunExpansionOverrides((current) => ({ ...current, [runId]: expanded }));
  }, []);

  const toggleProject = (path: string): void => {
    const collapsed = !collapsedProjects.has(path);
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (collapsed) next.add(path);
      else next.delete(path);
      return next;
    });
    void setProjectCollapsed(hostId, path, collapsed).catch((error: unknown) => {
      setBanner(`项目状态保存失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerTitleAlign: "center",
          headerTitle: () => (
            <Text
              style={[styles.headerTitle, { maxWidth: Math.max(96, width - 136) }]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {host?.name ?? "主机"}
            </Text>
          ),
          headerBackVisible: false,
          headerLeft: () => (
            <Pressable
              style={styles.headerBack}
              onPress={leaveHost}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="返回机器列表"
            >
              <Icon name="chevron.left" size={20} color={color.accent} weight="semibold" />
            </Pressable>
          ),
          headerRight: () =>
            composing ? (
              <Pressable
                onPress={() => {
                  setComposing(false);
                  setSelectedResume(null);
                  setLaunchIntent("conversation");
                  setGoal("");
                  setApprovalPolicy("strict");
                  setCreateYoloConfirmOpen(false);
                }}
                hitSlop={8}
              >
                <Text style={styles.headerCancel}>取消</Text>
              </Pressable>
            ) : (
              <View style={styles.headerActions}>
                <Pressable
                  onPress={() => {
                    setLaunchIntent("conversation");
                    setGoal("");
                    setSelectedResume(null);
                    setApprovalPolicy("strict");
                    setCreateYoloConfirmOpen(false);
                    setCwd((current) => current.trim() || currentSessions[0]?.cwd || "");
                    setComposing(true);
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="新建会话"
                >
                  <Icon name="plus" size={19} color={color.accent} weight="semibold" />
                </Pressable>
                {hasHostTools && (
                  <Pressable
                    onPress={() => setToolsOpen(true)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="更多主机功能"
                  >
                    <Icon name="ellipsis.circle" size={21} color={color.accent} />
                  </Pressable>
                )}
              </View>
            ),
        }}
      />

      {/* 连上时状态并进主机卡片 —— 一行灰字和卡片说的是同一件事,分开摆只是
          让屏幕上多一条横线。出问题时才需要独立一条,因为那时要给"重试"按钮 */}
      {runtime.status !== "connected" && (
        <View style={styles.statusBar}>
          <Text
            style={[styles.statusText, runtime.status === "failed" && styles.statusFailed]}
            numberOfLines={runtime.status === "failed" ? 3 : 1}
          >
            {connText}
          </Text>
          {(runtime.status === "failed" || runtime.status === "reconnecting") && (
            <Pressable onPress={() => conn?.kick()} hitSlop={8}>
              <Text style={styles.retry}>重试</Text>
            </Pressable>
          )}
        </View>
      )}

      {banner !== null && (
        <Pressable style={styles.banner} onPress={() => setBanner(null)}>
          <Text style={styles.bannerText}>{banner}(点击关闭)</Text>
        </Pressable>
      )}

      {composing ? (
        <KeyboardAvoidingView
          style={styles.launcher}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={[styles.launcherSplit, wideComposer && styles.launcherSplitWide]}>
            <View
              style={[
                styles.projectPane,
                !wideComposer && manualCwdOpen && styles.projectPaneManual,
                wideComposer && styles.projectPaneWide,
                wideComposer && {
                  flex: 0,
                  width: composerPaneWidths.start,
                },
              ]}
            >
              <View style={styles.paneHeader}>
                <Text style={styles.paneTitle}>项目</Text>
                <Text style={styles.paneMeta}>
                  {selectedProjectSessions.length > 0
                    ? `${String(selectedProjectSessions.length)} 个已有会话`
                    : "选择本次工作的目录"}
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.selectedProjectCard, pressed && styles.cardPressed]}
                onPress={() => setPickerOpen(true)}
                disabled={runtime.status !== "connected"}
                accessibilityRole="button"
                accessibilityLabel={cwd.trim() ? "更换项目目录" : "选择项目目录"}
              >
                <View style={styles.selectedProjectIcon}>
                  <Icon name="folder.fill" size={20} color={color.accent} />
                </View>
                <View style={styles.selectedProjectCopy}>
                  <Text style={styles.selectedProjectName} numberOfLines={1}>
                    {cwd.trim() ? projectNameFor(cwd.trim()) : "未选择项目"}
                  </Text>
                  <Text style={styles.selectedProjectPath} numberOfLines={2}>
                    {cwd.trim() || (wideComposer ? "输入完整路径，或从电脑浏览选择" : "从电脑浏览选择目录")}
                  </Text>
                  {!wideComposer && <Text style={styles.selectedProjectChange}>点按更换</Text>}
                </View>
              </Pressable>
              {!wideComposer && (
                <Pressable
                  style={({ pressed }) => [styles.manualCwdToggle, pressed && styles.browseBtnPressed]}
                  onPress={() => setManualCwdOpen((open) => !open)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: manualCwdOpen }}
                >
                  <Text style={styles.manualCwdToggleText}>{manualCwdOpen ? "收起路径输入" : "手动输入完整路径"}</Text>
                </Pressable>
              )}
              {(wideComposer || manualCwdOpen) && <View style={styles.cwdRow}>
                <View style={styles.cwdField}>
                  <Icon name="folder.fill" size={16} color={color.textDim} />
                  <TextInput
                    style={styles.cwdInput}
                    placeholder="项目目录"
                    placeholderTextColor={color.textFaint}
                    selectionColor={color.accent}
                    value={cwd}
                    onChangeText={(value) => {
                      setCwd(value);
                      setWorkspacePath("");
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    clearButtonMode="while-editing"
                    keyboardAppearance="dark"
                    accessibilityLabel="工作目录"
                  />
                </View>
                <Pressable
                  style={({ pressed }) => [
                    styles.browseBtn,
                    runtime.status !== "connected" && styles.btnDisabled,
                    pressed && styles.browseBtnPressed,
                  ]}
                  disabled={runtime.status !== "connected"}
                  onPress={() => setPickerOpen(true)}
                  accessibilityLabel="浏览电脑上的目录"
                >
                  <Text style={styles.browseBtnText}>浏览</Text>
                </Pressable>
              </View>}
              {wideComposer && selectedProjectSessions.slice(0, 3).map((session) => (
                <Pressable
                  key={session.id}
                  style={({ pressed }) => [styles.projectSessionHint, pressed && styles.cardPressed]}
                  onPress={() => router.push(`/host/${hostId}/session/${session.id}`)}
                  accessibilityLabel={`打开已有会话 ${session.title}`}
                >
                  <View style={[styles.dot, { backgroundColor: statusColor[session.status] }]} />
                  <Text style={styles.projectSessionHintText} numberOfLines={1}>{session.title}</Text>
                  <Icon name="chevron.right" size={11} color={color.textFaint} />
                </Pressable>
              ))}
              <Text style={[styles.projectPaneHelp, !wideComposer && styles.projectPaneHelpCompact]}>
                {workspacePath === ""
                  ? "目录决定会话归属；这里始终显示本次会话对应的项目。"
                  : `已从目录浏览器选择：~/${workspacePath}`}
              </Text>
            </View>

            {verticalPanes && (
              <View
                style={[styles.foldGutter, { width: verticalPanes.gap }]}
                pointerEvents="none"
              />
            )}

            <ScrollView
              style={[
                styles.configPane,
                wideComposer && {
                  flex: 0,
                  width: composerPaneWidths.end,
                },
              ]}
              contentContainerStyle={[styles.configBox, { paddingBottom: Math.max(insets.bottom, space.lg) }]}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
          <Text style={styles.formLabel}>运行方式</Text>
          <View style={styles.chips}>
            {availableAgents.map((a) => (
              <Pressable
                key={a}
                onPress={() => {
                  setAgent(a);
                  setSessionKind(STRUCTURED.includes(a) ? "structured" : "pty");
                  if (!STRUCTURED.includes(a)) setApprovalPolicy("strict");
                  setLaunchMode("default");
                  setLaunchIntent("conversation");
                  setGoal("");
                  setResumeQuery("");
                  setResumeResults([]);
                  setResumeLoaded(false);
                  setSelectedResume(null);
                }}
                style={[styles.chip, agent === a && styles.chipActive]}
              >
                <AgentIcon agent={a} size={14} />
                <Text style={[styles.chipText, agent === a && styles.chipTextActive]}>{a}</Text>
                {/* 对话/终端决定进去看到的是消息流还是一块终端屏,建之前就该知道。
                    原来这里挂个 💬 emoji —— 和满屏 SF Symbols 摆在一起像块补丁 */}
                {STRUCTURED.includes(a) && (
                  <Icon
                    name="bubble.left.and.text.bubble.right"
                    size={11}
                    /* 选中时底色变蓝,弱灰会糊在上面看不见 */
                    color={agent === a ? color.textDim : color.textFaint}
                  />
                )}
              </Pressable>
            ))}
          </View>
          {codeAgent && conn?.supportsAgentAccounts && (
            <>
              <View style={[styles.accountLabelRow, styles.kindLabel]}>
                <Text style={styles.formLabel}>账号环境</Text>
                <Pressable
                  onPress={() => router.push(`/host/${hostId}/accounts`)}
                  hitSlop={8}
                  accessibilityLabel="管理 Code Agent 账号"
                >
                  <Text style={styles.accountManage}>管理</Text>
                </Pressable>
              </View>
              <View style={styles.chips}>
                {matchingAccounts.map((account) => {
                  const active = selectedAccount?.id === account.id;
                  return (
                    <Pressable
                      key={account.id}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => {
                        setSelectedAccountIds((current) => ({
                          ...current,
                          [codeAgent]: account.id,
                        }));
                        setSelectedResume(null);
                        setResumeResults([]);
                        setResumeLoaded(false);
                      }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <View
                        style={[
                          styles.accountDot,
                          {
                            backgroundColor:
                              account.status === "signed_in"
                                ? color.success
                                : account.status === "unavailable"
                                  ? color.warn
                                  : color.textFaint,
                          },
                        ]}
                      />
                      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                        {account.name}
                      </Text>
                    </Pressable>
                  );
                })}
                <Pressable
                  style={styles.chip}
                  onPress={() => router.push(`/host/${hostId}/accounts`)}
                >
                  <Icon name="plus" size={12} color={color.accent} />
                  <Text style={[styles.chipText, { color: color.accent }]}>新增</Text>
                </Pressable>
              </View>
              <Text style={styles.kindHelp}>
                配置和凭据彼此隔离；项目目录仍使用左侧所选路径。
              </Text>
            </>
          )}
          {STRUCTURED.includes(agent) && (
            <>
              {agent !== "deepseek" && (
                <>
                  <Text style={[styles.formLabel, styles.kindLabel]}>界面</Text>
                  <View style={styles.kindSwitch} accessibilityRole="tablist">
                <Pressable
                  style={[styles.kindOption, sessionKind === "structured" && styles.kindOptionActive]}
                  onPress={() => setSessionKind("structured")}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: sessionKind === "structured" }}
                  accessibilityLabel="创建对话会话"
                >
                  <Icon
                    name="bubble.left.and.text.bubble.right"
                    size={14}
                    color={sessionKind === "structured" ? color.text : color.textDim}
                  />
                  <Text
                    style={[
                      styles.kindOptionText,
                      sessionKind === "structured" && styles.kindOptionTextActive,
                    ]}
                  >
                    对话
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.kindOption, sessionKind === "pty" && styles.kindOptionActive]}
                  onPress={() => {
                    setSessionKind("pty");
                    setApprovalPolicy("strict");
                    setLaunchIntent("conversation");
                    setSelectedResume(null);
                  }}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: sessionKind === "pty" }}
                  accessibilityLabel="创建终端会话"
                >
                  <Icon
                    name="terminal"
                    size={14}
                    color={sessionKind === "pty" ? color.text : color.textDim}
                  />
                  <Text
                    style={[
                      styles.kindOptionText,
                      sessionKind === "pty" && styles.kindOptionTextActive,
                    ]}
                  >
                    终端
                  </Text>
                </Pressable>
                  </View>
                  <Text style={styles.kindHelp}>
                    {sessionKind === "structured"
                      ? "消息、工具调用和审批以卡片展示"
                      : `启动 ${agent} TUI，可直接操作完整终端`}
                  </Text>
                </>
              )}
              {sessionKind === "structured" && launchCatalogAgent && conn?.supportsSessionCreateModel && (
                <>
                  <View style={[styles.accountLabelRow, styles.kindLabel]}>
                    <Text style={styles.formLabel}>模型</Text>
                    <Pressable
                      onPress={() => setLaunchModelsReload((value) => value + 1)}
                      disabled={launchModelsLoading}
                      hitSlop={8}
                      accessibilityLabel="刷新可选模型"
                    >
                      <Text style={styles.accountManage}>
                        {launchModelsLoading ? "读取中" : "刷新"}
                      </Text>
                    </Pressable>
                  </View>
                  {launchModelsLoading && launchModels.length === 0 ? (
                    <View style={styles.modelLoading}>
                      <ActivityIndicator size="small" color={color.accent} />
                      <Text style={styles.kindHelp}>从 {agent} 读取实时模型目录…</Text>
                    </View>
                  ) : (
                    <>
                      {launchModelsError && (
                        <Text style={styles.resumeError}>{launchModelsError}</Text>
                      )}
                      {launchModels.length > 0 && (
                        <View style={styles.chips} accessibilityRole="radiogroup">
                          {launchModels.map((model) => {
                            const active = selectedLaunchModel === model.id;
                            return (
                              <Pressable
                                key={model.id}
                                style={[styles.chip, active && styles.chipActive]}
                                onPress={() => {
                                  setSelectedLaunchModel(model.id);
                                  setSelectedLaunchEffort(
                                    model.defaultEffort ?? model.supportedEfforts[0] ?? null,
                                  );
                                }}
                                accessibilityRole="radio"
                                accessibilityState={{ checked: active }}
                                accessibilityLabel={`模型 ${model.label}`}
                              >
                                <Text
                                  style={[styles.chipText, active && styles.chipTextActive]}
                                  numberOfLines={1}
                                >
                                  {model.label}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}
                      {selectedLaunchModelInfo?.description && (
                        <Text style={styles.kindHelp} numberOfLines={2}>
                          {selectedLaunchModelInfo.description}
                        </Text>
                      )}
                      {(selectedLaunchModelInfo?.supportedEfforts.length ?? 0) > 0 && (
                        <>
                          <Text style={[styles.formLabel, styles.modelEffortLabel]}>推理强度</Text>
                          <View style={styles.chips} accessibilityRole="radiogroup">
                            {selectedLaunchModelInfo?.supportedEfforts.map((effort) => {
                              const active = selectedLaunchEffort === effort;
                              return (
                                <Pressable
                                  key={effort}
                                  style={[styles.chip, active && styles.chipActive]}
                                  onPress={() => setSelectedLaunchEffort(effort)}
                                  accessibilityRole="radio"
                                  accessibilityState={{ checked: active }}
                                >
                                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                                    {effort}
                                  </Text>
                                </Pressable>
                              );
                            })}
                          </View>
                        </>
                      )}
                      {agent === "deepseek" && launchPresets.length > 0 && (
                        <>
                          <Text style={[styles.formLabel, styles.modelEffortLabel]}>Agent 预设</Text>
                          <View style={styles.chips} accessibilityRole="radiogroup">
                            {launchPresets.map((preset) => {
                              const active = selectedLaunchPreset === preset.id;
                              return (
                                <Pressable
                                  key={preset.id}
                                  style={[styles.chip, active && styles.chipActive]}
                                  onPress={() => setSelectedLaunchPreset(preset.id)}
                                  accessibilityRole="radio"
                                  accessibilityState={{ checked: active }}
                                  accessibilityLabel={`Agent 预设 ${preset.name}`}
                                >
                                  <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                                    {preset.name}{preset.custom ? " · 自定义" : ""}
                                  </Text>
                                </Pressable>
                              );
                            })}
                          </View>
                          {launchPresets.find((preset) => preset.id === selectedLaunchPreset)?.description && (
                            <Text style={styles.kindHelp} numberOfLines={2}>
                              {launchPresets.find((preset) => preset.id === selectedLaunchPreset)?.description}
                            </Text>
                          )}
                        </>
                      )}
                    </>
                  )}
                </>
              )}
              {sessionKind === "structured" &&
                launchCatalogAgent &&
                conn &&
                !conn.supportsSessionCreateModel && (
                  <>
                    <Text style={[styles.formLabel, styles.kindLabel]}>模型与推理强度</Text>
                    <Text style={styles.kindHelp}>
                      电脑端仍在运行旧版 daemon；重启电脑上的 Prospero 后即可选择。
                    </Text>
                  </>
                )}
              {sessionKind === "structured" && (
                <>
                  <Text style={[styles.formLabel, styles.kindLabel]}>发起方式</Text>
                  <View style={styles.kindSwitch} accessibilityRole="tablist">
                    <Pressable
                      style={[styles.kindOption, launchIntent === "conversation" && styles.kindOptionActive]}
                      onPress={() => setLaunchIntent("conversation")}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: launchIntent === "conversation" }}
                    >
                      <Icon
                        name="bubble.left.and.text.bubble.right"
                        size={14}
                        color={launchIntent === "conversation" ? color.text : color.textDim}
                      />
                      <Text style={[styles.kindOptionText, launchIntent === "conversation" && styles.kindOptionTextActive]}>
                        对话
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.kindOption, launchIntent === "goal" && styles.kindOptionActive]}
                      onPress={() => {
                        setLaunchIntent("goal");
                        setSelectedResume(null);
                      }}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: launchIntent === "goal" }}
                      accessibilityLabel="创建 Goal 协调者会话"
                    >
                      <Icon
                        name="command"
                        size={14}
                        color={launchIntent === "goal" ? color.text : color.textDim}
                      />
                      <Text style={[styles.kindOptionText, launchIntent === "goal" && styles.kindOptionTextActive]}>
                        Goal
                      </Text>
                    </Pressable>
                  </View>
                  <Text style={styles.kindHelp}>
                    {launchIntent === "goal"
                      ? "创建协调者与 Run；它会拆分任务、派发 worker，并在需要时向你请求决策"
                      : "普通对话只启动一个 Agent 会话"}
                  </Text>
                </>
              )}
              {sessionKind === "structured" && (
                <>
                  <Text style={[styles.formLabel, styles.kindLabel]}>审批策略</Text>
                  <View style={styles.kindSwitch} accessibilityRole="radiogroup">
                    {APPROVAL_POLICIES.map((option) => {
                      const active = approvalPolicy === option.value;
                      const danger = option.value === "yolo";
                      return (
                        <Pressable
                          key={option.value}
                          style={[
                            styles.kindOption,
                            active && styles.kindOptionActive,
                            active && danger && styles.policyOptionDangerActive,
                          ]}
                          onPress={() => {
                            if (danger) setCreateYoloConfirmOpen(true);
                            else setApprovalPolicy(option.value);
                          }}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: active }}
                          accessibilityLabel={`审批策略：${option.label}`}
                          accessibilityHint={approvalPolicyHelp[option.value]}
                        >
                          <Icon
                            name={option.symbol}
                            size={14}
                            color={active && danger ? color.danger : active ? color.text : color.textDim}
                          />
                          <Text
                            style={[
                              styles.kindOptionText,
                              active && styles.kindOptionTextActive,
                              active && danger && styles.policyOptionDangerText,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <Text
                    style={[
                      styles.kindHelp,
                      approvalPolicy === "yolo" && styles.policyDangerHelp,
                    ]}
                  >
                    {approvalPolicyHelp[approvalPolicy]}
                  </Text>
                </>
              )}
              {sessionKind === "structured" && launchIntent === "conversation" && RESUMABLE.includes(agent) && (
                <>
                  {PLAN_CAPABLE.includes(agent) && (
                    <>
                      <Text style={[styles.formLabel, styles.kindLabel]}>启动模式</Text>
                      <View style={styles.kindSwitch} accessibilityRole="tablist">
                    <Pressable
                      style={[styles.kindOption, launchMode === "default" && styles.kindOptionActive]}
                      onPress={() => setLaunchMode("default")}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: launchMode === "default" }}
                    >
                      <Icon
                        name="bubble.left.and.text.bubble.right"
                        size={14}
                        color={launchMode === "default" ? color.text : color.textDim}
                      />
                      <Text
                        style={[
                          styles.kindOptionText,
                          launchMode === "default" && styles.kindOptionTextActive,
                        ]}
                      >
                        执行
                      </Text>
                    </Pressable>
                    <Pressable
                      style={[styles.kindOption, launchMode === "plan" && styles.kindOptionActive]}
                      onPress={() => setLaunchMode("plan")}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: launchMode === "plan" }}
                    >
                      <Icon
                        name="doc.on.doc"
                        size={14}
                        color={launchMode === "plan" ? color.text : color.textDim}
                      />
                      <Text
                        style={[
                          styles.kindOptionText,
                          launchMode === "plan" && styles.kindOptionTextActive,
                        ]}
                      >
                        Plan
                      </Text>
                    </Pressable>
                      </View>
                      <Text style={styles.kindHelp}>
                        {launchMode === "plan" ? "先调查、提问并形成计划" : "直接执行任务并允许工具操作"}
                      </Text>
                    </>
                  )}

                  <Text style={[styles.formLabel, styles.kindLabel]}>接回本机对话</Text>
                  <View style={styles.resumeSearch}>
                    <Icon name="magnifyingglass" size={14} color={color.textDim} />
                    <TextInput
                      value={resumeQuery}
                      onChangeText={(value) => {
                        setResumeQuery(value);
                        setSelectedResume(null);
                        setResumeLoaded(false);
                      }}
                      style={styles.resumeInput}
                      placeholder="搜索标题、提示词或目录"
                      placeholderTextColor={color.textFaint}
                      selectionColor={color.accent}
                      autoCapitalize="none"
                      autoCorrect={false}
                      clearButtonMode="while-editing"
                      keyboardAppearance="dark"
                      accessibilityLabel="搜索本机可恢复对话"
                    />
                    {resumeLoading && <ActivityIndicator size="small" color={color.accent} />}
                  </View>
                  {resumeError && <Text style={styles.resumeError}>{resumeError}</Text>}
                  {resumeLoaded && !resumeLoading && !resumeError && resumeResults.length === 0 && (
                    <Text style={styles.resumeEmpty}>
                      {resumeQuery.trim() ? "没有匹配的本机对话" : "没有找到可恢复的本机对话"}
                    </Text>
                  )}
                  {resumeResults.length > 0 && (
                    <ScrollView
                      style={styles.resumeList}
                      contentContainerStyle={styles.resumeListContent}
                      nestedScrollEnabled
                      keyboardShouldPersistTaps="handled"
                    >
                      {resumeResults.map((conversation) => {
                        const selected = selectedResume?.id === conversation.id;
                        return (
                          <Pressable
                            key={conversation.id}
                            style={({ pressed }) => [
                              styles.resumeRow,
                              selected && styles.resumeRowSelected,
                              pressed && styles.cardPressed,
                            ]}
                            onPress={() => {
                              setSelectedResume(selected ? null : conversation);
                              if (!selected) {
                                setCwd(conversation.cwd);
                                setWorkspacePath("");
                              }
                            }}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            accessibilityLabel={`恢复对话 ${conversation.title}`}
                          >
                            <View style={styles.resumeCopy}>
                              <Text style={styles.resumeTitle} numberOfLines={1}>
                                {conversation.title}
                              </Text>
                              {conversation.preview && (
                                <Text style={styles.resumePreview} numberOfLines={1}>
                                  {conversation.preview}
                                </Text>
                              )}
                              <Text style={styles.resumeMeta} numberOfLines={1}>
                                {formatConversationDate(conversation.updatedAt)} · {conversation.cwd}
                              </Text>
                            </View>
                            {selected && (
                              <Icon name="checkmark.circle.fill" size={17} color={color.accent} />
                            )}
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  )}
                </>
              )}
              {sessionKind === "structured" && launchIntent === "goal" && (
                <>
                  <Text style={[styles.formLabel, styles.kindLabel]}>Goal</Text>
                  <TextInput
                    value={goal}
                    onChangeText={setGoal}
                    style={styles.goalInput}
                    placeholder="例如：完成移动端 iOS/Android 适配并验收"
                    placeholderTextColor={color.textFaint}
                    selectionColor={color.accent}
                    multiline
                    textAlignVertical="top"
                    autoCorrect
                    keyboardAppearance="dark"
                    accessibilityLabel="Goal 目标"
                  />
                  <Text style={styles.kindHelp}>
                    Goal 会创建新的协调者会话，不能接回已有原生对话；Claude 和 Codex 会从 Plan 开始。
                  </Text>
                </>
              )}
            </>
          )}
          <Pressable
            style={({ pressed }) => [
              styles.createBtn,
              (runtime.status !== "connected" || createDelivery !== null) && styles.btnDisabled,
              pressed && styles.createBtnPressed,
            ]}
            disabled={runtime.status !== "connected" || createDelivery !== null}
            onPress={submitCreate}
            accessibilityState={{ disabled: runtime.status !== "connected" || createDelivery !== null, busy: createDelivery !== null }}
          >
            <View style={styles.createBtnContent}>
              {createDelivery !== null && <ActivityIndicator size="small" color="#0A0A0C" />}
              <Text style={styles.createBtnText}>{createButtonLabel}</Text>
            </View>
          </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      ) : all.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filterBar}
          contentContainerStyle={styles.filterContent}
        >
          <FilterChip
            label={`当前 ${String(currentSessions.length)}`}
            active={!showArchived}
            onPress={() => {
              setShowArchived(false);
              setFilter("all");
            }}
          />
          <FilterChip
            label={`归档 ${String(archivedSessions.length)}`}
            active={showArchived}
            onPress={() => {
              setShowArchived(true);
              setFilter("all");
            }}
          />
          {usedAgents.length > 1 && (
            <FilterChip
              label="所有 Agent"
              active={filter === "all"}
              onPress={() => setFilter("all")}
            />
          )}
          {usedAgents.length > 1 && usedAgents.map((a) => (
            <FilterChip
              key={a}
              label={a}
              active={filter === a}
              onPress={() => setFilter(a)}
            />
          ))}
        </ScrollView>
      ) : null}

      {!composing && <FlatList
        data={projects}
        keyExtractor={(project) => project.path}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        // 一行 = 一个项目,展开后含它全部会话与 subagent,单行成本远高于普通列表。
        // 默认 windowSize=21(约 21 屏)会把几十个项目的整棵子树都挂在原生侧。
        initialNumToRender={6}
        maxToRenderPerBatch={4}
        windowSize={7}
        removeClippedSubviews={Platform.OS === "android"}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 32 }]}
        refreshControl={
          <RefreshControl
            refreshing={runtime.status === "connecting" || runtime.status === "reconnecting"}
            onRefresh={() => conn?.kick()}
            tintColor="#7aa2f7"
          />
        }
        ListHeaderComponent={
          <>
            <HostSummary
              hostId={hostId}
              info={runtime.hostInfo}
              conn={conn}
              connected={runtime.status === "connected"}
              rttMs={runtime.rttMs}
              sessionCount={currentSessions.length}
              runningCount={runningCount}
            />
            <GoalRunsPanel
              snapshot={orchestration}
              hostId={hostId}
              onResolveGate={(gateId, decision) => conn?.resolveOrchestrationGate(gateId, decision)}
            />
          </>
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {all.length === 0
              ? "还没有会话，点右上角 ＋ 在项目目录中创建。"
              : showArchived
                ? "归档中没有符合条件的会话。"
                : "当前项目与筛选下没有会话。"}
          </Text>
        }
        ListFooterComponent={
          projects.length > 0 ? (
            <Text style={styles.swipeHint}>
              左滑：项目可新建 · 会话可{showArchived ? "恢复" : "归档"}或删除
            </Text>
          ) : null
        }
        renderItem={({ item: project }) => {
          const collapsed = collapsedProjects.has(project.path);
          return (
            <View style={styles.projectSection}>
              <SwipeRow
                actions={[
                  {
                    id: "create-session",
                    label: "新会话",
                    symbol: "plus",
                    color: color.accent,
                    foregroundColor: color.onAccent,
                    onPress: () => {
                      setCwd(project.path);
                      setWorkspacePath("");
                      setLaunchIntent("conversation");
                      setGoal("");
                      setSelectedResume(null);
                      setApprovalPolicy("strict");
                      setCreateYoloConfirmOpen(false);
                      setComposing(true);
                    },
                  },
                ]}
              >
                <Pressable
                  style={({ pressed }) => [styles.projectHeader, pressed && styles.projectHeaderPressed]}
                  onPress={() => toggleProject(project.path)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: !collapsed }}
                  accessibilityLabel={`${project.name} 项目，${String(project.sessions.length)} 个会话；左滑可新建会话`}
                >
                  <View style={styles.projectIcon}>
                    <Icon name="folder.fill" size={17} color={color.accent} />
                  </View>
                  <View style={styles.projectCopy}>
                    <Text style={styles.projectName} numberOfLines={1}>{project.name}</Text>
                    <Text style={styles.projectPath} numberOfLines={1}>{project.path}</Text>
                  </View>
                  {project.pendingCount > 0 && (
                    <Text style={styles.projectPending}>{String(project.pendingCount)} 待处理</Text>
                  )}
                  {project.pendingCount === 0 && project.runningCount > 0 && (
                    <Text style={styles.projectRunning}>{String(project.runningCount)} 运行</Text>
                  )}
                  <Text style={styles.projectCount}>{String(project.sessions.length)}</Text>
                  <Icon
                    name={collapsed ? "chevron.right" : "chevron.down"}
                    size={12}
                    color={color.textFaint}
                  />
                </Pressable>
              </SwipeRow>
              {!collapsed && (
                <View style={styles.projectSessions}>
                  {project.sessions.map((session) => {
                    const goalGroup = goalGroups.get(session.id);
                    const goalWorkers = (goalGroup?.workers ?? []).flatMap((worker) => {
                      const workerSession = visibleSessionsById.get(worker.sessionId);
                      return workerSession ? [{ link: worker, session: workerSession }] : [];
                    });
                    return (
                      <SessionRow
                        key={session.id}
                        session={session}
                        hostId={hostId}
                        // 断线时状态只代表上次连接，不能伪装成实时状态。
                        stale={runtime.status !== "connected"}
                        isCoordinator={coordinatorRuns.get(session.id) !== undefined}
                        goalGroup={goalGroup}
                        goalWorkers={goalWorkers}
                        goalWorkersExpanded={
                          goalGroup
                            ? (goalRunExpansionOverrides[goalGroup.run.id] ??
                              goalGroup.run.status === "active")
                            : false
                        }
                        onToggleGoalWorkers={toggleGoalWorkers}
                        swipeActionsFor={sessionSwipeActions}
                      />
                    );
                  })}
                </View>
              )}
            </View>
          );
        }}
      />}
      {conn && (
        <WorkspacePicker
          visible={pickerOpen}
          conn={conn}
          initialPath={workspacePath}
          initialCwd={cwd}
          onClose={() => setPickerOpen(false)}
          onManualInput={() => {
            setPickerOpen(false);
            setManualCwdOpen(true);
          }}
          onSelect={(selection) => {
            setWorkspacePath(selection.path);
            setCwd(selection.cwd);
            setManualCwdOpen(false);
            setPickerOpen(false);
          }}
        />
      )}
      <Sheet visible={toolsOpen} title={host?.name ?? "主机"} onClose={() => setToolsOpen(false)}>
        {conn?.supportsAgentAccounts && (
          <SheetAction
            label="Agent 账号"
            detail="Codex 与 Claude Code 独立登录环境，可共享同一项目目录"
            symbol="square.stack.3d.up"
            onPress={() => {
              setToolsOpen(false);
              router.push(`/host/${hostId}/accounts`);
            }}
          />
        )}
        {conn?.supportsOrchestrationSnapshot && (
          <SheetAction
            label="Agent 编排"
            detail={
              conn.supportsManualOrchestration
                ? "手工创建 Run、任务依赖并指定 worker"
                : "查看 Run、worker 与人工 Gate"
            }
            symbol="point.3.connected.trianglepath.dotted"
            onPress={() => {
              setToolsOpen(false);
              router.push(`/host/${hostId}/orchestration`);
            }}
          />
        )}
      </Sheet>
      <Sheet
        visible={createYoloConfirmOpen}
        title="新会话使用 YOLO？"
        onClose={() => setCreateYoloConfirmOpen(false)}
      >
        <Text style={styles.decisionNote}>
          Agent 修改文件、执行命令和联网都不再询问；Codex 沙箱也会切到完整访问。操作仍会记录在聊天里。
        </Text>
        <SheetAction
          label="我明白，选择 YOLO"
          detail="仅应用到这次新建的结构化会话"
          symbol="exclamationmark.triangle.fill"
          destructive
          onPress={() => {
            setApprovalPolicy("yolo");
            setCreateYoloConfirmOpen(false);
          }}
        />
      </Sheet>
      <Sheet
        visible={resumeConflictTitle !== null}
        title="电脑正在使用这条对话"
        onClose={() => {
          setResumeConflictTitle(null);
          pendingResumeTitleRef.current = null;
        }}
      >
        <Text style={styles.decisionNote}>
          「{resumeConflictTitle ?? "Codex 对话"}」当前由电脑端占用。Codex 暂不支持两个进程同时写入同一条对话，请先在电脑端关闭该任务后再接回。
        </Text>
      </Sheet>
      <Sheet
        visible={deleteTarget !== null}
        title="删除会话"
        onClose={() => setDeleteTarget(null)}
      >
        <Text style={styles.decisionNote}>
          删除会结束电脑上的 Prospero 会话并释放 Agent 占用。只想从当前列表移走时，请使用归档。
        </Text>
        <SheetAction
          label="结束并删除"
          detail={
            deleteTarget?.status === "done" || deleteTarget?.status === "died"
              ? "删除电脑端持久化记录，并从手机列表隐藏"
              : "结束电脑端会话进程，并从手机列表隐藏"
          }
          symbol="trash"
          destructive
          onPress={() => deleteTarget && deleteSession(deleteTarget)}
        />
      </Sheet>
    </View>
  );
}

interface GoalWorkerEntry {
  link: GoalWorkerSessionLink;
  session: SessionInfo;
}

interface SessionRowProps {
  session: SessionInfo;
  hostId: string;
  stale: boolean;
  isCoordinator: boolean;
  goalGroup: GoalSessionGroup | undefined;
  goalWorkers: GoalWorkerEntry[];
  goalWorkersExpanded: boolean;
  onToggleGoalWorkers: (runId: string, expanded: boolean) => void;
  swipeActionsFor: (session: SessionInfo) => SwipeAction[];
}

/**
 * 单个会话行（含 subagent 与 Goal 工作会话）。
 *
 * 独立成 memo 组件是有实测依据的:React Compiler 在本文件的主组件上直接 bail out
 * （"Unexpected terminal kind `logical` for ternary test block"），整屏拿不到任何
 * 自动记忆化。而 upsertSession 只替换单个会话对象,其余 session 引用是稳定的 ——
 * 只要这里挡住,一次会话状态更新就不会重渲染其余上百行。
 */
const SessionRow = memo(function SessionRow({
  session,
  hostId,
  stale,
  isCoordinator,
  goalGroup,
  goalWorkers,
  goalWorkersExpanded,
  onToggleGoalWorkers,
  swipeActionsFor,
}: SessionRowProps) {
  const pending = (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0);
  return (
    <View>
      <SwipeRow actions={swipeActionsFor(session)}>
        <Pressable
          style={({ pressed }) => [
            styles.card,
            pressed && styles.cardPressed,
            (session.status === "waiting_approval" || session.status === "waiting_input") &&
              styles.cardAttention,
          ]}
          onPress={() => router.push(`/host/${hostId}/session/${session.id}`)}
        >
          <View style={styles.cardTop}>
            <View
              style={[
                styles.dot,
                { backgroundColor: stale ? "#3a3a44" : statusColor[session.status] },
              ]}
            />
            <Text style={styles.cardTitle} numberOfLines={1}>{session.title}</Text>
            <Text style={[styles.kindTag, isCoordinator && styles.coordinatorTag]}>
              {isCoordinator
                ? "Goal 编排者"
                : session.kind === "structured"
                  ? "对话"
                  : "终端"}
            </Text>
            <Text
              style={[
                styles.cardStatus,
                { color: stale ? "#5a5a66" : statusColor[session.status] },
              ]}
            >
              {statusLabel[session.status]}{stale ? "(离线前)" : ""}
            </Text>
          </View>
          {session.preview !== undefined && session.preview.length > 0 && (
            <Text style={styles.preview} numberOfLines={2}>{session.preview}</Text>
          )}
          <Text style={styles.cardSub} numberOfLines={1}>
            {pending > 0
              ? `⚠︎ ${String(pending)} 项待处理`
              : [
                  session.agent,
                  session.accountName,
                  session.kind === "structured" ? "ChatUI" : "终端",
                ].filter(Boolean).join(" · ")}
          </Text>
        </Pressable>
      </SwipeRow>
      {(session.subagents?.length ?? 0) > 0 && (
        <View style={styles.childList}>
          {(session.subagents ?? []).map((child) => {
            const active = child.status === "running" || child.status === "starting";
            return (
              <Pressable
                key={child.id}
                style={({ pressed }) => [styles.childRow, pressed && styles.cardPressed]}
                onPress={() =>
                  router.push({
                    pathname: "/host/[hostId]/session/[sid]",
                    params: { hostId, sid: session.id, subagentId: child.id },
                  })
                }
                accessibilityRole="button"
                accessibilityLabel={`查看子 Agent ${child.name}`}
              >
                <View
                  style={[
                    styles.childRail,
                    { backgroundColor: active ? color.accent : color.textFaint },
                  ]}
                />
                <View style={styles.childCopy}>
                  <View style={styles.childTop}>
                    <Text style={styles.childName} numberOfLines={1}>{child.name}</Text>
                    <Text style={[styles.childStatus, active && styles.childStatusActive]}>
                      {childStatusLabel[child.status]}
                    </Text>
                  </View>
                  {(child.preview || child.task) && (
                    <Text style={styles.childPreview} numberOfLines={1}>
                      {child.preview || child.task}
                    </Text>
                  )}
                </View>
                <Icon name="chevron.right" size={11} color={color.textFaint} />
              </Pressable>
            );
          })}
        </View>
      )}
      {goalGroup && goalWorkers.length > 0 && (
        <View style={styles.goalWorkerGroup}>
          <Pressable
            style={({ pressed }) => [styles.goalWorkerToggle, pressed && styles.cardPressed]}
            onPress={() => onToggleGoalWorkers(goalGroup.run.id, !goalWorkersExpanded)}
            accessibilityRole="button"
            accessibilityState={{ expanded: goalWorkersExpanded }}
            accessibilityLabel={`${goalGroup.run.status === "active" ? "进行中" : "已完成"} Goal 的 ${String(goalWorkers.length)} 个关联会话`}
          >
            <Icon
              name="point.3.connected.trianglepath.dotted"
              size={13}
              color={goalGroup.run.status === "active" ? color.accent : color.textDim}
            />
            <Text style={styles.goalWorkerToggleTitle} numberOfLines={1}>
              {goalGroup.run.status === "active" ? "Goal 工作会话" : "已完成 Goal 会话"}
            </Text>
            <Text style={styles.goalWorkerToggleMeta}>{String(goalWorkers.length)}</Text>
            <Icon
              name={goalWorkersExpanded ? "chevron.down" : "chevron.right"}
              size={11}
              color={color.textFaint}
            />
          </Pressable>
          {goalWorkersExpanded && (
            <View style={styles.childList}>
              {goalWorkers.map(({ link, session: workerSession }) => {
                const active = workerSession.status === "running" ||
                  workerSession.status === "starting";
                const delivered = link.taskStatus === "done";
                const workerLabel = delivered
                  ? "已交付"
                  : link.taskStatus === "failed"
                    ? "失败"
                    : statusLabel[workerSession.status];
                return (
                  <SwipeRow key={workerSession.id} actions={swipeActionsFor(workerSession)}>
                    <Pressable
                      style={({ pressed }) => [styles.childRow, pressed && styles.cardPressed]}
                      onPress={() =>
                        router.push(`/host/${hostId}/session/${workerSession.id}`)
                      }
                      accessibilityRole="button"
                      accessibilityLabel={`打开 Goal 工作会话：${link.taskTitle}，${workerLabel}`}
                    >
                      <View
                        style={[
                          styles.childRail,
                          {
                            backgroundColor: active
                              ? color.accent
                              : delivered
                                ? color.success
                                : color.textFaint,
                          },
                        ]}
                      />
                      <View style={styles.childCopy}>
                        <View style={styles.childTop}>
                          <Text style={styles.childName} numberOfLines={1}>
                            {link.taskTitle}
                          </Text>
                          <Text style={[
                            styles.childStatus,
                            (active || delivered) && styles.childStatusActive,
                          ]}>
                            {workerLabel}
                          </Text>
                        </View>
                        <Text style={styles.childPreview} numberOfLines={1}>
                          {workerSession.title}
                        </Text>
                      </View>
                      <Icon name="chevron.right" size={11} color={color.textFaint} />
                    </Pressable>
                  </SwipeRow>
                );
              })}
            </View>
          )}
        </View>
      )}
    </View>
  );
}, (prev, next) =>
  // goalWorkers 每次渲染都是新数组(flatMap 产物),默认浅比较会让所有行都失效;
  // 它通常是空的,按内容比较代价极小。
  prev.session === next.session &&
  prev.hostId === next.hostId &&
  prev.stale === next.stale &&
  prev.isCoordinator === next.isCoordinator &&
  prev.goalGroup === next.goalGroup &&
  prev.goalWorkersExpanded === next.goalWorkersExpanded &&
  prev.onToggleGoalWorkers === next.onToggleGoalWorkers &&
  prev.swipeActionsFor === next.swipeActionsFor &&
  prev.goalWorkers.length === next.goalWorkers.length &&
  prev.goalWorkers.every((w, i) =>
    w.session === next.goalWorkers[i]?.session && w.link === next.goalWorkers[i]?.link),
);

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.filterChip, active && styles.filterChipActive]}>
      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function GoalRunsPanel({
  snapshot,
  hostId,
  onResolveGate,
}: {
  snapshot: OrchestrationSnapshot | null;
  hostId: string;
  onResolveGate: (gateId: string, decision: string) => void;
}) {
  const [otherDecisions, setOtherDecisions] = useState<Record<string, string>>({});
  const overview = useMemo(() => goalRunOverview(snapshot), [snapshot]);
  if (overview.activeRunCount === 0) return null;

  return (
    <View style={styles.goalPanel}>
      <View style={styles.goalPanelHeader}>
        <Text style={styles.goalPanelTitle}>Goal 编排</Text>
        <Text style={styles.goalPanelMeta}>
          {`${String(overview.activeRunCount)} 个进行中 · ${String(overview.pendingGateCount)} 个待处理 Gate`}
        </Text>
      </View>
      {overview.visibleRuns.map((run) => {
        const tasks = (snapshot?.tasks ?? []).filter((task) => task.runId === run.id);
        const completed = tasks.filter((task) => task.status === "done").length;
        const active = tasks.filter(
          (task) => task.status === "dispatched" || task.status === "blocked",
        ).length;
        const gates = (snapshot?.gates ?? []).filter(
          (gate) => gate.runId === run.id && gate.status === "pending");
        return (
          <View key={run.id} style={styles.goalRunCard}>
            <Pressable
              disabled={run.coordinatorSessionId === null}
              onPress={() => {
                if (run.coordinatorSessionId) router.push(`/host/${hostId}/session/${run.coordinatorSessionId}`);
              }}
              style={({ pressed }) => [styles.goalRunTop, pressed && run.coordinatorSessionId && styles.cardPressed]}
              accessibilityLabel="打开 Goal 协调者会话"
            >
              <View style={styles.goalRunCopy}>
                <Text style={styles.goalRunObjective} numberOfLines={2}>{run.objective}</Text>
                <Text style={styles.goalRunStats}>
                  {`任务 ${String(completed)}/${String(tasks.length)} 已完成${active > 0 ? ` · ${String(active)} 处理中` : ""}`}
                </Text>
              </View>
              {run.coordinatorSessionId && <Icon name="chevron.right" size={13} color={color.textFaint} />}
            </Pressable>
            {gates.map((gate) => (
              <View key={gate.id} style={styles.gateCard}>
                <Text style={styles.gateQuestion}>{gate.question}</Text>
                {gate.options.length > 0 ? (
                  <View style={styles.gateOptions}>
                    {gate.options.map((option) => (
                      <Pressable
                        key={option}
                        style={({ pressed }) => [styles.gateOption, pressed && styles.gateOptionPressed]}
                        onPress={() => onResolveGate(gate.id, option)}
                        accessibilityLabel={`选择 ${option}`}
                      >
                        <Text style={styles.gateOptionText}>{option}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <View style={styles.gateOtherRow}>
                    <TextInput
                      value={otherDecisions[gate.id] ?? ""}
                      onChangeText={(value) =>
                        setOtherDecisions((current) => ({ ...current, [gate.id]: value }))
                      }
                      style={styles.gateOtherInput}
                      placeholder="输入决定"
                      placeholderTextColor={color.textFaint}
                      selectionColor={color.accent}
                      accessibilityLabel="输入 Gate 决定"
                    />
                    <Pressable
                      style={styles.gateConfirm}
                      disabled={(otherDecisions[gate.id] ?? "").trim().length === 0}
                      onPress={() => onResolveGate(gate.id, (otherDecisions[gate.id] ?? "").trim())}
                    >
                      <Text style={styles.gateConfirmText}>确认</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ))}
          </View>
        );
      })}
      {overview.truncatedRunCount > 0 && (
        <Pressable
          style={({ pressed }) => [styles.goalOverflow, pressed && styles.cardPressed]}
          onPress={() => router.push(orchestrationRoute(hostId, overview.firstTruncatedGateRunId))}
          accessibilityRole="button"
          accessibilityLabel={overview.firstTruncatedGateRunId
            ? `打开 Agent 编排中心，并预选包含待处理 Gate 的 Run；另有 ${String(overview.truncatedRunCount)} 个 Run 未显示`
            : `打开 Agent 编排中心；另有 ${String(overview.truncatedRunCount)} 个 Run 未显示`}
          accessibilityHint={overview.firstTruncatedGateRunId
            ? "直接定位到第一个未显示的待处理 Gate 所在 Run"
            : "查看未显示的 Run"}
        >
          <View style={styles.goalOverflowCopy}>
            <Text style={styles.goalOverflowTitle}>查看全部 Agent 编排</Text>
            <Text style={styles.goalOverflowDetail}>
              {`另有 ${String(overview.truncatedRunCount)} 个 Run 未显示${
                overview.truncatedPendingGateCount > 0
                  ? ` · ${String(overview.truncatedPendingGateCount)} 个待处理 Gate`
                  : ""
              }`}
            </Text>
          </View>
          <Icon name="chevron.right" size={13} color={color.textFaint} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  headerTitle: { ...font.body, fontWeight: "700", textAlign: "center" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 14 },
  headerBack: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerCancel: { color: color.accent, fontSize: 15 },
  statusBar: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  statusText: font.sub,
  statusFailed: { color: color.danger },
  retry: { color: color.accent, fontSize: 13, marginTop: 4 },
  banner: {
    backgroundColor: color.warnBg,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  bannerText: { color: color.warn, fontSize: 12 },
  filterBar: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  filterContent: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  filterChip: {
    paddingHorizontal: space.md,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: color.surface,
  },
  filterChipActive: { backgroundColor: color.accentDim },
  filterChipText: { ...font.sub, color: color.textDim, lineHeight: 18, includeFontPadding: false },
  filterChipTextActive: { color: color.text, fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chipActive: { backgroundColor: color.accentDim },
  chipTextActive: { color: color.text, fontWeight: "600" },
  launcher: { flex: 1, minHeight: 0 },
  launcherSplit: { flex: 1, minHeight: 0, flexDirection: "column" },
  launcherSplitWide: { flexDirection: "row" },
  foldGutter: { flexShrink: 0, backgroundColor: color.bg },
  projectPane: {
    flexGrow: 0,
    flexShrink: 0,
    maxHeight: 184,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    gap: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  projectPaneWide: {
    maxHeight: undefined,
    borderBottomWidth: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: color.border,
  },
  projectPaneManual: { maxHeight: 264 },
  configPane: { flex: 1, minHeight: 0 },
  configBox: {
    width: "100%",
    maxWidth: 920,
    alignSelf: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
  },
  paneHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.sm },
  paneTitle: { ...font.body, fontWeight: "700" },
  paneMeta: { ...font.meta, color: color.textDim },
  selectedProjectCard: {
    minHeight: 68,
    padding: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  selectedProjectIcon: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: color.accentBg,
  },
  selectedProjectCopy: { flex: 1, gap: 3 },
  selectedProjectName: { color: color.text, fontSize: 15, fontWeight: "700" },
  selectedProjectPath: { ...font.meta, color: color.textDim },
  selectedProjectChange: { color: color.accent, fontSize: 11, fontWeight: "600" },
  projectSessionHint: {
    minHeight: 34,
    paddingHorizontal: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceRaised,
  },
  projectSessionHintText: { flex: 1, color: color.textDim, fontSize: 12 },
  projectPaneHelp: { ...font.meta, marginTop: "auto", color: color.textFaint, lineHeight: 16 },
  projectPaneHelpCompact: { marginTop: 0 },
  newBox: {
    width: "100%",
    maxWidth: 920,
    alignSelf: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  newBoxScroll: { flexGrow: 0, maxHeight: "72%" },
  formLabel: { ...font.meta, color: color.textDim, fontWeight: "600" },
  accountLabelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  accountManage: { color: color.accent, fontSize: 12, fontWeight: "600" },
  accountDot: { width: 7, height: 7, borderRadius: 4 },
  kindLabel: { marginTop: space.xs },
  modelLoading: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 34 },
  modelEffortLabel: { marginTop: 2 },
  kindSwitch: {
    flexDirection: "row",
    gap: 3,
    padding: 3,
    borderRadius: 12,
    backgroundColor: color.surfaceRaised,
  },
  kindOption: {
    flex: 1,
    minHeight: 36,
    borderRadius: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  kindOptionActive: { backgroundColor: color.pressed },
  policyOptionDangerActive: { backgroundColor: color.dangerBg },
  policyOptionDangerText: { color: color.danger },
  kindOptionText: { color: color.textDim, fontSize: 13, fontWeight: "500" },
  kindOptionTextActive: { color: color.text, fontWeight: "600" },
  kindHelp: { ...font.meta, marginLeft: 2 },
  policyDangerHelp: { color: color.danger },
  goalInput: {
    minHeight: 92,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    color: color.text,
    fontSize: 14,
    lineHeight: 20,
  },
  resumeSearch: {
    minHeight: 42,
    paddingHorizontal: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  resumeInput: {
    flex: 1,
    alignSelf: "stretch",
    paddingVertical: 0,
    color: color.text,
    fontSize: 13,
  },
  resumeError: { ...font.meta, color: color.danger },
  resumeEmpty: { ...font.meta, paddingVertical: 4, textAlign: "center" },
  resumeList: {
    maxHeight: 176,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  resumeListContent: { gap: StyleSheet.hairlineWidth, backgroundColor: color.border },
  resumeRow: {
    minHeight: 64,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: color.surface,
  },
  resumeRowSelected: { backgroundColor: color.accentBg },
  resumeCopy: { flex: 1, gap: 2 },
  resumeTitle: { color: color.text, fontSize: 13, fontWeight: "600" },
  resumePreview: { color: color.textDim, fontSize: 11.5 },
  resumeMeta: { color: color.textFaint, fontSize: 10 },
  cwdLabel: { marginTop: space.xs },
  createBtnText: { color: color.onAccent, fontSize: 15, fontWeight: "700" },
  btnDisabled: { opacity: 0.45 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  dim: font.sub,
  connBar: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  connText: font.sub,
  filterRow: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: color.surface,
  },
  chipOn: { backgroundColor: color.accentDim },
  chipText: { ...font.sub, color: color.textDim },
  chipTextOn: { color: color.text, fontWeight: "600" },
  list: {
    width: "100%",
    maxWidth: 920,
    alignSelf: "center",
    padding: space.lg,
    gap: space.md,
  },
  goalPanel: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  goalPanelHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.sm,
  },
  goalPanelTitle: { ...font.body, fontWeight: "700" },
  goalPanelMeta: { ...font.meta, flexShrink: 1, color: color.accent, textAlign: "right" },
  goalOverflow: {
    minHeight: 52,
    paddingHorizontal: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.accentBg,
  },
  goalOverflowCopy: { flex: 1, gap: 2 },
  goalOverflowTitle: { color: color.accent, fontSize: 13, fontWeight: "700" },
  goalOverflowDetail: { ...font.meta, color: color.textDim },
  goalRunCard: {
    overflow: "hidden",
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
  },
  goalRunTop: {
    minHeight: 62,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  goalRunCopy: { flex: 1, gap: 3 },
  goalRunObjective: { color: color.text, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  goalRunStats: { ...font.meta, color: color.textDim },
  gateCard: {
    gap: space.sm,
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.warnBg,
  },
  gateQuestion: { color: color.text, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  gateOptions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  gateOption: {
    minHeight: 34,
    paddingHorizontal: space.md,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: color.surface,
  },
  gateOptionPressed: { backgroundColor: color.pressed },
  gateOptionText: { color: color.accent, fontSize: 12, fontWeight: "600" },
  gateOtherRow: { flexDirection: "row", gap: space.sm },
  gateOtherInput: {
    flex: 1,
    minHeight: 38,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    color: color.text,
    backgroundColor: color.surface,
    fontSize: 13,
  },
  gateConfirm: {
    minWidth: 54,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: color.accentDim,
  },
  gateConfirmText: { color: color.accent, fontSize: 12, fontWeight: "700" },
  projectSection: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    overflow: "hidden",
  },
  projectHeader: {
    minHeight: 66,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  projectHeaderPressed: { backgroundColor: color.pressed },
  projectIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accentDim,
  },
  projectCopy: { flex: 1, gap: 2 },
  projectName: { color: color.text, fontSize: 15, fontWeight: "700" },
  projectPath: { ...font.meta, color: color.textFaint },
  projectPending: { color: color.warn, fontSize: 11, fontWeight: "600" },
  projectRunning: { color: color.success, fontSize: 11, fontWeight: "600" },
  projectCount: {
    color: color.textDim,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
    minWidth: 20,
    textAlign: "right",
  },
  projectSessions: {
    gap: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.border,
  },
  card: {
    backgroundColor: color.surface,
    borderRadius: 0,
    padding: space.lg,
    gap: 6,
  },
  cardPressed: { backgroundColor: color.pressed },
  cardAttention: { borderWidth: 1, borderColor: color.warn },
  cardTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cardTitle: { ...font.body, flex: 1 },
  kindTag: {
    ...font.meta,
    color: color.textDim,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
  },
  coordinatorTag: { color: color.accent, backgroundColor: color.accentBg },
  cardStatus: { fontSize: 12, fontWeight: "600" },
  preview: { ...font.sub, color: color.textDim, lineHeight: 18 },
  cardSub: font.meta,
  goalWorkerGroup: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.surface,
  },
  goalWorkerToggle: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 31,
    paddingRight: space.lg,
    paddingVertical: 8,
  },
  goalWorkerToggleTitle: {
    flex: 1,
    color: color.textDim,
    fontSize: 12,
    fontWeight: "600",
  },
  goalWorkerToggleMeta: {
    color: color.textFaint,
    fontSize: 10,
    fontVariant: ["tabular-nums"],
  },
  childList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.surface,
  },
  childRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingLeft: 31,
    paddingRight: space.lg,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  childRail: { width: 6, height: 6, borderRadius: 3 },
  childCopy: { flex: 1, gap: 3 },
  childTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  childName: { flex: 1, color: color.text, fontSize: 12, fontWeight: "600" },
  childStatus: { color: color.textFaint, fontSize: 9.5 },
  childStatusActive: { color: color.accent },
  childPreview: { color: color.textDim, fontSize: 10.5 },
  emptyText: { ...font.sub, textAlign: "center", paddingVertical: 40 },
  swipeHint: { ...font.meta, textAlign: "center", paddingVertical: space.lg },
  decisionNote: {
    ...font.sub,
    color: color.textDim,
    lineHeight: 20,
    paddingBottom: space.md,
  },
  cwdRow: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  cwdField: {
    flex: 1,
    minHeight: 46,
    paddingLeft: space.md,
    paddingRight: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: color.surface,
    borderRadius: radius.md,
  },
  cwdInput: {
    flex: 1,
    alignSelf: "stretch",
    paddingVertical: 0,
    color: color.text,
    fontSize: 14,
  },
  browseBtn: {
    minWidth: 62,
    minHeight: 46,
    paddingHorizontal: space.md,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
  },
  browseBtnPressed: { backgroundColor: color.pressed },
  browseBtnText: { color: color.accent, fontSize: 14, fontWeight: "600" },
  manualCwdToggle: { minHeight: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: color.surfaceRaised },
  manualCwdToggleText: { color: color.accent, fontSize: 12, fontWeight: "600" },
  cwdHelp: { ...font.meta, marginLeft: 2 },
  createBtn: {
    minHeight: 48,
    marginTop: space.xs,
    backgroundColor: color.accent,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  createBtnPressed: { opacity: 0.82 },
  createBtnContent: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
