import { useCallback, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
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
  openProgressOverlaySettings,
} from "@/lib/running-session-progress";
import { useApp, type ConnStatus, type HostRuntime } from "@/lib/store";
import { color, font, radius, space, statusColor } from "@/lib/theme";

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
}: {
  icon: IconName;
  title: string;
  detail?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <View style={styles.sectionIcon}>
          <Icon name={icon} size={18} color={color.accent} />
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
  last = false,
}: {
  title: string;
  detail: string;
  children: React.ReactNode;
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
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
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
}: {
  host: StoredHost;
  runtime: HostRuntime | undefined;
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
        <View style={[styles.statusDot, { backgroundColor: statusColor[status] }]} />
        <Text style={styles.deviceName} numberOfLines={1}>{host.name}</Text>
        <Text style={styles.deviceStatus}>{connectionStatusLabel[status]}</Text>
        <Icon name="chevron.right" size={17} color={color.textFaint} />
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

export default function SettingsScreen(): React.ReactElement {
  const insets = useSafeAreaInsets();
  const [hosts, setLocalHosts] = useState<StoredHost[]>(() => useApp.getState().hosts);
  const [overlayAvailable, setOverlayAvailable] = useState(canDisplayProgressOverlay());
  const settings = normalizeHomeSettings(
    useApp((state) => state.homeSettings) ?? DEFAULT_HOME_SETTINGS,
  );
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

  const updateRecentLimit = (recentSessionLimit: HomeRecentSessionLimit): void => {
    updateSettings({ recentSessionLimit });
  };

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
        >
          <View style={styles.optionBlock}>
            <Text style={styles.optionLabel}>主题</Text>
            <SegmentedOptions
              value={settings.themeMode}
              options={themeOptions}
              onChange={(themeMode) => updateSettings({ themeMode })}
              label="主题模式"
            />
          </View>
        </SettingsSection>

        <SettingsSection
          icon="clock.fill"
          title="首页显示"
          detail="控制首页信息密度"
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
            />
            <Text style={styles.optionHint}>首页仅改变展示数量，不会删除历史会话。</Text>
          </View>
        </SettingsSection>

        {Platform.OS === "android" && (
          <SettingsSection
            icon="bell.fill"
            title="后台任务"
            detail="离开 Prospero 后继续查看 Agent 进度"
          >
            <SettingRow
              title="持续通知"
              detail="运行中显示状态，点按直接返回对话"
            >
              <Switch
                value={settings.backgroundProgressEnabled}
                onValueChange={(value) =>
                  updateSettings({
                    backgroundProgressEnabled: value,
                    ...(!value ? { overlayProgressEnabled: false } : {}),
                  })
                }
                trackColor={{ false: color.border, true: color.accentDim }}
                thumbColor={settings.backgroundProgressEnabled ? color.accent : color.textDim}
              />
            </SettingRow>
            <SettingRow
              title="其他应用上层悬浮框"
              detail={
                overlayAvailable
                  ? "切到后台时显示，可拖动或点按返回"
                  : "需要授予“显示在其他应用上层”权限"
              }
              last
            >
              <Switch
                value={settings.overlayProgressEnabled}
                onValueChange={(value) => {
                  updateSettings({
                    backgroundProgressEnabled: value || settings.backgroundProgressEnabled,
                    overlayProgressEnabled: value,
                  });
                  if (value && !overlayAvailable) openProgressOverlaySettings();
                }}
                trackColor={{ false: color.border, true: color.accentDim }}
                thumbColor={settings.overlayProgressEnabled ? color.accent : color.textDim}
              />
            </SettingRow>
            <Text style={styles.privacyNote}>
              锁屏仅显示任务数量；会话标题和设备信息只在解锁后展示。
            </Text>
          </SettingsSection>
        )}

        <SettingsSection
          icon="network"
          title="设备与连接"
          detail="每台设备分别保存直连地址、端口和 Relay 凭证"
        >
          {hosts.length > 0 ? (
            hosts.map((host) => (
              <DeviceConnectionRow key={host.id} host={host} runtime={runtimes[host.id]} />
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
            <Icon name="plus" size={17} color={color.accent} />
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  content: { gap: 22, paddingHorizontal: 14, paddingTop: 18 },
  section: { gap: 10 },
  sectionHeading: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 2 },
  sectionIcon: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    backgroundColor: color.accentBg,
  },
  sectionCopy: { flex: 1, gap: 2 },
  sectionTitle: { ...font.body, fontSize: 15, fontWeight: "700" },
  sectionDetail: { ...font.meta, color: color.textDim, lineHeight: 15 },
  card: {
    overflow: "hidden",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  optionBlock: { gap: 11, padding: 13 },
  optionLabel: { color: color.text, fontSize: 13, fontWeight: "600" },
  optionHint: { ...font.meta, color: color.textFaint, lineHeight: 15 },
  segments: { flexDirection: "row", gap: 6, padding: 3, borderRadius: 10, backgroundColor: color.bg },
  segment: {
    flex: 1,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  segmentSelected: { backgroundColor: color.accentDim },
  segmentText: { color: color.textDim, fontSize: 12.5, fontWeight: "600" },
  segmentTextSelected: { color: color.text },
  settingRow: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  rowLast: { borderBottomWidth: 0 },
  settingCopy: { flex: 1, gap: 3 },
  settingTitle: { color: color.text, fontSize: 13.5, fontWeight: "600" },
  settingDetail: { color: color.textDim, fontSize: 10.5, lineHeight: 15 },
  privacyNote: {
    color: color.textFaint,
    fontSize: 10,
    lineHeight: 15,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  deviceRow: {
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  deviceRowPressed: { backgroundColor: color.pressed },
  deviceTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  deviceName: { flex: 1, color: color.text, fontSize: 14, fontWeight: "700" },
  deviceStatus: { color: color.textDim, fontSize: 10.5 },
  deviceMode: { marginLeft: 16, color: color.textDim, fontSize: 10.5 },
  relayLine: { marginLeft: 16, flexDirection: "row", alignItems: "center", gap: 7 },
  relayLabel: {
    color: color.accent,
    fontSize: 9,
    fontWeight: "800",
    paddingHorizontal: 5,
    paddingVertical: 2,
    overflow: "hidden",
    borderRadius: 5,
    backgroundColor: color.accentBg,
  },
  relayValue: { flex: 1, color: color.textFaint, fontSize: 10 },
  noDevices: { gap: 4, alignItems: "center", padding: 22 },
  noDevicesTitle: { color: color.text, fontSize: 13, fontWeight: "600" },
  noDevicesDetail: { color: color.textDim, fontSize: 10.5, textAlign: "center" },
  addDevice: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  addDeviceText: { color: color.accent, fontSize: 13, fontWeight: "600" },
  footer: { color: color.textFaint, fontSize: 10, lineHeight: 15, textAlign: "center", paddingHorizontal: 12 },
  pressed: { opacity: 0.64 },
});
