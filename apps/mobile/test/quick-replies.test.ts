import { describe, expect, it } from "vitest";
import { DEFAULT_QUICK_REPLIES, normalizeQuickReplies, parseQuickReplyLines, quickReplyValidationError } from "../src/lib/quick-replies";

describe("custom quick replies", () => {
  it("keeps first occurrence order and accepts Android pasted CRLF text", () => {
    expect(parseQuickReplyLines("  检查日志\r\n\r\n继续\r\n检查日志\r\n")).toEqual(["检查日志", "继续"]);
  });
  it("migrates missing groups independently and preserves a user's empty list", () => {
    expect(normalizeQuickReplies(null)).toEqual(DEFAULT_QUICK_REPLIES);
    expect(normalizeQuickReplies({ busy: [] })).toEqual({ idle: DEFAULT_QUICK_REPLIES.idle, busy: [] });
    expect(normalizeQuickReplies({ idle: [null, 1, " ", "ok", "ok", "x".repeat(501)] }).idle).toEqual(["ok"]);
  });
  it("rejects oversized edits before saving instead of silently losing instructions", () => {
    expect(quickReplyValidationError([])).toBeNull();
    expect(quickReplyValidationError(["x".repeat(500)])).toBeNull();
    expect(quickReplyValidationError(["x".repeat(501)])).toContain("500");
    expect(quickReplyValidationError(Array.from({ length: 25 }, (_, i) => String(i)))).toContain("24");
  });
});
