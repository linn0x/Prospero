import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { Button } from "../components/ui/button";
import { useSidebar } from "../components/ui/sidebar";
import { useLocale } from "../locale";
import { reportError } from "../state";
import type { WindowMenuAction, WindowMenuName } from "../../../shared/window-menu";

export function WindowsTitlebar({ canBack, canForward, onBack, onForward, onAction }: { canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void; onAction: (action: WindowMenuAction) => void }) {
  const { t, language } = useLocale();
  const { toggleSidebar } = useSidebar();
  const [menu, setMenu] = useState<WindowMenuName>();
  const pending = useRef(false);
  if (window.prospero.platform === "darwin") return null;
  return <header className="windows-titlebar" aria-label={t("窗口顶栏", "Window title bar")}>
    <Button variant="ghost" size="icon-sm" aria-label={t("切换侧边栏", "Toggle sidebar")} title={t("切换侧边栏", "Toggle sidebar")} onClick={toggleSidebar}><PanelLeft /></Button>
    <Button variant="ghost" size="icon-sm" aria-label={t("后退", "Back")} title={t("后退 · Alt+←", "Back · Alt+Left")} disabled={!canBack} onClick={onBack}><ArrowLeft /></Button>
    <Button variant="ghost" size="icon-sm" aria-label={t("前进", "Forward")} title={t("前进 · Alt+→", "Forward · Alt+Right")} disabled={!canForward} onClick={onForward}><ArrowRight /></Button>
    <nav aria-label={t("应用菜单", "Application menu")}>{([['file', t('文件', 'File')], ['edit', t('编辑', 'Edit')], ['view', t('视图', 'View')], ['help', t('帮助', 'Help')]] as const).map(([id, label]) => <Button key={id} variant="ghost" size="sm" aria-haspopup="menu" aria-expanded={menu === id} onClick={async (event) => {
      if (pending.current) return;
      pending.current = true;
      // Keep the editor/terminal focused so native copy, paste and undo target it.
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu(id);
      try { const selected = await window.prospero.openWindowMenu({ menu: id, x: rect.left, y: rect.bottom, language }); if (selected === "toggle-sidebar") toggleSidebar(); else if (selected) onAction(selected); }
      catch (reason) { reportError(reason); }
      finally { pending.current = false; setMenu(undefined); }
    }} onMouseDown={(event) => event.preventDefault()}>{label}</Button>)}</nav>
    <span className="titlebar-app-name" aria-hidden="true">Prospero</span>
  </header>;
}
