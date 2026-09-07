import type { ReactNode } from "react";
import { DesktopIcon } from "../design-system/icons";
import { useLocale } from "../locale";
import type { SettingFeedback } from "./settings-state";

export function SettingRow({ id, title, description, children, feedback, onRetry, stacked = false, group = false }: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  feedback?: SettingFeedback | undefined;
  onRetry?: (() => void) | undefined;
  stacked?: boolean;
  group?: boolean;
}) {
  const { t } = useLocale();
  return <div className={`setting-row${stacked ? " setting-row-stacked" : ""}`} role={group ? "group" : undefined} aria-labelledby={group ? `${id}-label` : undefined} aria-busy={feedback?.state === "saving"}>
    <div className="setting-row-copy">
      {group ? <span id={`${id}-label`}>{title}</span> : <label id={`${id}-label`} htmlFor={id}>{title}</label>}
      {description && <p id={`${id}-description`}>{description}</p>}
    </div>
    <div className="setting-row-control">{children}</div>
    {feedback && <div id={`${id}-feedback`} className={`setting-row-feedback is-${feedback.state}`} role={feedback.state === "error" ? "alert" : "status"} tabIndex={feedback.state === "error" ? 0 : undefined}>
      <DesktopIcon name={feedback.state === "saving" ? "refresh" : feedback.state === "saved" ? "check" : "alert"} size={12} className={feedback.state === "saving" ? "setting-saving-icon" : undefined} />
      <span>{feedback.message ?? t("正在处理…", "Working…")}</span>
      {feedback.state === "error" && onRetry && <button type="button" className="setting-retry" onClick={onRetry}>{t("重试", "Retry")}</button>}
    </div>}
  </div>;
}

export function SettingsSection({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return <section className="settings-section" aria-labelledby={`${id}-heading`}>
    <header className="settings-section-header">
      <h2 id={`${id}-heading`}>{title}</h2>
      {description && <p>{description}</p>}
    </header>
    <div className="settings-section-rows">{children}</div>
  </section>;
}
