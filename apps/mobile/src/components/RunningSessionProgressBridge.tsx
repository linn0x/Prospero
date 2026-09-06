import { useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Platform, type AppStateStatus } from "react-native";

import { DEFAULT_HOME_SETTINGS, getHomeSettings } from "@/lib/home-preferences";
import { peekConnection } from "@/lib/connection";
import {
  applyOverlayApprovalEvents,
  overlayApprovalKey,
  removeOverlayApproval,
  type PendingOverlayApproval,
} from "@/lib/pending-overlay-approvals";
import {
  canDisplayProgressOverlay,
  requestProgressNotificationPermission,
  subscribeProgressApprovalActions,
  syncRunningSessionProgress,
} from "@/lib/running-session-progress";
import {
  needsProgressApprovalSubscription,
  ProgressApprovalSubscriptions,
} from "@/lib/progress-approval-subscriptions";
import { runningSessionProgress } from "@/lib/running-session-summary";
import { useApp } from "@/lib/store";

/** 保留全平台偏好恢复；iOS 不挂载 Android 服务的会话订阅树。 */
export function RunningSessionProgressBridge() {
  const setHomeSettings = useApp((state) => state.setHomeSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getHomeSettings().then((saved) => {
      if (!cancelled) {
        setHomeSettings(saved);
        setSettingsLoaded(true);
      }
    });
    return () => { cancelled = true; };
  }, [setHomeSettings]);
  return Platform.OS === "android" && settingsLoaded ? <AndroidProgressSettingsBridge /> : null;
}

function AndroidProgressSettingsBridge() {
  // 后台进度只订阅自身开关；themeMode 等无关设置变化不应触发原生服务同步。
  const backgroundProgressEnabled = useApp(
    (state) =>
      state.homeSettings?.backgroundProgressEnabled ??
      DEFAULT_HOME_SETTINGS.backgroundProgressEnabled,
  );
  useEffect(() => {
    if (!backgroundProgressEnabled) syncRunningSessionProgress(null, false, false);
  }, [backgroundProgressEnabled]);
  return backgroundProgressEnabled ? <AndroidRunningSessionProgressBridge /> : null;
}

