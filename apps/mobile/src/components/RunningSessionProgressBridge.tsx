import { useEffect, useMemo, useState } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";

import { DEFAULT_HOME_SETTINGS, getHomeSettings } from "@/lib/home-preferences";
import {
  requestProgressNotificationPermission,
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
  const progress = useMemo(
    () => runningSessionProgress(hosts, runtimes),
    [hosts, runtimes],
  );

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
    if (
      Platform.OS === "android" &&
      appState === "active" &&
      progress !== null &&
      settings.backgroundProgressEnabled
    ) {
      void requestProgressNotificationPermission();
    }
  }, [appState, progress, settings.backgroundProgressEnabled]);

  useEffect(() => {
    syncRunningSessionProgress(
      progress,
      settings.backgroundProgressEnabled,
      settings.overlayProgressEnabled,
    );
  }, [appState, progress, settings.backgroundProgressEnabled, settings.overlayProgressEnabled]);

  return null;
}
