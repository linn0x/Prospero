import { useCallback, useMemo, useState } from "react";
import * as RN from "react-native";
import { AppState, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { peekConnection } from "@/lib/connection";
import { useApp } from "@/lib/store";
import { bytes } from "@/lib/format";
import { getWorkspaceSummary, type WorkspaceSummary } from "@/lib/workspace-summary";
import { useMobileTheme, type ThemePalette } from "@/lib/theme";

/** Only mounted directory rows read metadata. Scans are cached and bounded on the daemon. */
export function WorkspaceHeader({ hostId, path, sid, name, sessionCount, activity, deviceLabel, deviceDetail, deviceOffline, compact = false }: {
  hostId: string; path: string; sid?: string; name: string; sessionCount: number;
  activity?: { label: string; pending: boolean };
  deviceLabel?: string;
  deviceDetail?: string;
  deviceOffline?: boolean;
  compact?: boolean;
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
    const interactionTask = "InteractionManager" in RN && typeof RN.InteractionManager?.runAfterInteractions === "function"
      ? RN.InteractionManager.runAfterInteractions(refresh)
      : (refresh(), null);
    const timer = setInterval(refresh, 60_000);
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
    return () => { active = false; interactionTask?.cancel(); clearInterval(timer); subscription.remove(); };
  }, [connection, hostId, identity, path, sid, status]));
  const summary = received?.identity === identity ? received.summary : null;
  const size = !compact && summary?.sizeBytes != null ? `${summary.sizeComplete ? "" : "≥ "}${bytes(summary.sizeBytes)}` : null;
  return <View style={styles.header} testID="workspace-header">
    <View style={styles.copy}>
      <View style={styles.identity}>
        <Text style={styles.name} numberOfLines={1} testID="workspace-name">{name}</Text>
        {deviceLabel && <Text style={[styles.device, deviceOffline && { color: palette.warn }]} numberOfLines={1} testID="workspace-device"
          accessibilityLabel={deviceDetail ?? deviceLabel}>{deviceOffline ? "离线 · " : ""}{deviceLabel}</Text>}
        {summary?.branch && <View style={styles.gitMark} accessible accessibilityRole="image"
          accessibilityLabel={`Git 仓库${status === "connected" ? "" : "，上次读取"}`} testID="workspace-git-repository">
          <FontAwesome6 name="code-branch" size={11} color={palette.textFaint} />
        </View>}
      </View>
      {!compact && (
        <View style={styles.row}>
          <Text style={styles.path} numberOfLines={1} ellipsizeMode="middle">{path}</Text>
          {size && <Text style={styles.size} numberOfLines={1} testID="workspace-size"
            accessibilityLabel={`目录文件大小 ${size}${summary?.sizeComplete ? "" : "，部分统计"}${status === "connected" ? "" : "，上次读取"}`}>{size}</Text>}
        </View>
      )}
      {activity ? (
        <Text style={[styles.activity, { color: activity.pending ? palette.warn : palette.success }]} numberOfLines={1}>{activity.label}</Text>
      ) : compact ? (
        <Text style={styles.compactSub} numberOfLines={1}>{summary?.branch ?? `${String(sessionCount)} 个会话`}</Text>
      ) : null}
    </View>
    <View style={styles.countBadge} testID="workspace-session-count">
      <Text style={styles.countValue} numberOfLines={1}>{sessionCount}</Text>
    </View>
  </View>;
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    header: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 },
    copy: { flex: 1, minWidth: 0, gap: 3 },
    row: { flexDirection: "row", alignItems: "center", gap: 8 },
    identity: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
    name: { color: palette.text, fontSize: 15, fontWeight: "600", letterSpacing: -0.2, flexShrink: 1 },
    device: { color: palette.textDim, backgroundColor: palette.surfaceRaised, fontSize: 10,
      maxWidth: "40%", flexShrink: 1, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
    gitMark: { width: 14, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 },
    countBadge: {
      minWidth: 24,
      height: 22,
      paddingHorizontal: 7,
      borderRadius: 999,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: palette.surfaceRaised,
      flexShrink: 0,
    },
    countValue: { color: palette.textDim, fontSize: 11.5, fontWeight: "600", fontVariant: ["tabular-nums"] },
    path: { color: palette.textFaint, fontSize: 11.5, flex: 1 },
    size: { color: palette.textFaint, fontSize: 11, textAlign: "right", fontVariant: ["tabular-nums"], flexShrink: 0 },
    activity: { fontSize: 11, fontWeight: "500" },
    compactSub: { color: palette.textFaint, fontSize: 11 },
  });
}
