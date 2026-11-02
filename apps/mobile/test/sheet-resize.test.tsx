import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { Sheet } from "../src/components/Sheet";

const native = vi.hoisted(() => ({ responder: null as null | {
  onPanResponderGrant(): void; onPanResponderMove(event: unknown, gesture: { dx: number }): void;
} }));
vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  return {
    View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView",
    Modal: ({ children }: { children: ReactNode }) => el("Modal", {}, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Platform: { OS: "android" }, useWindowDimensions: () => ({ width: 1000, height: 700 }),
    PanResponder: { create: (responder: typeof native.responder) => { native.responder = responder; return { panHandlers: {} }; } },
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock("@/components/Icon", () => ({ Icon: () => null }));
vi.mock("@/lib/theme", () => ({
  radius: { lg: 16, sm: 8 }, space: { lg: 16, sm: 8, md: 12 },
  useMobileTheme: () => ({ palette: { surface: "white", textFaint: "gray" } }),
  fontForPalette: () => ({ title: {}, sub: {}, body: {}, meta: {} }),
  createThemedStyles: (factory: (palette: object) => unknown) => () => factory({ surface: "white", textFaint: "gray" }),
}));

describe("side sheet resizing", () => {
  it("changes panel width during a drag and clamps both sides", async () => {
    let renderer!: ReactTestRenderer;
    await act(() => { renderer = create(createElement(Sheet, { visible: true, title: "模型", presentation: "side", onClose: () => {}, children: null })); });
    const handle = () => renderer.root.findByProps({ accessibilityLabel: "调整模型选择面板宽度" });
    expect(handle().props.accessibilityValue.now).toBe(480);
    await act(() => { native.responder!.onPanResponderGrant(); native.responder!.onPanResponderMove(null, { dx: 1000 }); });
    expect(handle().props.accessibilityValue.now).toBe(720);
    await act(() => { native.responder!.onPanResponderGrant(); native.responder!.onPanResponderMove(null, { dx: -1000 }); });
    expect(handle().props.accessibilityValue.now).toBe(280);
    await act(() => { handle().props.onAccessibilityAction({ nativeEvent: { actionName: "increment" } }); });
    expect(handle().props.accessibilityValue.now).toBe(312);
    await act(() => renderer.unmount());
  });
});
