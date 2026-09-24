import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingQR, generateKeyPairB64, PAIRING_FORMAT_VERSION, type PairingPayload } from "@prospero/protocol";
import PairScreen from "../src/app/pair";

const state = vi.hoisted(() => ({
  params: {} as { mode?: string; d?: string },
  effects: [] as (() => unknown)[],
  requestPermission: vi.fn(async () => undefined),
  setHosts: vi.fn(),
  upsertHostFromPairing: vi.fn(),
  getHosts: vi.fn(),
  granted: false,
  discover: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => unknown) => { state.effects.push(effect); },
}));
vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const View = ({ children }: { children?: ReactNode }) => el("div", {}, children);
  return {
    View, Text: View, KeyboardAvoidingView: View, ScrollView: View,
    Pressable: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) => el("button", { "aria-label": accessibilityLabel }, children),
    TextInput: ({ accessibilityLabel, placeholder }: { accessibilityLabel?: string; placeholder?: string }) => el("input", { "aria-label": accessibilityLabel, placeholder }),
    ActivityIndicator: () => null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Platform: { OS: "android" }, AccessibilityInfo: {}, Alert: { alert: vi.fn() },
  };
});
vi.mock("expo-clipboard", () => ({ getStringAsync: vi.fn() }));
vi.mock("expo-glass-effect", () => ({ GlassView: () => null, isGlassEffectAPIAvailable: () => false, isLiquidGlassAvailable: () => false }));
vi.mock("expo-linking", () => ({ openSettings: vi.fn() }));
vi.mock("expo-router", () => ({ Stack: { Screen: () => null }, router: { canDismiss: () => false, dismissAll: vi.fn(), replace: vi.fn() }, useLocalSearchParams: () => state.params }));
vi.mock("expo-camera", () => ({ CameraView: () => createElement("div", { "data-camera": true }), useCameraPermissions: () => [{ granted: state.granted, canAskAgain: true }, state.requestPermission] }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@/lib/discovery", () => ({ useDiscovery: (enabled: boolean) => { state.discover(enabled); return { hosts: [], scanning: false, unavailable: false, timedOut: false }; } }));
vi.mock("@/lib/hosts", () => ({ upsertHostFromPairing: state.upsertHostFromPairing, getHosts: state.getHosts }));
vi.mock("@/lib/pairing-error-notice", () => ({ pairingErrorNotice: vi.fn() }));
vi.mock("@/lib/manual-pairing", () => import("../src/lib/manual-pairing"));
vi.mock("@/lib/store", () => ({ useApp: (selector: (state: { setHosts: (hosts: unknown[]) => void }) => unknown) => selector({ setHosts: state.setHosts }) }));
vi.mock("@/lib/theme", () => ({ color: {}, radius: {}, space: {} }));

beforeEach(() => {
  state.params = {};
  state.effects = [];
  state.granted = false;
  state.requestPermission.mockClear();
  state.discover.mockClear();
  state.setHosts.mockClear();
  state.upsertHostFromPairing.mockReset();
  state.getHosts.mockReset();
});

describe("pairing entry modes", () => {
  it("opens the manual form without requesting camera permission or local discovery", () => {
    state.params = { mode: "manual" };
    const html = renderToStaticMarkup(createElement(PairScreen));
    for (const effect of state.effects) effect();
    expect(html).toContain("电脑 IP 地址，可包含端口");
    expect(html).toContain("电脑生成的完整配对码");
    expect(html).not.toContain("data-camera");
    expect(state.requestPermission).not.toHaveBeenCalled();
    expect(state.discover).toHaveBeenCalledWith(false);
  });

  it("requests camera permission when the scan entry is chosen", () => {
    state.params = { mode: "scan" };
    renderToStaticMarkup(createElement(PairScreen));
    for (const effect of state.effects) effect();
    expect(state.requestPermission).toHaveBeenCalledOnce();
    expect(state.discover).toHaveBeenCalledWith(true);
  });

  it("keeps an already permitted camera unmounted in manual mode", () => {
    state.params = { mode: "manual" };
    state.granted = true;
    expect(renderToStaticMarkup(createElement(PairScreen))).not.toContain("data-camera");
    state.params = { mode: "scan" };
    expect(renderToStaticMarkup(createElement(PairScreen))).toContain("data-camera");
  });

  it("does not request camera access over a deep-link pairing payload", () => {
    state.params = { d: "fixture" };
    renderToStaticMarkup(createElement(PairScreen));
    const cleanups = state.effects.map((effect) => effect());
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    expect(state.requestPermission).not.toHaveBeenCalled();
  });

  it("refreshes in-memory devices after a deep-link pairing succeeds", async () => {
    const payload: PairingPayload = {
      v: PAIRING_FORMAT_VERSION,
      name: "Mac",
      addrs: ["192.168.1.8"],
      port: 7423,
      token: "0123456789abcdef",
      pubKey: generateKeyPairB64().publicKey,
    };
    state.params = { d: encodePairingQR(payload).slice("prospero://pair?d=".length) };
    const host = { id: "mac" };
    const hosts = [host];
    state.upsertHostFromPairing.mockResolvedValue(host);
    state.getHosts.mockResolvedValue(hosts);
    renderToStaticMarkup(createElement(PairScreen));
    for (const effect of state.effects) effect();
    await vi.waitFor(() => expect(state.setHosts).toHaveBeenCalledWith(hosts));
  });
});
