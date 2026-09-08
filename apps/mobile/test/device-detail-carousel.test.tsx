import { createElement, type ReactNode, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredHost } from "../src/lib/hosts";
import { DeviceDetailCarousel } from "../src/components/DeviceDetailCarousel";

type ScrollEvent = { nativeEvent: { contentOffset: { x: number } } };
type ScrollCallback = (event: ScrollEvent) => void;
type ListControls = {
  onScroll: ScrollCallback;
  onScrollBeginDrag: () => void;
  onScrollEndDrag: ScrollCallback;
  onMomentumScrollEnd: ScrollCallback;
};
const ui = vi.hoisted(() => ({
  controls: new Map<string, { onPress: (event: { stopPropagation: () => void }) => void }>(),
  list: null as ListControls | null,
  scrollToOffset: vi.fn(),
  height: 844,
  views: [] as { testID: string; accessibilityElementsHidden?: boolean; pointerEvents?: string; style?: unknown[] }[],
  effects: [] as (() => (() => void) | undefined | void)[],
  layoutEffects: [] as (() => (() => void) | undefined | void)[],
  animationStarts: [] as number[],
  nativeProgress: 0,
  stopAnimation: vi.fn(),
  stopTiming: vi.fn(),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (effect: () => (() => void) | undefined | void) => { ui.effects.push(effect); },
    useLayoutEffect: (effect: () => (() => void) | undefined | void) => { ui.layoutEffects.push(effect); },
  };
});

vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const View = (props: {
    children?: ReactNode; testID?: string; accessibilityElementsHidden?: boolean; pointerEvents?: string;
  }) => {
    if (props.testID) ui.views.push({ ...props, testID: props.testID });
    return el("div", {
      "data-testid": props.testID, "aria-hidden": props.accessibilityElementsHidden,
    }, props.children);
  };
  return {
    View, Text: View, ScrollView: View,
    Animated: { View, timing: () => ({
      start: () => { ui.animationStarts.push(ui.nativeProgress); ui.nativeProgress = 0.42; },
      stop: ui.stopTiming,
    }) },
    Easing: { out: vi.fn(), in: vi.fn() },
    BackHandler: { addEventListener: () => ({ remove: vi.fn() }) },
    useAnimatedValue: () => ({
      interpolate: () => ui.nativeProgress,
      stopAnimation: ui.stopAnimation,
      setValue: (value: number) => { ui.nativeProgress = value; },
    }),
    useWindowDimensions: () => ({ width: 390, height: ui.height }),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: (props: {
      children?: ReactNode;
      accessibilityLabel: string;
      accessibilityState?: { selected?: boolean };
      onPress: () => void;
    }) => {
      ui.controls.set(props.accessibilityLabel, props);
      return el("button", { "aria-selected": props.accessibilityState?.selected }, props.children);
    },
    FlatList: (props: ListControls & {
      ref: RefObject<unknown>;
      data: unknown[];
      renderItem: (row: { item: unknown; index: number }) => ReactNode;
    }) => {
      ui.list = props;
      props.ref.current = { scrollToOffset: ui.scrollToOffset };
      return el("div", {}, props.data.map((item, index) => el(
        "div", { key: index }, props.renderItem({ item, index }),
      )));
    },
  };
});
vi.mock("@expo/vector-icons/FontAwesome6", () => ({ default: () => null }));
vi.mock("@/components/AgentIcon", () => ({ AgentIcon: () => null }));
vi.mock("@/components/Icon", () => ({ Icon: () => null }));
vi.mock("@/components/AddDeviceCard", () => import("../src/components/AddDeviceCard"));
vi.mock("@/lib/device-detail-pages", () => import("../src/lib/device-detail-pages"));
vi.mock("@/lib/device-quick-switcher", () => import("../src/lib/device-quick-switcher"));
vi.mock("@/lib/home-dashboard", () => ({
  homeHostStats: () => ({ activeAgentCount: 0, sessionCount: 0, runningCount: 0 }),
  homeHostOsLabel: () => "OS", homeRecentSessions: () => [], homeWorkspaceProjects: () => [],
}));
vi.mock("@/lib/session-attention", () => ({
  completionBaselineHostKey: (id: string) => id,
  unreadCompletedSessionCount: () => 0,
  useSessionAttention: (selector: (state: unknown) => unknown) => selector({
    completionReads: {}, completionBaselineHosts: {}, markHostCompletionsRead: vi.fn(),
  }),
}));
vi.mock("@/lib/theme", () => ({
  useMobileTheme: () => ({ palette: {} }),
  radius: { sm: 8, md: 12, lg: 18 }, space: { sm: 8, md: 12, lg: 16 },
}));

