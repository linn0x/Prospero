import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HomeDashboard } from "@/components/HomeDashboard";
import { toast } from "@/components/Toast";
import { Icon } from "@/components/Icon";
import { Sheet, SheetAction } from "@/components/Sheet";
import { DismissedModalAction } from "@/lib/host-screen-flow";
import {
  isShellTerminal,
  isTerminalEnded,
  supportsRemoteTerminal,
  REMOTE_TERMINAL_UNAVAILABLE,
} from "@/lib/terminal-session";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import { getConnection, peekConnection, wireAppStateReconnect } from "@/lib/connection";
import { resolveHomeHostSelection } from "@/lib/home-dashboard";
import {
  DEFAULT_HOME_SETTINGS,
  getLastHomeHostId,
  normalizeHomeSettings,
  rememberHomeSettings,
  rememberLastHomeHost,
  type HomeSettings,
} from "@/lib/home-preferences";
import {
  HOME_EMPTY_STATE_MIN_HIT_TARGET,
  homeEmptyStateLayout,
} from "@/lib/home-empty-state-layout";
import { getDeviceKeys, getHosts, removeHost, type StoredHost } from "@/lib/hosts";
import { clearSessionPreferences } from "@/lib/session-preferences";
import { useApp } from "@/lib/store";
import { useOrchestrationSnapshot } from "@/lib/use-orchestration-snapshot";
import { font, radius, space, useMobileTheme, type ThemePalette } from "@/lib/theme";

