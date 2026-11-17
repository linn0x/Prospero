import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { S2CMessage, SessionInfo } from "@prospero/protocol";
import { Icon, type IconName } from "@/components/Icon";
import { toast } from "@/components/Toast";
import type { HostConnection } from "@/lib/connection";
import { gitFileBadge, summarizeGitChanges } from "@/lib/session-quick-panel";
import { MONOSPACE_FONT, createThemedStyles, useMobileTheme } from "@/lib/theme";

type GitStatusResult = Extract<S2CMessage, { type: "git.status.result" }>;

interface QuickActionProps {
  icon: IconName;
  label: string;
  detail: string;
  onPress: () => void;
}

function QuickAction({ icon, label, detail, onPress }: QuickActionProps): React.ReactElement {
  const styles = useStyles();
  const { palette: color } = useMobileTheme();
  return (
    <Pressable
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
    >
      <View style={styles.actionIcon}>
        <Icon name={icon} size={18} color={color.accent} />
      </View>
      <View style={styles.actionCopy}>
        <Text style={styles.actionLabel}>{label}</Text>
        <Text style={styles.actionDetail} numberOfLines={1}>{detail}</Text>
      </View>
      <Icon name="chevron.right" size={16} color={color.textFaint} />
    </Pressable>
  );
}

export interface SessionQuickPanelProps {
  active: boolean;
  connected: boolean;
  conn: HostConnection;
  session: SessionInfo;
  pending: number;
  coordinatorAvailable: boolean;
  terminalAction?: {
    active: boolean;
    onPress: () => void;
  };
  onClose: () => void;
  onOpenGit: () => void;
  onOpenFiles: () => void;
  onOpenCoordinator: () => void;
}

