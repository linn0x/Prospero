import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReorderList } from "../src/components/ReorderList";

type Value = { value: number; native: boolean; setValue(n: number): void; stopAnimation(): void };
type Gesture = { y0: number; moveY: number };
type Responder = {
  onPanResponderGrant(event: unknown, gesture: Gesture): void;
  onPanResponderMove(event: unknown, gesture: Gesture): void;
  onPanResponderRelease(): void;
  onPanResponderTerminate(): void;
};
const ui = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[], layouts: [] as (() => void | (() => void))[],
  focus: null as (() => void) | null, background: null as ((state: string) => void) | null,
  responders: [] as Responder[], values: [] as Value[], views: new Map<string, Record<string, unknown>>(),
  frames: new Map<number, (time: number) => void>(), frameId: 0, scrollTo: vi.fn(), height: 220,
}));
vi.mock("react", async () => ({
  ...await vi.importActual<typeof import("react")>("react"),
  useEffect: (effect: () => void) => { ui.effects.push(effect); },
  useLayoutEffect: (effect: () => void) => { ui.layouts.push(effect); },
}));
vi.mock("expo-router", () => ({ useFocusEffect: (effect: () => () => void) => { ui.focus = effect(); } }));
vi.mock("@expo/vector-icons/FontAwesome6", () => ({ default: () => null }));
vi.mock("@/lib/device-order", () => import("../src/lib/device-order"));
vi.mock("@/lib/theme", () => ({ useMobileTheme: () => ({ palette: {} }), radius: { md: 12 } }));
vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const View = (props: Record<string, unknown> & { children?: ReactNode; testID?: string; ref?: { current: unknown } }) => {
    if (props.ref) props.ref.current = {
      measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 100, 390, ui.height),
      scrollTo: ui.scrollTo,
    };
    if (props.testID) ui.views.set(props.testID, props);
    return el("div", {}, props.children);
  };
  return {
    View, Text: View, ScrollView: View,
    StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ fontScale: 1 }),
    AppState: { currentState: "active", addEventListener: (_name: string, callback: (state: string) => void) => {
      ui.background = callback; return { remove: vi.fn() };
    } },
    PanResponder: { create: (responder: Responder) => { ui.responders.push(responder); return { panHandlers: {} }; } },
    useAnimatedValue: (initial: number) => {
      const value: Value = { value: initial, native: false,
        setValue(n) { this.value = n; }, stopAnimation: vi.fn() };
      ui.values.push(value);
      return value;
    },
    Animated: { View, timing: (value: Value, options: { toValue: number; useNativeDriver: boolean }) => ({
      start: () => { value.native = options.useNativeDriver; value.value = options.toValue; }, stop: vi.fn(),
    }) },
  };
});

beforeEach(() => {
  ui.effects = []; ui.layouts = []; ui.responders = []; ui.values = []; ui.views.clear(); ui.frames.clear();
  ui.scrollTo.mockClear(); ui.height = 220;
  vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => { const id = ++ui.frameId; ui.frames.set(id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => ui.frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());

const mount = (count = 3) => {
  const onReorder = vi.fn();
  renderToStaticMarkup(createElement(ReorderList, {
    items: Array.from({ length: count }, (_, index) => ({ id: String(index), title: `device ${index}`, icon: null })),
    onReorder,
  }));
  ui.layouts.forEach((effect) => effect());
  ui.effects.forEach((effect) => effect());
  return onReorder;
};
const drag = (from: number, to: number) => {
  // Deliberately wrong nativeEvent.pageY models a transformed Android event target.
  ui.responders[0]!.onPanResponderGrant({ nativeEvent: { pageY: -500 } }, { y0: from, moveY: from });
  ui.responders[0]!.onPanResponderMove({ nativeEvent: { pageY: -500 } }, { y0: from, moveY: to });
};

describe("native reorder gestures", () => {
  it("moves the permanently attached native animation value using window gesture coordinates", () => {
    const save = mount();
    const row = ui.views.get("reorder-row-0")!;
    const style = (row.style as { transform?: { translateY: Value }[] }[]).find((part) => part.transform)!;
    const position = style.transform![0]!.translateY;
    expect(position.native).toBe(true);
    drag(120, 230);
    expect(position.value).toBe(110);
    expect(ui.values).toHaveLength(3); // No shared drag node gets swapped onto a row.
    ui.responders[0]!.onPanResponderRelease();
    expect(save).toHaveBeenCalledExactlyOnceWith(["1", "2", "0"]);
    expect(ui.frames.size).toBe(0);
  });
  it.each(["terminate", "background", "blur"])("cancels without saving on %s", (reason) => {
    const save = mount();
    drag(120, 250);
    if (reason === "terminate") ui.responders[0]!.onPanResponderTerminate();
    else if (reason === "background") ui.background!("background");
    else ui.focus!();
    ui.responders[0]!.onPanResponderRelease();
    expect(save).not.toHaveBeenCalled();
    expect(ui.frames.size).toBe(0);
  });
  it("autoscrolls at the viewport edge while keeping the dragged row under the pointer", () => {
    ui.height = 100;
    mount(8);
    drag(120, 198);
    const tick = (time: number) => { const callbacks = [...ui.frames.values()]; ui.frames.clear(); callbacks.forEach((callback) => callback(time)); };
    tick(0); tick(32);
    expect(ui.scrollTo.mock.calls.at(-1)?.[0].y).toBeGreaterThan(0);
    expect(ui.values[0]!.value).toBeGreaterThan(78);
    ui.responders[0]!.onPanResponderTerminate();
  });
});