export default function HostsScreen() {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const adaptiveLayout = useAdaptiveLayout();
  const emptyStatePaneWidth = adaptiveLayout.verticalPanes?.end ?? adaptiveLayout.width;
  const emptyStateLayout = homeEmptyStateLayout({
    viewportWidth: emptyStatePaneWidth,
    bottomInset: insets.bottom,
    fontScale,
  });
  const [hosts, setLocal] = useState<StoredHost[]>([]);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const [terminalPickerOpen, setTerminalPickerOpen] = useState(false);
  const [terminalNavigation] = useState(() => new DismissedModalAction());
  useEffect(() => () => terminalNavigation.cancel(), [terminalNavigation]);
  const setHosts = useApp((state) => state.setHosts);
  // 首页设置只消费这三个业务字段；主题由显式上下文单独驱动，避免订阅整个
  // 设置对象时把无关配置变化也扩散到设备和工作区列表。
  const recentSessionLimit = useApp(
    (state) => state.homeSettings?.recentSessionLimit ?? DEFAULT_HOME_SETTINGS.recentSessionLimit,
  );
  const workspaceAliases = useApp(
    (state) => state.homeSettings?.workspaceAliases ?? DEFAULT_HOME_SETTINGS.workspaceAliases,
  );
  const deviceSwitcherHapticsEnabled = useApp(
    (state) => state.homeSettings?.deviceSwitcherHapticsEnabled
      ?? DEFAULT_HOME_SETTINGS.deviceSwitcherHapticsEnabled,
  );
  const homeSettings = useMemo<HomeSettings>(
    () => ({
      ...DEFAULT_HOME_SETTINGS,
      recentSessionLimit,
      workspaceAliases,
      deviceSwitcherHapticsEnabled,
    }),
    [deviceSwitcherHapticsEnabled, recentSessionLimit, workspaceAliases],
  );
  const setHomeSettings = useApp((state) => state.setHomeSettings);
  const runtimes = useApp((state) => state.runtimes);
  const effectiveSelectedHostId = resolveHomeHostSelection(hosts, selectedHostId);
  const selectedHost = useMemo(
    () => hosts.find((host) => host.id === effectiveSelectedHostId) ?? hosts[0] ?? null,
    [effectiveSelectedHostId, hosts],
  );
  const selectedRuntime = selectedHost ? runtimes[selectedHost.id] : undefined;
  const hostDotColor =
    selectedRuntime?.status === "connected"
      ? (selectedRuntime.rttMs !== null && selectedRuntime.rttMs !== undefined && selectedRuntime.rttMs >= 300
          ? palette.warn
          : palette.success)
      : selectedRuntime?.status === "connecting" || selectedRuntime?.status === "reconnecting"
        ? palette.warn
        : selectedRuntime?.status === "failed"
          ? palette.danger
          : palette.textFaint;
  const hostBadgeLabel =
    selectedRuntime?.status === "connected"
      ? (selectedRuntime.rttMs !== null && selectedRuntime.rttMs !== undefined
          ? `${String(selectedRuntime.rttMs)}ms`
          : "在线")
      : selectedRuntime?.status === "connecting"
        ? "连接中"
        : selectedRuntime?.status === "reconnecting"
          ? "重连"
          : selectedRuntime?.status === "failed"
            ? "离线"
            : "待连接";
  const terminalHosts = useMemo(
    () =>
      hosts.filter(
        (host) =>
          host.id === effectiveSelectedHostId &&
          supportsRemoteTerminal(runtimes[host.id]?.hostInfo),
      ),
    [hosts, effectiveSelectedHostId, runtimes],
  );
  const activeTerminalCount = useMemo(
    () =>
      terminalHosts.reduce(
        (count, host) =>
          count +
          Object.values(runtimes[host.id]?.sessions ?? {}).filter(
            (session) => isShellTerminal(session) && !isTerminalEnded(session),
          ).length,
        0,
      ),
    [runtimes, terminalHosts],
  );
  const selectedConnection = effectiveSelectedHostId ? peekConnection(effectiveSelectedHostId) ?? null : null;
  const orchestration = useOrchestrationSnapshot(
    selectedConnection,
    effectiveSelectedHostId ? runtimes[effectiveSelectedHostId]?.status ?? "idle" : "idle",
    15_000,
  );
  const managedWorkspacePaths = useMemo(
    () => orchestration?.worktreeAssets?.map((asset) => asset.path) ?? [],
    [orchestration],
  );
  const closeDevicePicker = useCallback(() => setDevicePickerOpen(false), []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const [nextHosts, lastHostId] = await Promise.all([getHosts(), getLastHomeHostId()]);
        if (cancelled) return;
        setLocal(nextHosts);
        setSelectedHostId((current) =>
          resolveHomeHostSelection(nextHosts, current ?? lastHostId),
        );
        setHosts(nextHosts);
      })().catch(() => { if (!cancelled) toast("读取设备失败，请重新打开首页"); });
      return () => {
        cancelled = true;
      };
    }, [setHosts]),
  );

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    void getDeviceKeys().then((keys) => {
      if (cancelled) return;
      wireAppStateReconnect();
      for (const host of hosts) getConnection(host, keys).start();
    }).catch(() => { if (!cancelled) toast("读取配对凭证失败，请重新打开首页"); });
    return () => { cancelled = true; };
  }, [hosts]));

  const openTerminal = (): void => {
    if (terminalHosts.length === 1) {
      router.push(`/host/${terminalHosts[0]!.id}/terminals`);
    } else if (terminalHosts.length > 1) {
      setTerminalPickerOpen(true);
    } else {
      toast(REMOTE_TERMINAL_UNAVAILABLE);
    }
  };

  const openOrchestration = useCallback(() => {
    if (effectiveSelectedHostId) router.push(`/host/${effectiveSelectedHostId}/orchestration`);
  }, [effectiveSelectedHostId]);

  const onSelectHost = useCallback((hostId: string): void => {
    setSelectedHostId(hostId);
    setDevicePickerOpen(false);
    void rememberLastHomeHost(hostId);
  }, []);
  const onToggleDevicePicker = useCallback((): void => {
    setDevicePickerOpen((open) => !open);
  }, []);

  const onDelete = (host: StoredHost): void => {
    void Promise.all([
      removeHost(host.id),
      clearSessionPreferences(host.id).catch(() => undefined),
    ])
      .then(() => getHosts())
      .then((remaining) => {
        setLocal(remaining);
        setSelectedHostId((current) => resolveHomeHostSelection(remaining, current));
        setHosts(remaining);
      });
  };

  const onChangeHomeSettings = useCallback(
    (patch: Partial<HomeSettings>): void => {
      const next = normalizeHomeSettings({ ...useApp.getState().homeSettings, ...patch });
      setHomeSettings(next);
      void rememberHomeSettings(next);
    },
    [setHomeSettings],
  );

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Prospero",
          headerTitleAlign: "left",
          ...(selectedHost
            ? {
                headerTitle: () => (
                  <Pressable
                    testID={`home-device-card-${selectedHost.id}`}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: devicePickerOpen }}
                    accessibilityLabel={`选择电脑，当前为 ${selectedHost.name}，${hostBadgeLabel}`}
                    accessibilityHint="切换或管理已配对电脑"
                    onPress={onToggleDevicePicker}
                    style={({ pressed }) => [styles.hostPill, pressed && styles.headerButtonPressed]}
                  >
                    <View style={[styles.hostPillDot, { backgroundColor: hostDotColor }]} />
                    <Text style={styles.hostPillName} numberOfLines={1}>
                      {selectedHost.name}
                    </Text>
                    <Text style={styles.hostPillMeta} numberOfLines={1}>
                      {hostBadgeLabel}
                    </Text>
                    <Icon name="chevron.down" size={11} color={palette.textFaint} />
                  </Pressable>
                ),
              }
            : {}),
          headerRight: () => (
            <View style={styles.headerActions}>
              {effectiveSelectedHostId !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="新建会话"
                  accessibilityHint="在当前电脑新建对话或终端会话"
                  onPress={() =>
                    router.push({
                      pathname: "/host/[hostId]",
                      params: { hostId: effectiveSelectedHostId, quickCreate: "conversation" },
                    })
                  }
                  style={({ pressed }) => [
                    styles.headerPrimaryButton,
                    pressed && styles.ctaPressed,
                  ]}
                >
                  <Icon name="plus" size={16} color={palette.bg} weight="semibold" />
                </Pressable>
              )}
              {effectiveSelectedHostId !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="账号与模型源"
                  accessibilityHint="管理当前电脑的 Agent 登录态与模型源"
                  onPress={() => router.push(`/host/${effectiveSelectedHostId}/accounts`)}
                  style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
                >
                  <Icon name="command" size={16} color={palette.text} />
                </Pressable>
              )}
              {terminalHosts.length > 0 && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="远程终端"
                  accessibilityHint={
                    activeTerminalCount > 0
                      ? `当前有 ${String(activeTerminalCount)} 个运行中的终端，点击打开或新建`
                      : "打开设备的 Shell 终端，可新建或返回已有终端"
                  }
                  onPress={openTerminal}
                  style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
                >
                  <Icon name="terminal" size={17} color={palette.text} />
                  {activeTerminalCount > 0 && <View style={styles.headerLiveDot} />}
                </Pressable>
              )}
              {effectiveSelectedHostId !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="任务编排"
                  accessibilityHint="打开当前电脑的任务编排页面"
                  onPress={openOrchestration}
                  style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
                >
                  <Icon
                    name="point.3.connected.trianglepath.dotted"
                    size={17}
                    color={palette.text}
                  />
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="设置"
                accessibilityHint="打开应用、首页和设备连接设置"
                onPress={() => router.push("/settings")}
                style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
              >
                <Icon name="gearshape.fill" size={17} color={palette.text} />
              </Pressable>
            </View>
          ),
        }}
      />
      {hosts.length === 0 ? (
        <ScrollView
          testID="hosts-empty-state-scroll"
          style={[
            styles.emptyScroll,
            adaptiveLayout.verticalPanes && {
              width: adaptiveLayout.verticalPanes.end,
              alignSelf: "flex-end",
            },
          ]}
          contentContainerStyle={emptyStateLayout.contentContainer}
          keyboardShouldPersistTaps="handled"
          scrollEnabled
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.emptyWrap, emptyStateLayout.body]}>
            <Icon name="desktopcomputer" size={52} color={palette.textFaint} />
            <Text style={styles.emptyTitle}>还没有配对的电脑</Text>
            <Text style={styles.emptyText}>在电脑上运行 prosperod 并生成配对码：</Text>
            <Text style={styles.code}>prosperod start{"\n"}prosperod pair</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="扫码配对"
              accessibilityHint="打开相机扫描电脑上的配对二维码"
              style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
              onPress={() => router.push("/pair")}
            >
              <Text style={styles.ctaText}>扫码配对</Text>
            </Pressable>
          </View>
        </ScrollView>
      ) : (
        <HomeDashboard
          hosts={hosts}
          runtimes={runtimes}
          selectedHostId={effectiveSelectedHostId}
          connection={selectedConnection}
          devicePickerOpen={devicePickerOpen}
          bottomInset={insets.bottom}
          onToggleDevicePicker={onToggleDevicePicker}
          onCloseDevicePicker={closeDevicePicker}
          managedWorkspacePaths={managedWorkspacePaths}
          worktreeAssets={orchestration?.worktreeAssets}
          onSelectHost={onSelectHost}
          onOpenHost={(hostId) => router.push(`/host/${hostId}`)}
          onOpenAccounts={(hostId) => router.push(`/host/${hostId}/accounts`)}
          onOpenSession={(hostId, sessionId) =>
            router.push(`/host/${hostId}/session/${sessionId}`)
          }
          onEditHost={(hostId) => router.push(`/host/${hostId}/edit`)}
          onDeleteHost={onDelete}
          onAddHost={(mode) => router.push({ pathname: "/pair", params: { mode: mode ?? "scan" } })}
          onRefreshHost={(hostId) => peekConnection(hostId)?.kick()}
          onCreateSession={(hostId, cwd) =>
            router.push({
              pathname: "/host/[hostId]",
              params: {
                hostId,
                quickCreate: "conversation",
                ...(cwd ? { cwd } : {}),
              },
            })
          }
          onCreateDirectory={(hostId) =>
            router.push({
              pathname: "/host/[hostId]",
              params: { hostId, quickCreate: "directory" },
            })
          }
          onOpenTerminals={(hostId, cwd) =>
            router.push({
              pathname: "/host/[hostId]/terminals",
              params: { hostId, ...(cwd ? { cwd } : {}) },
            })
          }
          homeSettings={homeSettings}
          onChangeHomeSettings={onChangeHomeSettings}
        />
      )}
      <Sheet visible={terminalPickerOpen} title="选择终端电脑"
        onClose={() => { terminalNavigation.cancel(); setTerminalPickerOpen(false); }}
        onDismiss={() => terminalNavigation.dismiss()}>
        {terminalHosts.map((host) => <SheetAction key={host.id} label={host.name} symbol="terminal"
          detail={runtimes[host.id]?.status === "connected" ? "打开远程终端" : "打开后尝试连接设备"}
          onPress={() => { terminalNavigation.defer(() => router.push(`/host/${host.id}/terminals`)); setTerminalPickerOpen(false); }} />)}
      </Sheet>
    </View>
  );
}

