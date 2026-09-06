import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { useFocusEffect } from "expo-router";
import {
  Alert,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { SessionInfo } from "@prospero/protocol";

import { AgentIcon } from "@/components/AgentIcon";
import { Icon } from "@/components/Icon";
import { PromptDialog } from "@/components/PromptDialog";
import { Sheet, SheetAction } from "@/components/Sheet";
import { SwipeRow } from "@/components/SwipeRow";
import type { StoredHost } from "@/lib/hosts";
import {
  compactWorkspacePath,
  homeHostStats,
  homeRecentSessions,
  homeRecentSummary,
  homeWorkspaceProjects,
  partitionHomeProjects,
} from "@/lib/home-dashboard";
import { DismissedModalAction } from "@/lib/host-screen-flow";
import {
  DEFAULT_HOME_SETTINGS,
  normalizeHomeSettings,
  workspaceAliasKey,
  type HomeSettings,
} from "@/lib/home-preferences";
import type { SessionProject } from "@/lib/session-projects";
import type { ConnStatus, HostRuntime } from "@/lib/store";
import { recentSessions as recentSessionStore, recentSessionTime } from "@/lib/recent-sessions";
import {
  font,
  radius,
  space,
  useMobileTheme,
  type ThemePalette,
} from "@/lib/theme";

type HomeDashboardStyles = ReturnType<typeof createStyles>;
const NO_MANAGED_WORKSPACES: readonly string[] = [];

const statusLabel: Record<ConnStatus, string> = {
  idle: "未连接",
  connecting: "连接中…",
  reconnecting: "重连中…",
  connected: "已连接",
  failed: "连接失败",
};

const sessionStatusLabel: Record<SessionInfo["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting_approval: "待审批",
  waiting_input: "待回答",
  idle: "空闲",
  completed: "已完成",
  done: "已结束",
  died: "已退出",
};

function hostDetail(host: StoredHost, runtime: HostRuntime | undefined): string {
  const status = runtime?.status ?? "idle";
  const path =
    runtime?.activePath === "relay"
      ? "中继"
      : runtime?.activePath === "direct"
        ? "直连"
        : null;
  return [
    statusLabel[status],
    path,
    host.addrs.length > 1 ? `${String(host.addrs.length)} 条线路` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function workspaceDetail(project: SessionProject): string {
  if (project.pendingCount > 0) return `${String(project.pendingCount)} 项待处理`;
  if (project.runningCount > 0) return `${String(project.runningCount)} 个会话运行中`;
  return `${String(project.sessions.length)} 个会话`;
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "工作区";
}

function recentTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${time}`;
}

function statusTone(status: string, palette: ThemePalette): string {
  if (status === "running" || status === "starting" || status === "waiting_approval") {
    return palette.warn;
  }
  if (status === "waiting_input" || status === "idle") return palette.accent;
  if (status === "completed" || status === "connected") return palette.success;
  if (status === "died" || status === "failed") return palette.danger;
  if (status === "connecting" || status === "reconnecting") return palette.warn;
  return palette.textFaint;
}

function hostConnectionTone(runtime: HostRuntime | undefined, palette: ThemePalette): string {
  const status = runtime?.status ?? "idle";
  if (status === "connected") {
    return runtime?.rttMs !== null && runtime?.rttMs !== undefined && runtime.rttMs >= 300
      ? palette.warn
      : palette.success;
  }
  if (status === "connecting" || status === "reconnecting") return palette.warn;
  return palette.danger;
}

function hostConnectionLabel(runtime: HostRuntime | undefined): string {
  const status = runtime?.status ?? "idle";
  if (status === "connected") {
    return runtime?.rttMs !== null && runtime?.rttMs !== undefined
      ? `${String(runtime.rttMs)}ms`
      : "在线";
  }
  if (status === "connecting") return "连接中";
  if (status === "reconnecting") return "重连中";
  if (status === "failed") return "失败";
  return "离线";
}

function HostPlatformIcon({
  platform,
  palette,
}: {
  platform: string | undefined;
  palette: ThemePalette;
}) {
  const normalized = platform?.toLowerCase() ?? "";
  const brand = normalized === "win32" || normalized.includes("windows")
    ? "windows"
    : normalized === "darwin" || normalized.includes("mac")
      ? "apple"
      : normalized.includes("linux")
        ? "linux"
        : null;

  return brand ? (
    <FontAwesome6
      name={brand}
      size={18}
      color={brand === "linux" ? palette.warn : palette.accent}
    />
  ) : (
    <Icon name="desktopcomputer" size={18} color={palette.accent} />
  );
}

export function HomeDashboard({
  hosts,
  runtimes,
  selectedHostId,
  devicePickerOpen,
  bottomInset,
  onToggleDevicePicker,
  onCloseDevicePicker,
  onSelectHost,
  onOpenHost,
  onOpenSession,
  onEditHost,
  onDeleteHost,
  onAddHost,
  onRefreshHost,
  onCreateSession,
  onCreateDirectory,
  homeSettings,
  onChangeHomeSettings,
  managedWorkspacePaths = NO_MANAGED_WORKSPACES,
}: {
  hosts: StoredHost[];
  runtimes: Record<string, HostRuntime>;
  selectedHostId: string | null;
  devicePickerOpen: boolean;
  bottomInset: number;
  onToggleDevicePicker: () => void;
  onCloseDevicePicker: () => void;
  onSelectHost: (hostId: string) => void;
  onOpenHost: (hostId: string) => void;
  onOpenSession: (hostId: string, sessionId: string) => void;
  onEditHost: (hostId: string) => void;
  onDeleteHost: (host: StoredHost) => void;
  onAddHost: () => void;
  onRefreshHost: (hostId: string) => void;
  onCreateSession: (hostId: string, cwd?: string) => void;
  onCreateDirectory: (hostId: string) => void;
  homeSettings?: HomeSettings;
  onChangeHomeSettings: (patch: Partial<HomeSettings>) => void;
  managedWorkspacePaths?: readonly string[];
}) {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const { width: windowWidth } = useWindowDimensions();
  const compactWorkspaceActions = windowWidth < 390;
  const recentCardWidth = Math.min(232, Math.max(196, windowWidth - 72));
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? hosts[0];
  const selectedRuntime = selectedHost ? runtimes[selectedHost.id] : undefined;
  const recentUsage = useSyncExternalStore(
    recentSessionStore.subscribe,
    () => recentSessionStore.getHost(selectedHost?.id),
    () => recentSessionStore.getHost(selectedHost?.id),
  );
  useEffect(() => { void recentSessionStore.load(); }, []);
  // Fast Refresh 会保留旧版 Zustand 状态；标准化可补全后续新增的设置字段。
  const effectiveHomeSettings = normalizeHomeSettings(homeSettings ?? DEFAULT_HOME_SETTINGS);
  const allProjects = useMemo(
    () => homeWorkspaceProjects(selectedRuntime?.sessions),
    [selectedRuntime?.sessions],
  );
  const { projects, taskProjects } = useMemo(
    () => partitionHomeProjects(allProjects, managedWorkspacePaths),
    [allProjects, managedWorkspacePaths],
  );
  const stats = useMemo(
    () => homeHostStats(selectedRuntime?.sessions),
    [selectedRuntime?.sessions],
  );
  const recentSessions = useMemo(
    () => homeRecentSessions(selectedRuntime?.sessions, effectiveHomeSettings.recentSessionLimit, recentUsage),
    [effectiveHomeSettings.recentSessionLimit, selectedRuntime?.sessions, recentUsage],
  );
  const [expandedProjectKey, setExpandedProjectKey] = useState<string | null>(null);
  const [expandedTaskHostId, setExpandedTaskHostId] = useState<string | null>(null);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<SessionProject | null>(null);
  const [projectAlias, setProjectAlias] = useState("");
  const [deviceNavigation] = useState(() => new DismissedModalAction());
  const [createNavigation] = useState(() => new DismissedModalAction());
  const closeDevicePickerRef = useRef(onCloseDevicePicker);
  useEffect(() => {
    closeDevicePickerRef.current = onCloseDevicePicker;
  }, [onCloseDevicePicker]);

  // Keep this callback independent of sheet state and parent callback identities:
  // a normal close must leave its deferred route alive until native onDismiss.
  const cancelOverlays = useCallback(() => {
    deviceNavigation.cancel();
    createNavigation.cancel();
    closeDevicePickerRef.current();
    setQuickCreateOpen(false);
    setEditingProject(null);
  }, [createNavigation, deviceNavigation]);
  useFocusEffect(useCallback(() => cancelOverlays, [cancelOverlays]));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") cancelOverlays();
    });
    return () => subscription.remove();
  }, [cancelOverlays]);
  useEffect(() => {
    if (devicePickerOpen) deviceNavigation.cancel();
  }, [deviceNavigation, devicePickerOpen]);
  const refreshing =
    selectedRuntime?.status === "connecting" || selectedRuntime?.status === "reconnecting";

  if (!selectedHost) return null;

  const displayProjectName = (path: string, fallback: string): string =>
    effectiveHomeSettings.workspaceAliases[workspaceAliasKey(selectedHost.id, path)] ?? fallback;
  const taskProjectsExpanded = expandedTaskHostId === selectedHost.id;
  const taskRunningCount = taskProjects.reduce((total, project) => total + project.runningCount, 0);
  const taskPendingCount = taskProjects.reduce((total, project) => total + project.pendingCount, 0);

  const renderProject = (project: SessionProject) => {
    const projectKey = `${selectedHost.id}:${project.path}`;
    const expanded = expandedProjectKey === projectKey;
    const displayName = displayProjectName(project.path, project.name);
    return (
      <View
        key={projectKey}
        collapsable={false}
        style={[styles.projectCard, expanded && styles.projectCardExpanded]}
      >
        <SwipeRow
          clipRadius={radius.md}
          actions={[
            {
              id: "create-session",
              label: "新会话",
              symbol: "plus",
              color: palette.accent,
              foregroundColor: palette.onAccent,
              onPress: () => onCreateSession(selectedHost.id, project.path),
            },
            {
              id: "edit-workspace",
              label: "编辑",
              symbol: "pencil",
              color: palette.surfaceRaised,
              foregroundColor: palette.text,
              onPress: () => {
                setEditingProject(project);
                setProjectAlias(displayName);
              },
            },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`${displayName}，${workspaceDetail(project)}`}
            accessibilityHint={`${expanded ? "收起这个目录的会话" : "展开这个目录的会话"}；左滑可新建会话或编辑名称`}
            onPress={() => setExpandedProjectKey(expanded ? null : projectKey)}
            style={({ pressed }) => [styles.projectHeader, pressed && styles.projectCardPressed]}
          >
            <View style={styles.projectIcon}>
              <Icon name="folder.fill" size={18} color={palette.accent} />
            </View>
            <View style={styles.projectCopy}>
              <Text style={styles.projectName} numberOfLines={1}>
                {displayName}
              </Text>
              <Text
                style={styles.projectPath}
                numberOfLines={expanded ? undefined : 1}
                ellipsizeMode="middle"
              >
                {expanded ? project.path : compactWorkspacePath(project.path)}
              </Text>
            </View>
            <View style={styles.projectMeta}>
              <Text
                style={[
                  styles.projectState,
                  project.pendingCount > 0
                    ? styles.projectPending
                    : project.runningCount > 0
                      ? styles.projectRunning
                      : undefined,
                ]}
              >
                {workspaceDetail(project)}
              </Text>
              <Icon
                name={expanded ? "chevron.down" : "chevron.right"}
                size={15}
                color={palette.textFaint}
              />
            </View>
          </Pressable>
        </SwipeRow>

        {expanded && (
          <View style={styles.sessionList}>
            {project.sessions.map((session) => (
              <Pressable
                key={session.id}
                accessibilityRole="button"
                accessibilityLabel={`打开会话 ${session.title}，${sessionStatusLabel[session.status]}`}
                onPress={() => onOpenSession(selectedHost.id, session.id)}
                style={({ pressed }) => [
                  styles.sessionRow,
                  pressed && styles.sessionRowPressed,
                ]}
              >
                <AgentIcon agent={session.agent} size={17} badge />
                <View style={styles.sessionCopy}>
                  <Text style={styles.sessionTitle} numberOfLines={1}>
                    {session.title || session.agent}
                  </Text>
                  <Text style={styles.sessionPreview} numberOfLines={1}>
                    {session.preview?.trim() || `${session.agent} · ${session.kind}`}
                  </Text>
                </View>
                <View style={styles.sessionState}>
                  <View
                    style={[
                      styles.sessionStatusDot,
                      { backgroundColor: statusTone(session.status, palette) },
                    ]}
                  />
                  <Text style={styles.sessionStatusText}>
                    {sessionStatusLabel[session.status]}
                  </Text>
                </View>
                <Icon name="chevron.right" size={14} color={palette.textFaint} />
              </Pressable>
            ))}
          </View>
        )}
      </View>
    );
  };

  return (
    <>
      <FlatList
      key={selectedHost.id}
      testID="home-workspace-list"
      data={projects}
      extraData={expandedProjectKey}
      keyExtractor={(project) => project.path}
      // Android/Fabric 会缓存动态高度 cell 的裁剪边界；目录反复展开后文字会被
      // 当成仍在旧边界之外而消失。首页项目量有限，关闭裁剪换取稳定的重排。
      removeClippedSubviews={false}
      contentContainerStyle={[styles.list, { paddingBottom: bottomInset + space.xl }]}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => onRefreshHost(selectedHost.id)}
          tintColor={palette.accent}
        />
      }
      ListHeaderComponent={
        <View style={styles.headerContent}>
          <View style={styles.devicePanel}>
            <View style={styles.deviceSelector}>
              <View style={styles.sectionIcon}>
                <HostPlatformIcon
                  platform={selectedRuntime?.hostInfo?.platform}
                  palette={palette}
                />
              </View>
              <View style={styles.deviceHeaderCopy}>
                <Text style={styles.deviceHeaderName} numberOfLines={1}>
                  {selectedHost.name}
                </Text>
                <Text style={styles.deviceMeta} numberOfLines={1}>
                  {`${String(stats.sessionCount)} 个会话 · ${String(stats.runningCount)} 个运行中`}
                </Text>
              </View>
              <View style={styles.deviceSelectorEnd}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: devicePickerOpen }}
                  accessibilityLabel={`选择设备，${String(hosts.length)} 台已配对，当前为 ${selectedHost.name}，${hostConnectionLabel(selectedRuntime)}`}
                  accessibilityHint="从屏幕底部打开设备列表"
                  style={({ pressed }) => [
                    styles.deviceFleetPill,
                    pressed && styles.deviceFleetPillPressed,
                  ]}
                  onPress={() => {
                    deviceNavigation.cancel();
                    onToggleDevicePicker();
                  }}
                >
                  <Icon name="desktopcomputer" size={14} color={palette.textDim} />
                  <Text style={styles.deviceFleetCount}>{String(hosts.length)}</Text>
                  <Icon name="chevron.down" size={14} color={palette.textFaint} />
                </Pressable>
              </View>
            </View>
            <View style={styles.deviceConnection}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: hostConnectionTone(selectedRuntime, palette) },
                ]}
              />
              <Text style={styles.deviceConnectionText} numberOfLines={1}>
                {hostDetail(selectedHost, selectedRuntime)}
                {selectedRuntime?.status === "connected" && selectedRuntime.rttMs != null
                  ? ` · ${hostConnectionLabel(selectedRuntime)}`
                  : ""}
              </Text>
            </View>
          </View>

          <View style={styles.recentSection}>
            <View style={styles.sectionHeading}>
              <View>
                <Text style={styles.sectionTitle}>最近对话</Text>
                <Text style={styles.sectionSubtitle}>
                  最近 {String(effectiveHomeSettings.recentSessionLimit)} 条
                </Text>
              </View>
            </View>
            {recentSessions.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.recentList}
              >
                {recentSessions.map((session) => (
                  <Pressable
                    key={session.id}
                    accessibilityRole="button"
                    accessibilityLabel={`打开最近对话 ${session.title || session.agent}，${homeRecentSummary(session, recentUsage[session.id])}`}
                    onPress={() => onOpenSession(selectedHost.id, session.id)}
                    style={({ pressed }) => [
                      styles.recentCard,
                      { width: recentCardWidth },
                      pressed && styles.recentCardPressed,
                    ]}
                  >
                    <AgentIcon agent={session.agent} size={18} badge />
                    <View style={styles.recentCopy}>
                      <Text style={styles.recentTitle} numberOfLines={1}>
                        {session.title || session.agent}
                      </Text>
                      <Text style={styles.recentPreview} numberOfLines={2}>
                        {homeRecentSummary(session, recentUsage[session.id])}
                      </Text>
                      <Text style={styles.recentMeta} numberOfLines={1}>
                        {displayProjectName(session.cwd, projectName(session.cwd))} · {recentTime(recentSessionTime(session, recentUsage[session.id]))}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.sessionStatusDot,
                        { backgroundColor: statusTone(session.status, palette) },
                      ]}
                    />
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.recentEmpty}>创建或打开对话后，会显示在这里。</Text>
            )}
          </View>

          <View style={styles.workspaceSection}>
            <View style={styles.workspaceHeading}>
              <View style={styles.workspaceHeadingCopy}>
                <Text style={styles.workspaceTitle}>工作目录</Text>
                <Text style={styles.workspaceSubtitle} numberOfLines={1}>
                  点按展开 · 左滑操作
                </Text>
              </View>
              <View style={styles.workspaceActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`打开 ${selectedHost.name} 详情`}
                  onPress={() => onOpenHost(selectedHost.id)}
                  style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                >
                  <Icon name="ellipsis.circle" size={18} color={palette.textDim} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="新建对话或目录"
                  onPress={() => {
                    createNavigation.cancel();
                    setQuickCreateOpen(true);
                  }}
                  style={({ pressed }) => [
                    styles.createButton,
                    compactWorkspaceActions && styles.createButtonCompact,
                    pressed && styles.createButtonPressed,
                  ]}
                >
                  <Icon name="plus" size={16} color={palette.text} weight="semibold" />
                  {!compactWorkspaceActions && <Text style={styles.createButtonText}>新建</Text>}
                </Pressable>
              </View>
            </View>

          </View>
        </View>
      }
      ListEmptyComponent={taskProjects.length === 0 ? (
        <WorkspaceEmptyState
          host={selectedHost}
          runtime={selectedRuntime}
          onOpenHost={() => onOpenHost(selectedHost.id)}
          onRefresh={() => onRefreshHost(selectedHost.id)}
          palette={palette}
          styles={styles}
        />
      ) : null}
      ItemSeparatorComponent={() => <View style={styles.projectGap} />}
      renderItem={({ item }) => renderProject(item)}
      ListFooterComponent={taskProjects.length > 0 ? (
        <View style={styles.taskSection}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: taskProjectsExpanded }}
            accessibilityLabel={`任务工作区，${String(taskProjects.length)} 个目录，${String(taskRunningCount)} 个运行中，${String(taskPendingCount)} 项待处理`}
            accessibilityHint={taskProjectsExpanded ? "收起任务目录" : "展开后可进入会话或左滑操作"}
            onPress={() => setExpandedTaskHostId(taskProjectsExpanded ? null : selectedHost.id)}
            style={({ pressed }) => [styles.taskHeading, pressed && styles.pressed]}
          >
            <View style={styles.taskHeadingCopy}>
              <Text style={styles.taskTitle}>任务工作区 · {String(taskProjects.length)}</Text>
              <Text style={[styles.taskSummary, taskPendingCount > 0 && styles.projectPending]}>
                {`${String(taskRunningCount)} 个运行中 · ${String(taskPendingCount)} 项待处理`}
              </Text>
            </View>
            <Icon
              name={taskProjectsExpanded ? "chevron.down" : "chevron.right"}
              size={15}
              color={palette.textFaint}
            />
          </Pressable>
          {taskProjectsExpanded && (
            <View style={styles.taskProjects}>{taskProjects.map(renderProject)}</View>
          )}
        </View>
      ) : null}
      />

      <Sheet
        visible={devicePickerOpen}
        title="设备"
        onClose={() => {
          deviceNavigation.cancel();
          onCloseDevicePicker();
        }}
        onDismiss={() => deviceNavigation.dismiss()}
      >
        <View style={styles.deviceList}>
          {hosts.map((host) => {
            const runtime = runtimes[host.id];
            const selected = host.id === selectedHost.id;
            return (
              <View key={host.id} style={[styles.deviceManageRow, selected && styles.deviceRowSelected]}>
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${host.name}，${hostDetail(host, runtime)}`}
                  onPress={() => {
                    deviceNavigation.cancel();
                    onSelectHost(host.id);
                  }}
                  style={({ pressed }) => [
                    styles.deviceRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: hostConnectionTone(runtime, palette) },
                    ]}
                  />
                  <View style={styles.deviceRowCopy}>
                    <Text style={styles.deviceRowName} numberOfLines={1}>
                      {host.name}
                    </Text>
                    <Text style={styles.deviceRowDetail} numberOfLines={1}>
                      {hostDetail(host, runtime)}
                    </Text>
                  </View>
                  {selected && <Icon name="checkmark.circle.fill" size={18} color={palette.accent} />}
                </Pressable>
                <View style={styles.deviceRowActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`编辑 ${host.name}`}
                    onPress={() => {
                      deviceNavigation.defer(() => onEditHost(host.id));
                      onCloseDevicePicker();
                    }}
                    style={({ pressed }) => [styles.deviceAction, pressed && styles.pressed]}
                  >
                    <Icon name="pencil" size={17} color={palette.textDim} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`删除 ${host.name}`}
                    onPress={() =>
                      Alert.alert(
                        `移除「${host.name}」的配对？`,
                        "凭证会从这台手机删除，再次使用需要重新扫码配对。",
                        [
                          { text: "取消", style: "cancel" },
                          { text: "删除", style: "destructive", onPress: () => onDeleteHost(host) },
                        ],
                      )
                    }
                    style={({ pressed }) => [styles.deviceAction, pressed && styles.dangerPressed]}
                  >
                    <Icon name="trash" size={17} color={palette.danger} />
                  </Pressable>
                </View>
              </View>
            );
          })}
          <View style={styles.deviceSheetDivider} />
          <SheetAction
            label="添加设备"
            detail="扫描电脑上的 Prospero 配对二维码"
            symbol="qrcode.viewfinder"
            onPress={() => {
              deviceNavigation.defer(onAddHost);
              onCloseDevicePicker();
            }}
          />
        </View>
      </Sheet>

      <Sheet
        visible={quickCreateOpen}
        title="新建"
        onClose={() => {
          createNavigation.cancel();
          setQuickCreateOpen(false);
        }}
        onDismiss={() => createNavigation.dismiss()}
      >
        <SheetAction
          label="新建对话"
          detail={`在 ${selectedHost.name} 选择工作目录并启动 Agent`}
          symbol="bubble.left.and.text.bubble.right"
          onPress={() => {
            createNavigation.defer(() => onCreateSession(selectedHost.id));
            setQuickCreateOpen(false);
          }}
        />
        <SheetAction
          label="新建目录"
          detail="浏览电脑目录，并可在任意位置创建文件夹"
          symbol="folder.fill"
          onPress={() => {
            createNavigation.defer(() => onCreateDirectory(selectedHost.id));
            setQuickCreateOpen(false);
          }}
        />
      </Sheet>

      <PromptDialog
        visible={editingProject !== null}
        title="编辑工作区名称"
        message="只修改这台手机上的显示名称，不会移动电脑目录或更改已有会话。清空可恢复目录原名。"
        value={projectAlias}
        confirmLabel="保存"
        onChangeText={setProjectAlias}
        onCancel={() => setEditingProject(null)}
        validate={(value) => (value.trim().length > 60 ? "名称不能超过 60 个字符" : null)}
        onSubmit={(value) => {
          if (!editingProject) return;
          const key = workspaceAliasKey(selectedHost.id, editingProject.path);
          const nextAliases = { ...effectiveHomeSettings.workspaceAliases };
          const alias = value.trim();
          if (alias === "" || alias === editingProject.name) delete nextAliases[key];
          else nextAliases[key] = alias;
          onChangeHomeSettings({ workspaceAliases: nextAliases });
          setEditingProject(null);
        }}
      />
    </>
  );
}

