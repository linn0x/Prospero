import { useState } from "react";
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
import { ChatView } from "@/components/ChatView";
import { KeyBar } from "@/components/KeyBar";
import { Terminal } from "@/components/Terminal";
import { useHostConnection } from "@/lib/use-host-connection";

export default function SessionScreen() {
  const { hostId, sid } = useLocalSearchParams<{ hostId: string; sid: string }>();
  const { conn, runtime } = useHostConnection(hostId);
  const [draft, setDraft] = useState("");
  const session = sid ? runtime.sessions[sid] : undefined;
  const isChat = session?.kind === "structured";

  const sendDraft = (): void => {
    if (!conn || !sid || draft.trim().length === 0) return;
    if (isChat) conn.chatSend(sid, draft.trim());
    else conn.inputText(sid, draft + "\r");
    setDraft("");
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

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <Stack.Screen
        options={{
          title: session?.title ?? "会话",
          headerRight: () => (
            <View style={styles.headerRight}>
              {isChat && session?.status === "running" && (
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
        <ChatView conn={conn} sid={sid} />
      ) : (
        <>
          <Terminal conn={conn} sid={sid} />
          <KeyBar onKey={(seq) => conn.inputText(sid, seq)} />
        </>
      )}

      <View style={styles.composer}>
        <TextInput
          style={[styles.input, isChat && styles.inputChat]}
          placeholder={isChat ? "给 agent 发消息…" : "输入后发送(自动回车)"}
          placeholderTextColor="#5a5a66"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={sendDraft}
          submitBehavior={isChat ? "newline" : "submit"}
          returnKeyType={isChat ? "default" : "send"}
          autoCapitalize="none"
          autoCorrect={false}
          multiline={isChat}
        />
        <Pressable style={styles.sendBtn} onPress={sendDraft}>
          <Text style={styles.sendText}>发送</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0e" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  dim: { color: "#5a5a66" },
  headerRight: { flexDirection: "row", gap: 14, alignItems: "center" },
  stopText: { color: "#d9a441", fontSize: 15 },
  killText: { color: "#e5534b", fontSize: 15 },
  reconnBar: { backgroundColor: "#3a2f1f", paddingHorizontal: 12, paddingVertical: 6 },
  reconnText: { color: "#e8c98a", fontSize: 12 },
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
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#e8e8ee",
    fontSize: 14,
  },
  inputChat: { maxHeight: 120, minHeight: 38 },
  sendBtn: {
    backgroundColor: "#3557b7",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendText: { color: "#fff", fontWeight: "600" },
});
