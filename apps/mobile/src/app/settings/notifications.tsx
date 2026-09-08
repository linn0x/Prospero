import { useCallback, useState } from "react";
import { AppState, Platform, Switch } from "react-native";
import { useFocusEffect } from "expo-router";
import { SettingsGroup, SettingsPage, SettingsRow, useSettingsStyle } from "@/components/settings/SettingsLayout";
import { canDisplayProgressOverlay, isProgressOverlaySupported, openProgressOverlaySettings } from "@/lib/running-session-progress";
import { useSettingsPreferences } from "@/lib/use-settings-preferences";
import { useApp } from "@/lib/store";

export default function NotificationSettingsScreen() {
  const { settings, updateSettings } = useSettingsPreferences();
  const { palette } = useSettingsStyle();
  const [overlayAvailable, setOverlayAvailable] = useState(canDisplayProgressOverlay());
  const [overlayPermissionPending, setOverlayPermissionPending] = useState(false);
  const overlaySupported = isProgressOverlaySupported();

  useFocusEffect(useCallback(() => {
    if (Platform.OS !== "android") return;
    const reconcileOverlayPermission = () => {
      const available = canDisplayProgressOverlay();
      setOverlayAvailable(available);
      if (overlayPermissionPending) {
        setOverlayPermissionPending(false);
        if (available) updateSettings({ backgroundProgressEnabled: true, overlayProgressEnabled: true });
      } else if (!available && useApp.getState().homeSettings?.overlayProgressEnabled) {
        updateSettings({ overlayProgressEnabled: false });
      }
    };
    // Recheck on page entry as well as when returning from the Android permission screen.
    if (!overlayPermissionPending) reconcileOverlayPermission();
    else setOverlayAvailable(canDisplayProgressOverlay());
    const stateSubscription = AppState.addEventListener("change", (nextState) => { if (nextState === "active") reconcileOverlayPermission(); });
    const focusSubscription = AppState.addEventListener("focus", reconcileOverlayPermission);
    return () => { stateSubscription.remove(); focusSubscription.remove(); };
  }, [overlayPermissionPending, updateSettings]));

  return <SettingsPage title="通知" detail="离开 Prospero 后继续查看 Agent 进度。">
    {Platform.OS === "android" ? <SettingsGroup title="后台任务" note="锁屏仅显示任务数量；悬浮窗会显示审批摘要，并提供“拒绝”和“允许一次”。">
      <SettingsRow title="持续通知" detail="运行中显示状态，点按直接返回对话">
        <Switch accessibilityLabel="持续通知" value={settings.backgroundProgressEnabled}
          onValueChange={(value) => updateSettings({ backgroundProgressEnabled: value, ...(!value ? { overlayProgressEnabled: false } : {}) })}
          trackColor={{ false: palette.border, true: palette.accentDim }} thumbColor={settings.backgroundProgressEnabled ? palette.accent : palette.textDim} />
      </SettingsRow>
      <SettingsRow title="其他应用上层悬浮框" detail={!overlaySupported ? "当前安装包不包含悬浮窗模块，请更新应用"
        : overlayPermissionPending ? "请在系统页面允许显示在其他应用上层"
        : overlayAvailable ? "后台显示进度；待审批时可拒绝或允许一次" : "开启时将前往系统页面授予悬浮窗权限"} last>
        <Switch accessibilityLabel="其他应用上层悬浮框" disabled={!overlaySupported || overlayPermissionPending}
          value={settings.overlayProgressEnabled || overlayPermissionPending}
          onValueChange={(value) => {
            if (!value) { setOverlayPermissionPending(false); updateSettings({ overlayProgressEnabled: false }); return; }
            const available = canDisplayProgressOverlay();
            setOverlayAvailable(available);
            if (available) { updateSettings({ backgroundProgressEnabled: true, overlayProgressEnabled: true }); return; }
            setOverlayPermissionPending(true);
            updateSettings({ backgroundProgressEnabled: true, overlayProgressEnabled: false });
            openProgressOverlaySettings();
          }} trackColor={{ false: palette.border, true: palette.accentDim }}
          thumbColor={settings.overlayProgressEnabled || overlayPermissionPending ? palette.accent : palette.textDim} />
      </SettingsRow>
    </SettingsGroup> : <SettingsGroup note="持续通知与其他应用上层悬浮框目前仅支持 Android。"><SettingsRow title="后台任务通知" detail="当前平台暂不支持这些通知选项" last>{null}</SettingsRow></SettingsGroup>}
  </SettingsPage>;
}
