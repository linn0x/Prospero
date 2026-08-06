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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import type { ApprovalPolicy, S2CMessage, SessionInfo, UsageWindow } from "@prospero/protocol";
import { ChatView } from "@/components/ChatView";
import { DismissKey } from "@/components/DismissKey";
import { Icon } from "@/components/Icon";
import { KeyBar } from "@/components/KeyBar";
import { QuickReplies } from "@/components/QuickReplies";
import { Terminal, type TerminalHandle } from "@/components/Terminal";
import { VoiceButton } from "@/components/VoiceButton";
import { pickFromCamera, pickFromLibrary, type PickedImage } from "@/lib/attach";
import { Meter, Row, Sheet } from "@/components/Sheet";
import { color, font, statusColor, utilizationColor } from "@/lib/theme";
import { matchCommands } from "@/lib/slash-commands";
import { MONOSPACE_FONT } from "@/lib/theme";
import { useHostConnection } from "@/lib/use-host-connection";
import { appendVoiceTranscript } from "@/lib/voice-input";

type UsageResult = Extract<S2CMessage, { type: "usage.result" }>;

/** 把 ISO 时间说成人话:「14:30」或「8/6 09:00」 */
function formatReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString()
    ? hhmm
    : `${String(d.getMonth() + 1)}/${String(d.getDate())} ${hhmm}`;
}

const statusText: Record<SessionInfo["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting_approval: "待审批",
  idle: "空闲",
  done: "已完成",
  died: "已退出",
};