function createStyles(palette: ThemePalette) {
  const themedFont = {
    title: { ...font.title, color: palette.text },
    sub: { ...font.sub, color: palette.textDim },
    mono: { ...font.mono, color: palette.text },
  };
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  hostPill: {
    height: 34,
    maxWidth: 230,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
  },
  hostPillDot: { width: 7, height: 7, borderRadius: 3.5, flexShrink: 0 },
  hostPillName: { color: palette.text, fontSize: 13.5, fontWeight: "700", letterSpacing: -0.2, flexShrink: 1 },
  hostPillMeta: {
    color: palette.textFaint,
    fontSize: 11,
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerPrimaryButton: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.text,
  },
  headerButton: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: palette.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
  },
  headerLiveDot: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: palette.success,
    borderWidth: 1.5,
    borderColor: palette.surface,
  },
  headerButtonPressed: { backgroundColor: palette.pressed },
  emptyScroll: { flex: 1 },
  emptyWrap: { alignItems: "center", gap: space.md },
  emptyTitle: { ...themedFont.title, textAlign: "center" },
  emptyText: { ...themedFont.sub, textAlign: "center", alignSelf: "stretch" },
  code: {
    ...themedFont.mono,
    color: palette.textDim,
    backgroundColor: palette.surfaceRaised,
    borderRadius: radius.sm,
    padding: space.md,
    alignSelf: "stretch",
    maxWidth: "100%",
  },
  cta: {
    minHeight: HOME_EMPTY_STATE_MIN_HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
    marginTop: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    backgroundColor: palette.text,
  },
  ctaPressed: { opacity: 0.84 },
  ctaText: { color: palette.bg, fontSize: 15, fontWeight: "700", textAlign: "center" },
  });
}
