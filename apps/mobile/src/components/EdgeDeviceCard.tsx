import { useEffect, useMemo } from "react";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, useAnimatedValue, useWindowDimensions, View } from "react-native";
import { Icon } from "./Icon";
import type { StoredHost } from "@/lib/hosts";
import type { HostRuntime } from "@/lib/store";
import { edgeDeviceColumns, edgeDeviceConnectionLabel, toggleEdgeHost } from "@/lib/edge-devices";
import { radius, space, useMobileTheme, type ThemePalette } from "@/lib/theme";

function DeviceChip({ host, runtime, index, columns, selected, choosingOrchestration, onToggle, onOpenHost, onOpenOrchestration }: {
  host: StoredHost;
  runtime?: HostRuntime;
  index: number;
  columns: number;
  selected: boolean;
  choosingOrchestration: boolean;
  onToggle: () => void;
  onOpenHost: () => void;
  onOpenOrchestration: () => void;
}) {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const entrance = useAnimatedValue(1);
  useEffect(() => {
    let active = true;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (reduce) => {
      if (reduce) { entrance.stopAnimation(); entrance.setValue(1); }
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!active || reduce) return;
      entrance.setValue(0);
      Animated.timing(entrance, { toValue: 1, delay: Math.min(index * 35, 175), duration: 240, useNativeDriver: true }).start();
    }).catch(() => undefined);
    return () => { active = false; subscription.remove(); entrance.stopAnimation(); };
  }, [entrance, index]);

  const platform = runtime?.hostInfo?.platform?.toLowerCase() ?? "";
  const brand = platform === "win32" || platform.includes("windows") ? "windows"
    : platform === "darwin" || platform.includes("mac") ? "apple" : platform.includes("linux") ? "linux" : null;
  const tone = selected ? palette.accent : palette.textFaint;
  const disabled = choosingOrchestration && !selected;
  return <Animated.View style={[styles.cell, { width: `${100 / columns}%`, opacity: entrance,
    transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) }] }]}>
    <Pressable
      accessibilityRole={choosingOrchestration ? "button" : "checkbox"}
      accessibilityState={choosingOrchestration ? { disabled } : { checked: selected }}
      accessibilityLabel={`${host.name}，${selected ? edgeDeviceConnectionLabel(runtime) : "未选择"}`}
      accessibilityHint={choosingOrchestration ? "打开此设备的 Agent 编排" : "点击选择或取消选择，长按查看设备详情"}
      disabled={disabled}
      onPress={choosingOrchestration ? onOpenOrchestration : onToggle}
      onLongPress={choosingOrchestration ? undefined : onOpenHost}
      style={({ pressed }) => [styles.chip, selected && styles.selected, disabled && styles.disabled, pressed && styles.pressed]}
    >
      {brand ? <FontAwesome6 name={brand} size={15} color={tone} /> : <Icon name="desktopcomputer" size={15} color={tone} />}
      <Text style={[styles.name, !selected && styles.muted]} numberOfLines={1}>{host.name}</Text>
      <Text style={[styles.latency, { color: selected && runtime?.status === "connected" ? palette.success : palette.textFaint }]}>
        {selected ? edgeDeviceConnectionLabel(runtime) : "—"}
      </Text>
    </Pressable>
  </Animated.View>;
}

export function EdgeDeviceCard({ hosts, selectedHosts, runtimes, choosingOrchestration, onSelectHosts, onOpenHost,
  onOpenOrchestration, onCancelOrchestration }: {
  hosts: StoredHost[];
  selectedHosts: StoredHost[];
  runtimes: Record<string, HostRuntime>;
  choosingOrchestration: boolean;
  onSelectHosts: (ids: string[]) => void;
  onOpenHost: (hostId: string) => void;
  onOpenOrchestration: (hostId: string) => void;
  onCancelOrchestration: () => void;
}) {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const { width, fontScale } = useWindowDimensions();
  const columns = edgeDeviceColumns(Math.min(width, 840) - space.lg * 2 - space.sm * 2, fontScale);
  const selectedIds = useMemo(() => new Set(selectedHosts.map((host) => host.id)), [selectedHosts]);
  const connected = selectedHosts.filter((host) => runtimes[host.id]?.status === "connected").length;
  const allSelected = hosts.length > 0 && selectedHosts.length === hosts.length;
  return <View testID="edge-device-card" style={styles.card}>
    <View style={styles.heading}>
      <Text accessibilityLiveRegion="polite" style={styles.caption} numberOfLines={1}>
        {choosingOrchestration ? "点选设备，打开 Agent 编排" : `设备 ${selectedHosts.length}/${hosts.length} · ${connected} 在线`}
      </Text>
      <Pressable accessibilityRole="button"
        accessibilityLabel={choosingOrchestration ? "取消选择编排设备" : allSelected ? "取消选择全部 Edge 设备" : "选择全部 Edge 设备"}
        onPress={choosingOrchestration ? onCancelOrchestration : () => onSelectHosts(allSelected ? [] : hosts.map((host) => host.id))}
        style={styles.action}>
        <Text style={styles.link}>{choosingOrchestration ? "取消" : allSelected ? "清空" : "全选"}</Text>
      </Pressable>
    </View>
    <View style={styles.grid}>
      {hosts.map((host, index) => <DeviceChip key={host.id} host={host} runtime={runtimes[host.id]} index={index} columns={columns}
        selected={selectedIds.has(host.id)} choosingOrchestration={choosingOrchestration}
        onToggle={() => onSelectHosts(toggleEdgeHost(hosts, selectedIds, host.id))}
        onOpenHost={() => onOpenHost(host.id)} onOpenOrchestration={() => onOpenOrchestration(host.id)} />)}
    </View>
  </View>;
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    card: { backgroundColor: palette.surface, borderRadius: radius.md, paddingHorizontal: space.sm, paddingBottom: space.sm },
    heading: { flexDirection: "row", alignItems: "center", paddingLeft: 3 },
    caption: { flex: 1, color: palette.textFaint, fontSize: 11 },
    action: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
    link: { color: palette.accent, fontSize: 12, fontWeight: "600" },
    grid: { flexDirection: "row", flexWrap: "wrap", margin: -3 },
    cell: { padding: 3 },
    chip: { flexDirection: "row", alignItems: "center", minHeight: 44, gap: 6, paddingHorizontal: 8,
      borderRadius: radius.sm, borderWidth: 1, borderColor: palette.border },
    selected: { borderColor: palette.accent, backgroundColor: palette.accentBg },
    name: { flex: 1, color: palette.text, fontSize: 12, fontWeight: "500" },
    muted: { color: palette.textFaint },
    latency: { fontSize: 10, fontVariant: ["tabular-nums"] },
    disabled: { opacity: 0.45 }, pressed: { backgroundColor: palette.pressed },
  });
}
