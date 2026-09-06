import { useCallback, useEffect, useMemo, useRef } from "react";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import type { SessionInfo } from "@prospero/protocol";
import {
  Animated,
  BackHandler,
  Easing,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useAnimatedValue,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type NativeTouchEvent,
} from "react-native";

import { AgentIcon } from "@/components/AgentIcon";
import { Icon } from "@/components/Icon";
import {
  deviceIndexForCarouselOffset,
  deviceIndexForRailPosition,
} from "@/lib/device-quick-switcher";
import {
  homeHostOsLabel,
  homeHostStats,
  homeRecentSessions,
  homeWorkspaceProjects,
} from "@/lib/home-dashboard";
import type { StoredHost } from "@/lib/hosts";
import type { ConnStatus, HostRuntime } from "@/lib/store";
import { radius, space, useMobileTheme, type ThemePalette } from "@/lib/theme";

const CARD_GAP = 8;
const RAIL_ITEM_WIDTH = 38;
const RAIL_PADDING = 6;
const RAIL_HEIGHT = 42;
const ACTIVE_SESSION_STATUSES = new Set<SessionInfo["status"]>([
  "starting",
  "running",
  "waiting_approval",
  "waiting_input",
]);

const connectionStatusLabel: Record<ConnStatus, string> = {
  idle: "离线",
  connecting: "连接中",
  reconnecting: "重连中",
  connected: "在线",
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

function connectionTone(runtime: HostRuntime | undefined, palette: ThemePalette): string {
  const status = runtime?.status ?? "idle";
  if (status === "connected") {
    return runtime?.rttMs !== null && runtime?.rttMs !== undefined && runtime.rttMs >= 300
      ? palette.warn
      : palette.success;
  }
  if (status === "connecting" || status === "reconnecting") return palette.warn;
  return palette.danger;
}

function connectionLabel(runtime: HostRuntime | undefined): string {
  const status = runtime?.status ?? "idle";
  const rtt = runtime?.rttMs;
  return status === "connected" && rtt !== null && rtt !== undefined
    ? `${connectionStatusLabel[status]} · ${String(rtt)}ms`
    : connectionStatusLabel[status];
}

function sessionTone(session: SessionInfo, palette: ThemePalette): string {
  if (session.status === "waiting_approval" || session.status === "waiting_input") {
    return palette.warn;
  }
  if (session.status === "starting" || session.status === "running") return palette.accent;
  if (session.status === "completed") return palette.success;
  if (session.status === "died") return palette.danger;
  return palette.textFaint;
}

function PlatformIcon({
  platform,
  palette,
  size = 24,
}: {
  platform: string | undefined;
  palette: ThemePalette;
  size?: number;
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
      size={size}
      color={brand === "linux" ? palette.warn : palette.accent}
    />
  ) : (
    <Icon name="desktopcomputer" size={size} color={palette.accent} />
  );
}

function SessionRow({
  session,
  palette,
  styles,
  onPress,
}: {
  session: SessionInfo;
  palette: ThemePalette;
  styles: DetailStyles;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开会话 ${session.title || session.agent}`}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
      style={({ pressed }) => [styles.sessionRow, pressed && styles.rowPressed]}
    >
      <AgentIcon agent={session.agent} size={14} />
      <View style={styles.sessionCopy}>
        <Text style={styles.sessionTitle} numberOfLines={1}>
          {session.title || `${session.agent} 会话`}
        </Text>
        <Text style={styles.sessionPreview} numberOfLines={1}>
          {session.preview?.trim() || session.cwd}
        </Text>
      </View>
      <View style={[styles.sessionDot, { backgroundColor: sessionTone(session, palette) }]} />
      <Text style={styles.sessionStatus}>{sessionStatusLabel[session.status]}</Text>
    </Pressable>
  );
}

function ActionButton({
  icon,
  label,
  onPress,
  styles,
  palette,
}: {
  icon: "desktopcomputer" | "plus" | "arrow.clockwise";
  label: string;
  onPress: () => void;
  styles: DetailStyles;
  palette: ThemePalette;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={(event) => {
        event.stopPropagation();
        onPress();
      }}
      style={({ pressed }) => [styles.actionButton, pressed && styles.rowPressed]}
    >
      <Icon name={icon} size={15} color={palette.accent} />
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

function LargeDeviceCard({
  host,
  runtime,
  active,
  width,
  height,
  palette,
  styles,
  onSelect,
  onOpenHost,
  onOpenSession,
  onCreateSession,
  onRefreshHost,
}: {
  host: StoredHost;
  runtime: HostRuntime | undefined;
  active: boolean;
  width: number;
  height: number;
  palette: ThemePalette;
  styles: DetailStyles;
  onSelect: () => void;
  onOpenHost: () => void;
  onOpenSession: (sessionId: string) => void;
  onCreateSession: () => void;
  onRefreshHost: () => void;
}) {
  const stats = homeHostStats(runtime?.sessions);
  const activeSessions = Object.values(runtime?.sessions ?? {})
    .filter((session) => ACTIVE_SESSION_STATUSES.has(session.status))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 3);
  const recentSessions = homeRecentSessions(runtime?.sessions, 4);
  const projects = homeWorkspaceProjects(runtime?.sessions);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${host.name} 设备卡片，点击切换到此设备`}
      onPress={onSelect}
      style={[
        styles.card,
        { width, height },
        active ? styles.cardActive : styles.cardAdjacent,
      ]}
    >
      <View style={styles.cardHeader}>
        <View style={styles.platformIcon}>
          <PlatformIcon platform={runtime?.hostInfo?.platform} palette={palette} size={28} />
        </View>
        <View style={styles.hostCopy}>
          <Text style={styles.hostName} numberOfLines={1}>{host.name}</Text>
          <Text style={styles.osLabel} numberOfLines={1}>{homeHostOsLabel(runtime?.hostInfo)}</Text>
        </View>
        <View style={styles.connectionPill}>
          <View style={[styles.connectionDot, { backgroundColor: connectionTone(runtime, palette) }]} />
          <Text style={styles.connectionText}>{connectionLabel(runtime)}</Text>
        </View>
      </View>

      <View style={styles.statsRow}>
        <View style={styles.statPill}>
          <Icon name="point.3.connected.trianglepath.dotted" size={16} color={palette.accent} />
          <Text style={styles.statValue}>{String(stats.activeAgentCount)}</Text>
          <Text style={styles.statLabel}>Agent</Text>
        </View>
        <View style={styles.statPill}>
          <Icon name="bubble.left.and.text.bubble.right" size={16} color={palette.accent} />
          <Text style={styles.statValue}>{String(stats.sessionCount)}</Text>
          <Text style={styles.statLabel}>会话</Text>
        </View>
        <View style={[styles.statPill, stats.runningCount > 0 && styles.statPillBusy]}>
          <View
            style={[
              styles.busyDot,
              { backgroundColor: stats.runningCount > 0 ? palette.warn : palette.success },
            ]}
          />
          <Text style={styles.statValue}>{String(stats.runningCount)}</Text>
          <Text style={styles.statLabel}>{stats.runningCount > 0 ? "进行中" : "空闲"}</Text>
        </View>
      </View>

      <View style={styles.actionsRow}>
        <ActionButton
          icon="desktopcomputer"
          label="设备详情"
          onPress={onOpenHost}
          styles={styles}
          palette={palette}
        />
        <ActionButton
          icon="plus"
          label="新建会话"
          onPress={onCreateSession}
          styles={styles}
          palette={palette}
        />
        <ActionButton
          icon="arrow.clockwise"
          label="刷新"
          onPress={onRefreshHost}
          styles={styles}
          palette={palette}
        />
      </View>

      <ScrollView
        style={styles.detailsScroll}
        contentContainerStyle={styles.detailsContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.detailSection}>
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>正在进行</Text>
            <Text style={styles.sectionCount}>{String(activeSessions.length)} 项</Text>
          </View>
          {activeSessions.length > 0 ? (
            activeSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                palette={palette}
                styles={styles}
                onPress={() => onOpenSession(session.id)}
              />
            ))
          ) : (
            <Text style={styles.emptyLine}>当前没有等待处理或运行中的会话</Text>
          )}
        </View>

        <View style={styles.detailSection}>
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>最近会话</Text>
            <Text style={styles.sectionCount}>{String(stats.sessionCount)} 个</Text>
          </View>
          {recentSessions.length > 0 ? (
            recentSessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                palette={palette}
                styles={styles}
                onPress={() => onOpenSession(session.id)}
              />
            ))
          ) : (
            <Text style={styles.emptyLine}>这台设备还没有会话</Text>
          )}
        </View>

        <View style={styles.detailSection}>
          <View style={styles.sectionHeading}>
            <Text style={styles.sectionTitle}>工作目录</Text>
            <Text style={styles.sectionCount}>{String(projects.length)} 个 · 可上下滑动</Text>
          </View>
          {projects.length > 0 ? (
            projects.map((project) => (
              <Pressable
                key={project.path}
                accessibilityRole="button"
                accessibilityLabel={`切换到 ${host.name}，工作目录 ${project.name}`}
                onPress={(event) => {
                  event.stopPropagation();
                  onSelect();
                }}
                style={({ pressed }) => [styles.projectRow, pressed && styles.rowPressed]}
              >
                <View style={styles.projectIcon}>
                  <Icon name="folder.fill" size={16} color={palette.accent} />
                </View>
                <View style={styles.projectCopy}>
                  <Text style={styles.projectName} numberOfLines={1}>{project.name}</Text>
                  <Text style={styles.projectPath} numberOfLines={1}>{project.path}</Text>
                </View>
                <Text style={styles.projectCount}>{String(project.sessions.length)} 会话</Text>
              </Pressable>
            ))
          ) : (
            <Text style={styles.emptyLine}>连接设备并创建会话后，目录会显示在这里</Text>
          )}
        </View>
      </ScrollView>
    </Pressable>
  );
}

