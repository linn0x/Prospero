import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeLocatorMotion } from "../src/lib/use-home-locator-motion";

const motion = vi.hoisted(() => ({
  angle: 0, starts: [] as number[], stop: vi.fn(), focus: null as (() => (() => void)) | null,
}));
vi.mock("expo-router", () => ({ useFocusEffect: (effect: () => (() => void)) => { motion.focus = effect; } }));
vi.mock("react-native", () => ({
  useAnimatedValue: () => ({
    stopAnimation: motion.stop,
    setValue: (value: number) => { motion.angle = value; },
    interpolate: () => "animated",
  }),
  Easing: { linear: () => {} },
  Animated: {
    timing: vi.fn(), sequence: vi.fn(), delay: vi.fn(),
    loop: () => ({
      start: () => { motion.starts.push(motion.angle); motion.angle = 0.75; },
      stop: vi.fn(), reset: vi.fn(),
    }),
  },
}));

function Fixture({ enabled }: { enabled: boolean }) {
  useHomeLocatorMotion("pc", enabled);
  return null;
}

beforeEach(() => { motion.angle = 0; motion.starts = []; motion.focus = null; motion.stop.mockClear(); });
describe("home locator animation navigation", () => {
  it("clears a partially completed native rotation on blur and restarts at zero on return", () => {
    renderToStaticMarkup(createElement(Fixture, { enabled: true }));
    const blur = motion.focus!();
    expect(motion.angle).toBe(0.75);
    blur();
    expect(motion.angle).toBe(0);
    const blurAgain = motion.focus!();
    expect(motion.starts).toEqual([0, 0]);
    blurAgain();
    expect(motion.angle).toBe(0);
  });

  it("stays neutral when opening a session marks its completion read before returning", () => {
    renderToStaticMarkup(createElement(Fixture, { enabled: true }));
    motion.focus!()();
    renderToStaticMarkup(createElement(Fixture, { enabled: false }));
    const blur = motion.focus!();
    expect(motion.angle).toBe(0);
    expect(motion.starts).toHaveLength(1);
    blur();
    expect(motion.angle).toBe(0);
  });
});
