import { router } from "expo-router";
import { SettingsGroup, SettingsLink, SettingsPage, SettingsRow } from "@/components/settings/SettingsLayout";
import { DeviceConnectionRow } from "@/components/settings/DeviceConnectionRow";
import { useSettingsDevices } from "@/lib/use-settings-devices";

export default function DeviceSettingsScreen() {
  const { hosts, runtimes } = useSettingsDevices();
  return <SettingsPage title="设备管理" detail="管理配对设备、显示顺序与连接方式。">
    <SettingsGroup>
      <SettingsLink title="设备排序" detail="拖拽调整首页与详情卡片的顺序" icon="square.stack.3d.up" onPress={() => router.push("/device-order")} />
      <SettingsLink title="目录排序" detail="按设备拖拽排列工作目录" icon="folder.fill" onPress={() => router.push("/workspace-order")} />
      <SettingsLink title="添加设备" detail="扫码或使用 IP 和配对码连接" icon="plus" onPress={() => router.push("/pair")} last />
    </SettingsGroup>
    <SettingsGroup title={`已配对设备 · ${hosts.length}`} note="点击设备可管理直连地址、端口、连接方式和 Relay。">
      {hosts.length > 0 ? hosts.map((host, index) => <DeviceConnectionRow key={host.id} host={host} runtime={runtimes[host.id]} last={index === hosts.length - 1} />)
        : <SettingsRow title="还没有配对设备" detail="添加设备后，可在这里管理连接方式" last>{null}</SettingsRow>}
    </SettingsGroup>
  </SettingsPage>;
}
