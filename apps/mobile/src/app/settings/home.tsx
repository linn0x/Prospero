import { Switch } from "react-native";
import { SettingsGroup, SettingsOptions, SettingsPage, SettingsRow, useSettingsStyle } from "@/components/settings/SettingsLayout";
import { HOME_RECENT_SESSION_LIMITS } from "@/lib/home-preferences";
import { useSettingsPreferences } from "@/lib/use-settings-preferences";

export default function HomeSettingsScreen() {
  const { settings, updateSettings } = useSettingsPreferences();
  const { palette } = useSettingsStyle();
  return <SettingsPage title="首页与交互" detail="调整首页的信息密度与操作反馈。">
    <SettingsGroup title="最近对话数量" note="仅改变首页展示数量，不会删除历史会话。">
      <SettingsOptions label="首页最近对话数量" value={settings.recentSessionLimit}
        options={HOME_RECENT_SESSION_LIMITS.map((value) => ({ value, label: String(value) }))}
        onChange={(recentSessionLimit) => updateSettings({ recentSessionLimit })} />
    </SettingsGroup>
    <SettingsGroup title="操作反馈">
      <SettingsRow title="设备切换震动" detail="长按进入快速切换、滑过设备时提供轻微反馈" last>
        <Switch accessibilityLabel="设备切换震动" value={settings.deviceSwitcherHapticsEnabled}
          onValueChange={(deviceSwitcherHapticsEnabled) => updateSettings({ deviceSwitcherHapticsEnabled })}
          trackColor={{ false: palette.border, true: palette.accentDim }}
          thumbColor={settings.deviceSwitcherHapticsEnabled ? palette.accent : palette.textDim} />
      </SettingsRow>
    </SettingsGroup>
  </SettingsPage>;
}
