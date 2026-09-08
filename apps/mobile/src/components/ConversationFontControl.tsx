import { Pressable, StyleSheet, Text, View } from "react-native";
import { DEFAULT_CONVERSATION_FONT_SIZE, MIN_CONVERSATION_FONT_SIZE, MAX_CONVERSATION_FONT_SIZE } from "@/lib/conversation-font-size";
import { useMobileTheme } from "@/lib/theme";

export function ConversationFontControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const { palette } = useMobileTheme();
  return <View style={styles.root}>
    <View style={styles.heading}>
      <Text style={[styles.title, { color: palette.text }]}>对话字体大小</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="恢复默认对话字号"
        disabled={value === DEFAULT_CONVERSATION_FONT_SIZE} accessibilityState={{ disabled: value === DEFAULT_CONVERSATION_FONT_SIZE }}
        onPress={() => onChange(DEFAULT_CONVERSATION_FONT_SIZE)} style={styles.reset}>
        <Text style={{ color: value === DEFAULT_CONVERSATION_FONT_SIZE ? palette.textFaint : palette.accent, fontSize: 12 }}>恢复默认</Text>
      </Pressable>
    </View>
    <View style={[styles.controls, { backgroundColor: palette.bg }]}>
      {([-1, 0, 1] as const).map((delta) => {
        if (delta === 0) return <Text key="value" accessibilityLabel={`对话字号 ${value}`} accessibilityLiveRegion="polite"
          style={[styles.value, { color: palette.text }]}>{value}</Text>;
        const disabled = delta < 0 ? value <= MIN_CONVERSATION_FONT_SIZE : value >= MAX_CONVERSATION_FONT_SIZE;
        return <Pressable key={delta} accessibilityRole="button" accessibilityLabel={delta < 0 ? "缩小对话字体" : "放大对话字体"}
          accessibilityState={{ disabled }} disabled={disabled} onPress={() => onChange(value + delta)}
          style={({ pressed }) => [styles.step, { opacity: disabled ? 0.35 : 1, backgroundColor: pressed ? palette.pressed : "transparent" }]}>
          <Text style={{ color: palette.text, fontSize: delta < 0 ? 15 : 21, fontWeight: "600" }}>{delta < 0 ? "A−" : "A+"}</Text>
        </Pressable>;
      })}
    </View>
    <Text testID="conversation-font-preview" style={{ color: palette.textDim, fontSize: value, lineHeight: Math.round(value * 1.5) }}>让每一段对话，都清晰易读。</Text>
    <Text style={{ color: palette.textFaint, fontSize: 11, lineHeight: 16 }}>应用于所有对话，自动保存。</Text>
  </View>;
}

const styles = StyleSheet.create({
  root: { padding: 14, gap: 10 }, heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 14, fontWeight: "600" }, reset: { minHeight: 44, justifyContent: "center", paddingLeft: 12 },
  controls: { flexDirection: "row", alignItems: "center", borderRadius: 10 },
  step: { flex: 1, minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  value: { flex: 1, textAlign: "center", fontSize: 15, fontVariant: ["tabular-nums"], fontWeight: "600" },
});
