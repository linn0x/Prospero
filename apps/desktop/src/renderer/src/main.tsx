import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { useDesktopSnapshot } from "./state";
import { LocaleProvider, useLocale } from "./locale";
import "./boot.css";

const App = lazy(() =>
  import("./App").then((module) => ({ default: module.App })),
);

function Root() {
  const { t } = useLocale();
  const { snapshot, error, retry } = useDesktopSnapshot();
  if (!snapshot) return (
    <div className="boot-screen" aria-live="polite" aria-busy={!error}>
      {error ? <div className="boot-error-mark" aria-hidden="true">!</div> : <div className="boot-mark" aria-hidden="true" />}
      <span>
        {error
          ? t("无法载入 Prospero", "Unable to load Prospero")
          : t("正在连接 Prospero…", "Connecting to Prospero…")}
      </span>
      {error && <p role="alert">{error}</p>}
      {error && <button type="button" onClick={retry}>{t("重试", "Retry")}</button>}
    </div>
  );
  return (
    <Suspense
      fallback={
        <div className="boot-screen">
          <div className="boot-mark" />
          <span>{t("正在准备工作台…", "Preparing workspace…")}</span>
        </div>
      }
    >
      <App snapshot={snapshot} />
    </Suspense>
  );
}

// 侧栏头部要给 macOS 的红黄绿按钮让位,样式表按这个属性区分平台。
document.documentElement.dataset["platform"] = window.prospero.platform;

createRoot(document.getElementById("root")!).render(<StrictMode><LocaleProvider><Root /></LocaleProvider></StrictMode>);
