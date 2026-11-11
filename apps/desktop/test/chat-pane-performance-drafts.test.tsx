import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationTurn, INITIAL_DIFF_LINE_LIMIT, TurnDiffPatch } from "../src/renderer/src/chat/ConversationTurn";
import {
  CHAT_SESSION_DRAFT_CACHE_LIMIT,
  ConversationTimelineSection,
  clearChatSessionDraftCache,
  getChatSessionDraftCacheSize,
  loadChatSessionDraft,
  saveChatSessionDraft,
  type PendingAttachment,
} from "../src/renderer/src/ChatPane";
import { LocaleProvider } from "../src/renderer/src/locale";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  clearChatSessionDraftCache();
});

afterEach(() => {
  clearChatSessionDraftCache();
  vi.unstubAllGlobals();
});

describe("ConversationTurn DOM containment & huge inline diff pagination", () => {
  it("applies CSS content-visibility containment only to completed turns", () => {
    const completedHtml = renderToStaticMarkup(
      <LocaleProvider>
        <ConversationTurn
          event={{ kind: "conversation.turn", completed: true, finalText: "done", users: [], activity: [], outcomes: [], diffs: [] }}
          renderEvent={() => null}
        />
      </LocaleProvider>,
    );
    expect(completedHtml).toContain("content-visibility:auto");
    expect(completedHtml).toContain("contain-intrinsic-size:auto 180px");

    const runningHtml = renderToStaticMarkup(
      <LocaleProvider>
        <ConversationTurn
          event={{ kind: "conversation.turn", completed: false, finalText: "", users: [], activity: [], outcomes: [], diffs: [] }}
          renderEvent={() => null}
        />
      </LocaleProvider>,
    );
    expect(runningHtml).not.toContain("content-visibility:auto");
  });

  it("caps 5,000-line inline diffs at INITIAL_DIFF_LINE_LIMIT spans and renders expand buttons", () => {
    const hugePatch = Array.from({ length: 5_000 }, (_, index) => `+added line ${index + 1}`).join("\n");
    const patchHtml = renderToStaticMarkup(
      <LocaleProvider>
        <TurnDiffPatch patch={hugePatch} />
      </LocaleProvider>,
    );
    expect(INITIAL_DIFF_LINE_LIMIT).toBe(400);
    const mountedDiffSpans = patchHtml.match(/data-diff-line=/g)?.length ?? 0;
    expect(mountedDiffSpans).toBe(400);
    expect(patchHtml).toContain("继续展开 1000 行（剩余 4600 行）");
    expect(patchHtml).toContain("展开全部 5000 行");
  });
});

describe("ChatPane per-session draft & pending attachment persistence", () => {
  const sampleAttachment = (id: string): PendingAttachment => ({
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 1024,
    dataB64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
  });

  it("preserves both text and pasted/selected image attachments across session switches and PTY unmount/remount", () => {
    const att1 = sampleAttachment("shot-1");
    const att2 = sampleAttachment("shot-2");

    saveChatSessionDraft("session-a", { text: "check this bug", attachments: [att1, att2] }, true);
    saveChatSessionDraft("session-b", { text: "", attachments: [sampleAttachment("only-image")] }, true);

    // Switching away to a PTY tab (ChatPane unmounts) and back to session-a restores both text and attachments
    const restoredA = loadChatSessionDraft("session-a");
    expect(restoredA.text).toBe("check this bug");
    expect(restoredA.attachments).toEqual([att1, att2]);
    // Mutating returned array does not corrupt cached entry
    restoredA.attachments.pop();
    expect(loadChatSessionDraft("session-a").attachments).toHaveLength(2);

    // Session with attachment-only draft (no text) also survives switches
    const restoredB = loadChatSessionDraft("session-b");
    expect(restoredB.text).toBe("");
    expect(restoredB.attachments).toHaveLength(1);
    expect(restoredB.attachments[0]?.id).toBe("only-image");

    // Clearing after successful send removes both text and attachments
    saveChatSessionDraft("session-a", { text: "", attachments: [] }, true);
    expect(loadChatSessionDraft("session-a")).toEqual({ text: "", attachments: [] });
  });

  it("enforces the 200-session LRU limit while evicting least-recently-used sessions", () => {
    expect(CHAT_SESSION_DRAFT_CACHE_LIMIT).toBe(200);
    for (let index = 1; index <= 205; index++) {
      saveChatSessionDraft(`s-${index}`, { text: `draft ${index}`, attachments: [sampleAttachment(`img-${index}`)] });
    }
    expect(getChatSessionDraftCacheSize()).toBe(200);
    // Oldest 5 (s-1 .. s-5) evicted; s-6 .. s-205 retained
    expect(loadChatSessionDraft("s-1").attachments).toEqual([]);
    expect(loadChatSessionDraft("s-6").attachments).toHaveLength(1);

    // Touching s-6 refreshes its LRU position so inserting s-206 evicts s-7 instead of s-6
    saveChatSessionDraft("s-206", { text: "new", attachments: [sampleAttachment("img-206")] });
    expect(getChatSessionDraftCacheSize()).toBe(200);
    expect(loadChatSessionDraft("s-6").attachments).toHaveLength(1);
    expect(loadChatSessionDraft("s-7").attachments).toEqual([]);
  });

  it("memoizes ConversationTimelineSection so composer draft updates do not invalidate timeline props", () => {
    // React.memo wraps ConversationTimelineSection ($$typeof === Symbol.for('react.memo'))
    expect((ConversationTimelineSection as unknown as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });
});
