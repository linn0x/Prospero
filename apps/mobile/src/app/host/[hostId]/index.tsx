import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import {
  getSessionPreferences,
  setProjectCollapsed,
  setSessionArchived,
} from "@/lib/session-preferences";
import { groupSessionsByProject } from "@/lib/session-projects";
import { sortSessions } from "@/lib/store";
import { useHostConnection } from "@/lib/use-host-connection";
import * as theme from "@/lib/theme";
const { color, font, radius, space } = theme;

const AGENTS: AgentKind[] = ["claude", "codex", "opencode", "grok", "trae", "shell"];
/** 有结构化适配器的 agent(会话会以对话形态呈现) */
const STRUCTURED: AgentKind[] = ["claude", "codex", "opencode"];
const RESUMABLE: AgentKind[] = ["claude", "codex"];

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
  const { hostId, create, cmd } = useLocalSearchParams<{
    hostId: string;
    create?: string;
    cmd?: string;
  }>();
  const { host, conn, runtime } = useHostConnection(hostId);
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [sessionKind, setSessionKind] = useState<SessionKind>("structured");
  const [launchMode, setLaunchMode] = useState<"default" | "plan">("default");
  const [launchIntent, setLaunchIntent] = useState<"conversation" | "goal">("conversation");
  const [goal, setGoal] = useState("");
  const [cwd, setCwd] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | AgentKind>("all");
  const [composing, setComposing] = useState(false);
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
  const [showArchived, setShowArchived] = useState(false);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [orchestration, setOrchestration] = useState<OrchestrationSnapshot | null>(null);
  const pendingCreateRef = useRef(false);
  const deepLinkCreateRef = useRef<string | null>(null);
  const insets = useSafeAreaInsets();
  const { width, height, verticalPanes } = useAdaptiveLayout();
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
  const matchingAccounts = codeAgent
    ? agentAccounts.filter((account) => account.agent === codeAgent)
    : [];
  const selectedAccount = codeAgent
    ? matchingAccounts.find((account) => account.id === selectedAccountIds[codeAgent]) ??
      matchingAccounts.find((account) => account.isDefault) ??
      matchingAccounts[0]
    : undefined;

  // 账号目录属于 Mac；每次回到主机页重读，确保账号管理页的新增/默认/删除立即生效。
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

  // 空查询列最近会话；输入后做短 debounce，旧请求通过 effect cleanup 丢弃。
  useEffect(() => {
    if (!canSearchResume || !conn || (agent !== "claude" && agent !== "codex")) {
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
        .localConversations(agent, resumeQuery, 20, selectedAccount?.id)
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

  // 编排状态是 daemon 的真相。前台轻量轮询让 iOS/Android 从后台回来后立刻收敛；
  // 用户刚解开 Gate 时 daemon 也会立即回传，不必等下一个周期。
  useFocusEffect(
    useCallback(() => {
      if (!conn || runtime.status !== "connected") return undefined;
      const refresh = (): void => conn.orchestrationSnapshot();
      refresh();
      const off = conn.events.on("orchestrationSnapshot", (message) => {
        setOrchestration(message.snapshot);
      });
      const timer = setInterval(refresh, 8_000);
      return () => {
        off();
        clearInterval(timer);
      };
    }, [conn, runtime.status]),
  );

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
    if (runtime.status !== "connected") return;
    if (!AGENTS.includes(create as AgentKind) && create !== "custom") return;
    deepLinkCreateRef.current = fireKey;
    pendingCreateRef.current = true;
    conn.createSession(
      create as AgentKind,
      undefined,
      typeof cmd === "string" && cmd.length > 0 ? cmd : undefined,
    );
  }, [conn, create, cmd, runtime.status]);

  // 新建会话:创建后 daemon 自动 attach 并发快照(PTY 发 term.snapshot,
  // 结构化发 chat.snapshot)→ 以快照的 sid 进入会话页
  useEffect(() => {
    if (!conn) return;
    const enter = (sid: string): void => {
      if (!pendingCreateRef.current || !hostId) return;
      pendingCreateRef.current = false;
      setComposing(false);
      setSelectedResume(null);
      setLaunchIntent("conversation");
      setGoal("");
      router.push(`/host/${hostId}/session/${sid}`);
    };
    const offSnap = conn.events.on("snapshot", (m) => enter(m.sid));
    const offChat = conn.events.on("chatSnapshot", (m) => enter(m.sid));
    const offErr = conn.events.on("serverError", (m) => {
      pendingCreateRef.current = false;
      setBanner(`${m.code}: ${m.message}`);
    });
    return () => {
      offSnap();
      offChat();
      offErr();
    };
  }, [conn, hostId]);

  const all = useMemo(() => sortSessions(runtime.sessions), [runtime.sessions]);
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
  const projects = useMemo(() => groupSessionsByProject(sessions), [sessions]);
  const runningCount = all.filter(
    (s) => s.status === "running" || s.status === "starting",
  ).length;
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

  const submitCreate = (): void => {
    if (!conn || runtime.status !== "connected") return;
    const objective = goal.trim();
    if (launchIntent === "goal" && objective.length === 0) {
      setBanner("请先写下 Goal，协调者才知道要完成什么。");
      return;
    }
    pendingCreateRef.current = true;
    const accountOption = selectedAccount ? { accountId: selectedAccount.id } : {};
    const sessionOptions:
      | {
          mode?: "default" | "plan";
          resume?: { id: string; title?: string };
          goal?: string;
          accountId?: string;
        }
      | undefined =
      launchIntent === "goal"
        ? {
            ...accountOption,
            goal: objective,
            ...(RESUMABLE.includes(agent) ? { mode: "plan" as const } : {}),
          }
        : sessionKind === "structured" && RESUMABLE.includes(agent)
          ? {
              ...accountOption,
              mode: launchMode,
              ...(selectedResume
                ? { resume: { id: selectedResume.id, title: selectedResume.title } }
                : {}),
            }
          : selectedAccount
            ? accountOption
            : undefined;
    conn.createSession(
      agent,
      cwd.trim() || undefined,
      undefined,
      launchIntent === "goal" ? "structured" : STRUCTURED.includes(agent) ? sessionKind : "pty",
      80,
      24,
      sessionOptions,
    );
  };

  const leaveHost = (): void => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const changeArchive = (sessionId: string, archived: boolean): void => {
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
  };

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
          title: host?.name ?? "主机",
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
              <Text style={styles.headerBackText}>机器</Text>
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
                }}
                hitSlop={8}
              >
                <Text style={styles.headerCancel}>取消</Text>
              </Pressable>
            ) : (
              <Pressable
                onPress={() => {
                  setLaunchIntent("conversation");
                  setGoal("");
                  setSelectedResume(null);
                  setComposing(true);
                }}
                hitSlop={8}
              >
                <Icon name="plus" size={19} color="#7aa2f7" weight="semibold" />
              </Pressable>
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
                    {cwd.trim() || (wideComposer ? "输入完整路径，或从 Mac 浏览选择" : "从 Mac 浏览选择目录")}
                  </Text>
                  {!wideComposer && <Text style={styles.selectedProjectChange}>点按更换</Text>}
                </View>
              </Pressable>
              {wideComposer && <View style={styles.cwdRow}>
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
                  accessibilityLabel="浏览 Mac 上的目录"
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
            {AGENTS.map((a) => (
              <Pressable
                key={a}
                onPress={() => {
                  setAgent(a);
                  setSessionKind(STRUCTURED.includes(a) ? "structured" : "pty");
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
              {sessionKind === "structured" && launchIntent === "conversation" && RESUMABLE.includes(agent) && (
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
              runtime.status !== "connected" && styles.btnDisabled,
              pressed && styles.createBtnPressed,
            ]}
            disabled={runtime.status !== "connected"}
            onPress={submitCreate}
          >
            <Text style={styles.createBtnText}>
              {launchIntent === "goal"
                ? "启动 Goal 协调者"
                : sessionKind === "structured" && selectedResume
                ? "恢复并打开对话"
                : sessionKind === "structured" && launchMode === "plan"
                  ? "新建 Plan 会话"
                  : "新建会话"}
            </Text>
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
              info={runtime.hostInfo}
              conn={conn}
              connected={runtime.status === "connected"}
              rttMs={runtime.rttMs}
              sessionCount={currentSessions.length}
              runningCount={runningCount}
            />
            {conn?.supportsAgentAccounts && (
              <Pressable
                style={({ pressed }) => [styles.orchestrationEntry, pressed && styles.cardPressed]}
                onPress={() => router.push(`/host/${hostId}/accounts`)}
                accessibilityRole="button"
                accessibilityLabel="管理 Code Agent 账号"
              >
                <View style={styles.orchestrationEntryIcon}>
                  <Icon name="square.stack.3d.up" size={19} color={color.accent} />
                </View>
                <View style={styles.orchestrationEntryCopy}>
                  <Text style={styles.orchestrationEntryTitle}>Code Agent 账号</Text>
                  <Text style={styles.orchestrationEntryDetail}>
                    Codex 与 Claude Code 独立登录环境，可共享同一项目目录
                  </Text>
                </View>
                <Icon name="chevron.right" size={13} color={color.textFaint} />
              </Pressable>
            )}
            {conn?.supportsOrchestrationSnapshot && (
              <Pressable
                style={({ pressed }) => [styles.orchestrationEntry, pressed && styles.cardPressed]}
                onPress={() => router.push(`/host/${hostId}/orchestration`)}
                accessibilityRole="button"
                accessibilityLabel="打开 Agent 编排中心"
              >
                <View style={styles.orchestrationEntryIcon}>
                  <Icon name="point.3.connected.trianglepath.dotted" size={19} color={color.accent} />
                </View>
                <View style={styles.orchestrationEntryCopy}>
                  <Text style={styles.orchestrationEntryTitle}>Agent 编排</Text>
                  <Text style={styles.orchestrationEntryDetail}>
                    {conn.supportsManualOrchestration
                      ? "手工创建 Run、任务依赖并指定 worker"
                      : "查看 Run、worker 与人工 Gate"}
                  </Text>
                </View>
                <Icon name="chevron.right" size={13} color={color.textFaint} />
              </Pressable>
            )}
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
              左滑项目可新建 · 左滑会话可{showArchived ? "恢复" : "归档"}或结束
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
                    label: "新会话",
                    symbol: "plus",
                    color: color.accentDim,
                    onPress: () => {
                      setCwd(project.path);
                      setWorkspacePath("");
                      setLaunchIntent("conversation");
                      setGoal("");
                      setSelectedResume(null);
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
                    const done = session.status === "done" || session.status === "died";
                    // 断线时状态只代表上次连接，不能伪装成实时状态。
                    const stale = runtime.status !== "connected";
                    const actions: SwipeAction[] = [
                      {
                        label: showArchived ? "恢复" : "归档",
                        symbol: "archivebox",
                        color: "#766A45",
                        onPress: () => changeArchive(session.id, !showArchived),
                      },
                      {
                        label: "文件",
                        symbol: "doc.on.doc",
                        color: "#3a6ea5",
                        onPress: () => router.push(`/host/${hostId}/files/${session.id}`),
                      },
                      {
                        label: done ? "移除" : "结束",
                        symbol: "trash",
                        color: "#e5534b",
                        onPress: () => conn?.kill(session.id),
                        confirm: {
                          title: done ? `移除「${session.title}」?` : `结束「${session.title}」?`,
                          message: done
                            ? "会话已结束，这会同时删除它的持久化记录。"
                            : "会话进程会被终止，未完成的工作会丢失。归档不会终止会话。",
                          confirmLabel: done ? "移除" : "结束",
                        },
                      },
                    ];
                    return (
                      <SwipeRow key={session.id} actions={actions}>
                        <View>
                        <Pressable
                          style={({ pressed }) => [
                            styles.card,
                            pressed && styles.cardPressed,
                            (session.status === "waiting_approval" ||
                              session.status === "waiting_input") &&
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
                            <Text style={styles.kindTag}>
                              {session.kind === "structured" ? "对话" : "终端"}
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
                            {(session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0) > 0
                              ? `⚠︎ ${String((session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0))} 项待处理`
                              : [
                                  session.agent,
                                  session.accountName,
                                  session.kind === "structured" ? "ChatUI" : "终端",
                                ].filter(Boolean).join(" · ")}
                          </Text>
                        </Pressable>
                        {(session.subagents?.length ?? 0) > 0 && (
                          <View style={styles.childList}>
                            {(session.subagents ?? []).map((child) => {
                              const active = child.status === "running" || child.status === "starting";
                              return (
                                <Pressable
                                  key={child.id}
                                  style={({ pressed }) => [
                                    styles.childRow,
                                    pressed && styles.cardPressed,
                                  ]}
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
                        </View>
                      </SwipeRow>
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
          onClose={() => setPickerOpen(false)}
          onSelect={(selection) => {
            setWorkspacePath(selection.path);
            setCwd(selection.cwd);
            setPickerOpen(false);
          }}
        />
      )}
    </View>
  );
}

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
  const activeRuns = (snapshot?.runs ?? []).filter((run) => run.status === "active");
  if (activeRuns.length === 0) return null;

  return (
    <View style={styles.goalPanel}>
      <View style={styles.goalPanelHeader}>
        <Text style={styles.goalPanelTitle}>Goal 编排</Text>
        <Text style={styles.goalPanelMeta}>{String(activeRuns.length)} 个进行中</Text>
      </View>
      {activeRuns.slice(0, 3).map((run) => {
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  headerBack: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 36 },
  headerBackText: { color: color.accent, fontSize: 15 },
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
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: color.surface,
  },
  filterChipActive: { backgroundColor: color.accentDim },
  filterChipText: { ...font.sub, color: color.textDim },
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
  kindOptionText: { color: color.textDim, fontSize: 13, fontWeight: "500" },
  kindOptionTextActive: { color: color.text, fontWeight: "600" },
  kindHelp: { ...font.meta, marginLeft: 2 },
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
  createBtnText: { color: "#0A0A0C", fontSize: 15, fontWeight: "700" },
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
  orchestrationEntry: {
    padding: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  orchestrationEntryIcon: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: color.accentBg,
  },
  orchestrationEntryCopy: { flex: 1, gap: 3 },
  orchestrationEntryTitle: { ...font.body, fontWeight: "700" },
  orchestrationEntryDetail: { ...font.meta, color: color.textDim },
  goalPanel: {
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  goalPanelHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  goalPanelTitle: { ...font.body, fontWeight: "700" },
  goalPanelMeta: { ...font.meta, color: color.accent },
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
  cardStatus: { fontSize: 12, fontWeight: "600" },
  preview: { ...font.sub, color: color.textDim, lineHeight: 18 },
  cardSub: font.meta,
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
});
