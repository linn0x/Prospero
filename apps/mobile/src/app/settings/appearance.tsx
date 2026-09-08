import { Switch } from "react-native";
import { SettingsGroup, SettingsOptions, SettingsPage, SettingsRow, useSettingsStyle } from "@/components/settings/SettingsLayout";
import { ConversationFontControl } from "@/components/ConversationFontControl";
import { useSettingsPreferences } from "@/lib/use-settings-preferences";
import { HOME_RECENT_SESSION_LIMITS, type HomeThemeMode } from "@/lib/home-preferences";

const themeOptions: readonly { value: HomeThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" },
];

export default function AppearanceSettingsScreen() {
  const { settings, updateSettings } = useSettingsPreferences();
  const { palette } = useSettingsStyle();
  return <SettingsPage title="外观" detail="调整主题、对话文字、首页显示与操作反馈。">
    <SettingsGroup title="主题" note="立即应用到整个应用；跟随系统会自动切换浅色与深色。">
      <SettingsOptions label="主题模式" value={settings.themeMode} options={themeOptions} onChange={(themeMode) => { updateSettings({ themeMode }); }} />
    </SettingsGroup>
    <SettingsGroup title="对话阅读" note="正文、代码、公式和输入文字同步调整；终端保留独立字号。">
      <ConversationFontControl value={settings.conversationFontSize} onChange={(conversationFontSize) => updateSettings({ conversationFontSize })} />
    </SettingsGroup>
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
