import { Pressable, ScrollView, StyleSheet, Text } from "react-native";

import { createThemedStyles } from "@/lib/theme";
import { DEFAULT_QUICK_REPLIES, type QuickReplySettings } from "@/lib/quick-replies";

/**
 * 快捷回复:手机上打字成本高,把高频短回复做成一键。
 * 会话忙碌与空闲时给出不同组合。
 */
export function QuickReplies({
  busy,
  onPick,
  replies = DEFAULT_QUICK_REPLIES,
}: {
  busy: boolean;
  onPick: (text: string) => void;
  replies?: QuickReplySettings;
}) {
  const styles = useStyles();
  const items = busy ? replies.busy : replies.idle;
  if (items.length === 0) return null;
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

const useStyles = createThemedStyles((color) => StyleSheet.create({
  bar: { flexGrow: 0, backgroundColor: color.surface },
  content: { paddingHorizontal: 10, paddingTop: 7, paddingBottom: 3, gap: 7 },
  chip: {
    minHeight: 32,
    justifyContent: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipPressed: { backgroundColor: color.pressed, transform: [{ scale: 0.98 }] },
  chipText: { color: color.textDim, fontSize: 12.5, fontWeight: "500" },
}));
