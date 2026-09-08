import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { AgentIcon } from "./AgentIcon";
import { EdgeDeviceCard } from "./EdgeDeviceCard";
import { Icon } from "./Icon";
import { Sheet, SheetAction } from "./Sheet";
import { PromptDialog } from "./PromptDialog";
import { SwipeRow } from "./SwipeRow";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { WorkspaceDisclosure, WorkspaceFolderIcon, WorkspaceChevron } from "./WorkspaceDisclosure";
import { projectName } from "@/lib/session-projects";
import { buildEdgeDashboard, createEdgeRecentReader, type EdgeProject, type EdgeSession } from "@/lib/edge-dashboard";
import { edgeDeviceConnectionLabel } from "@/lib/edge-devices";
import { homeRecentSummary } from "@/lib/home-dashboard";
import { workspaceAliasKey, type HomeSettings } from "@/lib/home-preferences";
import { DismissedModalAction } from "@/lib/host-screen-flow";
import { peekConnection } from "@/lib/connection";
import type { StoredHost } from "@/lib/hosts";
import type { HostRuntime } from "@/lib/store";
import { recentSessions } from "@/lib/recent-sessions";
import { useOrchestrationSnapshot } from "@/lib/use-orchestration-snapshot";
import { radius, space, useMobileTheme, type ThemePalette } from "@/lib/theme";

const sessionLabels = { starting: "启动中", running: "运行中", waiting_approval: "待审批", waiting_input: "待回答", idle: "空闲", completed: "已完成", done: "已结束", died: "已退出" };
const EMPTY_PATHS: readonly string[] = [];

/** Independent observers let a slow/offline host leave the rest of the fleet responsive. */
function WorkspaceObserver({ hostId, runtime, onPaths }: {
  hostId: string; runtime?: HostRuntime; onPaths: (id: string, paths: readonly string[]) => void;
}) {
  const snapshot = useOrchestrationSnapshot(peekConnection(hostId), runtime?.status ?? "idle", 15_000);
  const paths = useMemo(() => snapshot?.worktreeAssets?.map((asset) => asset.path) ?? EMPTY_PATHS, [snapshot]);
  useEffect(() => { onPaths(hostId, paths); }, [hostId, onPaths, paths]);
  return null;
}

type ListRow = { kind: "heading"; key: string; title: string; create?: "session" | "directory" }
  | { kind: "empty"; key: string; title: string }
  | { kind: "session"; key: string; value: EdgeSession }
  | { kind: "project"; key: string; value: EdgeProject };

