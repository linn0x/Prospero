export type ClipboardKey = Pick<KeyboardEvent, "type" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & Partial<Pick<KeyboardEvent, "defaultPrevented" | "isComposing">>;

export function terminalClipboardShortcut(event: ClipboardKey, isMac: boolean): "copy" | "paste" | undefined {
  if (event.type !== "keydown" || event.defaultPrevented || event.isComposing) return undefined;
  const command = isMac
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey;
  if (command && event.code === "KeyC") return "copy";
  if (command && event.code === "KeyV") return "paste";
  if (event.code === "Insert" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) return "paste";
  return undefined;
}

export function consumeTerminalKey(event: Pick<KeyboardEvent, "preventDefault" | "stopPropagation">): void {
  event.preventDefault(); event.stopPropagation();
}

export function allowNativeTerminalPaste(event: Pick<KeyboardEvent, "preventDefault" | "stopPropagation">, allowed: boolean): boolean {
  if (!allowed) consumeTerminalKey(event);
  return allowed;
}

export function bindTerminalPaste(target: EventTarget, terminal: { paste(text: string): void }, canPaste: () => boolean, blocked: () => void = () => {}, pasted: () => void = () => {}): () => void {
  const handle = (raw: Event): void => {
    const event = raw as ClipboardEvent;
    const cancelled = event.defaultPrevented;
    event.preventDefault(); event.stopImmediatePropagation();
    if (cancelled) return;
    if (!canPaste()) { blocked(); return; }
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    terminal.paste(text);
    pasted();
  };
  target.addEventListener("paste", handle, { capture: true });
  return () => target.removeEventListener("paste", handle, { capture: true });
}