/** 普通通知只读会话元数据；仅可见的后台悬浮窗需要审批正文。 */
function AndroidRunningSessionProgressBridge() {
  const hosts = useApp((state) => state.hosts);
  const runtimes = useApp((state) => state.runtimes);
  const overlayProgressEnabled = useApp(
    (state) =>
      state.homeSettings?.overlayProgressEnabled ?? DEFAULT_HOME_SETTINGS.overlayProgressEnabled,
  );
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [approvals, setApprovals] = useState<Map<string, PendingOverlayApproval>>(new Map());
  const approvalsRef = useRef(approvals);
  const progress = useMemo(
    () => runningSessionProgress(hosts, runtimes),
    [hosts, runtimes],
  );
  const overlayActive = needsProgressApprovalSubscription(
    Platform.OS, true, overlayProgressEnabled, appState, canDisplayProgressOverlay(),
  );
  // 连接由首页/会话页异步创建；把注册表是否已有实例纳入订阅生命周期，
  // 避免 Bridge 首次渲染时连接尚不存在而永久漏订阅。
  const connectionSignature = overlayActive ? hosts
    .map((host) => `${host.id}:${peekConnection(host.id) === null ? "0" : "1"}`)
    .sort()
    .join("|") : "";
  const approvalTargetSignature = useMemo(
    () => overlayActive ? hosts.flatMap((host) => {
      const runtime = runtimes[host.id];
      if (!runtime) return [];
      return Object.values(runtime.sessions)
        .filter((session) =>
          session.kind === "structured" &&
          (session.status === "waiting_approval" || (session.pendingPermissions ?? 0) > 0),
        )
        .map((session) => `${host.id}\u0000${session.id}`);
    }).sort().join("\u0001") : "",
    [hosts, overlayActive, runtimes],
  );

  const activeApprovals = useMemo(() => {
    if (!overlayActive) return new Map<string, PendingOverlayApproval>();
    const hostIds = new Set(hosts.map((host) => host.id));
    return new Map([...approvals].filter(([, candidate]) => {
      const session = runtimes[candidate.hostId]?.sessions[candidate.sid];
      return hostIds.has(candidate.hostId) && session?.kind === "structured" &&
        (session.status === "waiting_approval" || (session.pendingPermissions ?? 0) > 0);
    }));
  }, [approvals, hosts, overlayActive, runtimes]);

  const approval = useMemo(() => {
    const candidates = [...activeApprovals.values()];
    candidates.sort((a, b) => b.receivedAt - a.receivedAt);
    return candidates[0] ?? null;
  }, [activeApprovals]);

  const effectiveProgress = useMemo(() => {
    if (!approval) return progress;
    const host = hosts.find((candidate) => candidate.id === approval.hostId);
    const session = runtimes[approval.hostId]?.sessions[approval.sid];
    return {
      runningCount: Math.max(1, progress?.runningCount ?? 0),
      waitingCount: Math.max(1, progress?.waitingCount ?? 0),
      title: session?.title.trim() || "Prospero 等待审批",
      detail: `${host?.name ?? "设备"} · ${approval.action || "Agent 操作"} · 等待审批`,
      deepLink: `prospero://host/${encodeURIComponent(approval.hostId)}/session/${encodeURIComponent(approval.sid)}`,
    };
  }, [approval, hosts, progress, runtimes]);

  useEffect(() => {
    approvalsRef.current = activeApprovals;
  }, [activeApprovals]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // Returning to the app ends this overlay interaction. Clear its cache at
      // the native transition, rather than scheduling a second render from an effect.
      if (nextState === "active") {
        approvalsRef.current = new Map();
        setApprovals((current) => current.size ? new Map() : current);
      }
      setAppState(nextState);
    });
    return () => subscription.remove();
  }, []);

  const approvalSubscriptions = useMemo(() => new ProgressApprovalSubscriptions({
    snapshot(hostId, message) {
      setApprovals((current) =>
        applyOverlayApprovalEvents(current, hostId, message.sid, message.events, true),
      );
    },
    event(hostId, message) {
      setApprovals((current) =>
        applyOverlayApprovalEvents(current, hostId, message.sid, [message.body]),
      );
    },
  }), []);

  useEffect(() => () => approvalSubscriptions.dispose(), [approvalSubscriptions]);

  useEffect(() => {
    const targetsByHost = new Map<string, Set<string>>();
    for (const target of approvalTargetSignature.split("\u0001")) {
      if (!target) continue;
      const [hostId, sid] = target.split("\u0000");
      if (!hostId || !sid) continue;
      const current = targetsByHost.get(hostId) ?? new Set<string>();
      current.add(sid);
      targetsByHost.set(hostId, current);
    }

    approvalSubscriptions.update(targetsByHost, peekConnection);
  }, [approvalSubscriptions, approvalTargetSignature, connectionSignature, hosts, overlayActive, runtimes]);

  useEffect(() => {
    if (!overlayActive) return;
    return subscribeProgressApprovalActions((event) => {
      const key = overlayApprovalKey(event.hostId, event.sid, event.reqId);
      if (!approvalsRef.current.has(key)) return;
      const result = peekConnection(event.hostId)?.respondPermission(
        event.sid,
        event.reqId,
        event.reply,
      );
      if (result?.accepted) {
        setApprovals((current) =>
          removeOverlayApproval(current, event.hostId, event.sid, event.reqId),
        );
        return;
      }
      // 连接已被移除或无法排队时，打开原会话让用户看到完整上下文并重试。
      if (event.deepLink) void Linking.openURL(event.deepLink);
    });
  }, [overlayActive]);

  useEffect(() => {
    if (
      Platform.OS === "android" &&
      appState === "active" &&
      effectiveProgress !== null
    ) {
      void requestProgressNotificationPermission();
    }
  }, [appState, effectiveProgress]);

  useEffect(() => {
    syncRunningSessionProgress(
      effectiveProgress,
      true,
      overlayProgressEnabled,
      approval,
    );
  }, [appState, approval, effectiveProgress, overlayProgressEnabled]);

  return null;
}
