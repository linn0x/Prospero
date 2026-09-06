import { describe, expect, it } from "vitest";
import { ChatScrollFollow, isAtLatestChatOffset, newestChatItemsFirst } from "../src/lib/chat-scroll-follow";

describe("inverted chat display", () => {
  it("starts a long variable-height history with its newest messages without altering model order", () => {
    const history = Array.from({ length: 10_000 }, (_, seq) => ({ key: `message-${seq}`, text: `reply ${seq}` }));
    const display = newestChatItemsFirst(history);
    expect(display[0]).toBe(history[9999]);
    expect(display.slice(0, 12).map((item) => item.key)).toEqual(
      Array.from({ length: 12 }, (_, index) => `message-${9999 - index}`),
    );
    expect(history[0]?.key).toBe("message-0");
    expect(history[9999]?.key).toBe("message-9999");
  });

  it("places streamed additions at the zero edge while preserving existing keyed rows", () => {
    const older = { key: "user", text: "request" };
    const newest = { key: "assistant", text: "reply" };
    const added = { key: "next", text: "next reply" };
    const history = [older, newest];
    const before = newestChatItemsFirst(history);
    const after = newestChatItemsFirst([...history, added]);
    expect(after[0]).toBe(added);
    expect(after[1]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
    expect(history).toEqual([older, newest]);
  });

  it("uses distance from zero rather than the total estimated history height", () => {
    expect(isAtLatestChatOffset(0)).toBe(true);
    expect(isAtLatestChatOffset(-15)).toBe(true); // iOS overscroll at the latest edge.
    expect(isAtLatestChatOffset(60)).toBe(true);
    expect(isAtLatestChatOffset(61)).toBe(false);
    expect(isAtLatestChatOffset(8000)).toBe(false);
  });
});

describe("chat follow intent", () => {
  it("keeps jumping through estimated offsets, programmatic momentum and growing content", () => {
    const state = new ChatScrollFollow();
    state.beginDrag();
    state.endDrag(false);
    expect(state.following).toBe(false);
    state.followLatest();
    state.beginMomentum();
    state.scrolled(false); // Animation is between the old position and the estimated end.
    state.endMomentum(false); // Unmeasured variable-height cells made the estimate too short.
    expect(state.following).toBe(true);
    state.followLatest(); // onContentSizeChange corrects the newly measured end.
    state.scrolled(false); // More streamed text grew the content again.
    expect(state.following).toBe(true);
    state.scrolled(true);
    expect(state.following).toBe(true);
  });

  it("lets a user interrupt auto-follow and read old messages through a fling", () => {
    const state = new ChatScrollFollow();
    state.followLatest();
    state.beginDrag();
    expect(state.following).toBe(false);
    state.scrolled(false);
    state.endDrag(false, -2);
    state.beginMomentum();
    state.scrolled(false);
    state.endMomentum(false);
    expect(state.following).toBe(false);
    state.scrolled(false); // A new message changing the layout cannot opt the user back in.
    expect(state.following).toBe(false);
  });

  it("waits for upward momentum even if the finger is released near the bottom", () => {
    const state = new ChatScrollFollow();
    state.beginDrag();
    state.endDrag(true, -1);
    expect(state.following).toBe(false);
    state.beginMomentum();
    state.endMomentum(false);
    expect(state.following).toBe(false);
  });

  it("resumes after a stationary drag or a user fling actually reaches the bottom", () => {
    const state = new ChatScrollFollow();
    state.beginDrag();
    state.endDrag(true, 0);
    expect(state.following).toBe(true);
    state.followLatest();
    state.scrolled(false);
    expect(state.following).toBe(true);
    state.beginDrag();
    state.endDrag(false, 2);
    state.beginMomentum();
    state.endMomentum(true);
    expect(state.following).toBe(true);
  });

  it("an explicit jump during a user fling owns its late momentum-end callback", () => {
    const state = new ChatScrollFollow();
    state.beginDrag();
    state.endDrag(false, -2);
    state.beginMomentum();
    state.followLatest();
    state.endMomentum(false);
    expect(state.following).toBe(true);
  });
});
