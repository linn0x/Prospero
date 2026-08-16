import { useCallback, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "@/components/Icon";
import { SwipeRow } from "@/components/SwipeRow";
import { useAdaptiveLayout } from "@/lib/adaptive-layout";
import { getConnection, wireAppStateReconnect } from "@/lib/connection";
import {
  HOME_EMPTY_STATE_MIN_HIT_TARGET,
  homeEmptyStateLayout,
} from "@/lib/home-empty-state-layout";
import { getDeviceKeys, getHosts, removeHost, type StoredHost } from "@/lib/hosts";
import { clearSessionPreferences } from "@/lib/session-preferences";
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
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const adaptiveLayout = useAdaptiveLayout();
  const hostColumns =
    adaptiveLayout.verticalPanes !== null || adaptiveLayout.isExpanded ? 2 : 1;
  const columnGap = adaptiveLayout.verticalPanes?.gap ?? space.lg;
  const regularColumnWidth =
    (adaptiveLayout.width - space.lg * 2 - columnGap) / 2;
  const emptyStatePaneWidth =
    adaptiveLayout.verticalPanes?.end ?? adaptiveLayout.width;
  const emptyStateLayout = homeEmptyStateLayout({
    viewportWidth: emptyStatePaneWidth,
    bottomInset: insets.bottom,
    fontScale,
  });
  const [hosts, setLocal] = useState<StoredHost[]>([]);
  const setHosts = useApp((s) => s.setHosts);
  const runtimes = useApp((s) => s.runtimes);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const h = await getHosts();
        if (cancelled) return;
        setLocal(h);
        setHosts(h);
        // 冷启动后每台机器都显示"未连接",因为连接要等你点进主机页才建立 ——
        // 那其实是"还没问过",却和"连不上"长得一模一样,而这两件事该做的处理
        // 完全相反。开 App 就把已配对的机器连起来:状态是真的,点进去也不用
        // 再等一次握手。start() 幂等,连接按主机缓存,进主机页时复用同一条。
        const keys = await getDeviceKeys();
        if (cancelled) return;
        wireAppStateReconnect();
        for (const host of h) getConnection(host, keys).start();
      })();
      return () => {
        cancelled = true;
      };
    }, [setHosts]),
  );

  const onDelete = (h: StoredHost): void => {
    void Promise.all([
      removeHost(h.id),
      clearSessionPreferences(h.id).catch(() => undefined),
    ])
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="扫码配对"
              accessibilityHint="打开相机扫描电脑上的配对二维码"
              onPress={() => router.push("/pair")}
              style={styles.headerButton}
            >
              <Icon name="qrcode.viewfinder" size={21} color={color.accent} />
            </Pressable>
          ),
        }}
      />
      {hosts.length === 0 ? (
        <ScrollView
          testID="hosts-empty-state-scroll"
          style={[
            styles.emptyScroll,
            adaptiveLayout.verticalPanes && {
              width: adaptiveLayout.verticalPanes.end,
              alignSelf: "flex-end",
            },
          ]}
          contentContainerStyle={emptyStateLayout.contentContainer}
          keyboardShouldPersistTaps="handled"
          scrollEnabled
          showsVerticalScrollIndicator={false}
        >
          <View style={[styles.emptyWrap, emptyStateLayout.body]}>
            <Icon name="desktopcomputer" size={52} color={color.textFaint} />
            <Text style={styles.emptyTitle}>还没有配对的电脑</Text>
            <Text style={styles.emptyText}>在电脑上运行 prosperod 并生成配对码:</Text>
            <Text style={styles.code}>prosperod start{"\n"}prosperod pair</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="扫码配对"
              accessibilityHint="打开相机扫描电脑上的配对二维码"
              style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
              onPress={() => router.push("/pair")}
            >
              <Text style={styles.ctaText}>扫码配对</Text>
            </Pressable>
          </View>
        </ScrollView>
      ) : (
        <FlatList
          key={`hosts-${String(hostColumns)}`}
          data={hosts}
          numColumns={hostColumns}
          keyExtractor={(h) => h.id}
          columnWrapperStyle={
            hostColumns === 2 ? { gap: columnGap } : undefined
          }
          contentContainerStyle={[
            styles.list,
            hostColumns === 2 &&
              (adaptiveLayout.verticalPanes
                ? styles.listFolded
                : styles.listExpanded),
            { paddingBottom: insets.bottom + 20 },
          ]}
          ListFooterComponent={
            hosts.length > 0 ? (
              <Text style={styles.swipeHint}>左滑可编辑连接地址或删除配对</Text>
            ) : null
          }
          renderItem={({ item, index }) => {
            const runtime = runtimes[item.id];
            const status = runtime?.status ?? "idle";
            const path = runtime?.activePath === "relay" ? "中继" : runtime?.activePath === "direct" ? "直连" : null;
            const columnWidth = adaptiveLayout.verticalPanes
              ? index % 2 === 0
                ? adaptiveLayout.verticalPanes.start
                : adaptiveLayout.verticalPanes.end
              : regularColumnWidth;
            return (
              <View
                style={[
                  hostColumns === 2 && styles.hostColumn,
                  hostColumns === 2 && { width: columnWidth },
                  adaptiveLayout.verticalPanes && styles.hostColumnFolded,
                ]}
              >
                <SwipeRow
                  clipRadius={radius.md}
                  actions={[
                    {
                      id: "edit-host",
                      label: "编辑",
                      symbol: "desktopcomputer",
                      color: "#3a6ea5",
                      onPress: () => router.push(`/host/${item.id}/edit`),
                    },
                    {
                      id: "delete-host",
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
                        {path ? ` · ${path}` : ""}
                        {item.addrs.length > 1 ? ` · ${String(item.addrs.length)} 条线路` : ""}
                      </Text>
                    </View>
                  </Pressable>
                </SwipeRow>
              </View>
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
  listExpanded: { gap: space.lg },
  listFolded: { paddingHorizontal: 0 },
  hostColumn: { flexShrink: 0 },
  hostColumnFolded: { paddingHorizontal: space.lg },
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
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  swipeHint: { ...font.meta, textAlign: "center", paddingVertical: space.lg },
  emptyScroll: { flex: 1 },
  emptyWrap: { alignItems: "center", gap: space.md },
  emptyTitle: { ...font.title, textAlign: "center" },
  emptyText: { ...font.sub, textAlign: "center", alignSelf: "stretch" },
  code: {
    ...font.mono,
    color: color.textDim,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.sm,
    padding: space.md,
    alignSelf: "stretch",
    maxWidth: "100%",
  },
  cta: {
    backgroundColor: color.accentDim,
    borderRadius: radius.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    marginTop: space.sm,
    minHeight: HOME_EMPTY_STATE_MIN_HIT_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaPressed: { backgroundColor: color.pressed },
  ctaText: { color: color.text, fontSize: 15, fontWeight: "600", textAlign: "center" },
});
