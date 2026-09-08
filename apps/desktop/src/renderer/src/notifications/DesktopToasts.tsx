import { useEffect, type ReactNode } from "react";
import { Toast } from "@base-ui/react/toast";
import { CircleAlert, TriangleAlert, X } from "lucide-react";
import { useLocale } from "../locale";
import { displayError } from "../state";
import { notify, subscribeNotices } from "./notifications";
import "./notifications.css";

function ToastViewport() {
  const { t } = useLocale();
  const { toasts, add } = Toast.useToastManager();
  useEffect(() => subscribeNotices((notice) => {
    add({ type: notice.kind, title: notice.title ?? (notice.kind === "error" ? t("操作未完成", "Action failed") : t("需要注意", "Attention")), description: notice.message, timeout: notice.kind === "error" ? 12_000 : 8_000, priority: "low" });
  }), [add, t]);
  useEffect(() => {
    const rejection = (event: PromiseRejectionEvent): void => {
      if (event.reason instanceof DOMException && event.reason.name === "AbortError") return;
      notify({ kind: "error", message: displayError(event.reason) });
    };
    window.addEventListener("unhandledrejection", rejection);
    return () => window.removeEventListener("unhandledrejection", rejection);
  }, []);
  return <Toast.Portal><Toast.Viewport className="desktop-toast-viewport" aria-label={t("通知", "Notifications")}>
    {toasts.map((toast) => <Toast.Root key={toast.id} toast={toast} className="desktop-toast" swipeDirection="right">
      {toast.type === "warning" ? <TriangleAlert className="desktop-toast-icon" /> : <CircleAlert className="desktop-toast-icon" />}
      <Toast.Content className="desktop-toast-content"><Toast.Title className="desktop-toast-title" /><Toast.Description className="desktop-toast-description" /></Toast.Content>
      <Toast.Close data-slot="toast-close" className="desktop-toast-close" aria-hidden={false} aria-label={t("关闭通知", "Dismiss notification")}><X /></Toast.Close>
    </Toast.Root>)}
  </Toast.Viewport></Toast.Portal>;
}

export function DesktopToasts({ children }: { children: ReactNode }) {
  return <Toast.Provider limit={3}><ToastViewport />{children}</Toast.Provider>;
}
