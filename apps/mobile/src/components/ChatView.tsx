/**
 * 结构化会话视图:消息流 + 工具卡片 + 审批卡片。
 * 事件→条目的折叠逻辑在 lib/chat-model,这里只负责渲染与交互。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  fromB64,
  toB64,
  type AgentEventBody,
  type AgentKind,
  type AgentQuestionAnswer,
  type PermissionReply,
  type SessionStatus,
  type SubagentStatus,
} from "@prospero/protocol";
import { AgentIcon, agentTint } from "@/components/AgentIcon";
import { DiffView } from "@/components/DiffView";
import { Icon } from "@/components/Icon";
import { Markdown, type ProjectImageLoader } from "@/components/Markdown";
import { toast } from "@/components/Toast";
import type { HostConnection } from "@/lib/connection";
import {
  resolveProjectFileReference,
  type ProjectFileReference,
} from "@/lib/file-references";
import { MONOSPACE_FONT, color, radius } from "@/lib/theme";
import {
  applyEvents,
  applyToolOutput,
  foldChatItems,
  itemsForAgent,
  pendingInteractions,
  type AssistantItem,
  type ChatDisplayItem,
  type ChatItem,
  type ErrorItem,
  type FoldableActivityItem,
  type PermissionItem,
  type QuestionItem,
  type SubagentItem,
  type ToolItem,
  type TurnDiffSummaryItem,
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
  /** agent 回复里的项目文件引用可直接打开只读预览。 */
  projectRoot?: string;
  onOpenFile?: (reference: ProjectFileReference) => void;
  /** 复用对话流底部的 agent 身份提示，不另占一条顶部状态栏。 */
  agent?: AgentKind;
  workingStatus?: SessionStatus | SubagentStatus;
  onInterrupt?: () => void;
  /** 省略显示主 Agent；有值时复用同一事件流展示该子 Agent 的独立对话。 */
  subagentId?: string;
  onOpenSubagent?: (subagentId: string) => void;
}

const PROJECT_IMAGE_CHUNK = 192 * 1024;
const MAX_PROJECT_IMAGE_BYTES = 6 * 1024 * 1024;

function projectImageMime(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  throw new Error("只支持 PNG、JPEG、GIF 与 WebP 图片");
}

