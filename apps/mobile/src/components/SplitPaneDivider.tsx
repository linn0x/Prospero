import { useLayoutEffect, useRef, useState } from "react";
import { PanResponder, Pressable, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useMobileTheme } from "@/lib/theme";

const TOUCH_SLOP_HALF = 14;
const DOUBLE_TAP_MS = 300;

/**
 * Tactile split-pane divider for unfolded foldables and tablets.
 *
 * - Keeps an exact `gap` layout width so neither column shifts at rest.
 * - Accepts horizontal drags anywhere along the vertical seam without swallowing
 *   vertical list scrolling or taps on neighboring controls.
 * - Double-tapping the center handle resets back to the default split width.
 */
export function SplitPaneDivider({
  value,
  min,
  max,
  gap = 1,
  label,
  disabled = false,
  onChange,
  onCommit,
  onReset,
}: {
  value: number;
  min: number;
  max: number;
  gap?: number;
  label: string;
  disabled?: boolean;
  onChange?: (next: number) => void;
  onCommit?: (next: number) => void;
  onReset?: () => void;
}) {
  const { palette } = useMobileTheme();
  const [dragging, setDragging] = useState(false);
  const current = useRef({ value, min, max, disabled, onChange, onCommit, onReset });
  const dragState = useRef({ startValue: value, lastClamped: value, hitEdge: false });
  const lastTapAt = useRef(0);

  useLayoutEffect(() => {
    current.current = { value, min, max, disabled, onChange, onCommit, onReset };
  }, [disabled, max, min, onChange, onCommit, onReset, value]);

  /* eslint-disable react-hooks/refs */
  const [responder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_event, gesture) => {
        if (current.current.disabled || !current.current.onChange) return false;
        return Math.abs(gesture.dx) > 4 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.1;
      },
      onPanResponderGrant: () => {
        const { value: now } = current.current;
        dragState.current = { startValue: now, lastClamped: now, hitEdge: false };
        setDragging(true);
        void Haptics.selectionAsync().catch(() => undefined);
      },
      onPanResponderMove: (_event, gesture) => {
        const { min: lower, max: upper, onChange: update } = current.current;
        if (!update) return;
        const raw = dragState.current.startValue + gesture.dx;
        const clamped = Math.max(lower, Math.min(upper, raw));
        const atEdge = raw <= lower || raw >= upper;
        if (atEdge && !dragState.current.hitEdge) {
          dragState.current.hitEdge = true;
          void Haptics.selectionAsync().catch(() => undefined);
        } else if (!atEdge && dragState.current.hitEdge) {
          dragState.current.hitEdge = false;
        }
        dragState.current.lastClamped = clamped;
        update(clamped);
      },
      onPanResponderRelease: () => {
        setDragging(false);
        current.current.onCommit?.(dragState.current.lastClamped);
      },
      onPanResponderTerminate: () => {
        setDragging(false);
        current.current.onCommit?.(dragState.current.lastClamped);
      },
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    }),
  );
  /* eslint-enable react-hooks/refs */

  const handleThumbPress = (): void => {
    if (disabled || !onReset) return;
    const now = Date.now();
    if (now - lastTapAt.current <= DOUBLE_TAP_MS) {
      lastTapAt.current = 0;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      onReset();
      return;
    }
    lastTapAt.current = now;
  };

  const interactive = !disabled && Boolean(onChange);

  return (
    <View
      testID="split-pane-divider"
      collapsable={false}
      style={[
        styles.gutter,
        {
          width: Math.max(1, gap),
          backgroundColor: dragging ? palette.text : palette.border,
        },
      ]}
    >
      {interactive && (
        <View
          {...responder.panHandlers}
          collapsable={false}
          style={[
            styles.touchZone,
            {
              left: -TOUCH_SLOP_HALF,
              width: Math.max(1, gap) + TOUCH_SLOP_HALF * 2,
            },
          ]}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          accessibilityHint="左右拖动调整边栏宽度，双击中间把手恢复默认宽度"
          accessibilityValue={{
            min: Math.round(min),
            max: Math.round(max),
            now: Math.round(value),
          }}
          accessibilityActions={[
            { name: "decrement", label: "收窄左侧边栏" },
            { name: "increment", label: "加宽左侧边栏" },
          ]}
          onAccessibilityAction={({ nativeEvent }) => {
            const delta =
              nativeEvent.actionName === "increment"
                ? 32
                : nativeEvent.actionName === "decrement"
                  ? -32
                  : 0;
            if (!delta) return;
            const next = Math.max(min, Math.min(max, value + delta));
            onChange?.(next);
            onCommit?.(next);
          }}
        >
          <Pressable
            onPress={handleThumbPress}
            hitSlop={8}
            style={styles.thumbHit}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <View
              style={[
                styles.thumbPill,
                {
                  backgroundColor: dragging ? palette.text : palette.surface,
                  borderColor: dragging ? palette.text : palette.border,
                },
                dragging && styles.thumbPillDragging,
              ]}
            >
              <View
                style={[
                  styles.thumbGrip,
                  { backgroundColor: dragging ? palette.bg : palette.textFaint },
                ]}
              />
            </View>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  gutter: {
    flexShrink: 0,
    alignSelf: "stretch",
    zIndex: 20,
    overflow: "visible",
  },
  touchZone: {
    position: "absolute",
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbHit: {
    width: 24,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbPill: {
    width: 8,
    height: 40,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbPillDragging: {
    width: 10,
    height: 52,
  },
  thumbGrip: {
    width: 2,
    height: 16,
    borderRadius: 1,
  },
});
