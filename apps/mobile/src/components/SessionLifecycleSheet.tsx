import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import type { ResumableConversation, SessionInfo } from "@prospero/protocol";
import type { HostConnection } from "@/lib/connection";
import { Sheet } from "./Sheet";
import { useMobileTheme } from "@/lib/theme";

export function SessionLifecycleSheet({ conn, session, archived, onClose, onDone }: { conn: HostConnection; session: SessionInfo; archived: boolean; onClose(): void; onDone(session: SessionInfo): void }) {
  const { palette } = useMobileTheme();
  const binding = session.kind === "pty" && ["claude", "codex"].includes(session.agent) && !session.nativeSession?.managed && !session.nativeSession?.nativeId;
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ResumableConversation[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!binding) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true); setError(undefined); setSelected(undefined);
      void conn.nativeConversationCandidates(session.id, query).then(rows => { if (!cancelled) setItems(rows); })
        .catch(error => { if (!cancelled) setError(String(error instanceof Error ? error.message : error)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [binding, conn, query, session.id]);
  return <Sheet visible title={binding ? "绑定原生对话" : archived ? "归档会话" : "继续对话"} onClose={() => { if (!busy) onClose(); }}>
    <Text style={{ color: palette.textDim, lineHeight: 22, marginBottom: 12 }}>{binding
      ? "请选择这个终端正在使用的原生对话。确认后将保存对话 ID，供以后准确恢复。"
      : archived ? (session.kind === "structured" || ["claude", "codex"].includes(session.agent) ? "停止当前执行并释放运行资源，保留历史、工作目录和文件改动。以后可以继续原对话。" : "结束终端并保留历史。任意 Shell 程序无法恢复其进程状态，可以另建终端继续工作。")
        : "使用原来的原生对话 ID 恢复上下文。不会自动重发上次中断的指令。"}</Text>
    {binding && <>
      <TextInput accessibilityLabel="搜索原生对话" value={query} onChangeText={setQuery} editable={!busy}
        placeholder="搜索标题或粘贴原生对话 ID" placeholderTextColor={palette.textFaint}
        style={{ color: palette.text, minHeight: 48, padding: 10, borderWidth: 1, borderColor: palette.border, borderRadius: 10 }} />
      {items.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ checked: selected === item.id, disabled: busy }} disabled={busy}
        onPress={() => setSelected(item.id)} style={{ padding: 12, marginTop: 8, borderRadius: 10, backgroundColor: selected === item.id ? palette.accentBg : palette.surface }}>
        <Text style={{ color: palette.text }}>{item.title}</Text><Text style={{ color: palette.textFaint, fontSize: 11 }}>{item.id}</Text>
        {item.preview && <Text numberOfLines={2} style={{ color: palette.textDim, marginTop: 4 }}>{item.preview}</Text>}
      </Pressable>)}
      {!loading && !items.length && <Text style={{ color: palette.textFaint, marginTop: 10 }}>没有匹配的对话，可粘贴原生对话 ID 查询。</Text>}
    </>}
    {loading && <ActivityIndicator style={{ margin: 12 }} color={palette.accent} />}
    {error && <Text accessibilityRole="alert" style={{ color: palette.warn, marginVertical: 12 }}>{error}</Text>}
    <Pressable accessibilityRole="button" disabled={busy || loading || (binding && !selected)}
      style={{ minHeight: 48, padding: 12, marginTop: 12, borderRadius: 10, backgroundColor: palette.accentBg, opacity: busy || loading || (binding && !selected) ? 0.5 : 1 }}
      onPress={() => {
        setBusy(true); setError(undefined);
        void conn.setSessionArchived(session.id, archived, selected).then(onDone)
          .catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setBusy(false));
      }}><View style={{ flexDirection: "row", gap: 8, justifyContent: "center", alignItems: "center" }}>
        {busy && <ActivityIndicator color={palette.accent} />}<Text style={{ color: palette.accent, fontWeight: "600" }}>{busy ? "正在处理…" : archived ? "停止并归档" : "继续对话"}</Text>
      </View></Pressable>
  </Sheet>;
}
