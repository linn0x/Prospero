/**
 * 结构化会话视图:消息流 + 工具卡片 + 审批卡片。
 * 事件→条目的折叠逻辑在 lib/chat-model,这里只负责渲染与交互。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { AgentEventBody, PermissionReply } from "@prospero/protocol";
import { DiffView } from "@/components/DiffView";
import { Icon } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { toast } from "@/components/Toast";
import type { HostConnection } from "@/lib/connection";
import { MONOSPACE_FONT, color, radius } from "@/lib/theme";
import {
  applyEvents,
  applyToolOutput,
  pendingPermissions,
  type AssistantItem,
  type ChatItem,
  type ErrorItem,
  type PermissionItem,
  type ToolItem,
  type UserItem,
} from "@/lib/chat-model";

interface Props {
  conn: HostConnection;
  sid: string;
  /** 上报给会话页,用于显示"N 项待批"与快捷回复的忙碌态 */
  onPendingChange?: (count: number) => void;
  /** 搜索关键词;非空时只显示命中的条目 */
  search?: string;
  /** 出错时可重发上一条用户消息 */
  onRetry?: (text: string) => void;
}

export const ChatView = memo(function ChatView({
  conn,
  sid,
  onPendingChange,
  search,
  onRetry,
}: Props) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const listRef = useRef<FlatList<ChatItem>>(null);
  const evSeqRef = useRef(0);
  const atBottomRef = useRef(true);
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    // 文本 delta 往往几十次/秒。逐条 setState 会反复解析 Markdown、布局列表并
    // 启动滚动动画;按约一帧半合并后仍像实时打字,但 JS/原生桥压力小很多。
    let queued: AgentEventBody[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      if (queued.length === 0) return;
      const batch = queued;
      queued = [];
      setItems((prev) => applyEvents(prev, batch));
    };
    const discardQueued = (): void => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      queued = [];
    };

    // 快照重建整个列表(attach / 重连后的权威状态)
    const offSnap = conn.events.on("chatSnapshot", (m) => {
      if (m.sid !== sid) return;
      discardQueued();
      evSeqRef.current = m.evSeq;
      setItems(applyEvents([], m.events));
    });
    const offEv = conn.events.on("agentEvent", (m) => {
      if (m.sid !== sid) return;
      evSeqRef.current = m.evSeq;
      queued.push(m.body);
      if (flushTimer === null) flushTimer = setTimeout(flush, 32);
      if (!atBottomRef.current) setHasUnread(true);
    });
    const offOut = conn.events.on("toolOutput", (m) => {
      if (m.sid !== sid) return;
      // tool.start 可能还在 32ms 合并窗里;先提交它,再回填完整输出。
      if (queued.length > 0) flush();
      setItems((prev) => applyToolOutput(prev, m.callId, m.output));
    });
    const attach = (): void => conn.attach(sid, evSeqRef.current || undefined);
    const offConn = conn.events.on("connected", attach);
    if (conn.isConnected) attach();
    return () => {
      offSnap();
      offEv();
      offOut();
      offConn();
      discardQueued();
    };
  }, [conn, sid]);

  // 新内容到达时,只有用户已在底部才自动跟随(避免打断向上翻阅)
  useEffect(() => {
    onPendingChange?.(pendingPermissions(items).length);
    if (atBottomRef.current && items.length > 0) {
      const frame = requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: false });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [items, onPendingChange]);

  const respond = useCallback(
    (reqId: string, reply: PermissionReply) => {
      // 审批是全 App 最高风险的点击,给一次触觉确认
      void Haptics.notificationAsync(
        reply === "reject"
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Success,
      );
      conn.respondPermission(sid, reqId, reply);
    },
    [conn, sid],
  );

  const fetchOutput = useCallback(
    (callId: string) => conn.getToolOutput(sid, callId),
    [conn, sid],
  );

  const retry = useCallback(() => {
    // 找最后一条用户消息重发
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.type === "user") {
        onRetry?.(it.text);
        return;
      }
    }
  }, [items, onRetry]);

  const visible = useMemo(() => {
    const q = search?.trim().toLowerCase() ?? "";
    if (q.length === 0) return items;
    return items.filter((i) => itemText(i).toLowerCase().includes(q));
  }, [items, search]);

  const jumpToBottom = useCallback(() => {
    atBottomRef.current = true;
    setHasUnread(false);
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  return (
    <View style={styles.root}>
      <FlatList
        ref={listRef}
        data={visible}
        keyExtractor={(i) => i.key}
        style={styles.list}
        contentContainerStyle={styles.content}
        onContentSizeChange={() => {
          if (atBottomRef.current) listRef.current?.scrollToEnd({ animated: false });
        }}
        onScroll={(e) => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
          const bottom =
            layoutMeasurement.height + contentOffset.y >= contentSize.height - 60;
          atBottomRef.current = bottom;
          if (bottom && hasUnread) setHasUnread(false);
        }}
        scrollEventThrottle={32}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        removeClippedSubviews={Platform.OS === "android"}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={11}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Icon
                name={search ? "magnifyingglass" : "bubble.left.and.text.bubble.right"}
                size={22}
                color={color.textFaint}
              />
            </View>
            <Text style={styles.emptyTitle}>{search ? "没有找到消息" : "准备好了"}</Text>
            <Text style={styles.emptyText}>
              {search ? "换个关键词试试" : "描述目标，或从下方快捷回复开始"}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          switch (item.type) {
            case "user":
              return <UserBubble item={item} />;
            case "assistant":
              return <AssistantBubble item={item} />;
            case "tool":
              return <ToolCard item={item} onFetchOutput={fetchOutput} />;
            case "permission":
              return <PermissionCard item={item} onRespond={respond} />;
            case "error":
              return <ErrorCard item={item} onRetry={onRetry ? retry : undefined} />;
          }
        }}
      />
      {hasUnread && (
        <Pressable
          style={({ pressed }) => [styles.jumpBtn, pressed && styles.jumpBtnPressed]}
          onPress={jumpToBottom}
          accessibilityRole="button"
          accessibilityLabel="跳到最新内容"
        >
          <Text style={styles.jumpText}>查看新内容 ↓</Text>
        </Pressable>
      )}
    </View>
  );
});

