import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/Sheet";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { PendingSessionCreation } from "@/lib/host-screen-flow";
import { SessionCreateError } from "@/lib/connection";
import { useHostConnection } from "@/lib/use-host-connection";
import { sortSessions } from "@/lib/store";
import { useMobileTheme, type ThemePalette } from "@/lib/theme";
import { isTerminalEnded, supportsMacTerminal, MAC_TERMINAL_ONLY } from "@/lib/terminal-session";
import { useTerminalClose } from "@/lib/use-terminal-close";
import { useTerminalActions } from "@/lib/use-terminal-actions";

export default function TerminalsScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const { host, conn, runtime } = useHostConnection(hostId);
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
  const [cwd, setCwd] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const terminalClose = useTerminalClose(conn, closeTarget ?? "");
  const terminalActions = useTerminalActions(conn);
  const [pending] = useState(() => new PendingSessionCreation());
  const supported = supportsMacTerminal(runtime.hostInfo);
  const connected = runtime.status === "connected" && conn?.host.id === hostId;
  const working = creating || terminalActions.busy !== null;
  const sessions = useMemo(() => sortSessions(runtime.sessions).filter((session) => session.agent === "shell" && session.kind === "pty"), [runtime.sessions]);
  useFocusEffect(useCallback(() => {
    setCreating(false);
    return () => { pending.cancel(); };
  }, [pending]));
  const create = (): void => {
    if (!conn || !connected || !supported || pending.pending || working) return;
    setError(null); setCreating(true);
    // A tracked create is never queued or retried across reconnects. Returning to
    // the list reuses the existing PTY instead of starting a duplicate shell.
    pending.track(conn.createSessionTracked("shell", cwd.trim() || undefined, undefined, "pty"),
      (session) => { setCreating(false); router.push(`/host/${hostId}/session/${session.id}`); },
      (failure) => {
        setCreating(false);
        setError(failure instanceof SessionCreateError && failure.reason === "shell_not_allowed"
          ? "此设备尚未获得终端权限，请在电脑端为该设备允许 Shell 后重试。"
          : failure instanceof Error ? failure.message : "创建终端失败，请重试。");
      });
  };
  if (!supported) return <View style={styles.screen}>
    <Stack.Screen options={{ title: "远程终端" }} />
    <View style={styles.content}>
      <Text style={styles.label}>{runtime.hostInfo ? MAC_TERMINAL_ONLY : "正在确认设备类型…"}</Text>
      <Text style={styles.detail}>连接 Mac 后可新建和管理终端。</Text>
      {!connected && <Pressable onPress={() => conn?.kick()} style={styles.smallButton} accessibilityRole="button">
        <Text style={styles.link}>重连设备</Text>
      </Pressable>}
    </View>
  </View>;
  return <View style={styles.screen}>
    <Stack.Screen options={{ title: `${host?.name ?? "设备"} · 终端`, headerBackButtonDisplayMode: "minimal" }} />
    <FlatList data={sessions} keyExtractor={(session) => session.id} keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      ListHeaderComponent={<View style={styles.header}>
        <Text style={styles.detail}>使用 Mac 的登录 Shell。支持 Tab 补全、历史记录和 Ctrl / Option 组合键；返回会保留终端，关闭会结束终端进程。</Text>
        {!connected && <View style={styles.connection}>
          <Text style={[styles.detail, { flex: 1 }]}>{runtime.lastError ?? "正在连接设备，连接后可新建终端。"}</Text>
          <Pressable accessibilityRole="button" onPress={() => conn?.kick()} style={styles.smallButton}><Text style={styles.link}>重连</Text></Pressable>
        </View>}
        <View style={styles.card}>
          <Text style={styles.label}>起始目录</Text>
          <View style={styles.pathRow}>
            <TextInput style={styles.input} value={cwd} onChangeText={setCwd} autoCapitalize="none" autoCorrect={false}
              editable={!working} placeholder="留空使用电脑的用户主目录" placeholderTextColor={palette.textFaint}
              accessibilityLabel="终端起始目录" />
            <Pressable disabled={!connected || working} accessibilityRole="button" accessibilityLabel="选择终端起始目录"
              onPress={() => setPickerOpen(true)} style={styles.smallButton}>
              <Icon name="folder.fill" size={20} color={connected && !creating ? palette.accent : palette.textFaint} />
            </Pressable>
          </View>
          <Pressable disabled={!connected || working} onPress={create} accessibilityRole="button" accessibilityLabel="新建终端"
            accessibilityState={{ disabled: !connected || working }}
            style={({ pressed }) => [styles.create, (!connected || working) && styles.disabled, pressed && styles.pressed]}>
            {creating ? <ActivityIndicator color={palette.accent} /> : <Icon name="plus" size={18} color={palette.accent} />}
            <Text style={styles.link}>{creating ? "正在创建终端…" : "新建终端"}</Text>
          </Pressable>
        </View>
        {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {terminalActions.error && <Text accessibilityRole="alert" style={styles.error}>{terminalActions.error}</Text>}
        <Text style={styles.label}>已有终端 · {sessions.length}</Text>
      </View>}
      ListEmptyComponent={<Text style={styles.empty}>{runtime.sessionsLoaded ? "还没有 Shell 终端。新建后可随时从这里返回。" : "正在读取设备上的终端…"}</Text>}
      renderItem={({ item }) => {
        const ended = isTerminalEnded(item);
        return <View style={styles.session}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${item.title || "终端"}，${ended ? "已结束" : "打开终端"}`}
          onPress={() => router.push(`/host/${hostId}/session/${item.id}`)} style={({ pressed }) => [styles.openSession, pressed && styles.pressed]}>
          <Icon name="terminal" size={22} color={ended ? palette.textFaint : palette.accent} />
          <View style={styles.copy}><Text style={styles.label} numberOfLines={1}>{item.title || "终端"}</Text>
            <Text style={styles.detail} numberOfLines={1} ellipsizeMode="middle">{item.cwd}</Text></View>
          <Text style={styles.detail}>{ended ? "已结束" : "打开"}</Text>
          </Pressable>
          {ended && <>
            <Pressable accessibilityRole="button" accessibilityLabel={`重启终端 ${item.title || item.id}`}
              disabled={!connected || working}
              onPress={() => { void terminalActions.restart(item.id).then((session) => { if (session) router.push(`/host/${hostId}/session/${session.id}`); }); }}
              style={[styles.smallButton, (!connected || working) && styles.disabled]}>
              {terminalActions.busy?.sid === item.id && terminalActions.busy.kind === "restart"
                ? <ActivityIndicator color={palette.accent} /> : <Icon name="arrow.clockwise" size={19} color={palette.accent} />}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`删除终端 ${item.title || item.id}`} disabled={working}
              onPress={() => setDeleteTarget(item.id)} style={[styles.smallButton, working && styles.disabled]}>
              <Icon name="trash" size={19} color={palette.danger} />
            </Pressable>
          </>}
          {!ended && <Pressable accessibilityRole="button" accessibilityLabel={`关闭终端 ${item.title || item.id}`}
            onPress={() => setCloseTarget(item.id)} style={styles.smallButton}>
            <Icon name="xmark" size={18} color={palette.danger} />
          </Pressable>}
        </View>;
      }} />
    {conn && <WorkspacePicker visible={pickerOpen} conn={conn} initialPath="" initialCwd={cwd}
      onClose={() => setPickerOpen(false)} onSelect={(selection) => { setCwd(selection.cwd); setPickerOpen(false); }} />}
    <Sheet visible={closeTarget !== null} title="关闭终端" onClose={() => setCloseTarget(null)}>
      <Text style={styles.detail}>结束此终端及其中运行的命令。</Text>
      {terminalClose.error && <Text accessibilityRole="alert" style={styles.error}>{terminalClose.error}</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="确认关闭终端" disabled={terminalClose.closing}
        onPress={() => { void terminalClose.close().then((closed) => { if (closed) setCloseTarget(null); }); }} style={styles.create}>
        {terminalClose.closing ? <ActivityIndicator color={palette.danger} /> : <Icon name="xmark" size={18} color={palette.danger} />}
        <Text style={[styles.link, { color: palette.danger }]}>{terminalClose.closing ? "正在关闭…" : "关闭终端"}</Text>
      </Pressable>
    </Sheet>
    <Sheet visible={deleteTarget !== null} title="删除终端" onClose={() => setDeleteTarget(null)}>
      <Text style={styles.detail}>删除这个已结束的终端记录，工作目录中的文件会保留。</Text>
      {terminalActions.error && <Text accessibilityRole="alert" style={styles.error}>{terminalActions.error}</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="确认删除终端" disabled={working}
        onPress={() => { if (deleteTarget) void terminalActions.remove(deleteTarget).then((deleted) => { if (deleted) setDeleteTarget(null); }); }} style={styles.create}>
        {terminalActions.busy?.kind === "delete" ? <ActivityIndicator color={palette.danger} /> : <Icon name="trash" size={18} color={palette.danger} />}
        <Text style={[styles.link, { color: palette.danger }]}>{terminalActions.busy?.kind === "delete" ? "正在删除…" : "删除终端"}</Text>
      </Pressable>
    </Sheet>
  </View>;
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: palette.bg },
    content: { padding: 16, gap: 8, width: "100%", maxWidth: 840, alignSelf: "center" },
    header: { gap: 16, marginBottom: 4 }, card: { backgroundColor: palette.surface, borderRadius: 12, padding: 14, gap: 8 },
    label: { color: palette.text, fontSize: 14, fontWeight: "600" }, detail: { color: palette.textFaint, fontSize: 12, lineHeight: 19 },
    input: { flex: 1, minWidth: 0, minHeight: 48, color: palette.text, fontSize: 13 },
    pathRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    smallButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
    create: { minHeight: 48, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: palette.accentBg },
    link: { color: palette.accent, fontSize: 14, fontWeight: "600" }, disabled: { opacity: 0.45 }, pressed: { backgroundColor: palette.pressed },
    error: { color: palette.warn, fontSize: 13, lineHeight: 20 }, empty: { color: palette.textFaint, fontSize: 13, lineHeight: 20, paddingVertical: 24 },
    connection: { flexDirection: "row", gap: 8, alignItems: "center" },
    session: { flexDirection: "row", alignItems: "center", backgroundColor: palette.surface, borderRadius: 10, paddingRight: 6 },
    openSession: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, minHeight: 72, padding: 14, borderRadius: 10 },
    copy: { flex: 1, minWidth: 0, gap: 4 },
  });
}
