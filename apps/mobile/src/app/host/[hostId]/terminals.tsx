import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../../components/Icon";
import { Sheet } from "../../../components/Sheet";
import { WorkspacePicker } from "../../../components/WorkspacePicker";
import { PendingSessionCreation } from "../../../lib/host-screen-flow";
import { SessionCreateError } from "../../../lib/connection";
import { DEFAULT_HOME_SETTINGS, workspaceAliasKey } from "../../../lib/home-preferences";
import { projectName } from "../../../lib/session-projects";
import { sortSessions, useApp } from "../../../lib/store";
import {
  MONOSPACE_FONT,
  radius,
  useMobileTheme,
  type ThemePalette,
} from "../../../lib/theme";
import {
  isTerminalEnded,
  supportsRemoteTerminal,
  REMOTE_TERMINAL_UNAVAILABLE,
} from "../../../lib/terminal-session";
import { useHostConnection } from "../../../lib/use-host-connection";
import { useTerminalActions } from "../../../lib/use-terminal-actions";
import { useTerminalClose } from "../../../lib/use-terminal-close";
import {
  normalizeWorkspacePath,
  useHydratedWorkspaceConcepts,
  workspacePathKey,
} from "../../../lib/workspace-concepts";

function formatTerminalCreateError(failure: unknown): string {
  if (failure instanceof SessionCreateError && failure.reason === "shell_not_allowed") {
    return "此设备尚未获得终端权限，请在电脑端为该设备开启允许 Shell 后重试。";
  }
  if (failure instanceof SessionCreateError && failure.message === "runtime worker is unavailable") {
    return "电脑端终端服务暂不可用，请检查电脑端运行状态后再创建终端。";
  }
  if (failure instanceof Error && failure.message) {
    return failure.message;
  }
  return "创建终端失败，请重试。";
}

