import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { router, Stack, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon, type IconName } from "@/components/Icon";
import {
  DEFAULT_HOME_SETTINGS,
  getHomeSettings,
  HOME_RECENT_SESSION_LIMITS,
  normalizeHomeSettings,
  rememberHomeSettings,
  type HomeRecentSessionLimit,
  type HomeSettings,
  type HomeThemeMode,
} from "@/lib/home-preferences";
import { getHosts, type StoredHost } from "@/lib/hosts";
import {
  canDisplayProgressOverlay,
  isProgressOverlaySupported,
  openProgressOverlaySettings,
} from "@/lib/running-session-progress";
import { useApp, type ConnStatus, type HostRuntime } from "@/lib/store";
import {
  paletteForScheme,
  radius,
  resolveThemeScheme,
  space,
  type ThemePalette,
} from "@/lib/theme";

type SettingsStyles = ReturnType<typeof createStyles>;

const themeOptions: readonly { value: HomeThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const connectionModeLabel: Record<StoredHost["connectionMode"], string> = {
  auto: "自动选择",
  direct: "仅直连",
  relay: "仅 Relay",
};

const connectionStatusLabel: Record<ConnStatus, string> = {
  idle: "未连接",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  failed: "连接失败",
};

function SettingsSection({
  icon,
  title,
  detail,
  children,
  palette,
  styles,
}: {
  icon: IconName;
  title: string;
  detail?: string;
  children: React.ReactNode;
  palette: ThemePalette;
  styles: SettingsStyles;
}): React.ReactElement {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <View style={styles.sectionIcon}>
          <Icon name={icon} size={18} color={palette.accent} />
        </View>
        <View style={styles.sectionCopy}>
          <Text style={styles.sectionTitle}>{title}</Text>
          {detail ? <Text style={styles.sectionDetail}>{detail}</Text> : null}
        </View>
      </View>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function SettingRow({
  title,
  detail,
  children,
  styles,
  last = false,
}: {
  title: string;
  detail: string;
  children: React.ReactNode;
  styles: SettingsStyles;
  last?: boolean;
}): React.ReactElement {
  return (
    <View style={[styles.settingRow, last && styles.rowLast]}>
      <View style={styles.settingCopy}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingDetail}>{detail}</Text>
      </View>
      {children}
    </View>
  );
}

function SegmentedOptions<T extends string | number>({
  value,
  options,
  onChange,
  label,
  styles,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
  styles: SettingsStyles;
}): React.ReactElement {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.segments}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.segment,
              selected && styles.segmentSelected,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function relaySummary(host: StoredHost): string {
  if (!host.relay) return "未配置 Relay · 重新扫码可添加凭证";
  return host.relay.url;
}

function DeviceConnectionRow({
  host,
  runtime,
  palette,
  styles,
}: {
  host: StoredHost;
  runtime: HostRuntime | undefined;
  palette: ThemePalette;
  styles: SettingsStyles;
}): React.ReactElement {
  const status = runtime?.status ?? "idle";
  const activePath =
    runtime?.activePath === "relay"
      ? "当前经 Relay"
      : runtime?.activePath === "direct"
        ? "当前直连"
        : null;

  return (
    <Pressable
      style={({ pressed }) => [styles.deviceRow, pressed && styles.deviceRowPressed]}
      onPress={() =>
        router.push({ pathname: "/host/[hostId]/edit", params: { hostId: host.id } })
      }
      accessibilityRole="button"
      accessibilityLabel={`${host.name} 的连接与 Relay 设置`}
    >
      <View style={styles.deviceTop}>
        <View style={[styles.statusDot, { backgroundColor: connectionStatusColor(status, palette) }]} />
        <Text style={styles.deviceName} numberOfLines={1}>{host.name}</Text>
        <Text style={styles.deviceStatus}>{connectionStatusLabel[status]}</Text>
        <Icon name="chevron.right" size={17} color={palette.textFaint} />
      </View>
      <Text style={styles.deviceMode}>
        {connectionModeLabel[host.connectionMode]}
        {activePath ? ` · ${activePath}` : ""}
        {` · ${String(host.addrs.length)} 个直连地址`}
      </Text>
      <View style={styles.relayLine}>
        <Text style={styles.relayLabel}>Relay</Text>
        <Text style={styles.relayValue} numberOfLines={1} ellipsizeMode="middle">
          {relaySummary(host)}
        </Text>
      </View>
    </Pressable>
  );
}

function connectionStatusColor(status: ConnStatus, palette: ThemePalette): string {
  if (status === "connected") return palette.success;
  if (status === "connecting" || status === "reconnecting") return palette.warn;
  if (status === "failed") return palette.danger;
  return palette.accent;
}

export default function SettingsScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const [hosts, setLocalHosts] = useState<StoredHost[]>(() => useApp.getState().hosts);
  const [overlayAvailable, setOverlayAvailable] = useState(canDisplayProgressOverlay());
  const [overlayPermissionPending, setOverlayPermissionPending] = useState(false);
  const overlaySupported = isProgressOverlaySupported();
  const settings = normalizeHomeSettings(
    useApp((state) => state.homeSettings) ?? DEFAULT_HOME_SETTINGS,
  );
  const systemScheme = useColorScheme();
  const activeScheme = resolveThemeScheme(settings.themeMode, systemScheme);
  const palette = paletteForScheme(activeScheme);
  const styles = useMemo(() => createStyles(palette), [palette]);
  const runtimes = useApp((state) => state.runtimes);
  const setHosts = useApp((state) => state.setHosts);
  const setHomeSettings = useApp((state) => state.setHomeSettings);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void Promise.all([getHosts(), getHomeSettings()]).then(([nextHosts, savedSettings]) => {
        if (cancelled) return;
        setLocalHosts(nextHosts);
        setHosts(nextHosts);
        setHomeSettings(savedSettings);
        setOverlayAvailable(canDisplayProgressOverlay());
      });
      return () => { cancelled = true; };
    }, [setHomeSettings, setHosts]),
  );

  const updateSettings = useCallback(
    (patch: Partial<HomeSettings>): void => {
      const next = normalizeHomeSettings({ ...useApp.getState().homeSettings, ...patch });
      setHomeSettings(next);
      void rememberHomeSettings(next);
    },
    [setHomeSettings],
  );

  useEffect(() => {
    if (Platform.OS !== "android") return undefined;
    const reconcileOverlayPermission = (): void => {
      const available = canDisplayProgressOverlay();
      setOverlayAvailable(available);

      if (overlayPermissionPending) {
        setOverlayPermissionPending(false);
        if (available) {
          updateSettings({
            backgroundProgressEnabled: true,
            overlayProgressEnabled: true,
          });
        }
        return;
      }

      if (!available && useApp.getState().homeSettings?.overlayProgressEnabled) {
        updateSettings({ overlayProgressEnabled: false });
      }
    };
    const stateSubscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") reconcileOverlayPermission();
    });
    const focusSubscription = AppState.addEventListener("focus", reconcileOverlayPermission);
    return () => {
      stateSubscription.remove();
      focusSubscription.remove();
    };
  }, [overlayPermissionPending, updateSettings]);

  const updateRecentLimit = (recentSessionLimit: HomeRecentSessionLimit): void => {
    updateSettings({ recentSessionLimit });
  };

  const updateThemeMode = useCallback(
    (themeMode: HomeThemeMode): void => {
      // 先发布 React 状态，让本页和根导航在同一帧完成重绘；根布局会在提交后
      // 再同步 Android uiMode，避免原生配置更新阻塞用户看到的第一帧。
      updateSettings({ themeMode });
    },
    [updateSettings],
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "设置", headerBackButtonDisplayMode: "minimal" }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}
        showsVerticalScrollIndicator={false}
      >
        <SettingsSection
          icon="circle.lefthalf.filled"
          title="外观"
          detail="主题会立即应用到整个移动端"
          palette={palette}
          styles={styles}
        >
          <View style={styles.optionBlock}>
            <Text style={styles.optionLabel}>主题</Text>
            <SegmentedOptions
              value={settings.themeMode}
              options={themeOptions}
              onChange={updateThemeMode}
              label="主题模式"
              styles={styles}
            />
          </View>
        </SettingsSection>

        <SettingsSection
          icon="clock.fill"
          title="首页显示"
          detail="控制首页信息密度"
          palette={palette}
          styles={styles}
        >
          <View style={styles.optionBlock}>
            <Text style={styles.optionLabel}>最近对话数量</Text>
            <SegmentedOptions
              value={settings.recentSessionLimit}
              options={HOME_RECENT_SESSION_LIMITS.map((limit) => ({
                value: limit,
                label: String(limit),
              }))}
              onChange={updateRecentLimit}
              label="首页最近对话数量"
              styles={styles}
            />
            <Text style={styles.optionHint}>首页仅改变展示数量，不会删除历史会话。</Text>
          </View>
        </SettingsSection>

        {Platform.OS === "android" && (
          <SettingsSection
            icon="bell.fill"
            title="后台任务"
            detail="离开 Prospero 后继续查看 Agent 进度"
            palette={palette}
            styles={styles}
          >
            <SettingRow
              title="持续通知"
              detail="运行中显示状态，点按直接返回对话"
              styles={styles}
            >
              <Switch
                value={settings.backgroundProgressEnabled}
                onValueChange={(value) =>
                  updateSettings({
                    backgroundProgressEnabled: value,
                    ...(!value ? { overlayProgressEnabled: false } : {}),
                  })
                }
                trackColor={{ false: palette.border, true: palette.accentDim }}
                thumbColor={settings.backgroundProgressEnabled ? palette.accent : palette.textDim}
              />
            </SettingRow>
            <SettingRow
              title="其他应用上层悬浮框"
              detail={
                !overlaySupported
                  ? "当前安装包不包含悬浮窗模块，请更新应用"
                  : overlayPermissionPending
                    ? "请在系统页面允许显示在其他应用上层"
                    : overlayAvailable
                      ? "后台显示进度；待审批时可拒绝或允许一次"
                      : "开启时将前往系统页面授予悬浮窗权限"
              }
              styles={styles}
              last
            >
              <Switch
                disabled={!overlaySupported || overlayPermissionPending}
                value={settings.overlayProgressEnabled || overlayPermissionPending}
                onValueChange={(value) => {
                  if (!value) {
                    setOverlayPermissionPending(false);
                    updateSettings({ overlayProgressEnabled: false });
                    return;
                  }

                  const available = canDisplayProgressOverlay();
                  setOverlayAvailable(available);
                  if (available) {
                    updateSettings({
                      backgroundProgressEnabled: true,
                      overlayProgressEnabled: true,
                    });
                    return;
                  }

                  setOverlayPermissionPending(true);
                  updateSettings({
                    backgroundProgressEnabled: true,
                    overlayProgressEnabled: false,
                  });
                  openProgressOverlaySettings();
                }}
                trackColor={{ false: palette.border, true: palette.accentDim }}
                thumbColor={
                  settings.overlayProgressEnabled || overlayPermissionPending
                    ? palette.accent
                    : palette.textDim
                }
              />
            </SettingRow>
            <Text style={styles.privacyNote}>
              锁屏仅显示任务数量；悬浮窗会显示审批摘要和首个资源，只提供“拒绝”和“允许一次”。
            </Text>
          </SettingsSection>
        )}

        <SettingsSection
          icon="network"
          title="设备与连接"
          detail="每台设备分别保存直连地址、端口和 Relay 凭证"
          palette={palette}
          styles={styles}
        >
          {hosts.length > 0 ? (
            hosts.map((host) => (
              <DeviceConnectionRow
                key={host.id}
                host={host}
                runtime={runtimes[host.id]}
                palette={palette}
                styles={styles}
              />
            ))
          ) : (
            <View style={styles.noDevices}>
              <Text style={styles.noDevicesTitle}>还没有配对设备</Text>
              <Text style={styles.noDevicesDetail}>配对后可在这里统一管理连接方式和 Relay。</Text>
            </View>
          )}
          <Pressable
            style={({ pressed }) => [styles.addDevice, pressed && styles.pressed]}
            onPress={() => router.push("/pair")}
            accessibilityRole="button"
            accessibilityLabel="添加设备"
          >
            <Icon name="plus" size={17} color={palette.accent} />
            <Text style={styles.addDeviceText}>添加设备</Text>
          </Pressable>
        </SettingsSection>

        <Text style={styles.footer}>
          Relay ticket 和配对密钥不会显示在页面中。缺少 Relay 凭证时需要重新扫码配对。
        </Text>
      </ScrollView>
    </View>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.bg },
  content: { gap: 22, paddingHorizontal: 14, paddingTop: 18 },
  section: { gap: 10 },
  sectionHeading: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 2 },
  sectionIcon: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: palette.accentBg,
  },
  sectionCopy: { flex: 1, gap: 2 },
  sectionTitle: { color: palette.text, fontSize: 15, fontWeight: "700" },
  sectionDetail: { color: palette.textDim, fontSize: 11, lineHeight: 15 },
  card: {
    overflow: "hidden",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.border,
    backgroundColor: palette.surface,
  },
  optionBlock: { gap: 11, padding: 13 },
  optionLabel: { color: palette.text, fontSize: 13, fontWeight: "600" },
  optionHint: { color: palette.textFaint, fontSize: 11, lineHeight: 15 },
  segments: { flexDirection: "row", gap: 6, padding: 3, borderRadius: 10, backgroundColor: palette.bg },
  segment: {
    flex: 1,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  segmentSelected: { backgroundColor: palette.accentDim },
  segmentText: { color: palette.textDim, fontSize: 12.5, fontWeight: "600" },
  segmentTextSelected: { color: palette.text },
  settingRow: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  rowLast: { borderBottomWidth: 0 },
  settingCopy: { flex: 1, gap: 3 },
  settingTitle: { color: palette.text, fontSize: 13.5, fontWeight: "600" },
  settingDetail: { color: palette.textDim, fontSize: 10.5, lineHeight: 15 },
  privacyNote: {
    color: palette.textFaint,
    fontSize: 10,
    lineHeight: 15,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.border,
  },
  deviceRow: {
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.border,
  },
  deviceRowPressed: { backgroundColor: palette.pressed },
  deviceTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  deviceName: { flex: 1, color: palette.text, fontSize: 14, fontWeight: "700" },
  deviceStatus: { color: palette.textDim, fontSize: 10.5 },
  deviceMode: { marginLeft: 16, color: palette.textDim, fontSize: 10.5 },
  relayLine: { marginLeft: 16, flexDirection: "row", alignItems: "center", gap: 7 },
  relayLabel: {
    color: palette.accent,
    fontSize: 9,
    fontWeight: "800",
    paddingHorizontal: 5,
    paddingVertical: 2,
    overflow: "hidden",
    borderRadius: 5,
    backgroundColor: palette.accentBg,
  },
  relayValue: { flex: 1, color: palette.textFaint, fontSize: 10 },
  noDevices: { gap: 4, alignItems: "center", padding: 22 },
  noDevicesTitle: { color: palette.text, fontSize: 13, fontWeight: "600" },
  noDevicesDetail: { color: palette.textDim, fontSize: 10.5, textAlign: "center" },
  addDevice: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  addDeviceText: { color: palette.accent, fontSize: 13, fontWeight: "600" },
  footer: { color: palette.textFaint, fontSize: 10, lineHeight: 15, textAlign: "center", paddingHorizontal: 12 },
  pressed: { opacity: 0.64 },
  });
}
