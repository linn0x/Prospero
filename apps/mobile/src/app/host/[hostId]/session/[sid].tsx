import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useHeaderHeight } from "expo-router/build/react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import type {
  ApprovalPolicy,
  AgentMode,
  AgentModel,
  ChatDelivery,
  ChatSuggestion,
  ChatSuggestionKind,
  S2CMessage,
  SessionInfo,
  SubagentInfo,
  SubagentStatus,
  UsageWindow,
} from "@prospero/protocol";
import { ChatView } from "@/components/ChatView";
import { DismissKey } from "@/components/DismissKey";
import { Icon } from "@/components/Icon";
import { KeyBar } from "@/components/KeyBar";
import { QuickReplies } from "@/components/QuickReplies";
import { Terminal, type TerminalHandle } from "@/components/Terminal";
import { VoiceButton } from "@/components/VoiceButton";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import {
  pickFromCamera,
  pickFromLibrary,
  recoverPendingPickerResult,
  type ImagePickResult,
  type PickedImage,
  type PickerSource,
} from "@/lib/attach";
import { Meter, Row, Sheet, SheetAction } from "@/components/Sheet";
import { toast } from "@/components/Toast";
import { color, font, MONOSPACE_FONT, statusColor, utilizationColor } from "@/lib/theme";
import { matchCommands } from "@/lib/slash-commands";
import { setSessionArchived } from "@/lib/session-preferences";
import { sortSessions } from "@/lib/store";
import { useHostConnection } from "@/lib/use-host-connection";
import { coordinatorRunsBySession } from "@/lib/orchestration-overview";
import { useOrchestrationSnapshot } from "@/lib/use-orchestration-snapshot";
import { deliveryFailureText } from "@/lib/outbound-queue";
import { sessionLoadState } from "@/lib/session-load-state";
import { appendVoiceTranscript } from "@/lib/voice-input";
import {
  SYSTEM_TERMINAL_FONT_PREFERENCE,
  COMPOSER_THUMBNAIL_GAP,
  COMPOSER_THUMBNAIL_REMOVE_TARGET,
  COMPOSER_THUMBNAIL_SIZE,
  MIN_TOUCH_TARGET,
  TERMINAL_FONT_PREFERENCE_STORAGE_KEY,
  adjustTerminalFontSize,
  clampTerminalFontSize,
  parseTerminalFontPreference,
  resetTerminalFontPreference,
  serializeTerminalFontPreference,
  terminalFontSizeForPreference,
  type TerminalFontPreference,
} from "@/lib/terminal-font-size";
import type { ProjectFileReference } from "@/lib/file-references";
import {
  activeComposerToken,
  replaceComposerToken,
} from "@/lib/composer-completion";
import {
  MAX_COMPOSER_IMAGES,
  clearComposerDraft,
  clearPendingPickerContext,
  getPendingPickerContext,
  loadComposerDraft,
  removeComposerDraftAttachment,
  saveComposerDraft,
  type ComposerDraftScope,
} from "@/lib/composer-draft-store";

type UsageResult = Extract<S2CMessage, { type: "usage.result" }>;

/** 把 ISO 时间说成人话:「14:30」或「8/6 09:00」 */
function formatReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === now.toDateString()
    ? hhmm
    : `${String(d.getMonth() + 1)}/${String(d.getDate())} ${hhmm}`;
}

const statusText: Record<SessionInfo["status"], string> = {
  starting: "启动中",
  running: "运行中",
  waiting_approval: "待审批",
  waiting_input: "待回答",
  idle: "空闲就绪",
  completed: "运行完毕",
  done: "会话结束",
  died: "已退出",
};

