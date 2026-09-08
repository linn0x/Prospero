import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { Icon } from "../Icon";
import type { StoredHost } from "@/lib/hosts";
import type { ConnStatus, HostRuntime } from "@/lib/store";
import { useMobileTheme, type ThemePalette } from "@/lib/theme";

const modeLabels: Record<StoredHost["connectionMode"], string> = { auto: "自动选择", direct: "仅直连", relay: "仅 Relay" };
const statusLabels: Record<ConnStatus, string> = { idle: "未连接", connecting: "连接中", connected: "已连接", reconnecting: "重连中", failed: "连接失败" };

export function DeviceConnectionRow({ host, runtime, last }: { host: StoredHost; runtime?: HostRuntime; last: boolean }) {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const status = runtime?.status ?? "idle";
  const tone = status === "connected" ? palette.success : status === "failed" ? palette.danger
    : status === "connecting" || status === "reconnecting" ? palette.warn : palette.textFaint;
  const activePath = runtime?.activePath === "relay" ? "当前经 Relay" : runtime?.activePath === "direct" ? "当前直连" : null;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${host.name} 的连接与 Relay 设置`}
    onPress={() => router.push({ pathname: "/host/[hostId]/edit", params: { hostId: host.id } })}
    style={({ pressed }) => [styles.row, last && styles.last, pressed && styles.pressed]}>
    <View style={styles.top}>
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Text style={styles.name} numberOfLines={1}>{host.name}</Text>
      <Text style={styles.status}>{statusLabels[status]}</Text>
      <Icon name="chevron.right" size={16} color={palette.textFaint} />
    </View>
    <Text style={styles.mode}>{modeLabels[host.connectionMode]}{activePath ? ` · ${activePath}` : ""} · {host.addrs.length} 个直连地址</Text>
    <View style={styles.relay}>
      <Text style={styles.relayLabel}>Relay</Text>
      <Text style={styles.relayValue} numberOfLines={1} ellipsizeMode="middle">{host.relay ? host.relay.url : "未配置 · 重新扫码可添加凭证"}</Text>
    </View>
  </Pressable>;
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    row: { gap: 8, padding: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border },
    last: { borderBottomWidth: 0 }, pressed: { backgroundColor: palette.pressed },
    top: { flexDirection: "row", alignItems: "center", gap: 8 }, dot: { width: 7, height: 7, borderRadius: 4 },
    name: { flex: 1, minWidth: 0, color: palette.text, fontSize: 14, fontWeight: "600" }, status: { color: palette.textDim, fontSize: 10.5 },
    mode: { marginLeft: 15, color: palette.textDim, fontSize: 11, lineHeight: 16 },
    relay: { marginLeft: 15, flexDirection: "row", gap: 7, alignItems: "center" },
    relayLabel: { color: palette.accent, fontSize: 10, fontWeight: "600" },
    relayValue: { flex: 1, color: palette.textFaint, fontSize: 10.5 },
  });
}
