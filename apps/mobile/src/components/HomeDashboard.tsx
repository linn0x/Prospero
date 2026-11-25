import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Alert,
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
import { useFocusEffect } from "expo-router";
import type { OrchestrationWorktreeAsset, SessionInfo } from "@prospero/protocol";

import { AgentIcon } from "@/components/AgentIcon";
import { Icon } from "@/components/Icon";
import { PromptDialog } from "@/components/PromptDialog";
import { Sheet, SheetAction } from "@/components/Sheet";
import { SplitPaneDivider } from "@/components/SplitPaneDivider";
import { SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { WorkspaceFolderIcon } from "@/components/WorkspaceDisclosure";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import type { HostConnection } from "@/lib/connection";
import type { StoredHost } from "@/lib/hosts";
import {
  compactWorkspacePath,
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
import { projectName, type SessionProject } from "@/lib/session-projects";
import { supportsRemoteTerminal } from "@/lib/terminal-session";
import type { ConnStatus, HostRuntime } from "@/lib/store";
import { recentSessions as recentSessionStore } from "@/lib/recent-sessions";
import {
  buildAlignedWorkspaceTree,
  desktopSidebarSessionLabel,
  filterMobileSessionsByQuery,
  homeInboxSessions,
  inboxReasonLabel,
  sessionWorkbenchSubtitle,
  sidebarSessionRowDisplay,
  sortWorkspaceSessions,
  useHydratedWorkspaceConcepts,
  workspacePathKey,
} from "@/lib/workspace-concepts";
import {
  font,
  MONOSPACE_FONT,
  radius,
  space,
  useMobileTheme,
  type ThemePalette,
} from "@/lib/theme";

type HomeDashboardStyles = ReturnType<typeof createStyles>;
type WorkbenchFilter = "workspace" | "all" | "running" | "archived";
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

function hostConnectionTone(runtime: HostRuntime | undefined, palette: ThemePalette): string {
  const status = runtime?.status ?? "idle";
  if (status === "connected") {
    return runtime?.rttMs !== null && runtime?.rttMs !== undefined && runtime.rttMs >= 300
      ? palette.warn
      : palette.success;
  }
  if (status === "connecting" || status === "reconnecting") return palette.warn;
  if (status === "failed") return palette.danger;
  return palette.textFaint;
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

export function HomeDashboard({
  hosts,
  runtimes,
  selectedHostId,
  connection = null,
  devicePickerOpen,
  bottomInset,
  onToggleDevicePicker: _onToggleDevicePicker,
  onCloseDevicePicker,
  onSelectHost,
  onOpenHost,
  onOpenBots,
  onOpenAccounts,
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
  onOpenBots?: (hostId: string) => void;
  onOpenAccounts?: (hostId: string) => void;
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

  const effectiveHomeSettings = normalizeHomeSettings(homeSettings ?? DEFAULT_HOME_SETTINGS);
  const displayProjectName = useCallback(
    (path: string, fallback: string): string =>
      selectedHost
        ? (effectiveHomeSettings.workspaceAliases[workspaceAliasKey(selectedHost.id, path)] ?? fallback)
        : fallback,
    [effectiveHomeSettings.workspaceAliases, selectedHost],
  );

  const allProjects = useMemo(
    () => homeWorkspaceProjects(selectedRuntime?.sessions),
    [selectedRuntime?.sessions],
  );

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

  const allLiveSessions = useMemo(
    () =>
      sortWorkspaceSessions(
        Object.values(selectedRuntime?.sessions ?? {}).filter((session) => session.archived !== true),
        pinnedSessionIds,
      ),
    [pinnedSessionIds, selectedRuntime?.sessions],
  );
  const runningSessionList = useMemo(
    () =>
      allLiveSessions.filter(
        (session) =>
          session.status === "running" ||
          session.status === "starting" ||
          session.status === "waiting_approval" ||
          session.status === "waiting_input" ||
          (session.pendingPermissions ?? 0) > 0 ||
          (session.pendingQuestions ?? 0) > 0,
      ),
    [allLiveSessions],
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
    () => allLiveSessions.filter((session) => pinnedSessionIds.has(session.id)),
    [allLiveSessions, pinnedSessionIds],
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

  const [expandedProjectKeys, setExpandedProjectKeys] = useState<Set<string>>(() => new Set());
  const [expandedChildTaskKeys, setExpandedChildTaskKeys] = useState<Set<string>>(() => new Set());
  const [selectedSplitPath, setSelectedSplitPath] = useState<string | null>(null);
  const [workbenchFilter, setWorkbenchFilter] = useState<WorkbenchFilter>("workspace");
  const [phoneFilter, setPhoneFilter] = useState<"all" | "running" | "archived">("all");
  const [expandedTaskHostId, setExpandedTaskHostId] = useState<string | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [archivedSheetOpen, setArchivedSheetOpen] = useState(false);
  const [addWorkspacePickerOpen, setAddWorkspacePickerOpen] = useState(false);
  const [manualWorkspaceOpen, setManualWorkspaceOpen] = useState(false);
  const [manualWorkspacePath, setManualWorkspacePath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [editingProject, setEditingProject] = useState<SessionProject | null>(null);
  const [projectAlias, setProjectAlias] = useState("");
  const [deviceNavigation] = useState(() => new DismissedModalAction());
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
    workspaceMenuNavigation.cancel();
    closeDevicePickerRef.current();
    setWorkspaceMenuOpen(false);
    setArchivedSheetOpen(false);
    setAddWorkspacePickerOpen(false);
    setManualWorkspaceOpen(false);
    setEditingProject(null);
  }, [deviceNavigation, workspaceMenuNavigation]);

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
  const taskProjectsExpanded = expandedTaskHostId === selectedHost.id;
  const taskRunningCount = taskProjects.reduce((total, project) => total + project.runningCount, 0);
  const taskPendingCount = taskProjects.reduce((total, project) => total + project.pendingCount, 0);
  const canOpenTerminal = Boolean(onOpenTerminals && supportsRemoteTerminal(selectedRuntime?.hostInfo));

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
    setWorkbenchFilter("workspace");
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

  const renderWorkbenchRow = (
    session: SessionInfo,
    index = 0,
    options?: { showWorkspacePath?: boolean; dense?: boolean },
  ) => {
    const conciseTitle = desktopSidebarSessionLabel(session);
    const isRunning = session.status === "running" || session.status === "starting";
    const isAttention = session.status === "waiting_approval" || session.status === "waiting_input";
    const isPinned = pinnedSessionIds.has(session.id);
    const workspaceLabel = options?.showWorkspacePath
      ? displayProjectName(session.cwd, projectName(session.cwd))
      : undefined;
    const subtitle = sessionWorkbenchSubtitle(
      session,
      workspaceLabel ? { showWorkspace: workspaceLabel } : undefined,
    );
    const modeTag = session.kind === "pty" ? "TUI" : "对话";

    return (
      <View key={session.id}>
        {index > 0 && <View style={styles.rowHairline} />}
        <SwipeRow
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
              styles.workbenchRow,
              options?.dense && styles.workbenchRowDense,
              pressed && styles.rowPressed,
            ]}
          >
            <AgentIcon agent={session.agent} size={15} badge badgeOutline={false} />
            <View style={styles.workbenchRowCopy}>
              <View style={styles.workbenchRowHead}>
                <Text style={styles.workbenchRowTitle} numberOfLines={1}>
                  {conciseTitle}
                </Text>
                <View style={styles.modeChip}>
                  <Text style={styles.modeChipText}>{modeTag}</Text>
                </View>
                {isPinned && <Icon name="pin.fill" size={10} color={palette.textFaint} />}
              </View>
              <Text style={styles.workbenchRowSub} numberOfLines={1}>
                {subtitle}
              </Text>
            </View>
            <View
              style={[
                styles.statusBadge,
                isRunning && styles.statusBadgeActive,
                isAttention && styles.statusBadgeWarn,
              ]}
            >
              <View
                style={[
                  styles.statusDotSmall,
                  { backgroundColor: statusTone(session.status, palette) },
                ]}
              />
              <Text
                style={[
                  styles.statusBadgeText,
                  isRunning && { color: palette.success, fontWeight: "600" },
                  isAttention && { color: palette.warn, fontWeight: "600" },
                ]}
              >
                {session.archived ? "已归档" : sessionStatusLabel[session.status]}
              </Text>
            </View>
            <Icon name="chevron.right" size={11} color={palette.textFaint} />
          </Pressable>
        </SwipeRow>
      </View>
    );
  };

  const renderSidebarTreeSession = (session: SessionInfo, options?: { showFolder?: boolean }) => {
    const folder = options?.showFolder
      ? displayProjectName(session.cwd, projectName(session.cwd))
      : undefined;
    const display = sidebarSessionRowDisplay(session, folder ? { folderLabel: folder } : undefined);

    return (
      <Pressable
        key={session.id}
        accessibilityRole="button"
        accessibilityLabel={`打开会话 ${display.title}，${sessionStatusLabel[session.status]}`}
        onPress={() => onOpenSession(selectedHost.id, session.id)}
        style={({ pressed }) => [styles.treeSessionRow, pressed && styles.rowPressed]}
      >
        <AgentIcon agent={session.agent} size={13} />
        <Text style={styles.treeSessionTitle} numberOfLines={1}>
          {display.title}
        </Text>
        {display.meta ? (
          <Text style={styles.treeSessionMeta} numberOfLines={1}>
            {display.meta}
          </Text>
        ) : null}
        <View
          style={[
            styles.statusDotSmall,
            { backgroundColor: statusTone(session.status, palette) },
          ]}
        />
      </Pressable>
    );
  };

  const renderNestedTaskWorkspaces = (
    parentPath: string,
    childTasks: readonly SessionProject[],
    dense = false,
  ) => {
    if (childTasks.length === 0) return null;
    const toggleKey = `${selectedHost.id}:${workspacePathKey(parentPath)}`;
    const childRunning = childTasks.reduce((sum, item) => sum + item.runningCount, 0);
    const childPending = childTasks.reduce((sum, item) => sum + item.pendingCount, 0);
    const autoExpand = childRunning > 0 || childPending > 0;
    const expanded =
      expandedChildTaskKeys.has(toggleKey) ||
      (autoExpand && !expandedChildTaskKeys.has(`closed:${toggleKey}`));

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
          style={({ pressed }) => [styles.nestedTaskToggle, pressed && styles.rowPressed]}
        >
          <Icon name={expanded ? "chevron.down" : "chevron.right"} size={11} color={palette.textFaint} />
          <Icon name="arrow.triangle.branch" size={12} color={palette.textDim} />
          <Text style={styles.nestedTaskTitle} numberOfLines={1}>
            任务工作区 · {String(childTasks.length)}
          </Text>
          {(childRunning > 0 || childPending > 0) && (
            <Text style={[styles.nestedTaskMeta, childPending > 0 && styles.pendingText]} numberOfLines={1}>
              {[
                childRunning > 0 ? `${String(childRunning)} 运行` : null,
                childPending > 0 ? `${String(childPending)} 待处理` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          )}
        </Pressable>
        {expanded && (
          <View style={styles.nestedTaskList}>
            {childTasks.map((taskProject) => {
              const sortedTaskSessions = sortWorkspaceSessions(taskProject.sessions, pinnedSessionIds);
              return (
                <View key={taskProject.path} style={styles.nestedTaskGroup}>
                  <View style={styles.nestedTaskGroupHead}>
                    <Text style={styles.nestedTaskGroupName} numberOfLines={1}>
                      {displayProjectName(taskProject.path, taskProject.name)}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`在 ${taskProject.name} 中新建会话`}
                      onPress={() => onCreateSession(selectedHost.id, taskProject.path)}
                      style={({ pressed }) => [styles.treeInlineBtn, pressed && styles.rowPressed]}
                    >
                      <Icon name="plus" size={12} color={palette.textDim} weight="semibold" />
                    </Pressable>
                  </View>
                  <View style={styles.nestedTaskSessions}>
                    {sortedTaskSessions.map((session, idx) =>
                      renderWorkbenchRow(session, idx, { dense }),
                    )}
                  </View>
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
    const splitSelected = splitLayout && activeSplitProject?.path === project.path;
    const singleAutoExpanded =
      projects.length === 1 && !expandedProjectKeys.has(`collapsed:${projectKey}`);
    const expanded = splitLayout
      ? (splitSelected && !expandedProjectKeys.has(`collapsed:${projectKey}`)) ||
        expandedProjectKeys.has(projectKey)
      : singleAutoExpanded || expandedProjectKeys.has(projectKey);
    const displayName = displayProjectName(project.path, project.name);
    const sortedSessions = sortWorkspaceSessions(project.sessions, pinnedSessionIds);
    const combinedPending = project.pendingCount + childTasks.reduce((s, c) => s + c.pendingCount, 0);
    const combinedRunning = project.runningCount + childTasks.reduce((s, c) => s + c.runningCount, 0);

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

    const toggleWorkspaceTree = (): void => {
      if (splitLayout) {
        if (!splitSelected) {
          setSelectedSplitPath(project.path);
          setWorkbenchFilter("workspace");
          setExpandedProjectKeys((current) => {
            const next = new Set(current);
            next.delete(`collapsed:${projectKey}`);
            next.add(projectKey);
            return next;
          });
          return;
        }
        setExpandedProjectKeys((current) => {
          const next = new Set(current);
          if (expanded) {
            next.delete(projectKey);
            next.add(`collapsed:${projectKey}`);
          } else {
            next.delete(`collapsed:${projectKey}`);
            next.add(projectKey);
          }
          return next;
        });
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
    };

    if (splitLayout) {
      return (
        <View key={projectKey} collapsable={false} style={styles.treeFolderBlock}>
          <SwipeRow clipRadius={8} actions={swipeActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: splitSelected, expanded }}
              accessibilityLabel={`${displayName}，${String(project.sessions.length)} 个会话，${project.path}`}
              onPress={toggleWorkspaceTree}
              style={({ pressed }) => [
                styles.treeFolderRow,
                splitSelected && styles.treeFolderRowSelected,
                pressed && styles.rowPressed,
              ]}
            >
              {splitSelected && <View style={styles.treeActiveBar} />}
              <Icon
                name={expanded ? "chevron.down" : "chevron.right"}
                size={10}
                color={palette.textFaint}
              />
              <WorkspaceFolderIcon
                expanded={expanded}
                size={14}
                color={splitSelected ? palette.accent : palette.textDim}
              />
              <Text
                style={[styles.treeFolderName, splitSelected && styles.treeFolderNameSelected]}
                numberOfLines={1}
              >
                {displayName}
              </Text>
              {isPinned && <Icon name="pin.fill" size={10} color={palette.textFaint} />}
              {(combinedPending > 0 || combinedRunning > 0) && (
                <View
                  style={[
                    styles.treeActivityDot,
                    { backgroundColor: combinedPending > 0 ? palette.warn : palette.success },
                  ]}
                />
              )}
              <Text style={styles.treeFolderCount}>{String(project.sessions.length)}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`在 ${displayName} 中新建会话`}
                hitSlop={6}
                onPress={() => onCreateSession(selectedHost.id, project.path)}
                style={({ pressed }) => [styles.treeInlineBtn, pressed && styles.rowPressed]}
              >
                <Icon name="plus" size={12} color={palette.textDim} weight="semibold" />
              </Pressable>
            </Pressable>
          </SwipeRow>
          {expanded && (sortedSessions.length > 0 || childTasks.length > 0) && (
            <View style={styles.treeChildrenGuide}>
              {sortedSessions.map((session) => renderSidebarTreeSession(session))}
              {childTasks.map((taskWs) => (
                <View key={taskWs.path} style={styles.treeWorktreeSub}>
                  <Text style={styles.treeWorktreeSubTitle} numberOfLines={1}>
                    ⑂ {displayProjectName(taskWs.path, taskWs.name)}
                  </Text>
                  {sortWorkspaceSessions(taskWs.sessions, pinnedSessionIds).map((session) =>
                    renderSidebarTreeSession(session),
                  )}
                </View>
              ))}
            </View>
          )}
        </View>
      );
    }

    return (
      <View
        key={projectKey}
        collapsable={false}
        style={[styles.phoneWorkspaceBlock, expanded && styles.phoneWorkspaceBlockExpanded]}
      >
        <SwipeRow clipRadius={10} actions={swipeActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`${displayName}，${String(project.sessions.length)} 个会话，${project.path}`}
            onPress={toggleWorkspaceTree}
            style={({ pressed }) => [styles.phoneFolderRow, pressed && styles.rowPressed]}
          >
            <Icon
              name={expanded ? "chevron.down" : "chevron.right"}
              size={11}
              color={palette.textFaint}
            />
            <WorkspaceFolderIcon expanded={expanded} size={15} color={palette.textDim} />
            <View style={styles.phoneFolderCopy}>
              <View style={styles.phoneFolderTitleRow}>
                <Text style={styles.phoneFolderName} numberOfLines={1}>
                  {displayName}
                </Text>
                {isPinned && <Icon name="pin.fill" size={10} color={palette.textFaint} />}
              </View>
              <Text style={styles.phoneFolderPath} numberOfLines={1} ellipsizeMode="middle">
                {compactWorkspacePath(project.path)}
              </Text>
            </View>
            {(combinedPending > 0 || combinedRunning > 0) && (
              <View
                style={[
                  styles.treeActivityDot,
                  { backgroundColor: combinedPending > 0 ? palette.warn : palette.success },
                ]}
              />
            )}
            <Text style={styles.treeFolderCount}>{String(project.sessions.length)}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`在 ${displayName} 中新建会话`}
              hitSlop={6}
              onPress={() => onCreateSession(selectedHost.id, project.path)}
              style={({ pressed }) => [styles.treeInlineBtn, pressed && styles.rowPressed]}
            >
              <Icon name="plus" size={13} color={palette.textDim} weight="semibold" />
            </Pressable>
          </Pressable>
        </SwipeRow>
        {expanded ? (
          <View style={styles.phoneSessionTree}>
            {sortedSessions.length > 0 ? (
              sortedSessions.map((session, idx) => renderWorkbenchRow(session, idx, { dense: true }))
            ) : (
              <View style={styles.emptySavedWorkspace}>
                <Text style={styles.emptySavedWorkspaceText}>此工作区暂无活跃会话</Text>
                <View style={styles.emptySavedWorkspaceActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onCreateSession(selectedHost.id, project.path)}
                    style={({ pressed }) => [styles.emptySavedPrimaryBtn, pressed && styles.ctaPressed]}
                  >
                    <Icon name="plus" size={12} color={palette.bg} weight="semibold" />
                    <Text style={styles.emptySavedPrimaryText}>新建会话</Text>
                  </Pressable>
                  {isSaved && (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => forgetWorkspace(selectedHost.id, project.path)}
                      style={({ pressed }) => [styles.emptySavedGhostBtn, pressed && styles.rowPressed]}
                    >
                      <Text style={styles.emptySavedGhostText}>从列表移除</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )}
            {renderNestedTaskWorkspaces(project.path, childTasks, true)}
          </View>
        ) : null}
      </View>
    );
  };

  const connectionBanner =
    selectedRuntime?.status !== "connected" ? (
      <View style={styles.connBanner}>
        <View style={styles.connBannerLeft}>
          <View
            style={[
              styles.statusDotSmall,
              { backgroundColor: hostConnectionTone(selectedRuntime, palette) },
            ]}
          />
          <Text style={styles.connBannerText} numberOfLines={1}>
            {selectedRuntime?.status === "failed"
              ? (selectedRuntime.lastError ?? `${selectedHost.name} 连接失败`)
              : `${selectedHost.name} · ${statusLabel[selectedRuntime?.status ?? "idle"]}`}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="重新连接"
          onPress={() => onRefreshHost(selectedHost.id)}
          hitSlop={8}
        >
          <Text style={styles.connRetry}>重试</Text>
        </Pressable>
      </View>
    ) : null;

  const inboxSection = inboxSessions.length > 0 ? (
    <View style={styles.sidebarSection} testID="home-approval-sessions">
      <View style={styles.sidebarSectionHead}>
        <Text style={styles.sidebarSectionLabel}>待处理</Text>
        <Text style={styles.inboxBadge}>{String(inboxSessions.length)}</Text>
      </View>
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
              styles.inboxRow,
              isApproval ? styles.inboxRowWarn : styles.inboxRowAccent,
              pressed && styles.rowPressed,
            ]}
          >
            <AgentIcon agent={session.agent} size={14} badge badgeOutline={false} />
            <View style={styles.treeSessionCopy}>
              <Text style={styles.treeSessionLabel} numberOfLines={1}>
                {desktopSidebarSessionLabel(session)}
              </Text>
              <Text
                style={[styles.inboxRowDetail, !isApproval && styles.inboxRowDetailAccent]}
                numberOfLines={1}
              >
                {`${inboxReasonLabel(session)} · ${displayProjectName(session.cwd, projectName(session.cwd))}`}
              </Text>
            </View>
            <Icon
              name={isApproval ? "exclamationmark.triangle.fill" : "bubble.left.and.text.bubble.right"}
              size={12}
              color={isApproval ? palette.warn : palette.accent}
            />
          </Pressable>
        );
      })}
    </View>
  ) : null;

  const pinnedSection = !isSearching && pinnedSessionList.length > 0 ? (
    <View style={styles.sidebarSection}>
      <View style={styles.sidebarSectionHead}>
        <Icon name="pin.fill" size={10} color={palette.textFaint} />
        <Text style={styles.sidebarSectionLabel}>置顶会话</Text>
      </View>
      {pinnedSessionList.map((session) => renderSidebarTreeSession(session, { showFolder: true }))}
    </View>
  ) : null;

  const searchAndToolbar = (
    <View style={styles.toolbarBlock}>
      <View style={styles.searchToolbarRow}>
        <View style={styles.searchField}>
          <Icon name="magnifyingglass" size={13} color={palette.textFaint} />
          <TextInput
            style={styles.searchInput}
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
              <Icon name="xmark.circle.fill" size={13} color={palette.textFaint} />
            </Pressable>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="添加工作区"
          hitSlop={6}
          onPress={openAddWorkspaceFlow}
          style={({ pressed }) => [styles.toolbarIconBtn, pressed && styles.rowPressed]}
        >
          <Icon name="folder.badge.plus" size={15} color={palette.textDim} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="工作区更多操作"
          hitSlop={6}
          onPress={() => {
            workspaceMenuNavigation.cancel();
            setWorkspaceMenuOpen(true);
          }}
          style={({ pressed }) => [styles.toolbarIconBtn, pressed && styles.rowPressed]}
        >
          <Icon name="ellipsis.circle" size={15} color={palette.textDim} />
        </Pressable>
      </View>
      {isSearching && (
        <View style={styles.workbenchTable}>
          {searchResults.length > 0 ? (
            searchResults.map((session, idx) =>
              renderWorkbenchRow(session, idx, { showWorkspacePath: true, dense: true }),
            )
          ) : (
            <Text style={styles.searchEmptyText}>没有匹配的会话</Text>
          )}
        </View>
      )}
    </View>
  );

  const taskWorkspaceFooter = !isSearching && taskProjects.length > 0 ? (
    <View style={styles.taskFooter}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: taskProjectsExpanded }}
        accessibilityLabel={`任务工作区，${String(taskProjects.length)} 个工作树，${String(taskRunningCount)} 个运行中，${String(taskPendingCount)} 项待处理`}
        onPress={() => setExpandedTaskHostId(taskProjectsExpanded ? null : selectedHost.id)}
        style={({ pressed }) => [styles.taskFooterHead, pressed && styles.rowPressed]}
      >
        <Icon
          name={taskProjectsExpanded ? "chevron.down" : "chevron.right"}
          size={11}
          color={palette.textFaint}
        />
        <Icon name="arrow.triangle.branch" size={12} color={palette.textDim} />
        <Text style={styles.taskFooterTitle} numberOfLines={1}>
          任务工作区 · {String(taskProjects.length)}
        </Text>
        {taskRunningCount + taskPendingCount > 0 && (
          <Text style={[styles.taskFooterCount, taskPendingCount > 0 && styles.pendingText]}>
            {taskPendingCount > 0 ? `${String(taskPendingCount)} 待处理` : `${String(taskRunningCount)} 运行`}
          </Text>
        )}
      </Pressable>
      {taskProjectsExpanded && (
        <View style={styles.taskFooterChildren}>{taskProjects.map(renderProject)}</View>
      )}
    </View>
  ) : null;

  const recentChipStrip = !isSearching && visibleRecentSessions.length > 0 ? (
    <View style={styles.recentStripWrap} testID="home-recent-section">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.recentStripContent}
      >
        <Text style={styles.recentStripLabel}>最近</Text>
        {visibleRecentSessions.map((session) => (
          <Pressable
            key={session.id}
            accessibilityRole="button"
            accessibilityLabel={`打开最近会话 ${desktopSidebarSessionLabel(session)}，${homeRecentSummary(session, recentUsage[session.id])}`}
            onPress={() => onOpenSession(selectedHost.id, session.id)}
            style={({ pressed }) => [styles.recentChip, pressed && styles.rowPressed]}
          >
            <AgentIcon agent={session.agent} size={12} badge badgeOutline={false} />
            <Text style={styles.recentChipTitle} numberOfLines={1}>
              {`${displayProjectName(session.cwd, projectName(session.cwd))} · ${desktopSidebarSessionLabel(session)}`}
            </Text>
            <View
              style={[
                styles.statusDotSmall,
                { backgroundColor: statusTone(session.status, palette) },
              ]}
            />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  ) : null;

  const activeWorkspaceLabel = activeSplitProject
    ? displayProjectName(activeSplitProject.path, activeSplitProject.name)
    : "工作区";
  const activeWorkspaceSessions = activeSplitProject
    ? sortWorkspaceSessions(activeSplitProject.sessions, pinnedSessionIds)
    : [];

  const workbenchListSessions =
    workbenchFilter === "all"
      ? allLiveSessions
      : workbenchFilter === "running"
        ? runningSessionList
        : workbenchFilter === "archived"
          ? archivedSessionList
          : activeWorkspaceSessions;

  const visibleWorkspaceList = isSearching ? [] : projects;

  const splitRightPane = (
    <ScrollView
      style={{ width: splitPanes?.end, flexGrow: 0, overflow: "hidden" }}
      contentContainerStyle={[styles.workbenchScroll, { paddingBottom: bottomInset + space.xl }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {connectionBanner}
      <View style={styles.filterChipRow}>
        {(
          [
            { id: "workspace", label: activeWorkspaceLabel },
            { id: "all", label: `全部活跃 ${String(allLiveSessions.length)}` },
            { id: "running", label: `运行中 ${String(stats.runningCount)}` },
            { id: "archived", label: `已归档 ${String(archivedSessionList.length)}` },
          ] as const
        ).map((tab) => {
          const active = workbenchFilter === tab.id;
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => setWorkbenchFilter(tab.id)}
              style={({ pressed }) => [
                styles.filterChip,
                active && styles.filterChipActive,
                pressed && styles.rowPressed,
              ]}
            >
              <Text
                style={[styles.filterChipText, active && styles.filterChipTextActive]}
                numberOfLines={1}
              >
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {recentChipStrip}

      {workbenchFilter === "workspace" && activeSplitProject ? (
        <View style={styles.workbenchDetail}>
          <View style={styles.workbenchHeader}>
            <View style={styles.workbenchHeaderCopy}>
              <View style={styles.workbenchTitleRow}>
                <Text style={styles.workbenchTitle} numberOfLines={1}>
                  {activeWorkspaceLabel}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="重命名工作区"
                  hitSlop={6}
                  onPress={() => {
                    setEditingProject(activeSplitProject);
                    setProjectAlias(activeWorkspaceLabel);
                  }}
                  style={({ pressed }) => [styles.microIconBtn, pressed && styles.rowPressed]}
                >
                  <Icon name="pencil" size={12} color={palette.textFaint} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    pinnedWorkspaceKeys.has(workspacePathKey(activeSplitProject.path))
                      ? "取消置顶工作区"
                      : "置顶工作区"
                  }
                  hitSlop={6}
                  onPress={() => togglePinWorkspace(selectedHost.id, activeSplitProject.path)}
                  style={({ pressed }) => [styles.microIconBtn, pressed && styles.rowPressed]}
                >
                  <Icon
                    name={
                      pinnedWorkspaceKeys.has(workspacePathKey(activeSplitProject.path))
                        ? "pin.fill"
                        : "pin"
                    }
                    size={12}
                    color={
                      pinnedWorkspaceKeys.has(workspacePathKey(activeSplitProject.path))
                        ? palette.accent
                        : palette.textFaint
                    }
                  />
                </Pressable>
              </View>
              <Text style={styles.workbenchPath} numberOfLines={1} ellipsizeMode="middle">
                {compactWorkspacePath(activeSplitProject.path)}
              </Text>
            </View>
            <View style={styles.workbenchActions}>
              {canOpenTerminal && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="在当前工作区打开终端"
                  onPress={() => onOpenTerminals?.(selectedHost.id, activeSplitProject.path)}
                  style={({ pressed }) => [styles.workbenchGhostBtn, pressed && styles.rowPressed]}
                >
                  <Icon name="terminal" size={13} color={palette.text} />
                  <Text style={styles.workbenchGhostText}>终端</Text>
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="在当前工作区新建会话"
                onPress={() => onCreateSession(selectedHost.id, activeSplitProject.path)}
                style={({ pressed }) => [styles.workbenchPrimaryBtn, pressed && styles.ctaPressed]}
              >
                <Icon name="plus" size={13} color={palette.bg} weight="semibold" />
                <Text style={styles.workbenchPrimaryText}>新建会话</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.workbenchTable}>
            {activeWorkspaceSessions.length > 0 ? (
              activeWorkspaceSessions.map((session, idx) => renderWorkbenchRow(session, idx))
            ) : (
              <View style={styles.emptySavedWorkspace}>
                <Text style={styles.emptySavedWorkspaceText}>此工作区暂无活跃会话</Text>
                <View style={styles.emptySavedWorkspaceActions}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => onCreateSession(selectedHost.id, activeSplitProject.path)}
                    style={({ pressed }) => [styles.emptySavedPrimaryBtn, pressed && styles.ctaPressed]}
                  >
                    <Icon name="plus" size={12} color={palette.bg} weight="semibold" />
                    <Text style={styles.emptySavedPrimaryText}>新建会话</Text>
                  </Pressable>
                  {savedWorkspaceKeys.has(workspacePathKey(activeSplitProject.path)) && (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => forgetWorkspace(selectedHost.id, activeSplitProject.path)}
                      style={({ pressed }) => [styles.emptySavedGhostBtn, pressed && styles.rowPressed]}
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
      ) : (
        <View style={styles.workbenchDetail}>
          <View style={styles.workbenchTable}>
            {workbenchListSessions.length > 0 ? (
              workbenchListSessions.map((session, idx) =>
                renderWorkbenchRow(session, idx, { showWorkspacePath: true }),
              )
            ) : (
              <Text style={styles.searchEmptyText}>
                {workbenchFilter === "running"
                  ? "当前没有运行中或等待处理的会话"
                  : workbenchFilter === "archived"
                    ? "当前没有已归档会话"
                    : "暂无活跃会话"}
              </Text>
            )}
          </View>
        </View>
      )}
    </ScrollView>
  );

  return (
    <>
      {splitLayout && splitPanes ? (
        <View style={styles.splitContainer}>
          <FlatList
            ref={homeListRef}
            testID="home-workspace-list"
            style={[styles.sidebarSurface, { width: splitPanes.start, flexGrow: 0, overflow: "hidden" }]}
            data={visibleWorkspaceList}
            extraData={`${activeSplitProject?.path ?? ""}:${String(expandedProjectKeys.size)}`}
            keyExtractor={(project) => project.path}
            removeClippedSubviews={false}
            contentContainerStyle={[styles.sidebarContent, { paddingBottom: bottomInset + space.xl }]}
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
              <View style={styles.sidebarHeader}>
                {searchAndToolbar}
                {inboxSection}
                {pinnedSection}
                <View style={styles.sidebarSectionHead}>
                  <Text style={styles.sidebarSectionLabel}>工作区</Text>
                  <Text style={styles.sidebarCount}>{String(projects.length)}</Text>
                  {workspaceSort === "name" && <Text style={styles.sidebarCount}>· 名称</Text>}
                </View>
              </View>
            }
            ListEmptyComponent={
              !isSearching && taskProjects.length === 0 ? (
                <WorkspaceEmptyState
                  host={selectedHost}
                  runtime={selectedRuntime}
                  onAddWorkspace={openAddWorkspaceFlow}
                  onRefresh={() => onRefreshHost(selectedHost.id)}
                  palette={palette}
                  styles={styles}
                />
              ) : null
            }
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
          {splitRightPane}
        </View>
      ) : (
        <FlatList
          ref={homeListRef}
          testID="home-workspace-list"
          data={phoneFilter === "all" && !isSearching ? projects : []}
          extraData={`${String(expandedProjectKeys.size)}:${phoneFilter}`}
          keyExtractor={(project) => project.path}
          removeClippedSubviews={false}
          contentContainerStyle={[styles.phoneList, { paddingBottom: bottomInset + space.xl }]}
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
            <View style={styles.phoneHeader}>
              {connectionBanner}
              {searchAndToolbar}
              <View style={styles.filterChipRow}>
                {(
                  [
                    { id: "all", label: `工作区 ${String(projects.length)}` },
                    { id: "running", label: `运行中 ${String(stats.runningCount)}` },
                    { id: "archived", label: `已归档 ${String(archivedSessionList.length)}` },
                  ] as const
                ).map((tab) => {
                  const active = phoneFilter === tab.id;
                  return (
                    <Pressable
                      key={tab.id}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: active }}
                      onPress={() => setPhoneFilter(tab.id)}
                      style={({ pressed }) => [
                        styles.filterChip,
                        active && styles.filterChipActive,
                        pressed && styles.rowPressed,
                      ]}
                    >
                      <Text
                        style={[styles.filterChipText, active && styles.filterChipTextActive]}
                        numberOfLines={1}
                      >
                        {tab.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {inboxSection}
              {recentChipStrip}
              {pinnedSection}
              {!isSearching && phoneFilter !== "all" && (
                <View style={styles.workbenchTable}>
                  {(phoneFilter === "running" ? runningSessionList : archivedSessionList).length > 0 ? (
                    (phoneFilter === "running" ? runningSessionList : archivedSessionList).map(
                      (session, idx) =>
                        renderWorkbenchRow(session, idx, { showWorkspacePath: true, dense: true }),
                    )
                  ) : (
                    <Text style={styles.searchEmptyText}>
                      {phoneFilter === "running" ? "当前没有运行中的会话" : "当前没有已归档会话"}
                    </Text>
                  )}
                </View>
              )}
            </View>
          }
          ListEmptyComponent={
            !isSearching && phoneFilter === "all" && taskProjects.length === 0 ? (
              <WorkspaceEmptyState
                host={selectedHost}
                runtime={selectedRuntime}
                onAddWorkspace={openAddWorkspaceFlow}
                onRefresh={() => onRefreshHost(selectedHost.id)}
                palette={palette}
                styles={styles}
              />
            ) : null
          }
          ItemSeparatorComponent={() => <View style={styles.phoneProjectGap} />}
          renderItem={({ item }) => renderProject(item)}
          ListFooterComponent={phoneFilter === "all" ? taskWorkspaceFooter : null}
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
                  style={({ pressed }) => [styles.deviceRow, pressed && styles.rowPressed]}
                >
                  <View
                    style={[
                      styles.statusDotSmall,
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
                    style={({ pressed }) => [styles.deviceAction, pressed && styles.rowPressed]}
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
            label="账号与模型源"
            detail="管理 Claude、Codex、Antigravity、Pi 登录态与 API 模型源"
            symbol="command"
            onPress={() => {
              deviceNavigation.defer(() => (onOpenAccounts ?? onOpenHost)(selectedHost.id));
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
          <View style={styles.workbenchTable}>
            {archivedSessionList.map((session, idx) =>
              renderWorkbenchRow(session, idx, { showWorkspacePath: true, dense: true }),
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
      <Icon
        name={unavailable ? "exclamationmark.triangle.fill" : "folder.fill"}
        size={26}
        color={unavailable ? palette.warn : palette.textFaint}
      />
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
        style={({ pressed }) => [styles.emptyAction, pressed && styles.rowPressed]}
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
    splitContainer: { flex: 1, flexDirection: "row", minHeight: 0, backgroundColor: palette.bg },
    sidebarSurface: { backgroundColor: palette.surface },
    sidebarContent: { paddingHorizontal: 8, paddingTop: 8, gap: 2 },
    sidebarHeader: { gap: 8, paddingBottom: 6 },
    sidebarSection: { gap: 2, paddingTop: 4 },
    sidebarSectionHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    sidebarSectionLabel: { color: palette.textFaint, fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },
    sidebarCount: { color: palette.textFaint, fontSize: 11, fontVariant: ["tabular-nums"] },

    toolbarBlock: { gap: 6 },
    searchToolbarRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    searchField: {
      flex: 1,
      minWidth: 0,
      height: 32,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      borderRadius: 8,
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    searchInput: { flex: 1, minWidth: 0, paddingVertical: 0, color: palette.text, fontSize: 12.5 },
    searchClearBtn: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
    toolbarIconBtn: {
      width: 30,
      height: 30,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    searchEmptyText: { ...themedFont.meta, textAlign: "center", paddingVertical: 20 },

    inboxBadge: {
      color: palette.warn,
      backgroundColor: palette.warnBg,
      fontSize: 10.5,
      fontWeight: "700",
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: radius.pill,
      overflow: "hidden",
    },
    inboxRow: {
      minHeight: 38,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: 8,
    },
    inboxRowWarn: { backgroundColor: palette.warnBg },
    inboxRowAccent: { backgroundColor: palette.accentBg },
    inboxRowDetail: { color: palette.warn, fontSize: 11, fontWeight: "600" },
    inboxRowDetailAccent: { color: palette.accent },

    treeFolderBlock: { gap: 1 },
    treeFolderRow: {
      position: "relative",
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: 8,
    },
    treeFolderRowSelected: {
      backgroundColor: palette.surfaceRaised,
    },
    treeActiveBar: {
      position: "absolute",
      left: 0,
      top: 7,
      bottom: 7,
      width: 3,
      borderRadius: 2,
      backgroundColor: palette.accent,
    },
    treeFolderName: {
      flex: 1,
      minWidth: 0,
      color: palette.textDim,
      fontSize: 13.5,
      fontWeight: "500",
    },
    treeFolderNameSelected: {
      color: palette.text,
      fontWeight: "700",
    },
    treeActivityDot: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
    treeFolderCount: {
      color: palette.textFaint,
      fontSize: 11,
      fontVariant: ["tabular-nums"],
      flexShrink: 0,
    },
    treeInlineBtn: {
      width: 24,
      height: 24,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    treeChildrenGuide: {
      marginLeft: 13,
      paddingLeft: 8,
      paddingVertical: 2,
      gap: 1,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: palette.border,
    },
    treeSessionRow: {
      minHeight: 30,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 7,
      paddingVertical: 4,
      borderRadius: 6,
    },
    treeSessionCopy: { flex: 1, minWidth: 0, gap: 1 },
    treeSessionTitle: { flex: 1, minWidth: 0, color: palette.text, fontSize: 12.5, fontWeight: "500" },
    treeSessionLabel: { color: palette.text, fontSize: 12.5, fontWeight: "500" },
    treeSessionMeta: { color: palette.textFaint, fontSize: 10.5, fontVariant: ["tabular-nums"], flexShrink: 0 },
    treeWorktreeSub: { marginTop: 4, gap: 1 },
    treeWorktreeSubTitle: {
      color: palette.textFaint,
      fontSize: 10.5,
      fontWeight: "600",
      paddingHorizontal: 7,
      paddingVertical: 2,
    },

    workbenchScroll: { paddingHorizontal: 18, paddingTop: 12, gap: 12 },
    connBanner: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    connBannerLeft: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
    connBannerText: { color: palette.textDim, fontSize: 12.5, flex: 1 },
    connRetry: { color: palette.accent, fontSize: 12.5, fontWeight: "700" },

    filterChipRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
    filterChip: {
      minHeight: 28,
      maxWidth: 160,
      justifyContent: "center",
      paddingHorizontal: 10,
      borderRadius: 8,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    filterChipActive: {
      backgroundColor: palette.text,
      borderColor: palette.text,
    },
    filterChipText: { color: palette.textDim, fontSize: 12, fontWeight: "600" },
    filterChipTextActive: { color: palette.bg },

    recentStripWrap: { minHeight: 28 },
    recentStripContent: { alignItems: "center", gap: 6, paddingRight: 8 },
    recentStripLabel: { color: palette.textFaint, fontSize: 11, fontWeight: "700", marginRight: 2 },
    recentChip: {
      height: 26,
      maxWidth: 190,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      borderRadius: 7,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    recentChipTitle: { color: palette.textDim, fontSize: 11.5, fontWeight: "500", flexShrink: 1 },

    workbenchDetail: { gap: 10 },
    workbenchHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    workbenchHeaderCopy: { flex: 1, minWidth: 0, gap: 2 },
    workbenchTitleRow: { flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0 },
    workbenchTitle: { ...themedFont.title, fontSize: 18, letterSpacing: -0.3, flexShrink: 1 },
    microIconBtn: { width: 24, height: 24, borderRadius: 6, alignItems: "center", justifyContent: "center" },
    workbenchPath: {
      color: palette.textFaint,
      fontSize: 11.5,
      fontFamily: MONOSPACE_FONT,
    },
    workbenchActions: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 },
    workbenchGhostBtn: {
      minHeight: 32,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 10,
      borderRadius: 8,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    workbenchGhostText: { color: palette.text, fontSize: 12.5, fontWeight: "600" },
    workbenchPrimaryBtn: {
      minHeight: 32,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: palette.text,
    },
    workbenchPrimaryText: { color: palette.bg, fontSize: 12.5, fontWeight: "600" },
    ctaPressed: { opacity: 0.82 },

    workbenchTable: {
      borderRadius: 10,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      overflow: "hidden",
    },
    rowHairline: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: palette.border,
      marginLeft: 38,
    },
    workbenchRow: {
      minHeight: 48,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    workbenchRowDense: { minHeight: 44, paddingHorizontal: 10, paddingVertical: 7 },
    rowPressed: { backgroundColor: palette.pressed },
    workbenchRowCopy: { flex: 1, minWidth: 0, gap: 2 },
    workbenchRowHead: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
    workbenchRowTitle: { ...themedFont.body, fontSize: 13.5, fontWeight: "600", flexShrink: 1 },
    modeChip: {
      paddingHorizontal: 5,
      paddingVertical: 1,
      borderRadius: 4,
      backgroundColor: palette.surfaceRaised,
    },
    modeChipText: {
      color: palette.textFaint,
      fontSize: 10,
      fontWeight: "600",
      fontFamily: MONOSPACE_FONT,
    },
    workbenchRowSub: { color: palette.textFaint, fontSize: 11.5 },
    statusBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 7,
      paddingVertical: 2.5,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceRaised,
    },
    statusBadgeActive: { backgroundColor: palette.successBg },
    statusBadgeWarn: { backgroundColor: palette.warnBg },
    statusDotSmall: { width: 6, height: 6, borderRadius: 3, flexShrink: 0 },
    statusBadgeText: { color: palette.textDim, fontSize: 11 },

    phoneList: {
      flexGrow: 1,
      width: "100%",
      maxWidth: 720,
      alignSelf: "center",
      paddingHorizontal: space.md,
      paddingTop: space.xs,
    },
    phoneHeader: { gap: 10, paddingBottom: 10 },
    phoneProjectGap: { height: 6 },
    phoneWorkspaceBlock: {
      borderRadius: 10,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      overflow: "hidden",
    },
    phoneWorkspaceBlockExpanded: { borderColor: palette.border },
    phoneFolderRow: {
      minHeight: 44,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    phoneFolderCopy: { flex: 1, minWidth: 0, gap: 1 },
    phoneFolderTitleRow: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 },
    phoneFolderName: { ...themedFont.body, fontSize: 14, fontWeight: "600", flexShrink: 1 },
    phoneFolderPath: { color: palette.textFaint, fontSize: 11, fontFamily: MONOSPACE_FONT },
    phoneSessionTree: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },

    taskFooter: { paddingTop: 8, gap: 4 },
    taskFooterHead: {
      minHeight: 34,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 8,
      borderRadius: 8,
      backgroundColor: palette.surfaceRaised,
    },
    taskFooterTitle: { flex: 1, minWidth: 0, color: palette.textDim, fontSize: 12, fontWeight: "600" },
    taskFooterCount: { color: palette.textFaint, fontSize: 11 },
    taskFooterChildren: { gap: 4, paddingLeft: 6 },
    pendingText: { color: palette.warn, fontWeight: "600" },

    nestedTaskWrap: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
      backgroundColor: palette.surfaceRaised,
    },
    nestedTaskToggle: {
      minHeight: 34,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    nestedTaskTitle: { flex: 1, minWidth: 0, color: palette.textDim, fontSize: 12, fontWeight: "600" },
    nestedTaskMeta: { color: palette.textFaint, fontSize: 11 },
    nestedTaskList: { gap: 6, paddingHorizontal: 8, paddingBottom: 8 },
    nestedTaskGroup: {
      borderRadius: 8,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      overflow: "hidden",
    },
    nestedTaskGroupHead: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: palette.border,
    },
    nestedTaskGroupName: { color: palette.textDim, fontSize: 12, fontWeight: "600", flex: 1 },
    nestedTaskSessions: {},

    emptySavedWorkspace: { padding: 14, alignItems: "center", gap: 8 },
    emptySavedWorkspaceText: { ...themedFont.meta, fontSize: 12.5 },
    emptySavedWorkspaceActions: { flexDirection: "row", alignItems: "center", gap: 8 },
    emptySavedPrimaryBtn: {
      minHeight: 30,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: palette.text,
    },
    emptySavedPrimaryText: { color: palette.bg, fontSize: 12, fontWeight: "600" },
    emptySavedGhostBtn: {
      minHeight: 30,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: palette.surfaceRaised,
    },
    emptySavedGhostText: { color: palette.textDim, fontSize: 12, fontWeight: "500" },

    archivedEmptyNote: { ...themedFont.sub, lineHeight: 20, paddingVertical: 16 },
    deviceList: { gap: 4, paddingBottom: space.md },
    deviceManageRow: { flexDirection: "row", alignItems: "center", borderRadius: radius.md },
    deviceRow: {
      minHeight: 52,
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
    deviceRowActions: { flexDirection: "row", alignItems: "center", paddingRight: 4 },
    deviceAction: { width: 42, height: 42, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
    dangerPressed: { backgroundColor: palette.dangerBg },
    deviceSheetDivider: { height: StyleSheet.hairlineWidth, marginVertical: space.xs, backgroundColor: palette.border },

    workspaceEmpty: {
      flex: 1,
      minHeight: 200,
      alignItems: "center",
      justifyContent: "center",
      gap: space.sm,
      padding: space.lg,
      borderRadius: 10,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    emptyTitle: { ...themedFont.title, fontSize: 15, textAlign: "center" },
    emptyDetail: { ...themedFont.sub, maxWidth: 320, fontSize: 12.5, lineHeight: 18, textAlign: "center" },
    emptyAction: {
      minHeight: 38,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: space.lg,
      borderRadius: 8,
      backgroundColor: palette.accentBg,
    },
    emptyActionText: { color: palette.accent, fontSize: 13, fontWeight: "600" },
  });
}
