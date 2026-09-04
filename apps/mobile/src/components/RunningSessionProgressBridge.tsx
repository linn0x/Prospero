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
  requestProgressNotificationPermission,
  subscribeProgressApprovalActions,
  syncRunningSessionProgress,
} from "@/lib/running-session-progress";
import { runningSessionProgress } from "@/lib/running-session-summary";
import { useApp } from "@/lib/store";

/** 把实时会话状态同步到 Android 前台服务；本组件本身不渲染界面。 */
export function RunningSessionProgressBridge() {
  const hosts = useApp((state) => state.hosts);
  const runtimes = useApp((state) => state.runtimes);
  const settings = useApp((state) => state.homeSettings) ?? DEFAULT_HOME_SETTINGS;
  const setHomeSettings = useApp((state) => state.setHomeSettings);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [approvals, setApprovals] = useState<Map<string, PendingOverlayApproval>>(new Map());
  const approvalsRef = useRef(approvals);
  const progress = useMemo(
    () => runningSessionProgress(hosts, runtimes),
    [hosts, runtimes],
  );
  // 连接由首页/会话页异步创建；把注册表是否已有实例纳入订阅生命周期，
  // 避免 Bridge 首次渲染时连接尚不存在而永久漏订阅。
  const connectionSignature = hosts
    .map((host) => `${host.id}:${peekConnection(host.id) === null ? "0" : "1"}`)
    .sort()
    .join("|");
  const approvalTargetSignature = useMemo(
    () => hosts.flatMap((host) => {
      const runtime = runtimes[host.id];
      if (!runtime) return [];
      return Object.values(runtime.sessions)
        .filter((session) =>
          session.kind === "structured" &&
          (session.status === "waiting_approval" || (session.pendingPermissions ?? 0) > 0),
        )
        .map((session) => `${host.id}\u0000${session.id}`);
    }).sort().join("\u0001"),
    [hosts, runtimes],
  );

  const activeApprovals = useMemo(() => {
    const hostIds = new Set(hosts.map((host) => host.id));
    return new Map([...approvals].filter(([, candidate]) =>
      hostIds.has(candidate.hostId) &&
      runtimes[candidate.hostId]?.sessions[candidate.sid] !== undefined,
    ));
  }, [approvals, hosts, runtimes]);

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
    let cancelled = false;
    void getHomeSettings().then((saved) => {
      if (!cancelled) setHomeSettings(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [setHomeSettings]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const targetsByHost = new Map<string, string[]>();
    for (const target of approvalTargetSignature.split("\u0001")) {
      if (!target) continue;
      const [hostId, sid] = target.split("\u0000");
      if (!hostId || !sid) continue;
      const current = targetsByHost.get(hostId) ?? [];
      current.push(sid);
      targetsByHost.set(hostId, current);
    }

    const unsubscribe: (() => void)[] = [];
    for (const host of hosts) {
      const conn = peekConnection(host.id);
      if (!conn) continue;
      unsubscribe.push(conn.events.on("chatSnapshot", (message) => {
        setApprovals((current) =>
          applyOverlayApprovalEvents(current, host.id, message.sid, message.events, true),
        );
      }));
      unsubscribe.push(conn.events.on("agentEvent", (message) => {
        if (
          message.body.kind !== "permission.request" &&
          message.body.kind !== "permission.resolved" &&
          message.body.kind !== "permission.auto"
        ) return;
        setApprovals((current) =>
          applyOverlayApprovalEvents(current, host.id, message.sid, [message.body]),
        );
      }));

      const attachTargets = () => {
        for (const sid of targetsByHost.get(host.id) ?? []) conn.attach(sid);
      };
      unsubscribe.push(conn.events.on("connected", attachTargets));
      if (conn.isConnected) attachTargets();
    }
    return () => {
      for (const off of unsubscribe) off();
    };
  }, [approvalTargetSignature, connectionSignature, hosts]);

  useEffect(() => subscribeProgressApprovalActions((event) => {
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
  }), []);

  useEffect(() => {
    if (
      Platform.OS === "android" &&
      appState === "active" &&
      effectiveProgress !== null &&
      settings.backgroundProgressEnabled
    ) {
      void requestProgressNotificationPermission();
    }
  }, [appState, effectiveProgress, settings.backgroundProgressEnabled]);

  useEffect(() => {
    syncRunningSessionProgress(
      effectiveProgress,
      settings.backgroundProgressEnabled,
      settings.overlayProgressEnabled,
      approval,
    );
  }, [appState, approval, effectiveProgress, settings.backgroundProgressEnabled, settings.overlayProgressEnabled]);

  return null;
}
