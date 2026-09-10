import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ReorderList } from "@/components/ReorderList";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/Toast";
import { homeWorkspaceProjects } from "@/lib/home-dashboard";
import { workspaceAliasKey } from "@/lib/home-preferences";
import { useSettingsDevices } from "@/lib/use-settings-devices";
import { useHostConnection } from "@/lib/use-host-connection";
import { useSettingsPreferences } from "@/lib/use-settings-preferences";
import { useOrderedWorkspaces, useWorkspaceOrder } from "@/lib/workspace-order-preferences";
import { useMobileTheme } from "@/lib/theme";

export default function WorkspaceOrderScreen() {
  const { palette } = useMobileTheme();
  const insets = useSafeAreaInsets();
  const { hosts } = useSettingsDevices();
  const { settings } = useSettingsPreferences();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const hostId = hosts.find((host) => host.id === selectedId)?.id ?? hosts[0]?.id;
  const { runtime } = useHostConnection(hostId);
  const projects = useMemo(() => homeWorkspaceProjects(runtime.sessions), [runtime.sessions]);
  const ordered = useOrderedWorkspaces(hostId, projects);
  const hydrated = useWorkspaceOrder((state) => state.hydrated);
  const saveOrder = useWorkspaceOrder((state) => state.saveOrder);
  const reorder = useCallback((paths: string[]) => {
    if (hostId) void saveOrder(hostId, paths).catch(() => toast("目录排序暂未保存，请重试"));
  }, [hostId, saveOrder]);
  const items = useMemo(() => ordered.map((project) => ({
    id: project.path, title: settings.workspaceAliases[workspaceAliasKey(hostId ?? "", project.path)] ?? project.name,
    subtitle: project.path, icon: <Icon name="folder.fill" size={20} color={palette.accent} />,
  })), [ordered, hostId, settings.workspaceAliases, palette]);
  return <View style={[styles.screen, { backgroundColor: palette.bg, paddingBottom: insets.bottom }]}>
    <Stack.Screen options={{ title: "目录排序", headerBackButtonDisplayMode: "minimal" }} />
    <View style={styles.heading}>
      <Text style={[styles.title, { color: palette.text }]}>排列工作目录</Text>
      <Text style={[styles.detail, { color: palette.textDim }]}>选择设备，拖动右侧把手排序。松手自动保存，同步到首页和设备会话列表。</Text>
      {hosts.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.devices}>
        {hosts.map((host) => <Pressable key={host.id} accessibilityRole="button" accessibilityState={{ selected: host.id === hostId }}
          onPress={() => setSelectedId(host.id)} style={[styles.device, { backgroundColor: host.id === hostId ? palette.accentBg : palette.surface }]}>
          <Text numberOfLines={1} style={{ color: host.id === hostId ? palette.accent : palette.textDim }}>{host.name}</Text>
        </Pressable>)}
      </ScrollView>}
    </View>
    {items.length > 0 ? <ReorderList key={hostId} testID="workspace-order" items={items} enabled={hydrated} onReorder={reorder} />
      : <View style={styles.empty}>
        <Icon name="folder.fill" size={32} color={palette.textFaint} />
        <Text style={[styles.detail, { color: palette.textDim }]}>{!hostId ? "配对设备后，可在这里排列目录"
          : runtime.status === "connected" ? "这台设备还没有工作目录"
          : runtime.status === "failed" ? "连接失败，重新连接后可读取目录" : "连接设备后读取工作目录…"}</Text>
      </View>}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 }, heading: { padding: 20, gap: 10 },
  title: { fontSize: 18, fontWeight: "700" }, detail: { fontSize: 12, lineHeight: 19 },
  devices: { gap: 8 }, device: { minHeight: 44, maxWidth: 180, justifyContent: "center", paddingHorizontal: 14, borderRadius: 22 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
});
