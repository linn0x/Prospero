import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as RN from "react-native";
import { AccessibilityInfo, Animated, StyleSheet, View, useAnimatedValue } from "react-native";
import { Icon } from "./Icon";
import Svg, { Path } from "react-native-svg";

function animateNextLayout(): void {
  const layoutAnim = "LayoutAnimation" in RN ? RN.LayoutAnimation : undefined;
  if (typeof layoutAnim?.configureNext !== "function") return;
  layoutAnim.configureNext({
    duration: 210,
    create: {
      type: layoutAnim.Types.easeInEaseOut,
      property: layoutAnim.Properties.opacity,
    },
    update: {
      type: layoutAnim.Types.spring,
      springDamping: 0.86,
    },
    delete: {
      duration: 150,
      type: layoutAnim.Types.easeInEaseOut,
      property: layoutAnim.Properties.opacity,
    },
  });
}

/**
 * Native 120fps disclosure: chevron + opacity run on RenderThread/CoreAnimation
 * (`useNativeDriver: true`), while Fabric's native LayoutAnimation moves sibling rows
 * without JS-thread height thrashing or absolute double-layout passes.
 */
export function WorkspaceDisclosure({ expanded, header, children }: {
  expanded: boolean;
  header: (progress: Animated.Value) => ReactNode;
  children: ReactNode;
}) {
  const progress = useAnimatedValue(expanded ? 1 : 0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const prevExpanded = useRef(expanded);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduceMotion(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { active = false; subscription.remove(); };
  }, []);

  useLayoutEffect(() => {
    const toggled = prevExpanded.current !== expanded;
    prevExpanded.current = expanded;
    if (toggled && !reduceMotion) {
      animateNextLayout();
    }
    if (reduceMotion) {
      progress.setValue(expanded ? 1 : 0);
      return;
    }
    const animation = Animated.spring(progress, {
      toValue: expanded ? 1 : 0,
      damping: 26,
      stiffness: 340,
      mass: 0.75,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [expanded, progress, reduceMotion]);

  return <>
    {header(progress)}
    {expanded ? (
      <Animated.View
        testID="workspace-disclosure"
        style={[
          styles.clip,
          {
            opacity: progress,
            transform: [{
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [-6, 0],
              }),
            }],
          },
        ]}
      >
        {children}
      </Animated.View>
    ) : null}
  </>;
}

export function WorkspaceFolderIcon({ expanded, size, color }: {
  expanded: boolean; size: number; color: string;
}) {
  // Swap the geometry of one opaque path. No crossfade, font loading or animated
  // completion callback can briefly hide it or restore a stale folder state.
  return <View testID="workspace-folder" pointerEvents="none" accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path fill={color} d={expanded
        ? "M3 5h6l2 2h9v3H7L3 20V5Zm4.8 6H23l-4.2 9H3.8l4-9Z"
        : "M3 5h6l2 2h10v13H3V5Z"} />
    </Svg>
  </View>;
}

export function WorkspaceChevron({ progress, size, color }: { progress: Animated.Value; size: number; color: string }) {
  return <Animated.View style={{ transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] }) }] }}>
    <Icon name="chevron.right" size={size} color={color} />
  </Animated.View>;
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
});
