import { describe, expect, it } from "vitest";
import { preferLocalTerminalSelection } from "../src/renderer/src/terminal-mouse";
const mouse = (overrides: Partial<MouseEvent> = {}) => ({ button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, detail: 2, clientX: 12, clientY: 34, ...overrides }) as MouseEvent;
describe("local terminal selection", () => {
  it.each(["x10", "vt200", "drag", "any"])("uses Option for macOS mouse mode %s without changing click count or coordinates", mode => {
    const e = mouse(); preferLocalTerminalSelection(e, true, true, mode);
    expect(e).toMatchObject({ altKey: true, shiftKey: false, detail: 2, clientX: 12, clientY: 34 });
  });
  it("uses Shift on other platforms only when reporting is active", () => {
    const e = mouse(); preferLocalTerminalSelection(e, false, true, "any"); expect(e.shiftKey).toBe(true);
    const plain = mouse(); preferLocalTerminalSelection(plain, false, true, "none"); expect(plain.shiftKey).toBe(false);
  });
  it("preserves application mode, secondary clicks and link modifiers", () => {
    for (const [event, local] of [[mouse(), false], [mouse({button: 2}), true], [mouse({metaKey: true}), true], [mouse({ctrlKey: true}), true]] as const) {
      preferLocalTerminalSelection(event, true, local, "any"); expect(event.altKey).toBe(false);
    }
  });
  it("does not force selection while clicking an xterm link", () => {
    const event = {
      ...mouse(),
      composedPath: () => [{ classList: { contains: (value: string) => value === "xterm-cursor-pointer" } }],
    } as unknown as MouseEvent;
    preferLocalTerminalSelection(event, true, true, "any");
    expect(event.altKey).toBe(false);
  });
});