function WorkspaceEmptyState({
  host,
  runtime,
  onOpenHost,
  onRefresh,
  palette,
  styles,
}: {
  host: StoredHost;
  runtime: HostRuntime | undefined;
  onOpenHost: () => void;
  onRefresh: () => void;
  palette: ThemePalette;
  styles: HomeDashboardStyles;
}) {
  const status = runtime?.status ?? "idle";
  const unavailable = status === "failed" || status === "idle";
  return (
    <View style={styles.workspaceEmpty}>
      <View style={styles.emptyIcon}>
        <Icon
          name={unavailable ? "exclamationmark.triangle.fill" : "folder.fill"}
          size={25}
          color={unavailable ? palette.warn : palette.textFaint}
        />
      </View>
      <Text style={styles.emptyTitle}>
        {status === "connecting" || status === "reconnecting"
          ? `正在读取 ${host.name}`
          : unavailable
            ? "暂时无法读取工作目录"
            : "还没有工作目录"}
      </Text>
      <Text style={styles.emptyDetail}>
        {status === "failed"
          ? (runtime?.lastError ?? "设备连接失败，请检查网络后重试。")
          : status === "idle"
            ? "连接设备后，这里会按会话所在目录自动整理项目。"
            : status === "connecting" || status === "reconnecting"
              ? "建立连接后会自动同步已有会话和目录。"
              : "在设备中选择一个目录并创建会话后，它会出现在这里。"}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={unavailable ? onRefresh : onOpenHost}
        style={({ pressed }) => [styles.emptyAction, pressed && styles.emptyActionPressed]}
      >
        <Text style={styles.emptyActionText}>{unavailable ? "重新连接" : "打开设备"}</Text>
      </Pressable>
    </View>
  );
}

