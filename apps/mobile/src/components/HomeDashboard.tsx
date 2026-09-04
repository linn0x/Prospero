import { useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { SessionInfo } from "@prospero/protocol";

import { AgentIcon } from "@/components/AgentIcon";
import { Icon } from "@/components/Icon";
import { PromptDialog } from "@/components/PromptDialog";
import { Sheet, SheetAction } from "@/components/Sheet";
import { SwipeRow } from "@/components/SwipeRow";
import type { StoredHost } from "@/lib/hosts";
import {
  homeHostOsLabel,
  homeHostStats,
  homeRecentSessions,
  homeWorkspaceProjects,
} from "@/lib/home-dashboard";
import {
  DEFAULT_HOME_SETTINGS,
  normalizeHomeSettings,
  workspaceAliasKey,
  type HomeSettings,
} from "@/lib/home-preferences";
import type { SessionProject } from "@/lib/session-projects";
import type { ConnStatus, HostRuntime } from "@/lib/store";
import { color, font, radius, space, statusColor } from "@/lib/theme";

const statusLabel: Record<ConnStatus, string> = {
  idle: "未连接",
  connecting: "连接中…",
  reconnecting: "重连中…",
  connected: "已连接",
  failed: "连接失败",
};

const sessionStatusLabel: Record<SessionInfo["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting_approval: "待审批",
  waiting_input: "待回答",
  idle: "空闲",
  completed: "已完成",
  done: "已结束",
  died: "已退出",
};

function hostDetail(host: StoredHost, runtime: HostRuntime | undefined): string {
  const status = runtime?.status ?? "idle";
  const path =
    runtime?.activePath === "relay"
      ? "中继"
      : runtime?.activePath === "direct"
        ? "直连"
        : null;
  return [
    statusLabel[status],
    path,
    host.addrs.length > 1 ? `${String(host.addrs.length)} 条线路` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

function workspaceDetail(project: SessionProject): string {
  if (project.pendingCount > 0) return `${String(project.pendingCount)} 项待处理`;
  if (project.runningCount > 0) return `${String(project.runningCount)} 个会话运行中`;
  return `${String(project.sessions.length)} 个会话`;
}

function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "工作区";
}

function recentTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${time}`;
}

export function HomeDashboard({
  hosts,
  runtimes,
  selectedHostId,
  devicePickerOpen,
  bottomInset,
  onToggleDevicePicker,
  onSelectHost,
  onOpenHost,
  onOpenSession,
  onEditHost,
  onDeleteHost,
  onAddHost,
  onRefreshHost,
  onCreateSession,
  onCreateDirectory,
  homeSettings,
  onChangeHomeSettings,
  onOpenSettings,
}: {
  hosts: StoredHost[];
  runtimes: Record<string, HostRuntime>;
  selectedHostId: string | null;
  devicePickerOpen: boolean;
  bottomInset: number;
  onToggleDevicePicker: () => void;
  onSelectHost: (hostId: string) => void;
  onOpenHost: (hostId: string) => void;
  onOpenSession: (hostId: string, sessionId: string) => void;
  onEditHost: (hostId: string) => void;
  onDeleteHost: (host: StoredHost) => void;
  onAddHost: () => void;
  onRefreshHost: (hostId: string) => void;
  onCreateSession: (hostId: string, cwd?: string) => void;
  onCreateDirectory: (hostId: string) => void;
  homeSettings?: HomeSettings;
  onChangeHomeSettings: (patch: Partial<HomeSettings>) => void;
  onOpenSettings: () => void;
}) {
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? hosts[0];
  const selectedRuntime = selectedHost ? runtimes[selectedHost.id] : undefined;
  // Fast Refresh 会保留旧版 Zustand 状态；标准化可补全后续新增的设置字段。
  const effectiveHomeSettings = normalizeHomeSettings(homeSettings ?? DEFAULT_HOME_SETTINGS);
  const projects = useMemo(
    () => homeWorkspaceProjects(selectedRuntime?.sessions),
    [selectedRuntime?.sessions],
  );
  const stats = useMemo(
    () => homeHostStats(selectedRuntime?.sessions),
    [selectedRuntime?.sessions],
  );
  const recentSessions = useMemo(
    () => homeRecentSessions(selectedRuntime?.sessions, effectiveHomeSettings.recentSessionLimit),
    [effectiveHomeSettings.recentSessionLimit, selectedRuntime?.sessions],
  );
  const [expandedProjectKey, setExpandedProjectKey] = useState<string | null>(null);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<SessionProject | null>(null);
  const [projectAlias, setProjectAlias] = useState("");
  const refreshing =
    selectedRuntime?.status === "connecting" || selectedRuntime?.status === "reconnecting";

  if (!selectedHost) return null;

  const displayProjectName = (path: string, fallback: string): string =>
    effectiveHomeSettings.workspaceAliases[workspaceAliasKey(selectedHost.id, path)] ?? fallback;

  return (
    <>
      <FlatList
      key={selectedHost.id}
      testID="home-workspace-list"
      data={projects}
      extraData={expandedProjectKey}
      keyExtractor={(project) => project.path}
      // Android/Fabric 会缓存动态高度 cell 的裁剪边界；目录反复展开后文字会被
      // 当成仍在旧边界之外而消失。首页项目量有限，关闭裁剪换取稳定的重排。
      removeClippedSubviews={false}
      contentContainerStyle={[styles.list, { paddingBottom: bottomInset + space.xl }]}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => onRefreshHost(selectedHost.id)}
          tintColor={color.accent}
        />
      }
      ListHeaderComponent={
        <View style={styles.headerContent}>
          <View style={styles.devicePanel}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: devicePickerOpen }}
              accessibilityLabel={`选择设备，当前为 ${selectedHost.name}`}
              accessibilityHint="从屏幕底部打开设备列表"
              style={({ pressed }) => [styles.deviceSelector, pressed && styles.pressed]}
              onPress={onToggleDevicePicker}
            >
                <View style={styles.sectionIcon}>
                  <Icon name="desktopcomputer" size={18} color={color.accent} />
                </View>
                <View style={styles.deviceHeaderCopy}>
                  <Text style={styles.deviceHeaderName} numberOfLines={1}>
                    {selectedHost.name}
                  </Text>
                  <Text style={styles.deviceOs} numberOfLines={1}>
                    {homeHostOsLabel(selectedRuntime?.hostInfo)}
                  </Text>
                </View>
                <View style={styles.deviceSelectorEnd}>
                  <View style={styles.connectionBadge}>
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: statusColor[selectedRuntime?.status ?? "idle"] },
                      ]}
                    />
                    <Text style={styles.connectionBadgeText}>
                      {statusLabel[selectedRuntime?.status ?? "idle"]}
                    </Text>
                  </View>
                  <Icon name="chevron.down" size={17} color={color.textDim} />
                </View>
            </Pressable>

            <View style={styles.statsRow}>
              <DeviceStat value={stats.activeAgentCount} label="Agent" />
              <DeviceStat value={stats.sessionCount} label="会话" />
              <DeviceStat value={hosts.length} label="设备" />
              <View style={[styles.runningPill, stats.runningCount === 0 && styles.runningPillIdle]}>
                <View
                  style={[
                    styles.sessionStatusDot,
                    { backgroundColor: stats.runningCount > 0 ? color.warn : color.textFaint },
                  ]}
                />
                <Text style={styles.runningPillText}>
                  {stats.runningCount > 0 ? `${String(stats.runningCount)} 项进行中` : "当前空闲"}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.recentSection}>
            <View style={styles.sectionHeading}>
              <View>
                <Text style={styles.sectionTitle}>最近对话</Text>
                <Text style={styles.sectionSubtitle}>
                  最近 {String(effectiveHomeSettings.recentSessionLimit)} 条
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="打开设置"
                onPress={onOpenSettings}
                hitSlop={8}
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
              >
                <Icon name="gearshape.fill" size={18} color={color.textDim} />
              </Pressable>
            </View>
            {recentSessions.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.recentList}
              >
                {recentSessions.map((session) => (
                  <Pressable
                    key={session.id}
                    accessibilityRole="button"
                    accessibilityLabel={`打开最近对话 ${session.title || session.agent}`}
                    onPress={() => onOpenSession(selectedHost.id, session.id)}
                    style={({ pressed }) => [styles.recentCard, pressed && styles.recentCardPressed]}
                  >
                    <AgentIcon agent={session.agent} size={18} badge />
                    <View style={styles.recentCopy}>
                      <Text style={styles.recentTitle} numberOfLines={1}>
                        {session.title || session.agent}
                      </Text>
                      <Text style={styles.recentMeta} numberOfLines={1}>
                        {displayProjectName(session.cwd, projectName(session.cwd))} · {recentTime(session.createdAt)}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.sessionStatusDot,
                        { backgroundColor: statusColor[session.status] },
                      ]}
                    />
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.recentEmpty}>创建或打开对话后，会显示在这里。</Text>
            )}
          </View>

          <View style={styles.workspaceSection}>
            <View style={styles.workspaceHeading}>
              <View>
                <Text style={styles.workspaceTitle}>工作目录</Text>
                <Text style={styles.workspaceSubtitle} numberOfLines={1}>
                  {selectedHost.name} · 点按展开 · 左滑操作
                </Text>
              </View>
              <View style={styles.workspaceActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`打开 ${selectedHost.name} 详情`}
                  hitSlop={8}
                  onPress={() => onOpenHost(selectedHost.id)}
                  style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                >
                  <Icon name="ellipsis.circle" size={18} color={color.textDim} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="新建对话或目录"
                  onPress={() => setQuickCreateOpen(true)}
                  style={({ pressed }) => [styles.createButton, pressed && styles.createButtonPressed]}
                >
                  <Icon name="plus" size={16} color={color.text} weight="semibold" />
                  <Text style={styles.createButtonText}>新建</Text>
                </Pressable>
              </View>
            </View>

          </View>
        </View>
      }
      ListEmptyComponent={
        <WorkspaceEmptyState
          host={selectedHost}
          runtime={selectedRuntime}
          onOpenHost={() => onOpenHost(selectedHost.id)}
          onRefresh={() => onRefreshHost(selectedHost.id)}
        />
      }
      ItemSeparatorComponent={() => <View style={styles.projectGap} />}
      renderItem={({ item: project }) => {
        const projectKey = `${selectedHost.id}:${project.path}`;
        const expanded = expandedProjectKey === projectKey;
        const displayName = displayProjectName(project.path, project.name);
        return (
          <View
            collapsable={false}
            style={[styles.projectCard, expanded && styles.projectCardExpanded]}
          >
            <SwipeRow
              clipRadius={radius.md}
              actions={[
                {
                  id: "create-session",
                  label: "新会话",
                  symbol: "plus",
                  color: color.accent,
                  foregroundColor: color.onAccent,
                  onPress: () => onCreateSession(selectedHost.id, project.path),
                },
                {
                  id: "edit-workspace",
                  label: "编辑",
                  symbol: "pencil",
                  color: color.surfaceRaised,
                  foregroundColor: color.text,
                  onPress: () => {
                    setEditingProject(project);
                    setProjectAlias(displayName);
                  },
                },
              ]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={`${displayName}，${workspaceDetail(project)}`}
                accessibilityHint={`${expanded ? "收起这个目录的会话" : "展开这个目录的会话"}；左滑可新建会话或编辑名称`}
                onPress={() => setExpandedProjectKey(expanded ? null : projectKey)}
                style={({ pressed }) => [styles.projectHeader, pressed && styles.projectCardPressed]}
              >
                <View style={styles.projectIcon}>
                  <Icon name="folder.fill" size={18} color={color.accent} />
                </View>
                <View style={styles.projectCopy}>
                  <Text style={styles.projectName} numberOfLines={1}>
                    {displayName}
                  </Text>
                  <Text style={styles.projectPath} numberOfLines={1}>
                    {project.path}
                  </Text>
                </View>
                <View style={styles.projectMeta}>
                  <Text
                    style={[
                      styles.projectState,
                      project.pendingCount > 0
                        ? styles.projectPending
                        : project.runningCount > 0
                          ? styles.projectRunning
                          : undefined,
                    ]}
                  >
                    {workspaceDetail(project)}
                  </Text>
                  <Icon
                    name={expanded ? "chevron.down" : "chevron.right"}
                    size={15}
                    color={color.textFaint}
                  />
                </View>
              </Pressable>
            </SwipeRow>

            {expanded && (
              <View style={styles.sessionList}>
                {project.sessions.map((session) => (
                  <Pressable
                    key={session.id}
                    accessibilityRole="button"
                    accessibilityLabel={`打开会话 ${session.title}，${sessionStatusLabel[session.status]}`}
                    onPress={() => onOpenSession(selectedHost.id, session.id)}
                    style={({ pressed }) => [
                      styles.sessionRow,
                      pressed && styles.sessionRowPressed,
                    ]}
                  >
                    <AgentIcon agent={session.agent} size={17} badge />
                    <View style={styles.sessionCopy}>
                      <Text style={styles.sessionTitle} numberOfLines={1}>
                        {session.title || session.agent}
                      </Text>
                      <Text style={styles.sessionPreview} numberOfLines={1}>
                        {session.preview?.trim() || `${session.agent} · ${session.kind}`}
                      </Text>
                    </View>
                    <View style={styles.sessionState}>
                      <View
                        style={[
                          styles.sessionStatusDot,
                          { backgroundColor: statusColor[session.status] },
                        ]}
                      />
                      <Text style={styles.sessionStatusText}>
                        {sessionStatusLabel[session.status]}
                      </Text>
                    </View>
                    <Icon name="chevron.right" size={14} color={color.textFaint} />
                  </Pressable>
                ))}
              </View>
            )}
          </View>
        );
      }}
      />

      <Sheet
        visible={devicePickerOpen}
        title="设备"
        onClose={onToggleDevicePicker}
      >
        <View style={styles.deviceList}>
          {hosts.map((host) => {
            const runtime = runtimes[host.id];
            const selected = host.id === selectedHost.id;
            return (
              <View key={host.id} style={[styles.deviceManageRow, selected && styles.deviceRowSelected]}>
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${host.name}，${hostDetail(host, runtime)}`}
                  onPress={() => onSelectHost(host.id)}
                  style={({ pressed }) => [
                    styles.deviceRow,
                    pressed && styles.pressed,
                  ]}
                >
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: statusColor[runtime?.status ?? "idle"] },
                    ]}
                  />
                  <View style={styles.deviceRowCopy}>
                    <Text style={styles.deviceRowName} numberOfLines={1}>
                      {host.name}
                    </Text>
                    <Text style={styles.deviceRowDetail} numberOfLines={1}>
                      {hostDetail(host, runtime)}
                    </Text>
                  </View>
                  {selected && <Icon name="checkmark.circle.fill" size={18} color={color.accent} />}
                </Pressable>
                <View style={styles.deviceRowActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`编辑 ${host.name}`}
                    onPress={() => {
                      onToggleDevicePicker();
                      onEditHost(host.id);
                    }}
                    style={({ pressed }) => [styles.deviceAction, pressed && styles.pressed]}
                  >
                    <Icon name="pencil" size={17} color={color.textDim} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`删除 ${host.name}`}
                    onPress={() =>
                      Alert.alert(
                        `移除「${host.name}」的配对？`,
                        "凭证会从这台手机删除，再次使用需要重新扫码配对。",
                        [
                          { text: "取消", style: "cancel" },
                          { text: "删除", style: "destructive", onPress: () => onDeleteHost(host) },
                        ],
                      )
                    }
                    style={({ pressed }) => [styles.deviceAction, pressed && styles.dangerPressed]}
                  >
                    <Icon name="trash" size={17} color={color.danger} />
                  </Pressable>
                </View>
              </View>
            );
          })}
          <View style={styles.deviceSheetDivider} />
          <SheetAction
            label="添加设备"
            detail="扫描电脑上的 Prospero 配对二维码"
            symbol="qrcode.viewfinder"
            onPress={() => {
              onToggleDevicePicker();
              onAddHost();
            }}
          />
        </View>
      </Sheet>

      <Sheet
        visible={quickCreateOpen}
        title="新建"
        onClose={() => setQuickCreateOpen(false)}
      >
        <SheetAction
          label="新建对话"
          detail={`在 ${selectedHost.name} 选择工作目录并启动 Agent`}
          symbol="bubble.left.and.text.bubble.right"
          onPress={() => {
            setQuickCreateOpen(false);
            onCreateSession(selectedHost.id);
          }}
        />
        <SheetAction
          label="新建目录"
          detail="浏览电脑目录，并可在任意位置创建文件夹"
          symbol="folder.fill"
          onPress={() => {
            setQuickCreateOpen(false);
            onCreateDirectory(selectedHost.id);
          }}
        />
      </Sheet>

      <PromptDialog
        visible={editingProject !== null}
        title="编辑工作区名称"
        message="只修改这台手机上的显示名称，不会移动电脑目录或更改已有会话。清空可恢复目录原名。"
        value={projectAlias}
        confirmLabel="保存"
        onChangeText={setProjectAlias}
        onCancel={() => setEditingProject(null)}
        validate={(value) => (value.trim().length > 60 ? "名称不能超过 60 个字符" : null)}
        onSubmit={(value) => {
          if (!editingProject) return;
          const key = workspaceAliasKey(selectedHost.id, editingProject.path);
          const nextAliases = { ...effectiveHomeSettings.workspaceAliases };
          const alias = value.trim();
          if (alias === "" || alias === editingProject.name) delete nextAliases[key];
          else nextAliases[key] = alias;
          onChangeHomeSettings({ workspaceAliases: nextAliases });
          setEditingProject(null);
        }}
      />
    </>
  );
}

