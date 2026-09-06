import { useEffect, useMemo, useState } from "react";
import * as Haptics from "expo-haptics";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  useAnimatedValue,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import {
  DEVICE_QUICK_SWITCH_CANCEL_Y,
  deviceIndexForTranslation,
  deviceRailWindow,
  quickSwitchShouldCancel,
} from "@/lib/device-quick-switcher";
import type { StoredHost } from "@/lib/hosts";
import {
  completionBaselineHostKey,
  deviceAttentionMotion,
  type DeviceAttentionMotion,
  useSessionAttention,
} from "@/lib/session-attention";
import type { HostRuntime } from "@/lib/store";
import { useMobileTheme, type ThemePalette } from "@/lib/theme";

export type DeviceSwitchDirection = -1 | 0 | 1;

const DEVICE_CARD_HEIGHT = 64;
const DEVICE_QUICK_SWITCH_LONG_PRESS_MS = 450;

function switchDirection(fromIndex: number, toIndex: number): DeviceSwitchDirection {
  return toIndex === fromIndex ? 0 : toIndex > fromIndex ? 1 : -1;
}

class QuickSwitchGestureSession {
  private active = false;
  private cancelled = false;
  private initialIndex: number;
  private previewIndex: number;

  constructor(selectedIndex: number) {
    this.initialIndex = selectedIndex;
    this.previewIndex = selectedIndex;
  }

  begin(selectedIndex: number): void {
    this.active = true;
    this.cancelled = false;
    this.initialIndex = selectedIndex;
    this.previewIndex = selectedIndex;
  }

  canUpdate(): boolean {
    return this.active && !this.cancelled;
  }

  startIndex(): number {
    return this.initialIndex;
  }

  currentIndex(): number {
    return this.previewIndex;
  }

  move(nextIndex: number): DeviceSwitchDirection {
    const direction = switchDirection(this.previewIndex, nextIndex);
    this.previewIndex = nextIndex;
    return direction;
  }

  cancel(): DeviceSwitchDirection {
    this.cancelled = true;
    const direction = switchDirection(this.previewIndex, this.initialIndex);
    this.previewIndex = this.initialIndex;
    return direction;
  }

  finish(forceCancel: boolean): {
    cancelled: boolean;
    finalIndex: number;
    initialIndex: number;
  } | null {
    if (!this.active) return null;
    this.active = false;
    return {
      cancelled: forceCancel || this.cancelled,
      finalIndex: this.previewIndex,
      initialIndex: this.initialIndex,
    };
  }
}

function connectionTone(runtime: HostRuntime | undefined, palette: ThemePalette): string {
  const status = runtime?.status ?? "idle";
  if (status === "connected") {
    return runtime?.rttMs !== null && runtime?.rttMs !== undefined && runtime.rttMs >= 300
      ? palette.warn
      : palette.success;
  }
  if (status === "connecting" || status === "reconnecting") return palette.warn;
  return palette.danger;
}

function selectionHaptic(enabled: boolean): void {
  if (!enabled) return;
  void Haptics.selectionAsync().catch(() => undefined);
}

function doubleFlash(value: Animated.Value): Animated.CompositeAnimation {
  return Animated.sequence([
    Animated.timing(value, { toValue: 0.18, duration: 65, useNativeDriver: true }),
    Animated.timing(value, { toValue: 1, duration: 65, useNativeDriver: true }),
    Animated.timing(value, { toValue: 0.18, duration: 65, useNativeDriver: true }),
    Animated.timing(value, { toValue: 1, duration: 65, useNativeDriver: true }),
  ]);
}

