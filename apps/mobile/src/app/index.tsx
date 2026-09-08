import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HomeDashboard } from "@/components/HomeDashboard";
import { EdgeDashboard } from "@/components/EdgeDashboard";
import { HomeModeTitle } from "@/components/HomeModeTitle";
import { toast } from "@/components/Toast";
import { Icon } from "@/components/Icon";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import { dropConnection, getConnection, peekConnection, wireAppStateReconnect } from "@/lib/connection";
import { selectedEdgeHosts, useEdgePreferences } from "@/lib/edge-preferences";
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
import { useOrderedDevices } from "@/lib/device-order-preferences";
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
  const [storedHosts, setLocal] = useState<StoredHost[]>([]);
  const hosts = useOrderedDevices(storedHosts);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const [choosingEdgeOrchestration, setChoosingEdgeOrchestration] = useState(false);
  const mode = useEdgePreferences((state) => state.mode);
  const edgeHostIds = useEdgePreferences((state) => state.selectedHostIds);
  const edgeHydrated = useEdgePreferences((state) => state.hydrated);
  const hydrateEdge = useEdgePreferences((state) => state.hydrate);
  const setMode = useEdgePreferences((state) => state.setMode);
  const selectEdgeHosts = useEdgePreferences((state) => state.selectHosts);
  const edgeHosts = useMemo(() => selectedEdgeHosts(hosts, edgeHostIds), [hosts, edgeHostIds]);
  useEffect(() => { void hydrateEdge(); }, [hydrateEdge]);
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
  const selectedConnection = mode === "normal" && effectiveSelectedHostId ? peekConnection(effectiveSelectedHostId) ?? null : null;
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
    if (!edgeHydrated) return;
    let cancelled = false;
    const activeHosts = mode === "edge" ? edgeHosts : hosts;
    // Drop excluded sockets from the reconnect registry as well as the live connection.
    // This runs only on the home screen; opening a device still permits a direct connection.
    if (mode === "edge") {
      const included = new Set(activeHosts.map((host) => host.id));
      for (const host of hosts) if (!included.has(host.id)) dropConnection(host.id);
    }
    void getDeviceKeys().then((keys) => {
      if (cancelled) return;
      wireAppStateReconnect();
      for (const host of activeHosts) getConnection(host, keys).start();
    }).catch(() => { if (!cancelled) toast("读取配对凭证失败，请重新打开首页"); });
    return () => { cancelled = true; };
  }, [edgeHosts, edgeHydrated, hosts, mode]));

  const toggleMode = useCallback(() => {
    setDevicePickerOpen(false);
    setChoosingEdgeOrchestration(false);
    setMode(mode === "edge" ? "normal" : "edge");
  }, [mode, setMode]);

  const openOrchestration = useCallback(() => {
    if (mode === "normal") {
      if (effectiveSelectedHostId) router.push(`/host/${effectiveSelectedHostId}/orchestration`);
      return;
    }
    if (edgeHosts.length === 0) {
      toast("请先点击设备卡片，选择要编排的设备");
    } else if (edgeHosts.length === 1) {
      router.push(`/host/${edgeHosts[0]!.id}/orchestration`);
    } else {
      setChoosingEdgeOrchestration((current) => !current);
    }
  }, [edgeHosts, effectiveSelectedHostId, mode]);

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
          headerTitle: () => <HomeModeTitle edge={mode === "edge"} onToggle={toggleMode} />,
          headerRight: () => (
            <View style={styles.headerActions}>
              {effectiveSelectedHostId !== null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Agent 编排"
                  accessibilityHint={mode === "edge" ? "打开所选设备的 Agent 编排，多台设备时在设备卡片中选择" : "打开当前设备的 Agent 编排页面"}
                  accessibilityState={{ expanded: mode === "edge" && choosingEdgeOrchestration }}
                  onPress={openOrchestration}
                  style={styles.headerButton}
                >
                  <Icon
                    name="point.3.connected.trianglepath.dotted"
                    size={21}
                    color={palette.accent}
                  />
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="设置"
                accessibilityHint="打开应用、首页和设备连接设置"
                onPress={() => router.push("/settings")}
                style={styles.headerButton}
              >
                <Icon name="gearshape.fill" size={20} color={palette.accent} />
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
      ) : mode === "edge" ? (
        <EdgeDashboard
          hosts={hosts}
          selectedHosts={edgeHosts}
          runtimes={runtimes}
          bottomInset={insets.bottom}
          homeSettings={homeSettings}
          onSelectHosts={(ids) => { setChoosingEdgeOrchestration(false); selectEdgeHosts(ids); }}
          choosingOrchestration={choosingEdgeOrchestration}
          onCancelOrchestration={() => setChoosingEdgeOrchestration(false)}
          onOpenOrchestration={(hostId) => {
            if (!edgeHosts.some((host) => host.id === hostId)) return;
            setChoosingEdgeOrchestration(false);
            router.push(`/host/${hostId}/orchestration`);
          }}
          onOpenHost={(hostId) => router.push(`/host/${hostId}`)}
          onOpenSession={(hostId, sessionId) => router.push(`/host/${hostId}/session/${sessionId}`)}
          onRefreshHost={(hostId) => peekConnection(hostId)?.kick()}
          onCreateSession={(hostId, cwd) => router.push({ pathname: "/host/[hostId]", params: {
            hostId, quickCreate: "conversation", ...(cwd ? { cwd } : {}),
          } })}
          onCreateDirectory={(hostId) => router.push({ pathname: "/host/[hostId]", params: { hostId, quickCreate: "directory" } })}
          onChangeHomeSettings={onChangeHomeSettings}
        />
      ) : (
        <HomeDashboard
          hosts={hosts}
          runtimes={runtimes}
          selectedHostId={effectiveSelectedHostId}
          devicePickerOpen={devicePickerOpen}
          bottomInset={insets.bottom}
          onToggleDevicePicker={onToggleDevicePicker}
          onCloseDevicePicker={closeDevicePicker}
          managedWorkspacePaths={managedWorkspacePaths}
          onSelectHost={onSelectHost}
          onOpenHost={(hostId) => router.push(`/host/${hostId}`)}
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
          homeSettings={homeSettings}
          onChangeHomeSettings={onChangeHomeSettings}
        />
      )}
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
  headerActions: { flexDirection: "row", alignItems: "center", gap: 2 },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
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
    borderRadius: radius.md,
    backgroundColor: palette.accentDim,
  },
  ctaPressed: { backgroundColor: palette.pressed },
  ctaText: { color: palette.text, fontSize: 15, fontWeight: "600", textAlign: "center" },
  });
}
