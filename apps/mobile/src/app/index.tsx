import { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { Icon } from "@/components/Icon";
import { getHosts, removeHost, type StoredHost } from "@/lib/hosts";
import { useApp, type ConnStatus } from "@/lib/store";

const statusLabel: Record<ConnStatus, string> = {
  idle: "未连接",
  connecting: "连接中…",
  reconnecting: "重连中…",
  connected: "已连接",
  failed: "连接失败",
};

const statusColor: Record<ConnStatus, string> = {
  idle: "#5a5a66",
  connecting: "#d9a441",
  reconnecting: "#d9a441",
  connected: "#4dbd74",
  failed: "#e5534b",
};

export default function HostsScreen() {
  const [hosts, setLocal] = useState<StoredHost[]>([]);
  const setHosts = useApp((s) => s.setHosts);
  const runtimes = useApp((s) => s.runtimes);

  useFocusEffect(
    useCallback(() => {
      void getHosts().then((h) => {
        setLocal(h);
        setHosts(h);
      });
    }, [setHosts]),
  );

  const onDelete = (h: StoredHost): void => {
    Alert.alert("删除主机", `移除「${h.name}」的配对?`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          void removeHost(h.id).then(() => getHosts()).then((rest) => {
            setLocal(rest);
            setHosts(rest);
          });
        },
      },
    ]);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Prospero",
          // 不用 headerLargeTitle:大标题要求可滚动组件是屏幕直接子级并设置
          // contentInsetAdjustmentBehavior,而这些屏幕上方还有状态条/筛选条。
          // 强行开启会给内容加上大幅内边距,把列表整个推出可视区(实测白屏)。
          headerRight: () => (
            <Pressable onPress={() => router.push("/pair")} hitSlop={8}>
              <Icon name="qrcode.viewfinder" size={21} color="#7aa2f7" />
            </Pressable>
          ),
        }}
      />
      {hosts.length === 0 ? (
        <View style={styles.empty}>
          <Icon name="desktopcomputer" size={52} color="#3a3a46" />
          <Text style={styles.emptyTitle}>还没有配对的 Mac</Text>
          <Text style={styles.emptyText}>在 Mac 上运行 prosperod 并生成配对码:</Text>
          <Text style={styles.code}>prosperod start{"\n"}prosperod pair</Text>
          <Pressable style={styles.primaryBtn} onPress={() => router.push("/pair")}>
            <Text style={styles.primaryBtnText}>扫码配对</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={hosts}
          keyExtractor={(h) => h.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const status = runtimes[item.id]?.status ?? "idle";
            return (
              <Pressable
                style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                onPress={() => router.push(`/host/${item.id}`)}
                onLongPress={() => onDelete(item)}
              >
                <View style={[styles.dot, { backgroundColor: statusColor[status] }]} />
                <View style={styles.cardBody}>
                  <Text style={styles.cardTitle}>{item.name}</Text>
                  <Text style={styles.cardSub}>
                    {statusLabel[status]}
                    {item.addrs.length > 1 ? ` · ${String(item.addrs.length)} 条线路` : ""}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  link: { color: "#7aa2f7", fontSize: 16 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  emptyTitle: { color: "#e8e8ee", fontSize: 20, fontWeight: "600" },
  emptyText: { color: "#9a9aa6", fontSize: 14, textAlign: "center" },
  code: {
    color: "#b7c7ff",
    fontFamily: "Menlo",
    fontSize: 13,
    backgroundColor: "#17171d",
    padding: 12,
    borderRadius: 8,
    overflow: "hidden",
  },
  primaryBtn: {
    marginTop: 12,
    backgroundColor: "#3557b7",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  list: { padding: 12, gap: 10 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#17171d",
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  cardPressed: { backgroundColor: "#1f1f27" },
  dot: { width: 10, height: 10, borderRadius: 5 },
  cardBody: { flex: 1, gap: 2 },
  cardTitle: { color: "#e8e8ee", fontSize: 16, fontWeight: "600" },
  cardSub: { color: "#8a8a96", fontSize: 12 },
});
