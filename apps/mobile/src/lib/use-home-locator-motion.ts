import { useCallback, useMemo } from "react";
import { Animated, Easing, useAnimatedValue } from "react-native";
import { useFocusEffect } from "expo-router";

function iconDoubleWiggle(value: Animated.Value): Animated.CompositeAnimation {
  const wiggle = () => Animated.sequence([
    Animated.timing(value, { toValue: -1, duration: 70, easing: Easing.linear, useNativeDriver: true, isInteraction: false }),
    Animated.timing(value, { toValue: 1, duration: 110, easing: Easing.linear, useNativeDriver: true, isInteraction: false }),
    Animated.timing(value, { toValue: 0, duration: 70, easing: Easing.linear, useNativeDriver: true, isInteraction: false }),
  ]);
  return Animated.sequence([wiggle(), Animated.delay(90), wiggle()]);
}

/** A retained navigation screen must reset on blur and resume from zero on focus. */
export function useHomeLocatorMotion(hostId: string | undefined, enabled: boolean) {
  const value = useAnimatedValue(0);
  useFocusEffect(useCallback(() => {
    const reset = (): void => { value.stopAnimation(); value.setValue(0); };
    reset();
    if (!hostId || !enabled) return reset;
    const animation = Animated.loop(Animated.sequence([iconDoubleWiggle(value), Animated.delay(1_000)]));
    animation.start();
    return () => {
      animation.stop();
      animation.reset();
      reset();
    };
  }, [enabled, hostId, value]));

  return useMemo(() => ({ transform: [{ rotate: value.interpolate({
    inputRange: [-1, 0, 1], outputRange: ["-6deg", "0deg", "6deg"],
  }) }] }), [value]);
}
