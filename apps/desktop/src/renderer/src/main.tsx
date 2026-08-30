import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopSnapshot } from "./state";
import { LocaleProvider, useLocale } from "./locale";
import "./styles.css";

function Root() {
  const { t } = useLocale();
  const snapshot = useDesktopSnapshot();
  if (!snapshot) return <div className="boot-screen"><div className="boot-mark" /><span>{t("正在连接 Prospero…", "Connecting to Prospero…")}</span></div>;
  return <TooltipProvider><App snapshot={snapshot} /></TooltipProvider>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><LocaleProvider><Root /></LocaleProvider></StrictMode>);
