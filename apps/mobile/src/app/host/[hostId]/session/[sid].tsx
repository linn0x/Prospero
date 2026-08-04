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
import { Stack, router, useLocalSearchParams } from "expo-router";
import type { SessionInfo } from "@prospero/protocol";
import { ChatView } from "@/components/ChatView";
import { KeyBar } from "@/components/KeyBar";
import { QuickReplies } from "@/components/QuickReplies";
import { Terminal } from "@/components/Terminal";
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

  const session = sid ? runtime.sessions[sid] : undefined;
  const isStructured = session?.kind === "structured";
  const isChat = isStructured && !showTty;
  const busy = session?.status === "running" || session?.status === "starting";
  const elapsed = useElapsed(busy || session?.status === "waiting_approval" ? session?.busySince : undefined);

  const send = useCallback(
    (text: string): void => {
      const t = text.trim();
      if (!conn || !sid || t.length === 0) return;
      if (isStructured) conn.chatSend(sid, t);
      else conn.inputText(sid, t + "\r");
      setDraft("");
    },
    [conn, sid, isStructured],
  );

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

  const subtitle = session
    ? `${session.agent} · ${statusText[session.status]}${elapsed ? ` · ${elapsed}` : ""}${
        pending > 0 ? ` · ${String(pending)} 项待批` : ""
      }`
    : "";

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
              {isStructured && (
                <Pressable onPress={() => setShowTty((v) => !v)} hitSlop={8}>
                  <Text style={[styles.ttyBtn, showTty && styles.ttyBtnActive]}>
                    {showTty ? "对话" : "TTY"}
                  </Text>
                </Pressable>
              )}
              {busy && (
                <Pressable onPress={() => conn.interrupt(sid)} hitSlop={8}>
                  <Text style={styles.stopText}>停止</Text>
                </Pressable>
              )}
              <Pressable onPress={confirmKill} hitSlop={8}>
                <Text style={styles.killText}>终止</Text>
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

      {isChat ? (
        <ChatView conn={conn} sid={sid} onPendingChange={setPending} />
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

      {isChat && <QuickReplies busy={busy} onPick={send} />}

      <View style={styles.composer}>
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
          style={[styles.sendBtn, draft.trim().length === 0 && styles.sendBtnDim]}
          onPress={() => send(draft)}
        >
          <Text style={styles.sendText}>↑</Text>
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
