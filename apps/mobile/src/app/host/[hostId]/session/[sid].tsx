import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SessionInfo } from "@prospero/protocol";
import { ChatView } from "@/components/ChatView";
import { Icon } from "@/components/Icon";
import { KeyBar } from "@/components/KeyBar";
import { QuickReplies } from "@/components/QuickReplies";
import { Terminal } from "@/components/Terminal";
import { VoiceButton } from "@/components/VoiceButton";
import { matchCommands } from "@/lib/slash-commands";
import { MONOSPACE_FONT } from "@/lib/theme";
import { useHostConnection } from "@/lib/use-host-connection";
import { appendVoiceTranscript } from "@/lib/voice-input";

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
  const insets = useSafeAreaInsets();
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
  const elapsed = useElapsed(busy || session?.status === "waiting_approval" ? session?.busySince : undefined);

  const send = useCallback(
    (text: string): void => {
      const t = text.trim();
      if (!conn || !sid || t.length === 0) return;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (isStructured) conn.chatSend(sid, t);
      else conn.inputText(sid, t + "\r");
      setDraft("");
    },
    [conn, sid, isStructured],
  );

  const appendTranscript = useCallback((text: string): void => {
    // 使用函数式更新，转写期间用户新打的字也不会被旧闭包覆盖。
    setDraft((current) => appendVoiceTranscript(current, text));
  }, []);

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

  const totals = session?.totals;
  const subtitle = session
    ? `${session.agent} · ${statusText[session.status]}${elapsed ? ` · ${elapsed}` : ""}${
        pending > 0 ? ` · ${String(pending)} 项待批` : ""
      }${
        totals && totals.costUsd > 0 ? ` · 共 $${totals.costUsd.toFixed(3)}` : ""
      }`
    : "";

  // 输入以 / 开头时给命令候选
  const commandHints =
    isChat && session ? matchCommands(session.agent, draft.trim()) : [];

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
          <Terminal conn={conn} sid={sid} />
          {!isStructured && <KeyBar onKey={(seq) => conn.inputText(sid, seq)} />}
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

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
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
        {isChat && <VoiceButton onTranscript={appendTranscript} />}
        <Pressable
          style={[styles.sendBtn, draft.trim().length === 0 && styles.sendBtnDim]}
          onPress={() => send(draft)}
          disabled={draft.trim().length === 0}
        >
          <Icon name="arrow.up" size={17} color="#fff" weight="semibold" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0e" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  dim: { color: "#5a5a66" },
  headerTitle: { alignItems: "center", maxWidth: 220 },
  headerName: { color: "#e8e8ee", fontSize: 16, fontWeight: "600" },
  headerSub: { color: "#7a7a86", fontSize: 11, marginTop: 1 },
  headerRight: { flexDirection: "row", gap: 12, alignItems: "center" },
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
  cmdName: { color: "#7aa2f7", fontSize: 14, fontFamily: MONOSPACE_FONT },
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
