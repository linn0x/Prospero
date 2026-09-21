import { MousePointer2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { useLocale } from "../locale";

export function TerminalMouseToggle({ localSelection, onChange }: { localSelection: boolean; onChange: (value: boolean) => void }) {
  const { t } = useLocale();
  return <Button variant={localSelection ? "ghost" : "secondary"} size="icon-sm" aria-label={t("应用鼠标交互", "Application mouse interaction")} aria-pressed={!localSelection} title={localSelection ? t("拖动选择文字；点击启用应用鼠标交互", "Drag to select text; click to enable application mouse interaction") : t("鼠标由应用处理；点击恢复拖选文字", "Application handles the mouse; click to restore text selection")} onClick={() => onChange(!localSelection)}><MousePointer2 /></Button>;
}
