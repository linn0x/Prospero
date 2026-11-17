import { useEffect } from "react";
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, useAnimatedValue, View } from "react-native";
import { useMobileTheme } from "@/lib/theme";

export function HomeModeTitle({ edge, onToggle }: { edge: boolean; onToggle: () => void }) {
  const { palette } = useMobileTheme();
  const scale = useAnimatedValue(1);
  useEffect(() => {
    let active = true;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (reduce) => {
      if (reduce) { scale.stopAnimation(); scale.setValue(1); }
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!active || reduce) return;
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.06, duration: 100, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, speed: 24, bounciness: 4, useNativeDriver: true }),
      ]).start();
    }).catch(() => undefined);
    return () => { active = false; subscription.remove(); scale.stopAnimation(); scale.setValue(1); };
  }, [edge, scale]);
  return (
    <Pressable
      testID="home-mode-toggle"
      accessibilityRole="button"
      accessibilityLabel={edge ? "Prospero Edge 模式，切换到普通模式" : "Prospero 普通模式，切换到 Edge 模式"}
      accessibilityHint="点击或长按标题切换模式"
      onPress={onToggle}
      onLongPress={onToggle}
      style={styles.touch}
    >
      <Animated.View style={[styles.wordmark, { transform: [{ scale }] }]}>
        <Text style={[styles.title, { color: palette.text }]}>Prospero</Text>
        {edge && (
          <View style={[styles.edgeBadge, { backgroundColor: palette.text }]}>
            <Text style={[styles.edgeBadgeText, { color: palette.bg }]}>EDGE</Text>
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  touch: { minHeight: 44, justifyContent: "center", paddingRight: 8 },
  wordmark: { flexDirection: "row", alignItems: "center", gap: 7 },
  title: { fontSize: 21, fontWeight: "700", letterSpacing: -0.6 },
  edgeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  edgeBadgeText: { fontSize: 9.5, fontWeight: "800", letterSpacing: 0.6 },
});
