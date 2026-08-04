/**
 * 结构化会话视图:消息流 + 工具卡片 + 审批卡片。
 * 事件→条目的折叠逻辑在 lib/chat-model,这里只负责渲染与交互。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { PermissionReply } from "@prospero/protocol";
import type { HostConnection } from "@/lib/connection";
import {
  applyEvent,
  applyEvents,
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
}

export function ChatView({ conn, sid }: Props) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const listRef = useRef<FlatList<ChatItem>>(null);
  const evSeqRef = useRef(0);
  const atBottomRef = useRef(true);

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
    });
    const attach = (): void => conn.attach(sid, evSeqRef.current || undefined);
    const offConn = conn.events.on("connected", attach);
    if (conn.isConnected) attach();
    return () => {
      offSnap();
      offEv();
      offConn();
    };
  }, [conn, sid]);

  // 新内容到达时,只有用户已在底部才自动跟随(避免打断向上翻阅)
  useEffect(() => {
    if (atBottomRef.current && items.length > 0) {
      listRef.current?.scrollToEnd({ animated: true });
    }
  }, [items]);

  const respond = useCallback(
    (reqId: string, reply: PermissionReply) => {
      conn.respondPermission(sid, reqId, reply);
    },
    [conn, sid],
  );

  return (
    <FlatList
      ref={listRef}
      data={items}
      keyExtractor={(i) => i.key}
      style={styles.list}
      contentContainerStyle={styles.content}
      onScroll={(e) => {
        const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
        atBottomRef.current =
          layoutMeasurement.height + contentOffset.y >= contentSize.height - 60;
      }}
      scrollEventThrottle={200}
      ListEmptyComponent={
        <Text style={styles.empty}>会话已就绪,发一条消息开始。</Text>
      }
      renderItem={({ item }) => {
        switch (item.type) {
          case "user":
            return <UserBubble item={item} />;
          case "assistant":
            return <AssistantBubble item={item} />;
          case "tool":
            return <ToolCard item={item} />;
          case "permission":
            return <PermissionCard item={item} onRespond={respond} />;
          case "error":
            return <ErrorCard item={item} />;
        }
      }}
    />
  );
}

function UserBubble({ item }: { item: UserItem }) {
  return (
    <View style={styles.userRow}>
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{item.text}</Text>
      </View>
    </View>
  );
}

function AssistantBubble({ item }: { item: AssistantItem }) {
  const [showReasoning, setShowReasoning] = useState(false);
  const cost = item.finish?.costUsd;
  const out = item.finish?.outputTokens;
  return (
    <View style={styles.assistantRow}>
      {item.reasoning.length > 0 && (
        <Pressable onPress={() => setShowReasoning((v) => !v)} style={styles.reasoningToggle}>
          <Text style={styles.reasoningToggleText}>
            {showReasoning ? "▾ 收起思考" : "▸ 思考过程"}
          </Text>
        </Pressable>
      )}
      {showReasoning && <Text style={styles.reasoningText}>{item.reasoning}</Text>}
      {item.text.length > 0 && <Text style={styles.assistantText}>{item.text}</Text>}
      {!item.done && item.text.length === 0 && item.reasoning.length === 0 && (
        <Text style={styles.thinking}>思考中…</Text>
      )}
      {item.done && (cost !== undefined || out !== undefined) && (
        <Text style={styles.usage}>
          {out !== undefined ? `${String(out)} tokens` : ""}
          {cost !== undefined && cost > 0 ? ` · $${cost.toFixed(4)}` : ""}
        </Text>
      )}
    </View>
  );
}

const stateLabel = { running: "运行中", success: "完成", failed: "失败" } as const;
const stateColor = { running: "#d9a441", success: "#4dbd74", failed: "#e5534b" } as const;

function ToolCard({ item }: { item: ToolItem }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Pressable style={styles.toolCard} onPress={() => setExpanded((v) => !v)}>
      <View style={styles.toolHeader}>
        <View style={[styles.toolDot, { backgroundColor: stateColor[item.state] }]} />
        <Text style={styles.toolName}>{item.tool}</Text>
        <Text style={styles.toolState}>{stateLabel[item.state]}</Text>
      </View>
      {item.input.length > 0 && (
        <Text style={styles.toolInput} numberOfLines={expanded ? undefined : 2}>
          {item.input}
        </Text>
      )}
      {expanded && item.result !== undefined && item.result.length > 0 && (
        <Text style={styles.toolResult}>{item.result}</Text>
      )}
    </Pressable>
  );
}

const replyLabel: Record<PermissionReply, string> = {
  once: "已允许一次",
  always: "已始终允许",
  reject: "已拒绝",
};

function PermissionCard({
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
      {item.resources.map((r, i) => (
        <Text key={`${item.reqId}:${String(i)}`} style={styles.permResource} numberOfLines={4}>
          {r}
        </Text>
      ))}
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
}

function ErrorCard({ item }: { item: ErrorItem }) {
  return (
    <View style={styles.errorCard}>
      <Text style={styles.errorText}>{item.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: "#0b0b0e" },
  content: { padding: 12, gap: 10, paddingBottom: 24 },
  empty: { color: "#5a5a66", textAlign: "center", marginTop: 40, fontSize: 13 },

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
  assistantText: { color: "#e8e8ee", fontSize: 15, lineHeight: 22 },
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

  errorCard: { backgroundColor: "#2b1a1a", borderRadius: 10, padding: 10 },
  errorText: { color: "#f0b0ab", fontSize: 13 },
});
