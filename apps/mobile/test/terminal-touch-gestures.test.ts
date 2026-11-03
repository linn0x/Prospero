import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface FakeTouch { identifier: number; clientX: number; clientY: number }
type Handler = (e: object) => void;

/** 只跑 term.html 里的捏合 + 单指滚动两段，触摸事件手工喂。 */
function gestures() {
  const html = readFileSync(join(import.meta.dirname, "../../daemon/term.html"), "utf8")
    .replaceAll("\r\n", "\n");
  const start = html.indexOf("  // 双指缩放进行中时");
  const end = html.indexOf("  (function tapToFocus", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);

  const handlers = new Map<string, Handler[]>();
  const el = {
    addEventListener: (type: string, fn: Handler) => {
      handlers.set(type, [...(handlers.get(type) ?? []), fn]);
    },
  };
  const term = {
    rows: 40,
    options: { fontSize: 12 },
    modes: { mouseTrackingMode: "none" },
    buffer: { active: { type: "normal" } },
    element: { querySelector: () => ({ getBoundingClientRect: () => ({ height: 800 }) }) },
    scrollLines: vi.fn(),
  };
  const post = vi.fn();
  let now = 0;
  const context = {
    document: { getElementById: () => el },
    term, post, doFit: vi.fn(),
    performance: { now: () => now },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    WheelEvent: class {},
  };
  runInNewContext(html.slice(start, end), context);

  let active: FakeTouch[] = [];
  const fire = (type: string, changed: FakeTouch[]) => {
    const event = { touches: active, changedTouches: changed, preventDefault: vi.fn() };
    for (const fn of handlers.get(type) ?? []) fn(event);
  };
  return {
    term, post,
    down(t: FakeTouch) { active = [...active, t]; now += 16; fire("touchstart", [t]); },
    move(t: FakeTouch) {
      active = active.map((a) => (a.identifier === t.identifier ? t : a));
      now += 16;
      fire("touchmove", [t]);
    },
    up(id: number) {
      const t = active.find((a) => a.identifier === id)!;
      active = active.filter((a) => a.identifier !== id);
      now += 200; // 停顿后抬手，不触发惯性
      fire("touchend", [t]);
    },
  };
}

describe("终端触摸手势", () => {
  it("拇指搭在屏幕上时，另一指上下滑是滚动而不是缩放", () => {
    const g = gestures();
    g.down({ identifier: 1, clientX: 20, clientY: 300 }); // 不动的拇指
    g.down({ identifier: 2, clientX: 400, clientY: 100 });
    for (let y = 120; y <= 400; y += 20) g.move({ identifier: 2, clientX: 400, clientY: y });
    g.up(2);
    expect(g.term.options.fontSize).toBe(12);
    expect(g.post).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "fontSize" }));
    // 手指下移 = 往回翻历史 = 负向行数
    const lines = g.term.scrollLines.mock.calls.reduce((sum, [n]) => sum + (n as number), 0);
    expect(lines).toBeLessThan(0);
  });

  it("两指同时张开才缩放，并且缩放时不滚动", () => {
    const g = gestures();
    g.down({ identifier: 1, clientX: 200, clientY: 300 });
    g.down({ identifier: 2, clientX: 300, clientY: 300 });
    for (let d = 10; d <= 100; d += 10) {
      g.move({ identifier: 1, clientX: 200 - d, clientY: 300 });
      g.move({ identifier: 2, clientX: 300 + d, clientY: 300 });
    }
    expect(g.term.options.fontSize).toBeGreaterThan(12);
    expect(g.post).toHaveBeenCalledWith(expect.objectContaining({ kind: "fontSize" }));
    expect(g.term.scrollLines).not.toHaveBeenCalled();
  });

  it("单指上下滑仍然滚动", () => {
    const g = gestures();
    g.down({ identifier: 1, clientX: 200, clientY: 500 });
    for (let y = 480; y >= 200; y -= 20) g.move({ identifier: 1, clientX: 200, clientY: y });
    g.up(1);
    const lines = g.term.scrollLines.mock.calls.reduce((sum, [n]) => sum + (n as number), 0);
    expect(lines).toBeGreaterThan(0);
  });
});