const subagentStatusText: Record<SubagentStatus, string> = {
  starting: "启动中",
  running: "工作中",
  waiting_input: "待回答",
  idle: "可对话",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

/** 每秒刷新耗时;计时只重渲染标题,不牵动终端 WebView 与聊天列表。 */
function useElapsed(since: number | undefined): string {
  const [clock, setClock] = useState<{ since: number; label: string } | null>(null);
  useEffect(() => {
    if (since === undefined) return;
    const update = (): void => {
      const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
      if (seconds < 60) {
        setClock({ since, label: `${String(seconds)}s` });
        return;
      }
      const minutes = Math.floor(seconds / 60);
      setClock({
        since,
        label:
          minutes < 60
            ? `${String(minutes)}m ${String(seconds % 60)}s`
            : `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`,
      });
    };
    // 避免在 effect 主体同步 setState,同时让标题首帧尽快补上耗时。
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [since]);
  return since !== undefined && clock?.since === since ? clock.label : "";
}

function SessionHeaderTitle({
  session,
  pending,
  tightest,
  subagent,
}: {
  session?: SessionInfo;
  pending: number;
  tightest: UsageWindow | null;
  subagent?: SubagentInfo;
}) {
  const busy = !subagent && (session?.status === "running" || session?.status === "starting");
  const elapsed = useElapsed(
    busy || session?.status === "waiting_approval" ? session?.busySince : undefined,
  );
  const totals = session?.totals;
  const parts = session
    ? subagent
      ? [session.agent, "子 Agent", subagentStatusText[subagent.status], pending > 0 ? `${String(pending)} 项待处理` : ""]
          .filter(Boolean)
      : [
        session.agent,
        session.accountName ?? "",
        `${statusText[session.status]}${elapsed ? ` ${elapsed}` : ""}`,
        pending > 0 ? `${String(pending)} 项待处理` : "",
        session.messageQueue?.length
          ? `${String(session.messageQueue.length)} 条排队`
          : "",
        totals && totals.costUsd > 0 ? `$${totals.costUsd.toFixed(3)}` : "",
        tightest ? `${tightest.label} ${String(Math.round(tightest.utilization))}%` : "",
        ].filter(Boolean)
    : [];

  return (
    <View style={styles.headerTitle}>
      <Text style={styles.headerName} numberOfLines={1}>
        {subagent?.name ?? session?.title ?? "会话"}
      </Text>
      {session && (
        <View style={styles.headerMetaRow}>
          <View
            style={[
              styles.headerDot,
              {
                backgroundColor: subagent
                  ? subagent.status === "running" || subagent.status === "starting"
                    ? color.accent
                    : subagent.status === "failed"
                      ? color.danger
                      : color.textDim
                  : statusColor[session.status] ?? color.textDim,
              },
            ]}
          />
          <Text style={styles.headerSub} numberOfLines={1}>
            {parts.join(" · ")}
          </Text>
        </View>
      )}
    </View>
  );
}

function FoldableSessionRail({
  sessions,
  currentId,
  hostId,
  width,
}: {
  sessions: readonly SessionInfo[];
  currentId: string;
  hostId: string;
  width: number;
}) {
  return (
    <View style={[styles.sessionRail, { width }]}>
      <View style={styles.sessionRailHeader}>
        <Text style={styles.sessionRailTitle}>会话</Text>
        <Text style={styles.sessionRailCount}>{String(sessions.length)}</Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.sessionRailList}
        showsVerticalScrollIndicator={false}
      >
        {sessions.map((item) => {
          const selected = item.id === currentId;
          return (
            <Pressable
              key={item.id}
              style={({ pressed }) => [
                styles.sessionRailItem,
                selected && styles.sessionRailItemSelected,
                pressed && styles.controlPressed,
              ]}
              disabled={selected}
              onPress={() =>
                router.replace({
                  pathname: "/host/[hostId]/session/[sid]",
                  params: { hostId, sid: item.id },
                })
              }
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={`打开会话 ${item.title}`}
            >
              <View style={styles.sessionRailItemTop}>
                <View
                  style={[
                    styles.sessionRailStatus,
                    { backgroundColor: statusColor[item.status] ?? color.textFaint },
                  ]}
                />
                <Text style={styles.sessionRailItemTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.sessionRailAgent}>{item.agent}</Text>
              </View>
              <Text style={styles.sessionRailPath} numberOfLines={1} ellipsizeMode="middle">
                {item.cwd}
              </Text>
              {item.preview ? (
                <Text style={styles.sessionRailPreview} numberOfLines={2}>
                  {item.preview}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export default function SessionScreen() {
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const adaptiveLayout = useAdaptiveLayout();
  const { fontScale } = useWindowDimensions();
  const { hostId, sid, subagentId } = useLocalSearchParams<{
    hostId: string;
    sid: string;
    subagentId?: string;
  }>();
  const { conn, runtime } = useHostConnection(hostId);
  const [draft, setDraft] = useState("");
  const [draftHydratedFor, setDraftHydratedFor] = useState("");
  /** 被连接层拒绝的消息留在编辑器中，直到用户确认修改或重试。 */
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const inputRef = useRef<TextInput>(null);
  const appendTranscript = useCallback((text: string): void => {
    // 使用函数式更新，转写期间用户新打的字也不会被旧闭包覆盖。
    setDraft((current) => appendVoiceTranscript(current, text));
  }, []);
  const [focused, setFocused] = useState(false);
  const [pending, setPending] = useState(0);
  const [search, setSearch] = useState<string | null>(null);
  const [busyDelivery, setBusyDelivery] = useState<Exclude<ChatDelivery, "auto">>("queue");
  const [completionResult, setCompletionResult] = useState<{
    key: string;
    items: ChatSuggestion[];
    loading: boolean;
  }>({ key: "", items: [], loading: false });
  const completionSequence = useRef(0);

  const session = sid ? runtime.sessions[sid] : undefined;
  const orchestration = useOrchestrationSnapshot(conn, runtime.status, 8_000);
  const coordinatorRun = useMemo(
    () => coordinatorRunsBySession(orchestration?.runs ?? []).get(sid) ?? null,
    [orchestration, sid],
  );
  const orderedSessions = useMemo(
    () => sortSessions(runtime.sessions),
    [runtime.sessions],
  );
  const showSessionRail =
    adaptiveLayout.verticalPanes !== null ||
    (adaptiveLayout.width >= 960 && adaptiveLayout.height >= 560);
  const sessionRailWidth =
    adaptiveLayout.verticalPanes?.start ??
    Math.min(360, Math.max(288, adaptiveLayout.width * 0.32));
  const agentControls = session?.agentControls;
  const subagent = subagentId
    ? session?.subagents?.find((candidate) => candidate.id === subagentId)
    : undefined;
  const isSubagent = subagentId !== undefined;
  const isStructured = session?.kind === "structured";
  const isChat = isStructured;
  const busy = isSubagent
    ? subagent?.status === "running" ||
      subagent?.status === "starting" ||
      subagent?.status === "waiting_input"
    : session?.status === "running" ||
      session?.status === "starting" ||
      session?.status === "waiting_approval" ||
      session?.status === "waiting_input";
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [yoloConfirmOpen, setYoloConfirmOpen] = useState(false);
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const [controlsLoading, setControlsLoading] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [models, setModels] = useState<AgentModel[]>([]);
  const [modes, setModes] = useState<AgentMode[]>([]);
  const [currentModel, setCurrentModel] = useState<string | undefined>(undefined);
  const [currentEffort, setCurrentEffort] = useState<string | undefined>(undefined);
  const [currentMode, setCurrentMode] = useState<string | undefined>(undefined);
  const displayedModel = currentModel ?? agentControls?.currentModel;
  const displayedEffort = currentEffort ?? agentControls?.currentEffort;
  const displayedMode = currentMode ?? agentControls?.currentMode;
  const [images, setImages] = useState<PickedImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const termRef = useRef<TerminalHandle>(null);
  const [terminalFontPreference, setTerminalFontPreference] = useState<TerminalFontPreference>(
    SYSTEM_TERMINAL_FONT_PREFERENCE,
  );
  const [terminalFontPreferenceHydrated, setTerminalFontPreferenceHydrated] = useState(false);
  const terminalFontPreferenceChanged = useRef(false);
  const fontSize = terminalFontSizeForPreference(terminalFontPreference, fontScale);
  const composerToken = useMemo(
    () => activeComposerToken(draft, selection.start),
    [draft, selection.start],
  );
  const completionKind: ChatSuggestionKind | null =
    composerToken?.kind === "file" || composerToken?.kind === "skill"
      ? composerToken.kind
      : null;
  const completionQuery = completionKind === null ? "" : composerToken?.query ?? "";
  const completionKey = completionKind === null ? "" : `${completionKind}\u0000${completionQuery}`;
  const suggestions = completionResult.key === completionKey ? completionResult.items : [];
  const completionLoading =
    completionKind !== null &&
    (completionResult.key !== completionKey || completionResult.loading);
  const composerScope = useMemo<ComposerDraftScope | null>(
    () => hostId && sid
      ? { hostId, sid, ...(subagentId ? { subagentId } : {}) }
      : null,
    [hostId, sid, subagentId],
  );
  const composerScopeKey = composerScope
    ? `${composerScope.hostId}\u0000${composerScope.sid}\u0000${composerScope.subagentId ?? ""}`
    : "";
  const draftHydrated = draftHydratedFor === composerScopeKey;

  // 深链冷启动时 hello.ok 的会话列表可能尚未进入 zustand。先 attach 同一个 sid，
  // 不跳转、不新建，等主机状态收敛后当前路由自然恢复为完整会话页。
  useEffect(() => {
    if (!conn || !sid || session || runtime.status !== "connected") return;
    conn.attach(sid);
  }, [conn, runtime.status, session, sid]);

  // Drafts are scoped to the exact host/session/subagent route. Do not autosave the previous
  // screen's empty initial state over a draft before this read completes.
  useEffect(() => {
    if (!composerScope) return;
    let alive = true;
    const start = setTimeout(() => {
      setDraftHydratedFor("");
      setDraft("");
      setSelection({ start: 0, end: 0 });
      setImages([]);
      setAttachmentError(null);
      void loadComposerDraft(composerScope)
        .then((restored) => {
          if (!alive) return;
          setDraft(restored.draft?.text ?? "");
          setSelection(restored.draft?.selection ?? { start: 0, end: 0 });
          setImages(restored.draft ? [...restored.draft.images] : []);
          if (restored.discardedAttachments > 0) {
            setAttachmentError("部分草稿图片的本地缓存已失效，已保留文字并移除这些图片。");
          }
          setDraftHydratedFor(composerScopeKey);
        })
        .catch((error: unknown) => {
          if (!alive) return;
          setAttachmentError(`无法恢复草稿：${error instanceof Error ? error.message : String(error)}`);
          setDraftHydratedFor(composerScopeKey);
        });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(start);
    };
  }, [composerScope, composerScopeKey]);

  // AsyncStorage deliberately receives only text, selection and file metadata; JPEG base64 stays
  // in the dedicated cache file and current in-memory image list.
  useEffect(() => {
    if (!composerScope || !draftHydrated) return;
    void saveComposerDraft(composerScope, { text: draft, selection, images }).catch((error: unknown) => {
      setAttachmentError(`无法保存草稿：${error instanceof Error ? error.message : String(error)}`);
    });
  }, [composerScope, draft, draftHydrated, images, selection]);

  // 字号是设备偏好，不应随主机或会话变化。没有保存项就保持 system，
  // 因而 useWindowDimensions() 的 fontScale 更新会在本次渲染立即生效。
  useEffect(() => {
    let alive = true;
    void AsyncStorage.getItem(TERMINAL_FONT_PREFERENCE_STORAGE_KEY)
      .then((raw) => {
        if (!alive) return;
        if (!terminalFontPreferenceChanged.current) {
          setTerminalFontPreference(parseTerminalFontPreference(raw));
        }
        setTerminalFontPreferenceHydrated(true);
      })
      .catch(() => {
        // 偏好读取失败时不阻塞终端；默认的 system 模式仍然可用。
        if (alive) setTerminalFontPreferenceHydrated(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const setCustomTerminalFontSize = useCallback((size: number): void => {
    terminalFontPreferenceChanged.current = true;
    const preference: TerminalFontPreference = {
      mode: "custom",
      size: clampTerminalFontSize(size),
    };
    setTerminalFontPreference(preference);
    const serialized = serializeTerminalFontPreference(preference);
    if (serialized) void AsyncStorage.setItem(TERMINAL_FONT_PREFERENCE_STORAGE_KEY, serialized);
  }, []);

  const followSystemTerminalFontSize = useCallback((): void => {
    terminalFontPreferenceChanged.current = true;
    setTerminalFontPreference(resetTerminalFontPreference());
    void AsyncStorage.removeItem(TERMINAL_FONT_PREFERENCE_STORAGE_KEY);
  }, []);

  useEffect(() => {
    const sequence = ++completionSequence.current;
    if (!conn || !sid || !isChat || completionKind === null) return;
    const key = `${completionKind}\u0000${completionQuery}`;
    const timer = setTimeout(() => {
      setCompletionResult({ key, items: [], loading: true });
      const requestId = `${Date.now().toString(36)}-${String(sequence)}`;
      void conn
        .chatComplete(sid, completionKind, completionQuery, requestId)
        .then((response) => {
          if (completionSequence.current !== sequence) return;
          setCompletionResult({ key, items: response.items, loading: false });
        })
        .catch(() => {
          if (completionSequence.current !== sequence) return;
          setCompletionResult({ key, items: [], loading: false });
        });
    }, 120);
    return () => clearTimeout(timer);
  }, [conn, sid, isChat, completionKind, completionQuery]);

  // 只显示最吃紧的那个窗口 —— 头部塞不下三个,而你关心的永远是先撞上的那个
  const tightest = (usage?.windows ?? []).reduce<UsageWindow | null>(
    (best, w) => (best === null || w.utilization > best.utilization ? w : best),
    null,
  );

  const openControls = useCallback((): void => {
    if (!conn || !sid || !agentControls || isSubagent) return;
    setControlsOpen(true);
    setControlsLoading(true);
    setControlError(null);
    const requests: Promise<void>[] = [];
    if (agentControls.model) {
      requests.push(
        conn.agentModels(sid).then((response) => {
          setModels(response.models);
          setCurrentModel(response.currentModel);
          setCurrentEffort(response.currentEffort);
        }),
      );
    }
    if (agentControls.mode) {
      requests.push(
        conn.agentModes(sid).then((response) => {
          setModes(response.modes);
          setCurrentMode(response.currentMode);
        }),
      );
    }
    void Promise.all(requests)
      .catch((error: unknown) => {
        setControlError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setControlsLoading(false));
  }, [conn, sid, agentControls, isSubagent]);

  const selectMode = useCallback(
    (mode: string): void => {
      if (!conn || !sid) return;
      setControlsLoading(true);
      setControlError(null);
      void conn
        .setAgentMode(sid, mode)
        .then((response) => {
          if (!response.ok) throw new Error(response.message ?? "模式切换失败");
          setCurrentMode(response.currentMode ?? mode);
          toast(response.message ?? "模式已切换");
        })
        .catch((error: unknown) => {
          setControlError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setControlsLoading(false));
    },
    [conn, sid],
  );

  const selectModel = useCallback(
    (model: string, effort?: string): void => {
      if (!conn || !sid) return;
      setControlsLoading(true);
      setControlError(null);
      void conn
        .setAgentModel(sid, model, effort)
        .then((response) => {
          if (!response.ok) throw new Error(response.message ?? "模型切换失败");
          setCurrentModel(response.currentModel ?? model);
          setCurrentEffort(response.currentEffort);
          toast(response.message ?? "模型已切换");
        })
        .catch((error: unknown) => {
          setControlError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => setControlsLoading(false));
    },
    [conn, sid],
  );

  const compactContext = useCallback((): void => {
    if (!conn || !sid) return;
    setControlsLoading(true);
    setControlError(null);
    void conn
      .compactAgent(sid)
      .then((response) => {
        if (!response.ok) throw new Error(response.message ?? "上下文压缩失败");
        toast(response.message ?? "上下文已压缩");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setControlError(message);
        toast(message);
      })
      .finally(() => setControlsLoading(false));
  }, [conn, sid]);

  const presentAttachmentError = useCallback((message: string): void => {
    setAttachmentError(message);
    Alert.alert("图片无法添加", message);
  }, []);

  const appendPickedImages = useCallback(
    async (picked: readonly PickedImage[]): Promise<void> => {
      if (!composerScope || picked.length === 0) return;
      const room = MAX_IMAGES - images.length;
      const accepted = picked.slice(0, Math.max(0, room));
      if (accepted.length === 0) {
        presentAttachmentError("最多只能添加 6 张图片。");
        return;
      }
      const next = [...images, ...accepted];
      try {
        // A selected image is persisted before it enters visible composer state.
        await saveComposerDraft(composerScope, { text: draft, selection, images: next });
        setImages(next);
        setAttachmentError(null);
      } catch (error) {
        await Promise.allSettled(accepted.map((image) => removeComposerDraftAttachment(composerScope, image.uri)));
        presentAttachmentError(`无法保存图片草稿：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [composerScope, draft, images, presentAttachmentError, selection],
  );

  const applyPickerResult = useCallback(
    async (result: ImagePickResult): Promise<void> => {
      if (result.status === "selected") {
        await appendPickedImages(result.images);
      } else if (result.status === "error") {
        presentAttachmentError(result.message);
      }
      // cancelled and permission_denied are handled by the initiating path. A genuine cancel stays silent.
    },
    [appendPickedImages, presentAttachmentError],
  );

  const pickAgainRef = useRef<(source: PickerSource) => void>(() => undefined);
  const startPicker = useCallback(
    async (source: PickerSource): Promise<void> => {
      if (!composerScope || !draftHydrated) return;
      const room = MAX_IMAGES - images.length;
      if (room <= 0) {
        Alert.alert("最多 6 张", "先移除几张再添加。");
        return;
      }
      try {
        // Android needs the exact draft safely flushed before it hands control to the picker activity.
        await saveComposerDraft(composerScope, { text: draft, selection, images });
      } catch (error) {
        presentAttachmentError(`无法保存草稿：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const pendingContext = Platform.OS === "android"
        ? { ...composerScope, source, createdAt: Date.now() }
        : undefined;
      const result = source === "library"
        ? await pickFromLibrary(room, pendingContext)
        : await pickFromCamera(pendingContext);
      if (result.status === "permission_denied") {
        const subject = result.source === "library" ? "相册" : "相机";
        Alert.alert(
          "需要权限",
          result.canAskAgain
            ? `允许访问${subject}后才能添加图片。`
            : `${subject}权限已被系统关闭。请在系统设置中允许 Prospero 访问${subject}。`,
          result.canAskAgain
            ? [
              { text: "取消", style: "cancel" },
              { text: "重新授权", onPress: () => pickAgainRef.current(result.source) },
            ]
            : [
              { text: "取消", style: "cancel" },
              { text: "打开系统设置", onPress: () => { void Linking.openSettings(); } },
            ],
        );
        return;
      }
      await applyPickerResult(result);
    },
    [applyPickerResult, composerScope, draft, draftHydrated, images, presentAttachmentError, selection],
  );
  useEffect(() => {
    pickAgainRef.current = (source) => { void startPicker(source); };
  }, [startPicker]);

  // getPendingResultAsync is global to Android's picker. Check our persisted context first so a
  // result can never be consumed while viewing a different host/session/subagent.
  useEffect(() => {
    if (Platform.OS !== "android" || !composerScope || !draftHydrated) return;
    let alive = true;
    void (async () => {
      try {
        const lookup = await getPendingPickerContext(composerScope);
        const pending = lookup.context;
        if (!pending) return;
        try {
          const result = await recoverPendingPickerResult(
            pending.source,
            pending.source === "camera" ? 1 : Math.max(1, MAX_IMAGES - images.length),
          );
          if (!alive) return;
          await applyPickerResult(result);
        } finally {
          // Normal return, cancellation, picker error and stale activity recovery all clear context.
          await clearPendingPickerContext(pending);
        }
      } catch (error) {
        if (alive) {
          presentAttachmentError(`无法恢复图片选择：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
    return () => { alive = false; };
  }, [applyPickerResult, composerScope, draftHydrated, images.length, presentAttachmentError]);

  const send = useCallback(
    (text: string, deliveryOverride?: ChatDelivery): void => {
      const t = text.trim();
      // 只带图不带字是合理的:一张报错截图本身就是问题
      if (!conn || !sid || (t.length === 0 && (!isChat || images.length === 0))) return;
      if (isChat) {
        if (!isSubagent && images.length === 0 && t === "/model") {
          openControls();
        } else if (!isSubagent && images.length === 0 && t === "/compact") {
          compactContext();
        } else if (!isSubagent && images.length === 0 && t === "/plan") {
          selectMode("plan");
        } else if (!isSubagent && images.length === 0 && t === "/skills") {
          setDraft("$");
          setSelection({ start: 1, end: 1 });
          requestAnimationFrame(() => inputRef.current?.focus());
          return;
        } else if (isSubagent && subagentId) {
          const result = conn.sendToSubagent(sid, subagentId, t);
          if (!result.accepted) {
            const message = deliveryFailureText(result);
            setDeliveryError(message);
            toast(message);
            return;
          }
        } else {
          const result = conn.chatSend(
            sid,
            t,
            images.map(({ mimeType, dataB64, name }) => ({
              mimeType,
              dataB64,
              ...(name ? { name } : {}),
            })),
            deliveryOverride ?? (busy ? busyDelivery : "auto"),
          );
          if (!result.accepted) {
            const message = deliveryFailureText(result);
            setDeliveryError(message);
            toast(message);
            return;
          }
          if (result.disposition === "queued") {
            toast("连接已断开，消息已在本机排队，恢复后会按顺序发送。");
          }
        }
        setImages([]);
      } else {
        const result = conn.inputText(sid, t + "\r");
        if (!result.accepted) {
          const message = deliveryFailureText(result);
          setDeliveryError(message);
          toast(message);
          return;
        }
      }
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setDraft("");
      setSelection({ start: 0, end: 0 });
      setDeliveryError(null);
      if (composerScope) void clearComposerDraft(composerScope);
      completionSequence.current++;
    },
    [
      conn,
      sid,
      isChat,
      images,
      busy,
      busyDelivery,
      isSubagent,
      subagentId,
      openControls,
      compactContext,
      selectMode,
      setDraft,
      setImages,
      composerScope,
    ],
  );

  // 会话打开时取一次;不轮询 —— 限流窗口是小时级的,盯着刷没意义
  useEffect(() => {
    if (!conn || !sid || !isStructured) return;
    let alive = true;
    void conn
      .usageGet(sid)
      .then((r) => {
        if (alive) setUsage(r);
      })
      .catch(() => {
        // 取不到就是没有,不打扰用户
      });
    return () => {
      alive = false;
    };
  }, [conn, sid, isStructured]);

  const showUsage = (): void => {
    if (!conn || !sid) return;
    setUsageOpen(true);
    setUsageError(null);
    void conn
      .usageGet(sid)
      .then(setUsage)
      .catch((e: unknown) => {
        setUsageError(e instanceof Error ? e.message : String(e));
      });
  };

  const attach = (): void => {
    if (!draftHydrated) return;
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      Alert.alert("最多 6 张", "先移除几张再添加。");
      return;
    }
    Alert.alert("添加图片", undefined, [
      { text: "从相册选", onPress: () => { void startPicker("library"); } },
      { text: "拍一张", onPress: () => { void startPicker("camera"); } },
      { text: "取消", style: "cancel" },
    ]);
  };

  const returnToHost = (): void => {
    if (router.canGoBack()) router.back();
    else if (isSubagent && hostId && sid) {
      router.replace({ pathname: "/host/[hostId]/session/[sid]", params: { hostId, sid } });
    } else if (hostId) router.replace(`/host/${hostId}`);
    else router.replace("/");
  };

  const returnToHostOverview = (): void => {
    if (hostId) router.replace(`/host/${hostId}`);
    else router.replace("/");
  };

  const retryColdStart = (): void => {
    if (!conn || !sid) return;
    conn.kick();
    if (conn.isConnected) conn.attach(sid);
  };

  const openFileReference = useCallback(
    (reference: ProjectFileReference): void => {
      if (!hostId || !sid) return;
      void Haptics.selectionAsync();
      router.push({
        pathname: "/host/[hostId]/preview/[sid]",
        params: {
          hostId,
          sid,
          path: reference.path,
          ...(reference.line !== undefined ? { line: String(reference.line) } : {}),
          ...(reference.column !== undefined ? { column: String(reference.column) } : {}),
        },
      });
    },
    [hostId, sid],
  );
  const openSubagent = useCallback(
    (nextSubagentId: string): void => {
      if (!hostId || !sid) return;
      router.push({
        pathname: "/host/[hostId]/session/[sid]",
        params: { hostId, sid, subagentId: nextSubagentId },
      });
    },
    [hostId, sid],
  );
  const interruptCurrent = useCallback((): void => {
    if (conn && sid) conn.interrupt(sid);
  }, [conn, sid]);

  const confirmKill = (): void => {
    if (!conn || !sid) return;
    setMenuOpen(false);
    setKillConfirmOpen(true);
  };

  if (!conn || !sid || !session) {
    const loading = sessionLoadState(runtime.status, runtime.lastError);
    return (
      <View style={styles.loadState}>
        <Stack.Screen options={{ title: loading.title }} />
        {loading.showSpinner && <ActivityIndicator color={color.accent} />}
        <Text style={styles.loadTitle}>{loading.title}</Text>
        <Text style={styles.loadDetail} accessibilityLiveRegion="polite">
          {loading.detail}
        </Text>
        <View style={styles.loadActions}>
          <Pressable
            style={({ pressed }) => [styles.loadRetry, (!conn || pressed) && styles.loadButtonPressed]}
            onPress={retryColdStart}
            disabled={!conn}
            accessibilityRole="button"
            accessibilityLabel={loading.retryLabel}
            accessibilityState={{ disabled: !conn }}
          >
            <Text style={styles.loadRetryText}>{loading.retryLabel}</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.loadBack, pressed && styles.loadButtonPressed]}
            onPress={returnToHostOverview}
            accessibilityRole="button"
            accessibilityLabel="返回主机"
          >
            <Text style={styles.loadBackText}>返回主机</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const policy: ApprovalPolicy = session?.approvalPolicy ?? "strict";
  const policyLabel: Record<ApprovalPolicy, string> = {
    strict: "逐条批准",
    standard: "半自动",
    yolo: "YOLO",
  };

  const choosePolicy = (): void => {
    setMenuOpen(false);
    setPolicyOpen(true);
  };

  /** 低频操作放进可点背景关闭的应用内面板。 */
  const openMenu = (): void => {
    setMenuOpen(true);
  };

  // 输入以 / 开头时给命令候选；@/$ 候选由 daemon 按当前项目生成。
  const commandHints =
    isChat && !isSubagent && session && composerToken?.kind === "command"
      ? matchCommands(session.agent, draft.trim())
      : [];
  const terminalInputEnabled = runtime.status === "connected";
  const canSend =
    draftHydrated &&
    (draft.trim().length > 0 || (isChat && !isSubagent && images.length > 0)) &&
    (isChat || terminalInputEnabled);

  const focusComposer = (cursor: number): void => {
    setSelection({ start: cursor, end: cursor });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const chooseCommand = (command: string): void => {
    const next = command === "/skills" ? "$" : command;
    setDraft(next);
    focusComposer(next.length);
    void Haptics.selectionAsync();
  };

  const chooseSuggestion = (suggestion: ChatSuggestion): void => {
    if (!composerToken || composerToken.kind === "command") return;
    const next = replaceComposerToken(draft, composerToken, suggestion);
    setDraft(next.text);
    completionSequence.current++;
    focusComposer(next.cursor);
    void Haptics.selectionAsync();
  };

  return (
    <View style={[styles.adaptiveRoot, showSessionRail && styles.adaptiveRootSplit]}>
      {showSessionRail && (
        <FoldableSessionRail
          sessions={orderedSessions}
          currentId={sid}
          hostId={hostId}
          width={sessionRailWidth}
        />
      )}
      {adaptiveLayout.verticalPanes && (
        <View
          style={[
            styles.sessionFoldGutter,
            { width: adaptiveLayout.verticalPanes.gap },
          ]}
          pointerEvents="none"
        />
      )}
      <KeyboardAvoidingView
        style={[
          styles.container,
          showSessionRail && styles.sessionDetail,
          adaptiveLayout.verticalPanes && {
            flex: 0,
            width: adaptiveLayout.verticalPanes.end,
          },
        ]}
        // 显式使用 native-stack 已知的头部高度，首轮布局就能同步算出 IME 重叠量。
        // automaticOffset 需要异步测量窗口坐标，快速首次点按时可能晚于键盘动画。
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={headerHeight}
      >
        <Stack.Screen
        options={{
          headerBackVisible: false,
          headerLeft: () => (
            <Pressable
              style={styles.headerBack}
              onPress={returnToHost}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="返回项目会话列表"
            >
              <Icon name="chevron.left" size={20} color={color.accent} weight="semibold" />
            </Pressable>
          ),
          headerTitle: () => (
            <SessionHeaderTitle
              session={session}
              pending={pending}
              tightest={tightest}
              {...(subagent ? { subagent } : {})}
            />
          ),
          headerRight: () => (
            <View style={styles.headerRight}>
              {/* 只有"停止"留在外面 —— 它是唯一分秒必争的操作 */}
              {busy && !isSubagent && (
                <Pressable
                  onPress={() => conn.interrupt(sid)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="停止当前任务"
                >
                  <Icon name="stop.circle" size={21} color={color.warn} />
                </Pressable>
              )}
              <Pressable
                onPress={openMenu}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="更多会话操作"
              >
                <Icon name="ellipsis.circle" size={21} color={color.accent} />
              </Pressable>
            </View>
          ),
        }}
      />
      {runtime.status !== "connected" && (
        <View style={styles.reconnBar}>
          <View style={styles.reconnCopy}>
            <View style={styles.reconnDot} />
            <Text style={styles.reconnText} numberOfLines={2}>
              {runtime.status === "failed"
                ? `连接失败 · ${runtime.lastError ?? "请重试"}`
                : "连接已中断 · 正在自动恢复"}
            </Text>
          </View>
          <Pressable onPress={() => conn.kick()} hitSlop={8} accessibilityRole="button">
            <Text style={styles.reconnAction}>重试</Text>
          </Pressable>
        </View>
      )}

      {isStructured && (
        <View style={styles.modeBar}>
          <View style={styles.chatModeLabel}>
            {isSubagent ? (
              <View style={styles.subagentModeIdentity}>
                <View
                  style={[
                    styles.subagentModeDot,
                    {
                      backgroundColor:
                        subagent?.status === "running" || subagent?.status === "starting"
                          ? color.accent
                          : color.textFaint,
                    },
                  ]}
                />
                <Text style={styles.subagentModeName} numberOfLines={1}>
                  {subagent?.name ?? "子 Agent"}
                </Text>
              </View>
            ) : (
              <>
                <Icon
                  name={coordinatorRun
                    ? "point.3.connected.trianglepath.dotted"
                    : "bubble.left.and.text.bubble.right"}
                  size={14}
                  color={coordinatorRun ? color.accent : color.text}
                />
                <Text style={[styles.modeText, coordinatorRun && styles.coordinatorModeText]}>
                  {coordinatorRun ? "Goal 编排者" : "对话"}
                </Text>
              </>
            )}
          </View>
          {!isSubagent && agentControls && (
            <Pressable
              style={[styles.controlChip, displayedMode === "plan" && styles.controlChipPlan]}
              onPress={openControls}
              accessibilityRole="button"
              accessibilityLabel="模型与 Plan 模式"
            >
              <Text style={[styles.controlChipText, displayedMode === "plan" && styles.controlChipTextPlan]}>
                {displayedMode === "plan" ? "Plan" : displayedModel?.split("/").at(-1) ?? "模型"}
              </Text>
            </Pressable>
          )}
          {!isSubagent && (
            <Pressable
              style={[styles.policyChip, policy === "yolo" && styles.policyChipYolo]}
              onPress={choosePolicy}
              accessibilityRole="button"
              accessibilityLabel={`审批策略：${policyLabel[policy]}`}
            >
              <Text style={[styles.policyChipText, policy === "yolo" && styles.policyChipTextYolo]}>
                {policyLabel[policy]}
              </Text>
            </Pressable>
          )}
          <Pressable
            style={[styles.modeAction, search !== null && styles.modeActionActive]}
            onPress={() => setSearch((value) => (value === null ? "" : null))}
            accessibilityRole="button"
            accessibilityLabel={search === null ? "搜索消息" : "关闭搜索"}
          >
            <Icon name="magnifyingglass" size={16} color={color.textDim} />
          </Pressable>
        </View>
      )}

      {isStructured && !isSubagent && (session.subagents?.length ?? 0) > 0 && (
        <View style={styles.subagentRail}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.subagentRailContent}
          >
            {session.subagents?.map((child) => {
              const active = child.status === "running" || child.status === "starting";
              return (
                <Pressable
                  key={child.id}
                  style={({ pressed }) => [
                    styles.subagentRailChip,
                    active && styles.subagentRailChipActive,
                    pressed && styles.controlPressed,
                  ]}
                  onPress={() => openSubagent(child.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`查看子 Agent ${child.name} 的过程`}
                >
                  <View
                    style={[
                      styles.subagentRailDot,
                      { backgroundColor: active ? color.accent : color.textFaint },
                    ]}
                  />
                  <Text style={styles.subagentRailName} numberOfLines={1}>{child.name}</Text>
                  <Text style={[styles.subagentRailState, active && styles.subagentRailStateActive]}>
                    {subagentStatusText[child.status]}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      {isChat && search !== null && (
        <View style={styles.searchBar}>
          <Icon name="magnifyingglass" size={15} color={color.textFaint} />
          <TextInput
            style={styles.searchInput}
            placeholder="在本会话中搜索…"
            placeholderTextColor="#5a5a66"
            value={search}
            onChangeText={setSearch}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          <Pressable
            onPress={() => setSearch(null)}
            style={styles.searchCancelButton}
            accessibilityRole="button"
            accessibilityLabel="关闭消息搜索"
          >
            <Text style={styles.searchCancel}>取消</Text>
          </Pressable>
        </View>
      )}

      {isChat ? (
        <ChatView
          conn={conn}
          sid={sid}
          agent={session.agent}
          workingStatus={busy ? (subagent?.status ?? session.status) : undefined}
          onInterrupt={isSubagent ? undefined : interruptCurrent}
          {...(subagentId ? { subagentId } : {})}
          onOpenSubagent={openSubagent}
          projectRoot={session.cwd}
          onOpenFile={openFileReference}
          onPendingChange={setPending}
          {...(search !== null ? { search } : {})}
          onRetry={send}
        />
      ) : (
        terminalFontPreferenceHydrated ? (
          <>
            <Terminal
              ref={termRef}
              conn={conn}
              sid={sid}
              fontSize={fontSize}
              onFontSize={setCustomTerminalFontSize}
              inputEnabled={terminalInputEnabled}
              disconnectedMessage="主机未连接；终端输入已冻结，断线期间的按键不会自动重放。"
              onRetryConnection={() => conn.kick()}
            />
            <KeyBar
              onKey={(seq) => conn.inputText(sid, seq)}
              enabled={terminalInputEnabled}
              disabledMessage="主机未连接；快捷键和粘贴已冻结，不会自动重放。"
              onRetry={() => conn.kick()}
              onFontSize={(delta) => setCustomTerminalFontSize(adjustTerminalFontSize(fontSize, delta))}
              onResetFontSize={followSystemTerminalFontSize}
              fontSizeMode={terminalFontPreference.mode}
              onScrollBottom={() => termRef.current?.scrollToBottom()}
              onDismissKeyboard={() => termRef.current?.blur()}
            />
          </>
        ) : (
          <View style={styles.terminalPreferenceLoading} accessibilityLabel="正在读取终端字号偏好">
            <ActivityIndicator color={color.accent} />
          </View>
        )
      )}

      {isChat && commandHints.length > 0 && (
        <View style={styles.cmdBox}>
          {commandHints.slice(0, 5).map((c) => (
            <Pressable key={c.cmd} style={styles.cmdRow} onPress={() => chooseCommand(c.cmd)}>
              <Text style={styles.cmdName}>{c.cmd}</Text>
              <Text style={styles.cmdDesc}>{c.desc}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {isChat && completionKind !== null && (
        <View style={styles.suggestionBox}>
          <View style={styles.suggestionHeader}>
            <Text style={styles.suggestionTitle}>
              {completionKind === "file" ? "@ 项目文件" : "$ Agent Skills"}
            </Text>
            {completionLoading ? (
              <ActivityIndicator size="small" color={color.textFaint} />
            ) : (
              <Text style={styles.suggestionCount}>{String(suggestions.length)} 项</Text>
            )}
          </View>
          {!completionLoading && suggestions.length === 0 ? (
            <Text style={styles.suggestionEmpty}>没有匹配项</Text>
          ) : (
            suggestions.slice(0, 8).map((item) => (
              <Pressable
                key={`${item.kind}:${item.value}`}
                style={({ pressed }) => [styles.suggestionRow, pressed && styles.suggestionPressed]}
                onPress={() => chooseSuggestion(item)}
                accessibilityRole="button"
                accessibilityLabel={`插入${item.kind === "file" ? "文件" : "Skill"} ${item.label}`}
              >
                <View
                  style={[
                    styles.suggestionSigil,
                    item.kind === "skill" && styles.suggestionSigilSkill,
                  ]}
                >
                  <Text style={styles.suggestionSigilText}>{item.kind === "file" ? "@" : "$"}</Text>
                </View>
                <View style={styles.suggestionCopy}>
                  <Text style={styles.suggestionName} numberOfLines={1}>{item.label}</Text>
                  {item.detail ? (
                    <Text style={styles.suggestionDetail} numberOfLines={1}>{item.detail}</Text>
                  ) : null}
                </View>
              </Pressable>
            ))
          )}
        </View>
      )}

      {isChat && commandHints.length === 0 && completionKind === null && (
        <QuickReplies busy={busy} onPick={send} />
      )}

      {isChat && !isSubagent && (session.messageQueue?.length ?? 0) > 0 && (
        <View style={styles.queuePanel}>
          <View style={styles.queueHeader}>
            <Text style={styles.queueTitle}>
              待发送 · {String(session.messageQueue?.length ?? 0)}
            </Text>
            <Text style={styles.queueHint}>当前任务结束后自动继续</Text>
          </View>
          {(session.messageQueue ?? []).slice(0, 4).map((item, index) => (
            <View key={item.id} style={styles.queueRow}>
              <View style={[styles.queueKind, item.kind === "guide" && styles.queueKindGuide]}>
                <Text style={styles.queueKindText}>
                  {item.kind === "guide" ? "引导" : `#${String(index + 1)}`}
                </Text>
              </View>
              <Text style={styles.queueText} numberOfLines={1}>
                {item.text || `${String(item.attachmentCount)} 张图片`}
              </Text>
              {item.kind === "queue" && busy && (
                <Pressable
                  style={({ pressed }) => [styles.queueGuide, pressed && styles.queueGuidePressed]}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    conn.guideQueuedMessage(sid, item.id);
                  }}
                  hitSlop={5}
                  accessibilityRole="button"
                  accessibilityLabel={`把排队消息 ${String(index + 1)} 改为引导`}
                >
                  <Text style={styles.queueGuideText}>改为引导</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => conn.removeQueuedMessage(sid, item.id)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`取消排队消息 ${String(index + 1)}`}
              >
                <Text style={styles.queueRemove}>×</Text>
              </Pressable>
            </View>
          ))}
          {(session.messageQueue?.length ?? 0) > 4 && (
            <Text style={styles.queueMore}>
              另有 {String((session.messageQueue?.length ?? 0) - 4)} 条
            </Text>
          )}
        </View>
      )}

      {isChat && !isSubagent && busy && (
        <View style={styles.deliveryBar}>
          <Text style={styles.deliveryLabel}>发送方式</Text>
          <Pressable
            style={[styles.deliveryOption, busyDelivery === "queue" && styles.deliveryOptionActive]}
            onPress={() => setBusyDelivery("queue")}
            accessibilityRole="button"
            accessibilityState={{ selected: busyDelivery === "queue" }}
          >
            <Text
              style={[
                styles.deliveryOptionText,
                busyDelivery === "queue" && styles.deliveryOptionTextActive,
              ]}
            >
              排到队尾
            </Text>
          </Pressable>
          <Pressable
            style={[styles.deliveryOption, busyDelivery === "steer" && styles.deliveryOptionActive]}
            onPress={() => setBusyDelivery("steer")}
            accessibilityRole="button"
            accessibilityState={{ selected: busyDelivery === "steer" }}
          >
            <Text
              style={[
                styles.deliveryOptionText,
                busyDelivery === "steer" && styles.deliveryOptionTextActive,
              ]}
            >
              引导当前任务
            </Text>
          </Pressable>
        </View>
      )}

      {isChat && !isSubagent && images.length > 0 && (
        <ScrollView horizontal style={styles.thumbs} contentContainerStyle={styles.thumbsRow}>
          {images.map((img, i) => (
            <View key={img.uri} style={styles.thumbWrap}>
              <Image source={{ uri: img.uri }} style={styles.thumb} />
              <Pressable
                style={styles.thumbX}
                onPress={() => {
                  setImages((v) => v.filter((_, j) => j !== i));
                  if (composerScope) {
                    void removeComposerDraftAttachment(composerScope, img.uri).catch((error: unknown) => {
                      setAttachmentError(`无法移除图片缓存：${error instanceof Error ? error.message : String(error)}`);
                    });
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel={`移除第 ${String(i + 1)} 张图片`}
              >
                <View style={styles.thumbXIcon}>
                  <Text style={styles.thumbXText}>×</Text>
                </View>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      <Sheet visible={menuOpen} title={session.title || "会话"} onClose={() => setMenuOpen(false)}>
        {isStructured && session.agentControls && !isSubagent ? (
          <SheetAction
            label="模型与 Plan 模式"
            detail="切换当前会话的模型、推理强度和工作模式"
            symbol="command"
            onPress={() => {
              setMenuOpen(false);
              openControls();
            }}
          />
        ) : null}
        {isStructured ? (
          <>
            <SheetAction
              label={tightest
                ? `用量与限流 · ${tightest.label} ${String(Math.round(tightest.utilization))}%`
                : "用量与限流"}
              detail="查看套餐窗口、剩余额度和重置时间"
              symbol="arrow.clockwise"
              onPress={() => {
                setMenuOpen(false);
                showUsage();
              }}
            />
            <SheetAction
              label={`审批策略 · ${policyLabel[policy]}`}
              detail="决定哪些操作需要你确认"
              symbol="checkmark.circle.fill"
              onPress={choosePolicy}
            />
          </>
        ) : null}
        <SheetAction
          label="查看项目改动"
          detail="检查当前项目的 Git 变更"
          symbol="doc.on.doc"
          onPress={() => {
            setMenuOpen(false);
            router.push(`/host/${hostId}/git/${sid}`);
          }}
        />
        <SheetAction
          label="浏览项目文件"
          detail="打开当前会话的工作目录"
          symbol="folder.fill"
          onPress={() => {
            setMenuOpen(false);
            router.push(`/host/${hostId}/files/${sid}`);
          }}
        />
        <SheetAction
          label="归档会话"
          detail="仅从手机当前列表移入归档，电脑端保持运行"
          symbol="archivebox"
          onPress={() => {
            setMenuOpen(false);
            void setSessionArchived(hostId, sid, true)
              .then(returnToHost)
              .catch((error: unknown) => {
                toast(error instanceof Error ? error.message : String(error));
              });
          }}
        />
        <SheetAction
          label="结束会话"
          detail="终止电脑端会话进程"
          symbol="trash"
          destructive
          onPress={confirmKill}
        />
      </Sheet>

      <Sheet visible={policyOpen} title="审批策略" onClose={() => setPolicyOpen(false)}>
        <Text style={styles.sheetNote}>决定哪些操作需要你点头。</Text>
        <SheetAction
          label="逐条批准"
          detail="文件修改、命令和联网操作均请求确认"
          symbol="checkmark.circle.fill"
          onPress={() => {
            conn.setApprovalPolicy(sid, "strict");
            setPolicyOpen(false);
          }}
        />
        <SheetAction
          label="半自动"
          detail="只读操作自动放行，其余操作请求确认"
          symbol="command"
          onPress={() => {
            conn.setApprovalPolicy(sid, "standard");
            setPolicyOpen(false);
          }}
        />
        <SheetAction
          label="YOLO"
          detail="全部操作自动批准"
          symbol="exclamationmark.triangle.fill"
          destructive
          onPress={() => {
            setPolicyOpen(false);
            setYoloConfirmOpen(true);
          }}
        />
      </Sheet>

      <Sheet
        visible={yoloConfirmOpen}
        title="确认开启 YOLO"
        onClose={() => setYoloConfirmOpen(false)}
      >
        <Text style={styles.sheetNote}>
          Agent 修改文件、执行命令和联网都不再询问；Codex 沙箱也会切到完整访问。操作仍会记录在聊天里。
        </Text>
        <SheetAction
          label="我明白，开启 YOLO"
          detail="立即应用到当前会话"
          symbol="exclamationmark.triangle.fill"
          destructive
          onPress={() => {
            conn.setApprovalPolicy(sid, "yolo");
            setYoloConfirmOpen(false);
          }}
        />
      </Sheet>

      <Sheet
        visible={killConfirmOpen}
        title="结束会话"
        onClose={() => setKillConfirmOpen(false)}
      >
        <Text style={styles.sheetNote}>电脑端会话进程会被终止，未完成的工作可能丢失。</Text>
        <SheetAction
          label="结束电脑端会话"
          detail="此操作无法撤销"
          symbol="trash"
          destructive
          onPress={() => {
            setKillConfirmOpen(false);
            conn.kill(sid);
            returnToHost();
          }}
        />
      </Sheet>

      <Sheet visible={controlsOpen} title="Agent 设置" onClose={() => setControlsOpen(false)}>
        {controlError && <Text style={styles.controlError}>{controlError}</Text>}
        {controlsLoading && models.length === 0 && modes.length === 0 ? (
          <ActivityIndicator style={styles.sheetLoading} color={color.accent} />
        ) : (
          <>
            {modes.length > 0 && (
              <View style={styles.controlSection}>
                <Text style={styles.controlSectionTitle}>工作模式</Text>
                <View style={styles.controlSegments}>
                  {modes.map((mode) => {
                    const active = displayedMode === mode.id;
                    return (
                      <Pressable
                        key={mode.id}
                        style={({ pressed }) => [
                          styles.controlSegment,
                          active && styles.controlSegmentActive,
                          pressed && styles.controlPressed,
                        ]}
                        onPress={() => selectMode(mode.id)}
                        disabled={controlsLoading}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: active }}
                      >
                        <Text style={[styles.controlSegmentTitle, active && styles.controlActiveText]}>
                          {mode.label}
                        </Text>
                        {mode.description && (
                          <Text style={styles.controlDescription}>{mode.description}</Text>
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}
            {models.length > 0 && (
              <View style={styles.controlSection}>
                <Text style={styles.controlSectionTitle}>模型</Text>
                <View style={styles.controlList}>
                  {models.map((model) => {
                    const active = displayedModel === model.id;
                    return (
                      <Pressable
                        key={model.id}
                        style={({ pressed }) => [
                          styles.controlModel,
                          active && styles.controlModelActive,
                          pressed && styles.controlPressed,
                        ]}
                        onPress={() =>
                          selectModel(
                            model.id,
                            model.defaultEffort ?? model.supportedEfforts[0],
                          )
                        }
                        disabled={controlsLoading}
                      >
                        <View style={styles.controlModelCopy}>
                          <Text style={[styles.controlModelTitle, active && styles.controlActiveText]}>
                            {model.label}
                          </Text>
                          {model.description && (
                            <Text style={styles.controlDescription} numberOfLines={2}>
                              {model.description}
                            </Text>
                          )}
                        </View>
                        {active && <Icon name="checkmark.circle.fill" size={16} color={color.accent} />}
                      </Pressable>
                    );
                  })}
                </View>
                {(models.find((model) => model.id === displayedModel)?.supportedEfforts.length ?? 0) > 0 && (
                  <View style={styles.effortRow}>
                    <Text style={styles.effortLabel}>推理强度</Text>
                    {models
                      .find((model) => model.id === displayedModel)
                      ?.supportedEfforts.map((effort) => (
                        <Pressable
                          key={effort}
                          style={[
                            styles.effortChip,
                            displayedEffort === effort && styles.effortChipActive,
                          ]}
                          onPress={() => displayedModel && selectModel(displayedModel, effort)}
                          disabled={controlsLoading}
                        >
                          <Text
                            style={[
                              styles.effortText,
                              displayedEffort === effort && styles.controlActiveText,
                            ]}
                          >
                            {effort}
                          </Text>
                        </Pressable>
                      ))}
                  </View>
                )}
              </View>
            )}
            {session.agentControls?.compact && (
              <View style={styles.controlSection}>
                <Text style={styles.controlSectionTitle}>上下文</Text>
                <Pressable
                  style={({ pressed }) => [
                    styles.compactButton,
                    (busy || controlsLoading) && styles.compactButtonDisabled,
                    pressed && !busy && styles.controlPressed,
                  ]}
                  disabled={busy || controlsLoading}
                  onPress={compactContext}
                >
                  <Text style={styles.compactButtonText}>压缩当前上下文</Text>
                  <Text style={styles.controlDescription}>
                    原生执行 /compact，不会把命令作为 Prompt 发给模型
                  </Text>
                </Pressable>
              </View>
            )}
            {controlsLoading && <ActivityIndicator style={styles.controlInlineLoading} color={color.accent} />}
          </>
        )}
      </Sheet>

      <Sheet visible={usageOpen} title="用量与限流" onClose={() => setUsageOpen(false)}>
        {usageError !== null ? (
          <Text style={styles.sheetNote}>{usageError}</Text>
        ) : usage === null ? (
          <ActivityIndicator style={styles.sheetLoading} color={color.accent} />
        ) : (
          <>
            {usage.subscription ? <Row label="套餐" value={usage.subscription} /> : null}
            {usage.costUsd !== undefined ? (
              <Row label="本会话花费" value={`$${usage.costUsd.toFixed(4)}`} />
            ) : null}
            {usage.inputTokens !== undefined ? (
              <Row label="输入 token" value={usage.inputTokens.toLocaleString()} />
            ) : null}
            {usage.outputTokens !== undefined ? (
              <Row label="输出 token" value={usage.outputTokens.toLocaleString()} />
            ) : null}

            {(usage.windows ?? []).map((w) => (
              <View key={w.label} style={styles.window}>
                <View style={styles.windowHead}>
                  <Text style={font.body}>{w.label}</Text>
                  <Text style={[styles.windowPct, { color: utilizationColor(w.utilization) }]}>
                    {String(Math.round(w.utilization))}%
                  </Text>
                </View>
                <Meter value={w.utilization} tint={utilizationColor(w.utilization)} />
                {w.resetsAt ? (
                  <Text style={font.meta}>{formatReset(w.resetsAt)} 重置</Text>
                ) : null}
              </View>
            ))}

            {!usage.available || (usage.windows ?? []).length === 0 ? (
              <Text style={styles.sheetNote}>
                {usage.reason ?? "这个账号不适用套餐限流(API key / Bedrock / Vertex)。"}
              </Text>
            ) : null}
          </>
        )}
      </Sheet>

      {deliveryError && (
        <View
          style={styles.deliveryError}
          accessible
          accessibilityLiveRegion="assertive"
          accessibilityLabel={deliveryError}
        >
          <Text style={styles.deliveryErrorText}>{deliveryError}</Text>
        </View>
      )}
      {attachmentError && (
        <View
          style={styles.attachmentError}
          accessible
          accessibilityLiveRegion="assertive"
          accessibilityLabel={attachmentError}
        >
          <Text style={styles.attachmentErrorText}>{attachmentError}</Text>
        </View>
      )}
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <DismissKey visible={focused} />
        {isChat && !isSubagent && (
          <Pressable
            style={({ pressed }) => [styles.iconBtn, pressed && styles.composerBtnPressed]}
            onPress={attach}
            accessibilityRole="button"
            accessibilityLabel="添加图片"
          >
            <Icon name="paperclip" size={17} color={color.textDim} />
          </Pressable>
        )}
        <TextInput
          ref={inputRef}
          style={[styles.input, isChat && styles.inputChat, !isChat && !terminalInputEnabled && styles.inputDisabled]}
          placeholder={
            isChat
              ? isSubagent
                ? `给 ${subagent?.name ?? "子 Agent"} 发消息`
                : busy
                ? busyDelivery === "steer"
                  ? "立即引导当前任务…"
                  : "消息将排到队尾…"
                : `给 ${session?.agent ?? "agent"} 发消息 · @文件 · $Skill · /命令`
              : terminalInputEnabled
                ? "输入命令，回车执行"
                : "主机未连接；终端输入已冻结"
          }
          placeholderTextColor={color.textFaint}
          value={draft}
          onChangeText={(next) => {
            setDraft(next);
            setDeliveryError(null);
          }}
          selection={selection}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
          onFocus={() => { setFocused(true); }}
          onBlur={() => { setFocused(false); }}
          onSubmitEditing={() => send(draft)}
          submitBehavior={isChat ? "newline" : "submit"}
          returnKeyType={isChat ? "default" : "send"}
          autoCapitalize="none"
          autoCorrect={false}
          multiline={isChat}
          editable={isChat || terminalInputEnabled}
          accessibilityHint={
            !isChat && !terminalInputEnabled
              ? "连接恢复前不能执行命令；输入内容不会自动发送。"
              : undefined
          }
        />
        {isChat && <VoiceButton onTranscript={appendTranscript} />}
        <Pressable
          style={({ pressed }) => [
            styles.sendBtn,
            !canSend && styles.sendBtnDim,
            pressed && canSend && styles.sendBtnPressed,
          ]}
          onPress={() => send(draft)}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel={
            isChat
              ? busyDelivery === "steer" && busy
                ? "发送引导"
                : busy
                  ? "加入消息队列"
                  : "发送消息"
              : "执行命令"
          }
          accessibilityState={{ disabled: !canSend }}
        >
          <Icon name="arrow.up" size={17} color="#fff" weight="semibold" />
        </Pressable>
      </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/** 与协议里的上限一致 */
const MAX_IMAGES = MAX_COMPOSER_IMAGES;

const styles = StyleSheet.create({
  adaptiveRoot: { flex: 1, backgroundColor: color.bg },
  adaptiveRootSplit: { flexDirection: "row" },
  container: { flex: 1, backgroundColor: color.bg },
  sessionDetail: { minWidth: 0 },
  sessionFoldGutter: {
    flexShrink: 0,
    backgroundColor: color.bg,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  sessionRail: {
    flexShrink: 0,
    backgroundColor: color.surface,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: color.border,
  },
  sessionRailHeader: {
    minHeight: 45,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  sessionRailTitle: { color: color.text, fontSize: 13, fontWeight: "700" },
  sessionRailCount: {
    minWidth: 22,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
    borderRadius: 999,
    backgroundColor: color.surfaceRaised,
    color: color.textDim,
    fontSize: 10,
    textAlign: "center",
  },
  sessionRailList: { gap: 6, padding: 10 },
  sessionRailItem: {
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
    backgroundColor: color.bg,
  },
  sessionRailItemSelected: {
    borderColor: color.accentDim,
    backgroundColor: color.accentBg,
  },
  sessionRailItemTop: { flexDirection: "row", alignItems: "center", gap: 7 },
  sessionRailStatus: { width: 7, height: 7, borderRadius: 4 },
  sessionRailItemTitle: { flex: 1, color: color.text, fontSize: 12.5, fontWeight: "600" },
  sessionRailAgent: { color: color.textFaint, fontSize: 9.5 },
  sessionRailPath: { color: color.textFaint, fontSize: 9.5, fontFamily: MONOSPACE_FONT },
  sessionRailPreview: { color: color.textDim, fontSize: 10.5, lineHeight: 15 },
  headerBack: { minWidth: 30, minHeight: 36, alignItems: "flex-start", justifyContent: "center" },
  loadState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 28,
    backgroundColor: color.bg,
  },
  loadTitle: { color: color.text, fontSize: 18, fontWeight: "700" },
  loadDetail: { maxWidth: 360, color: color.textDim, fontSize: 13, lineHeight: 19, textAlign: "center" },
  loadActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  loadRetry: {
    minHeight: 40,
    justifyContent: "center",
    borderRadius: 10,
    paddingHorizontal: 14,
    backgroundColor: color.accentDim,
  },
  loadRetryText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  loadBack: {
    minHeight: 40,
    justifyContent: "center",
    borderRadius: 10,
    paddingHorizontal: 14,
    backgroundColor: color.surfaceRaised,
  },
  loadBackText: { color: color.text, fontSize: 13, fontWeight: "600" },
  loadButtonPressed: { opacity: 0.55 },

  headerTitle: { alignItems: "center", maxWidth: 238 },
  headerName: { color: color.text, fontSize: 16, fontWeight: "600" },
  headerMetaRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  headerDot: { width: 5, height: 5, borderRadius: 3 },
  headerSub: { color: color.textDim, fontSize: 10.5, flexShrink: 1 },
  headerRight: { flexDirection: "row", gap: 16, alignItems: "center" },

  modeBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: color.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  chatModeLabel: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 8,
  },
  modeText: { color: color.text, fontSize: 13, fontWeight: "600" },
  coordinatorModeText: { color: color.accent },
  subagentModeIdentity: {
    maxWidth: "82%",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentDim,
    backgroundColor: "#18223A",
  },
  subagentModeDot: { width: 7, height: 7, borderRadius: 4 },
  subagentModeName: { flexShrink: 1, color: color.text, fontSize: 12, fontWeight: "700" },
  subagentRail: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
    backgroundColor: color.bg,
  },
  subagentRailContent: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  subagentRailChip: {
    maxWidth: 220,
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  subagentRailChipActive: { borderColor: color.accentDim, backgroundColor: "#18223A" },
  subagentRailDot: { width: 7, height: 7, borderRadius: 4 },
  subagentRailName: { flexShrink: 1, color: color.text, fontSize: 12, fontWeight: "700" },
  subagentRailState: { color: color.textFaint, fontSize: 9.5 },
  subagentRailStateActive: { color: color.accent },
  policyChip: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    paddingHorizontal: 9,
    borderRadius: 9,
    backgroundColor: color.surfaceRaised,
  },
  policyChipYolo: { backgroundColor: color.dangerBg },
  policyChipText: { color: color.textDim, fontSize: 11, fontWeight: "600" },
  policyChipTextYolo: { color: color.danger },
  controlChip: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    maxWidth: 92,
    justifyContent: "center",
    paddingHorizontal: 9,
    borderRadius: 9,
    backgroundColor: color.surfaceRaised,
  },
  controlChipPlan: { backgroundColor: color.accentBg },
  controlChipText: { color: color.textDim, fontSize: 10.5, fontWeight: "600" },
  controlChipTextPlan: { color: color.accent },
  modeAction: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: color.surfaceRaised,
  },
  modeActionActive: { backgroundColor: color.accentBg },
  terminalPreferenceLoading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#09090b",
  },

  reconnBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    backgroundColor: color.warnBg,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  reconnCopy: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  reconnDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.warn },
  reconnText: { flex: 1, color: "#EAC77C", fontSize: 12, lineHeight: 16 },
  reconnAction: { color: color.text, fontSize: 12, fontWeight: "600" },

  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: color.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  searchInput: {
    flex: 1,
    minHeight: 36,
    backgroundColor: color.surfaceRaised,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 7,
    color: color.text,
    fontSize: 14,
  },
  searchCancelButton: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  searchCancel: { color: color.accent, fontSize: 14, fontWeight: "500" },

  cmdBox: { backgroundColor: color.surface, paddingHorizontal: 10, paddingTop: 6, gap: 3 },
  cmdRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: color.surfaceRaised,
    borderRadius: 9,
  },
  cmdName: { color: color.accent, fontSize: 13, fontFamily: MONOSPACE_FONT },
  cmdDesc: { color: color.textDim, fontSize: 12, flex: 1 },

  suggestionBox: {
    gap: 4,
    paddingHorizontal: 10,
    paddingTop: 7,
    paddingBottom: 6,
    backgroundColor: color.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  suggestionHeader: {
    minHeight: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 7,
  },
  suggestionTitle: { color: color.textDim, fontSize: 11, fontWeight: "600" },
  suggestionCount: { color: color.textFaint, fontSize: 10 },
  suggestionEmpty: { color: color.textFaint, fontSize: 12, paddingHorizontal: 9, paddingVertical: 10 },
  suggestionRow: {
    minHeight: 43,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 9,
    backgroundColor: color.surfaceRaised,
  },
  suggestionPressed: { backgroundColor: color.pressed },
  suggestionSigil: {
    width: 25,
    height: 25,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 7,
    backgroundColor: color.accentBg,
  },
  suggestionSigilSkill: { backgroundColor: color.warnBg },
  suggestionSigilText: { color: color.accent, fontSize: 13, fontWeight: "700", fontFamily: MONOSPACE_FONT },
  suggestionCopy: { flex: 1, minWidth: 0 },
  suggestionName: { color: color.text, fontSize: 12.5, fontWeight: "600" },
  suggestionDetail: { color: color.textFaint, fontSize: 10.5, marginTop: 2 },

  queuePanel: {
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: color.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  queueHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  queueTitle: { color: color.text, fontSize: 12, fontWeight: "600" },
  queueHint: { color: color.textFaint, fontSize: 10 },
  queueRow: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: color.surfaceRaised,
  },
  queueKind: {
    minWidth: 28,
    paddingHorizontal: 5,
    paddingVertical: 2,
    alignItems: "center",
    borderRadius: 5,
    backgroundColor: color.accentBg,
  },
  queueKindGuide: { backgroundColor: color.warnBg },
  queueKindText: { color: color.textDim, fontSize: 9, fontWeight: "700" },
  queueText: { flex: 1, color: color.textDim, fontSize: 11 },
  queueGuide: {
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: color.warnBg,
  },
  queueGuideText: { color: color.warn, fontSize: 9.5, fontWeight: "600" },
  queueGuidePressed: { opacity: 0.68 },
  queueRemove: { color: color.textFaint, fontSize: 19, lineHeight: 22 },
  queueMore: { color: color.textFaint, fontSize: 10, textAlign: "center" },

  deliveryBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: color.surface,
  },
  deliveryLabel: { color: color.textFaint, fontSize: 10, marginRight: 2 },
  deliveryOption: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 9,
    backgroundColor: color.surfaceRaised,
  },
  deliveryOptionActive: { backgroundColor: color.accentBg },
  deliveryOptionText: { color: color.textDim, fontSize: 11, fontWeight: "500" },
  deliveryOptionTextActive: { color: color.accent, fontWeight: "600" },

  thumbs: { flexGrow: 0, backgroundColor: color.surface },
  thumbsRow: {
    gap: COMPOSER_THUMBNAIL_GAP,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  thumbWrap: {
    width: COMPOSER_THUMBNAIL_SIZE,
    height: COMPOSER_THUMBNAIL_SIZE,
    flexShrink: 0,
  },
  thumb: {
    width: COMPOSER_THUMBNAIL_SIZE,
    height: COMPOSER_THUMBNAIL_SIZE,
    borderRadius: 10,
    backgroundColor: color.surfaceRaised,
  },
  thumbX: {
    position: "absolute",
    top: 0,
    right: 0,
    width: COMPOSER_THUMBNAIL_REMOVE_TARGET,
    height: COMPOSER_THUMBNAIL_REMOVE_TARGET,
    alignItems: "flex-end",
    justifyContent: "flex-start",
  },
  thumbXIcon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: color.pressed,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: color.surface,
  },
  thumbXText: { color: color.text, fontSize: 14, lineHeight: 16 },

  sheetLoading: { paddingVertical: 32 },
  sheetNote: { color: color.textDim, fontSize: 13, lineHeight: 19, paddingVertical: 12 },
  controlError: {
    color: color.danger,
    backgroundColor: color.dangerBg,
    borderRadius: 9,
    padding: 10,
    fontSize: 12,
    marginBottom: 8,
  },
  controlSection: { gap: 9, paddingBottom: 18 },
  controlSectionTitle: { color: color.textDim, fontSize: 11, fontWeight: "700" },
  controlSegments: { flexDirection: "row", gap: 8 },
  controlSegment: {
    flex: 1,
    minHeight: 78,
    gap: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: 11,
    padding: 10,
    backgroundColor: color.surfaceRaised,
  },
  controlSegmentActive: { borderColor: color.accent, backgroundColor: color.accentBg },
  controlSegmentTitle: { color: color.text, fontSize: 13, fontWeight: "600" },
  controlDescription: { color: color.textFaint, fontSize: 10.5, lineHeight: 15 },
  controlActiveText: { color: color.accent },
  controlPressed: { opacity: 0.68 },
  controlList: { gap: 6 },
  controlModel: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surfaceRaised,
    paddingHorizontal: 11,
    paddingVertical: 8,
  },
  controlModelActive: { borderColor: color.accentDim, backgroundColor: color.accentBg },
  controlModelCopy: { flex: 1, gap: 2 },
  controlModelTitle: { color: color.text, fontSize: 12.5, fontWeight: "600" },
  effortRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  effortLabel: { color: color.textFaint, fontSize: 10.5, marginRight: 2 },
  effortChip: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: color.surfaceRaised,
  },
  effortChipActive: { backgroundColor: color.accentBg },
  effortText: { color: color.textDim, fontSize: 10.5, fontWeight: "600" },
  compactButton: {
    gap: 4,
    borderRadius: 10,
    backgroundColor: color.surfaceRaised,
    padding: 11,
  },
  compactButtonDisabled: { opacity: 0.42 },
  compactButtonText: { color: color.text, fontSize: 12.5, fontWeight: "600" },
  controlInlineLoading: { paddingVertical: 8 },
  window: { gap: 6, paddingVertical: 14 },
  windowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  windowPct: { fontSize: 15, fontWeight: "600", fontVariant: ["tabular-nums"] },

  composer: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10,
    backgroundColor: color.surface,
    alignItems: "flex-end",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  composerBtnPressed: { backgroundColor: color.pressed },
  input: {
    flex: 1,
    minHeight: 40,
    backgroundColor: color.surfaceRaised,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
    color: color.text,
    fontSize: 15,
    lineHeight: 21,
  },
  inputChat: { maxHeight: 132 },
  inputDisabled: { color: color.textFaint, opacity: 0.7 },
  sendBtn: {
    backgroundColor: color.accentDim,
    borderRadius: 20,
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDim: { backgroundColor: color.surfaceRaised, opacity: 0.72 },
  sendBtnPressed: { transform: [{ scale: 0.94 }] },
  deliveryError: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: color.dangerBg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.danger,
  },
  deliveryErrorText: { color: color.danger, fontSize: 12, lineHeight: 17, textAlign: "center" },
  attachmentError: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: color.dangerBg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.danger,
  },
  attachmentErrorText: { color: color.danger, fontSize: 12, lineHeight: 17, textAlign: "center" },
});
