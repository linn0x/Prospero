import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { useFocusEffect } from "expo-router";
import {
  AccessibilityInfo,
  Alert,
  AppState,
  Animated,
  Easing,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useAnimatedValue,
  useWindowDimensions,
  View,
} from "react-native";
import type { SessionInfo } from "@prospero/protocol";

import { AgentIcon } from "@/components/AgentIcon";
import { DeviceDetailCarousel } from "@/components/DeviceDetailCarousel";
import {
  DeviceQuickSwitcher,
  type DeviceSwitchDirection,
} from "@/components/DeviceQuickSwitcher";
import { Icon } from "@/components/Icon";
import { PromptDialog } from "@/components/PromptDialog";
import { Sheet, SheetAction } from "@/components/Sheet";
import { SwipeRow } from "@/components/SwipeRow";
import { WorkspaceHeader } from "@/components/WorkspaceHeader";
import { WorkspaceDisclosure, WorkspaceFolderIcon, WorkspaceChevron } from "@/components/WorkspaceDisclosure";
import type { StoredHost } from "@/lib/hosts";
import { clampDetailPreviewPosition, homeDevicePreviewIndex, showsAddDevicePreview, type AddDeviceSide } from "@/lib/home-device-preview";
import {
  homeApprovalSessions,
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
import {
  completionBaselineHostKey,
  sessionNeedsLocatorMotion,
  useSessionAttention,
} from "@/lib/session-attention";
import { projectName, type SessionProject } from "@/lib/session-projects";
import type { ConnStatus, HostRuntime } from "@/lib/store";
import { recentSessions as recentSessionStore, recentSessionTime } from "@/lib/recent-sessions";
import { useHomeLocatorMotion } from "@/lib/use-home-locator-motion";
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
  onAddHost: (mode?: "scan" | "manual") => void;
  onRefreshHost: (hostId: string) => void;
  onCreateSession: (hostId: string, cwd?: string) => void;
  onCreateDirectory: (hostId: string) => void;
  homeSettings?: HomeSettings;
  onChangeHomeSettings: (patch: Partial<HomeSettings>) => void;
  managedWorkspacePaths?: readonly string[];
}) {
  const { palette } = useMobileTheme();
  const { width: viewportWidth } = useWindowDimensions();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const windowWidth = viewportWidth;
  const compactWorkspaceActions = windowWidth < 390;
  const recentCardWidth = Math.min(232, Math.max(196, windowWidth - 72));
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
  const [previewHostId, setPreviewHostId] = useState<string | null>(null);
  const [quickSwitchActive, setQuickSwitchActive] = useState(false);
  const [deviceDetailsOpen, setDeviceDetailsOpen] = useState(false);
  const [detailHostId, setDetailHostId] = useState<string | null>(null);
  const [detailAddDeviceSide, setDetailAddDeviceSide] = useState<AddDeviceSide | null>(null);
  const homeListWidth = Math.min(840, viewportWidth);
  const deviceViewportBleed = (viewportWidth - homeListWidth) / 2 + space.lg;
  const deviceCardWidth = Math.max(280, homeListWidth - space.lg * 2);
  const deviceCardSideInset = (viewportWidth - deviceCardWidth) / 2;
  const deviceCardStride = deviceCardWidth * 0.94;
  const homeSwipeActive = quickSwitchActive || deviceDetailsOpen;
  const previewState = { detailsOpen: deviceDetailsOpen, detailHostId, addDeviceSide: detailAddDeviceSide, quickSwitchActive, previewHostId };
  const showAddDevicePreviews = showsAddDevicePreview(previewState);
  const homeActiveIndex = homeDevicePreviewIndex(hosts, selectedHost?.id, previewState);
  const detailSwipePositionRef = useRef(homeActiveIndex);
  const homeCarouselX = useAnimatedValue(
    deviceCardSideInset - homeActiveIndex * deviceCardStride,
  );
  const homeSwipeProgress = useAnimatedValue(0);
  const homeDevicePosition = useMemo(() => homeCarouselX.interpolate({
    inputRange: [deviceCardSideInset - deviceCardStride, deviceCardSideInset],
    outputRange: [1, 0],
  }), [deviceCardSideInset, deviceCardStride, homeCarouselX]);
  const neutralHomePosition = deviceCardSideInset - Math.max(0, hosts.findIndex((host) => host.id === selectedHost?.id)) * deviceCardStride;
  const neutralHomePositionRef = useRef(neutralHomePosition);
  useLayoutEffect(() => { neutralHomePositionRef.current = neutralHomePosition; }, [neutralHomePosition]);
  const [reduceMotion, setReduceMotion] = useState(false);
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
  const recentSessions = useMemo(
    () => homeRecentSessions(selectedRuntime?.sessions, effectiveHomeSettings.recentSessionLimit, recentUsage),
    [effectiveHomeSettings.recentSessionLimit, selectedRuntime?.sessions, recentUsage],
  );
  const approvalSessions = useMemo(
    () => homeApprovalSessions(selectedRuntime?.sessions),
    [selectedRuntime?.sessions],
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
    hasLocatorMotion && !reduceMotion && !deviceDetailsOpen,
  );
  const [expandedProjectKeys, setExpandedProjectKeys] = useState<Set<string>>(() => new Set());
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
  const resetHomeDevicePreview = useCallback(() => {
    homeSwipeProgress.stopAnimation();
    homeSwipeProgress.setValue(0);
    homeCarouselX.stopAnimation();
    homeCarouselX.setValue(neutralHomePositionRef.current);
    setQuickSwitchActive(false);
    setPreviewHostId(null);
    setDetailHostId(null);
    setDeviceDetailsOpen(false);
    setDetailAddDeviceSide(null);
  }, [homeCarouselX, homeSwipeProgress]);
  const cancelOverlays = useCallback(() => {
    deviceNavigation.cancel();
    createNavigation.cancel();
    closeDevicePickerRef.current();
    setQuickCreateOpen(false);
    setEditingProject(null);
    resetHomeDevicePreview();
  }, [createNavigation, deviceNavigation, resetHomeDevicePreview]);
  useFocusEffect(useCallback(() => {
    resetHomeDevicePreview();
    return cancelOverlays;
  }, [cancelOverlays, resetHomeDevicePreview]));
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

  useEffect(() => {
    homeCarouselX.stopAnimation();
    if (!homeSwipeActive) {
      homeCarouselX.setValue(neutralHomePosition);
      return;
    }
    if (deviceDetailsOpen) {
      homeCarouselX.setValue(deviceCardSideInset - detailSwipePositionRef.current * deviceCardStride);
      return;
    }
    Animated.timing(homeCarouselX, {
      toValue: deviceCardSideInset - homeActiveIndex * deviceCardStride,
      duration: reduceMotion ? 0 : 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [deviceCardSideInset, deviceCardStride, deviceDetailsOpen, homeActiveIndex, homeCarouselX, homeSwipeActive, neutralHomePosition, reduceMotion]);

  useEffect(() => {
    if (reduceMotion) {
      homeSwipeProgress.setValue(homeSwipeActive ? 1 : 0);
      return;
    }
    const animation = Animated.spring(homeSwipeProgress, {
      toValue: homeSwipeActive ? 1 : 0, speed: 26, bounciness: 4, useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [homeSwipeActive, homeSwipeProgress, reduceMotion]);

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

  useEffect(() => () => {
    homeCarouselX.stopAnimation();
  }, [homeCarouselX]);

  const handlePreviewHost = useCallback((
    hostId: string,
    _direction: DeviceSwitchDirection,
  ): void => {
    setPreviewHostId(hostId);
  }, []);

  const handleCancelPreview = useCallback((_direction: DeviceSwitchDirection): void => {
    setPreviewHostId(null);
  }, []);

  const handleConfirmHost = useCallback((hostId: string): void => {
    setPreviewHostId(null);
    onSelectHost(hostId);
  }, [onSelectHost]);

  const handleQuickSwitchStateChange = useCallback((
    active: boolean,
    _cancelled: boolean,
  ): void => {
    setQuickSwitchActive(active);
  }, []);

  const handleOpenDeviceDetails = useCallback((): void => {
    if (!selectedHost) return;
    setDetailAddDeviceSide(null);
    detailSwipePositionRef.current = Math.max(0, hosts.findIndex((host) => host.id === selectedHost.id));
    setDetailHostId(selectedHost.id);
    setDeviceDetailsOpen(true);
  }, [hosts, selectedHost]);

  const handleDetailHostSelect = useCallback((hostId: string): void => {
    setDetailAddDeviceSide(null);
    setDetailHostId(hostId);
    onSelectHost(hostId);
  }, [onSelectHost]);

  const handleDetailSwipePosition = useCallback((position: number): void => {
    const clampedPosition = clampDetailPreviewPosition(position, hosts.length);
    detailSwipePositionRef.current = clampedPosition;
    homeCarouselX.setValue(
      deviceCardSideInset - clampedPosition * deviceCardStride,
    );
  }, [deviceCardSideInset, deviceCardStride, homeCarouselX, hosts.length]);

  const closeDeviceDetails = resetHomeDevicePreview;
  const handlePairDevice = useCallback((mode: "scan" | "manual") => {
    closeDeviceDetails();
    onAddHost(mode);
  }, [closeDeviceDetails, onAddHost]);

  if (!selectedHost) return null;

  const displayProjectName = (path: string, fallback: string): string =>
    effectiveHomeSettings.workspaceAliases[workspaceAliasKey(selectedHost.id, path)] ?? fallback;
  const taskProjectsExpanded = expandedTaskHostId === selectedHost.id;
  const taskRunningCount = taskProjects.reduce((total, project) => total + project.runningCount, 0);
  const taskPendingCount = taskProjects.reduce((total, project) => total + project.pendingCount, 0);
  const renderProject = (project: SessionProject) => {
    const projectKey = `${selectedHost.id}:${project.path}`;
    const expanded = expandedProjectKeys.has(projectKey);
    const displayName = displayProjectName(project.path, project.name);
    const projectHasLocatorMotion = project.sessions.some(sessionNeedsMotion);
    return (
      <View
        key={projectKey}
        collapsable={false}
        style={[styles.projectCard, expanded && styles.projectCardExpanded]}
      >
        <WorkspaceDisclosure expanded={expanded} header={(disclosureProgress) => <SwipeRow
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
            accessibilityLabel={`${displayName}，${workspaceDetail(project)}，${project.path}`}
            accessibilityHint={`${expanded ? "收起这个目录的会话" : "展开这个目录的会话"}；左滑可新建会话或编辑名称`}
            onPress={() => setExpandedProjectKeys((current) => {
              const next = new Set(current);
              if (next.has(projectKey)) next.delete(projectKey);
              else next.add(projectKey);
              return next;
            })}
            style={({ pressed }) => [styles.projectHeader, pressed && styles.projectCardPressed]}
          >
            <View style={styles.projectIcon}>
              <Animated.View style={projectHasLocatorMotion ? locatorWiggleStyle : styles.locatorRest}>
                <WorkspaceFolderIcon progress={disclosureProgress} size={18} color={palette.accent} />
              </Animated.View>
            </View>
            <WorkspaceHeader hostId={selectedHost.id} path={project.path} sid={project.sessions[0]?.id}
              name={displayName} sessionCount={project.sessions.length}
              activity={project.pendingCount > 0 || project.runningCount > 0
                ? { label: workspaceDetail(project), pending: project.pendingCount > 0 } : undefined} />
            <WorkspaceChevron progress={disclosureProgress} size={15} color={palette.textFaint} />
          </Pressable>
        </SwipeRow>}>
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
                <Animated.View
                  style={sessionNeedsMotion(session) ? locatorWiggleStyle : styles.locatorRest}
                >
                  <AgentIcon agent={session.agent} size={17} badge badgeOutline={false} />
                </Animated.View>
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
        </WorkspaceDisclosure>
      </View>
    );
  };

  const renderHomeDeviceCard = (host: StoredHost, index: number) => {
    const runtime = runtimes[host.id];
    const stats = homeHostStats(runtime?.sessions);
    const orderedHosts = [host, ...hosts.filter((candidate) => candidate.id !== host.id)];
    const active = index === homeActiveIndex;
    return (
      <Animated.View
        key={host.id}
        testID={`home-device-card-${host.id}`}
        pointerEvents={active ? "auto" : "none"}
        accessibilityElementsHidden={!active}
        importantForAccessibility={active ? "auto" : "no-hide-descendants"}
        style={[
          styles.deviceCarouselCard,
          {
            width: deviceCardWidth,
            marginRight: -(deviceCardWidth - deviceCardStride),
            zIndex: active ? 2 : 1,
            // Preserve the switcher's scale motion without a translucent settlement flash.
            opacity: active || homeSwipeActive ? 1 : 0,
            transform: [{ scale: homeSwipeProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.9] }) }],
          },
        ]}
      >
        <View style={styles.devicePanel}>
          <View style={styles.deviceSelector}>
            <View style={styles.sectionIcon}>
              <HostPlatformIcon platform={runtime?.hostInfo?.platform} palette={palette} />
            </View>
            <View style={styles.deviceHeaderCopy}>
              <Text style={styles.deviceHeaderName} numberOfLines={1}>{host.name}</Text>
              <Text style={styles.deviceMeta} numberOfLines={1}>
                {`${String(stats.activeAgentCount)} Agent · ${String(stats.sessionCount)} 会话 · ${stats.runningCount > 0 ? `${String(stats.runningCount)} 项工作中` : "空闲"}`}
              </Text>
            </View>
            <View style={styles.deviceSelectorEnd}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: devicePickerOpen }}
                accessibilityLabel={`选择设备，${String(hosts.length)} 台已配对，当前为 ${host.name}，${hostConnectionLabel(runtime)}`}
                accessibilityHint="从屏幕底部打开设备列表"
                hitSlop={8}
                style={({ pressed }) => [
                  styles.deviceFleetPill,
                  pressed && styles.deviceFleetPillPressed,
                ]}
                onPress={() => {
                  deviceNavigation.cancel();
                  onToggleDevicePicker();
                }}
              >
                <Icon name="desktopcomputer" size={12} color={palette.textDim} />
                <View style={styles.deviceFleetDots}>
                  <View
                    style={[
                      styles.fleetStatusDot,
                      { backgroundColor: hostConnectionTone(runtime, palette) },
                    ]}
                  />
                  <Text style={styles.fleetCurrentStatus} numberOfLines={1}>
                    {hostConnectionLabel(runtime)}
                  </Text>
                  {orderedHosts.slice(1).map((candidate) => (
                    <View
                      key={candidate.id}
                      style={[
                        styles.fleetStatusDot,
                        { backgroundColor: hostConnectionTone(runtimes[candidate.id], palette) },
                      ]}
                    />
                  ))}
                </View>
                <Icon name="chevron.down" size={11} color={palette.textFaint} />
              </Pressable>
            </View>
          </View>
        </View>
      </Animated.View>
    );
  };

  const renderAddDevicePreview = (side: AddDeviceSide) => {
    const index = side === "before" ? -1 : hosts.length;
    const active = homeActiveIndex === index;
    return <Animated.View key={`add:${side}`} testID={`home-add-device-${side}`} pointerEvents="none"
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={[styles.deviceCarouselCard, {
        position: "absolute", left: index * deviceCardStride, width: deviceCardWidth,
        zIndex: active ? 2 : 1,
        transform: [{ scale: homeSwipeProgress.interpolate({ inputRange: [0, 1], outputRange: [1, 0.9] }) }],
      }]}>
      <View style={[styles.devicePanel, styles.addDevicePanel]}>
        <View style={styles.deviceSelector}>
          <View style={styles.sectionIcon}><Icon name="plus" size={18} color={palette.accent} /></View>
          <View style={styles.deviceHeaderCopy}>
            <Text style={styles.deviceHeaderName}>新增设备</Text>
            <Text style={styles.deviceMeta}>扫码或使用 IP + 配对码</Text>
          </View>
          <Icon name="qrcode.viewfinder" size={20} color={palette.textDim} />
        </View>
      </View>
    </Animated.View>;
  };

  const devicePanel = (
    <View
      style={[
        styles.devicePanelStage,
        hosts.length > 0 && styles.devicePanelStageWithRail,
        { width: viewportWidth, marginLeft: -deviceViewportBleed },
      ]}
    >
      <View style={styles.deviceCarouselViewport}>
        <Animated.View
          style={[
            styles.deviceCarouselTrack,
            { transform: [{ translateX: homeSwipeActive ? homeCarouselX : neutralHomePosition }] },
          ]}
        >
          {showAddDevicePreviews && renderAddDevicePreview("before")}
          {hosts.map(renderHomeDeviceCard)}
          {showAddDevicePreviews && renderAddDevicePreview("after")}
        </Animated.View>
      </View>
      <DeviceQuickSwitcher
        hosts={hosts}
        runtimes={runtimes}
        selectedHostId={selectedHost.id}
        position={homeDevicePosition}
        hapticsEnabled={effectiveHomeSettings.deviceSwitcherHapticsEnabled}
        onOpenDeviceDetails={handleOpenDeviceDetails}
        onPreviewHost={handlePreviewHost}
        onCancelPreview={handleCancelPreview}
        onConfirmHost={handleConfirmHost}
        onQuickSwitchStateChange={handleQuickSwitchStateChange}
      />
    </View>
  );

  return (
    <>
      <FlatList
      ref={homeListRef}
      testID="home-workspace-list"
      data={projects}
      extraData={expandedProjectKeys}
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
          {devicePanel}

          {approvalSessions.length > 0 && (
            <View style={styles.approvalSection} testID="home-approval-sessions">
              <View style={styles.sectionHeading}>
                <Text style={styles.sectionTitle}>待授权对话</Text>
                <Text style={styles.approvalCount}>{String(approvalSessions.length)} 项</Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.recentList}
              >
                {approvalSessions.map((session) => {
                  const pendingCount = session.pendingPermissions ?? 0;
                  return (
                    <Pressable
                      key={session.id}
                      accessibilityRole="button"
                      accessibilityLabel={`打开待授权对话 ${session.title || session.agent}`}
                      onPress={() => onOpenSession(selectedHost.id, session.id)}
                      style={({ pressed }) => [
                        styles.approvalCard,
                        { width: recentCardWidth },
                        pressed && styles.recentCardPressed,
                      ]}
                    >
                      <Animated.View style={locatorWiggleStyle}>
                        <AgentIcon agent={session.agent} size={18} badge badgeOutline={false} />
                      </Animated.View>
                      <View style={styles.recentCopy}>
                        <Text style={styles.recentTitle} numberOfLines={1}>
                          {session.title || session.agent}
                        </Text>
                        <Text style={styles.approvalDetail} numberOfLines={1}>
                          {pendingCount > 0
                            ? `${String(pendingCount)} 项操作等待授权`
                            : "等待授权操作"}
                        </Text>
                        <Text style={styles.recentMeta} numberOfLines={1}>
                          {displayProjectName(session.cwd, projectName(session.cwd))}
                        </Text>
                      </View>
                      <Icon name="exclamationmark.triangle.fill" size={16} color={palette.warn} />
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          )}

          <View style={styles.recentSection} testID="home-recent-section">
            <View style={[styles.sectionHeading, styles.recentHeading]}>
              <Text style={styles.sectionTitle}>最近对话</Text>
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
                    <Animated.View style={sessionNeedsMotion(session) ? locatorWiggleStyle : styles.locatorRest}>
                      <AgentIcon agent={session.agent} size={18} badge badgeOutline={false} />
                    </Animated.View>
                    <View style={styles.recentCopy}>
                      <Text style={styles.recentTitle} numberOfLines={1}>
                        {session.title || session.agent}
                      </Text>
                      <Text style={styles.recentPreview} numberOfLines={1}>
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

      <DeviceDetailCarousel
        visible={deviceDetailsOpen}
        hosts={hosts}
        runtimes={runtimes}
        activeHostId={detailHostId ?? selectedHost.id}
        addDeviceSide={detailAddDeviceSide}
        onSelectAddDevice={setDetailAddDeviceSide}
        onPairDevice={handlePairDevice}
        onClose={closeDeviceDetails}
        onSelectHost={handleDetailHostSelect}
        onSwipePosition={handleDetailSwipePosition}
        onOpenHost={onOpenHost}
        onOpenSession={onOpenSession}
        onCreateSession={onCreateSession}
        onRefreshHost={onRefreshHost}
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
        message={`${editingProject?.path ?? ""}\n\n只修改这台手机上的显示名称，不会移动电脑目录或更改已有会话。清空可恢复目录原名。`}
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
  headerContent: { gap: space.xs, paddingTop: space.sm, paddingBottom: space.md },
  devicePanelStage: {
    position: "relative",
    zIndex: 20,
  },
  devicePanelStageWithRail: { paddingBottom: 17 },
  deviceCarouselViewport: {
    height: 64,
    overflow: "hidden",
  },
  deviceCarouselTrack: {
    height: 64,
    flexDirection: "row",
  },
  deviceCarouselCard: {
    height: 64,
    flexShrink: 0,
  },
  devicePanel: {
    height: 64,
    overflow: "hidden",
    borderRadius: radius.md,
    backgroundColor: palette.surface,
  },
  addDevicePanel: { borderWidth: 1, borderStyle: "dashed", borderColor: palette.border },
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
    height: 28,
    minWidth: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    borderRadius: 999,
    backgroundColor: palette.surfaceRaised,
  },
  deviceFleetPillPressed: { backgroundColor: palette.pressed },
  deviceFleetDots: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  fleetStatusDot: { width: 5, height: 5, borderRadius: 2.5 },
  fleetCurrentStatus: {
    color: palette.textDim,
    fontSize: 8.5,
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
  approvalSection: { gap: space.sm },
  approvalCount: { color: palette.warn, fontSize: 11, fontWeight: "700" },
  approvalCard: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: palette.warnBg,
  },
  approvalDetail: { color: palette.warn, fontSize: 11, fontWeight: "600" },
  recentSection: { gap: space.xs },
  recentHeading: { minHeight: 28 },
  sectionHeading: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: { ...themedFont.title, fontSize: 17 },
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
  projectPending: { color: palette.warn, fontWeight: "600" },
  locatorRest: { transform: [{ rotate: "0deg" }] },
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
