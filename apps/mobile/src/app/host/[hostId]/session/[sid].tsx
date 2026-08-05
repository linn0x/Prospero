import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Stack, router, useLocalSearchParams } from "expo-router";
import type { ApprovalPolicy, SessionInfo, UsageWindow } from "@prospero/protocol";
import type { S2CMessage } from "@prospero/protocol";

type UsageResult = Extract<S2CMessage, { type: "usage.result" }>;

/** 把 ISO 时间说成人话:「14:30」或「明天 09:00」 */
function formatReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString() ? hhmm : `${String(d.getMonth() + 1)}/${String(d.getDate())} ${hhmm}`;
}
import { ChatView } from "@/components/ChatView";
import { Icon } from "@/components/Icon";
import { KeyBar } from "@/components/KeyBar";
import { QuickReplies } from "@/components/QuickReplies";
import { Terminal, type TerminalHandle } from "@/components/Terminal";
import { pickFromCamera, pickFromLibrary, type PickedImage } from "@/lib/attach";
import { Meter, Row, Sheet } from "@/components/Sheet";
import { color, font, utilizationColor } from "@/lib/theme";
import { matchCommands } from "@/lib/slash-commands";
import { useHostConnection } from "@/lib/use-host-connection";

const statusText: Record<SessionInfo["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting_approval: "待审批",
  idle: "空闲",
  done: "已完成",
  died: "已退出",
};

/** 每秒刷新的耗时显示("运行中 · 12s") */
function useElapsed(since: number | undefined): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === undefined) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (since === undefined) return "";
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${String(m)}m ${String(s % 60)}s` : `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}

