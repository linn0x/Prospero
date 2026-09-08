import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceQuickSwitcher } from "../src/components/DeviceQuickSwitcher";
import type { StoredHost } from "../src/lib/hosts";

type GestureCallbacks = {
  begin?: () => void;
  start?: () => void;
  update?: (event: { translationX: number; translationY: number }) => void;
  end?: (event: object, success?: boolean) => void;
  finalize?: (event: object, success: boolean) => void;
};
const harness = vi.hoisted(() => ({
  focus: null as (() => () => void) | null,
  effects: [] as (() => void | (() => void))[],
  appState: null as ((state: string) => void) | null,
  pans: [] as GestureCallbacks[], taps: [] as GestureCallbacks[],
  values: [] as { value: number; stopAnimation: ReturnType<typeof vi.fn>; setValue: (value: number) => void; interpolate: () => number }[],
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { harness.effects.push(effect); },
}));
vi.mock("expo-router", () => ({ useFocusEffect: (effect: () => () => void) => { harness.focus = effect; } }));
vi.mock("expo-haptics", () => ({
  selectionAsync: vi.fn().mockResolvedValue(undefined), impactAsync: vi.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const View = ({ children }: { children?: ReactNode }) => el("div", {}, children);
  return {
    View, Animated: { View, spring: () => ({ start: vi.fn() }) },
    Easing: {}, StyleSheet: { create: (styles: unknown) => styles },
    AccessibilityInfo: { isReduceMotionEnabled: () => Promise.resolve(false), addEventListener: () => ({ remove: vi.fn() }) },
    AppState: {
      currentState: "active",
      addEventListener: (_name: string, callback: (state: string) => void) => {
        harness.appState = callback;
        return { remove: vi.fn() };
      },
    },
    useAnimatedValue: (initial: number) => {
      const value = { value: initial, stopAnimation: vi.fn(),
        setValue: (next: number) => { value.value = next; }, interpolate: () => value.value };
      harness.values.push(value);
      return value;
    },
  };
});
vi.mock("react-native-gesture-handler", () => {
  function gesture(target: GestureCallbacks[]) {
    const callbacks: GestureCallbacks = {};
    target.push(callbacks);
    return {
      activateAfterLongPress() { return this; }, maxPointers() { return this; }, shouldCancelWhenOutside() { return this; },
      runOnJS() { return this; }, maxDuration() { return this; }, maxDistance() { return this; },
      onBegin(callback: GestureCallbacks["begin"]) { callbacks.begin = callback; return this; },
      onStart(callback: GestureCallbacks["start"]) { callbacks.start = callback; return this; },
      onUpdate(callback: GestureCallbacks["update"]) { callbacks.update = callback; return this; },
      onEnd(callback: GestureCallbacks["end"]) { callbacks.end = callback; return this; },
      onFinalize(callback: GestureCallbacks["finalize"]) { callbacks.finalize = callback; return this; },
    };
  }
  return {
    Gesture: { Pan: () => gesture(harness.pans), Tap: () => gesture(harness.taps), Exclusive: () => ({}) },
    GestureDetector: ({ children }: { children?: ReactNode }) => children,
  };
});
vi.mock("@/lib/device-quick-switcher", () => import("../src/lib/device-quick-switcher"));
vi.mock("@/lib/theme", () => ({ useMobileTheme: () => ({ palette: {} }) }));
vi.mock("@/lib/session-attention", () => ({
  completionBaselineHostKey: (hostId: string) => hostId,
  deviceAttentionMotion: () => null,
  useSessionAttention: (select: (state: object) => unknown) => select({
    completionReads: {}, completionBaselineHosts: {}, hydrated: true,
    hydrate: vi.fn().mockResolvedValue(undefined), baselineHostCompletions: vi.fn(),
  }),
}));

const hosts = ["mac", "pc"].map((id): StoredHost => ({
  id, name: id, addrs: [], port: 7423, token: "test", daemonPub: "test", pairedAt: 1, connectionMode: "direct",
}));
function fixture() {
  const props = { hosts, runtimes: {}, selectedHostId: "mac", hapticsEnabled: false,
    onOpenDeviceDetails: vi.fn(), onPreviewHost: vi.fn(), onCancelPreview: vi.fn(),
    onConfirmHost: vi.fn(), onQuickSwitchStateChange: vi.fn() };
  renderToStaticMarkup(createElement(DeviceQuickSwitcher, props));
  for (const effect of harness.effects) effect();
  return { props, pan: harness.pans[0]!, tap: harness.taps[0]!, blur: harness.focus!(), rail: harness.values[0]! };
}
function previewNext(pan: GestureCallbacks) {
  pan.begin!(); pan.start!(); pan.update!({ translationX: 35, translationY: 0 });
}
beforeEach(() => {
  harness.focus = null; harness.appState = null; harness.effects = [];
  harness.pans = []; harness.taps = []; harness.values = [];
});

describe("quick switch navigation and background interruption", () => {
  it("resets a partially scaled rail on blur and ignores the old gesture after refocus", () => {
    const { props, pan, blur, rail } = fixture();
    previewNext(pan);
    expect(props.onPreviewHost).toHaveBeenLastCalledWith("pc", 1);
    rail.value = 1.15;
    blur();
    expect(rail.value).toBe(1);
    expect(rail.stopAnimation).toHaveBeenCalled();
    expect(props.onQuickSwitchStateChange).toHaveBeenLastCalledWith(false, true);
    expect(props.onCancelPreview).toHaveBeenLastCalledWith(-1);
    harness.focus!();
    props.onPreviewHost.mockClear();
    pan.update!({ translationX: 35, translationY: 0 });
    pan.end!({}, true);
    expect(props.onPreviewHost).not.toHaveBeenCalled();
    expect(props.onConfirmHost).not.toHaveBeenCalled();
    previewNext(pan);
    pan.end!({}, true);
    expect(props.onConfirmHost).toHaveBeenCalledWith("pc");
  });

  it("cancels backgrounded input without waiting for native finalize and accepts a fresh touch", () => {
    const { props, pan, rail } = fixture();
    previewNext(pan);
    rail.value = 1.12;
    harness.appState!("background");
    expect(rail.value).toBe(1);
    expect(props.onQuickSwitchStateChange).toHaveBeenLastCalledWith(false, true);
    props.onPreviewHost.mockClear();
    pan.start!(); pan.update!({ translationX: 35, translationY: 0 });
    expect(props.onPreviewHost).not.toHaveBeenCalled();
    harness.appState!("active");
    pan.end!({}, true);
    pan.finalize!({}, false);
    expect(props.onConfirmHost).not.toHaveBeenCalled();
    previewNext(pan);
    expect(props.onPreviewHost).toHaveBeenCalledWith("pc", 1);
  });

  it("preserves a fresh short tap while rejecting one that started before leaving the screen", () => {
    const { props, tap, blur } = fixture();
    tap.begin!();
    blur();
    harness.focus!();
    tap.end!({}, true);
    expect(props.onOpenDeviceDetails).not.toHaveBeenCalled();
    tap.begin!(); tap.end!({}, true);
    expect(props.onOpenDeviceDetails).toHaveBeenCalledOnce();
  });
});
