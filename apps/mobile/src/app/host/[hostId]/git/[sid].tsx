import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import type { GitFile } from "@prospero/protocol";
import { DismissKey } from "@/components/DismissKey";
import { DiffView } from "@/components/DiffView";
import { Icon } from "@/components/Icon";
import { SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { toast } from "@/components/Toast";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import { useHostConnection } from "@/lib/use-host-connection";

/**
 * 源代码管理面板。
 *
 * 文件面板回答"文件现在长什么样",这里回答"agent 改了什么"——
 * 后者才是盯着 agent 干活时真正要看的。所以列表按【改动】组织,
 * 不是按目录树。
 */
/** 从补丁里数增删行 —— DiffView 头部要显示,填 0 会是错的 */
function countLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

export default function GitScreen(): React.ReactElement {
  const { hostId, sid } = useLocalSearchParams<{ hostId: string; sid: string }>();
  const { conn } = useHostConnection(hostId);
  const insets = useSafeAreaInsets();
  const adaptiveLayout = useAdaptiveLayout();

  const [branch, setBranch] = useState<string | null>(null);
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [files, setFiles] = useState<GitFile[]>([]);
  const [hasStaged, setHasStaged] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notRepo, setNotRepo] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [focused, setFocused] = useState(false);
  const [committing, setCommitting] = useState(false);

  const refresh = useCallback(async () => {
    if (!conn) return;
    setLoading(true);
    try {
      const st = await conn.gitStatus(sid);
      setBranch(st.branch);
      setAhead(st.ahead);
      setBehind(st.behind);
      setFiles(st.files);
      setHasStaged(st.staged);
      setNotRepo(st.branch === null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not a git repository/i.test(msg)) setNotRepo(true);
      else Alert.alert("读取失败", msg);
    } finally {
      setLoading(false);
    }
  }, [conn, sid]);

  useEffect(() => {
    let cancelled = false;
    // refresh 会立即设置 loading；推到 microtask 中可避免 effect 内同步 setState，
    // 同时保证连接变更后不会启动旧请求。
    queueMicrotask(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const openDiff = async (f: GitFile): Promise<void> => {
    if (!conn) return;
    const staged = f.index !== " " && f.index !== "?";
    setOpenPath(f.path);
    setPatch(null);
    try {
      const r = await conn.gitDiff(sid, f.path, staged);
      setPatch(r.patch);
    } catch (e) {
      setPatch("");
      Alert.alert("读取 diff 失败", e instanceof Error ? e.message : String(e));
    }
  };

  const toggleStage = async (f: GitFile): Promise<void> => {
    if (!conn) return;
    const staged = f.index !== " " && f.index !== "?";
    try {
      await conn.gitStage(sid, [f.path], staged);
      void Haptics.selectionAsync();
      void refresh();
    } catch (e) {
      Alert.alert(staged ? "取消暂存失败" : "暂存失败", e instanceof Error ? e.message : String(e));
    }
  };

  const discard = async (f: GitFile): Promise<void> => {
    if (!conn) return;
    try {
      await conn.gitDiscard(sid, f.path);
      toast(`已丢弃 ${f.path.split("/").pop() ?? f.path} 的改动`);
      void refresh();
    } catch (e) {
      Alert.alert("丢弃失败", e instanceof Error ? e.message : String(e));
    }
  };

  const doCommit = async (): Promise<void> => {
    if (!conn || message.trim().length === 0) return;
    setCommitting(true);
    try {
      const r = await conn.gitCommit(sid, message);
      toast(`已提交 ${r.detail ?? ""}`);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMessage("");
      void refresh();
    } catch (e) {
      Alert.alert("提交失败", e instanceof Error ? e.message : String(e));
    } finally {
      setCommitting(false);
    }
  };

  if (notRepo) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: "源代码管理", headerBackTitle: "" }} />
        <Text style={styles.empty}>这个会话的目录不是 git 仓库。</Text>
      </View>
    );
  }

  const staged = files.filter((f) => f.index !== " " && f.index !== "?");
  const unstaged = files.filter((f) => f.index === " " || f.index === "?");
  const splitLayout =
    adaptiveLayout.verticalPanes !== null ||
    (adaptiveLayout.width >= 840 && adaptiveLayout.height >= 480);
  const filePaneWidth =
    adaptiveLayout.verticalPanes?.start ??
    Math.min(380, Math.max(300, adaptiveLayout.width * 0.38));
  const detailPaneWidth =
    adaptiveLayout.verticalPanes?.end ??
    adaptiveLayout.width - filePaneWidth - StyleSheet.hairlineWidth;
  const splitGap =
    adaptiveLayout.verticalPanes?.gap ?? StyleSheet.hairlineWidth;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 88 : 0}
    >
      <Stack.Screen
        options={{
          title: branch ?? "源代码管理",
          headerBackTitle: "",
          headerRight: () => (
            <Pressable onPress={() => void refresh()} hitSlop={8} disabled={loading}>
              <Icon name="arrow.clockwise" size={18} color={loading ? "#3a3a44" : "#7aa2f7"} />
            </Pressable>
          ),
        }}
      />

      <View style={[styles.gitWorkspace, splitLayout && styles.gitWorkspaceSplit]}>
        <View
          style={[
            styles.filePane,
            splitLayout && { flex: 0, width: filePaneWidth },
          ]}
        >
          <View style={styles.branchBar}>
            <Text style={styles.branch} numberOfLines={1}>
              {branch}
            </Text>
            {(ahead > 0 || behind > 0) && (
              <Text style={styles.counts}>
                {ahead > 0 ? `↑${String(ahead)}` : ""}
                {behind > 0 ? ` ↓${String(behind)}` : ""}
              </Text>
            )}
            <Text style={styles.changed}>{files.length} 处改动</Text>
          </View>

          <FlatList
            data={[...staged, ...unstaged]}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            keyExtractor={(f) => f.path}
            contentContainerStyle={{ paddingBottom: insets.bottom + 8 }}
            refreshControl={
              <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor="#7aa2f7" />
            }
            ListEmptyComponent={
              loading ? null : <Text style={styles.empty}>工作区干净,没有改动。</Text>
            }
            renderItem={({ item }) => {
              const isStaged = item.index !== " " && item.index !== "?";
              const actions: SwipeAction[] = [
                {
                  label: isStaged ? "取消暂存" : "暂存",
                  symbol: isStaged ? "arrow.clockwise" : "checkmark.circle.fill",
                  color: isStaged ? "#5a5a66" : "#3a6ea5",
                  onPress: () => void toggleStage(item),
                },
              ];
              // 未跟踪文件没有"改动"可丢弃,git restore 也处理不了它
              if (!item.untracked) {
                actions.push({
                  label: "丢弃",
                  symbol: "trash",
                  color: "#e5534b",
                  onPress: () => void discard(item),
                  confirm: {
                    title: `丢弃「${item.path}」的改动?`,
                    message: "工作区的修改会恢复成上次提交的样子。不可撤销。",
                    confirmLabel: "丢弃",
                  },
                });
              }
              return (
                <SwipeRow actions={actions}>
                  <Pressable
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    onPress={() => void openDiff(item)}
                  >
                    <Text style={[styles.badge, isStaged ? styles.badgeStaged : styles.badgeDirty]}>
                      {item.untracked ? "新" : isStaged ? item.index : item.worktree}
                    </Text>
                    <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
                      {item.path}
                    </Text>
                  </Pressable>
                </SwipeRow>
              );
            }}
          />
        </View>
        {splitLayout && (
          <View
            style={[styles.gitFoldGutter, { width: splitGap }]}
            pointerEvents="none"
          />
        )}
        <View
          style={[
            styles.gitDetailPane,
            splitLayout && { flex: 0, width: detailPaneWidth },
          ]}
        >
          {openPath !== null ? (
            <View style={[styles.diffPane, splitLayout && styles.diffPaneWide]}>
              <View style={styles.diffHead}>
                <Text style={styles.diffTitle} numberOfLines={1}>
                  {openPath}
                </Text>
                <Pressable onPress={() => setOpenPath(null)} hitSlop={8}>
                  <Text style={styles.close}>关闭</Text>
                </Pressable>
              </View>
              {patch === null ? (
                <ActivityIndicator style={styles.diffLoading} color="#7aa2f7" />
              ) : patch.length === 0 ? (
                <Text style={styles.empty}>没有可显示的差异。</Text>
              ) : (
                <DiffView diff={{ path: openPath, patch, ...countLines(patch) }} />
              )}
            </View>
          ) : splitLayout ? (
            <View style={styles.diffPlaceholder}>
              <Icon name="doc.fill" size={28} color="#3a3a44" />
              <Text style={styles.empty}>从左侧选择文件查看改动</Text>
            </View>
          ) : null}

          <View style={styles.commitBar}>
            <DismissKey visible={focused} />
            <TextInput
              style={styles.commitInput}
              value={message}
              onChangeText={setMessage}
              placeholder={hasStaged ? "提交信息" : "先暂存一些改动"}
              placeholderTextColor="#5a5a66"
              editable={hasStaged}
              multiline
              onFocus={() => { setFocused(true); }}
              onBlur={() => { setFocused(false); }}
            />
            <Pressable
              onPress={() => void doCommit()}
              disabled={!hasStaged || message.trim().length === 0 || committing}
              style={[
                styles.commitBtn,
                (!hasStaged || message.trim().length === 0) && styles.commitBtnOff,
              ]}
            >
              {committing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.commitBtnText}>提交</Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b0b0e" },
  gitWorkspace: { flex: 1, minHeight: 0 },
  gitWorkspaceSplit: { flexDirection: "row" },
  filePane: { flex: 1, minHeight: 0 },
  gitDetailPane: { flexShrink: 0, minWidth: 0 },
  gitFoldGutter: {
    flexShrink: 0,
    backgroundColor: "#0b0b0e",
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: "#26262e",
  },
  branchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#26262e",
  },
  branch: { color: "#7aa2f7", fontSize: 14, flexShrink: 1 },
  counts: { color: "#d9a441", fontSize: 12, fontVariant: ["tabular-nums"] },
  changed: { color: "#8a8a96", fontSize: 12, marginLeft: "auto" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1c1c22",
  },
  rowPressed: { backgroundColor: "#16161c" },
  badge: {
    width: 22,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "700",
    borderRadius: 4,
    paddingVertical: 2,
    overflow: "hidden",
  },
  badgeStaged: { color: "#0b0b0e", backgroundColor: "#4dbd74" },
  badgeDirty: { color: "#0b0b0e", backgroundColor: "#d9a441" },
  path: { color: "#e8e8ee", fontSize: 13, flex: 1 },
  empty: { color: "#5a5a66", textAlign: "center", padding: 28, fontSize: 13 },
  diffPane: {
    maxHeight: "50%",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#26262e",
    backgroundColor: "#0e0e13",
  },
  diffPaneWide: { flex: 1, maxHeight: undefined },
  diffPlaceholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  diffHead: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 10,
  },
  diffTitle: { color: "#8a8a96", fontSize: 12, flex: 1 },
  close: { color: "#7aa2f7", fontSize: 13 },
  diffLoading: { paddingVertical: 24 },
  commitBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#26262e",
  },
  commitInput: {
    flex: 1,
    maxHeight: 90,
    backgroundColor: "#16161c",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: "#e8e8ee",
    fontSize: 14,
  },
  commitBtn: {
    backgroundColor: "#3557b7",
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  commitBtnOff: { backgroundColor: "#26262e" },
  commitBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});
