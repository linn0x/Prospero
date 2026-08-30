import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Language = "zh" | "en";

type LocaleContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (zh: string, en: string) => string;
  status: (value: string) => string;
};

const statusCopy: Record<string, [string, string]> = {
  running: ["运行中", "Running"],
  starting: ["启动中", "Starting"],
  idle: ["空闲", "Idle"],
  waiting_approval: ["等待审批", "Needs approval"],
  waiting_input: ["等待输入", "Needs input"],
  completed: ["已完成", "Completed"],
  done: ["已完成", "Done"],
  succeeded: ["已完成", "Succeeded"],
  died: ["已终止", "Stopped"],
  pending: ["待处理", "Pending"],
  ready: ["可执行", "Ready"],
  dispatched: ["已派发", "Dispatched"],
  blocked: ["受阻", "Blocked"],
  failed: ["失败", "Failed"],
  cancelled: ["已取消", "Cancelled"],
  active: ["进行中", "Active"],
  paused: ["已暂停", "Paused"],
  abandoned: ["已放弃", "Abandoned"],
  signed_in: ["已登录", "Signed in"],
  signed_out: ["未登录", "Signed out"],
  unavailable: ["不可用", "Unavailable"],
  error: ["错误", "Error"],
  connected: ["已连接", "Connected"],
  connecting: ["连接中", "Connecting"],
  disabled: ["未启用", "Disabled"],
  offline: ["离线", "Offline"],
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => {
    const stored = localStorage.getItem("prospero.language");
    return stored === "en" || stored === "zh" ? stored : "zh";
  });

  useEffect(() => {
    localStorage.setItem("prospero.language", language);
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);

  const value = useMemo<LocaleContextValue>(() => ({
    language,
    setLanguage,
    t: (zh, en) => language === "zh" ? zh : en,
    status: (status) => {
      const copy = statusCopy[status];
      return copy ? copy[language === "zh" ? 0 : 1] : status || (language === "zh" ? "未知" : "Unknown");
    },
  }), [language]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useLocale must be used within LocaleProvider");
  return context;
}
