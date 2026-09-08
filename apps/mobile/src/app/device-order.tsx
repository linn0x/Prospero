import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Stack, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DeviceOrderList } from "@/components/DeviceOrderList";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/Toast";
import { getHosts } from "@/lib/hosts";
import { useDeviceOrder, useOrderedDevices } from "@/lib/device-order-preferences";
import { useApp } from "@/lib/store";
import { useMobileTheme, type ThemePalette } from "@/lib/theme";

export default function DeviceOrderScreen() {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const insets = useSafeAreaInsets();
  const storedHosts = useApp((state) => state.hosts);
  const hosts = useOrderedDevices(storedHosts);
  const runtimes = useApp((state) => state.runtimes);
  const hydrated = useDeviceOrder((state) => state.hydrated);
  const saveOrder = useDeviceOrder((state) => state.saveOrder);
  const [loaded, setLoaded] = useState(false);
  useFocusEffect(useCallback(() => {
    let active = true;
    void getHosts().then((devices) => {
      if (active) { useApp.getState().setHosts(devices); setLoaded(true); }
    }).catch(() => { if (active) { setLoaded(true); toast("读取设备失败，请稍后重试"); } });
    return () => { active = false; };
  }, []));
  const reorder = useCallback((ids: string[]) => {
    void saveOrder(ids).catch(() => toast("设备排序暂未保存，请重试"));
  }, [saveOrder]);
  return <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
    <Stack.Screen options={{ title: "设备排序", headerBackButtonDisplayMode: "minimal" }} />
    <View style={styles.heading}>
      <Text style={styles.title}>按你的习惯排列</Text>
      <Text style={styles.detail}>拖动右侧把手调整顺序，松手自动保存。首页与详情卡片同步更新。</Text>
    </View>
    {hosts.length > 0 ? <DeviceOrderList hosts={hosts} runtimes={runtimes} enabled={hydrated} onReorder={reorder} />
      : <View style={styles.empty}>
        <Icon name="desktopcomputer" size={32} color={palette.textFaint} />
        <Text style={styles.detail}>{loaded ? "配对设备后，可在这里调整顺序" : "正在读取设备…"}</Text>
      </View>}
  </View>;
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: palette.bg },
    heading: { padding: 20, paddingBottom: 16, gap: 6 },
    title: { color: palette.text, fontSize: 18, fontWeight: "700" },
    detail: { color: palette.textDim, fontSize: 12, lineHeight: 19 },
    empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  });
}
