import { describe, expect, it } from "vitest";
import { normalizeConversationFontSize, scaleConversationTextStyle } from "../src/lib/conversation-font-size";

describe("conversation reading size", () => {
  it("migrates missing or corrupt preferences and bounds valid edits", () => {
    for (const value of [undefined, null, "20", NaN, Infinity, {}]) expect(normalizeConversationFontSize(value)).toBe(15);
    expect(normalizeConversationFontSize(1)).toBe(12);
    expect(normalizeConversationFontSize(100)).toBe(22);
    expect(normalizeConversationFontSize(17.6)).toBe(18);
  });

  it("scales text and leading together while preserving layout and nested inheritance", () => {
    const body = { fontSize: 15, lineHeight: 22, marginTop: 4 };
    expect(scaleConversationTextStyle(body, 1)).toBe(body);
    expect(scaleConversationTextStyle(body, 1.2)).toEqual({ fontSize: 18, lineHeight: 26.4, marginTop: 4 });
    expect(scaleConversationTextStyle({ fontSize: 12, lineHeight: 18 }, 1.5)).toEqual({ fontSize: 18, lineHeight: 27 });
    expect(scaleConversationTextStyle({ fontWeight: "700" } as { fontSize?: number; fontWeight: string }, 1.5)).toEqual({ fontWeight: "700" });
  });
});
