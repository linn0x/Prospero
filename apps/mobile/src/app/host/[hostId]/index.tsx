import { useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import type { AgentKind, SessionInfo } from "@prospero/protocol";
import { Icon } from "@/components/Icon";
import { SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { sortSessions } from "@/lib/store";
import { useHostConnection } from "@/lib/use-host-connection";

const AGENTS: AgentKind[] = ["claude", "codex", "opencode", "grok", "trae", "shell"];
/** 有结构化适配器的 agent(会话会以对话形态呈现) */
const STRUCTURED: AgentKind[] = ["claude", "codex", "opencode"];

const statusLabel: Record<SessionInfo["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting_approval: "待审批",
  idle: "就绪",
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
  const { hostId, create, cmd } = useLocalSearchParams<{
    hostId: string;
    create?: string;
    cmd?: string;
  }>();
  const { host, conn, runtime } = useHostConnection(hostId);
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [cwd, setCwd] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | AgentKind>("all");
  const [composing, setComposing] = useState(false);
  const pendingCreateRef = useRef(false);
  const deepLinkCreateRef = useRef<string | null>(null);
  const insets = useSafeAreaInsets();

  // 深链 prospero://host/<id>?create=shell&cmd=…:连上后自动建会话(自动化测试/快捷指令用)
  useEffect(() => {
    if (!conn || !create) return;
    const fireKey = `${create}:${typeof cmd === "string" ? cmd : ""}`;
    if (deepLinkCreateRef.current === fireKey) return;
    if (runtime.status !== "connected") return;
    if (!AGENTS.includes(create as AgentKind) && create !== "custom") return;
    deepLinkCreateRef.current = fireKey;
    pendingCreateRef.current = true;
    conn.createSession(
      create as AgentKind,
      undefined,
      typeof cmd === "string" && cmd.length > 0 ? cmd : undefined,
    );
  }, [conn, create, cmd, runtime.status]);

  // 新建会话:创建后 daemon 自动 attach 并发快照(PTY 发 term.snapshot,
  // 结构化发 chat.snapshot)→ 以快照的 sid 进入会话页
  useEffect(() => {
    if (!conn) return;
    const enter = (sid: string): void => {
      if (!pendingCreateRef.current || !hostId) return;
      pendingCreateRef.current = false;
      setComposing(false);
      router.push(`/host/${hostId}/session/${sid}`);
    };
    const offSnap = conn.events.on("snapshot", (m) => enter(m.sid));
    const offChat = conn.events.on("chatSnapshot", (m) => enter(m.sid));
    const offErr = conn.events.on("serverError", (m) => {
      pendingCreateRef.current = false;
      setBanner(`${m.code}: ${m.message}`);
    });
    return () => {
      offSnap();
      offChat();
      offErr();
    };
  }, [conn, hostId]);

  const all = sortSessions(runtime.sessions);
  const sessions = useMemo(
    () => (filter === "all" ? all : all.filter((s) => s.agent === filter)),
    [all, filter],
  );
  const runningCount = all.filter(
    (s) => s.status === "running" || s.status === "starting",
  ).length;
  const usedAgents = useMemo(
    () => [...new Set(all.map((s) => s.agent))],
    [all],
  );

  // 只报延迟,不报地址 —— 地址是内网拓扑,截图分享时不该跟着出去,
  // 而且连哪条线路是竞速自动决定的,用户无从干预
  const quality = runtime.rttMs === null ? "" : ` · ${String(runtime.rttMs)}ms`;
  const connText =
    runtime.status === "connected"
      ? `${runningCount} 个运行中 · ${String(all.length)} 个会话${quality}`
      : runtime.status === "connecting"
        ? "连接中…"
        : runtime.status === "reconnecting"
          ? "重连中…"
          : runtime.status === "failed"
            ? (runtime.lastError ?? "连接失败")
            : "未连接";

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: host?.name ?? "主机",
          headerRight: () =>
            composing ? (
              <Pressable onPress={() => setComposing(false)} hitSlop={8}>
                <Text style={styles.headerCancel}>取消</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => setComposing(true)} hitSlop={8}>
                <Icon name="plus" size={19} color="#7aa2f7" weight="semibold" />
              </Pressable>
            ),
        }}
      />

      <View style={styles.statusBar}>
        <Text
          style={[styles.statusText, runtime.status === "failed" && styles.statusFailed]}
          numberOfLines={runtime.status === "failed" ? 3 : 1}
        >
          {connText}
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

      {composing ? (
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
                  {STRUCTURED.includes(a) ? " 💬" : ""}
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
      ) : (
        usedAgents.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.filterBar}
            contentContainerStyle={styles.filterContent}
          >
            <FilterChip label="全部" active={filter === "all"} onPress={() => setFilter("all")} />
            {usedAgents.map((a) => (
              <FilterChip
                key={a}
                label={a}
                active={filter === a}
                onPress={() => setFilter(a)}
              />
            ))}
          </ScrollView>
        )
      )}

      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 32 }]}
        refreshControl={
          <RefreshControl
            refreshing={runtime.status === "connecting" || runtime.status === "reconnecting"}
            onRefresh={() => conn?.kick()}
            tintColor="#7aa2f7"
          />
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {all.length === 0 ? "还没有会话,点右上角 ＋ 新建。" : "该筛选下没有会话。"}
          </Text>
        }
        renderItem={({ item }) => {
          const done = item.status === "done" || item.status === "died";
          const actions: SwipeAction[] = [];
          // 还在跑的先给"中断"—— 多数时候用户只是想停掉当前这一轮,而不是丢掉整个会话
          if (!done) {
            actions.push({
              label: "中断",
              symbol: "stop.circle",
              color: "#d9a441",
              onPress: () => conn?.interrupt(item.id),
            });
          }
          actions.push({
            label: done ? "移除" : "结束",
            symbol: "trash",
            color: "#e5534b",
            onPress: () => conn?.kill(item.id),
            // 会话里可能跑着没保存的东西,误滑代价太大,一律二次确认
            confirm: {
              title: done ? `移除「${item.title}」?` : `结束「${item.title}」?`,
              message: done
                ? "会话已结束,这会把它从列表移除。"
                : "会话进程会被终止,未完成的工作会丢失。",
              confirmLabel: done ? "移除" : "结束",
            },
          });
          return (
            <SwipeRow actions={actions}>
          <Pressable
            style={({ pressed }) => [
              styles.card,
              pressed && styles.cardPressed,
              item.status === "waiting_approval" && styles.cardAttention,
            ]}
            onPress={() => router.push(`/host/${hostId}/session/${item.id}`)}
          >
            <View style={styles.cardTop}>
              <View style={[styles.dot, { backgroundColor: statusColor[item.status] }]} />
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.kindTag}>{item.kind === "structured" ? "对话" : "终端"}</Text>
              <Text style={[styles.cardStatus, { color: statusColor[item.status] }]}>
                {statusLabel[item.status]}
              </Text>
            </View>
            {item.preview !== undefined && item.preview.length > 0 && (
              <Text style={styles.preview} numberOfLines={2}>
                {item.preview}
              </Text>
            )}
            <Text style={styles.cardSub} numberOfLines={1}>
              {item.pendingPermissions ? `⚠︎ ${String(item.pendingPermissions)} 项待批 · ` : ""}
              {item.cwd}
            </Text>
          </Pressable>
            </SwipeRow>
          );
        }}
      />
    </View>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.filterChip, active && styles.filterChipActive]}>
      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerCancel: { color: "#7aa2f7", fontSize: 16 },
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
  newBox: { paddingHorizontal: 12, gap: 8, paddingBottom: 6 },
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
  filterBar: { flexGrow: 0 },
  filterContent: { paddingHorizontal: 12, paddingBottom: 6, gap: 6 },
  filterChip: {
    backgroundColor: "#17171d",
    borderRadius: 13,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: "#26262e",
  },
  filterChipActive: { backgroundColor: "#e8e8ee", borderColor: "#e8e8ee" },
  filterChipText: { color: "#9a9aa6", fontSize: 12 },
  filterChipTextActive: { color: "#0b0b0e", fontWeight: "600" },
  list: { padding: 12, gap: 10, paddingBottom: 32 },
  emptyText: { color: "#5a5a66", textAlign: "center", marginTop: 24, fontSize: 13 },
  card: { backgroundColor: "#17171d", borderRadius: 12, padding: 14, gap: 6 },
  cardPressed: { backgroundColor: "#1f1f27" },
  cardAttention: { borderWidth: 1, borderColor: "#5a2f2b" },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cardTitle: { color: "#e8e8ee", fontSize: 15, fontWeight: "600", flexShrink: 1 },
  kindTag: {
    color: "#7aa2f7",
    fontSize: 10,
    backgroundColor: "#1b2233",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  cardStatus: { fontSize: 11, marginLeft: "auto" },
  preview: { color: "#9a9aa6", fontSize: 13, lineHeight: 18 },
  cardSub: { color: "#6a6a76", fontSize: 11 },
});
