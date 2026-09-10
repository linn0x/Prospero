import { useEffect, useState } from "react";
import { DesktopIcon, type DesktopIconName } from "../design-system/icons";
import { useLocale } from "../locale";
import { nextSettingsCategory, settingsCategories, type SettingsCategory } from "./settings-state";

const icons: Record<SettingsCategory, DesktopIconName> = { general: "settings", appearance: "appearance", accounts: "accounts", terminal: "terminal", runtime: "server", relay: "relay" };

export function SettingsNav({ active, onChange }: { active: SettingsCategory; onChange: (category: SettingsCategory) => void }) {
  const { t } = useLocale();
  const [horizontal, setHorizontal] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 850px)");
    const update = () => setHorizontal(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return <nav className="settings-nav" aria-label={t("设置分类", "Settings categories")}>
    <div role="tablist" aria-orientation={horizontal ? "horizontal" : "vertical"} aria-label={t("设置分类", "Settings categories")}>
      {settingsCategories.map((category) => {
        return <button key={category.id} type="button" data-liquid-glass="tab" id={`settings-tab-${category.id}`} role="tab" aria-selected={active === category.id} aria-controls={`settings-panel-${category.id}`} tabIndex={active === category.id ? 0 : -1} onClick={() => onChange(category.id)} onKeyDown={(event) => {
          const next = nextSettingsCategory(category.id, event.key);
          if (!next) return;
          event.preventDefault();
          onChange(next);
          document.getElementById(`settings-tab-${next}`)?.focus();
        }}><DesktopIcon name={icons[category.id]} navigation /><span>{t(category.zh, category.en)}</span></button>;
      })}
    </div>
  </nav>;
}
