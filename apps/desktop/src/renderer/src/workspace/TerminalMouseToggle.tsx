import { MousePointer2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { useLocale } from "../locale";

const STORAGE_KEY = "prospero.terminal.mouse-mode";
export const TERMINAL_MOUSE_MODE_EVENT = "prospero:terminal-mouse-mode";

/** The default keeps the existing text-selection behavior for new users. */
export function readTerminalMousePreference(storage: Pick<Storage, "getItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): boolean {
  try { return storage?.getItem(STORAGE_KEY) !== "application"; } catch { return true; }
}

export function writeTerminalMousePreference(localSelection: boolean, storage: Pick<Storage, "setItem"> | undefined = typeof localStorage === "undefined" ? undefined : localStorage): void {
  try { storage?.setItem(STORAGE_KEY, localSelection ? "selection" : "application"); } catch { /* Preferences are best effort. */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(TERMINAL_MOUSE_MODE_EVENT, { detail: localSelection }));
}

export function TerminalMouseToggle({ localSelection, onChange }: { localSelection: boolean; onChange: (value: boolean) => void }) {
  const { t } = useLocale();
  const next = !localSelection;
  return <Button variant={localSelection ? "ghost" : "secondary"} size="icon-sm" aria-label={localSelection ? t("启用应用鼠标交互", "Enable application mouse interaction") : t("恢复本地选字", "Restore local text selection")} aria-pressed={!localSelection} title={localSelection ? t("当前可拖动选字；点击后由 CLI 应用处理鼠标", "Text selection is local; click to let the CLI application handle the mouse") : t("当前由 CLI 应用处理鼠标；点击恢复本地选字", "The CLI application handles the mouse; click to restore local text selection")} onClick={() => { writeTerminalMousePreference(next); onChange(next); }}><MousePointer2 /></Button>;
}