export default function TerminalsScreen() {
  const { hostId, cwd: initialCwdParam } = useLocalSearchParams<{
    hostId: string;
    cwd?: string;
  }>();
  const { host, conn, runtime } = useHostConnection(hostId);
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
  const { savedWorkspaces } = useHydratedWorkspaceConcepts();
  const workspaceAliases = useApp(
    (state) => state.homeSettings?.workspaceAliases ?? DEFAULT_HOME_SETTINGS.workspaceAliases,
  );

  const [cwd, setCwd] = useState(() => (typeof initialCwdParam === "string" ? initialCwdParam : ""));
  const [homeCwd, setHomeCwd] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [createAfterPick, setCreateAfterPick] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closeTarget, setCloseTarget] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const terminalClose = useTerminalClose(conn, closeTarget ?? "");
  const terminalActions = useTerminalActions(conn);
  const [pending] = useState(() => new PendingSessionCreation());
  const mountedRef = useRef(true);
  const createAttemptRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const supported = supportsRemoteTerminal(runtime.hostInfo);
  const connected = runtime.status === "connected" && conn?.host.id === hostId;
  const working = creating || terminalActions.busy !== null;

  const sessions = useMemo(
    () =>
      sortSessions(runtime.sessions).filter(
        (session) => session.agent === "shell" && session.kind === "pty",
      ),
    [runtime.sessions],
  );

  const activeCount = useMemo(
    () => sessions.filter((session) => !isTerminalEnded(session)).length,
    [sessions],
  );

  const displayWorkspaceName = useCallback(
    (path: string): string => {
      const alias = hostId ? workspaceAliases[workspaceAliasKey(hostId, path)]?.trim() : undefined;
      return alias || projectName(path) || path;
    },
    [hostId, workspaceAliases],
  );

  const workspaceChoices = useMemo(() => {
    const homeKey = homeCwd ? workspacePathKey(homeCwd) : "";
    const seen = new Set<string>();
    if (homeKey) seen.add(homeKey);
    const items: { path: string; label: string }[] = [];
    const pushPath = (rawPath: string) => {
      const normalized = normalizeWorkspacePath(rawPath);
      if (!normalized) return;
      const key = workspacePathKey(normalized);
      if (!key || seen.has(key)) return;
      seen.add(key);
      items.push({ path: normalized, label: displayWorkspaceName(normalized) });
    };
    for (const ws of (hostId ? savedWorkspaces[hostId] : undefined) ?? []) {
      pushPath(ws);
    }
    for (const session of sortSessions(runtime.sessions)) {
      if (!session.archived && session.cwd) pushPath(session.cwd);
    }
    return items.slice(0, 10);
  }, [displayWorkspaceName, homeCwd, hostId, runtime.sessions, savedWorkspaces]);

  useFocusEffect(
    useCallback(() => {
      setCreating(false);
      return () => {
        createAttemptRef.current++;
        pending.cancel();
      };
    }, [pending]),
  );

  useFocusEffect(
    useCallback(() => {
      if (!conn || !connected || !supported) return;
      let cancelled = false;
      void conn
        .workspaceList("", "home")
        .then((listing) => {
          if (!cancelled && listing.cwd) setHomeCwd(listing.cwd);
        })
        .catch((failure) => {
          if (cancelled) return;
          const message = failure instanceof Error ? failure.message : "";
          if (message === "被新的请求取代") return;
        });
      return () => {
        cancelled = true;
      };
    }, [conn, connected, supported]),
  );

  const create = useCallback(
    (overrideCwd?: string): void => {
      if (!conn || !connected || !supported || pending.pending || working) return;
      const attemptId = ++createAttemptRef.current;
      setError(null);
      setCreating(true);

      void (async () => {
        let directory = (overrideCwd ?? cwd).trim() || homeCwd.trim();
        if (!directory) {
          try {
            const listing = await conn.workspaceList("", "home");
            if (!mountedRef.current || attemptId !== createAttemptRef.current) return;
            if (listing.cwd) setHomeCwd(listing.cwd);
            directory = listing.cwd.trim();
          } catch (failure) {
            if (!mountedRef.current || attemptId !== createAttemptRef.current) return;
            setCreating(false);
            const message = failure instanceof Error ? failure.message : "";
            setError(
              message && message !== "被新的请求取代"
                ? `无法读取电脑主目录（${message}），请手动选择起始目录。`
                : "请先选择终端起始目录。",
            );
            setCreateAfterPick(true);
            setPickerOpen(true);
            return;
          }
        }

        if (!directory) {
          if (!mountedRef.current || attemptId !== createAttemptRef.current) return;
          setCreating(false);
          setError("请先选择终端起始目录。");
          setCreateAfterPick(true);
          setPickerOpen(true);
          return;
        }

        // A tracked create is never queued or retried across reconnects. Returning to
        // the list reuses the existing PTY instead of starting a duplicate shell.
        pending.track(
          conn.createSessionTracked("shell", directory, undefined, "pty"),
          (session) => {
            if (!mountedRef.current) return;
            setCreating(false);
            router.push(`/host/${hostId}/session/${session.id}`);
          },
          (failure) => {
            if (!mountedRef.current) return;
            setCreating(false);
            setError(formatTerminalCreateError(failure));
          },
        );
      })();
    },
    [conn, connected, cwd, homeCwd, hostId, pending, supported, working],
  );

  const trimmedCwd = cwd.trim();
  const isHomeSelected =
    trimmedCwd.length === 0 ||
    (homeCwd.length > 0 && workspacePathKey(trimmedCwd) === workspacePathKey(homeCwd));

  if (!supported) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: "远程终端", headerBackButtonDisplayMode: "minimal" }} />
        <View style={styles.content}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>
              {runtime.hostInfo ? REMOTE_TERMINAL_UNAVAILABLE : "正在确认设备类型…"}
            </Text>
            <Text style={styles.detail}>连接支持终端的电脑后可新建和管理 Shell 终端。</Text>
            {!connected && (
              <Pressable
                onPress={() => conn?.kick()}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryButtonText}>重连设备</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: `${host?.name ?? "设备"} · 终端`,
          headerBackButtonDisplayMode: "minimal",
        }}
      />
      <FlatList
        data={sessions}
        keyExtractor={(session) => session.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}
        ListHeaderComponent={
          <View style={styles.header}>
            {!connected && (
              <View style={styles.connectionBanner}>
                <View style={styles.warnDot} />
                <Text style={[styles.connectionText, { flex: 1 }]}>
                  {runtime.lastError ?? "正在连接设备，连接后可新建或进入终端。"}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => conn?.kick()}
                  style={({ pressed }) => [styles.reconnectPill, pressed && styles.pressed]}
                >
                  <Text style={styles.reconnectPillText}>重连</Text>
                </Pressable>
              </View>
            )}

            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardIconBadge}>
                  <Icon name="terminal" size={18} color={palette.text} />
                </View>
                <View style={styles.cardHeaderCopy}>
                  <Text style={styles.cardTitle}>新建 Shell 终端</Text>
                  <Text style={styles.detail}>
                    电脑默认 Shell · 支持中文输入栏、方向键连发、88 列宽屏与链接提取
                  </Text>
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.sectionCaption}>工作区与起始目录</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={styles.workspaceChips}
                >
                  <Pressable
                    disabled={working}
                    onPress={() => {
                      setCwd("");
                      setError(null);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isHomeSelected, disabled: working }}
                    accessibilityLabel="主目录"
                    style={({ pressed }) => [
                      styles.workspaceChip,
                      isHomeSelected && styles.workspaceChipActive,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Icon
                      name="house.fill"
                      size={13}
                      color={isHomeSelected ? palette.bg : palette.textDim}
                    />
                    <Text
                      style={[
                        styles.workspaceChipText,
                        isHomeSelected && styles.workspaceChipTextActive,
                      ]}
                    >
                      主目录 (~)
                    </Text>
                  </Pressable>

                  {workspaceChoices.map((ws) => {
                    const selected =
                      trimmedCwd.length > 0 &&
                      workspacePathKey(trimmedCwd) === workspacePathKey(ws.path);
                    return (
                      <Pressable
                        key={ws.path}
                        disabled={working}
                        onPress={() => {
                          setCwd(ws.path);
                          setError(null);
                        }}
                        accessibilityRole="button"
                        accessibilityState={{ selected, disabled: working }}
                        accessibilityLabel={`工作区 ${ws.label}`}
                        style={({ pressed }) => [
                          styles.workspaceChip,
                          selected && styles.workspaceChipActive,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Icon
                          name="folder.fill"
                          size={13}
                          color={selected ? palette.bg : palette.textDim}
                        />
                        <Text
                          style={[
                            styles.workspaceChipText,
                            selected && styles.workspaceChipTextActive,
                          ]}
                          numberOfLines={1}
                        >
                          {ws.label}
                        </Text>
                      </Pressable>
                    );
                  })}

                  <Pressable
                    disabled={!connected || working}
                    onPress={() => {
                      setCreateAfterPick(false);
                      setPickerOpen(true);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="浏览并选择目录"
                    style={({ pressed }) => [
                      styles.workspaceChip,
                      (!connected || working) && styles.disabled,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Icon name="folder.badge.plus" size={14} color={palette.textDim} />
                    <Text style={styles.workspaceChipText}>浏览…</Text>
                  </Pressable>
                </ScrollView>

                <View style={styles.pathShell}>
                  <TextInput
                    style={styles.input}
                    value={cwd}
                    onChangeText={(next) => {
                      setCwd(next);
                      if (error) setError(null);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!working}
                    placeholder={
                      homeCwd ? `${homeCwd}（主目录）` : "留空使用电脑的用户主目录"
                    }
                    placeholderTextColor={palette.textFaint}
                    accessibilityLabel="终端起始目录"
                  />
                  {trimmedCwd.length > 0 && !working && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="清空起始目录"
                      hitSlop={8}
                      onPress={() => setCwd("")}
                      style={styles.inlineIconButton}
                    >
                      <Icon name="xmark.circle.fill" size={16} color={palette.textFaint} />
                    </Pressable>
                  )}
                  <Pressable
                    disabled={!connected || working}
                    accessibilityRole="button"
                    accessibilityLabel="选择终端起始目录"
                    onPress={() => {
                      setCreateAfterPick(false);
                      setPickerOpen(true);
                    }}
                    style={[styles.browseButton, (!connected || working) && styles.disabled]}
                  >
                    <Icon name="folder.fill" size={17} color={palette.text} />
                  </Pressable>
                </View>
              </View>

              <Pressable
                disabled={!connected || working}
                onPress={() => create()}
                accessibilityRole="button"
                accessibilityLabel="新建终端"
                accessibilityState={{ disabled: !connected || working, busy: creating }}
                style={({ pressed }) => [
                  styles.primaryButton,
                  (!connected || working) && styles.disabled,
                  pressed && styles.primaryButtonPressed,
                ]}
              >
                {creating ? (
                  <ActivityIndicator size="small" color={palette.bg} />
                ) : (
                  <Icon name="plus" size={17} color={palette.bg} weight="semibold" />
                )}
                <Text style={styles.primaryButtonText}>
                  {creating ? "正在启动终端…" : "新建终端"}
                </Text>
              </Pressable>
            </View>

            {error && (
              <View style={styles.errorBanner}>
                <Icon name="exclamationmark.triangle.fill" size={16} color={palette.warn} />
                <Text accessibilityRole="alert" style={styles.errorText}>
                  {error}
                </Text>
              </View>
            )}
            {terminalActions.error && (
              <View style={styles.errorBanner}>
                <Icon name="exclamationmark.triangle.fill" size={16} color={palette.warn} />
                <Text accessibilityRole="alert" style={styles.errorText}>
                  {terminalActions.error}
                </Text>
              </View>
            )}

            <View style={styles.listSectionHeader}>
              <Text style={styles.sectionTitle}>已有终端 · {String(sessions.length)}</Text>
              {activeCount > 0 && (
                <View style={styles.liveCountPill}>
                  <View style={styles.liveDot} />
                  <Text style={styles.liveCountText}>{String(activeCount)} 运行中</Text>
                </View>
              )}
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyCard}>
            <Icon name="terminal" size={22} color={palette.textFaint} />
            <Text style={styles.emptyTitle}>
              {runtime.sessionsLoaded ? "还没有打开的 Shell 终端" : "正在读取设备上的终端…"}
            </Text>
            <Text style={styles.emptyDetail}>
              点击上方「新建终端」即可在主目录或所选工作区启动；离开页面会保留后台进程。
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const ended = isTerminalEnded(item);
          const wsLabel =
            homeCwd && workspacePathKey(item.cwd) === workspacePathKey(homeCwd)
              ? "主目录"
              : displayWorkspaceName(item.cwd);
          return (
            <View style={styles.sessionCard}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${item.title || "终端"}，${ended ? "已结束" : "打开终端"}`}
                onPress={() => router.push(`/host/${hostId}/session/${item.id}`)}
                style={({ pressed }) => [styles.openSession, pressed && styles.pressed]}
              >
                <View style={[styles.sessionIconWrap, ended && styles.sessionIconWrapEnded]}>
                  <Icon
                    name="terminal"
                    size={18}
                    color={ended ? palette.textFaint : palette.text}
                  />
                </View>
                <View style={styles.copy}>
                  <View style={styles.sessionTitleRow}>
                    <Text style={styles.sessionTitle} numberOfLines={1}>
                      {item.title || "Shell 终端"}
                    </Text>
                    <View style={[styles.statusBadge, ended && styles.statusBadgeEnded]}>
                      {!ended && <View style={styles.liveDot} />}
                      <Text style={[styles.statusBadgeText, ended && styles.statusBadgeTextEnded]}>
                        {ended ? "已结束" : "运行中"}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.sessionPath} numberOfLines={1} ellipsizeMode="middle">
                    {wsLabel ? `${wsLabel} · ${item.cwd}` : item.cwd}
                  </Text>
                </View>
                <Icon name="chevron.right" size={16} color={palette.textFaint} />
              </Pressable>

              <View style={styles.sessionActions}>
                {ended ? (
                  <>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`重启终端 ${item.title || item.id}`}
                      disabled={!connected || working}
                      onPress={() => {
                        void terminalActions.restart(item.id).then((session) => {
                          if (session) router.push(`/host/${hostId}/session/${session.id}`);
                        });
                      }}
                      style={({ pressed }) => [
                        styles.actionIconBtn,
                        (!connected || working) && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      {terminalActions.busy?.sid === item.id &&
                      terminalActions.busy.kind === "restart" ? (
                        <ActivityIndicator size="small" color={palette.text} />
                      ) : (
                        <Icon name="arrow.clockwise" size={17} color={palette.text} />
                      )}
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`删除终端 ${item.title || item.id}`}
                      disabled={working}
                      onPress={() => setDeleteTarget(item.id)}
                      style={({ pressed }) => [
                        styles.actionIconBtn,
                        working && styles.disabled,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Icon name="trash" size={17} color={palette.danger} />
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`关闭终端 ${item.title || item.id}`}
                    onPress={() => setCloseTarget(item.id)}
                    style={({ pressed }) => [styles.actionIconBtn, pressed && styles.pressed]}
                  >
                    <Icon name="xmark" size={16} color={palette.textDim} />
                  </Pressable>
                )}
              </View>
            </View>
          );
        }}
      />

      {conn && (
        <WorkspacePicker
          visible={pickerOpen}
          conn={conn}
          initialPath=""
          initialCwd={cwd}
          onClose={() => {
            setCreateAfterPick(false);
            setPickerOpen(false);
          }}
          onSelect={(selection) => {
            const shouldAutoCreate = createAfterPick;
            setCreateAfterPick(false);
            setCwd(selection.cwd);
            setError(null);
            setPickerOpen(false);
            if (shouldAutoCreate) {
              create(selection.cwd);
            }
          }}
        />
      )}

      <Sheet visible={closeTarget !== null} title="关闭终端" onClose={() => setCloseTarget(null)}>
        <Text style={styles.detail}>结束此终端进程及其中正在运行的命令。</Text>
        {terminalClose.error && (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {terminalClose.error}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="确认关闭终端"
          disabled={terminalClose.closing}
          onPress={() => {
            void terminalClose.close().then((closed) => {
              if (closed) setCloseTarget(null);
            });
          }}
          style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed]}
        >
          {terminalClose.closing ? (
            <ActivityIndicator size="small" color={palette.danger} />
          ) : (
            <Icon name="xmark" size={17} color={palette.danger} />
          )}
          <Text style={styles.dangerButtonText}>
            {terminalClose.closing ? "正在关闭…" : "关闭终端"}
          </Text>
        </Pressable>
      </Sheet>

      <Sheet visible={deleteTarget !== null} title="删除终端" onClose={() => setDeleteTarget(null)}>
        <Text style={styles.detail}>删除这条已结束的终端记录，工作区目录中的文件会保留。</Text>
        {terminalActions.error && (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {terminalActions.error}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="确认删除终端"
          disabled={working}
          onPress={() => {
            if (deleteTarget) {
              void terminalActions.remove(deleteTarget).then((deleted) => {
                if (deleted) setDeleteTarget(null);
              });
            }
          }}
          style={({ pressed }) => [styles.dangerButton, pressed && styles.pressed]}
        >
          {terminalActions.busy?.kind === "delete" ? (
            <ActivityIndicator size="small" color={palette.danger} />
          ) : (
            <Icon name="trash" size={17} color={palette.danger} />
          )}
          <Text style={styles.dangerButtonText}>
            {terminalActions.busy?.kind === "delete" ? "正在删除…" : "删除终端"}
          </Text>
        </Pressable>
      </Sheet>
    </View>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: palette.bg },
    content: {
      padding: 16,
      gap: 10,
      width: "100%",
      maxWidth: 860,
      alignSelf: "center",
    },
    header: { gap: 14, marginBottom: 4 },
    connectionBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: radius.md,
      backgroundColor: palette.warnBg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.warn,
    },
    warnDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: palette.warn },
    connectionText: { color: palette.warn, fontSize: 12.5, lineHeight: 18 },
    reconnectPill: {
      minHeight: 32,
      paddingHorizontal: 12,
      borderRadius: radius.pill,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      alignItems: "center",
      justifyContent: "center",
    },
    reconnectPillText: { color: palette.text, fontSize: 12.5, fontWeight: "600" },
    card: {
      backgroundColor: palette.surface,
      borderRadius: radius.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      padding: 16,
      gap: 14,
    },
    cardHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
    cardIconBadge: {
      width: 38,
      height: 38,
      borderRadius: 11,
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      alignItems: "center",
      justifyContent: "center",
    },
    cardHeaderCopy: { flex: 1, minWidth: 0, gap: 2 },
    cardTitle: { color: palette.text, fontSize: 15.5, fontWeight: "700", letterSpacing: -0.2 },
    detail: { color: palette.textFaint, fontSize: 12, lineHeight: 18 },
    fieldGroup: { gap: 8 },
    sectionCaption: { color: palette.textDim, fontSize: 12, fontWeight: "600" },
    workspaceChips: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 2 },
    workspaceChip: {
      minHeight: 34,
      maxWidth: 210,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 11,
      borderRadius: radius.pill,
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    workspaceChipActive: {
      backgroundColor: palette.text,
      borderColor: palette.text,
    },
    workspaceChipText: { color: palette.text, fontSize: 12.5, fontWeight: "600" },
    workspaceChipTextActive: { color: palette.bg },
    pathShell: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: 46,
      paddingLeft: 12,
      paddingRight: 4,
      borderRadius: radius.md,
      backgroundColor: palette.bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      gap: 4,
    },
    input: {
      flex: 1,
      minWidth: 0,
      minHeight: 44,
      color: palette.text,
      fontSize: 12.5,
      fontFamily: MONOSPACE_FONT,
    },
    inlineIconButton: {
      width: 34,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    browseButton: {
      width: 38,
      height: 38,
      borderRadius: 9,
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryButton: {
      minHeight: 46,
      flexDirection: "row",
      gap: 8,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.md,
      backgroundColor: palette.text,
    },
    primaryButtonPressed: { opacity: 0.85 },
    primaryButtonText: { color: palette.bg, fontSize: 14.5, fontWeight: "700" },
    secondaryButton: {
      minHeight: 42,
      alignSelf: "flex-start",
      paddingHorizontal: 14,
      borderRadius: radius.md,
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      alignItems: "center",
      justifyContent: "center",
    },
    secondaryButtonText: { color: palette.text, fontSize: 13.5, fontWeight: "600" },
    dangerButton: {
      minHeight: 46,
      marginTop: 8,
      flexDirection: "row",
      gap: 8,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.md,
      backgroundColor: palette.dangerBg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.danger,
    },
    dangerButtonText: { color: palette.danger, fontSize: 14, fontWeight: "700" },
    disabled: { opacity: 0.45 },
    pressed: { backgroundColor: palette.pressed },
    errorBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: radius.md,
      backgroundColor: palette.warnBg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.warn,
    },
    errorText: { flex: 1, color: palette.warn, fontSize: 12.5, lineHeight: 18 },
    listSectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 2,
    },
    sectionTitle: { color: palette.text, fontSize: 14, fontWeight: "700" },
    liveCountPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 9,
      paddingVertical: 3,
      borderRadius: radius.pill,
      backgroundColor: palette.successBg,
    },
    liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.success },
    liveCountText: { color: palette.success, fontSize: 11.5, fontWeight: "600" },
    emptyCard: {
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      paddingVertical: 32,
      paddingHorizontal: 20,
      borderRadius: radius.lg,
      backgroundColor: palette.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
    },
    emptyTitle: { color: palette.text, fontSize: 14, fontWeight: "600" },
    emptyDetail: { color: palette.textFaint, fontSize: 12, lineHeight: 18, textAlign: "center" },
    sessionCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: palette.surface,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      paddingRight: 6,
    },
    openSession: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 68,
      paddingVertical: 12,
      paddingLeft: 14,
      paddingRight: 8,
      borderRadius: radius.md,
    },
    sessionIconWrap: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: palette.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: palette.border,
      alignItems: "center",
      justifyContent: "center",
    },
    sessionIconWrapEnded: { opacity: 0.65 },
    copy: { flex: 1, minWidth: 0, gap: 4 },
    sessionTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    sessionTitle: { flexShrink: 1, color: palette.text, fontSize: 14, fontWeight: "600" },
    statusBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: radius.pill,
      backgroundColor: palette.successBg,
    },
    statusBadgeEnded: { backgroundColor: palette.surfaceRaised },
    statusBadgeText: { color: palette.success, fontSize: 10.5, fontWeight: "600" },
    statusBadgeTextEnded: { color: palette.textFaint },
    sessionPath: { color: palette.textFaint, fontSize: 11.5, fontFamily: MONOSPACE_FONT },
    sessionActions: { flexDirection: "row", alignItems: "center", gap: 2 },
    actionIconBtn: {
      width: 40,
      height: 40,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
  });
}
