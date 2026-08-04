import { useEffect, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import type { AgentKind, SessionInfo } from "@prospero/protocol";
import { sortSessions } from "@/lib/store";
import { useHostConnection } from "@/lib/use-host-connection";

const AGENTS: AgentKind[] = ["claude", "codex", "opencode", "grok", "trae", "shell"];

const statusLabel: Record<SessionInfo["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting_approval: "待审批",
  idle: "空闲",
  done: "已完成",
  died: "已退出",
};

const statusColor: Record<SessionInfo["status"], string> = {
  starting: "#d9a441",
  running: "#4dbd74",
  waiting_approval: "#e5534b",
  idle: "#7aa2f7",
  done: "#5a5a66",
  died: "#5a5a66",
};

export default function HostScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const { host, conn, runtime } = useHostConnection(hostId);
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [cwd, setCwd] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const pendingCreateRef = useRef(false);

  // 新建会话:创建后 daemon 自动 attach 并发快照 → 以快照的 sid 进入会话页
  useEffect(() => {
    if (!conn) return;
    const offSnap = conn.events.on("snapshot", (m) => {
      if (!pendingCreateRef.current || !hostId) return;
      pendingCreateRef.current = false;
      router.push(`/host/${hostId}/session/${m.sid}`);
    });
    const offErr = conn.events.on("serverError", (m) => {
      pendingCreateRef.current = false;
      setBanner(`${m.code}: ${m.message}`);
    });
    return () => {
      offSnap();
      offErr();
    };
  }, [conn, hostId]);

  const sessions = sortSessions(runtime.sessions);
  const statusText =
    runtime.status === "connected"
      ? `已连接 · ${runtime.activeAddr ?? ""}`
      : runtime.status === "connecting"
        ? "连接中…"
        : runtime.status === "reconnecting"
          ? "重连中…"
          : runtime.status === "failed"
            ? `连接失败:${runtime.lastError ?? "未知错误"}`
            : "未连接";

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: host?.name ?? "主机" }} />

      <View style={styles.statusBar}>
        <Text
          style={[
            styles.statusText,
            runtime.status === "failed" && styles.statusFailed,
          ]}
          numberOfLines={2}
        >
          {statusText}
        </Text>
        {(runtime.status === "failed" || runtime.status === "reconnecting") && (
          <Pressable onPress={() => conn?.kick()} hitSlop={8}>
            <Text style={styles.retry}>重试</Text>
          </Pressable>
        )}
      </View>

      {banner !== null && (
        <Pressable style={styles.banner} onPress={() => setBanner(null)}>
          <Text style={styles.bannerText}>{banner}(点击关闭)</Text>
        </Pressable>
      )}

      <View style={styles.newBox}>
        <View style={styles.chips}>
          {AGENTS.map((a) => (
            <Pressable
              key={a}
              onPress={() => setAgent(a)}
              style={[styles.chip, agent === a && styles.chipActive]}
            >
              <Text style={[styles.chipText, agent === a && styles.chipTextActive]}>
                {a}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.newRow}>
          <TextInput
            style={styles.cwdInput}
            placeholder="工作目录(默认 ~)"
            placeholderTextColor="#5a5a66"
            value={cwd}
            onChangeText={setCwd}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={[styles.createBtn, runtime.status !== "connected" && styles.btnDisabled]}
            disabled={runtime.status !== "connected"}
            onPress={() => {
              pendingCreateRef.current = true;
              conn?.createSession(agent, cwd.trim() || undefined);
            }}
          >
            <Text style={styles.createBtnText}>新建</Text>
          </Pressable>
        </View>
      </View>

      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.emptyText}>还没有会话,选择 agent 后点「新建」。</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            onPress={() => router.push(`/host/${hostId}/session/${item.id}`)}
          >
            <View style={[styles.dot, { backgroundColor: statusColor[item.status] }]} />
            <View style={styles.cardBody}>
              <Text style={styles.cardTitle}>{item.title}</Text>
              <Text style={styles.cardSub}>
                {statusLabel[item.status]} · {item.cwd}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 8,
  },
  statusText: { color: "#8a8a96", fontSize: 12, flex: 1 },
  statusFailed: { color: "#e5534b" },
  retry: { color: "#7aa2f7", fontSize: 13 },
  banner: {
    backgroundColor: "#3a1f1f",
    marginHorizontal: 12,
    borderRadius: 8,
    padding: 10,
  },
  bannerText: { color: "#f0b0ab", fontSize: 12 },
  newBox: { paddingHorizontal: 12, gap: 8, paddingBottom: 4 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    backgroundColor: "#1c1c24",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  chipActive: { backgroundColor: "#3557b7" },
  chipText: { color: "#9a9aa6", fontSize: 13 },
  chipTextActive: { color: "#fff" },
  newRow: { flexDirection: "row", gap: 8 },
  cwdInput: {
    flex: 1,
    backgroundColor: "#17171d",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#e8e8ee",
    fontSize: 13,
  },
  createBtn: {
    backgroundColor: "#3557b7",
    borderRadius: 8,
    paddingHorizontal: 18,
    justifyContent: "center",
  },
  btnDisabled: { opacity: 0.4 },
  createBtnText: { color: "#fff", fontWeight: "600" },
  list: { padding: 12, gap: 10, paddingBottom: 32 },
  emptyText: { color: "#5a5a66", textAlign: "center", marginTop: 24, fontSize: 13 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#17171d",
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  cardPressed: { backgroundColor: "#1f1f27" },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cardBody: { flex: 1, gap: 2 },
  cardTitle: { color: "#e8e8ee", fontSize: 15, fontWeight: "600" },
  cardSub: { color: "#8a8a96", fontSize: 12 },
});
