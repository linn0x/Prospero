import { useLayoutEffect, useRef, useState } from "react";
import { PanResponder, StyleSheet, View } from "react-native";
import { useMobileTheme } from "@/lib/theme";

/** A wide touch target around a narrow, visible split-pane divider. */
export function ResizeHandle({ value, min, max, onChange, label }: {
  value: number; min: number; max: number; onChange(value: number): void; label: string;
}) {
  const { palette } = useMobileTheme();
  const current = useRef({ value, min, max, onChange });
  const start = useRef(value);
  useLayoutEffect(() => { current.current = { value, min, max, onChange }; }, [value, min, max, onChange]);
  /* eslint-disable react-hooks/refs */
  const [responder] = useState(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { start.current = current.current.value; },
    onPanResponderMove: (_event, gesture) => {
      const { min: lower, max: upper, onChange: update } = current.current;
      update(Math.max(lower, Math.min(upper, start.current + gesture.dx)));
    },
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }));
  /* eslint-enable react-hooks/refs */
  return <View {...responder.panHandlers} collapsable={false} style={styles.handle}
    accessible accessibilityRole="adjustable" accessibilityLabel={label}
    accessibilityHint="左右拖动调整宽度，也可使用辅助功能调整"
    accessibilityValue={{ min: Math.round(min), max: Math.round(max), now: Math.round(value) }}
    accessibilityActions={[{ name: "decrement", label: "缩小左侧" }, { name: "increment", label: "扩大左侧" }]}
    onAccessibilityAction={({ nativeEvent }) => {
      const delta = nativeEvent.actionName === "increment" ? 32 : nativeEvent.actionName === "decrement" ? -32 : 0;
      if (delta) onChange(Math.max(min, Math.min(max, value + delta)));
    }}>
    <View style={[styles.mark, { backgroundColor: palette.textFaint }]} />
  </View>;
}

const styles = StyleSheet.create({
  handle: { flex: 1, width: 24, alignSelf: "stretch", justifyContent: "center", alignItems: "center" },
  mark: { width: 4, height: 40, borderRadius: 2, opacity: 0.65 },
});
