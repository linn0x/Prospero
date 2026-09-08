import { useEffect } from "react";
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, useAnimatedValue } from "react-native";
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
        <Text style={[styles.title, { color: edge ? palette.accent : palette.text }, edge && styles.edge]}>Prospero</Text>
        {edge && <Text style={[styles.plus, { color: palette.accent }]}>+</Text>}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  touch: { minHeight: 44, justifyContent: "center", paddingRight: 8 },
  wordmark: { flexDirection: "row", alignItems: "center" },
  title: { fontSize: 20, fontWeight: "600" },
  edge: { fontStyle: "italic" },
  plus: { fontSize: 19, fontWeight: "700", marginLeft: 2, alignSelf: "flex-start" },
});
