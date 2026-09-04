import { AppState, PermissionsAndroid, Platform } from "react-native";

import ProsperoProgressOverlayModule from "../../modules/prospero-progress-overlay/src/ProsperoProgressOverlayModule";
import type { ProgressOverlayApprovalAction } from "../../modules/prospero-progress-overlay/src/ProsperoProgressOverlay.types";
import type { PendingOverlayApproval } from "./pending-overlay-approvals";
import type { RunningSessionProgress } from "./running-session-summary";

export function isProgressOverlaySupported(): boolean {
  return Platform.OS === "android" && ProsperoProgressOverlayModule !== null;
}

export function canDisplayProgressOverlay(): boolean {
  return Platform.OS === "android" &&
    (ProsperoProgressOverlayModule?.canDrawOverlays() ?? false);
}

export function openProgressOverlaySettings(): void {
  if (Platform.OS === "android") ProsperoProgressOverlayModule?.openOverlaySettings();
}

let requestedNotificationPermission = false;

export async function requestProgressNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== "android" || Platform.Version < 33) return true;
  if (requestedNotificationPermission) {
    return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  }
  requestedNotificationPermission = true;
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    {
      title: "显示 Agent 工作进度",
      message: "Prospero 会在有会话运行时显示持续通知，方便从其他应用快速返回。",
      buttonPositive: "允许",
      buttonNegative: "暂不",
    },
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export function syncRunningSessionProgress(
  progress: RunningSessionProgress | null,
  backgroundProgressEnabled: boolean,
  overlayProgressEnabled: boolean,
  approval: PendingOverlayApproval | null = null,
): void {
  if (Platform.OS !== "android" || !ProsperoProgressOverlayModule) return;
  try {
    if (!progress || !backgroundProgressEnabled) {
      ProsperoProgressOverlayModule.stop();
      return;
    }

    ProsperoProgressOverlayModule.sync(
      progress.title,
      progress.detail,
      progress.deepLink,
      progress.runningCount,
      progress.waitingCount,
      overlayProgressEnabled && AppState.currentState !== "active" && canDisplayProgressOverlay(),
      JSON.stringify(approval),
    );
  } catch {
    // 某些 ROM 会在切后台的瞬间拒绝启动前台服务；下一次状态更新会重试。
  }
}

export function subscribeProgressApprovalActions(
  listener: (event: ProgressOverlayApprovalAction) => void,
): () => void {
  if (Platform.OS !== "android" || !ProsperoProgressOverlayModule) return () => undefined;
  const subscription = ProsperoProgressOverlayModule.addListener("onApprovalAction", listener);
  return () => subscription.remove();
}