const hosts = ["mac", "pc"].map((id): StoredHost => ({
  id, name: id, addrs: [], port: 7423, token: "test", daemonPub: "test", pairedAt: 1,
  connectionMode: "direct",
}));
const props = () => ({
  visible: true, hosts, runtimes: {}, activeHostId: "mac", onClose: vi.fn(),
  onSelectHost: vi.fn(), onSelectAddDevice: vi.fn(), onPairDevice: vi.fn(),
  onSwipePosition: vi.fn(), onOpenHost: vi.fn(), onOpenSession: vi.fn(),
  onCreateSession: vi.fn(), onRefreshHost: vi.fn(),
});
const scroll = (x: number): ScrollEvent => ({ nativeEvent: { contentOffset: { x } } });
const press = (label: string) => ui.controls.get(label)!.onPress({ stopPropagation: vi.fn() });
const stride = 390 - 32 + 8;

beforeEach(() => {
  vi.useFakeTimers();
  ui.controls.clear();
  ui.list = null;
  ui.scrollToOffset.mockClear();
  ui.height = 844;
  ui.views = [];
  ui.effects = [];
  ui.layoutEffects = [];
  ui.animationStarts = [];
  ui.nativeProgress = 0;
  ui.stopAnimation.mockClear();
  ui.stopTiming.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("device detail add pages", () => {
  it("removes the entire overlay immediately even if native opacity remains halfway through entry", () => {
    const callbacks = props();
    const opened = renderToStaticMarkup(createElement(DeviceDetailCarousel, callbacks));
    expect(opened).toContain('data-testid="device-detail-carousel"');
    ui.effects[0]();
    expect(ui.nativeProgress).toBe(0.42);

    ui.effects = [];
    const closed = renderToStaticMarkup(createElement(DeviceDetailCarousel, { ...callbacks, visible: false }));
    expect(closed).toBe("");
    // The view is already gone before React runs passive effects or native animation callbacks.
    expect(ui.nativeProgress).toBe(0.42);
    ui.effects[0]();
    expect(ui.nativeProgress).toBe(0);
    expect(ui.stopAnimation).toHaveBeenCalled();
    expect(ui.animationStarts).toEqual([0]);
  });

  it("cancels interrupted entries and starts rapid reopening from zero without a retained backdrop", () => {
    const callbacks = props();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      ui.effects = [];
      renderToStaticMarkup(createElement(DeviceDetailCarousel, callbacks));
      const cleanup = ui.effects[0]();
      expect(ui.nativeProgress).toBe(0.42);
      if (typeof cleanup === "function") cleanup();
      expect(ui.nativeProgress).toBe(0);
      expect(renderToStaticMarkup(createElement(DeviceDetailCarousel, {
        ...callbacks, visible: false, addDeviceSide: "after",
      }))).toBe("");
    }
    expect(ui.animationStarts).toEqual([0, 0, 0]);
    expect(ui.stopTiming).toHaveBeenCalledTimes(3);
  });

  it("keeps the heading transparent beside the separate close button", () => {
    renderToStaticMarkup(createElement(DeviceDetailCarousel, props()));
    const headingStyle = ui.views.find((view) => view.testID === "device-detail-heading")!.style![0];
    expect(headingStyle).not.toHaveProperty("backgroundColor");
    expect(headingStyle).toMatchObject({ height: 44, flexDirection: "row" });
    expect(ui.controls.has("关闭设备详情")).toBe(true);
  });

  it("ignores queued swipe events and settling work after the overlay closes", () => {
    const callbacks = props();
    renderToStaticMarkup(createElement(DeviceDetailCarousel, callbacks));
    const cleanupVisibility = ui.layoutEffects[0]();
    ui.list!.onScrollBeginDrag();
    ui.list!.onScrollEndDrag(scroll(0));
    if (typeof cleanupVisibility === "function") cleanupVisibility();
    ui.list!.onScroll(scroll(stride * 3));
    vi.advanceTimersByTime(180);
    expect(callbacks.onSwipePosition).not.toHaveBeenCalled();
    expect(callbacks.onSelectAddDevice).not.toHaveBeenCalled();
    expect(callbacks.onSelectHost).not.toHaveBeenCalled();
  });

  it("supports one host and exposes both pairing methods without selecting a rail device", () => {
    const callbacks = { ...props(), hosts: hosts.slice(0, 1), addDeviceSide: "before" as const };
    const html = renderToStaticMarkup(createElement(DeviceDetailCarousel, callbacks));
    expect(html).toContain("新增设备");
    expect(html).toContain('aria-selected="false"');
    expect(html).not.toContain('aria-selected="true"');
    const addPages = ui.views.filter((view) => view.testID === "add-device-detail-card");
    expect(addPages.map((view) => view.accessibilityElementsHidden)).toEqual([false, true]);
    expect(addPages.map((view) => view.pointerEvents)).toEqual(["auto", "none"]);
    press("扫码配对新设备");
    press("使用 IP 和配对码添加新设备");
    expect(callbacks.onPairDevice.mock.calls).toEqual([["scan"], ["manual"]]);
    expect(callbacks.onSelectHost).not.toHaveBeenCalled();
    press("切换到 mac，离线");
    expect(callbacks.onSelectHost).toHaveBeenCalledWith("mac");
    expect(ui.scrollToOffset).toHaveBeenLastCalledWith({ offset: stride, animated: true });
  });

  it("makes the whole device card and both pairing methods scrollable in a short window", () => {
    ui.height = 400;
    renderToStaticMarkup(createElement(DeviceDetailCarousel, {
      ...props(), addDeviceSide: "after",
    }));
    expect(ui.views.filter((view) => view.testID === "compact-device-detail-scroll")).toHaveLength(2);
    expect(ui.views.filter((view) => view.testID === "add-device-detail-scroll")).toHaveLength(2);
    expect(ui.controls.has("关闭设备详情")).toBe(true);
    expect(ui.controls.has("扫码配对新设备")).toBe(true);
    expect(ui.controls.has("使用 IP 和配对码添加新设备")).toBe(true);
  });

  it("settles a slow drag onto the left add page without a momentum callback", () => {
    const callbacks = props();
    renderToStaticMarkup(createElement(DeviceDetailCarousel, callbacks));
    ui.list!.onScrollBeginDrag();
    ui.list!.onScroll(scroll(0));
    ui.list!.onScrollEndDrag(scroll(0));
    expect(callbacks.onSelectAddDevice).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    expect(callbacks.onSelectAddDevice).toHaveBeenCalledWith("before");
    expect(callbacks.onSelectHost).not.toHaveBeenCalled();
    expect(callbacks.onSwipePosition).toHaveBeenLastCalledWith(-1);
  });

  it("keeps the home preview continuous and selects the right add page at the last boundary", () => {
    const callbacks = props();
    renderToStaticMarkup(createElement(DeviceDetailCarousel, callbacks));
    ui.list!.onScrollBeginDrag();
    ui.list!.onScroll(scroll(stride * 2.4));
    expect(callbacks.onSwipePosition).toHaveBeenLastCalledWith(1.4);
    ui.list!.onScrollEndDrag(scroll(stride * 3));
    ui.list!.onMomentumScrollEnd(scroll(stride * 3));
    expect(callbacks.onSelectAddDevice).toHaveBeenCalledWith("after");
    expect(callbacks.onSelectHost).not.toHaveBeenCalled();
    expect(callbacks.onSwipePosition).toHaveBeenLastCalledWith(hosts.length);
  });

  it("does not select an intermediate device while a rail tap animates to a later device", () => {
    const callbacks = props();
    renderToStaticMarkup(createElement(DeviceDetailCarousel, callbacks));
    press("切换到 pc，离线");
    expect(callbacks.onSelectHost.mock.calls).toEqual([["pc"]]);
    ui.list!.onMomentumScrollEnd(scroll(stride));
    expect(callbacks.onSelectHost.mock.calls).toEqual([["pc"]]);
    ui.list!.onScrollBeginDrag();
    ui.list!.onScrollEndDrag(scroll(0));
    vi.advanceTimersByTime(180);
    expect(callbacks.onSelectAddDevice).toHaveBeenCalledWith("before");
  });

  it("makes both edge hints actionable", () => {
    const callbacks = props();
    renderToStaticMarkup(createElement(DeviceDetailCarousel, callbacks));
    press("左侧新增设备");
    expect(callbacks.onSelectAddDevice).toHaveBeenLastCalledWith("before");
    expect(ui.scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: true });
    press("右侧新增设备");
    expect(callbacks.onSelectAddDevice).toHaveBeenLastCalledWith("after");
    expect(ui.scrollToOffset).toHaveBeenLastCalledWith({ offset: stride * 3, animated: true });
    expect(callbacks.onSelectHost).not.toHaveBeenCalled();
  });
});
