import { useLayoutEffect, useRef, useState } from "react";
import { PanResponder, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useMobileTheme } from "@/lib/theme";

const TOUCH_SLOP_HALF = 14;
const DOUBLE_TAP_MS = 300;

/**
 * Tactile split-pane divider for unfolded foldables and tablets.
 *
 * - Keeps an exact `gap` Yoga layout footprint via negative horizontal margins
 *   while giving Android's native touch hit-tester a >=29dp target above siblings.
 * - Captures horizontal drags on the seam ahead of sibling ScrollViews/WebViews.
 * - Double-tapping the divider resets back to the default split width.
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
  const dragState = useRef({ startValue: value, lastClamped: value, hitEdge: false, moved: false });
  const lastTapAt = useRef(0);

  useLayoutEffect(() => {
    current.current = { value, min, max, disabled, onChange, onCommit, onReset };
  }, [disabled, max, min, onChange, onCommit, onReset, value]);

  const canDrag = (): boolean => !current.current.disabled && Boolean(current.current.onChange);

  /* eslint-disable react-hooks/refs */
  const [responder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => canDrag(),
      onStartShouldSetPanResponderCapture: () => canDrag(),
      onMoveShouldSetPanResponder: () => canDrag(),
      onMoveShouldSetPanResponderCapture: () => canDrag(),
      onPanResponderGrant: () => {
        const { value: now } = current.current;
        dragState.current = { startValue: now, lastClamped: now, hitEdge: false, moved: false };
      },
      onPanResponderMove: (_event, gesture) => {
        const { min: lower, max: upper, onChange: update } = current.current;
        if (!update) return;
        if (!dragState.current.moved && Math.abs(gesture.dx) > 2) {
          dragState.current.moved = true;
          setDragging(true);
          void Haptics.selectionAsync().catch(() => undefined);
        }
        if (!dragState.current.moved) return;
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
      onPanResponderRelease: (_event, gesture) => {
        if (dragState.current.moved) {
          setDragging(false);
          current.current.onCommit?.(dragState.current.lastClamped);
          return;
        }
        setDragging(false);
        if (Math.abs(gesture.dx) < 6 && Math.abs(gesture.dy) < 6 && !current.current.disabled && current.current.onReset) {
          const now = Date.now();
          if (now - lastTapAt.current <= DOUBLE_TAP_MS) {
            lastTapAt.current = 0;
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
            current.current.onReset();
          } else {
            lastTapAt.current = now;
          }
        }
      },
      onPanResponderTerminate: () => {
        setDragging(false);
        if (dragState.current.moved) {
          current.current.onCommit?.(dragState.current.lastClamped);
        }
      },
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    }),
  );
  /* eslint-enable react-hooks/refs */

  const interactive = !disabled && Boolean(onChange);
  const seamWidth = Math.max(1, gap);
  const touchWidth = Math.max(seamWidth, TOUCH_SLOP_HALF * 2 + 1);
  const overlap = (touchWidth - seamWidth) / 2;

  return (
    <View
      testID="split-pane-divider"
      collapsable={false}
      {...(interactive ? responder.panHandlers : {})}
      style={[
        styles.touchRoot,
        {
          width: touchWidth,
          marginHorizontal: -overlap,
        },
      ]}
      accessible={interactive}
      accessibilityRole={interactive ? "adjustable" : undefined}
      accessibilityLabel={interactive ? label : undefined}
      accessibilityHint={interactive ? "左右拖动调整边栏宽度，双击中间把手恢复默认宽度" : undefined}
      accessibilityValue={
        interactive
          ? {
              min: Math.round(min),
              max: Math.round(max),
              now: Math.round(value),
            }
          : undefined
      }
      accessibilityActions={
        interactive
          ? [
              { name: "decrement", label: "收窄左侧边栏" },
              { name: "increment", label: "加宽左侧边栏" },
            ]
          : undefined
      }
      onAccessibilityAction={
        interactive
          ? ({ nativeEvent }) => {
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
            }
          : undefined
      }
    >
      <View
        pointerEvents="none"
        style={[
          styles.seamLine,
          {
            width: seamWidth,
            backgroundColor: dragging ? palette.text : palette.border,
          },
        ]}
      />
      {interactive && (
        <View
          pointerEvents="none"
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
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  touchRoot: {
    flexShrink: 0,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 50,
    elevation: 12,
    overflow: "visible",
  },
  seamLine: {
    position: "absolute",
    top: 0,
    bottom: 0,
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
