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
import { HostSummary } from "@/components/HostSummary";
import { Icon } from "@/components/Icon";
import { SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { sortSessions } from "@/lib/store";
import { useHostConnection } from "@/lib/use-host-connection";
import * as theme from "@/lib/theme";
const { color, font, radius, space } = theme;

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

/** 待审批用告警色而非中性色 —— 它是唯一在等你动手的状态 */
const statusColor: Record<SessionInfo["status"], string> = {
  ...theme.statusColor,
  waiting_approval: theme.color.danger,
  idle: theme.color.accent,
} as Record<SessionInfo["status"], string>;

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
  // 验收期要能直接读到 A1/A5 的数,不然只能填"主观秒开"
  const metrics: string[] = [];
  if (runtime.rttMs !== null) metrics.push(`${String(runtime.rttMs)}ms`);
  if (conn?.lastAttachMs != null) metrics.push(`上屏 ${String(conn.lastAttachMs)}ms`);
  if (conn?.lastResumeMs != null) metrics.push(`恢复 ${String(conn.lastResumeMs)}ms`);
  const quality = metrics.length > 0 ? ` · ${metrics.join(" · ")}` : "";
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

      {/* 连上时状态并进主机卡片 —— 一行灰字和卡片说的是同一件事,分开摆只是
          让屏幕上多一条横线。出问题时才需要独立一条,因为那时要给"重试"按钮 */}
      {runtime.status !== "connected" && (
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
      )}

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
        ListHeaderComponent={
          <HostSummary
            info={runtime.hostInfo}
            conn={conn}
            connected={runtime.status === "connected"}
            rttMs={runtime.rttMs}
            sessionCount={all.length}
            runningCount={runningCount}
          />
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {all.length === 0 ? "还没有会话,点右上角 ＋ 新建。" : "该筛选下没有会话。"}
          </Text>
        }
        ListFooterComponent={
          all.length > 0 ? (
            <Text style={styles.swipeHint}>左滑会话可看改动 / 文件或结束</Text>
          ) : null
        }
        renderItem={({ item }) => {
          const done = item.status === "done" || item.status === "died";
          // 断线后列表还挂着最后一次收到的状态。不标出来的话,"运行中"会被当成
          // 此刻的事实 —— 而它可能早就结束了。
          const stale = runtime.status !== "connected";
          const actions: SwipeAction[] = [
            {
              label: "改动",
              symbol: "arrow.clockwise",
              color: "#2f6b4f",
              onPress: () => router.push(`/host/${hostId}/git/${item.id}`),
            },
            {
              label: "文件",
              symbol: "doc.on.doc",
              color: "#3a6ea5",
              onPress: () => router.push(`/host/${hostId}/files/${item.id}`),
            },
          ];
          // 中断不放这里:会话页头部在忙时已有停止按钮,而一行塞四个操作
          // 会把标题整个挤没(402pt 宽放不下 4×78pt,模拟器上实测到了)。
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
              <View
                style={[
                  styles.dot,
                  { backgroundColor: stale ? "#3a3a44" : statusColor[item.status] },
                ]}
              />
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.kindTag}>{item.kind === "structured" ? "对话" : "终端"}</Text>
              <Text
                style={[
                  styles.cardStatus,
                  { color: stale ? "#5a5a66" : statusColor[item.status] },
                ]}
              >
                {statusLabel[item.status]}
                {stale ? "(离线前)" : ""}
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
  container: { flex: 1, backgroundColor: color.bg },
  headerCancel: { color: color.accent, fontSize: 15 },
  statusBar: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  statusText: font.sub,
  statusFailed: { color: color.danger },
  retry: { color: color.accent, fontSize: 13, marginTop: 4 },
  banner: {
    backgroundColor: color.warnBg,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  bannerText: { color: color.warn, fontSize: 12 },
  filterBar: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
  filterContent: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  filterChip: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: color.surface,
  },
  filterChipActive: { backgroundColor: color.accentDim },
  filterChipText: { ...font.sub, color: color.textDim },
  filterChipTextActive: { color: color.text, fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chipActive: { backgroundColor: color.accentDim },
  chipTextActive: { color: color.text, fontWeight: "600" },
  newBox: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  createBtnText: { color: color.text, fontSize: 14, fontWeight: "600" },
  btnDisabled: { opacity: 0.45 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  dim: font.sub,
  connBar: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  connText: font.sub,
  filterRow: { gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: color.surface,
  },
  chipOn: { backgroundColor: color.accentDim },
  chipText: { ...font.sub, color: color.textDim },
  chipTextOn: { color: color.text, fontWeight: "600" },
  list: { padding: space.lg, gap: space.md },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: space.lg,
    gap: 6,
  },
  cardPressed: { backgroundColor: color.pressed },
  cardAttention: { borderWidth: 1, borderColor: color.warn },
  cardTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cardTitle: { ...font.body, flex: 1 },
  kindTag: {
    ...font.meta,
    color: color.textDim,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
  },
  cardStatus: { fontSize: 12, fontWeight: "600" },
  preview: { ...font.sub, color: color.textDim, lineHeight: 18 },
  cardSub: font.meta,
  emptyText: { ...font.sub, textAlign: "center", paddingVertical: 40 },
  swipeHint: { ...font.meta, textAlign: "center", paddingVertical: space.lg },
  newRow: { gap: space.sm, paddingHorizontal: space.lg, paddingBottom: space.md },
  agentRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  cwdRow: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  cwdInput: {
    flex: 1,
    backgroundColor: color.surface,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    color: color.text,
    fontSize: 14,
  },
  createBtn: {
    backgroundColor: color.accentDim,
    borderRadius: radius.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 11,
  },
  createText: { color: color.text, fontSize: 14, fontWeight: "600" },
});