function DeviceOsRail({
  hosts,
  runtimes,
  activeIndex,
  width,
  palette,
  styles,
  onSelectIndex,
}: {
  hosts: StoredHost[];
  runtimes: Record<string, HostRuntime>;
  activeIndex: number;
  width: number;
  palette: ThemePalette;
  styles: DetailStyles;
  onSelectIndex: (index: number) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const offsetRef = useRef(0);
  const lastDragIndexRef = useRef(activeIndex);
  const contentWidth = hosts.length * RAIL_ITEM_WIDTH + RAIL_PADDING * 2;
  const maximumOffset = Math.max(0, contentWidth - width);

  useEffect(() => {
    lastDragIndexRef.current = activeIndex;
    const centered = activeIndex * RAIL_ITEM_WIDTH - (width - RAIL_ITEM_WIDTH) / 2 + RAIL_PADDING;
    scrollRef.current?.scrollTo({
      x: Math.min(maximumOffset, Math.max(0, centered)),
      animated: true,
    });
  }, [activeIndex, maximumOffset, width]);

  const handleTouchMove = useCallback((event: NativeSyntheticEvent<NativeTouchEvent>): void => {
    const index = deviceIndexForRailPosition(
      offsetRef.current,
      event.nativeEvent.locationX,
      hosts.length,
      RAIL_ITEM_WIDTH,
      RAIL_PADDING,
    );
    if (index < 0 || index === lastDragIndexRef.current) return;
    lastDragIndexRef.current = index;
    onSelectIndex(index);
  }, [hosts.length, onSelectIndex]);

  return (
    <View style={[styles.rail, { width }]} testID="device-os-rail">
      <ScrollView
        ref={scrollRef}
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(event) => {
          offsetRef.current = event.nativeEvent.contentOffset.x;
        }}
        onTouchMove={handleTouchMove}
        contentContainerStyle={styles.railContent}
      >
        {hosts.map((host, index) => {
          const runtime = runtimes[host.id];
          const active = index === activeIndex;
          return (
            <Pressable
              key={host.id}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`切换到 ${host.name}，${connectionLabel(runtime)}`}
              onPress={() => onSelectIndex(index)}
              style={({ pressed }) => [
                styles.railItem,
                active && styles.railItemActive,
                pressed && styles.railItemPressed,
              ]}
            >
              <PlatformIcon platform={runtime?.hostInfo?.platform} palette={palette} size={16} />
              <View
                style={[
                  styles.railStatusDot,
                  { backgroundColor: connectionTone(runtime, palette) },
                ]}
              />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function DeviceDetailCarousel({
  visible,
  hosts,
  runtimes,
  activeHostId,
  onClose,
  onSelectHost,
  onSwipePosition,
  onOpenHost,
  onOpenSession,
  onCreateSession,
  onRefreshHost,
}: {
  visible: boolean;
  hosts: StoredHost[];
  runtimes: Record<string, HostRuntime>;
  activeHostId: string;
  onClose: () => void;
  onSelectHost: (hostId: string) => void;
  onSwipePosition: (position: number) => void;
  onOpenHost: (hostId: string) => void;
  onOpenSession: (hostId: string, sessionId: string) => void;
  onCreateSession: (hostId: string) => void;
  onRefreshHost: (hostId: string) => void;
}) {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const cardWidth = Math.min(720, Math.max(300, viewportWidth - 32));
  const cardHeight = Math.min(540, Math.max(430, viewportHeight - 270));
  const cardStride = cardWidth + CARD_GAP;
  const stageHeight = cardHeight + 98;
  const sideInset = (viewportWidth - cardWidth) / 2;
  const railWidth = Math.min(viewportWidth - 48, hosts.length * RAIL_ITEM_WIDTH + RAIL_PADDING * 2);
  const activeIndex = Math.max(0, hosts.findIndex((host) => host.id === activeHostId));
  const listRef = useRef<FlatList<StoredHost>>(null);
  const wasVisibleRef = useRef(false);
  const visibleIndexRef = useRef(activeIndex);
  const pendingScrollIndexRef = useRef<number | null>(null);
  const progress = useAnimatedValue(0);

  useEffect(() => {
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: visible ? 220 : 160,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [progress, visible]);

  useEffect(() => {
    if (!visible) {
      wasVisibleRef.current = false;
      pendingScrollIndexRef.current = null;
      return undefined;
    }
    if (wasVisibleRef.current) {
      if (
        visibleIndexRef.current === activeIndex
        || pendingScrollIndexRef.current === activeIndex
      ) {
        return undefined;
      }
      pendingScrollIndexRef.current = activeIndex;
    } else {
      wasVisibleRef.current = true;
      visibleIndexRef.current = activeIndex;
    }
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollToOffset({
        offset: activeIndex * cardStride,
        animated: pendingScrollIndexRef.current !== null,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, cardStride, visible]);

  useEffect(() => {
    if (!visible) return undefined;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose, visible]);

  useEffect(() => () => progress.stopAnimation(), [progress]);

  const selectIndex = useCallback((index: number, animated = true): void => {
    const host = hosts[index];
    if (!host) return;
    pendingScrollIndexRef.current = animated ? index : null;
    if (!animated) visibleIndexRef.current = index;
    listRef.current?.scrollToOffset({ offset: index * cardStride, animated });
    onSelectHost(host.id);
  }, [cardStride, hosts, onSelectHost]);

  const handleCarouselEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const index = deviceIndexForCarouselOffset(
      event.nativeEvent.contentOffset.x,
      cardStride,
      hosts.length,
    );
    if (index < 0) return;
    visibleIndexRef.current = index;
    const pendingIndex = pendingScrollIndexRef.current;
    if (pendingIndex !== null) {
      if (index === pendingIndex) pendingScrollIndexRef.current = null;
      return;
    }
    const host = hosts[index];
    if (host && index !== activeIndex) onSelectHost(host.id);
  }, [activeIndex, cardStride, hosts, onSelectHost]);

  const handleCarouselScroll = useCallback((
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void => {
    if (!visible) return;
    onSwipePosition(event.nativeEvent.contentOffset.x / cardStride);
  }, [cardStride, onSwipePosition, visible]);

  if (hosts.length <= 1) return null;

  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "yes" : "no-hide-descendants"}
      accessibilityViewIsModal={visible}
      style={styles.overlay}
      testID="device-detail-carousel"
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.backdrop,
          { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 0.62] }) },
        ]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="关闭设备详情"
        onPress={onClose}
        style={styles.backdropPress}
        testID="device-detail-backdrop"
      />
      <Animated.View
        pointerEvents="auto"
        style={[
          styles.stage,
          {
            height: stageHeight,
            marginTop: -stageHeight / 2,
            opacity: progress,
            transform: [
              {
                translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-80, 0] }),
              },
              { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
            ],
          },
        ]}
      >
        <Pressable
          accessible={false}
          onPress={(event) => event.stopPropagation()}
          style={styles.stageShield}
        />
        <View style={[styles.modeHeader, { width: cardWidth }]}>
          <View>
            <Text style={styles.modeTitle}>设备详情</Text>
            <Text style={styles.modeHint}>左右滑动设备 · 卡片内容可上下滚动</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭设备详情"
            onPress={onClose}
            hitSlop={8}
            style={({ pressed }) => [styles.closeButton, pressed && styles.rowPressed]}
          >
            <Icon name="xmark" size={17} color={palette.textDim} />
          </Pressable>
        </View>

        <FlatList
          ref={listRef}
          data={hosts}
          horizontal
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          disableIntervalMomentum
          snapToInterval={cardStride}
          snapToAlignment="start"
          nestedScrollEnabled
          keyExtractor={(host) => host.id}
          getItemLayout={(_data, index) => ({
            length: cardStride,
            offset: cardStride * index,
            index,
          })}
          contentContainerStyle={{ paddingHorizontal: sideInset }}
          ItemSeparatorComponent={() => <View style={{ width: CARD_GAP }} />}
          onScroll={handleCarouselScroll}
          scrollEventThrottle={16}
          onMomentumScrollEnd={handleCarouselEnd}
          extraData={activeHostId}
          style={{ flexGrow: 0, height: cardHeight }}
          renderItem={({ item: host, index }) => (
            <LargeDeviceCard
              host={host}
              runtime={runtimes[host.id]}
              active={index === activeIndex}
              width={cardWidth}
              height={cardHeight}
              palette={palette}
              styles={styles}
              onSelect={() => selectIndex(index)}
              onOpenHost={() => {
                onSelectHost(host.id);
                onClose();
                onOpenHost(host.id);
              }}
              onOpenSession={(sessionId) => {
                onSelectHost(host.id);
                onClose();
                onOpenSession(host.id, sessionId);
              }}
              onCreateSession={() => {
                onSelectHost(host.id);
                onClose();
                onCreateSession(host.id);
              }}
              onRefreshHost={() => {
                onSelectHost(host.id);
                onRefreshHost(host.id);
              }}
            />
          )}
        />

        <DeviceOsRail
          hosts={hosts}
          runtimes={runtimes}
          activeIndex={activeIndex}
          width={railWidth}
          palette={palette}
          styles={styles}
          onSelectIndex={selectIndex}
        />
      </Animated.View>
    </View>
  );
}

