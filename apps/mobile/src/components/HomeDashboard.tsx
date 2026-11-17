import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { useFocusEffect } from "expo-router";
import {
  AccessibilityInfo,
  Alert,
  Animated,
  AppState,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { OrchestrationWorktreeAsset, SessionInfo } from "@prospero/protocol";

import { AgentIcon } from "@/components/AgentIcon";
import { Icon } from "@/components/Icon";
import { PromptDialog } from "@/components/PromptDialog";
import { Sheet, SheetAction } from "@/components/Sheet";
import { SplitPaneDivider } from "@/components/SplitPaneDivider";
import { SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { WorkspaceHeader } from "@/components/WorkspaceHeader";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { useOrderedWorkspaces } from "@/lib/workspace-order-preferences";
import { WorkspaceDisclosure, WorkspaceFolderIcon, WorkspaceChevron } from "@/components/WorkspaceDisclosure";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import type { HostConnection } from "@/lib/connection";
import type { StoredHost } from "@/lib/hosts";
import {
  homeHostStats,
  homeRecentSessions,
  homeRecentSummary,
  homeWorkspaceProjects,
} from "@/lib/home-dashboard";
import { DismissedModalAction } from "@/lib/host-screen-flow";
import {
  DEFAULT_HOME_SETTINGS,
  normalizeHomeSettings,
  workspaceAliasKey,
  type HomeSettings,
} from "@/lib/home-preferences";
import {
  completionBaselineHostKey,
  sessionNeedsLocatorMotion,
  useSessionAttention,
} from "@/lib/session-attention";
import { projectName, type SessionProject } from "@/lib/session-projects";
import { supportsRemoteTerminal } from "@/lib/terminal-session";
import type { ConnStatus, HostRuntime } from "@/lib/store";
import { recentSessions as recentSessionStore, recentSessionTime } from "@/lib/recent-sessions";
import { useHomeLocatorMotion } from "@/lib/use-home-locator-motion";
import {
  buildAlignedWorkspaceTree,
  desktopSidebarSessionLabel,
  filterMobileSessionsByQuery,
  homeInboxSessions,
  inboxReasonLabel,
  sortWorkspaceSessions,
  useHydratedWorkspaceConcepts,
  workspacePathKey,
} from "@/lib/workspace-concepts";
import {
  font,
  radius,
  space,
  useMobileTheme,
  type ThemePalette,
} from "@/lib/theme";

type HomeDashboardStyles = ReturnType<typeof createStyles>;
const NO_MANAGED_WORKSPACES: readonly string[] = [];
const NO_WORKTREE_ASSETS: readonly OrchestrationWorktreeAsset[] = [];

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
  waiting_approval: "需要授权",
  waiting_input: "需要输入",
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

function workspaceDetail(project: SessionProject, childTaskCount = 0): string {
  if (project.pendingCount > 0) return `${String(project.pendingCount)} 项待处理`;
  if (project.runningCount > 0) return `${String(project.runningCount)} 个运行中`;
  if (childTaskCount > 0 && project.sessions.length === 0) {
    return `${String(childTaskCount)} 个任务工作区`;
  }
  return `${String(project.sessions.length)} 个会话`;
}

function recentTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return time;
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${time}`;
}

function statusTone(status: string, palette: ThemePalette): string {
  if (status === "running" || status === "starting" || status === "completed" || status === "connected") {
    return palette.success;
  }
  if (status === "waiting_approval" || status === "connecting" || status === "reconnecting") {
    return palette.warn;
  }
  if (status === "waiting_input") return palette.accent;
  if (status === "died" || status === "failed") return palette.danger;
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
      size={15}
      color={palette.text}
    />
  ) : (
    <Icon name="desktopcomputer" size={15} color={palette.text} />
  );
}

export function HomeDashboard({
  hosts,
  runtimes,
  selectedHostId,
  connection = null,
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
  onOpenTerminals,
  homeSettings,
  onChangeHomeSettings,
  managedWorkspacePaths = NO_MANAGED_WORKSPACES,
  worktreeAssets = NO_WORKTREE_ASSETS,
}: {
  hosts: StoredHost[];
  runtimes: Record<string, HostRuntime>;
  selectedHostId: string | null;
  connection?: HostConnection | null;
  devicePickerOpen: boolean;
  bottomInset: number;
  onToggleDevicePicker: () => void;
  onCloseDevicePicker: () => void;
  onSelectHost: (hostId: string) => void;
  onOpenHost: (hostId: string) => void;
  onOpenSession: (hostId: string, sessionId: string) => void;
  onEditHost: (hostId: string) => void;
  onDeleteHost: (host: StoredHost) => void;
  onAddHost: (mode?: "scan" | "manual") => void;
  onRefreshHost: (hostId: string) => void;
  onCreateSession: (hostId: string, cwd?: string) => void;
  onCreateDirectory: (hostId: string) => void;
  onOpenTerminals?: (hostId: string, cwd?: string) => void;
  homeSettings?: HomeSettings;
  onChangeHomeSettings: (patch: Partial<HomeSettings>) => void;
  managedWorkspacePaths?: readonly string[];
  worktreeAssets?: readonly OrchestrationWorktreeAsset[];
}) {
  const { palette } = useMobileTheme();
  const adaptiveLayout = useAdaptiveLayout();
  const splitPanes = adaptiveLayout.splitPanes ?? null;
  const splitLayout = splitPanes !== null;
  const styles = useMemo(() => createStyles(palette), [palette]);
  const deviceBarWidth = splitPanes ? splitPanes.start : adaptiveLayout.width;
  const compactWorkspaceActions = deviceBarWidth < 430;
  const ultraCompactSidebar = deviceBarWidth < 260;
  const recentCardWidth = Math.min(236, Math.max(180, (splitPanes?.end ?? adaptiveLayout.width) - 64));
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? hosts[0];
  const homeListRef = useRef<FlatList<SessionProject>>(null);
  useEffect(() => {
    homeListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [selectedHost?.id]);
  const selectedRuntime = selectedHost ? runtimes[selectedHost.id] : undefined;
  const recentUsage = useSyncExternalStore(
    recentSessionStore.subscribe,
    () => recentSessionStore.getHost(selectedHost?.id),
    () => recentSessionStore.getHost(selectedHost?.id),
  );
  useEffect(() => { void recentSessionStore.load(); }, []);

  const {
    savedWorkspaces,
    pinnedWorkspaces,
    pinnedSessions,
    workspaceSort,
    addWorkspace,
    forgetWorkspace,
    togglePinWorkspace,
    togglePinSession,
    setWorkspaceSort,
  } = useHydratedWorkspaceConcepts();

  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  const effectiveHomeSettings = normalizeHomeSettings(homeSettings ?? DEFAULT_HOME_SETTINGS);
  const displayProjectName = useCallback(
    (path: string, fallback: string): string =>
      selectedHost
        ? (effectiveHomeSettings.workspaceAliases[workspaceAliasKey(selectedHost.id, path)] ?? fallback)
        : fallback,
    [effectiveHomeSettings.workspaceAliases, selectedHost],
  );

  const unorderedProjects = useMemo(
    () => homeWorkspaceProjects(selectedRuntime?.sessions),
    [selectedRuntime?.sessions],
  );
  const allProjects = useOrderedWorkspaces(selectedHost?.id, unorderedProjects);

  const savedHostWorkspaces = useMemo(
    () => (selectedHost ? savedWorkspaces[selectedHost.id] ?? [] : []),
    [savedWorkspaces, selectedHost],
  );
  const pinnedHostWorkspaces = useMemo(
    () => (selectedHost ? pinnedWorkspaces[selectedHost.id] ?? [] : []),
    [pinnedWorkspaces, selectedHost],
  );
  const pinnedWorkspaceKeys = useMemo(
    () => new Set(pinnedHostWorkspaces.map(workspacePathKey)),
    [pinnedHostWorkspaces],
  );
  const savedWorkspaceKeys = useMemo(
    () => new Set(savedHostWorkspaces.map(workspacePathKey)),
    [savedHostWorkspaces],
  );
  const pinnedSessionIds = useMemo(
    () => new Set(selectedHost ? pinnedSessions[selectedHost.id] ?? [] : []),
    [pinnedSessions, selectedHost],
  );

  const { workspaces: projects, childTaskWorkspacesByKey, orphanTaskWorkspaces: taskProjects } = useMemo(
    () =>
      buildAlignedWorkspaceTree({
        projects: allProjects,
        savedPaths: savedHostWorkspaces,
        pinnedPaths: pinnedHostWorkspaces,
        worktreeAssets,
        managedPaths: managedWorkspacePaths,
        sortMode: workspaceSort,
        displayNameFor: displayProjectName,
      }),
    [
      allProjects,
      displayProjectName,
      managedWorkspacePaths,
      pinnedHostWorkspaces,
      savedHostWorkspaces,
      workspaceSort,
      worktreeAssets,
    ],
  );

  const inboxSessions = useMemo(
    () => homeInboxSessions(selectedRuntime?.sessions),
    [selectedRuntime?.sessions],
  );
  const inboxIds = useMemo(
    () => new Set(inboxSessions.map((item) => item.id)),
    [inboxSessions],
  );
  const pinnedSessionList = useMemo(
    () =>
      sortWorkspaceSessions(
        Object.values(selectedRuntime?.sessions ?? {}).filter(
          (session) => session.archived !== true && pinnedSessionIds.has(session.id),
        ),
        pinnedSessionIds,
      ),
    [pinnedSessionIds, selectedRuntime?.sessions],
  );
  const archivedSessionList = useMemo(
    () =>
      Object.values(selectedRuntime?.sessions ?? {})
        .filter((session) => session.archived === true)
        .sort((a, b) => b.createdAt - a.createdAt),
    [selectedRuntime?.sessions],
  );
  const recentSessions = useMemo(
    () =>
      homeRecentSessions(
        selectedRuntime?.sessions,
        effectiveHomeSettings.recentSessionLimit,
        recentUsage,
      ).filter((item) => !inboxIds.has(item.id)),
    [effectiveHomeSettings.recentSessionLimit, inboxIds, recentUsage, selectedRuntime?.sessions],
  );

  const completionReads = useSessionAttention((state) => state.completionReads);
  const completionBaselineReady = useSessionAttention((state) => Boolean(
    selectedHost && state.completionBaselineHosts[completionBaselineHostKey(selectedHost.id)],
  ));
  const sessionNeedsMotion = useCallback(
    (session: SessionInfo): boolean => Boolean(selectedHost) && sessionNeedsLocatorMotion(
      selectedHost.id,
      session,
      completionReads,
      completionBaselineReady,
    ),
    [completionBaselineReady, completionReads, selectedHost],
  );
  const hasLocatorMotion = useMemo(
    () => allProjects.some((project) => project.sessions.some(sessionNeedsMotion)),
    [allProjects, sessionNeedsMotion],
  );
  const locatorWiggleStyle = useHomeLocatorMotion(
    selectedHost?.id,
    hasLocatorMotion && !reduceMotion,
  );

  const [expandedProjectKeys, setExpandedProjectKeys] = useState<Set<string>>(() => new Set());
  const [expandedChildTaskKeys, setExpandedChildTaskKeys] = useState<Set<string>>(() => new Set());
  const [selectedSplitPath, setSelectedSplitPath] = useState<string | null>(null);
  const [expandedTaskHostId, setExpandedTaskHostId] = useState<string | null>(null);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [archivedSheetOpen, setArchivedSheetOpen] = useState(false);
  const [addWorkspacePickerOpen, setAddWorkspacePickerOpen] = useState(false);
  const [manualWorkspaceOpen, setManualWorkspaceOpen] = useState(false);
  const [manualWorkspacePath, setManualWorkspacePath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [editingProject, setEditingProject] = useState<SessionProject | null>(null);
  const [projectAlias, setProjectAlias] = useState("");
  const [deviceNavigation] = useState(() => new DismissedModalAction());
  const [createNavigation] = useState(() => new DismissedModalAction());
  const [workspaceMenuNavigation] = useState(() => new DismissedModalAction());
  const closeDevicePickerRef = useRef(onCloseDevicePicker);
  useEffect(() => {
    closeDevicePickerRef.current = onCloseDevicePicker;
  }, [onCloseDevicePicker]);

  const searchResults = useMemo(
    () => filterMobileSessionsByQuery(selectedRuntime?.sessions, searchQuery),
    [searchQuery, selectedRuntime?.sessions],
  );
  const isSearching = searchQuery.trim().length > 0;

  const cancelOverlays = useCallback(() => {
    deviceNavigation.cancel();
    createNavigation.cancel();
    workspaceMenuNavigation.cancel();
    closeDevicePickerRef.current();
    setQuickCreateOpen(false);
    setWorkspaceMenuOpen(false);
    setArchivedSheetOpen(false);
    setAddWorkspacePickerOpen(false);
    setManualWorkspaceOpen(false);
    setEditingProject(null);
  }, [createNavigation, deviceNavigation, workspaceMenuNavigation]);

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

  const [manualRefreshing, setManualRefreshing] = useState(false);
  useEffect(() => {
    if (!manualRefreshing) return;
    if (
      selectedRuntime?.status !== "connecting" &&
      selectedRuntime?.status !== "reconnecting"
    ) {
      const done = setTimeout(() => setManualRefreshing(false), 180);
      return () => clearTimeout(done);
    }
    const timeout = setTimeout(() => setManualRefreshing(false), 1800);
    return () => clearTimeout(timeout);
  }, [manualRefreshing, selectedRuntime?.status]);

  if (!selectedHost) return null;

  const stats = homeHostStats(selectedRuntime?.sessions);
  const orderedHosts = [selectedHost, ...hosts.filter((candidate) => candidate.id !== selectedHost.id)];
  const taskProjectsExpanded = expandedTaskHostId === selectedHost.id;
  const taskRunningCount = taskProjects.reduce((total, project) => total + project.runningCount, 0);
  const taskPendingCount = taskProjects.reduce((total, project) => total + project.pendingCount, 0);

  const openAddWorkspaceFlow = (): void => {
    if (connection && selectedRuntime?.status === "connected") {
      setAddWorkspacePickerOpen(true);
      return;
    }
    onCreateDirectory(selectedHost.id);
  };

  const commitAddedWorkspace = (cwd: string): void => {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    addWorkspace(selectedHost.id, trimmed);
    setSelectedSplitPath(trimmed);
    const projectKey = `${selectedHost.id}:${trimmed}`;
    setExpandedProjectKeys((current) => {
      const next = new Set(current);
      next.delete(`collapsed:${projectKey}`);
      next.add(projectKey);
      return next;
    });
  };

  const activeSplitProject =
    projects.find((project) => project.path === selectedSplitPath) ??
    allProjects.find((project) => project.path === selectedSplitPath) ??
    projects[0] ??
    taskProjects[0] ??
    null;

  const activeSplitChildTasks = activeSplitProject
    ? (childTaskWorkspacesByKey.get(workspacePathKey(activeSplitProject.path)) ?? [])
    : [];
  const activeSplitSessionIds = new Set(activeSplitProject?.sessions.map((item) => item.id) ?? []);
  const visibleRecentSessions = splitLayout
    ? recentSessions.filter((item) => !activeSplitSessionIds.has(item.id))
    : recentSessions;

  const allSingleExpanded =
    projects.length > 1 &&
    projects.every((project) => expandedProjectKeys.has(`${selectedHost.id}:${project.path}`));

  const renderSessionRow = (
    session: SessionInfo,
    index = 0,
    options?: { showWorkspacePath?: boolean },
  ) => {
    const conciseTitle = desktopSidebarSessionLabel(session);
    const isRunning = session.status === "running" || session.status === "starting";
    const isAttention = session.status === "waiting_approval" || session.status === "waiting_input";
    const isPinned = pinnedSessionIds.has(session.id);
    const subtitle = options?.showWorkspacePath
      ? [
          displayProjectName(session.cwd, projectName(session.cwd)),
          session.archived ? "已归档" : null,
          session.preview?.trim() || `${session.agent} · ${session.kind === "pty" ? "终端" : "对话"}`,
        ]
          .filter(Boolean)
          .join(" · ")
      : session.preview?.trim() || `${session.agent} · ${session.kind === "pty" ? "终端" : "对话"}`;

    return (
      <View key={session.id}>
        {index > 0 && <View style={styles.sessionDivider} />}
        <SwipeRow
          clipRadius={12}
          actions={[
            {
              id: "pin-session",
              label: isPinned ? "取消置顶" : "置顶",
              symbol: isPinned ? "pin.fill" : "pin",
              color: isPinned ? palette.surfaceRaised : palette.accent,
              foregroundColor: isPinned ? palette.text : palette.onAccent,
              onPress: () => togglePinSession(selectedHost.id, session.id),
            },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`打开会话 ${conciseTitle}，${sessionStatusLabel[session.status]}`}
            onPress={() => onOpenSession(selectedHost.id, session.id)}
            style={({ pressed }) => [
              styles.sessionRow,
              pressed && styles.sessionRowPressed,
            ]}
          >
            <Animated.View
              style={sessionNeedsMotion(session) ? locatorWiggleStyle : styles.locatorRest}
            >
              <AgentIcon agent={session.agent} size={16} badge badgeOutline={false} />
            </Animated.View>
            <View style={styles.sessionCopy}>
              <View style={styles.sessionTitleRow}>
                <Text style={styles.sessionTitle} numberOfLines={1}>
                  {conciseTitle}
                </Text>
                {isPinned && !options?.showWorkspacePath && (
                  <Icon name="pin.fill" size={11} color={palette.textFaint} />
                )}
              </View>
              <Text style={styles.sessionPreview} numberOfLines={1}>
                {subtitle}
              </Text>
            </View>
            <View
              style={[
                styles.sessionState,
                isRunning && styles.sessionStateActive,
                isAttention && styles.sessionStateWarn,
              ]}
            >
              <View
                style={[
                  styles.sessionStatusDot,
                  { backgroundColor: statusTone(session.status, palette) },
                ]}
              />
              <Text
                style={[
                  styles.sessionStatusText,
                  isRunning && { color: palette.success, fontWeight: "600" },
                  isAttention && { color: palette.warn, fontWeight: "600" },
                ]}
              >
                {session.archived ? "已归档" : sessionStatusLabel[session.status]}
              </Text>
            </View>
            <Icon name="chevron.right" size={12} color={palette.textFaint} />
          </Pressable>
        </SwipeRow>
      </View>
    );
  };

  const renderNestedTaskWorkspaces = (parentPath: string, childTasks: readonly SessionProject[]) => {
    if (childTasks.length === 0) return null;
    const toggleKey = `${selectedHost.id}:${workspacePathKey(parentPath)}`;
    const childRunning = childTasks.reduce((sum, item) => sum + item.runningCount, 0);
    const childPending = childTasks.reduce((sum, item) => sum + item.pendingCount, 0);
    const autoExpand = childRunning > 0 || childPending > 0;
    const expanded = expandedChildTaskKeys.has(toggleKey) || (autoExpand && !expandedChildTaskKeys.has(`closed:${toggleKey}`));

    return (
      <View style={styles.nestedTaskWrap}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`任务工作区，${String(childTasks.length)} 个工作树`}
          onPress={() =>
            setExpandedChildTaskKeys((current) => {
              const next = new Set(current);
              if (expanded) {
                next.delete(toggleKey);
                if (autoExpand) next.add(`closed:${toggleKey}`);
              } else {
                next.delete(`closed:${toggleKey}`);
                next.add(toggleKey);
              }
              return next;
            })
          }
          style={({ pressed }) => [styles.nestedTaskToggle, pressed && styles.pressed]}
        >
          <Icon name="arrow.triangle.branch" size={13} color={palette.textDim} />
          <Text style={styles.nestedTaskTitle} numberOfLines={1}>
            任务工作区 · {String(childTasks.length)}
          </Text>
          {(childRunning > 0 || childPending > 0) && (
            <Text style={[styles.nestedTaskMeta, childPending > 0 && styles.projectPending]} numberOfLines={1}>
              {[
                childRunning > 0 ? `${String(childRunning)} 运行中` : null,
                childPending > 0 ? `${String(childPending)} 待处理` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          )}
          <Icon
            name={expanded ? "chevron.down" : "chevron.right"}
            size={12}
            color={palette.textFaint}
          />
        </Pressable>
        {expanded && (
          <View style={styles.nestedTaskList}>
            {childTasks.map((taskProject) => {
              const sortedTaskSessions = sortWorkspaceSessions(taskProject.sessions, pinnedSessionIds);
              return (
                <View key={taskProject.path} style={styles.nestedTaskCard}>
                  <View style={styles.nestedTaskCardHeader}>
                    <View style={styles.nestedTaskCardCopy}>
                      <Text style={styles.nestedTaskCardName} numberOfLines={1}>
                        {displayProjectName(taskProject.path, taskProject.name)}
                      </Text>
                      <Text style={styles.nestedTaskCardPath} numberOfLines={1} ellipsizeMode="middle">
                        {taskProject.path}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`在 ${taskProject.name} 中新建会话`}
                      onPress={() => onCreateSession(selectedHost.id, taskProject.path)}
                      style={({ pressed }) => [styles.inlinePlusBtn, pressed && styles.pressed]}
                    >
                      <Icon name="plus" size={13} color={palette.textDim} weight="semibold" />
                    </Pressable>
                  </View>
                  {sortedTaskSessions.map((session, idx) => renderSessionRow(session, idx))}
                </View>
              );
            })}
          </View>
        )}
      </View>
    );
  };

  const renderProject = (project: SessionProject) => {
    const projectKey = `${selectedHost.id}:${project.path}`;
    const pathKey = workspacePathKey(project.path);
    const isPinned = pinnedWorkspaceKeys.has(pathKey);
    const isSaved = savedWorkspaceKeys.has(pathKey);
    const childTasks = childTaskWorkspacesByKey.get(pathKey) ?? [];
    const singleAutoExpanded = projects.length === 1 && !expandedProjectKeys.has(`collapsed:${projectKey}`);
    const expanded = singleAutoExpanded || expandedProjectKeys.has(projectKey);
    const splitSelected = splitLayout && activeSplitProject?.path === project.path;
    const displayName = displayProjectName(project.path, project.name);
    const projectHasLocatorMotion =
      project.sessions.some(sessionNeedsMotion) ||
      childTasks.some((child) => child.sessions.some(sessionNeedsMotion));
    const sortedSessions = sortWorkspaceSessions(project.sessions, pinnedSessionIds);
    const combinedPending = project.pendingCount + childTasks.reduce((s, c) => s + c.pendingCount, 0);
    const combinedRunning = project.runningCount + childTasks.reduce((s, c) => s + c.runningCount, 0);
    const summaryProject: SessionProject = {
      ...project,
      pendingCount: combinedPending,
      runningCount: combinedRunning,
    };

    const swipeActions: SwipeAction[] = [
      {
        id: "create-session",
        label: "新会话",
        symbol: "plus",
        color: palette.text,
        foregroundColor: palette.bg,
        onPress: () => onCreateSession(selectedHost.id, project.path),
      },
      {
        id: "pin-workspace",
        label: isPinned ? "取消置顶" : "置顶",
        symbol: isPinned ? "pin.fill" : "pin",
        color: palette.accent,
        foregroundColor: palette.onAccent,
        onPress: () => togglePinWorkspace(selectedHost.id, project.path),
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
      ...(project.sessions.length === 0 && isSaved
        ? [
            {
              id: "forget-workspace",
              label: "移除",
              symbol: "trash" as const,
              color: palette.danger,
              foregroundColor: palette.onAccent,
              onPress: () => forgetWorkspace(selectedHost.id, project.path),
            },
          ]
        : []),
    ];

    const headerRow = (
      <SwipeRow clipRadius={radius.md} actions={swipeActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={splitLayout ? { selected: splitSelected } : { expanded }}
          accessibilityLabel={`${displayName}，${workspaceDetail(summaryProject, childTasks.length)}，${project.path}`}
          onPress={() => {
            if (splitLayout) {
              setSelectedSplitPath(project.path);
              return;
            }
            setExpandedProjectKeys((current) => {
              const next = new Set(current);
              if (projects.length === 1) {
                const collapseMarker = `collapsed:${projectKey}`;
                if (next.has(collapseMarker)) next.delete(collapseMarker);
                else next.add(collapseMarker);
                return next;
              }
              if (next.has(projectKey)) next.delete(projectKey);
              else next.add(projectKey);
              return next;
            });
          }}
          style={({ pressed }) => [
            styles.projectHeader,
            splitLayout && styles.projectHeaderSplit,
            splitSelected && styles.projectHeaderSelected,
            pressed && styles.projectCardPressed,
          ]}
        >
          <View style={[styles.projectIcon, splitSelected && styles.projectIconSelected]}>
            <Animated.View style={projectHasLocatorMotion ? locatorWiggleStyle : styles.locatorRest}>
              <WorkspaceFolderIcon
                expanded={splitLayout ? splitSelected : expanded}
                size={15}
                color={splitSelected ? palette.bg : palette.textDim}
              />
            </Animated.View>
          </View>
          <WorkspaceHeader
            hostId={selectedHost.id}
            path={project.path}
            sid={project.sessions[0]?.id}
            name={isPinned ? `📌 ${displayName}` : displayName}
            sessionCount={project.sessions.length}
            compact={splitLayout}
            activity={
              combinedPending > 0 || combinedRunning > 0 || childTasks.length > 0
                ? {
                    label: workspaceDetail(summaryProject, childTasks.length),
                    pending: combinedPending > 0,
                  }
                : undefined
            }
          />
        </Pressable>
      </SwipeRow>
    );

    if (splitLayout) {
      return (
        <View
          key={projectKey}
          collapsable={false}
          style={[styles.projectCardSplit, splitSelected && styles.projectCardSplitSelected]}
        >
          {headerRow}
        </View>
      );
    }

    return (
      <View
        key={projectKey}
        collapsable={false}
        style={[styles.projectCard, expanded && styles.projectCardExpanded]}
      >
        <WorkspaceDisclosure
          expanded={expanded}
          header={(disclosureProgress) => (
            <SwipeRow clipRadius={radius.md} actions={swipeActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={`${displayName}，${workspaceDetail(summaryProject, childTasks.length)}，${project.path}`}
                onPress={() => setExpandedProjectKeys((current) => {
                  const next = new Set(current);
                  if (projects.length === 1) {
                    const collapseMarker = `collapsed:${projectKey}`;
                    if (next.has(collapseMarker)) next.delete(collapseMarker);
                    else next.add(collapseMarker);
                    return next;
                  }
                  if (next.has(projectKey)) next.delete(projectKey);
                  else next.add(projectKey);
                  return next;
                })}
                style={({ pressed }) => [styles.projectHeader, pressed && styles.projectCardPressed]}
              >
                <View style={styles.projectIcon}>
                  <Animated.View style={projectHasLocatorMotion ? locatorWiggleStyle : styles.locatorRest}>
                    <WorkspaceFolderIcon expanded={expanded} size={15} color={palette.textDim} />
                  </Animated.View>
                </View>
                <WorkspaceHeader
                  hostId={selectedHost.id}
                  path={project.path}
                  sid={project.sessions[0]?.id}
                  name={isPinned ? `📌 ${displayName}` : displayName}
                  sessionCount={project.sessions.length}
                  activity={
                    combinedPending > 0 || combinedRunning > 0 || childTasks.length > 0
                      ? {
                          label: workspaceDetail(summaryProject, childTasks.length),
                          pending: combinedPending > 0,
                        }
                      : undefined
                  }
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`在 ${displayName} 中新建会话`}
                  hitSlop={6}
                  onPress={() => onCreateSession(selectedHost.id, project.path)}
                  style={({ pressed }) => [styles.inlinePlusBtn, pressed && styles.pressed]}
                >
                  <Icon name="plus" size={13} color={palette.textDim} weight="semibold" />
                </Pressable>
                <WorkspaceChevron progress={disclosureProgress} size={14} color={palette.textFaint} />
              </Pressable>
            </SwipeRow>
          )}
        >
          <View style={styles.sessionList}>
            {sortedSessions.length > 0 ? (
              sortedSessions.map((session, idx) => renderSessionRow(session, idx))
            ) : (
              <View style={styles.emptySavedWorkspace}>
                <Text style={styles.emptySavedWorkspaceText}>此工作区暂无活跃会话</Text>
                <View style={styles.emptySavedWorkspaceActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onCreateSession(selectedHost.id, project.path)}
                    style={({ pressed }) => [styles.emptySavedPrimaryBtn, pressed && styles.createButtonPressed]}
                  >
                    <Icon name="plus" size={12} color={palette.bg} weight="semibold" />
                    <Text style={styles.emptySavedPrimaryText}>新建会话</Text>
                  </Pressable>
                  {isSaved && (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => forgetWorkspace(selectedHost.id, project.path)}
                      style={({ pressed }) => [styles.emptySavedGhostBtn, pressed && styles.pressed]}
                    >
                      <Text style={styles.emptySavedGhostText}>从列表移除</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )}
            {renderNestedTaskWorkspaces(project.path, childTasks)}
          </View>
        </WorkspaceDisclosure>
      </View>
    );
  };

  const deviceBar = (
    <View style={styles.deviceBar}>
      <Pressable
        testID={`home-device-card-${selectedHost.id}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: devicePickerOpen }}
        accessibilityLabel={`选择电脑，${String(hosts.length)} 台已配对，当前为 ${selectedHost.name}，${hostConnectionLabel(selectedRuntime)}`}
        accessibilityHint="打开已配对电脑与管理列表"
        onPress={() => {
          deviceNavigation.cancel();
          onToggleDevicePicker();
        }}
        style={({ pressed }) => [styles.deviceCapsule, pressed && styles.pressed]}
      >
        <View style={styles.sectionIcon}>
          <HostPlatformIcon platform={selectedRuntime?.hostInfo?.platform} palette={palette} />
        </View>
        <View style={styles.deviceHeaderCopy}>
          <View style={styles.deviceNameRow}>
            <Text style={styles.deviceHeaderName} numberOfLines={1}>{selectedHost.name}</Text>
            <Icon name="chevron.down" size={10} color={palette.textFaint} />
          </View>
          <View style={styles.deviceMetaRow}>
            <View style={styles.deviceFleetPill}>
              <View
                style={[
                  styles.fleetStatusDot,
                  { backgroundColor: hostConnectionTone(selectedRuntime, palette) },
                ]}
              />
              <Text style={styles.fleetCurrentStatus} numberOfLines={1}>
                {hostConnectionLabel(selectedRuntime)}
              </Text>
              {orderedHosts.slice(1).map((candidate, index) =>
                index >= 3 ? null : (
                  <View
                    key={candidate.id}
                    style={[
                      styles.fleetStatusDot,
                      { backgroundColor: hostConnectionTone(runtimes[candidate.id], palette) },
                    ]}
                  />
                ),
              )}
            </View>
            {!ultraCompactSidebar && (
              <Text style={styles.deviceMeta} numberOfLines={1}>
                {stats.runningCount > 0
                  ? `${String(stats.runningCount)} 运行中`
                  : `${String(stats.sessionCount)} 会话`}
              </Text>
            )}
          </View>
        </View>
      </Pressable>

      <View style={styles.deviceActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建会话或添加工作区"
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
          <Icon name="plus" size={15} color={palette.bg} weight="semibold" />
          {!compactWorkspaceActions && <Text style={styles.createButtonText}>新建</Text>}
        </Pressable>
      </View>
    </View>
  );

  const inboxSection = inboxSessions.length > 0 ? (
    <View style={styles.approvalSection} testID="home-approval-sessions">
      <View style={styles.sectionHeading}>
        <View style={styles.sectionTitleGroup}>
          <Text style={styles.sectionTitle}>收件箱</Text>
          <Text style={styles.approvalCount}>{String(inboxSessions.length)}</Text>
        </View>
      </View>
      <ScrollView
        horizontal={!splitLayout}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={splitLayout ? styles.approvalStack : styles.recentList}
      >
        {inboxSessions.map((session) => {
          const isApproval =
            session.status === "waiting_approval" || (session.pendingPermissions ?? 0) > 0;
          return (
            <Pressable
              key={session.id}
              accessibilityRole="button"
              accessibilityLabel={`打开收件箱会话 ${desktopSidebarSessionLabel(session)}，${inboxReasonLabel(session)}`}
              onPress={() => onOpenSession(selectedHost.id, session.id)}
              style={({ pressed }) => [
                styles.approvalCard,
                !isApproval && styles.inboxInputCard,
                !splitLayout && { width: recentCardWidth },
                pressed && styles.recentCardPressed,
              ]}
            >
              <Animated.View style={locatorWiggleStyle}>
                <AgentIcon agent={session.agent} size={17} badge badgeOutline={false} />
              </Animated.View>
              <View style={styles.recentCopy}>
                <Text style={styles.recentTitle} numberOfLines={1}>
                  {desktopSidebarSessionLabel(session)}
                </Text>
                <Text
                  style={[styles.approvalDetail, !isApproval && styles.inboxInputDetail]}
                  numberOfLines={1}
                >
                  {[inboxReasonLabel(session), displayProjectName(session.cwd, projectName(session.cwd))]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              <Icon
                name={isApproval ? "exclamationmark.triangle.fill" : "bubble.left.and.text.bubble.right"}
                size={14}
                color={isApproval ? palette.warn : palette.accent}
              />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  ) : null;

  const pinnedSection = !isSearching && pinnedSessionList.length > 0 ? (
    <View style={styles.pinnedSection}>
      <View style={styles.sectionHeading}>
        <View style={styles.sectionTitleGroup}>
          <Icon name="pin.fill" size={11} color={palette.textFaint} />
          <Text style={styles.sectionTitle}>置顶</Text>
          <Text style={styles.sectionMetaCount}>{String(pinnedSessionList.length)}</Text>
        </View>
      </View>
      <View style={styles.pinnedCard}>
        {pinnedSessionList.map((session, idx) =>
          renderSessionRow(session, idx, { showWorkspacePath: true }),
        )}
      </View>
    </View>
  ) : null;

  const recentSection = !isSearching && visibleRecentSessions.length > 0 ? (
    <View style={styles.recentSection} testID="home-recent-section">
      <View style={styles.sectionHeading}>
        <Text style={styles.sectionTitle}>最近继续</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.recentList}
      >
        {visibleRecentSessions.map((session) => {
          const timeText = recentTime(recentSessionTime(session, recentUsage[session.id]));
          return (
            <Pressable
              key={session.id}
              accessibilityRole="button"
              accessibilityLabel={`打开最近会话 ${desktopSidebarSessionLabel(session)}，${homeRecentSummary(session, recentUsage[session.id])}`}
              onPress={() => onOpenSession(selectedHost.id, session.id)}
              style={({ pressed }) => [
                styles.recentCard,
                { width: recentCardWidth },
                pressed && styles.recentCardPressed,
              ]}
            >
              <Animated.View style={sessionNeedsMotion(session) ? locatorWiggleStyle : styles.locatorRest}>
                <AgentIcon agent={session.agent} size={17} badge badgeOutline={false} />
              </Animated.View>
              <View style={styles.recentCopy}>
                <Text style={styles.recentTitle} numberOfLines={1}>
                  {desktopSidebarSessionLabel(session)}
                </Text>
                <Text style={styles.recentMeta} numberOfLines={1}>
                  {[displayProjectName(session.cwd, projectName(session.cwd)), timeText].filter(Boolean).join(" · ")}
                </Text>
              </View>
              <View
                style={[
                  styles.sessionStatusDot,
                  { backgroundColor: statusTone(session.status, palette) },
                ]}
              />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  ) : null;

  const workspaceSectionHeader = (projects.length > 0 || taskProjects.length > 0 || isSearching || archivedSessionList.length > 0) ? (
    <View style={styles.workspaceHeaderBlock}>
      <View style={styles.sectionHeading}>
        <View style={styles.sectionTitleGroup}>
          <Text style={styles.sectionTitle}>工作区</Text>
          <Text style={styles.sectionMetaCount}>{String(projects.length)}</Text>
          {workspaceSort === "name" && !ultraCompactSidebar && (
            <Text style={styles.sectionMetaCount}>· 按名称</Text>
          )}
        </View>
        <View style={styles.sectionHeadingActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="添加工作区"
            hitSlop={6}
            onPress={openAddWorkspaceFlow}
            style={({ pressed }) => [styles.sectionActionBtn, pressed && styles.pressed]}
          >
            <Icon name="plus" size={14} color={palette.textDim} weight="semibold" />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="工作区更多操作"
            hitSlop={6}
            onPress={() => {
              workspaceMenuNavigation.cancel();
              setWorkspaceMenuOpen(true);
            }}
            style={({ pressed }) => [styles.sectionActionBtn, pressed && styles.pressed]}
          >
            <Icon name="ellipsis.circle" size={15} color={palette.textDim} />
          </Pressable>
        </View>
      </View>
      <View style={styles.workspaceSearchBar}>
        <Icon name="magnifyingglass" size={13} color={palette.textFaint} />
        <TextInput
          style={styles.workspaceSearchInput}
          placeholder="搜索会话、状态或路径"
          placeholderTextColor={palette.textFaint}
          selectionColor={palette.accent}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="搜索会话、状态或路径"
        />
        {isSearching && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="清空搜索"
            hitSlop={8}
            onPress={() => setSearchQuery("")}
            style={styles.searchClearBtn}
          >
            <Icon name="xmark.circle.fill" size={14} color={palette.textFaint} />
          </Pressable>
        )}
      </View>
      {isSearching && (
        <View style={styles.pinnedCard}>
          {searchResults.length > 0 ? (
            searchResults.map((session, idx) =>
              renderSessionRow(session, idx, { showWorkspacePath: true }),
            )
          ) : (
            <Text style={styles.searchEmptyText}>没有匹配的会话</Text>
          )}
        </View>
      )}
    </View>
  ) : null;

  const taskWorkspaceFooter = !isSearching && taskProjects.length > 0 ? (
    <View style={styles.taskSection}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: taskProjectsExpanded }}
        accessibilityLabel={`任务工作区，${String(taskProjects.length)} 个工作树，${String(taskRunningCount)} 个运行中，${String(taskPendingCount)} 项待处理`}
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
          size={14}
          color={palette.textFaint}
        />
      </Pressable>
      {taskProjectsExpanded && (
        <View style={styles.taskProjects}>{taskProjects.map(renderProject)}</View>
      )}
    </View>
  ) : null;

  const visibleWorkspaceList = isSearching ? [] : projects;

  return (
    <>
      {splitLayout && splitPanes ? (
        <View style={styles.splitContainer}>
          <FlatList
            ref={homeListRef}
            testID="home-workspace-list"
            style={{ width: splitPanes.start, flexGrow: 0, overflow: "hidden" }}
            data={visibleWorkspaceList}
            extraData={activeSplitProject?.path}
            keyExtractor={(project) => project.path}
            removeClippedSubviews={false}
            contentContainerStyle={[styles.splitLeftList, { paddingBottom: bottomInset + space.xl }]}
            keyboardShouldPersistTaps="handled"
            refreshControl={
              <RefreshControl
                refreshing={manualRefreshing}
                onRefresh={() => {
                  setManualRefreshing(true);
                  onRefreshHost(selectedHost.id);
                }}
                tintColor={palette.accent}
              />
            }
            ListHeaderComponent={
              <View style={styles.headerContent}>
                {deviceBar}
                {inboxSection}
                {pinnedSection}
                {workspaceSectionHeader}
              </View>
            }
            ListEmptyComponent={!isSearching && taskProjects.length === 0 ? (
              <WorkspaceEmptyState
                host={selectedHost}
                runtime={selectedRuntime}
                onAddWorkspace={openAddWorkspaceFlow}
                onRefresh={() => onRefreshHost(selectedHost.id)}
                palette={palette}
                styles={styles}
              />
            ) : null}
            ItemSeparatorComponent={() => <View style={styles.projectGap} />}
            renderItem={({ item }) => renderProject(item)}
            ListFooterComponent={taskWorkspaceFooter}
          />
          <SplitPaneDivider
            label="拖动调整工作区侧栏宽度"
            value={splitPanes.start}
            min={adaptiveLayout.splitBounds?.minStart ?? 220}
            max={adaptiveLayout.splitBounds?.maxStart ?? 440}
            gap={splitPanes.gap}
            disabled={adaptiveLayout.splitResizable === false}
            onChange={adaptiveLayout.setSplitStart}
            onCommit={adaptiveLayout.commitSplitStart}
            onReset={adaptiveLayout.resetSplitStart}
          />
          <ScrollView
            style={{ width: splitPanes.end, flexGrow: 0, overflow: "hidden" }}
            contentContainerStyle={[styles.splitRightContent, { paddingBottom: bottomInset + space.xl }]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {recentSection}
            {activeSplitProject ? (
              <View style={styles.splitProjectDetail}>
                <View style={styles.splitProjectHeader}>
                  <View style={styles.splitProjectCopy}>
                    <Text style={styles.splitProjectTitle} numberOfLines={1}>
                      {displayProjectName(activeSplitProject.path, activeSplitProject.name)}
                    </Text>
                    <Text style={styles.splitProjectPath} numberOfLines={1} ellipsizeMode="middle">
                      {activeSplitProject.path}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="在当前工作区新建会话"
                    onPress={() => onCreateSession(selectedHost.id, activeSplitProject.path)}
                    style={({ pressed }) => [styles.splitCreateBtn, pressed && styles.createButtonPressed]}
                  >
                    <Icon name="plus" size={14} color={palette.bg} weight="semibold" />
                    <Text style={styles.splitCreateText}>新建会话</Text>
                  </Pressable>
                </View>
                <View style={styles.splitSessionCard}>
                  {activeSplitProject.sessions.length > 0 ? (
                    sortWorkspaceSessions(activeSplitProject.sessions, pinnedSessionIds).map(
                      (session, idx) => renderSessionRow(session, idx),
                    )
                  ) : (
                    <View style={styles.emptySavedWorkspace}>
                      <Text style={styles.emptySavedWorkspaceText}>此工作区暂无活跃会话</Text>
                      <View style={styles.emptySavedWorkspaceActions}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => onCreateSession(selectedHost.id, activeSplitProject.path)}
                          style={({ pressed }) => [styles.emptySavedPrimaryBtn, pressed && styles.createButtonPressed]}
                        >
                          <Icon name="plus" size={12} color={palette.bg} weight="semibold" />
                          <Text style={styles.emptySavedPrimaryText}>新建会话</Text>
                        </Pressable>
                        {savedWorkspaceKeys.has(workspacePathKey(activeSplitProject.path)) && (
                          <Pressable
                            accessibilityRole="button"
                            onPress={() => forgetWorkspace(selectedHost.id, activeSplitProject.path)}
                            style={({ pressed }) => [styles.emptySavedGhostBtn, pressed && styles.pressed]}
                          >
                            <Text style={styles.emptySavedGhostText}>从列表移除</Text>
                          </Pressable>
                        )}
                      </View>
                    </View>
                  )}
                  {renderNestedTaskWorkspaces(activeSplitProject.path, activeSplitChildTasks)}
                </View>
              </View>
            ) : null}
          </ScrollView>
        </View>
      ) : (
        <FlatList
          ref={homeListRef}
          testID="home-workspace-list"
          data={visibleWorkspaceList}
          extraData={expandedProjectKeys}
          keyExtractor={(project) => project.path}
          removeClippedSubviews={false}
          contentContainerStyle={[styles.list, { paddingBottom: bottomInset + space.xl }]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={manualRefreshing}
              onRefresh={() => {
                setManualRefreshing(true);
                onRefreshHost(selectedHost.id);
              }}
              tintColor={palette.accent}
            />
          }
          ListHeaderComponent={
            <View style={styles.headerContent}>
              {deviceBar}
              {inboxSection}
              {recentSection}
              {pinnedSection}
              {workspaceSectionHeader}
            </View>
          }
          ListEmptyComponent={!isSearching && taskProjects.length === 0 ? (
            <WorkspaceEmptyState
              host={selectedHost}
              runtime={selectedRuntime}
              onAddWorkspace={openAddWorkspaceFlow}
              onRefresh={() => onRefreshHost(selectedHost.id)}
              palette={palette}
              styles={styles}
            />
          ) : null}
          ItemSeparatorComponent={() => <View style={styles.projectGap} />}
          renderItem={({ item }) => renderProject(item)}
          ListFooterComponent={taskWorkspaceFooter}
        />
      )}

      <Sheet
        visible={devicePickerOpen}
        title="已配对电脑"
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
                    <Icon name="pencil" size={16} color={palette.textDim} />
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
                    <Icon name="trash" size={16} color={palette.danger} />
                  </Pressable>
                </View>
              </View>
            );
          })}
          <View style={styles.deviceSheetDivider} />
          <SheetAction
            label={`打开 ${selectedHost.name} 主机页`}
            detail="查看机器状态、账号与模型源及全部会话"
            symbol="desktopcomputer"
            onPress={() => {
              deviceNavigation.defer(() => onOpenHost(selectedHost.id));
              onCloseDevicePicker();
            }}
          />
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
          label="新建会话"
          detail={`在 ${selectedHost.name} 选择工作区并启动 Agent 或终端`}
          symbol="bubble.left.and.text.bubble.right"
          onPress={() => {
            createNavigation.defer(() => onCreateSession(selectedHost.id));
            setQuickCreateOpen(false);
          }}
        />
        {onOpenTerminals && supportsRemoteTerminal(selectedRuntime?.hostInfo) && (
          <SheetAction
            label="新建终端"
            detail={`在 ${selectedHost.name} 打开电脑的默认 Shell 终端`}
            symbol="terminal"
            onPress={() => {
              const targetCwd = splitLayout ? activeSplitProject?.path : undefined;
              createNavigation.defer(() => onOpenTerminals(selectedHost.id, targetCwd));
              setQuickCreateOpen(false);
            }}
          />
        )}
        <SheetAction
          label="添加工作区"
          detail="从电脑浏览选择文件夹，固定到工作区列表"
          symbol="folder.badge.plus"
          onPress={() => {
            createNavigation.defer(openAddWorkspaceFlow);
            setQuickCreateOpen(false);
          }}
        />
      </Sheet>

      <Sheet
        visible={workspaceMenuOpen}
        title="工作区选项"
        onClose={() => {
          workspaceMenuNavigation.cancel();
          setWorkspaceMenuOpen(false);
        }}
        onDismiss={() => workspaceMenuNavigation.dismiss()}
      >
        <SheetAction
          label="添加工作区"
          detail="浏览电脑文件夹并加入工作区列表（无会话也会保留）"
          symbol="folder.badge.plus"
          onPress={() => {
            workspaceMenuNavigation.defer(openAddWorkspaceFlow);
            setWorkspaceMenuOpen(false);
          }}
        />
        <SheetAction
          label="已归档会话"
          detail={
            archivedSessionList.length > 0
              ? `查看或继续 ${String(archivedSessionList.length)} 个已归档会话`
              : "当前没有已归档会话"
          }
          symbol="archivebox"
          onPress={() => {
            workspaceMenuNavigation.defer(() => setArchivedSheetOpen(true));
            setWorkspaceMenuOpen(false);
          }}
        />
        <SheetAction
          label={`排序方式：${workspaceSort === "recent" ? "最近使用" : "名称"}`}
          detail={`点按切换为按${workspaceSort === "recent" ? "名称" : "最近使用"}排序（置顶工作区始终在前）`}
          symbol="arrow.up.arrow.down"
          onPress={() => {
            setWorkspaceSort(workspaceSort === "recent" ? "name" : "recent");
            setWorkspaceMenuOpen(false);
          }}
        />
        {!splitLayout && projects.length > 1 && (
          <SheetAction
            label={allSingleExpanded ? "全部折叠" : "全部展开"}
            detail="展开或折叠当前所有工作区"
            symbol="square.stack.3d.up"
            onPress={() => {
              setExpandedProjectKeys(() => {
                if (allSingleExpanded) return new Set();
                return new Set(projects.map((p) => `${selectedHost.id}:${p.path}`));
              });
              setWorkspaceMenuOpen(false);
            }}
          />
        )}
      </Sheet>

      <Sheet
        visible={archivedSheetOpen}
        title="已归档会话"
        onClose={() => setArchivedSheetOpen(false)}
      >
        {archivedSessionList.length === 0 ? (
          <Text style={styles.archivedEmptyNote}>
            当前电脑上没有已归档会话。在会话菜单中选择「停止并归档」后，历史记录会保存在这里。
          </Text>
        ) : (
          <View style={styles.archivedList}>
            {archivedSessionList.map((session, idx) =>
              renderSessionRow(session, idx, { showWorkspacePath: true }),
            )}
          </View>
        )}
      </Sheet>

      {connection && (
        <WorkspacePicker
          visible={addWorkspacePickerOpen}
          conn={connection}
          initialPath=""
          title="添加工作区"
          confirmLabel="添加此工作区"
          onClose={() => setAddWorkspacePickerOpen(false)}
          onManualInput={() => {
            setAddWorkspacePickerOpen(false);
            setManualWorkspacePath("");
            setManualWorkspaceOpen(true);
          }}
          onSelect={({ cwd }) => {
            commitAddedWorkspace(cwd);
            setAddWorkspacePickerOpen(false);
          }}
        />
      )}

      <PromptDialog
        visible={manualWorkspaceOpen}
        title="添加工作区路径"
        message="输入电脑上的完整文件夹路径，添加到工作区列表。"
        value={manualWorkspacePath}
        confirmLabel="添加工作区"
        onChangeText={setManualWorkspacePath}
        onCancel={() => setManualWorkspaceOpen(false)}
        validate={(value) => (value.trim().length === 0 ? "请输入文件夹路径" : null)}
        onSubmit={(value) => {
          commitAddedWorkspace(value);
          setManualWorkspaceOpen(false);
        }}
      />

      <PromptDialog
        visible={editingProject !== null}
        title="编辑工作区名称"
        message={`${editingProject?.path ?? ""}\n\n只修改这台手机上的显示名称，清空可恢复目录原名。`}
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
  onAddWorkspace,
  onRefresh,
  palette,
  styles,
}: {
  host: StoredHost;
  runtime: HostRuntime | undefined;
  onAddWorkspace: () => void;
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
          size={24}
          color={unavailable ? palette.warn : palette.textFaint}
        />
      </View>
      <Text style={styles.emptyTitle}>
        {status === "connecting" || status === "reconnecting"
          ? `正在连接 ${host.name}`
          : unavailable
            ? "暂时无法读取工作区"
            : "还没有工作区"}
      </Text>
      <Text style={styles.emptyDetail}>
        {status === "failed"
          ? (runtime?.lastError ?? "连接失败，请检查网络后重试。")
          : status === "idle"
            ? "连接电脑后，这里会按工作区整理全部会话。"
            : status === "connecting" || status === "reconnecting"
              ? "建立连接后会自动同步工作区与会话。"
              : "添加一个电脑文件夹作为工作区，或直接新建会话。"}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={unavailable ? onRefresh : onAddWorkspace}
        style={({ pressed }) => [styles.emptyAction, pressed && styles.emptyActionPressed]}
      >
        <Text style={styles.emptyActionText}>{unavailable ? "重新连接" : "添加工作区"}</Text>
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
    splitContainer: { flex: 1, flexDirection: "row", minHeight: 0 },
    splitLeftList: { paddingHorizontal: 14, paddingTop: space.xs },
    splitGutter: {
      flexShrink: 0,
      backgroundColor: palette.bg,
      borderRightWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    splitRightContent: { paddingHorizontal: 20, paddingTop: space.sm, gap: 18 },
    splitProjectDetail: { gap: 12 },
    splitProjectHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.md,
      paddingHorizontal: 2,
    },
    splitProjectCopy: { flex: 1, minWidth: 0, gap: 3 },
    splitProjectTitle: { ...themedFont.title, fontSize: 22, letterSpacing: -0.5 },
    splitProjectPath: { ...themedFont.meta, fontSize: 12 },
    splitCreateBtn: {
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 14,
      borderRadius: radius.pill,
      backgroundColor: palette.text,
    },
    splitCreateText: { color: palette.bg, fontSize: 13, fontWeight: "600" },
    splitSessionCard: {
      borderRadius: 18,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      paddingHorizontal: 6,
      paddingVertical: 4,
      overflow: "hidden",
    },

    list: {
      flexGrow: 1,
      width: "100%",
      maxWidth: 720,
      alignSelf: "center",
      paddingHorizontal: space.lg,
    },
    headerContent: { gap: 14, paddingTop: space.xs, paddingBottom: 10 },
    deviceBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minWidth: 0,
    },
    deviceCapsule: {
      flex: 1,
      minWidth: 0,
      minHeight: 50,
      flexDirection: "row",
      alignItems: "center",
      gap: 9,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: 16,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      overflow: "hidden",
    },
    sectionIcon: {
      width: 30,
      height: 30,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 9,
      backgroundColor: palette.surfaceRaised,
    },
    deviceHeaderCopy: { flex: 1, minWidth: 0, gap: 3, overflow: "hidden" },
    deviceNameRow: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 },
    deviceHeaderName: { ...themedFont.body, fontSize: 14.5, fontWeight: "700", letterSpacing: -0.2, flex: 1, minWidth: 0 },
    deviceMetaRow: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" },
    deviceMeta: { color: palette.textFaint, fontSize: 11, flexShrink: 1, minWidth: 0 },
    deviceFleetPill: {
      height: 19,
      maxWidth: "100%",
      flexShrink: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 6,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceRaised,
      overflow: "hidden",
    },
    fleetStatusDot: { width: 5, height: 5, borderRadius: 2.5, flexShrink: 0 },
    fleetCurrentStatus: {
      color: palette.textDim,
      fontSize: 10,
      fontWeight: "600",
      fontVariant: ["tabular-nums"],
      flexShrink: 1,
    },
    deviceActions: { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 6 },
    iconButton: {
      width: 38,
      height: 38,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.pill,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    createButton: {
      minHeight: 38,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      paddingHorizontal: 14,
      borderRadius: radius.pill,
      backgroundColor: palette.text,
    },
    createButtonCompact: {
      width: 38,
      paddingHorizontal: 0,
    },
    createButtonPressed: { opacity: 0.82 },
    createButtonText: { color: palette.bg, fontSize: 13.5, fontWeight: "600" },

    deviceList: {
      gap: 4,
      paddingBottom: space.md,
    },
    deviceManageRow: {
      flexDirection: "row",
      alignItems: "center",
      borderRadius: radius.md,
    },
    deviceRow: {
      minHeight: 54,
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: radius.md,
    },
    deviceRowSelected: { backgroundColor: palette.accentBg },
    deviceRowCopy: { flex: 1, minWidth: 0, gap: 2 },
    deviceRowName: { ...themedFont.body, fontWeight: "600" },
    deviceRowDetail: themedFont.meta,
    statusDot: { width: 7, height: 7, borderRadius: 3.5 },
    deviceRowActions: { flexDirection: "row", alignItems: "center", paddingRight: 4 },
    deviceAction: {
      width: 42,
      height: 42,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.sm,
    },
    dangerPressed: { backgroundColor: palette.dangerBg },
    deviceSheetDivider: {
      height: StyleSheet.hairlineWidth,
      marginVertical: space.xs,
      backgroundColor: palette.border,
    },
    pressed: { backgroundColor: palette.pressed },

    approvalSection: { gap: 6 },
    approvalStack: { gap: 6 },
    approvalCount: {
      color: palette.warn,
      backgroundColor: palette.warnBg,
      fontSize: 11,
      fontWeight: "700",
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: radius.pill,
      overflow: "hidden",
    },
    approvalCard: {
      minHeight: 54,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: radius.md,
      backgroundColor: palette.warnBg,
    },
    inboxInputCard: {
      backgroundColor: palette.accentBg,
    },
    approvalDetail: { color: palette.warn, fontSize: 11.5, fontWeight: "600" },
    inboxInputDetail: { color: palette.accent },

    pinnedSection: { gap: 6 },
    pinnedCard: {
      borderRadius: 16,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      paddingHorizontal: 6,
      paddingVertical: 4,
      overflow: "hidden",
    },

    workspaceHeaderBlock: { gap: 8 },
    sectionHeading: {
      minHeight: 26,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      paddingHorizontal: 4,
      minWidth: 0,
    },
    sectionTitleGroup: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      overflow: "hidden",
    },
    sectionHeadingActions: {
      flexShrink: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    sectionActionBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    sectionTitle: { color: palette.textFaint, fontSize: 12, fontWeight: "600", letterSpacing: 0.3 },
    sectionMetaCount: { color: palette.textFaint, fontSize: 11.5, fontVariant: ["tabular-nums"] },

    workspaceSearchBar: {
      minHeight: 36,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      paddingHorizontal: 11,
      borderRadius: 12,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      overflow: "hidden",
    },
    workspaceSearchInput: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 6,
      color: palette.text,
      fontSize: 13,
    },
    searchClearBtn: {
      width: 24,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
    },
    searchEmptyText: {
      ...themedFont.meta,
      textAlign: "center",
      paddingVertical: 18,
    },

    recentSection: { gap: 8 },
    recentList: { gap: 8, paddingRight: space.md },
    recentCard: {
      width: 232,
      minHeight: 52,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 15,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    recentCardPressed: { backgroundColor: palette.pressed },
    recentCopy: { flex: 1, minWidth: 0, gap: 2 },
    recentTitle: { ...themedFont.body, fontSize: 13.5, fontWeight: "600", letterSpacing: -0.1 },
    recentMeta: { color: palette.textFaint, fontSize: 11 },

    taskSection: { paddingTop: space.lg, gap: space.sm },
    taskHeading: {
      minHeight: 50,
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: 15,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    taskHeadingCopy: { flex: 1, minWidth: 0, gap: 2 },
    taskTitle: { ...themedFont.body, fontSize: 14, fontWeight: "600" },
    taskSummary: { ...themedFont.meta, color: palette.textDim },
    taskProjects: { gap: space.sm },

    nestedTaskWrap: {
      marginTop: 6,
      marginHorizontal: 4,
      marginBottom: 4,
      borderRadius: 12,
      backgroundColor: palette.surfaceRaised,
      overflow: "hidden",
    },
    nestedTaskToggle: {
      minHeight: 38,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    nestedTaskTitle: { flex: 1, minWidth: 0, color: palette.textDim, fontSize: 12.5, fontWeight: "600" },
    nestedTaskMeta: { color: palette.textFaint, fontSize: 11 },
    nestedTaskList: {
      gap: 6,
      paddingHorizontal: 6,
      paddingBottom: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    nestedTaskCard: {
      marginTop: 6,
      borderRadius: 10,
      backgroundColor: palette.surface,
      paddingHorizontal: 4,
      paddingVertical: 4,
    },
    nestedTaskCardHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    nestedTaskCardCopy: { flex: 1, minWidth: 0, gap: 1 },
    nestedTaskCardName: { color: palette.text, fontSize: 12.5, fontWeight: "600" },
    nestedTaskCardPath: { color: palette.textFaint, fontSize: 10.5 },

    inlinePlusBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.surfaceRaised,
    },

    emptySavedWorkspace: {
      paddingHorizontal: 12,
      paddingVertical: 14,
      alignItems: "center",
      gap: 10,
    },
    emptySavedWorkspaceText: { ...themedFont.meta, fontSize: 12.5 },
    emptySavedWorkspaceActions: { flexDirection: "row", alignItems: "center", gap: 8 },
    emptySavedPrimaryBtn: {
      minHeight: 32,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 12,
      borderRadius: radius.pill,
      backgroundColor: palette.text,
    },
    emptySavedPrimaryText: { color: palette.bg, fontSize: 12, fontWeight: "600" },
    emptySavedGhostBtn: {
      minHeight: 32,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 12,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceRaised,
    },
    emptySavedGhostText: { color: palette.textDim, fontSize: 12, fontWeight: "500" },

    archivedEmptyNote: { ...themedFont.sub, lineHeight: 20, paddingVertical: 16 },
    archivedList: { paddingBottom: space.sm },

    projectGap: { height: 6 },
    projectCard: {
      minHeight: 58,
      borderRadius: 16,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    projectCardExpanded: {
      backgroundColor: palette.surface,
    },
    projectCardSplit: {
      borderRadius: 14,
      backgroundColor: "transparent",
    },
    projectCardSplitSelected: {
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    projectHeader: {
      minHeight: 58,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 16,
    },
    projectHeaderSplit: {
      minHeight: 50,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 14,
    },
    projectHeaderSelected: {
      backgroundColor: palette.surface,
    },
    projectCardPressed: { borderRadius: radius.md, backgroundColor: palette.pressed },
    projectIcon: {
      width: 30,
      height: 30,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 9,
      backgroundColor: palette.surfaceRaised,
    },
    projectIconSelected: {
      backgroundColor: palette.text,
    },
    projectPending: { color: palette.warn, fontWeight: "600" },
    locatorRest: { transform: [{ rotate: "0deg" }] },
    sessionList: {
      paddingHorizontal: 6,
      paddingBottom: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    sessionDivider: {
      height: StyleSheet.hairlineWidth,
      marginLeft: 48,
      marginRight: 10,
      backgroundColor: palette.border,
    },
    sessionRow: {
      minHeight: 56,
      flexDirection: "row",
      alignItems: "center",
      gap: 11,
      paddingHorizontal: 10,
      paddingVertical: 9,
      borderRadius: 12,
    },
    sessionRowPressed: { backgroundColor: palette.pressed },
    sessionCopy: { flex: 1, minWidth: 0, gap: 3 },
    sessionTitleRow: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 },
    sessionTitle: { ...themedFont.body, fontSize: 14.5, fontWeight: "600", letterSpacing: -0.15, flexShrink: 1 },
    sessionPreview: { ...themedFont.meta, color: palette.textFaint, fontSize: 12 },
    sessionState: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceRaised,
    },
    sessionStateActive: { backgroundColor: palette.successBg },
    sessionStateWarn: { backgroundColor: palette.warnBg },
    sessionStatusDot: { width: 5.5, height: 5.5, borderRadius: 3 },
    sessionStatusText: { ...themedFont.meta, color: palette.textDim, fontSize: 11 },

    workspaceEmpty: {
      flex: 1,
      minHeight: 240,
      alignItems: "center",
      justifyContent: "center",
      gap: space.md,
      paddingHorizontal: space.xl,
      paddingVertical: space.xl,
      borderRadius: radius.lg,
      backgroundColor: palette.surface,
    },
    emptyIcon: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 16,
      backgroundColor: palette.surfaceRaised,
    },
    emptyTitle: { ...themedFont.title, fontSize: 16, textAlign: "center" },
    emptyDetail: { ...themedFont.sub, maxWidth: 340, lineHeight: 19, textAlign: "center" },
    emptyAction: {
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: space.xl,
      borderRadius: radius.pill,
      backgroundColor: palette.accentBg,
    },
    emptyActionPressed: { backgroundColor: palette.pressed },
    emptyActionText: { color: palette.accent, fontSize: 14, fontWeight: "600" },
  });
}