function DeviceStatusDot({
  color,
  current,
  motion,
  reduceMotion,
  styles,
}: {
  color: string;
  current: boolean;
  motion: DeviceAttentionMotion;
  reduceMotion: boolean;
  styles: ReturnType<typeof createStyles>;
}) {
  const opacity = useAnimatedValue(1);
  const scale = useAnimatedValue(1);
  const translateY = useAnimatedValue(0);

  useEffect(() => {
    const reset = (): void => {
      opacity.stopAnimation();
      scale.stopAnimation();
      translateY.stopAnimation();
      opacity.setValue(1);
      scale.setValue(1);
      translateY.setValue(0);
    };
    reset();
    if (!motion || reduceMotion) return;

    let animation: Animated.CompositeAnimation;
    if (motion === "approval") {
      animation = Animated.loop(Animated.sequence([
        doubleFlash(opacity),
        Animated.delay(140),
        doubleFlash(opacity),
        Animated.delay(140),
        doubleFlash(opacity),
        Animated.delay(720),
      ]));
    } else if (motion === "working") {
      animation = Animated.loop(Animated.sequence([
        Animated.timing(scale, {
          toValue: 1.5,
          duration: 820,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: 820,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]));
    } else {
      animation = Animated.loop(Animated.sequence([
        Animated.timing(translateY, {
          toValue: -3.5,
          duration: 170,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 210,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: -1.8,
          duration: 120,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: 0,
          duration: 150,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.delay(850),
      ]));
    }
    animation.start();
    return () => {
      animation.stop();
      animation.reset();
      reset();
    };
  }, [motion, opacity, reduceMotion, scale, translateY]);

  return (
    <Animated.View
      style={[
        styles.railDot,
        current && styles.railDotCurrent,
        {
          backgroundColor: color,
          opacity,
          transform: [{ translateY }, { scale }],
        },
      ]}
    />
  );
}

export function DeviceQuickSwitcher({
  hosts,
  runtimes,
  selectedHostId,
  hapticsEnabled,
  onOpenDeviceDetails,
  onPreviewHost,
  onCancelPreview,
  onConfirmHost,
  onQuickSwitchStateChange,
}: {
  hosts: StoredHost[];
  runtimes: Record<string, HostRuntime>;
  selectedHostId: string;
  hapticsEnabled: boolean;
  onOpenDeviceDetails: () => void;
  onPreviewHost: (hostId: string, direction: DeviceSwitchDirection) => void;
  onCancelPreview: (direction: DeviceSwitchDirection) => void;
  onConfirmHost: (hostId: string) => void;
  onQuickSwitchStateChange: (active: boolean, cancelled: boolean) => void;
}) {
  const { palette } = useMobileTheme();
  const styles = useMemo(() => createStyles(palette), [palette]);
  const selectedIndex = Math.max(0, hosts.findIndex((host) => host.id === selectedHostId));
  const [quickSwitchActive, setQuickSwitchActive] = useState(false);
  const [candidateIndex, setCandidateIndex] = useState(selectedIndex);
  const [reduceMotion, setReduceMotion] = useState(false);
  const railScale = useAnimatedValue(1);
  const completionReads = useSessionAttention((state) => state.completionReads);
  const completionBaselineHosts = useSessionAttention(
    (state) => state.completionBaselineHosts,
  );
  const completionReadsHydrated = useSessionAttention((state) => state.hydrated);
  const hydrateSessionAttention = useSessionAttention((state) => state.hydrate);
  const baselineHostCompletions = useSessionAttention(
    (state) => state.baselineHostCompletions,
  );

  const activeIndex = quickSwitchActive ? candidateIndex : selectedIndex;
  const railIndices = useMemo(
    () => deviceRailWindow(hosts.length, activeIndex),
    [activeIndex, hosts.length],
  );
  const railWidth = Math.min(144, Math.max(64, railIndices.length * 18 + 16));

  useEffect(() => {
    void hydrateSessionAttention();
  }, [hydrateSessionAttention]);

  useEffect(() => {
    if (!completionReadsHydrated) return;
    for (const host of hosts) {
      const runtime = runtimes[host.id];
      if (runtime?.sessionsLoaded) baselineHostCompletions(host.id, runtime.sessions);
    }
  }, [baselineHostCompletions, completionReadsHydrated, hosts, runtimes]);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    railScale.stopAnimation();
    Animated.spring(railScale, {
      toValue: quickSwitchActive ? 1.2 : 1,
      speed: 28,
      bounciness: 5,
      useNativeDriver: true,
    }).start();
  }, [quickSwitchActive, railScale]);

  useEffect(() => () => railScale.stopAnimation(), [railScale]);

  const panGesture = useMemo(
    () => {
      const session = new QuickSwitchGestureSession(selectedIndex);

      const finish = (forceCancel = false): void => {
        const result = session.finish(forceCancel);
        if (!result) return;
        setQuickSwitchActive(false);
        onQuickSwitchStateChange(false, false);
        if (result.cancelled || result.finalIndex === result.initialIndex) {
          onCancelPreview(switchDirection(result.finalIndex, result.initialIndex));
          return;
        }
        const nextHost = hosts[result.finalIndex];
        if (!nextHost) {
          onCancelPreview(switchDirection(result.finalIndex, result.initialIndex));
          return;
        }
        onConfirmHost(nextHost.id);
      };

      return Gesture.Pan()
        .activateAfterLongPress(DEVICE_QUICK_SWITCH_LONG_PRESS_MS)
        .maxPointers(1)
        .shouldCancelWhenOutside(false)
        .runOnJS(true)
        .onStart(() => {
          session.begin(selectedIndex);
          setCandidateIndex(selectedIndex);
          setQuickSwitchActive(true);
          onQuickSwitchStateChange(true, false);
          if (hapticsEnabled) {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
          }
        })
        .onUpdate((event) => {
          if (!session.canUpdate()) return;
          if (quickSwitchShouldCancel(event.translationY, DEVICE_QUICK_SWITCH_CANCEL_Y)) {
            const returnDirection = session.cancel();
            setCandidateIndex(session.currentIndex());
            onQuickSwitchStateChange(true, true);
            onCancelPreview(returnDirection);
            selectionHaptic(hapticsEnabled);
            return;
          }
          const nextIndex = deviceIndexForTranslation(
            session.startIndex(),
            event.translationX,
            hosts.length,
          );
          if (nextIndex < 0 || nextIndex === session.currentIndex()) return;
          const direction = session.move(nextIndex);
          setCandidateIndex(nextIndex);
          const nextHost = hosts[nextIndex];
          if (nextHost) onPreviewHost(nextHost.id, direction);
          selectionHaptic(hapticsEnabled);
        })
        .onEnd(() => finish())
        .onFinalize((_event, success) => {
          if (!success) finish(true);
        });
    }, [
      hapticsEnabled,
      hosts,
      onCancelPreview,
      onConfirmHost,
      onPreviewHost,
      onQuickSwitchStateChange,
      selectedIndex,
    ],
  );
  const tapGesture = useMemo(
    () => Gesture.Tap()
      .maxDuration(DEVICE_QUICK_SWITCH_LONG_PRESS_MS - 10)
      .maxDistance(10)
      .runOnJS(true)
      .onEnd((_event, success) => {
        if (success) onOpenDeviceDetails();
      }),
    [onOpenDeviceDetails],
  );
  const composedGesture = useMemo(
    () => Gesture.Exclusive(panGesture, tapGesture),
    [panGesture, tapGesture],
  );

  if (hosts.length <= 1) return null;

  return (
    <GestureDetector gesture={composedGesture}>
      <View
        collapsable={false}
        testID="device-quick-switcher"
        accessible
        accessibilityRole="button"
        accessibilityLabel={`快速切换设备，当前为 ${hosts[selectedIndex]?.name ?? "未知设备"}`}
        accessibilityHint="单击打开设备详情，长按后左右滑动快速切换，上下滑动取消"
        style={styles.touchTarget}
      >
        <Animated.View
          style={[
            styles.railCapsule,
            quickSwitchActive && styles.railCapsuleActive,
            { width: railWidth, transform: [{ scale: railScale }] },
          ]}
        >
          <View style={styles.railDots}>
            {railIndices.map((index) => {
              const host = hosts[index];
              if (!host) return null;
              const current = index === activeIndex;
              const runtime = runtimes[host.id];
              return (
                <DeviceStatusDot
                  key={host.id}
                  color={connectionTone(runtime, palette)}
                  current={current}
                  motion={deviceAttentionMotion(
                    host.id,
                    runtime?.sessions,
                    completionReadsHydrated ? completionReads : null,
                    Boolean(completionBaselineHosts[completionBaselineHostKey(host.id)]),
                  )}
                  reduceMotion={reduceMotion}
                  styles={styles}
                />
              );
            })}
          </View>
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

function createStyles(palette: ThemePalette) {
  return StyleSheet.create({
    touchTarget: {
      position: "absolute",
      top: DEVICE_CARD_HEIGHT - 4,
      left: 0,
      right: 0,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      zIndex: 30,
      elevation: 12,
    },
    railCapsule: {
      height: 14,
      paddingHorizontal: 5,
      borderRadius: 999,
      backgroundColor: palette.surfaceRaised,
    },
    railCapsuleActive: {
      backgroundColor: palette.accentBg,
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.18,
      shadowRadius: 8,
      elevation: 18,
    },
    railDots: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-evenly",
    },
    railDot: { width: 5, height: 5, borderRadius: 3 },
    railDotCurrent: {
      width: 7,
      height: 7,
      borderRadius: 3.5,
    },
  });
}
