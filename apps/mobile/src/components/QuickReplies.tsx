import { Pressable, ScrollView, StyleSheet, Text } from "react-native";

/**
 * 快捷回复:手机上打字成本高,把高频短回复做成一键。
 * 会话忙碌与空闲时给出不同组合。
 */
const IDLE_REPLIES = [
  "继续",
  "go ahead",
  "看起来不错",
  "跑一下测试",
  "解释一下",
  "总结一下",
  "提交这些改动",
];

const BUSY_REPLIES = ["等一下", "换个思路", "先别改文件"];

export function QuickReplies({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: (text: string) => void;
}) {
  const items = busy ? BUSY_REPLIES : IDLE_REPLIES;
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={styles.bar}
      contentContainerStyle={styles.content}
    >
      {items.map((t) => (
        <Pressable
          key={t}
          onPress={() => onPick(t)}
          style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
          accessibilityRole="button"
          accessibilityLabel={`快速发送：${t}`}
        >
          <Text style={styles.chipText}>{t}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { flexGrow: 0, backgroundColor: "#141419" },
  content: { paddingHorizontal: 10, paddingTop: 7, paddingBottom: 3, gap: 7 },
  chip: {
    minHeight: 32,
    justifyContent: "center",
    backgroundColor: "#24242B",
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipPressed: { backgroundColor: "#34343E", transform: [{ scale: 0.98 }] },
  chipText: { color: "#C6C6D0", fontSize: 12.5, fontWeight: "500" },
});