export const ChatView = memo(function ChatView({
  conn,
  sid,
  onPendingChange,
  search,
  onRetry,
  projectRoot,
  onOpenFile,
  agent,
  workingStatus,
  onInterrupt,
  subagentId,
  onOpenSubagent,
}: Props) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const listRef = useRef<FlatList<ChatDisplayItem>>(null);
  const imageCacheRef = useRef(new Map<string, Promise<string>>());
  const evSeqRef = useRef(0);
  const atBottomRef = useRef(true);
  const [hasUnread, setHasUnread] = useState(false);

  const loadProjectImage = useCallback<ProjectImageLoader>(
    (reference) => {
      const key = `${sid}\u0000${reference.path}`;
      const cached = imageCacheRef.current.get(key);
      if (cached) return cached;
      const request = (async (): Promise<string> => {
        const mime = projectImageMime(reference.path);
        let offset = 0;
        let total: number | null = null;
        let bytes: Uint8Array | null = null;
        for (;;) {
          const chunk = await conn.fsGetChunk(sid, reference.path, offset, PROJECT_IMAGE_CHUNK);
          if (total === null) {
            total = chunk.total;
            if (total <= 0) throw new Error("图片文件为空");
            if (total > MAX_PROJECT_IMAGE_BYTES) throw new Error("图片超过 6 MB，请点按打开预览");
            bytes = new Uint8Array(total);
          } else if (chunk.total !== total) {
            throw new Error("读取图片时文件大小发生了变化");
          }
          const part = fromB64(chunk.dataB64);
          if (!bytes || offset + part.byteLength > bytes.byteLength) {
            throw new Error("图片分块响应无效");
          }
          bytes.set(part, offset);
          offset += part.byteLength;
          if (chunk.eof) break;
          if (part.byteLength === 0) throw new Error("图片传输提前中断");
        }
        if (!bytes || total === null || offset !== total) throw new Error("图片传输不完整");
        return `data:${mime};base64,${toB64(bytes)}`;
      })().catch((error: unknown) => {
        imageCacheRef.current.delete(key);
        throw error;
      });
      if (imageCacheRef.current.size >= 12) {
        const oldest = imageCacheRef.current.keys().next().value as string | undefined;
        if (oldest) imageCacheRef.current.delete(oldest);
      }
      imageCacheRef.current.set(key, request);
      return request;
    },
    [conn, sid],
  );

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

  const scopedItems = useMemo(() => itemsForAgent(items, subagentId), [items, subagentId]);

  // 新内容到达时,只有用户已在底部才自动跟随(避免打断向上翻阅)
  useEffect(() => {
    onPendingChange?.(pendingInteractions(scopedItems).length);
    if (atBottomRef.current && scopedItems.length > 0) {
      const frame = requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: false });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [scopedItems, onPendingChange]);

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

  const answerQuestion = useCallback(
    (reqId: string, answers: AgentQuestionAnswer[], cancelled = false) => {
      void Haptics.notificationAsync(
        cancelled
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Success,
      );
      conn.respondQuestion(sid, reqId, answers, cancelled);
    },
    [conn, sid],
  );

  const retry = useCallback(() => {
    // 找最后一条用户消息重发
    for (let i = scopedItems.length - 1; i >= 0; i--) {
      const it = scopedItems[i]!;
      if (it.type === "user") {
        onRetry?.(it.text);
        return;
      }
    }
  }, [scopedItems, onRetry]);

  const visible = useMemo(() => {
    const q = search?.trim().toLowerCase() ?? "";
    if (q.length > 0) {
      // 搜索结果逐条展开，否则命中项可能藏在活动组里。
      return scopedItems.filter((i) => itemText(i).toLowerCase().includes(q));
    }
    return foldChatItems(scopedItems);
  }, [scopedItems, search]);

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
        ListEmptyComponent={workingStatus ? null : (
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
        )}
        ListFooterComponent={
          agent && workingStatus ? (
            <AgentWorkingIndicator
              agent={agent}
              status={workingStatus}
              onInterrupt={onInterrupt}
            />
          ) : null
        }
        renderItem={({ item }) => {
          switch (item.type) {
            case "user":
              return <UserBubble item={item} />;
            case "assistant":
              return (
                <AssistantBubble
                  item={item}
                  projectRoot={projectRoot}
                  onOpenFile={onOpenFile}
                  loadProjectImage={loadProjectImage}
                />
              );
            case "tool":
              return <ToolCard item={item} onFetchOutput={fetchOutput} />;
            case "permission":
              return <PermissionCard item={item} onRespond={respond} />;
            case "question":
              return <QuestionCard item={item} onRespond={answerQuestion} />;
            case "subagent":
              return <SubagentCard item={item} onOpen={onOpenSubagent} />;
            case "error":
              return <ErrorCard item={item} onRetry={onRetry ? retry : undefined} />;
            case "turn-diff-summary":
              return (
                <TurnDiffSummaryBar
                  item={item}
                  projectRoot={projectRoot}
                  onOpenFile={onOpenFile}
                />
              );
            case "activity-group":
              return (
                <ActivityGroup
                  item={item}
                  onFetchOutput={fetchOutput}
                  onRespond={respond}
                />
              );
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

const agentLabel: Record<AgentKind, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok",
  trae: "Trae",
  shell: "Shell",
  custom: "Agent",
};

function AgentWorkingIndicator({
  agent,
  status,
  onInterrupt,
}: {
  agent: AgentKind;
  status: SessionStatus | SubagentStatus;
  onInterrupt?: () => void;
}) {
  const waiting = status === "waiting_approval" || status === "waiting_input";
  const label = waiting
    ? status === "waiting_input"
      ? `${agentLabel[agent]} 等待你的回答`
      : `${agentLabel[agent]} 等待你的批准`
    : status === "starting"
      ? `正在启动 ${agentLabel[agent]}`
      : `${agentLabel[agent]} 正在工作`;
  return (
    <View
      style={styles.agentWorking}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
    >
      <AgentIcon agent={agent} size={14} badge />
      {!waiting && <ActivityIndicator size="small" color={agentTint(agent)} />}
      <Text style={[styles.agentWorkingText, { color: waiting ? color.warn : agentTint(agent) }]}>
        {label}
      </Text>
      <Text style={styles.agentWorkingHint} numberOfLines={1}>
        {waiting ? "处理后自动继续" : "可继续排队或引导"}
      </Text>
      {onInterrupt && (
        <Pressable
          style={({ pressed }) => [styles.agentStop, pressed && styles.agentStopPressed]}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            onInterrupt();
          }}
          accessibilityRole="button"
          accessibilityLabel={`停止 ${agentLabel[agent]} 当前任务`}
        >
          <Icon name="stop.circle" size={13} color={color.danger} />
          <Text style={styles.agentStopText}>停止</Text>
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
    case "question":
      return i.questions.map((question) => question.question).join(" ");
    case "subagent":
      return `${i.subagent.name} ${i.subagent.role ?? ""} ${i.subagent.task ?? ""} ${i.subagent.preview ?? ""}`;
    case "error":
      return i.message;
    case "turn-diff-summary":
      return i.files.map((file) => file.path).join(" ");
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
  return (
    <View style={styles.userRow}>
      <View style={styles.userBubble}>
        <Text style={styles.userText} selectable>
          {item.text}
        </Text>
      </View>
    </View>
  );
});

/**
 * memo 化:流式输出时列表每收到一个 delta 就重渲染,
 * 不做记忆化的话历史消息(可能上百条)会跟着一起重算。
 */
const AssistantBubble = memo(function AssistantBubble({
  item,
  projectRoot,
  onOpenFile,
  loadProjectImage,
}: {
  item: AssistantItem;
  projectRoot?: string;
  onOpenFile?: (reference: ProjectFileReference) => void;
  loadProjectImage: ProjectImageLoader;
}) {
  const [showReasoning, setShowReasoning] = useState(false);
  const copy = useCopy();
  const cost = item.finish?.costUsd;
  const out = item.finish?.outputTokens;
  return (
    <View style={styles.assistantRow}>
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
      {showReasoning && <Text style={styles.reasoningText} selectable>{item.reasoning}</Text>}
      {item.text.length > 0 && (
        <Markdown
          source={item.text}
          projectRoot={projectRoot}
          onOpenFile={onOpenFile}
          loadProjectImage={loadProjectImage}
        />
      )}
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
      {item.text.length > 0 && (
        <Pressable
          style={({ pressed }) => [styles.copyReply, pressed && styles.inlinePressed]}
          onPress={() => copy(item.text, "回复")}
          accessibilityRole="button"
          accessibilityLabel="复制完整回复"
        >
          <Icon name="doc.on.doc" size={11} color={color.textFaint} />
          <Text style={styles.copyReplyText}>复制全文</Text>
        </Pressable>
      )}
    </View>
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

const TurnDiffSummaryBar = memo(function TurnDiffSummaryBar({
  item,
  projectRoot,
  onOpenFile,
}: {
  item: TurnDiffSummaryItem;
  projectRoot?: string;
  onOpenFile?: (reference: ProjectFileReference) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const files = useMemo(
    () =>
      item.files.map((file) => ({
        ...file,
        reference: projectRoot
          ? resolveProjectFileReference(file.path, projectRoot, true)
          : null,
      })),
    [item.files, projectRoot],
  );
  return (
    <View style={styles.diffSummary}>
      <Pressable
        style={({ pressed }) => [styles.diffSummaryHeader, pressed && styles.inlinePressed]}
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`本轮改动 ${String(files.length)} 个文件，新增 ${String(item.additions)} 行，删除 ${String(item.deletions)} 行`}
      >
        <View style={styles.diffSummaryIcon}>
          <Icon name="doc.on.doc" size={13} color={color.success} />
        </View>
        <Text style={styles.diffSummaryTitle}>本轮改动</Text>
        <Text style={styles.diffSummaryFiles}>{String(files.length)} 个文件</Text>
        <Text style={styles.diffSummaryAdd}>+{String(item.additions)}</Text>
        <Text style={styles.diffSummaryDelete}>−{String(item.deletions)}</Text>
        <Icon
          name={expanded ? "chevron.down" : "chevron.right"}
          size={11}
          color={color.textFaint}
        />
      </Pressable>
      {expanded && (
        <View style={styles.diffSummaryList}>
          {files.slice(0, 12).map((file) => {
            const displayPath = file.reference?.path ?? file.path;
            return (
              <Pressable
                key={file.path}
                style={({ pressed }) => [
                  styles.diffSummaryRow,
                  pressed && file.reference !== null && styles.inlinePressed,
                ]}
                disabled={!file.reference || !onOpenFile}
                onPress={() => {
                  if (file.reference) onOpenFile?.(file.reference);
                }}
                accessibilityRole={file.reference ? "link" : undefined}
                accessibilityLabel={`预览 ${displayPath}`}
              >
                <Text style={styles.diffSummaryPath} numberOfLines={1} ellipsizeMode="middle">
                  {displayPath}
                </Text>
                <Text style={styles.diffSummaryMiniAdd}>+{String(file.additions)}</Text>
                <Text style={styles.diffSummaryMiniDelete}>−{String(file.deletions)}</Text>
                {file.reference && <Icon name="chevron.right" size={10} color={color.textFaint} />}
              </Pressable>
            );
          })}
          {files.length > 12 && (
            <Text style={styles.diffSummaryMore}>另有 {String(files.length - 12)} 个文件</Text>
          )}
        </View>
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

const QuestionCard = memo(function QuestionCard({
  item,
  onRespond,
}: {
  item: QuestionItem;
  onRespond: (reqId: string, answers: AgentQuestionAnswer[], cancelled?: boolean) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const resolved = item.answers !== undefined || item.cancelled === true;
  const answers = item.questions.map((question): AgentQuestionAnswer => {
    const values = [...(selected[question.id] ?? [])];
    const custom = other[question.id]?.trim();
    if (custom) values.push(custom);
    return { questionId: question.id, values };
  });
  const ready = answers.every((answer) => answer.values.length > 0);

  const toggle = (questionId: string, label: string, multi: boolean): void => {
    setSelected((previous) => {
      const values = previous[questionId] ?? [];
      return {
        ...previous,
        [questionId]: multi
          ? values.includes(label)
            ? values.filter((value) => value !== label)
            : [...values, label]
          : [label],
      };
    });
  };

  return (
    <View style={[styles.questionCard, resolved && styles.questionResolved]}>
      <View style={styles.questionHeader}>
        <Icon name="bubble.left.and.text.bubble.right" size={17} color={color.accent} />
        <View style={styles.questionHeaderCopy}>
          <Text style={styles.questionKicker}>Agent 需要你的回答</Text>
          <Text style={styles.questionHint}>回答后会自动继续当前任务</Text>
        </View>
      </View>
      {item.questions.map((question) => {
        const resolvedAnswer = item.answers?.find((answer) => answer.questionId === question.id);
        return (
          <View key={question.id} style={styles.questionBlock}>
            {question.header.length > 0 && <Text style={styles.questionTag}>{question.header}</Text>}
            <Text style={styles.questionText}>{question.question}</Text>
            {resolved ? (
              <Text style={styles.questionAnswer} selectable>
                {item.cancelled
                  ? "已取消"
                  : resolvedAnswer?.values.join("、") || "已回答"}
              </Text>
            ) : (
              <>
                <View style={styles.questionOptions}>
                  {question.options.map((option) => {
                    const active = (selected[question.id] ?? []).includes(option.label);
                    return (
                      <Pressable
                        key={option.label}
                        style={({ pressed }) => [
                          styles.questionOption,
                          active && styles.questionOptionActive,
                          pressed && styles.inlinePressed,
                        ]}
                        onPress={() => toggle(question.id, option.label, question.multiSelect)}
                        accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                        accessibilityState={{ checked: active }}
                      >
                        <View style={[styles.questionChoice, active && styles.questionChoiceActive]} />
                        <View style={styles.questionOptionCopy}>
                          <Text style={[styles.questionOptionLabel, active && styles.questionOptionLabelActive]}>
                            {option.label}
                          </Text>
                          {option.description && (
                            <Text style={styles.questionOptionDescription}>{option.description}</Text>
                          )}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
                {question.allowOther && (
                  <TextInput
                    style={styles.questionInput}
                    value={other[question.id] ?? ""}
                    onChangeText={(value) =>
                      setOther((previous) => ({ ...previous, [question.id]: value }))
                    }
                    placeholder="其他答案…"
                    placeholderTextColor={color.textFaint}
                    secureTextEntry={question.secret === true}
                    multiline={!question.secret}
                  />
                )}
              </>
            )}
          </View>
        );
      })}
      {!resolved && (
        <View style={styles.questionActions}>
          <Pressable
            style={({ pressed }) => [styles.questionCancel, pressed && styles.inlinePressed]}
            onPress={() => onRespond(item.reqId, [], true)}
          >
            <Text style={styles.questionCancelText}>取消</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.questionSubmit,
              !ready && styles.questionSubmitDisabled,
              pressed && ready && styles.inlinePressed,
            ]}
            disabled={!ready}
            onPress={() => onRespond(item.reqId, answers)}
          >
            <Text style={styles.questionSubmitText}>提交回答</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
});

const subagentStateLabel: Record<SubagentStatus, string> = {
  starting: "启动中",
  running: "工作中",
  waiting_input: "等待回答",
  idle: "可对话",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

const SubagentCard = memo(function SubagentCard({
  item,
  onOpen,
}: {
  item: SubagentItem;
  onOpen?: (subagentId: string) => void;
}) {
  const subagent = item.subagent;
  const active = subagent.status === "running" || subagent.status === "starting";
  return (
    <Pressable
      style={({ pressed }) => [styles.subagentCard, pressed && styles.inlinePressed]}
      onPress={() => onOpen?.(subagent.id)}
      disabled={!onOpen}
      accessibilityRole="button"
      accessibilityLabel={`查看子 Agent ${subagent.name}`}
    >
      <View style={[styles.subagentDot, { backgroundColor: active ? color.accent : color.textFaint }]} />
      <View style={styles.subagentCopy}>
        <View style={styles.subagentTitleRow}>
          <Text style={styles.subagentName} numberOfLines={1}>{subagent.name}</Text>
          <Text style={[styles.subagentState, active && styles.subagentStateActive]}>
            {subagentStateLabel[subagent.status]}
          </Text>
        </View>
        {(subagent.preview || subagent.task) && (
          <Text style={styles.subagentPreview} numberOfLines={2}>
            {subagent.preview || subagent.task}
          </Text>
        )}
      </View>
      <Icon name="chevron.right" size={12} color={color.textFaint} />
    </Pressable>
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

const ActivityGroup = memo(function ActivityGroup({
  item,
  onFetchOutput,
  onRespond,
}: {
  item: Extract<ChatDisplayItem, { type: "activity-group" }>;
  onFetchOutput: (callId: string) => void;
  onRespond: (reqId: string, reply: PermissionReply) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tools = item.items.filter((entry): entry is ToolItem => entry.type === "tool");
  const approvals = item.items.length - tools.length;
  const names = [...new Set(tools.map((entry) => entry.tool))].slice(0, 3);
  const additions = item.items.reduce((sum, entry) => sum + (entry.diff?.additions ?? 0), 0);
  const deletions = item.items.reduce((sum, entry) => sum + (entry.diff?.deletions ?? 0), 0);
  const details = [
    names.join(" · "),
    approvals > 0 ? `${String(approvals)} 次自动/已审批` : "",
  ].filter(Boolean).join(" · ");

  const renderActivity = (entry: FoldableActivityItem): React.ReactElement =>
    entry.type === "tool" ? (
      <ToolCard key={entry.key} item={entry} onFetchOutput={onFetchOutput} />
    ) : (
      <PermissionCard key={entry.key} item={entry} onRespond={onRespond} />
    );

  return (
    <View style={styles.activityGroup}>
      <Pressable
        style={({ pressed }) => [styles.activityHeader, pressed && styles.inlinePressed]}
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${expanded ? "收起" : "展开"}${String(item.items.length)} 项操作`}
      >
        <View style={styles.activityIcon}>
          <Icon name="terminal" size={13} color={color.textDim} />
        </View>
        <View style={styles.activityCopy}>
          <Text style={styles.activityTitle}>已完成 {String(item.items.length)} 项操作</Text>
          {details.length > 0 && <Text style={styles.activityDetail} numberOfLines={1}>{details}</Text>}
        </View>
        {(additions > 0 || deletions > 0) && (
          <Text style={styles.activityDiff}>+{String(additions)} −{String(deletions)}</Text>
        )}
        <Icon
          name={expanded ? "chevron.down" : "chevron.right"}
          size={12}
          color={color.textFaint}
        />
      </Pressable>
      {expanded && <View style={styles.activityItems}>{item.items.map(renderActivity)}</View>}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1, backgroundColor: color.bg },
  content: {
    flexGrow: 1,
    width: "100%",
    maxWidth: 920,
    alignSelf: "center",
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

  agentWorking: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 2,
    paddingTop: 10,
  },
  agentWorkingText: { fontSize: 12.5, fontWeight: "600" },
  agentWorkingHint: { flex: 1, color: color.textFaint, fontSize: 10.5, textAlign: "right" },
  agentStop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderRadius: 7,
    backgroundColor: color.dangerBg,
  },
  agentStopPressed: { opacity: 0.68 },
  agentStopText: { color: color.danger, fontSize: 10, fontWeight: "600" },

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
  copyReply: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 3,
    paddingRight: 6,
  },
  copyReplyText: { color: color.textFaint, fontSize: 10.5 },

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

  diffSummary: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#254333",
    overflow: "hidden",
  },
  diffSummaryHeader: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  diffSummaryIcon: {
    width: 25,
    height: 25,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    backgroundColor: color.successBg,
  },
  diffSummaryTitle: { color: color.text, fontSize: 12.5, fontWeight: "600" },
  diffSummaryFiles: { flex: 1, color: color.textDim, fontSize: 10.5 },
  diffSummaryAdd: { color: color.success, fontSize: 11, fontVariant: ["tabular-nums"] },
  diffSummaryDelete: { color: color.danger, fontSize: 11, fontVariant: ["tabular-nums"] },
  diffSummaryList: {
    paddingHorizontal: 9,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  diffSummaryRow: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  diffSummaryPath: {
    flex: 1,
    color: color.accent,
    fontSize: 10.5,
    fontFamily: MONOSPACE_FONT,
  },
  diffSummaryMiniAdd: { color: color.success, fontSize: 9.5 },
  diffSummaryMiniDelete: { color: color.danger, fontSize: 9.5 },
  diffSummaryMore: { color: color.textFaint, fontSize: 10, textAlign: "center", paddingTop: 7 },

  activityGroup: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    overflow: "hidden",
  },
  activityHeader: {
    minHeight: 54,
    paddingHorizontal: 11,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  activityIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: color.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  activityCopy: { flex: 1, gap: 2 },
  activityTitle: { color: color.text, fontSize: 13, fontWeight: "600" },
  activityDetail: { color: color.textFaint, fontSize: 11 },
  activityDiff: { color: color.success, fontSize: 11, fontVariant: ["tabular-nums"] },
  activityItems: {
    gap: 10,
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    paddingTop: 10,
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

  questionCard: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.accentDim,
    padding: 13,
    gap: 12,
  },
  questionResolved: { opacity: 0.68, borderColor: color.border },
  questionHeader: { flexDirection: "row", alignItems: "center", gap: 9 },
  questionHeaderCopy: { flex: 1, gap: 1 },
  questionKicker: { color: color.accent, fontSize: 11, fontWeight: "700" },
  questionHint: { color: color.textFaint, fontSize: 10 },
  questionBlock: { gap: 8 },
  questionTag: { color: color.textDim, fontSize: 10, fontWeight: "600" },
  questionText: { color: color.text, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  questionOptions: { gap: 7 },
  questionOption: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: 9,
    padding: 9,
  },
  questionOptionActive: { borderColor: color.accent, backgroundColor: "#172035" },
  questionChoice: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1,
    borderColor: color.textFaint,
    marginTop: 2,
  },
  questionChoiceActive: { borderWidth: 4, borderColor: color.accent },
  questionOptionCopy: { flex: 1, gap: 2 },
  questionOptionLabel: { color: color.text, fontSize: 12.5, fontWeight: "500" },
  questionOptionLabelActive: { color: "#DCE6FF" },
  questionOptionDescription: { color: color.textDim, fontSize: 11, lineHeight: 16 },
  questionInput: {
    minHeight: 38,
    maxHeight: 100,
    color: color.text,
    backgroundColor: color.bg,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 12.5,
  },
  questionAnswer: {
    color: color.success,
    backgroundColor: color.successBg,
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 7,
    fontSize: 12,
  },
  questionActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  questionCancel: { paddingHorizontal: 13, paddingVertical: 9 },
  questionCancelText: { color: color.textDim, fontSize: 12, fontWeight: "600" },
  questionSubmit: {
    backgroundColor: color.accentDim,
    borderRadius: 9,
    paddingHorizontal: 15,
    paddingVertical: 9,
  },
  questionSubmitDisabled: { opacity: 0.38 },
  questionSubmitText: { color: "#fff", fontSize: 12, fontWeight: "700" },

  subagentCard: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  subagentDot: { width: 8, height: 8, borderRadius: 4 },
  subagentCopy: { flex: 1, gap: 4 },
  subagentTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  subagentName: { flex: 1, color: color.text, fontSize: 13, fontWeight: "600" },
  subagentState: { color: color.textFaint, fontSize: 10 },
  subagentStateActive: { color: color.accent },
  subagentPreview: { color: color.textDim, fontSize: 11, lineHeight: 16 },

  errorCard: { backgroundColor: color.dangerBg, borderRadius: radius.md, padding: 11, gap: 7 },
  errorText: { color: "#F2AAAA", fontSize: 13, lineHeight: 19 },
  retryBtn: { alignSelf: "flex-start" },
  retryText: { color: color.accent, fontSize: 12, fontWeight: "600" },
});
