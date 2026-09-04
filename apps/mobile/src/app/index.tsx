import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HomeDashboard } from "@/components/HomeDashboard";
import { Icon } from "@/components/Icon";
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
import { color, font, radius, space } from "@/lib/theme";

export default function HostsScreen() {
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
  const setHosts = useApp((state) => state.setHosts);
  const homeSettings = useApp((state) => state.homeSettings) ?? DEFAULT_HOME_SETTINGS;
  const setHomeSettings = useApp((state) => state.setHomeSettings);
  const runtimes = useApp((state) => state.runtimes);
  const effectiveSelectedHostId = resolveHomeHostSelection(hosts, selectedHostId);

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
        // 首页是跨设备控制台：并行连接全部设备，握手会把各自的会话写入 store，
        // 下方工作目录页签随即刷新，不再要求用户先进入设备详情页。
        const keys = await getDeviceKeys();
        if (cancelled) return;
        wireAppStateReconnect();
        for (const host of nextHosts) getConnection(host, keys).start();
      })();
      return () => {
        cancelled = true;
      };
    }, [setHosts]),
  );

  const onSelectHost = useCallback((hostId: string): void => {
    setSelectedHostId(hostId);
    setDevicePickerOpen(false);
    void rememberLastHomeHost(hostId);
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
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="设置"
                accessibilityHint="打开应用、首页和设备连接设置"
                onPress={() => router.push("/settings")}
                style={styles.headerButton}
              >
                <Icon name="gearshape.fill" size={20} color={color.accent} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="扫码配对"
                accessibilityHint="打开相机扫描电脑上的配对二维码"
                onPress={() => router.push("/pair")}
                style={styles.headerButton}
              >
                <Icon name="qrcode.viewfinder" size={21} color={color.accent} />
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
            <Icon name="desktopcomputer" size={52} color={color.textFaint} />
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
          devicePickerOpen={devicePickerOpen}
          bottomInset={insets.bottom}
          onToggleDevicePicker={() => setDevicePickerOpen((open) => !open)}
          onSelectHost={onSelectHost}
          onOpenHost={(hostId) => router.push(`/host/${hostId}`)}
          onOpenSession={(hostId, sessionId) =>
            router.push(`/host/${hostId}/session/${sessionId}`)
          }
          onEditHost={(hostId) => router.push(`/host/${hostId}/edit`)}
          onDeleteHost={onDelete}
          onAddHost={() => router.push("/pair")}
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
          onOpenSettings={() => router.push("/settings")}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 2 },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  emptyScroll: { flex: 1 },
  emptyWrap: { alignItems: "center", gap: space.md },
  emptyTitle: { ...font.title, textAlign: "center" },
  emptyText: { ...font.sub, textAlign: "center", alignSelf: "stretch" },
  code: {
    ...font.mono,
    color: color.textDim,
    backgroundColor: color.surfaceRaised,
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
    backgroundColor: color.accentDim,
  },
  ctaPressed: { backgroundColor: color.pressed },
  ctaText: { color: color.text, fontSize: 15, fontWeight: "600", textAlign: "center" },
});