export function EdgeDashboard({ hosts, selectedHosts, runtimes, bottomInset, homeSettings, onSelectHosts, onOpenHost,
  onOpenSession, onRefreshHost, onCreateSession, onCreateDirectory, onChangeHomeSettings,
  choosingOrchestration, onOpenOrchestration, onCancelOrchestration }: {
  hosts: StoredHost[]; selectedHosts: StoredHost[]; runtimes: Record<string, HostRuntime>; bottomInset: number;
  homeSettings: HomeSettings; onSelectHosts: (ids: string[]) => void; onOpenHost: (id: string) => void;
  onOpenSession: (hostId: string, sessionId: string) => void; onRefreshHost: (id: string) => void;
  onCreateSession: (hostId: string, cwd?: string) => void; onCreateDirectory: (hostId: string) => void;
  onChangeHomeSettings: (patch: Partial<HomeSettings>) => void;
  choosingOrchestration: boolean;
  onOpenOrchestration: (hostId: string) => void;
  onCancelOrchestration: () => void;
}) {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const listRef = useRef<FlatList<ListRow>>(null);
  useEffect(() => {
    if (choosingOrchestration) listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [choosingOrchestration]);
  const [createKind, setCreateKind] = useState<"session" | "directory" | null>(null);
  const [navigation] = useState(() => new DismissedModalAction());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<EdgeProject | null>(null);
  const [alias, setAlias] = useState("");
  const [managedPaths, setManagedPaths] = useState<Record<string, readonly string[]>>({});
  const onPaths = useCallback((id: string, paths: readonly string[]) => {
    setManagedPaths((current) => current[id]?.join("\u0000") === paths.join("\u0000") ? current : { ...current, [id]: paths });
  }, []);
  // Cache a stable multi-host snapshot for useSyncExternalStore; never merge by session ID alone.
  const getRecentSnapshot = useMemo(() => createEdgeRecentReader(selectedHosts, recentSessions.getHost), [selectedHosts]);
  const usage = useSyncExternalStore(recentSessions.subscribe, getRecentSnapshot, getRecentSnapshot);
  useEffect(() => { void recentSessions.load(); }, []);
  useEffect(() => () => navigation.cancel(), [navigation]);
  const data = useMemo(() => buildEdgeDashboard(selectedHosts, runtimes, homeSettings.recentSessionLimit,
    (id) => usage[selectedHosts.findIndex((host) => host.id === id)] ?? {}, managedPaths),
  [homeSettings.recentSessionLimit, managedPaths, runtimes, selectedHosts, usage]);
  const rows = useMemo<ListRow[]>(() => selectedHosts.length === 0 ? [] : [
    ...(data.approvals.length ? [{ kind: "heading" as const, key: "approvals", title: `待审批 · ${data.approvals.length}` },
      ...data.approvals.map((value) => ({ kind: "session" as const, key: `approval:${value.key}`, value }))] : []),
    { kind: "heading", key: "recent", title: "最近对话", create: "session" },
    ...data.recent.map((value) => ({ kind: "session" as const, key: `recent:${value.key}`, value })),
    ...(data.recent.length ? [] : [{ kind: "empty" as const, key: "recent-empty", title: "创建或打开对话后，会显示在这里。" }]),
    { kind: "heading", key: "projects", title: `工作目录 · ${data.projects.length}`, create: "directory" },
    ...data.projects.map((value) => ({ kind: "project" as const, key: `project:${value.key}`, value })),
    ...(data.projects.length ? [] : [{ kind: "empty" as const, key: "projects-empty", title: "设备上的工作目录会在连接后同步。" }]),
  ], [data, selectedHosts.length]);
  const connected = selectedHosts.filter((host) => runtimes[host.id]?.status === "connected").length;
  const loading = selectedHosts.some((host) => ["connecting", "reconnecting"].includes(runtimes[host.id]?.status ?? "idle"));
  const readyHosts = selectedHosts.filter((host) => runtimes[host.id]?.status === "connected");

  const startCreate = (kind: "session" | "directory"): void => {
    if (readyHosts.length === 1) {
      if (kind === "directory") onCreateDirectory(readyHosts[0]!.id);
      else onCreateSession(readyHosts[0]!.id);
    } else if (readyHosts.length > 1) {
      setCreateKind(kind);
    }
  };

  const sessionRow = (value: EdgeSession) => {
    const { host, session, recent, time } = value;
    const offline = runtimes[host.id]?.status !== "connected";
    return <Pressable accessibilityRole="button" accessibilityLabel={`${session.title}，${host.name}`}
      onPress={() => onOpenSession(host.id, session.id)} style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
      <View style={styles.line}><AgentIcon agent={session.agent} size={18} />
        <Text style={styles.itemTitle} numberOfLines={1}>{session.title || "未命名对话"}</Text>
        <Text style={[styles.meta, session.status === "waiting_approval" && { color: palette.warn }]}>{sessionLabels[session.status]}</Text>
      </View>
      <Text style={styles.summary} numberOfLines={1}>{homeRecentSummary(session, recent)}</Text>
      <Text style={styles.meta} numberOfLines={1}>{host.name}{offline ? " · 离线缓存" : ""} · {new Date(time).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</Text>
    </Pressable>;
  };
  const projectRow = (value: EdgeProject) => {
    const { host, project, key, managed } = value;
    const expanded = expandedKeys.has(key);
    const online = runtimes[host.id]?.status === "connected";
    const title = homeSettings.workspaceAliases[workspaceAliasKey(host.id, project.path)]
      || projectName(project.path);
    return <View style={styles.project}>
      <WorkspaceDisclosure expanded={expanded} header={(progress) => <SwipeRow actions={[
        ...(online ? [{ id: "create-session", label: "新建对话", symbol: "plus" as const, color: palette.accent, onPress: () => onCreateSession(host.id, project.path) }] : []),
        { id: "edit-workspace", label: "修改名称", symbol: "pencil" as const, color: palette.accentDim, foregroundColor: palette.text, onPress: () => { setEditing(value); setAlias(homeSettings.workspaceAliases[workspaceAliasKey(host.id, project.path)] ?? ""); } },
      ]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${title}，${host.name}，${project.sessions.length} 个对话`}
          accessibilityState={{ expanded }} onPress={() => setExpandedKeys((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })}
          style={({ pressed }) => [styles.item, pressed && styles.pressed]}>
          <View style={styles.projectIdentity}><WorkspaceFolderIcon progress={progress} size={18} color={palette.accent} />
            <WorkspaceHeader hostId={host.id} path={project.path} sid={project.sessions[0]?.id}
              name={title} sessionCount={project.sessions.length} />
            <WorkspaceChevron progress={progress} size={16} color={palette.textFaint} />
          </View>
          <Text style={styles.meta} numberOfLines={1}>{host.name}{!online ? " · 离线缓存" : ""}{managed ? " · 任务工作区" : ""}{project.runningCount > 0 ? ` · ${project.runningCount} 个运行中` : ""}{project.pendingCount > 0 ? ` · ${project.pendingCount} 项待处理` : ""}</Text>
        </Pressable>
      </SwipeRow>}>
      <View style={styles.projectSessions}>{project.sessions.map((session) =>
        <Pressable key={session.id} accessibilityRole="button" onPress={() => onOpenSession(host.id, session.id)}
          style={({ pressed }) => [styles.child, pressed && styles.pressed]}>
          <AgentIcon agent={session.agent} size={16} /><Text style={styles.itemTitle} numberOfLines={1}>{session.title || "未命名对话"}</Text>
          <Text style={styles.meta}>{sessionLabels[session.status]}</Text>
        </Pressable>)}
        {online && <Pressable accessibilityRole="button" onPress={() => onCreateSession(host.id, project.path)} style={styles.button}>
          <Text style={styles.link}>在此目录新建对话</Text>
        </Pressable>}
      </View>
      </WorkspaceDisclosure>
    </View>;
  };

  return <View style={styles.container}>
    {selectedHosts.map((host) => <WorkspaceObserver key={host.id} hostId={host.id} runtime={runtimes[host.id]} onPaths={onPaths} />)}
    <FlatList ref={listRef} testID="edge-dashboard" data={rows} keyExtractor={(row) => row.key} removeClippedSubviews={false}
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset + space.xl }]}
      refreshControl={<RefreshControl refreshing={loading} tintColor={palette.accent} onRefresh={() => selectedHosts.forEach((host) => onRefreshHost(host.id))} />}
      ListHeaderComponent={<View style={styles.header}>
        <EdgeDeviceCard hosts={hosts} selectedHosts={selectedHosts} runtimes={runtimes}
          choosingOrchestration={choosingOrchestration} onSelectHosts={onSelectHosts} onOpenHost={onOpenHost}
          onOpenOrchestration={onOpenOrchestration} onCancelOrchestration={onCancelOrchestration} />
        {selectedHosts.length > 0 && connected < selectedHosts.length && <Text style={styles.notice}>
          {loading ? "正在连接设备，内容会陆续显示。" : "部分设备离线；可下拉重连，或长按设备查看。"}
        </Text>}
      </View>}
      ListEmptyComponent={<View style={styles.empty}><Icon name={selectedHosts.length ? "bubble.left.and.text.bubble.right" : "desktopcomputer"} size={32} color={palette.textFaint} />
        <Text style={styles.emptyTitle}>{selectedHosts.length ? loading ? "正在加载设备对话" : "还没有可显示的对话和工作目录" : "选择设备，开始汇总"}</Text>
        <Text style={styles.meta}>{selectedHosts.length ? "设备上的对话同步后会出现在这里。" : "点击上方设备即可选择，下次进入会保留你的选择。"}</Text>
      </View>}
      renderItem={({ item }) => item.kind === "heading" ? <View style={styles.sectionHeading}>
        <Text style={styles.heading}>{item.title}</Text>
        {item.create && <Pressable accessibilityRole="button"
          accessibilityLabel={item.create === "directory" ? "新建目录" : "新建对话"}
          accessibilityState={{ disabled: readyHosts.length === 0 }} disabled={!readyHosts.length}
          onPress={() => startCreate(item.create!)} style={[styles.button, !readyHosts.length && styles.unselected]}>
          <Icon name="plus" size={14} color={palette.accent} /><Text style={styles.link}>{item.create === "directory" ? "新建目录" : "新对话"}</Text>
        </Pressable>}
      </View> : item.kind === "empty" ? <Text style={styles.sectionEmpty}>{item.title}</Text>
        : item.kind === "session" ? sessionRow(item.value) : projectRow(item.value)}
      ItemSeparatorComponent={() => <View style={styles.gap} />}
    />
    <Sheet visible={createKind !== null} title={createKind === "directory" ? "选择新建目录的设备" : "选择新对话的设备"}
      onClose={() => { navigation.cancel(); setCreateKind(null); }} onDismiss={() => navigation.dismiss()}>
      {readyHosts.map((host) => <SheetAction key={host.id} label={host.name} detail={edgeDeviceConnectionLabel(runtimes[host.id])} symbol="desktopcomputer"
        onPress={() => { const kind = createKind; navigation.defer(() => kind === "directory" ? onCreateDirectory(host.id) : onCreateSession(host.id)); setCreateKind(null); }} />)}
    </Sheet>
    <PromptDialog visible={editing !== null} title="工作目录名称" message={editing ? `${editing.host.name} · ${editing.project.path}` : undefined}
      value={alias} onChangeText={setAlias} onCancel={() => setEditing(null)} onSubmit={(value) => {
        if (editing) { const aliases = { ...homeSettings.workspaceAliases }; const key = workspaceAliasKey(editing.host.id, editing.project.path);
          if (value.trim()) aliases[key] = value.trim(); else delete aliases[key];
          onChangeHomeSettings({ workspaceAliases: aliases }); }
        setEditing(null);
      }} />
  </View>;
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: palette.bg },
    projectIdentity: { flexDirection: "row", alignItems: "center", gap: 8 },
    content: { padding: space.lg, width: "100%", maxWidth: 840, alignSelf: "center" },
    header: { gap: space.xs }, unselected: { opacity: 0.45 },
    button: { minHeight: 44, paddingHorizontal: 8, flexDirection: "row", gap: 4, alignItems: "center", justifyContent: "center" },
    link: { fontSize: 13, color: palette.accent, fontWeight: "600" },
    notice: { color: palette.textDim, fontSize: 12, lineHeight: 18, paddingBottom: 4 },
    sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44, gap: space.sm },
    heading: { color: palette.text, fontSize: 17, fontWeight: "600", flex: 1 },
    sectionEmpty: { color: palette.textFaint, fontSize: 12, lineHeight: 18, paddingBottom: space.sm },
    item: { backgroundColor: palette.surface, borderRadius: radius.md, padding: space.md, gap: 8 },
    line: { flexDirection: "row", alignItems: "center", gap: 8 },
    itemTitle: { color: palette.text, fontSize: 14, fontWeight: "500", flex: 1 },
    summary: { color: palette.textDim, fontSize: 13, lineHeight: 19 }, meta: { color: palette.textFaint, fontSize: 11, lineHeight: 17 },
    project: { backgroundColor: palette.surface, borderRadius: radius.md, overflow: "hidden" },
    projectSessions: { paddingHorizontal: space.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
    child: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48 },
    gap: { height: 7 }, pressed: { backgroundColor: palette.pressed },
    empty: { alignItems: "center", paddingVertical: 48, gap: 12 }, emptyTitle: { color: palette.textDim, fontSize: 15, textAlign: "center" },
  });
}