export default function SessionScreen() {
  const { hostId, sid } = useLocalSearchParams<{ hostId: string; sid: string }>();
  const { conn, runtime } = useHostConnection(hostId);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(0);
  /** 结构化会话可切到 TTY 视图查看底层终端 */
  const [showTty, setShowTty] = useState(false);
  const [search, setSearch] = useState<string | null>(null);

  const session = sid ? runtime.sessions[sid] : undefined;
  const isStructured = session?.kind === "structured";
  const isChat = isStructured && !showTty;
  const busy = session?.status === "running" || session?.status === "starting";
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

  // 只显示最吃紧的那个窗口 —— 头部塞不下三个,而你关心的永远是先撞上的那个
  const tightest = (usage?.windows ?? []).reduce<UsageWindow | null>(
    (best, w) => (best === null || w.utilization > best.utilization ? w : best),
    null,
  );

  const elapsed = useElapsed(busy || session?.status === "waiting_approval" ? session?.busySince : undefined);

  const [images, setImages] = useState<PickedImage[]>([]);

  const send = useCallback(
    (text: string): void => {
      const t = text.trim();
      // 只带图不带字是合理的:一张报错截图本身就是问题
      if (!conn || !sid || (t.length === 0 && images.length === 0)) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (isStructured) {
        conn.chatSend(
          sid,
          t,
          images.map(({ mimeType, dataB64, name }) => ({ mimeType, dataB64, ...(name ? { name } : {}) })),
        );
        setImages([]);
      } else {
        conn.inputText(sid, t + "\r");
      }
      setDraft("");
    },
    [conn, sid, isStructured, images],
  );

  // 会话打开时取一次;不轮询 —— 限流窗口是小时级的,盯着刷没意义
  useEffect(() => {
    if (!conn || !sid || !isStructured) return;
    let alive = true;
    void conn
      .usageGet(sid)
      .then((r) => {
        if (alive) setUsage(r);
      })
      .catch(() => {
        // 取不到就是没有,不打扰用户
      });
    return () => {
      alive = false;
    };
  }, [conn, sid, isStructured]);

  const showUsage = (): void => {
    if (!conn || !sid) return;
    setUsageOpen(true);
    setUsageError(null);
    void conn
      .usageGet(sid)
      .then(setUsage)
      .catch((e: unknown) => {
        setUsageError(e instanceof Error ? e.message : String(e));
      });
  };

  const attach = (): void => {
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      Alert.alert("最多 6 张", "先移除几张再添加。");
      return;
    }
    Alert.alert("添加图片", undefined, [
      { text: "从相册选", onPress: () => void pickFromLibrary(room).then((p) => setImages((v) => [...v, ...p])) },
      { text: "拍一张", onPress: () => void pickFromCamera().then((p) => setImages((v) => [...v, ...p])) },
      { text: "取消", style: "cancel" },
    ]);
  };

  const confirmKill = (): void => {
    if (!conn || !sid) return;
    Alert.alert("终止会话", "结束该会话进程?", [
      { text: "取消", style: "cancel" },
      {
        text: "终止",
        style: "destructive",
        onPress: () => {
          conn.kill(sid);
          router.back();
        },
      },
    ]);
  };

  if (!conn || !sid) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "会话" }} />
        <Text style={styles.dim}>正在准备连接…</Text>
      </View>
    );
  }

  const termRef = useRef<TerminalHandle>(null);
  // 字号存在会话页而不是终端内部:切走再回来不该重置成默认值
  const [fontSize, setFontSize] = useState(12);
  const [perf, setPerf] = useState<{ fps: number; kb: number; renderer: string } | null>(null);

  const policy: ApprovalPolicy = session?.approvalPolicy ?? "strict";

  const choosePolicy = (): void => {
    Alert.alert(
      "审批策略",
      "决定哪些操作需要你点头。",
      [
        {
          text: "逐条批准(最安全)",
          onPress: () => conn.setApprovalPolicy(sid, "strict"),
        },
        {
          text: "半自动:只读放行",
          onPress: () => conn.setApprovalPolicy(sid, "standard"),
        },
        {
          // YOLO 要单独再确认一次。它允许 agent 无提示地改文件、跑命令,
          // 一次误点的代价远大于多点一次的成本。
          text: "YOLO:全部自动批准",
          style: "destructive",
          onPress: () => {
            Alert.alert(
              "确认开启 YOLO?",
              "这个会话里,agent 改文件、执行命令、联网都不再询问你。操作仍会记录在聊天里,但不会等你。",
              [
                { text: "取消", style: "cancel" },
                {
                  text: "我明白,开启",
                  style: "destructive",
                  onPress: () => conn.setApprovalPolicy(sid, "yolo"),
                },
              ],
            );
          },
        },
        { text: "取消", style: "cancel" },
      ],
    );
  };

  const totals = session?.totals;
  const subtitle = session
    ? `${session.agent} · ${statusText[session.status]}${elapsed ? ` · ${elapsed}` : ""}${
        pending > 0 ? ` · ${String(pending)} 项待批` : ""
      }${
        totals && totals.costUsd > 0 ? ` · 共 $${totals.costUsd.toFixed(3)}` : ""
      }${
        // 洪峰时才有值。A4 验收线是 30fps,平时没输出就不显示,免得占位置
        perf ? ` · ${String(perf.fps)}fps ${String(perf.kb)}KB/s` : ""
      }${tightest ? ` · ${tightest.label} ${String(Math.round(tightest.utilization))}%` : ""}`
    : "";

  // 输入以 / 开头时给命令候选
  const commandHints =
    isChat && session ? matchCommands(session.agent, draft.trim()) : [];

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={styles.headerTitle}>
              <Text style={styles.headerName} numberOfLines={1}>
                {session?.title ?? "会话"}
              </Text>
              {subtitle.length > 0 && (
                <Text style={styles.headerSub} numberOfLines={1}>
                  {subtitle}
                </Text>
              )}
            </View>
          ),
          headerRight: () => (
            <View style={styles.headerRight}>
              {isChat && (
                <Pressable
                  onPress={() => setSearch((s) => (s === null ? "" : null))}
                  hitSlop={8}
                >
                  <Icon
                    name="magnifyingglass"
                    size={19}
                    color={search !== null ? "#7aa2f7" : "#9a9aa6"}
                  />
                </Pressable>
              )}
              {isStructured && (
                <Pressable onPress={() => setShowTty((v) => !v)} hitSlop={8}>
                  {/* 标签写的是"点了会切到哪",不是"现在是什么" */}
                  <Text style={[styles.ttyBtn, showTty && styles.ttyBtnActive]}>
                    {showTty ? "看对话" : "看终端"}
                  </Text>
                </Pressable>
              )}
              {isStructured && (
                <Pressable onPress={showUsage} hitSlop={8}>
                  <Text
                    style={[
                      styles.ttyBtn,
                      tightest && tightest.utilization >= 80 && styles.usageHot,
                    ]}
                  >
                    用量
                  </Text>
                </Pressable>
              )}
              {isStructured && (
                <Pressable onPress={choosePolicy} hitSlop={8}>
                  <Text
                    style={[
                      styles.ttyBtn,
                      policy !== "strict" && styles.policyRelaxed,
                    ]}
                  >
                    {policy === "yolo" ? "YOLO" : policy === "standard" ? "半自动" : "逐条批"}
                  </Text>
                </Pressable>
              )}
              {busy && (
                <Pressable onPress={() => conn.interrupt(sid)} hitSlop={8}>
                  <Icon name="stop.circle" size={20} color="#d9a441" />
                </Pressable>
              )}
              <Pressable onPress={confirmKill} hitSlop={8}>
                <Icon name="trash" size={18} color="#e5534b" />
              </Pressable>
            </View>
          ),
        }}
      />
      {runtime.status !== "connected" && (
        <View style={styles.reconnBar}>
          <Text style={styles.reconnText}>
            {runtime.status === "failed"
              ? `连接失败:${runtime.lastError ?? ""}`
              : "连接断开,重连中…(内容将自动恢复)"}
          </Text>
        </View>
      )}

      {isChat && search !== null && (
        <View style={styles.searchBar}>
          <TextInput
            style={styles.searchInput}
            placeholder="在本会话中搜索…"
            placeholderTextColor="#5a5a66"
            value={search}
            onChangeText={setSearch}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          <Pressable onPress={() => setSearch(null)} hitSlop={8}>
            <Text style={styles.searchCancel}>取消</Text>
          </Pressable>
        </View>
      )}

      {isChat ? (
        <ChatView
          conn={conn}
          sid={sid}
          onPendingChange={setPending}
          {...(search !== null ? { search } : {})}
          onRetry={send}
        />
      ) : (
        <>
          {isStructured && showTty && (
            <View style={styles.ttyNotice}>
              <Text style={styles.ttyNoticeText}>
                TTY 视图:结构化会话没有终端输出,此处用于排查底层进程。
              </Text>
            </View>
          )}
          <Terminal ref={termRef} conn={conn} sid={sid} onFontSize={setFontSize} onPerf={setPerf} />
          {!isStructured && (
            <KeyBar
              onKey={(seq) => conn.inputText(sid, seq)}
              onFontSize={(delta) => {
                const next = Math.min(20, Math.max(8, fontSize + delta));
                setFontSize(next);
                termRef.current?.setFontSize(next);
              }}
              onScrollBottom={() => termRef.current?.scrollToBottom()}
              onDismissKeyboard={() => termRef.current?.blur()}
            />
          )}
        </>
      )}

      {isChat && commandHints.length > 0 && (
        <View style={styles.cmdBox}>
          {commandHints.slice(0, 5).map((c) => (
            <Pressable key={c.cmd} style={styles.cmdRow} onPress={() => setDraft(c.cmd)}>
              <Text style={styles.cmdName}>{c.cmd}</Text>
              <Text style={styles.cmdDesc}>{c.desc}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {isChat && commandHints.length === 0 && <QuickReplies busy={busy} onPick={send} />}

      {images.length > 0 && (
        <ScrollView horizontal style={styles.thumbs} contentContainerStyle={styles.thumbsRow}>
          {images.map((img, i) => (
            <View key={img.uri} style={styles.thumbWrap}>
              <Image source={{ uri: img.uri }} style={styles.thumb} />
              <Pressable
                style={styles.thumbX}
                hitSlop={6}
                onPress={() => setImages((v) => v.filter((_, j) => j !== i))}
              >
                <Text style={styles.thumbXText}>×</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      <Sheet visible={usageOpen} title="用量与限流" onClose={() => setUsageOpen(false)}>
        {usageError !== null ? (
          <Text style={styles.sheetNote}>{usageError}</Text>
        ) : usage === null ? (
          <ActivityIndicator style={styles.sheetLoading} color={color.accent} />
        ) : (
          <>
            {usage.subscription ? <Row label="套餐" value={usage.subscription} /> : null}
            {usage.costUsd !== undefined ? (
              <Row label="本会话花费" value={`$${usage.costUsd.toFixed(4)}`} />
            ) : null}

            {(usage.windows ?? []).map((w) => (
              <View key={w.label} style={styles.window}>
                <View style={styles.windowHead}>
                  <Text style={font.body}>{w.label}</Text>
                  <Text style={[styles.windowPct, { color: utilizationColor(w.utilization) }]}>
                    {String(Math.round(w.utilization))}%
                  </Text>
                </View>
                <Meter value={w.utilization} tint={utilizationColor(w.utilization)} />
                {w.resetsAt ? (
                  <Text style={font.meta}>{formatReset(w.resetsAt)} 重置</Text>
                ) : null}
              </View>
            ))}

            {!usage.available || (usage.windows ?? []).length === 0 ? (
              <Text style={styles.sheetNote}>
                {usage.reason ?? "这个账号不适用套餐限流(API key / Bedrock / Vertex)。"}
              </Text>
            ) : null}
          </>
        )}
      </Sheet>

      <View style={styles.composer}>
        {isChat && (
          <Pressable style={styles.attachBtn} onPress={attach} hitSlop={6}>
            <Icon name="doc.on.doc" size={17} color="#7aa2f7" />
          </Pressable>
        )}
        <TextInput
          style={[styles.input, isChat && styles.inputChat]}
          placeholder={isChat ? `给 ${session?.agent ?? "agent"} 发消息…` : "输入后发送(自动回车)"}
          placeholderTextColor="#5a5a66"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => send(draft)}
          submitBehavior={isChat ? "newline" : "submit"}
          returnKeyType={isChat ? "default" : "send"}
          autoCapitalize="none"
          autoCorrect={false}
          multiline={isChat}
        />
        <Pressable
          style={[
            styles.sendBtn,
            draft.trim().length === 0 && images.length === 0 && styles.sendBtnDim,
          ]}
          onPress={() => send(draft)}
          disabled={draft.trim().length === 0 && images.length === 0}
        >
          <Icon name="arrow.up" size={17} color="#fff" weight="semibold" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/** 与协议里的上限一致 */
const MAX_IMAGES = 6;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0e" },
  thumbs: { flexGrow: 0, backgroundColor: "#141419" },
  thumbsRow: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  thumbWrap: { width: 56, height: 56 },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: "#26262e" },
  thumbX: {
    position: "absolute",
    top: -5,
    right: -5,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#2a2a33",
    alignItems: "center",
    justifyContent: "center",
  },
  thumbXText: { color: "#e8e8ee", fontSize: 13, lineHeight: 15 },
  attachBtn: { paddingHorizontal: 6, paddingVertical: 10 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  dim: { color: "#5a5a66" },
  headerTitle: { alignItems: "center", maxWidth: 220 },
  headerName: { color: "#e8e8ee", fontSize: 16, fontWeight: "600" },
  headerSub: { color: "#7a7a86", fontSize: 11, marginTop: 1 },
  headerRight: { flexDirection: "row", gap: 12, alignItems: "center" },
  sheetLoading: { paddingVertical: 32 },
  sheetNote: { color: color.textDim, fontSize: 13, lineHeight: 19, paddingVertical: 12 },
  window: { gap: 6, paddingVertical: 14 },
  windowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  windowPct: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },
  ttyBtn: {
    color: "#8a8a96",
    fontSize: 12,
    borderWidth: 1,
    borderColor: "#33333d",
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    overflow: "hidden",
  },
  ttyBtnActive: { color: "#7aa2f7", borderColor: "#3557b7" },
  // 放宽后必须显眼 —— 用户要能一眼看出这个会话没在逐条把关
  policyRelaxed: { color: "#e5a341", borderColor: "#7a5a1a" },
  // 用掉 80% 以上就变色 —— 到那时你该知道自己快撞墙了
  usageHot: { color: "#e5534b", borderColor: "#7a2a2a" },
  stopText: { color: "#d9a441", fontSize: 15 },
  killText: { color: "#e5534b", fontSize: 15 },
  reconnBar: { backgroundColor: "#3a2f1f", paddingHorizontal: 12, paddingVertical: 6 },
  reconnText: { color: "#e8c98a", fontSize: 12 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#141419",
  },
  searchInput: {
    flex: 1,
    backgroundColor: "#1c1c24",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#e8e8ee",
    fontSize: 15,
  },
  searchCancel: { color: "#7aa2f7", fontSize: 15 },
  cmdBox: { backgroundColor: "#0b0b0e", paddingHorizontal: 10, paddingBottom: 4, gap: 2 },
  cmdRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
    paddingVertical: 7,
    paddingHorizontal: 8,
    backgroundColor: "#15151b",
    borderRadius: 8,
  },
  cmdName: { color: "#7aa2f7", fontSize: 14, fontFamily: "Menlo" },
  cmdDesc: { color: "#8a8a96", fontSize: 12, flex: 1 },
  ttyNotice: { backgroundColor: "#16202b", paddingHorizontal: 12, paddingVertical: 6 },
  ttyNoticeText: { color: "#8fb0d0", fontSize: 11 },
  composer: {
    flexDirection: "row",
    gap: 8,
    padding: 8,
    backgroundColor: "#141419",
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    backgroundColor: "#1c1c24",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
    color: "#e8e8ee",
    fontSize: 15,
  },
  inputChat: { maxHeight: 120, minHeight: 40 },
  sendBtn: {
    backgroundColor: "#3557b7",
    borderRadius: 18,
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDim: { opacity: 0.4 },
  sendText: { color: "#fff", fontWeight: "700", fontSize: 17 },
});
