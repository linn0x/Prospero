import { router } from "expo-router";
import { SettingsGroup, SettingsLink, SettingsPage } from "@/components/settings/SettingsLayout";
import { useSettingsPreferences } from "@/lib/use-settings-preferences";
import { useSettingsDevices } from "@/lib/use-settings-devices";

const themeLabels = { system: "跟随系统", light: "浅色", dark: "深色" };

export default function SettingsScreen() {
  const { settings } = useSettingsPreferences();
  const { hosts } = useSettingsDevices();
  return <SettingsPage title="设置">
    <SettingsGroup title="偏好设置">
      <SettingsLink title="外观" detail={`${themeLabels[settings.themeMode]} · 显示主题`}
        icon="circle.lefthalf.filled" onPress={() => router.push("/settings/appearance")} />
      <SettingsLink title="首页与交互" detail={`最近 ${settings.recentSessionLimit} 条对话 · 操作反馈`}
        icon="house.fill" onPress={() => router.push("/settings/home")} />
      <SettingsLink title="通知" detail="后台任务进度与悬浮窗"
        icon="bell.fill" onPress={() => router.push("/settings/notifications")} last />
    </SettingsGroup>
    <SettingsGroup title="设备">
      <SettingsLink title="设备管理" detail={hosts.length ? `${hosts.length} 台设备 · 配对、排序与连接` : "配对、排序与连接设置"}
        icon="desktopcomputer" onPress={() => router.push("/settings/devices")} last />
    </SettingsGroup>
  </SettingsPage>;
}
