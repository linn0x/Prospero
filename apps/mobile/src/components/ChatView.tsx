/**
 * 结构化会话视图:消息流 + 工具卡片 + 审批卡片。
 * 事件→条目的折叠逻辑在 lib/chat-model,这里只负责渲染与交互。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { PermissionReply } from "@prospero/protocol";
import { DiffView } from "@/components/DiffView";
import { Markdown } from "@/components/Markdown";
import type { HostConnection } from "@/lib/connection";
import {
  applyEvent,
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

export function ChatView({ conn, sid, onPendingChange, search, onRetry }: Props) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const listRef = useRef<FlatList<ChatItem>>(null);
  const evSeqRef = useRef(0);
  const atBottomRef = useRef(true);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    // 快照重建整个列表(attach / 重连后的权威状态)
    const offSnap = conn.events.on("chatSnapshot", (m) => {
      if (m.sid !== sid) return;
      evSeqRef.current = m.evSeq;
      setItems(applyEvents([], m.events));
    });
    const offEv = conn.events.on("agentEvent", (m) => {
      if (m.sid !== sid) return;
      evSeqRef.current = m.evSeq;
      setItems((prev) => applyEvent(prev, m.body));
      if (!atBottomRef.current) setUnread((n) => n + 1);
    });
    const offOut = conn.events.on("toolOutput", (m) => {
      if (m.sid !== sid) return;
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
    };
  }, [conn, sid]);

  // 新内容到达时,只有用户已在底部才自动跟随(避免打断向上翻阅)
  useEffect(() => {
    if (atBottomRef.current && items.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
    onPendingChange?.(pendingPermissions(items).length);
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
    setUnread(0);
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
        onScroll={(e) => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
          const bottom =
            layoutMeasurement.height + contentOffset.y >= contentSize.height - 60;
          atBottomRef.current = bottom;
          if (bottom && unread > 0) setUnread(0);
        }}
        scrollEventThrottle={200}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        removeClippedSubviews
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={11}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {search ? "没有匹配的消息。" : "会话已就绪,发一条消息开始。"}
          </Text>
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
      {unread > 0 && (
        <Pressable style={styles.jumpBtn} onPress={jumpToBottom}>
          <Text style={styles.jumpText}>↓ {unread} 条新消息</Text>
        </Pressable>
      )}
    </View>
  );
}

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
function useCopy(): (text: string) => void {
  return useCallback((text: string) => {
    void Clipboard.setStringAsync(text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);
}

const UserBubble = memo(function UserBubble({ item }: { item: UserItem }) {
  const copy = useCopy();
  return (
    <View style={styles.userRow}>
      <Pressable
        style={styles.userBubble}
        onLongPress={() => copy(item.text)}
        delayLongPress={350}
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
      onLongPress={() => copy(item.text)}
      delayLongPress={350}
    >
      {item.reasoning.length > 0 && (
        <Pressable onPress={() => setShowReasoning((v) => !v)} style={styles.reasoningToggle}>
          <Text style={styles.reasoningToggleText}>
            {showReasoning ? "▾ 收起思考" : "▸ 思考过程"}
          </Text>
        </Pressable>
      )}
      {showReasoning && <Text style={styles.reasoningText}>{item.reasoning}</Text>}
      {item.text.length > 0 && <Markdown source={item.text} />}
      {!item.done && item.text.length === 0 && item.reasoning.length === 0 && (
        <Text style={styles.thinking}>思考中…</Text>
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
const stateColor = { running: "#d9a441", success: "#4dbd74", failed: "#e5534b" } as const;

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
        onLongPress={() => copy(`${item.tool}\n${item.input}\n${body ?? ""}`)}
        delayLongPress={350}
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
  return (
    <View style={[styles.permCard, resolved !== undefined && styles.permCardResolved]}>
      <Text style={styles.permTitle}>需要你的批准 · {item.action}</Text>
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
          <Pressable
            style={[styles.permBtn, styles.permAllow]}
            onPress={() => onRespond(item.reqId, "once")}
          >
            <Text style={styles.permBtnText}>允许一次</Text>
          </Pressable>
          <Pressable
            style={[styles.permBtn, styles.permAlways]}
            onPress={() => onRespond(item.reqId, "always")}
          >
            <Text style={styles.permBtnText}>始终允许</Text>
          </Pressable>
          <Pressable
            style={[styles.permBtn, styles.permReject]}
            onPress={() => onRespond(item.reqId, "reject")}
          >
            <Text style={styles.permBtnText}>拒绝</Text>
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
        <Pressable onPress={onRetry} hitSlop={6} style={styles.retryBtn}>
          <Text style={styles.retryText}>重发上一条</Text>
        </Pressable>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1, backgroundColor: "#0b0b0e" },
  content: { padding: 12, gap: 10, paddingBottom: 24 },
  empty: { color: "#5a5a66", textAlign: "center", marginTop: 40, fontSize: 13 },

  jumpBtn: {
    position: "absolute",
    bottom: 12,
    alignSelf: "center",
    backgroundColor: "#3557b7",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  jumpText: { color: "#fff", fontSize: 13, fontWeight: "600" },

  userRow: { alignItems: "flex-end" },
  userBubble: {
    backgroundColor: "#3557b7",
    borderRadius: 14,
    borderBottomRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 9,
    maxWidth: "88%",
  },
  userText: { color: "#fff", fontSize: 15, lineHeight: 21 },

  assistantRow: { gap: 6 },
  thinking: { color: "#6a6a76", fontSize: 14, fontStyle: "italic" },
  reasoningToggle: { alignSelf: "flex-start" },
  reasoningToggleText: { color: "#7aa2f7", fontSize: 12 },
  reasoningText: {
    color: "#8a8a96",
    fontSize: 13,
    lineHeight: 19,
    borderLeftWidth: 2,
    borderLeftColor: "#2c2c36",
    paddingLeft: 10,
  },
  usage: { color: "#5a5a66", fontSize: 11 },

  toolCard: { backgroundColor: "#15151b", borderRadius: 10, padding: 10, gap: 6 },
  toolHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  toolDot: { width: 8, height: 8, borderRadius: 4 },
  toolName: { color: "#c8c8d4", fontSize: 13, fontWeight: "600", flex: 1 },
  diffBadge: { color: "#7a9a7a", fontSize: 11, fontVariant: ["tabular-nums"] },
  toolState: { color: "#6a6a76", fontSize: 11 },
  toolInput: { color: "#8a8a96", fontSize: 12, fontFamily: "Menlo", lineHeight: 17 },
  toolResult: {
    color: "#7a8a7a",
    fontSize: 12,
    fontFamily: "Menlo",
    lineHeight: 17,
    borderTopWidth: 1,
    borderTopColor: "#22222a",
    paddingTop: 6,
  },

  permCard: {
    backgroundColor: "#241c14",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#5a4426",
    padding: 12,
    gap: 8,
  },
  permCardResolved: { opacity: 0.55, borderColor: "#33333d" },
  permTitle: { color: "#e8c98a", fontSize: 14, fontWeight: "600" },
  permResource: {
    color: "#d8d8e2",
    fontSize: 12,
    fontFamily: "Menlo",
    backgroundColor: "#171319",
    borderRadius: 6,
    padding: 8,
  },
  permButtons: { flexDirection: "row", gap: 8 },
  permBtn: { flex: 1, borderRadius: 8, paddingVertical: 10, alignItems: "center" },
  permAllow: { backgroundColor: "#2f6b45" },
  permAlways: { backgroundColor: "#3557b7" },
  permReject: { backgroundColor: "#7a2f2b" },
  permBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  permResolved: { color: "#9a9aa6", fontSize: 12 },

  errorCard: { backgroundColor: "#2b1a1a", borderRadius: 10, padding: 10, gap: 6 },
  errorText: { color: "#f0b0ab", fontSize: 13 },
  retryBtn: { alignSelf: "flex-start" },
  retryText: { color: "#7aa2f7", fontSize: 12, fontWeight: "600" },
});
