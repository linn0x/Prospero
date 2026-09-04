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
import { color, MONOSPACE_FONT, statusColor } from "@/lib/theme";

type GitStatusResult = Extract<S2CMessage, { type: "git.status.result" }>;

const statusLabel: Record<SessionInfo["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting_approval: "待审批",
  waiting_input: "待回答",
  idle: "空闲就绪",
  completed: "运行完毕",
  done: "会话结束",
  died: "已退出",
};

interface QuickActionProps {
  icon: IconName;
  label: string;
  detail: string;
  onPress: () => void;
}

function QuickAction({ icon, label, detail, onPress }: QuickActionProps): React.ReactElement {
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
  onClose,
  onOpenGit,
  onOpenFiles,
  onOpenCoordinator,
}: SessionQuickPanelProps): React.ReactElement {
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
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>SESSION TOOLBOX</Text>
          <Text style={styles.title}>会话工具</Text>
        </View>
        <Pressable
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="关闭会话工具"
        >
          <Icon name="xmark" size={18} color={color.textDim} />
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(30, insets.bottom + 16) }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.sessionCard}>
          <View style={styles.sessionTitleRow}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: statusColor[session.status] ?? color.textFaint },
              ]}
            />
            <Text style={styles.sessionTitle} numberOfLines={1}>{session.title || "会话"}</Text>
            <Text style={styles.agent}>{session.agent}</Text>
          </View>
          <Text style={styles.sessionState}>{statusLabel[session.status]}</Text>
          <Pressable
            style={({ pressed }) => [styles.pathRow, pressed && styles.pathPressed]}
            onPress={copyWorkingDirectory}
            accessibilityRole="button"
            accessibilityLabel="复制工作目录"
          >
            <Icon name="folder.fill" size={14} color={color.textFaint} />
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
        </View>

        <View style={styles.sectionHeading}>
          <Text style={styles.sectionTitle}>代码状态</Text>
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
            <Icon name="arrow.triangle.branch" size={17} color={color.accent} />
            <Text style={styles.branch} numberOfLines={1}>
              {git?.branch ?? (loading ? "正在读取分支…" : "Git")}
            </Text>
            {git && (git.ahead > 0 || git.behind > 0) && (
              <Text style={styles.syncState}>
                {git.ahead > 0 ? `↑${String(git.ahead)}` : ""}
                {git.behind > 0 ? ` ↓${String(git.behind)}` : ""}
              </Text>
            )}
            <Icon name="chevron.right" size={16} color={color.textFaint} />
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
                <Text style={styles.gitEmpty}>工作区干净，没有改动</Text>
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
            <Text style={styles.gitEmpty}>打开面板后读取代码状态</Text>
          )}
        </Pressable>

        <Text style={styles.sectionTitle}>快捷入口</Text>
        <View style={styles.actions}>
          <QuickAction
            icon="doc.on.doc"
            label="完整 Diff"
            detail="审阅、暂存、丢弃与提交"
            onPress={onOpenGit}
          />
          <QuickAction
            icon="folder.fill"
            label="项目文件"
            detail="浏览和编辑当前工作目录"
            onPress={onOpenFiles}
          />
          {coordinatorAvailable && (
            <QuickAction
              icon="point.3.connected.trianglepath.dotted"
              label="Goal 任务图"
              detail="查看依赖、Worker 与 Gate"
              onPress={onOpenCoordinator}
            />
          )}
          <QuickAction
            icon="doc.on.doc"
            label="复制工作目录"
            detail="用于电脑端快速定位项目"
            onPress={copyWorkingDirectory}
          />
        </View>

        <Text style={styles.gestureHint}>从屏幕右边缘向左滑，可随时呼出此面板</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: color.surface },
  header: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  headerCopy: { flex: 1, gap: 2 },
  eyebrow: { color: color.textFaint, fontSize: 9, fontWeight: "700", letterSpacing: 1.1 },
  title: { color: color.text, fontSize: 20, fontWeight: "700" },
  close: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.surfaceRaised,
  },
  scroll: { flex: 1 },
  content: { gap: 14, padding: 14, paddingBottom: 30 },
  sessionCard: {
    gap: 8,
    padding: 13,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.bg,
  },
  sessionTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  sessionTitle: { flex: 1, color: color.text, fontSize: 14, fontWeight: "700" },
  agent: { color: color.textFaint, fontSize: 10.5, textTransform: "uppercase" },
  sessionState: { marginLeft: 16, color: color.textDim, fontSize: 11 },
  pathRow: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 9,
    borderRadius: 8,
    backgroundColor: color.surfaceRaised,
  },
  pathPressed: { backgroundColor: color.pressed },
  path: { flex: 1, color: color.textDim, fontSize: 10.5, fontFamily: MONOSPACE_FONT },
  sessionMetrics: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  metric: {
    color: color.textDim,
    fontSize: 10,
    paddingHorizontal: 7,
    paddingVertical: 3,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: color.surfaceRaised,
  },
  metricWarn: {
    color: color.warn,
    fontSize: 10,
    paddingHorizontal: 7,
    paddingVertical: 3,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: color.warnBg,
  },
  sectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 30,
  },
  sectionTitle: { color: color.textDim, fontSize: 11, fontWeight: "700", letterSpacing: 0.4 },
  refresh: { width: 34, height: 30, alignItems: "center", justifyContent: "center" },
  gitCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.bg,
    overflow: "hidden",
  },
  gitCardPressed: { borderColor: color.accentDim },
  branchRow: {
    minHeight: 45,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  branch: { flex: 1, color: color.text, fontSize: 13, fontWeight: "600", fontFamily: MONOSPACE_FONT },
  syncState: { color: color.warn, fontSize: 10.5, fontVariant: ["tabular-nums"] },
  gitMetrics: { flexDirection: "row", paddingHorizontal: 8, paddingVertical: 10 },
  gitMetric: { flex: 1, alignItems: "center", gap: 2 },
  gitMetricValue: { color: color.text, fontSize: 15, fontWeight: "700", fontVariant: ["tabular-nums"] },
  gitMetricLabel: { color: color.textFaint, fontSize: 9.5 },
  changedFiles: {
    paddingHorizontal: 10,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  changedFile: { minHeight: 30, flexDirection: "row", alignItems: "center", gap: 8 },
  fileBadge: {
    width: 24,
    color: color.warn,
    fontSize: 9.5,
    fontWeight: "800",
    textAlign: "center",
    fontFamily: MONOSPACE_FONT,
  },
  filePath: { flex: 1, color: color.textDim, fontSize: 10.5, fontFamily: MONOSPACE_FONT },
  moreFiles: { color: color.textFaint, fontSize: 9.5, textAlign: "center", paddingTop: 5 },
  gitEmpty: { color: color.textFaint, fontSize: 11, textAlign: "center", padding: 18 },
  gitError: { color: color.warn, backgroundColor: color.warnBg, fontSize: 11, lineHeight: 16, padding: 12 },
  actions: { gap: 7 },
  action: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    borderRadius: 11,
    backgroundColor: color.bg,
  },
  actionIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: color.accentBg,
  },
  actionCopy: { flex: 1, gap: 2 },
  actionLabel: { color: color.text, fontSize: 12.5, fontWeight: "600" },
  actionDetail: { color: color.textFaint, fontSize: 9.5 },
  gestureHint: { color: color.textFaint, fontSize: 10, lineHeight: 15, textAlign: "center", paddingTop: 4 },
  pressed: { opacity: 0.62 },
});