/** 每秒刷新耗时;计时只重渲染标题,不牵动终端 WebView 与聊天列表。 */
function useElapsed(since: number | undefined): string {
  const [clock, setClock] = useState<{ since: number; label: string } | null>(null);
  useEffect(() => {
    if (since === undefined) return;
    const update = (): void => {
      const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
      if (seconds < 60) {
        setClock({ since, label: `${String(seconds)}s` });
        return;
      }
      const minutes = Math.floor(seconds / 60);
      setClock({
        since,
        label:
          minutes < 60
            ? `${String(minutes)}m ${String(seconds % 60)}s`
            : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`,
      });
    };
    // 避免在 effect 主体同步 setState,同时让标题首帧尽快补上耗时。
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [since]);
  return since !== undefined && clock?.since === since ? clock.label : "";
}

function SessionHeaderTitle({
  session,
  pending,
  tightest,
}: {
  session?: SessionInfo;
  pending: number;
  tightest: UsageWindow | null;
}) {
  const busy = session?.status === "running" || session?.status === "starting";
  const elapsed = useElapsed(
    busy || session?.status === "waiting_approval" ? session?.busySince : undefined,
  );
  const totals = session?.totals;
  const parts = session
    ? [
        session.agent,
        `${statusText[session.status]}${elapsed ? ` ${elapsed}` : ""}`,
        pending > 0 ? `${String(pending)} 项待批` : "",
        totals && totals.costUsd > 0 ? `$${totals.costUsd.toFixed(3)}` : "",
        tightest ? `${tightest.label} ${String(Math.round(tightest.utilization))}%` : "",
      ].filter(Boolean)
    : [];

  return (
    <View style={styles.headerTitle}>
      <Text style={styles.headerName} numberOfLines={1}>
        {session?.title ?? "会话"}
      </Text>
      {session && (
        <View style={styles.headerMetaRow}>
          <View
            style={[
              styles.headerDot,
              { backgroundColor: statusColor[session.status] ?? color.textDim },
            ]}
          />
          <Text style={styles.headerSub} numberOfLines={1}>
            {parts.join(" · ")}
          </Text>
        </View>
      )}
    </View>
  );
}

export default function SessionScreen() {
  const insets = useSafeAreaInsets();
  const appendTranscript = useCallback((text: string): void => {
    // 使用函数式更新，转写期间用户新打的字也不会被旧闭包覆盖。
    setDraft((current) => appendVoiceTranscript(current, text));
  }, []);
  const { hostId, sid } = useLocalSearchParams<{ hostId: string; sid: string }>();
  const { conn, runtime } = useHostConnection(hostId);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
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
  const [images, setImages] = useState<PickedImage[]>([]);
  const termRef = useRef<TerminalHandle>(null);
  // 字号存在会话页而不是终端内部:切走再回来不该重置成默认值
  const [fontSize, setFontSize] = useState(12);
  const [perf, setPerf] = useState<{ fps: number; kb: number; renderer: string } | null>(null);

  // 只显示最吃紧的那个窗口 —— 头部塞不下三个,而你关心的永远是先撞上的那个
  const tightest = (usage?.windows ?? []).reduce<UsageWindow | null>(
    (best, w) => (best === null || w.utilization > best.utilization ? w : best),
    null,
  );

  const send = useCallback(
    (text: string): void => {
      const t = text.trim();
      // 只带图不带字是合理的:一张报错截图本身就是问题
      if (!conn || !sid || (t.length === 0 && (!isChat || images.length === 0))) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (isChat) {
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
    [conn, sid, isChat, images, setDraft, setImages],
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
        <ActivityIndicator color={color.accent} />
        <Text style={styles.dim}>正在准备连接…</Text>
      </View>
    );
  }

  const policy: ApprovalPolicy = session?.approvalPolicy ?? "strict";
  const policyLabel: Record<ApprovalPolicy, string> = {
    strict: "逐条批准",
    standard: "半自动",
    yolo: "YOLO",
  };

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

  /** 常用的 Chat / Shell 切换直接可见,不再藏在三级菜单里。 */
  const switchMode = (tty: boolean): void => {
    if (showTty === tty) return;
    void Haptics.selectionAsync();
    setShowTty(tty);
    setSearch(null);
    if (tty) setImages([]);
  };

  /** 低频与危险操作保留在系统菜单里,当前策略直接写在菜单项上。 */
  const openMenu = (): void => {
    const items: { text: string; style?: "destructive" | "cancel"; onPress?: () => void }[] = [];
    if (isStructured) {
      items.push({
        text: tightest
          ? `用量与限流(${tightest.label} ${String(Math.round(tightest.utilization))}%)`
          : "用量与限流",
        onPress: showUsage,
      });
      items.push({
        text: `审批策略:${policyLabel[policy]}`,
        onPress: choosePolicy,
      });
    }
    items.push({ text: "结束会话", style: "destructive", onPress: confirmKill });
    items.push({ text: "取消", style: "cancel" });
    Alert.alert(session?.title ?? "会话", undefined, items);
  };

  // 输入以 / 开头时给命令候选
  const commandHints =
    isChat && session ? matchCommands(session.agent, draft.trim()) : [];
  const canSend = draft.trim().length > 0 || (isChat && images.length > 0);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      // targetSdk 35+ 的 edge-to-edge 窗口上，adjustResize 仍可能只让 IME 覆盖
      // ReactRootView；Android 需显式按键盘高度缩短这一层，保证输入栏留在键盘上方。
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <Stack.Screen
        options={{
          headerTitle: () => (
            <SessionHeaderTitle session={session} pending={pending} tightest={tightest} />
          ),
          headerRight: () => (
            <View style={styles.headerRight}>
              {/* 只有"停止"留在外面 —— 它是唯一分秒必争的操作 */}
              {busy && (
                <Pressable
                  onPress={() => conn.interrupt(sid)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="停止当前任务"
                >
                  <Icon name="stop.circle" size={21} color={color.warn} />
                </Pressable>
              )}
              <Pressable
                onPress={openMenu}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="更多会话操作"
              >
                <Icon name="ellipsis.circle" size={21} color={color.accent} />
              </Pressable>
            </View>
          ),
        }}
      />
      {runtime.status !== "connected" && (
        <View style={styles.reconnBar}>
          <View style={styles.reconnCopy}>
            <View style={styles.reconnDot} />
            <Text style={styles.reconnText} numberOfLines={2}>
              {runtime.status === "failed"
                ? `连接失败 · ${runtime.lastError ?? "请重试"}`
                : "连接已中断 · 正在自动恢复"}
            </Text>
          </View>
          <Pressable onPress={() => conn.kick()} hitSlop={8} accessibilityRole="button">
            <Text style={styles.reconnAction}>重试</Text>
          </Pressable>
        </View>
      )}

      {isStructured && (
        <View style={styles.modeBar}>
          <View style={styles.modeSwitch} accessibilityRole="tablist">
            <Pressable
              style={[styles.modeTab, !showTty && styles.modeTabActive]}
              onPress={() => switchMode(false)}
              accessibilityRole="tab"
              accessibilityState={{ selected: !showTty }}
              accessibilityLabel="对话视图"
            >
              <Icon
                name="bubble.left.and.text.bubble.right"
                size={14}
                color={!showTty ? color.text : color.textDim}
              />
              <Text style={[styles.modeText, !showTty && styles.modeTextActive]}>对话</Text>
              {pending > 0 && (
                <View style={styles.pendingBadge}>
                  <Text style={styles.pendingBadgeText}>{pending > 9 ? "9+" : pending}</Text>
                </View>
              )}
            </Pressable>
            <Pressable
              style={[styles.modeTab, showTty && styles.modeTabActive]}
              onPress={() => switchMode(true)}
              accessibilityRole="tab"
              accessibilityState={{ selected: showTty }}
              accessibilityLabel="终端视图"
            >
              <Icon name="terminal" size={14} color={showTty ? color.text : color.textDim} />
              <Text style={[styles.modeText, showTty && styles.modeTextActive]}>终端</Text>
            </Pressable>
          </View>
          {!showTty && (
            <Pressable
              style={[styles.modeAction, search !== null && styles.modeActionActive]}
              onPress={() => setSearch((value) => (value === null ? "" : null))}
              accessibilityRole="button"
              accessibilityLabel={search === null ? "搜索消息" : "关闭搜索"}
            >
              <Icon name="magnifyingglass" size={16} color={color.textDim} />
            </Pressable>
          )}
        </View>
      )}

      {isChat && search !== null && (
        <View style={styles.searchBar}>
          <Icon name="magnifyingglass" size={15} color={color.textFaint} />
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
                原始 TTY · 部分结构化 agent 可能不会在这里输出内容
                {__DEV__ && perf
                  ? ` · ${perf.renderer} ${String(perf.fps)}fps ${String(perf.kb)}KB/s`
                  : ""}
              </Text>
            </View>
          )}
          <Terminal ref={termRef} conn={conn} sid={sid} onFontSize={setFontSize} onPerf={setPerf} />
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

      {isChat && images.length > 0 && (
        <ScrollView horizontal style={styles.thumbs} contentContainerStyle={styles.thumbsRow}>
          {images.map((img, i) => (
            <View key={img.uri} style={styles.thumbWrap}>
              <Image source={{ uri: img.uri }} style={styles.thumb} />
              <Pressable
                style={styles.thumbX}
                hitSlop={6}
                onPress={() => setImages((v) => v.filter((_, j) => j !== i))}
                accessibilityRole="button"
                accessibilityLabel={`移除第 ${String(i + 1)} 张图片`}
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
            {usage.inputTokens !== undefined ? (
              <Row label="输入 token" value={usage.inputTokens.toLocaleString()} />
            ) : null}
            {usage.outputTokens !== undefined ? (
              <Row label="输出 token" value={usage.outputTokens.toLocaleString()} />
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

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <DismissKey visible={focused} />
        {isChat && (
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && styles.composerBtnPressed]}
            onPress={attach}
            accessibilityRole="button"
            accessibilityLabel="添加图片"
          >
            <Icon name="paperclip" size={17} color={color.textDim} />
          </Pressable>
        )}
        <TextInput
          style={[styles.input, isChat && styles.inputChat]}
          placeholder={isChat ? `给 ${session?.agent ?? "agent"} 发消息` : "输入命令，回车执行"}
          placeholderTextColor={color.textFaint}
          value={draft}
          onChangeText={setDraft}
          onFocus={() => { setFocused(true); }}
          onBlur={() => { setFocused(false); }}
          onSubmitEditing={() => send(draft)}
          submitBehavior={isChat ? "newline" : "submit"}
          returnKeyType={isChat ? "default" : "send"}
          autoCapitalize="none"
          autoCorrect={false}
          multiline={isChat}
        />
        {isChat && <VoiceButton onTranscript={appendTranscript} />}
        <Pressable
          style={({ pressed }) => [
            styles.sendBtn,
            !canSend && styles.sendBtnDim,
            pressed && canSend && styles.sendBtnPressed,
          ]}
          onPress={() => send(draft)}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel={isChat ? "发送消息" : "执行命令"}
          accessibilityState={{ disabled: !canSend }}
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
  container: { flex: 1, backgroundColor: color.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  dim: { color: color.textDim, fontSize: 14 },

  headerTitle: { alignItems: "center", maxWidth: 238 },
  headerName: { color: color.text, fontSize: 16, fontWeight: "600" },
  headerMetaRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  headerDot: { width: 5, height: 5, borderRadius: 3 },
  headerSub: { color: color.textDim, fontSize: 10.5, flexShrink: 1 },
  headerRight: { flexDirection: "row", gap: 16, alignItems: "center" },

  modeBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: color.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  modeSwitch: {
    flex: 1,
    flexDirection: "row",
    gap: 3,
    padding: 3,
    backgroundColor: color.surfaceRaised,
    borderRadius: 12,
  },
  modeTab: {
    flex: 1,
    minHeight: 34,
    borderRadius: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  modeTabActive: {
    backgroundColor: color.pressed,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
  },
  modeText: { color: color.textDim, fontSize: 13, fontWeight: "500" },
  modeTextActive: { color: color.text, fontWeight: "600" },
  pendingBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.danger,
  },
  pendingBadgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  modeAction: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: color.surfaceRaised,
  },
  modeActionActive: { backgroundColor: color.accentBg },

  reconnBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: color.warnBg,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reconnCopy: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  reconnDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.warn },
  reconnText: { flex: 1, color: "#EAC77C", fontSize: 12, lineHeight: 16 },
  reconnAction: { color: color.text, fontSize: 12, fontWeight: "600" },

  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  searchInput: {
    flex: 1,
    minHeight: 36,
    backgroundColor: color.surfaceRaised,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 7,
    color: color.text,
    fontSize: 14,
  },
  searchCancel: { color: color.accent, fontSize: 14, fontWeight: "500" },

  cmdBox: { backgroundColor: color.surface, paddingHorizontal: 10, paddingTop: 6, gap: 3 },
  cmdRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: color.surfaceRaised,
    borderRadius: 9,
  },
  cmdName: { color: color.accent, fontSize: 13, fontFamily: MONOSPACE_FONT },
  cmdDesc: { color: color.textDim, fontSize: 12, flex: 1 },

  ttyNotice: { backgroundColor: color.accentBg, paddingHorizontal: 12, paddingVertical: 7 },
  ttyNoticeText: { color: "#9AB7E8", fontSize: 11, lineHeight: 15 },

  thumbs: { flexGrow: 0, backgroundColor: color.surface },
  thumbsRow: { gap: 10, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
  thumbWrap: { width: 58, height: 58 },
  thumb: { width: 58, height: 58, borderRadius: 10, backgroundColor: color.surfaceRaised },
  thumbX: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: color.pressed,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: color.surface,
  },
  thumbXText: { color: color.text, fontSize: 14, lineHeight: 16 },

  sheetLoading: { paddingVertical: 32 },
  sheetNote: { color: color.textDim, fontSize: 13, lineHeight: 19, paddingVertical: 12 },
  window: { gap: 6, paddingVertical: 14 },
  windowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  windowPct: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },

  composer: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
    backgroundColor: color.surface,
    alignItems: "flex-end",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  composerBtnPressed: { backgroundColor: color.pressed },
  input: {
    flex: 1,
    minHeight: 40,
    backgroundColor: color.surfaceRaised,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
    color: color.text,
    fontSize: 15,
    lineHeight: 21,
  },
  inputChat: { maxHeight: 132 },
  sendBtn: {
    backgroundColor: color.accentDim,
    borderRadius: 20,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDim: { backgroundColor: color.surfaceRaised, opacity: 0.72 },
  sendBtnPressed: { transform: [{ scale: 0.94 }] },
});
