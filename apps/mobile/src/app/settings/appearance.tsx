import { SettingsGroup, SettingsOptions, SettingsPage } from "@/components/settings/SettingsLayout";
import { useSettingsPreferences } from "@/lib/use-settings-preferences";
import type { HomeThemeMode } from "@/lib/home-preferences";

const themeOptions: readonly { value: HomeThemeMode; label: string }[] = [
  { value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" },
];

export default function AppearanceSettingsScreen() {
  const { settings, updateSettings } = useSettingsPreferences();
  return <SettingsPage title="外观" detail="调整 Prospero 的显示主题。">
    <SettingsGroup title="主题" note="立即应用到整个应用；跟随系统会自动切换浅色与深色。">
      <SettingsOptions label="主题模式" value={settings.themeMode} options={themeOptions} onChange={(themeMode) => { updateSettings({ themeMode }); }} />
    </SettingsGroup>
  </SettingsPage>;
}
