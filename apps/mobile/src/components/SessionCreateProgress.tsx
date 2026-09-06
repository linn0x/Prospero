import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { color, radius, space } from "@/lib/theme";

/** A local send is observable; remote initialization is not, until its result arrives. */
export function SessionCreateProgress({ startedAt, delivery, onBrowse, onStop }: {
  startedAt: number;
  delivery: "sent" | "queued";
  onBrowse?: () => void;
  onStop: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  const title = delivery === "sent" ? "请求已发送，等待电脑返回会话" : "请求仍在本机等待发送";

  return (
    <View style={styles.card}>
      <View style={styles.heading}>
        <ActivityIndicator size="small" color={color.accent} />
        <Text style={styles.title} accessibilityLiveRegion="polite">{title}</Text>
        <Text style={styles.elapsed} accessibilityLabel={`已等待 ${seconds} 秒`}>{seconds}s</Text>
      </View>
      <Text style={styles.detail}>
        {seconds >= 12
          ? "等待比平时久，可以先查看其他会话。停止等待不会撤销电脑上的创建请求，请先查看列表再重试。"
          : "可以继续浏览会话；打开其他会话后，将停止本次自动跳转。"}
      </Text>
      <View style={styles.actions}>
        {onBrowse && (
          <Pressable accessibilityRole="button" onPress={onBrowse} style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
            <Text style={styles.actionText}>查看会话列表</Text>
          </Pressable>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityHint="停止手机等待，不撤销电脑上的创建请求"
          onPress={onStop}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={styles.stopText}>停止等待</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: space.md, marginVertical: space.sm, paddingHorizontal: space.md, paddingTop: space.sm, borderRadius: radius.md, backgroundColor: color.surface },
  heading: { flexDirection: "row", alignItems: "center", gap: space.sm },
  title: { flex: 1, minWidth: 0, color: color.text, fontSize: 13, fontWeight: "600" },
  elapsed: { color: color.textDim, fontSize: 12, fontVariant: ["tabular-nums"] },
  detail: { marginTop: space.xs, color: color.textDim, fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm },
  action: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.sm },
  actionText: { color: color.accent, fontSize: 13, fontWeight: "600" },
  stopText: { color: color.textDim, fontSize: 13 },
  pressed: { backgroundColor: color.pressed },
});
