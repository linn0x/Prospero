import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ platform: { OS: "ios" } }));
const store = vi.hoisted(() => ({
  setHomeSettings: vi.fn(),
  get hosts(): never { throw new Error("iOS must not subscribe to progress hosts"); },
  get runtimes(): never { throw new Error("iOS must not subscribe to progress runtimes"); },
}));

vi.mock("react-native", () => ({ Platform: native.platform }));
vi.mock("@/lib/store", () => ({ useApp: (select: (state: typeof store) => unknown) => select(store) }));
vi.mock("@/lib/home-preferences", () => ({
  DEFAULT_HOME_SETTINGS: { backgroundProgressEnabled: true, overlayProgressEnabled: false },
  getHomeSettings: vi.fn(),
}));
vi.mock("@/lib/connection", () => ({
  peekConnection: () => { throw new Error("iOS must not access progress connections"); },
}));
vi.mock("@/lib/running-session-progress", () => ({}));
vi.mock("@/lib/running-session-summary", () => ({}));
vi.mock("@/lib/pending-overlay-approvals", () => ({}));
vi.mock("@/lib/progress-approval-subscriptions", () => ({}));

import { RunningSessionProgressBridge } from "../src/components/RunningSessionProgressBridge";

describe("iOS progress bridge", () => {
  it("does not read hosts, runtime history, connections, or native progress APIs", () => {
    expect(renderToStaticMarkup(createElement(RunningSessionProgressBridge))).toBe("");
  });
});
