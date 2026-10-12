import { MousePointer2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { useLocale } from "../locale";

const STORAGE_KEY = "prospero.terminal.mouse-mode";
export const TERMINAL_MOUSE_MODE_EVENT = "prospero:terminal-mouse-mode";

export function readTerminalMousePreference(storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage, sessionId?: string): boolean {
  try { return (sessionId ? storage?.getItem(`${STORAGE_KEY}:${sessionId}`) ?? storage?.getItem(STORAGE_KEY) : storage?.getItem(STORAGE_KEY)) !== "application"; } catch { return true; }
}

export function writeTerminalMousePreference(localSelection: boolean, storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage, sessionId?: string): void {
  try { storage?.setItem(sessionId ? `${STORAGE_KEY}:${sessionId}` : STORAGE_KEY, localSelection ? "selection" : "application"); } catch {}
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(TERMINAL_MOUSE_MODE_EVENT, { detail: { sessionId, localSelection } }));
}

export function TerminalMouseToggle({ localSelection, onChange, sessionId }: { localSelection: boolean; onChange: (value: boolean) => void; sessionId?: string }) {
  const { t } = useLocale();
  const next = !localSelection;
  return <Button className="terminal-mouse-toggle" variant={localSelection ? "ghost" : "secondary"} size="sm" aria-label={localSelection ? t("启用应用鼠标交互", "Enable application mouse interaction") : t("恢复本地选字", "Restore local text selection")} aria-pressed={!localSelection} title={localSelection ? t("当前拖动可选字；点击切换，让 CLI 接收点击和滚轮", "Drag to select text; switch to send clicks and wheel events to the CLI") : t("应用处理点击和滚轮；按住 ⌥（Mac）或 Shift 拖动可选字", "The application handles clicks and the wheel; hold Option (Mac) or Shift while dragging to select text")} onClick={() => { writeTerminalMousePreference(next, undefined, sessionId); onChange(next); }}><MousePointer2 /><span>{localSelection ? t("本地选字", "Select text") : t("应用鼠标", "App mouse")}</span></Button>;
}
