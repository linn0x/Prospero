function terminalEventTargetsLink(event: MouseEvent): boolean {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  return path.some((item) => {
    const classList = (item as { classList?: { contains?: (value: string) => boolean } } | null)?.classList;
    return typeof classList?.contains === "function" && classList.contains("xterm-cursor-pointer");
  });
}

/** Route a primary click through xterm's supported force-selection modifier.
 * Only the DOM event is adapted: the PTY's mouse modes and wheel reporting stay
 * intact. xterm then owns double/triple click, autoscroll, selection and copy.
 */
export function preferLocalTerminalSelection(event: MouseEvent, isMac: boolean, local: boolean, mouseMode: string): void {
  if (!local || mouseMode === "none" || event.button !== 0 || event.ctrlKey || event.metaKey || terminalEventTargetsLink(event)) return;
  Object.defineProperty(event, isMac ? "altKey" : "shiftKey", { configurable: true, value: true });
}