type DetailStyles = ReturnType<typeof createStyles>;

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    overlay: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      zIndex: 100,
      elevation: 44,
    },
    backdrop: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "#000000",
    },
    backdropPress: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      zIndex: 1,
    },
    stage: {
      position: "absolute",
      top: "50%",
      right: 0,
      left: 0,
      zIndex: 2,
      elevation: 1,
      justifyContent: "center",
      alignItems: "center",
      gap: 9,
    },
    stageShield: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
    modeHeader: {
      minHeight: 38,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 4,
    },
    modeTitle: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
    modeHint: { color: "#D7DCE3", fontSize: 9.5, marginTop: 2 },
    closeButton: {
      width: 34,
      height: 34,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 17,
      backgroundColor: palette.surface,
    },
    card: {
      flexShrink: 0,
      overflow: "hidden",
      padding: space.lg,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      backgroundColor: palette.surface,
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.28,
      shadowRadius: 26,
      elevation: 22,
    },
    cardActive: { borderColor: palette.accent },
    cardAdjacent: { borderColor: palette.border },
    cardHeader: { flexDirection: "row", alignItems: "center", gap: space.sm },
    platformIcon: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 14,
      backgroundColor: palette.accentBg,
    },
    hostCopy: { flex: 1, minWidth: 0, gap: 3 },
    hostName: { color: palette.text, fontSize: 20, fontWeight: "700" },
    osLabel: { color: palette.textDim, fontSize: 10.5 },
    connectionPill: {
      minHeight: 27,
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 9,
      borderRadius: 999,
      backgroundColor: palette.surfaceRaised,
    },
    connectionDot: { width: 7, height: 7, borderRadius: 4 },
    connectionText: { color: palette.textDim, fontSize: 9.5, fontWeight: "600" },
    statsRow: { flexDirection: "row", gap: 7, marginTop: space.md },
    statPill: {
      flex: 1,
      minWidth: 0,
      minHeight: 40,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      paddingHorizontal: 7,
      borderRadius: radius.sm,
      backgroundColor: palette.surfaceRaised,
    },
    statPillBusy: { backgroundColor: palette.warnBg },
    statValue: { color: palette.text, fontSize: 14, fontWeight: "700" },
    statLabel: { color: palette.textDim, fontSize: 9.5 },
    busyDot: { width: 7, height: 7, borderRadius: 4 },
    actionsRow: { flexDirection: "row", gap: 7, marginTop: space.sm },
    actionButton: {
      flex: 1,
      minHeight: 36,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 5,
      borderRadius: radius.sm,
      backgroundColor: palette.accentBg,
    },
    actionLabel: { color: palette.accent, fontSize: 10, fontWeight: "600" },
    detailsScroll: { flex: 1, marginTop: space.sm },
    detailsContent: { gap: space.md, paddingBottom: space.md },
    detailSection: { gap: 5 },
    sectionHeading: {
      minHeight: 22,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sectionTitle: { color: palette.text, fontSize: 13, fontWeight: "700" },
    sectionCount: { color: palette.textFaint, fontSize: 9.5 },
    sessionRow: {
      minHeight: 38,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      paddingHorizontal: 9,
      borderRadius: radius.sm,
      backgroundColor: palette.surfaceRaised,
    },
    rowPressed: { opacity: 0.62 },
    sessionCopy: { flex: 1, minWidth: 0, gap: 1 },
    sessionTitle: { color: palette.text, fontSize: 11, fontWeight: "600" },
    sessionPreview: { color: palette.textFaint, fontSize: 8.5 },
    sessionDot: { width: 6, height: 6, borderRadius: 3 },
    sessionStatus: { color: palette.textDim, fontSize: 8.5 },
    emptyLine: {
      color: palette.textFaint,
      fontSize: 10,
      lineHeight: 16,
      paddingHorizontal: 9,
      paddingVertical: 9,
      borderRadius: radius.sm,
      backgroundColor: palette.surfaceRaised,
    },
    projectRow: {
      minHeight: 46,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 9,
      borderRadius: radius.sm,
      backgroundColor: palette.surfaceRaised,
    },
    projectIcon: {
      width: 30,
      height: 30,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 8,
      backgroundColor: palette.accentBg,
    },
    projectCopy: { flex: 1, minWidth: 0, gap: 2 },
    projectName: { color: palette.text, fontSize: 11, fontWeight: "600" },
    projectPath: { color: palette.textFaint, fontSize: 8.5 },
    projectCount: { color: palette.textDim, fontSize: 9 },
    rail: {
      height: RAIL_HEIGHT,
      overflow: "hidden",
      borderRadius: 999,
      backgroundColor: palette.surface,
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.2,
      shadowRadius: 14,
      elevation: 18,
    },
    railContent: {
      minWidth: "100%",
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: RAIL_PADDING,
    },
    railItem: {
      width: RAIL_ITEM_WIDTH,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
      borderRadius: 16,
    },
    railItemActive: { backgroundColor: palette.accentBg },
    railItemPressed: { backgroundColor: palette.pressed },
    railStatusDot: { width: 3, height: 3, borderRadius: 2 },
  });
}