function createStyles(palette: ThemePalette) {
  const themedFont = {
    title: { ...font.title, color: palette.text },
    body: { ...font.body, color: palette.text },
    sub: { ...font.sub, color: palette.textDim },
    meta: { ...font.meta, color: palette.textFaint },
  };
  return StyleSheet.create({
  list: {
    flexGrow: 1,
    width: "100%",
    maxWidth: 840,
    alignSelf: "center",
    paddingHorizontal: space.lg,
  },
  headerContent: { gap: space.lg, paddingTop: space.sm, paddingBottom: space.md },
  devicePanel: {
    overflow: "hidden",
    borderRadius: radius.md,
    backgroundColor: palette.surface,
  },
  deviceSelector: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  sectionIcon: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: palette.accentBg,
  },
  deviceHeaderCopy: { flex: 1, minWidth: 0, gap: 3 },
  deviceHeaderName: { ...themedFont.body, fontSize: 15, fontWeight: "700" },
  deviceMeta: { color: palette.textDim, fontSize: 11 },
  deviceSelectorEnd: { flexShrink: 0, alignItems: "flex-end", justifyContent: "center" },
  deviceConnection: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
  },
  deviceConnectionText: { flex: 1, minWidth: 0, color: palette.textDim, fontSize: 11 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  deviceFleetPill: {
    minHeight: 44,
    minWidth: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    borderRadius: 999,
    backgroundColor: palette.surfaceRaised,
  },
  deviceFleetPillPressed: { backgroundColor: palette.pressed },
  deviceFleetCount: {
    color: palette.textDim,
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  deviceList: {
    gap: 2,
    paddingBottom: space.lg,
  },
  deviceManageRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.sm,
  },
  deviceRow: {
    minHeight: 58,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
  },
  deviceRowSelected: { backgroundColor: palette.accentBg },
  deviceRowCopy: { flex: 1, minWidth: 0, gap: 2 },
  deviceRowName: { ...themedFont.body, fontWeight: "600" },
  deviceRowDetail: themedFont.meta,
  deviceRowActions: { flexDirection: "row", alignItems: "center", paddingRight: space.xs },
  deviceAction: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  dangerPressed: { backgroundColor: palette.dangerBg },
  deviceSheetDivider: {
    height: StyleSheet.hairlineWidth,
    marginTop: space.sm,
    backgroundColor: palette.border,
  },
  pressed: { backgroundColor: palette.pressed },
  recentSection: { gap: space.sm },
  sectionHeading: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: { ...themedFont.title, fontSize: 17 },
  sectionSubtitle: { color: palette.textDim, fontSize: 10, marginTop: 1 },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  recentList: { gap: space.sm, paddingRight: space.lg },
  recentCard: {
    width: 232,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
  },
  recentCardPressed: { backgroundColor: palette.pressed },
  recentCopy: { flex: 1, minWidth: 0, gap: 3 },
  recentTitle: { ...themedFont.body, fontSize: 13, fontWeight: "600" },
  recentPreview: { color: palette.textDim, fontSize: 12, lineHeight: 17 },
  recentMeta: { color: palette.textDim, fontSize: 10.5 },
  recentEmpty: {
    ...themedFont.meta,
    paddingVertical: space.sm,
    color: palette.textDim,
  },
  workspaceSection: { gap: space.md },
  workspaceHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  workspaceHeadingCopy: { flex: 1, minWidth: 0 },
  workspaceTitle: { ...themedFont.title, fontSize: 19 },
  workspaceSubtitle: { ...themedFont.meta, marginTop: 3 },
  workspaceActions: { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: space.xs },
  createButton: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: palette.accentDim,
  },
  createButtonCompact: {
    width: 44,
    paddingHorizontal: 0,
  },
  createButtonPressed: { opacity: 0.8 },
  createButtonText: { color: palette.text, fontSize: 12, fontWeight: "700" },
  taskSection: { paddingTop: space.lg, gap: space.sm },
  taskHeading: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
  },
  taskHeadingCopy: { flex: 1, minWidth: 0, gap: 3 },
  taskTitle: { ...themedFont.body, fontSize: 14, fontWeight: "600" },
  taskSummary: { ...themedFont.meta, color: palette.textDim },
  taskProjects: { gap: space.sm },
  projectGap: { height: space.sm },
  projectCard: {
    minHeight: 64,
    borderRadius: radius.md,
    backgroundColor: palette.surface,
  },
  projectCardExpanded: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.accentDim,
  },
  projectHeader: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    backgroundColor: palette.surface,
  },
  // 不依赖父层 overflow 裁剪：它在 Android/Fabric 动态高度列表中会再次造成文字消失。
  projectCardPressed: { borderRadius: radius.md, backgroundColor: palette.pressed },
  projectIcon: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: palette.accentBg,
  },
  projectCopy: { flex: 1, minWidth: 0, gap: 2 },
  projectName: { ...themedFont.body, fontSize: 15, fontWeight: "700" },
  projectPath: { ...themedFont.meta, color: palette.textDim },
  projectMeta: { alignItems: "flex-end", gap: space.sm, maxWidth: 112 },
  projectState: { ...themedFont.meta, textAlign: "right" },
  projectPending: { color: palette.warn, fontWeight: "600" },
  projectRunning: { color: palette.success, fontWeight: "600" },
  sessionList: {
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
  },
  sessionRow: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
  },
  sessionRowPressed: { backgroundColor: palette.pressed },
  sessionCopy: { flex: 1, minWidth: 0, gap: 3 },
  sessionTitle: { ...themedFont.body, fontSize: 14, fontWeight: "600" },
  sessionPreview: { ...themedFont.meta, color: palette.textDim },
  sessionState: { flexDirection: "row", alignItems: "center", gap: 5 },
  sessionStatusDot: { width: 6, height: 6, borderRadius: 3 },
  sessionStatusText: { ...themedFont.meta, color: palette.textDim },
  workspaceEmpty: {
    flex: 1,
    minHeight: 270,
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.xl,
    borderRadius: radius.lg,
    backgroundColor: palette.surface,
  },
  emptyIcon: {
    width: 54,
    height: 54,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.lg,
    backgroundColor: palette.surfaceRaised,
  },
  emptyTitle: { ...themedFont.title, fontSize: 17, textAlign: "center" },
  emptyDetail: { ...themedFont.sub, maxWidth: 360, lineHeight: 19, textAlign: "center" },
  emptyAction: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
    backgroundColor: palette.accentBg,
  },
  emptyActionPressed: { backgroundColor: palette.pressed },
  emptyActionText: { color: palette.accent, fontSize: 14, fontWeight: "600" },
  });
}
