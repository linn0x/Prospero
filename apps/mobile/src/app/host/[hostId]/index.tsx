import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
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
import type { AgentKind, SessionInfo, SessionKind, SubagentStatus } from "@prospero/protocol";
import { AgentIcon } from "@/components/AgentIcon";
import { HostSummary } from "@/components/HostSummary";
import { Icon } from "@/components/Icon";
import { SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { WorkspacePicker } from "@/components/WorkspacePicker";
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

const statusLabel: Record<SessionInfo["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting_approval: "待审批",
  waiting_input: "待回答",
  idle: "就绪",
  done: "已完成",
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

export default function HostScreen() {
  const { hostId, create, cmd } = useLocalSearchParams<{
    hostId: string;
    create?: string;
    cmd?: string;
  }>();
  const { host, conn, runtime } = useHostConnection(hostId);
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [sessionKind, setSessionKind] = useState<SessionKind>("structured");
  const [cwd, setCwd] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | AgentKind>("all");
  const [composing, setComposing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(() => new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const pendingCreateRef = useRef(false);
  const deepLinkCreateRef = useRef<string | null>(null);
  const insets = useSafeAreaInsets();

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
    pendingCreateRef.current = true;
    conn.createSession(
      agent,
      cwd.trim() || undefined,
      undefined,
      STRUCTURED.includes(agent) ? sessionKind : "pty",
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
              <Pressable onPress={() => setComposing(false)} hitSlop={8}>
                <Text style={styles.headerCancel}>取消</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => setComposing(true)} hitSlop={8}>
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
        <View style={styles.newBox}>
          <Text style={styles.formLabel}>运行方式</Text>
          <View style={styles.chips}>
            {AGENTS.map((a) => (
              <Pressable
                key={a}
                onPress={() => {
                  setAgent(a);
                  setSessionKind(STRUCTURED.includes(a) ? "structured" : "pty");
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
                  onPress={() => setSessionKind("pty")}
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
          <Text style={[styles.formLabel, styles.cwdLabel]}>项目目录</Text>
          <View style={styles.cwdRow}>
            {/* 输入框必须放在有确定高度的横向容器里。之前外层是默认纵向布局，
                TextInput 却用了 flex:1，iOS 会把可编辑区域压到几乎 0 高。 */}
            <View style={styles.cwdField}>
              <Icon name="folder.fill" size={16} color={color.textDim} />
              <TextInput
                style={styles.cwdInput}
                placeholder="选择目录；同目录的会话归为一个项目"
                placeholderTextColor={color.textFaint}
                selectionColor={color.accent}
                value={cwd}
                onChangeText={(value) => {
                  setCwd(value);
                  setWorkspacePath("");
                }}
                onSubmitEditing={submitCreate}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                clearButtonMode="while-editing"
                keyboardAppearance="dark"
                returnKeyType="done"
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
          </View>
          <Text style={styles.cwdHelp}>
            {workspacePath === ""
              ? "一个目录就是一个项目；可输入完整路径或浏览选择"
              : `项目目录：~/${workspacePath}`}
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.createBtn,
              runtime.status !== "connected" && styles.btnDisabled,
              pressed && styles.createBtnPressed,
            ]}
            disabled={runtime.status !== "connected"}
            onPress={submitCreate}
          >
            <Text style={styles.createBtnText}>新建会话</Text>
          </Pressable>
        </View>
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

      <FlatList
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
          <HostSummary
            info={runtime.hostInfo}
            conn={conn}
            connected={runtime.status === "connected"}
            rttMs={runtime.rttMs}
            sessionCount={currentSessions.length}
            runningCount={runningCount}
          />
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
                              : `${session.agent} · ${session.kind === "structured" ? "ChatUI" : "终端"}`}
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
      />
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
  newBox: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  formLabel: { ...font.meta, color: color.textDim, fontWeight: "600" },
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
  list: { padding: space.lg, gap: space.md },
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