function itemText(i: ChatItem): string {
  switch (i.type) {
    case "user":
      return i.text;
    case "assistant":
      return i.text + i.reasoning;
    case "tool":
      return `${i.tool} ${i.input} ${i.result ?? ""}`;
    case "permission":
      return `${i.action} ${i.resources.join(" ")}`;
    case "error":
      return i.message;
  }
}

/** 长按复制:手机上把 agent 输出拷走的唯一顺手方式,附触觉确认 */
function useCopy(): (text: string, what?: string) => void {
  return useCallback((text: string, what = "内容") => {
    void Clipboard.setStringAsync(text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // 只给触感等于没反馈 —— 静音/关掉触感的手机上完全看不出来复制成功了
    toast(`已复制${what}`);
  }, []);
}

const UserBubble = memo(function UserBubble({ item }: { item: UserItem }) {
  const copy = useCopy();
  return (
    <View style={styles.userRow}>
      <Pressable
        style={styles.userBubble}
        onLongPress={() => copy(item.text, "这条消息")}
        delayLongPress={350}
        accessibilityHint="长按复制"
      >
        <Text style={styles.userText} selectable>
          {item.text}
        </Text>
      </Pressable>
    </View>
  );
});

/**
 * memo 化:流式输出时列表每收到一个 delta 就重渲染,
 * 不做记忆化的话历史消息(可能上百条)会跟着一起重算。
 */
const AssistantBubble = memo(function AssistantBubble({ item }: { item: AssistantItem }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const copy = useCopy();
  const cost = item.finish?.costUsd;
  const out = item.finish?.outputTokens;
  return (
    <Pressable
      style={styles.assistantRow}
      onLongPress={() => copy(item.text, "回复")}
      delayLongPress={350}
      accessibilityHint="长按复制回复"
    >
      {item.reasoning.length > 0 && (
        <Pressable
          onPress={() => setShowReasoning((v) => !v)}
          style={({ pressed }) => [styles.reasoningToggle, pressed && styles.inlinePressed]}
          accessibilityRole="button"
          accessibilityState={{ expanded: showReasoning }}
        >
          <Text style={styles.reasoningToggleText}>
            {showReasoning ? "▾ 收起思考" : "▸ 思考过程"}
          </Text>
        </Pressable>
      )}
      {showReasoning && <Text style={styles.reasoningText}>{item.reasoning}</Text>}
      {item.text.length > 0 && <Markdown source={item.text} />}
      {!item.done && item.text.length === 0 && item.reasoning.length === 0 && (
        <View style={styles.thinkingRow}>
          <View style={styles.thinkingDot} />
          <Text style={styles.thinking}>正在思考</Text>
        </View>
      )}
      {item.done && (cost !== undefined || out !== undefined) && (
        <Text style={styles.usage}>
          {out !== undefined ? `${String(out)} tokens` : ""}
          {cost !== undefined && cost > 0 ? ` · $${cost.toFixed(4)}` : ""}
        </Text>
      )}
    </Pressable>
  );
});

const stateLabel = { running: "运行中", success: "完成", failed: "失败" } as const;
const stateColor = { running: color.warn, success: color.success, failed: color.danger } as const;

const ToolCard = memo(function ToolCard({
  item,
  onFetchOutput,
}: {
  item: ToolItem;
  onFetchOutput: (callId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const copy = useCopy();

  const toggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    // 展开时才去拉全文,避免把大量输出提前灌到手机上
    if (next && item.hasMore === true && item.fullOutput === undefined) {
      onFetchOutput(item.callId);
    }
  };

  const body = item.fullOutput ?? item.result;
  return (
    <View style={styles.toolCard}>
      <Pressable
        onPress={toggle}
        onLongPress={() => copy(`${item.tool}\n${item.input}\n${body ?? ""}`, "工具卡片")}
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityHint="点按展开，长按复制"
      >
        <View style={styles.toolHeader}>
          <View style={[styles.toolDot, { backgroundColor: stateColor[item.state] }]} />
          <Text style={styles.toolName}>{item.tool}</Text>
          {item.diff && (
            <Text style={styles.diffBadge}>
              +{item.diff.additions} −{item.diff.deletions}
            </Text>
          )}
          <Text style={styles.toolState}>
            {stateLabel[item.state]}
            {body !== undefined && body.length > 0 ? (expanded ? " ▾" : " ▸") : ""}
          </Text>
        </View>
        {item.input.length > 0 && !item.diff && (
          <Text style={styles.toolInput} numberOfLines={expanded ? undefined : 2}>
            {item.input}
          </Text>
        )}
      </Pressable>
      {item.diff && <DiffView diff={item.diff} />}
      {expanded && body !== undefined && body.length > 0 && (
        <Text style={styles.toolResult} selectable>
          {body}
          {item.hasMore === true && item.fullOutput === undefined ? "\n(正在拉取完整输出…)" : ""}
        </Text>
      )}
    </View>
  );
});

const replyLabel: Record<PermissionReply, string> = {
  once: "已允许一次",
  always: "已始终允许",
  reject: "已拒绝",
};

const PermissionCard = memo(function PermissionCard({
  item,
  onRespond,
}: {
  item: PermissionItem;
  onRespond: (reqId: string, reply: PermissionReply) => void;
}) {
  const resolved = item.resolved;
  // 自动批准的卡片刻意做得低调但可见:不该抢注意力(它没在等你),
  // 但必须能在回滚聊天时一眼认出"这条没经过我"。
  if (item.auto !== undefined) {
    return (
      <View style={styles.permAutoCard}>
        <Text style={styles.permAutoText} numberOfLines={2}>
          自动放行 · {item.summary || item.action}
          {item.auto === "yolo" ? "(YOLO)" : ""}
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.permCard, resolved !== undefined && styles.permCardResolved]}>
      <View style={styles.permHeader}>
        <Icon name="exclamationmark.triangle.fill" size={18} color={color.warn} />
        <View style={styles.permHeaderCopy}>
          <Text style={styles.permKicker}>需要你的批准</Text>
          <Text style={styles.permTitle}>{item.summary || item.action}</Text>
        </View>
      </View>
      {item.summary && item.summary !== item.action && (
        <Text style={styles.permAction}>{item.action}</Text>
      )}
      {item.diff ? (
        <DiffView diff={item.diff} />
      ) : (
        item.resources.map((r, i) => (
          <Text key={`${item.reqId}:${String(i)}`} style={styles.permResource} numberOfLines={4}>
            {r}
          </Text>
        ))
      )}
      {resolved === undefined ? (
        <View style={styles.permButtons}>
          <View style={styles.permPrimaryRow}>
            <Pressable
              style={({ pressed }) => [
                styles.permBtn,
                styles.permReject,
                pressed && styles.permBtnPressed,
              ]}
              onPress={() => onRespond(item.reqId, "reject")}
              accessibilityRole="button"
            >
              <Text style={styles.permRejectText}>拒绝</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [
                styles.permBtn,
                styles.permAllow,
                pressed && styles.permBtnPressed,
              ]}
              onPress={() => onRespond(item.reqId, "once")}
              accessibilityRole="button"
            >
              <Text style={styles.permBtnText}>允许一次</Text>
            </Pressable>
          </View>
          <Pressable
            style={({ pressed }) => [styles.permAlways, pressed && styles.permBtnPressed]}
            onPress={() => onRespond(item.reqId, "always")}
            accessibilityRole="button"
          >
            <Text style={styles.permAlwaysText}>始终允许此类操作</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.permResolved}>{replyLabel[resolved]}</Text>
      )}
    </View>
  );
});