export function SessionQuickPanel({
  active,
  connected,
  conn,
  session,
  pending,
  coordinatorAvailable,
  terminalAction,
  onClose,
  onOpenGit,
  onOpenFiles,
  onOpenCoordinator,
}: SessionQuickPanelProps): React.ReactElement {
  const styles = useStyles();
  const { palette: color } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const [git, setGit] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRevision = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const revision = ++requestRevision.current;
    if (!connected) {
      setGit(null);
      setLoading(false);
      setError("主机未连接，恢复后会自动刷新");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await conn.gitStatus(session.id);
      if (revision !== requestRevision.current) return;
      setGit(next);
    } catch (reason) {
      if (revision !== requestRevision.current) return;
      setGit(null);
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(/not a git repository/i.test(message) ? "当前工作目录不是 Git 仓库" : message);
    } finally {
      if (revision === requestRevision.current) setLoading(false);
    }
  }, [conn, connected, session.id]);

  useEffect(() => {
    if (!active) {
      requestRevision.current++;
      return;
    }
    const first = setTimeout(() => { void refresh(); }, 0);
    const timer = setInterval(() => { void refresh(); }, 8_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active, refresh]);

  const summary = useMemo(
    () => summarizeGitChanges(git?.files ?? []),
    [git?.files],
  );
  const subagentCount = session.subagents?.length ?? 0;
  const queuedCount = session.messageQueue?.length ?? 0;

  const copyWorkingDirectory = (): void => {
    void Clipboard.setStringAsync(session.cwd);
    void Haptics.selectionAsync();
    toast("已复制工作目录");
  };

  return (
    <View style={styles.panel}>
      <View style={[styles.header, { paddingTop: Math.max(12, insets.top) }]}>
        <Text style={styles.title}>工作区与工具</Text>
        <Pressable
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="关闭会话工具"
        >
          <Icon name="xmark" size={15} color={color.textDim} weight="semibold" />
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(30, insets.bottom + 16) }]}
        showsVerticalScrollIndicator={false}
      >
        <Pressable
          style={({ pressed }) => [styles.pathCard, pressed && styles.pathPressed]}
          onPress={copyWorkingDirectory}
          accessibilityRole="button"
          accessibilityLabel="复制工作目录"
        >
          <Icon name="folder.fill" size={15} color={color.accent} />
          <Text style={styles.path} numberOfLines={1} ellipsizeMode="middle">{session.cwd}</Text>
          <Icon name="doc.on.doc" size={13} color={color.textFaint} />
        </Pressable>

        {(pending > 0 || queuedCount > 0 || subagentCount > 0) && (
          <View style={styles.sessionMetrics}>
            {pending > 0 && <Text style={styles.metricWarn}>{String(pending)} 项待处理</Text>}
            {queuedCount > 0 && <Text style={styles.metric}>{String(queuedCount)} 条排队</Text>}
            {subagentCount > 0 && <Text style={styles.metric}>{String(subagentCount)} 个子 Agent</Text>}
          </View>
        )}

        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>Git 改动</Text>
          <Pressable
            style={({ pressed }) => [styles.refresh, pressed && styles.pressed]}
            onPress={() => { void refresh(); }}
            disabled={loading}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="刷新 Git 状态"
            accessibilityState={{ busy: loading, disabled: loading }}
          >
            {loading ? (
              <ActivityIndicator size="small" color={color.accent} />
            ) : (
              <Icon name="arrow.clockwise" size={16} color={color.accent} />
            )}
          </Pressable>
        </View>

        <Pressable
          style={({ pressed }) => [styles.gitCard, pressed && styles.gitCardPressed]}
          onPress={onOpenGit}
          accessibilityRole="button"
          accessibilityLabel="打开项目改动"
        >
          <View style={styles.branchRow}>
            <Icon name="arrow.triangle.branch" size={16} color={color.accent} />
            <Text style={styles.branch} numberOfLines={1}>
              {git?.branch ?? (loading ? "正在读取分支…" : "源代码管理")}
            </Text>
            {git && (git.ahead > 0 || git.behind > 0) && (
              <Text style={styles.syncState}>
                {git.ahead > 0 ? `↑${String(git.ahead)}` : ""}
                {git.behind > 0 ? ` ↓${String(git.behind)}` : ""}
              </Text>
            )}
            <Icon name="chevron.right" size={15} color={color.textFaint} />
          </View>

          {error ? (
            <Text style={styles.gitError}>{error}</Text>
          ) : git?.branch === null ? (
            <Text style={styles.gitEmpty}>当前工作目录不是 Git 仓库</Text>
          ) : git ? (
            <>
              <View style={styles.gitMetrics}>
                <View style={styles.gitMetric}>
                  <Text style={styles.gitMetricValue}>{String(summary.changed)}</Text>
                  <Text style={styles.gitMetricLabel}>改动</Text>
                </View>
                <View style={styles.gitMetric}>
                  <Text style={styles.gitMetricValue}>{String(summary.staged)}</Text>
                  <Text style={styles.gitMetricLabel}>已暂存</Text>
                </View>
                <View style={styles.gitMetric}>
                  <Text style={styles.gitMetricValue}>{String(summary.unstaged)}</Text>
                  <Text style={styles.gitMetricLabel}>未暂存</Text>
                </View>
                <View style={styles.gitMetric}>
                  <Text style={styles.gitMetricValue}>{String(summary.untracked)}</Text>
                  <Text style={styles.gitMetricLabel}>新增</Text>
                </View>
              </View>
              {git.files.length === 0 ? (
                <Text style={styles.gitEmpty}>工作区干净</Text>
              ) : (
                <View style={styles.changedFiles}>
                  {git.files.slice(0, 5).map((file) => (
                    <View key={file.path} style={styles.changedFile}>
                      <Text style={styles.fileBadge}>{gitFileBadge(file)}</Text>
                      <Text style={styles.filePath} numberOfLines={1} ellipsizeMode="middle">
                        {file.path}
                      </Text>
                    </View>
                  ))}
                  {git.files.length > 5 && (
                    <Text style={styles.moreFiles}>另有 {String(git.files.length - 5)} 个文件</Text>
                  )}
                </View>
              )}
            </>
          ) : (
            <Text style={styles.gitEmpty}>正在同步代码状态…</Text>
          )}
        </Pressable>

        <View style={styles.actions}>
          <QuickAction
            icon="folder.fill"
            label="项目文件"
            detail="浏览与编辑当前工作目录"
            onPress={onOpenFiles}
          />
          {terminalAction && (
            <QuickAction
              icon="terminal"
              label="工作区终端"
              detail={
                terminalAction.active
                  ? "切换到当前工作区运行中的 Shell 终端"
                  : "在当前工作目录启动或管理 Shell 终端"
              }
              onPress={terminalAction.onPress}
            />
          )}
          {coordinatorAvailable && (
            <QuickAction
              icon="point.3.connected.trianglepath.dotted"
              label="Goal 任务图"
              detail="查看依赖、Worker 与 Gate"
              onPress={onOpenCoordinator}
            />
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const useStyles = createThemedStyles((color) => StyleSheet.create({
  panel: { flex: 1, backgroundColor: color.surface },
  header: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  title: { color: color.text, fontSize: 18, fontWeight: "700", letterSpacing: -0.2 },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surfaceRaised,
  },
  scroll: { flex: 1 },
  content: { gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 30 },
  pathCard: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: color.surfaceRaised,
  },
  pathPressed: { backgroundColor: color.pressed },
  path: { flex: 1, color: color.textDim, fontSize: 11.5, fontFamily: MONOSPACE_FONT },
  sessionMetrics: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  metric: {
    color: color.textDim,
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: color.surfaceRaised,
  },
  metricWarn: {
    color: color.warn,
    fontSize: 11,
    fontWeight: "600",
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: color.warnBg,
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 28,
    marginTop: 2,
  },
  sectionTitle: { color: color.textDim, fontSize: 12, fontWeight: "600" },
  refresh: { width: 34, height: 30, alignItems: "center", justifyContent: "center" },
  gitCard: {
    borderRadius: 16,
    backgroundColor: color.bg,
    overflow: "hidden",
  },
  gitCardPressed: { opacity: 0.85 },
  branchRow: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  branch: { flex: 1, color: color.text, fontSize: 13, fontWeight: "600", fontFamily: MONOSPACE_FONT },
  syncState: { color: color.warn, fontSize: 11, fontVariant: ["tabular-nums"] },
  gitMetrics: { flexDirection: "row", paddingHorizontal: 8, paddingVertical: 12 },
  gitMetric: { flex: 1, alignItems: "center", gap: 2 },
  gitMetricValue: { color: color.text, fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
  gitMetricLabel: { color: color.textFaint, fontSize: 10 },
  changedFiles: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  changedFile: { minHeight: 30, flexDirection: "row", alignItems: "center", gap: 8 },
  fileBadge: {
    width: 24,
    color: color.warn,
    fontSize: 10,
    fontWeight: "700",
    textAlign: "center",
    fontFamily: MONOSPACE_FONT,
  },
  filePath: { flex: 1, color: color.textDim, fontSize: 11, fontFamily: MONOSPACE_FONT },
  moreFiles: { color: color.textFaint, fontSize: 10, textAlign: "center", paddingTop: 5 },
  gitEmpty: { color: color.textFaint, fontSize: 12, textAlign: "center", padding: 18 },
  gitError: { color: color.warn, backgroundColor: color.warnBg, fontSize: 11.5, lineHeight: 17, padding: 12 },
  actions: { gap: 8, marginTop: 4 },
  action: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: color.bg,
  },
  actionIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accentBg,
  },
  actionCopy: { flex: 1, gap: 2 },
  actionLabel: { color: color.text, fontSize: 14, fontWeight: "600" },
  actionDetail: { color: color.textFaint, fontSize: 11.5 },
  pressed: { opacity: 0.68 },
}));
