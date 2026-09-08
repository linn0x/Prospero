import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View, useAnimatedValue } from "react-native";
import { Icon } from "./Icon";

/** Measure intrinsic content while animating its clip height, so following rows move with it. */
export function WorkspaceDisclosure({ expanded, header, children }: {
  expanded: boolean;
  header: (progress: Animated.Value) => ReactNode;
  children: ReactNode;
}) {
  const progress = useAnimatedValue(expanded ? 1 : 0);
  const height = useAnimatedValue(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [retained, setRetained] = useState(expanded);
  const [reduceMotion, setReduceMotion] = useState(false);
  const expandedRef = useRef(expanded);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduceMotion(value); });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => { active = false; subscription.remove(); };
  }, []);

  useLayoutEffect(() => {
    expandedRef.current = expanded;
    let active = true;
    const options = { duration: reduceMotion ? 0 : 240, easing: Easing.inOut(Easing.cubic), useNativeDriver: false };
    const animation = Animated.parallel([
      Animated.timing(progress, { ...options, toValue: expanded ? 1 : 0 }),
      Animated.timing(height, { ...options, toValue: expanded ? contentHeight : 0 }),
    ]);
    animation.start(({ finished }) => {
      if (active && finished && !expandedRef.current) setRetained(false);
    });
    return () => { active = false; animation.stop(); };
  }, [contentHeight, expanded, height, progress, reduceMotion]);

  return <>
    {header(progress)}
    <Animated.View testID="workspace-disclosure" style={[styles.clip, { height, opacity: progress }]}
      pointerEvents={expanded ? "auto" : "none"} accessibilityElementsHidden={!expanded}
      importantForAccessibility={expanded ? "auto" : "no-hide-descendants"}>
      {(expanded || retained) && <View style={styles.content}
        onLayout={({ nativeEvent }) => {
          setContentHeight(nativeEvent.layout.height);
          if (expandedRef.current) setRetained(true);
        }}>{children}</View>}
    </Animated.View>
  </>;
}

export function WorkspaceFolderIcon({ progress, expanded = false, size, color }: {
  progress?: Animated.Value; expanded?: boolean; size: number; color: string;
}) {
  return <View style={{ width: size, height: size }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Animated.View testID="workspace-folder-closed" style={[styles.iconLayer, { opacity: progress ? progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) : expanded ? 0 : 1 }]}>
      <Icon name="folder.fill" size={size} color={color} />
    </Animated.View>
    <Animated.View testID="workspace-folder-open" style={[styles.iconLayer, { opacity: progress ?? (expanded ? 1 : 0) }]}>
      <MaterialIcons name="folder-open" size={size} color={color} allowFontScaling={false} />
    </Animated.View>
  </View>;
}

export function WorkspaceChevron({ progress, size, color }: { progress: Animated.Value; size: number; color: string }) {
  return <Animated.View style={{ transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "90deg"] }) }] }}>
    <Icon name="chevron.right" size={size} color={color} />
  </Animated.View>;
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
  content: { position: "absolute", top: 0, left: 0, right: 0 },
  iconLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
});