const ErrorCard = memo(function ErrorCard({
  item,
  onRetry,
}: {
  item: ErrorItem;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.errorCard}>
      <Text style={styles.errorText} selectable>
        {item.message}
      </Text>
      {onRetry && (
        <Pressable
          onPress={onRetry}
          hitSlop={6}
          style={styles.retryBtn}
          accessibilityRole="button"
        >
          <Text style={styles.retryText}>重发上一条</Text>
        </Pressable>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1, backgroundColor: color.bg },
  content: {
    flexGrow: 1,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 28,
    gap: 14,
  },
  empty: { minHeight: 280, alignItems: "center", justifyContent: "center", gap: 7 },
  emptyIcon: {
    width: 50,
    height: 50,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surface,
    marginBottom: 4,
  },
  emptyTitle: { color: color.text, fontSize: 15, fontWeight: "600" },
  emptyText: { color: color.textDim, fontSize: 13, textAlign: "center" },

  jumpBtn: {
    position: "absolute",
    bottom: 14,
    alignSelf: "center",
    backgroundColor: color.text,
    borderRadius: 18,
    paddingHorizontal: 15,
    paddingVertical: 8,
    shadowColor: "#000",
    shadowOpacity: 0.32,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  jumpBtnPressed: { transform: [{ scale: 0.97 }] },
  jumpText: { color: color.bg, fontSize: 12, fontWeight: "700" },

  userRow: { alignItems: "flex-end" },
  userBubble: {
    backgroundColor: color.accentDim,
    borderRadius: radius.lg,
    borderBottomRightRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    maxWidth: "86%",
  },
  userText: { color: "#fff", fontSize: 15, lineHeight: 22 },

  assistantRow: { gap: 7, paddingHorizontal: 2 },
  thinkingRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  thinkingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.accent },
  thinking: { color: color.textDim, fontSize: 13 },
  reasoningToggle: {
    alignSelf: "flex-start",
    backgroundColor: color.surface,
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  inlinePressed: { opacity: 0.72 },
  reasoningToggleText: { color: color.accent, fontSize: 12, fontWeight: "500" },
  reasoningText: {
    color: color.textDim,
    fontSize: 13,
    lineHeight: 20,
    borderLeftWidth: 2,
    borderLeftColor: color.border,
    paddingLeft: 10,
  },
  usage: { color: color.textFaint, fontSize: 11, fontVariant: ["tabular-nums"] },

  toolCard: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: 11,
    gap: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  toolHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  toolDot: { width: 7, height: 7, borderRadius: 4 },
  toolName: { color: color.text, fontSize: 13, fontWeight: "600", flex: 1 },
  diffBadge: { color: color.success, fontSize: 11, fontVariant: ["tabular-nums"] },
  toolState: { color: color.textFaint, fontSize: 11 },
  toolInput: { color: color.textDim, fontSize: 12, fontFamily: MONOSPACE_FONT, lineHeight: 18 },
  toolResult: {
    color: "#A9B4A9",
    fontSize: 12,
    fontFamily: MONOSPACE_FONT,
    lineHeight: 18,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    paddingTop: 8,
  },

  permCard: {
    backgroundColor: color.warnBg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "#624A22",
    padding: 13,
    gap: 10,
  },
  permAutoCard: {
    marginHorizontal: 8,
    marginVertical: 2,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: color.surface,
    borderLeftWidth: 2,
    borderLeftColor: color.textFaint,
  },
  permAutoText: { color: color.textDim, fontSize: 11, lineHeight: 16 },
  permCardResolved: { opacity: 0.58, borderColor: color.border },
  permHeader: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  permHeaderCopy: { flex: 1, gap: 2 },
  permKicker: { color: color.warn, fontSize: 11, fontWeight: "700" },
  permTitle: { color: color.text, fontSize: 14, fontWeight: "600", lineHeight: 20 },
  permAction: { color: "#DABF87", fontSize: 12, fontFamily: MONOSPACE_FONT },
  permResource: {
    color: color.text,
    fontSize: 12,
    fontFamily: MONOSPACE_FONT,
    backgroundColor: "#1B1712",
    borderRadius: 8,
    padding: 9,
    lineHeight: 17,
  },
  permButtons: { gap: 8, marginTop: 2 },
  permPrimaryRow: { flexDirection: "row", gap: 8 },
  permBtn: { flex: 1, borderRadius: 9, paddingVertical: 11, alignItems: "center" },
  permAllow: { backgroundColor: color.accentDim },
  permReject: { backgroundColor: color.dangerBg },
  permRejectText: { color: "#FF9A9A", fontSize: 13, fontWeight: "600" },
  permAlways: {
    borderRadius: 9,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#6D5830",
  },
  permAlwaysText: { color: "#DABF87", fontSize: 12, fontWeight: "500" },
  permBtnPressed: { opacity: 0.72 },
  permBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  permResolved: { color: color.textDim, fontSize: 12, fontWeight: "500" },

  errorCard: { backgroundColor: color.dangerBg, borderRadius: radius.md, padding: 11, gap: 7 },
  errorText: { color: "#F2AAAA", fontSize: 13, lineHeight: 19 },
  retryBtn: { alignSelf: "flex-start" },
  retryText: { color: color.accent, fontSize: 12, fontWeight: "600" },
});
