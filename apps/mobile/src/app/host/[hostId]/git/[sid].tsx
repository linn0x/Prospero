import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import type { GitFile } from "@prospero/protocol";
import { DismissKey } from "@/components/DismissKey";
import { DiffView } from "@/components/DiffView";
import { Icon } from "@/components/Icon";
import { SwipeRow, type SwipeAction } from "@/components/SwipeRow";
import { toast } from "@/components/Toast";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import { getGitCommitBarPadding } from "@/lib/git-layout";
import { color } from "@/lib/theme";
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
  const commitBarPadding = getGitCommitBarPadding(insets);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior="padding"
      automaticOffset
    >
      <Stack.Screen
        options={{
          title: branch ?? "源代码管理",
          headerBackTitle: "",
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={loading ? "正在刷新 Git 状态" : "刷新 Git 状态"}
              accessibilityHint={loading ? "刷新进行中" : "读取当前工作区状态"}
              accessibilityState={{ busy: loading, disabled: loading }}
              onPress={() => void refresh()}
              disabled={loading}
              style={styles.headerButton}
            >
              <Icon name="arrow.clockwise" size={18} color={loading ? color.textFaint : color.accent} />
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
            contentContainerStyle={{ paddingBottom: 8 }}
            refreshControl={
              <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={color.accent} />
            }
            ListEmptyComponent={
              loading ? null : <Text style={styles.empty}>工作区干净,没有改动。</Text>
            }
            renderItem={({ item }) => {
              const isStaged = item.index !== " " && item.index !== "?";
              const actions: SwipeAction[] = [
                {
                  id: "toggle-stage",
                  label: isStaged ? "取消暂存" : "暂存",
                  symbol: isStaged ? "arrow.clockwise" : "checkmark.circle.fill",
                  color: isStaged ? color.surfaceRaised : color.accent,
                  foregroundColor: isStaged ? color.text : color.onAccent,
                  onPress: () => void toggleStage(item),
                },
              ];
              // 未跟踪文件没有"改动"可丢弃,git restore 也处理不了它
              if (!item.untracked) {
                actions.push({
                  id: "discard-change",
                  label: "丢弃",
                  symbol: "trash",
                  color: color.danger,
                  foregroundColor: color.onAccent,
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
                <ActivityIndicator style={styles.diffLoading} color={color.accent} />
              ) : patch.length === 0 ? (
                <Text style={styles.empty}>没有可显示的差异。</Text>
              ) : (
                <DiffView diff={{ path: openPath, patch, ...countLines(patch) }} />
              )}
            </View>
          ) : splitLayout ? (
            <View style={styles.diffPlaceholder}>
              <Icon name="doc.fill" size={28} color={color.textFaint} />
              <Text style={styles.empty}>从左侧选择文件查看改动</Text>
            </View>
          ) : null}

          <View style={[styles.commitBar, commitBarPadding]}>
            <DismissKey visible={focused} />
            <TextInput
              style={styles.commitInput}
              value={message}
              onChangeText={setMessage}
              placeholder={hasStaged ? "提交信息" : "先暂存一些改动"}
              placeholderTextColor={color.textFaint}
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
                <ActivityIndicator size="small" color={color.onAccent} />
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
  screen: { flex: 1, backgroundColor: color.bg },
  gitWorkspace: { flex: 1, minHeight: 0 },
  gitWorkspaceSplit: { flexDirection: "row" },
  filePane: { flex: 1, minHeight: 0 },
  gitDetailPane: { flexShrink: 0, minWidth: 0 },
  gitFoldGutter: {
    flexShrink: 0,
    backgroundColor: color.bg,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  branchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  branch: { color: color.accent, fontSize: 14, flexShrink: 1 },
  counts: { color: color.warn, fontSize: 12, fontVariant: ["tabular-nums"] },
  changed: { color: color.textDim, fontSize: 12, marginLeft: "auto" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  rowPressed: { backgroundColor: color.pressed },
  badge: {
    width: 22,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "700",
    borderRadius: 4,
    paddingVertical: 2,
    overflow: "hidden",
  },
  badgeStaged: { color: color.onAccent, backgroundColor: color.success },
  badgeDirty: { color: color.onAccent, backgroundColor: color.warn },
  path: { color: color.text, fontSize: 13, flex: 1 },
  empty: { color: color.textDim, textAlign: "center", padding: 28, fontSize: 13 },
  diffPane: {
    maxHeight: "50%",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.surface,
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
  diffTitle: { color: color.textDim, fontSize: 12, flex: 1 },
  close: { color: color.accent, fontSize: 13 },
  diffLoading: { paddingVertical: 24 },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  commitBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  commitInput: {
    flex: 1,
    maxHeight: 90,
    backgroundColor: color.surfaceRaised,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: color.text,
    fontSize: 14,
  },
  commitBtn: {
    backgroundColor: color.accent,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 11,
  },
  commitBtnOff: { backgroundColor: color.pressed },
  commitBtnText: { color: color.onAccent, fontSize: 14, fontWeight: "600" },
});
