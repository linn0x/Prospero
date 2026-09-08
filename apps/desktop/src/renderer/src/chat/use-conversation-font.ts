import { useCallback, useSyncExternalStore } from "react";
import { conversationFontSize, CONVERSATION_FONT_KEY, DEFAULT_CONVERSATION_FONT_SIZE } from "./display";

const FONT_CHANGED = "prospero:conversation-font";
function readSize(): number {
  try { return conversationFontSize(localStorage.getItem(CONVERSATION_FONT_KEY)); }
  catch { return DEFAULT_CONVERSATION_FONT_SIZE; }
}
function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(FONT_CHANGED, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(FONT_CHANGED, onChange);
  };
}

export function useConversationFont(): readonly [number, (size: number) => void] {
  const size = useSyncExternalStore(subscribe, readSize, () => DEFAULT_CONVERSATION_FONT_SIZE);
  const update = useCallback((value: number) => {
    try { localStorage.setItem(CONVERSATION_FONT_KEY, String(conversationFontSize(value))); } catch {}
    window.dispatchEvent(new Event(FONT_CHANGED));
  }, []);
  return [size, update];
}
