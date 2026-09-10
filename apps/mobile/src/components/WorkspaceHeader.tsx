import { useCallback, useMemo, useState } from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { peekConnection } from "@/lib/connection";
import { useApp } from "@/lib/store";
import { bytes } from "@/lib/format";
import { getWorkspaceSummary, type WorkspaceSummary } from "@/lib/workspace-summary";
import { useMobileTheme, type ThemePalette } from "@/lib/theme";

/** Only mounted directory rows read metadata. Scans are cached and bounded on the daemon. */
export function WorkspaceHeader({ hostId, path, sid, name, sessionCount, activity, deviceLabel, deviceDetail, deviceOffline }: {
  hostId: string; path: string; sid?: string; name: string; sessionCount: number;
  activity?: { label: string; pending: boolean };
  deviceLabel?: string;
  deviceDetail?: string;
  deviceOffline?: boolean;
}) {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const status = useApp((state) => state.runtimes[hostId]?.status);
  const connection = peekConnection(hostId);
  const identity = JSON.stringify([hostId, path]);
  const [received, setReceived] = useState<{ identity: string; summary: WorkspaceSummary } | null>(null);
  useFocusEffect(useCallback(() => {
    if (!connection || status !== "connected" || !sid) return;
    let active = true;
    let loading = false;
    const refresh = (): void => {
      if (!active || loading || (AppState.currentState && AppState.currentState !== "active")) return;
      loading = true;
      void getWorkspaceSummary(connection, hostId, path, sid).then((summary) => {
        if (active) setReceived({ identity, summary });
      }).catch(() => undefined).finally(() => { loading = false; });
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [connection, hostId, identity, path, sid, status]));
  const summary = received?.identity === identity ? received.summary : null;
  const size = summary?.sizeBytes == null ? null : `${summary.sizeComplete ? "" : "≥ "}${bytes(summary.sizeBytes)}`;
  return <View style={styles.header} testID="workspace-header">
    <View style={styles.copy}>
      <View style={styles.identity}>
        <Text style={styles.name} numberOfLines={1} testID="workspace-name">{name}</Text>
        {deviceLabel && <Text style={[styles.device, deviceOffline && { color: palette.warn }]} numberOfLines={1} testID="workspace-device"
          accessibilityLabel={deviceDetail ?? deviceLabel}>{deviceOffline ? "离线 · " : ""}{deviceLabel}</Text>}
        {summary?.branch && <View style={styles.gitMark} accessible accessibilityRole="image"
          accessibilityLabel={`Git 仓库${status === "connected" ? "" : "，上次读取"}`} testID="workspace-git-repository">
          <FontAwesome6 name="git-alt" size={14} color={palette.textDim} />
        </View>}
      </View>
      <View style={styles.row}>
        <Text style={styles.path} numberOfLines={1} ellipsizeMode="middle">{path}</Text>
        {size && <Text style={styles.size} numberOfLines={1} testID="workspace-size"
          accessibilityLabel={`目录文件大小 ${size}${summary?.sizeComplete ? "" : "，部分统计"}${status === "connected" ? "" : "，上次读取"}`}>{size}</Text>}
      </View>
      {activity && <Text style={[styles.activity, { color: activity.pending ? palette.warn : palette.success }]} numberOfLines={1}>{activity.label}</Text>}
    </View>
    <Text style={styles.count} numberOfLines={1} testID="workspace-session-count">
      <Text style={styles.countValue}>{sessionCount}</Text> 会话
    </Text>
  </View>;
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    header: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12 },
    copy: { flex: 1, minWidth: 0, gap: 5 },
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    identity: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
    name: { color: palette.text, fontSize: 15, fontWeight: "700", flexShrink: 1 },
    device: { color: palette.textDim, backgroundColor: palette.surfaceRaised, fontSize: 10,
      maxWidth: "40%", flexShrink: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, overflow: "hidden" },
    gitMark: { width: 16, height: 16, alignItems: "center", justifyContent: "center", flexShrink: 0 },
    count: { color: palette.textFaint, fontSize: 10, fontVariant: ["tabular-nums"], flexShrink: 0 },
    countValue: { color: palette.textDim, fontSize: 12, fontWeight: "600" },
    path: { color: palette.textFaint, fontSize: 11, flex: 1 },
    size: { color: palette.textFaint, fontSize: 11, textAlign: "right", fontVariant: ["tabular-nums"], flexShrink: 0 },
    activity: { fontSize: 10 },
  });
}
