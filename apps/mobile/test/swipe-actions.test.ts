import { describe, expect, it } from "vitest";
import { findAccessibilityAction, toAccessibilityActions } from "../src/lib/swipe-actions";

describe("swipe accessibility actions", () => {
  const actions = [
    { id: "rename", label: "重命名" },
    { id: "delete", label: "删除" },
  ] as const;

  it("keeps every named action available to assistive technology", () => {
    expect(toAccessibilityActions(actions)).toEqual([
      { name: "rename", label: "重命名" },
      { name: "delete", label: "删除" },
    ]);
  });

  it("maps an accessibility action name back to the original action", () => {
    expect(findAccessibilityAction(actions, "delete")).toBe(actions[1]);
    expect(findAccessibilityAction(actions, "missing")).toBeUndefined();
  });
});
