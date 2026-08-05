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
import { SwipeRow } from "@/components/SwipeRow";
import { getHosts, removeHost, type StoredHost } from "@/lib/hosts";
import { useApp, type ConnStatus } from "@/lib/store";
import { color, font, radius, space, statusColor } from "@/lib/theme";

const statusLabel: Record<ConnStatus, string> = {
  idle: "未连接",
  connecting: "连接中…",
  reconnecting: "重连中…",
  connected: "已连接",
  failed: "连接失败",
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
    void removeHost(h.id)
      .then(() => getHosts())
      .then((rest) => {
        setLocal(rest);
        setHosts(rest);
      });
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
              <Icon name="qrcode.viewfinder" size={21} color={color.accent} />
            </Pressable>
          ),
        }}
      />
      {hosts.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Icon name="desktopcomputer" size={52} color={color.textFaint} />
          <Text style={styles.emptyTitle}>还没有配对的 Mac</Text>
          <Text style={styles.emptyText}>在 Mac 上运行 prosperod 并生成配对码:</Text>
          <Text style={styles.code}>prosperod start{"\n"}prosperod pair</Text>
          <Pressable style={styles.cta} onPress={() => router.push("/pair")}>
            <Text style={styles.ctaText}>扫码配对</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={hosts}
          keyExtractor={(h) => h.id}
          contentContainerStyle={styles.list}
          ListFooterComponent={
            hosts.length > 0 ? (
              <Text style={styles.swipeHint}>左滑可编辑连接地址或删除配对</Text>
            ) : null
          }
          renderItem={({ item }) => {
            const status = runtimes[item.id]?.status ?? "idle";
            return (
              <SwipeRow
                actions={[
                  {
                    label: "编辑",
                    symbol: "desktopcomputer",
                    color: "#3a6ea5",
                    onPress: () => router.push(`/host/${item.id}/edit`),
                  },
                  {
                    label: "删除",
                    symbol: "trash",
                    color: "#e5534b",
                    onPress: () => onDelete(item),
                    confirm: {
                      title: `移除「${item.name}」的配对?`,
                      message: "凭证会从这台手机删除,要再用得重新扫码配对。",
                      confirmLabel: "删除",
                    },
                  },
                ]}
              >
              <Pressable
                style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                onPress={() => router.push(`/host/${item.id}`)}
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
              </SwipeRow>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  list: { padding: space.lg, gap: space.md },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
  },
  cardPressed: { backgroundColor: color.pressed },
  dot: { width: 9, height: 9, borderRadius: 5 },
  cardBody: { flex: 1, gap: 3 },
  cardTitle: { ...font.body, fontSize: 16 },
  cardSub: font.sub,
  swipeHint: { ...font.meta, textAlign: "center", paddingVertical: space.lg },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.md },
  emptyTitle: { ...font.title, textAlign: "center" },
  emptyText: { ...font.sub, textAlign: "center", lineHeight: 20 },
  code: {
    ...font.mono,
    color: color.textDim,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    padding: space.md,
    overflow: "hidden",
  },
  cta: {
    backgroundColor: color.accentDim,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    marginTop: space.sm,
  },
  ctaText: { color: color.text, fontSize: 15, fontWeight: "600" },
});
