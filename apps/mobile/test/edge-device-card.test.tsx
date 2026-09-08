import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredHost } from "../src/lib/hosts";
import { edgeDeviceColumns, toggleEdgeHost } from "../src/lib/edge-devices";

import { EdgeDeviceCard } from "../src/components/EdgeDeviceCard";

const controls = vi.hoisted(() => new Map<string, { onPress: () => void; onLongPress?: () => void; disabled?: boolean }>());
vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const View = ({ children }: { children?: ReactNode }) => el("div", {}, children);
  return {
    View, Text: View, Animated: { View },
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 390, fontScale: 1 }),
    useAnimatedValue: () => ({ interpolate: () => 0 }),
    Pressable: (props: { children?: ReactNode; accessibilityLabel: string; accessibilityRole?: string; accessibilityState?: { checked?: boolean }; onPress: () => void; disabled?: boolean }) => {
      controls.set(props.accessibilityLabel, props);
      return el("button", { role: props.accessibilityRole, "aria-checked": props.accessibilityState?.checked, disabled: props.disabled }, props.children);
    },
  };
});
vi.mock("@expo/vector-icons/FontAwesome6", () => ({ default: () => null }));
vi.mock("../src/components/Icon", () => ({ Icon: () => null }));
vi.mock("@/lib/edge-devices", () => import("../src/lib/edge-devices"));
vi.mock("@/lib/theme", () => ({
  useMobileTheme: () => ({ palette: {} }), radius: { sm: 8, md: 12 }, space: { sm: 8, lg: 16 },
}));

const hosts = ["mac", "pc", "linux"].map((id): StoredHost => ({ id, name: id, addrs: [], port: 7423, token: "test", daemonPub: "test", pairedAt: 1, connectionMode: "direct" }));
const props = () => ({ hosts, selectedHosts: hosts.slice(0, 2), runtimes: {}, choosingOrchestration: false,
  onSelectHosts: vi.fn(), onOpenHost: vi.fn(), onOpenOrchestration: vi.fn(), onCancelOrchestration: vi.fn() });
beforeEach(() => controls.clear());

describe("inline Edge device controls", () => {
  it("toggles selections in place and reserves long press for device details", () => {
    const callbacks = props();
    const html = renderToStaticMarkup(createElement(EdgeDeviceCard, callbacks));
    expect(html).toContain('role="checkbox" aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
    controls.get("mac，离线")!.onPress();
    expect(callbacks.onSelectHosts).toHaveBeenLastCalledWith(["pc"]);
    expect(callbacks.onOpenHost).not.toHaveBeenCalled();
    controls.get("mac，离线")!.onLongPress!();
    expect(callbacks.onOpenHost).toHaveBeenCalledWith("mac");
    controls.get("linux，未选择")!.onPress();
    expect(callbacks.onSelectHosts).toHaveBeenLastCalledWith(["mac", "pc", "linux"]);
  });

  it("opens orchestration only for included devices, without altering the saved selection", () => {
    const callbacks = { ...props(), choosingOrchestration: true };
    const html = renderToStaticMarkup(createElement(EdgeDeviceCard, callbacks));
    expect(html).toContain("点选设备，打开 Agent 编排");
    expect(controls.get("linux，未选择")!.disabled).toBe(true);
    controls.get("pc，离线")!.onPress();
    expect(callbacks.onOpenOrchestration).toHaveBeenCalledWith("pc");
    expect(callbacks.onSelectHosts).not.toHaveBeenCalled();
    controls.get("取消选择编排设备")!.onPress();
    expect(callbacks.onCancelOrchestration).toHaveBeenCalledOnce();
  });

  it("keeps all/none controls inline and allows clearing the last device", () => {
    const callbacks = props();
    renderToStaticMarkup(createElement(EdgeDeviceCard, callbacks));
    controls.get("选择全部 Edge 设备")!.onPress();
    expect(callbacks.onSelectHosts).toHaveBeenLastCalledWith(["mac", "pc", "linux"]);
    renderToStaticMarkup(createElement(EdgeDeviceCard, { ...callbacks, selectedHosts: hosts }));
    controls.get("取消选择全部 Edge 设备")!.onPress();
    expect(callbacks.onSelectHosts).toHaveBeenLastCalledWith([]);
    expect(toggleEdgeHost(hosts, new Set(["mac", "removed"]), "mac")).toEqual([]);
  });

  it("uses multiple columns on phones and reduces columns for narrow panes or larger text", () => {
    expect(edgeDeviceColumns(312)).toBe(2);
    expect(edgeDeviceColumns(272)).toBe(1);
    expect(edgeDeviceColumns(792)).toBe(4);
    expect(edgeDeviceColumns(342, 1.3)).toBe(1);
  });
});