function DeviceStat({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{String(value)}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function WorkspaceEmptyState({
  host,
  runtime,
  onOpenHost,
  onRefresh,
}: {
  host: StoredHost;
  runtime: HostRuntime | undefined;
  onOpenHost: () => void;
  onRefresh: () => void;
}) {
  const status = runtime?.status ?? "idle";
  const unavailable = status === "failed" || status === "idle";
  return (
    <View style={styles.workspaceEmpty}>
      <View style={styles.emptyIcon}>
        <Icon
          name={unavailable ? "exclamationmark.triangle.fill" : "folder.fill"}
          size={25}
          color={unavailable ? color.warn : color.textFaint}
        />
      </View>
      <Text style={styles.emptyTitle}>
        {status === "connecting" || status === "reconnecting"
          ? `正在读取 ${host.name}`
          : unavailable
            ? "暂时无法读取工作目录"
            : "还没有工作目录"}
      </Text>
      <Text style={styles.emptyDetail}>
        {status === "failed"
          ? (runtime?.lastError ?? "设备连接失败，请检查网络后重试。")
          : status === "idle"
            ? "连接设备后，这里会按会话所在目录自动整理项目。"
            : status === "connecting" || status === "reconnecting"
              ? "建立连接后会自动同步已有会话和目录。"
              : "在设备中选择一个目录并创建会话后，它会出现在这里。"}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={unavailable ? onRefresh : onOpenHost}
        style={({ pressed }) => [styles.emptyAction, pressed && styles.emptyActionPressed]}
      >
        <Text style={styles.emptyActionText}>{unavailable ? "重新连接" : "打开设备"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    flexGrow: 1,
    width: "100%",
    maxWidth: 840,
    alignSelf: "center",
    paddingHorizontal: space.lg,
  },
  headerContent: { gap: space.lg, paddingTop: space.sm, paddingBottom: space.md },
  devicePanel: {
    overflow: "hidden",
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  deviceSelector: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  sectionIcon: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: color.accentBg,
  },
  deviceHeaderCopy: { flex: 1, gap: 2 },
  deviceHeaderName: { ...font.body, fontSize: 15, fontWeight: "700" },
  deviceOs: { color: color.textDim, fontSize: 10.5 },
  deviceSelectorEnd: { flexDirection: "row", alignItems: "center", gap: space.sm },
  connectionBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: color.surfaceRaised,
  },
  connectionBadgeText: { color: color.textDim, fontSize: 10, fontWeight: "600" },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statsRow: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  stat: { flexDirection: "row", alignItems: "baseline", gap: 3 },
  statValue: { color: color.text, fontSize: 13, fontWeight: "700" },
  statLabel: { color: color.textDim, fontSize: 10 },
  runningPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginLeft: "auto",
  },
  runningPillIdle: { opacity: 0.72 },
  runningPillText: { color: color.textDim, fontSize: 10, fontWeight: "600" },
  deviceList: {
    gap: 2,
    paddingBottom: space.lg,
  },
  deviceManageRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.sm,
  },
  deviceRow: {
    minHeight: 58,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
  },
  deviceRowSelected: { backgroundColor: color.accentBg },
  deviceRowCopy: { flex: 1, gap: 2 },
  deviceRowName: { ...font.body, fontWeight: "600" },
  deviceRowDetail: font.meta,
  deviceRowActions: { flexDirection: "row", alignItems: "center", paddingRight: space.xs },
  deviceAction: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  dangerPressed: { backgroundColor: color.dangerBg },
  deviceSheetDivider: {
    height: StyleSheet.hairlineWidth,
    marginTop: space.sm,
    backgroundColor: color.border,
  },
  pressed: { backgroundColor: color.pressed },
  recentSection: { gap: space.sm },
  sectionHeading: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: { ...font.title, fontSize: 17 },
  sectionSubtitle: { color: color.textDim, fontSize: 10, marginTop: 1 },
  iconButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
  },
  recentList: { gap: space.sm, paddingRight: space.lg },
  recentCard: {
    width: 232,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  recentCardPressed: { backgroundColor: color.pressed },
  recentCopy: { flex: 1, minWidth: 0, gap: 3 },
  recentTitle: { ...font.body, fontSize: 13, fontWeight: "600" },
  recentMeta: { color: color.textDim, fontSize: 10.5 },
  recentEmpty: {
    ...font.meta,
    paddingVertical: space.sm,
    color: color.textDim,
  },
  workspaceSection: { gap: space.md },
  workspaceHeading: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: space.md,
  },
  workspaceTitle: { ...font.title, fontSize: 19 },
  workspaceSubtitle: { ...font.meta, marginTop: 3 },
  workspaceActions: { flexDirection: "row", alignItems: "center", gap: space.xs },
  createButton: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    backgroundColor: color.accentDim,
  },
  createButtonPressed: { opacity: 0.8 },
  createButtonText: { color: color.text, fontSize: 12, fontWeight: "700" },
  projectGap: { height: space.sm },
  projectCard: {
    minHeight: 64,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  projectCardExpanded: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentDim,
  },
  projectHeader: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    backgroundColor: color.surface,
  },
  // 不依赖父层 overflow 裁剪：它在 Android/Fabric 动态高度列表中会再次造成文字消失。
  projectCardPressed: { borderRadius: radius.md, backgroundColor: color.pressed },
  projectIcon: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: color.accentBg,
  },
  projectCopy: { flex: 1, minWidth: 0, gap: 2 },
  projectName: { ...font.body, fontSize: 15, fontWeight: "700" },
  projectPath: { ...font.meta, color: color.textDim },
  projectMeta: { alignItems: "flex-end", gap: space.sm, maxWidth: 112 },
  projectState: { ...font.meta, textAlign: "right" },
  projectPending: { color: color.warn, fontWeight: "600" },
  projectRunning: { color: color.success, fontWeight: "600" },
  sessionList: {
    paddingHorizontal: space.sm,
    paddingBottom: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  sessionRow: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
  },
  sessionRowPressed: { backgroundColor: color.pressed },
  sessionCopy: { flex: 1, minWidth: 0, gap: 3 },
  sessionTitle: { ...font.body, fontSize: 14, fontWeight: "600" },
  sessionPreview: { ...font.meta, color: color.textDim },
  sessionState: { flexDirection: "row", alignItems: "center", gap: 5 },
  sessionStatusDot: { width: 6, height: 6, borderRadius: 3 },
  sessionStatusText: { ...font.meta, color: color.textDim },
  workspaceEmpty: {
    flex: 1,
    minHeight: 270,
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.xl,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  emptyIcon: {
    width: 54,
    height: 54,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.lg,
    backgroundColor: color.surfaceRaised,
  },
  emptyTitle: { ...font.title, fontSize: 17, textAlign: "center" },
  emptyDetail: { ...font.sub, maxWidth: 360, lineHeight: 19, textAlign: "center" },
  emptyAction: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.xl,
    borderRadius: radius.md,
    backgroundColor: color.accentBg,
  },
  emptyActionPressed: { backgroundColor: color.pressed },
  emptyActionText: { color: color.accent, fontSize: 14, fontWeight: "600" },
});
