import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopSnapshot, JsonObject, SessionInfo, UsageAccount } from "../../../shared/types";
import { getCachedAccountUsage, loadAccountUsage } from "../account-usage-cache";
import { accountApiTestAction, provisionalAccountLoginSession } from "../account-profile-form";
import { useLocale } from "../locale";
import { displayError, record, text } from "../state";
import { createManagedAccountFlow } from "./account-request-state";

export type AccountAction = "agent.account.default" | "agent.account.login" | "agent.account.logout" | "agent.account.delete" | "agent.account.api.test";

export function useAccountActions(snapshot: DesktopSnapshot, onOpenSession: (id: string, session?: SessionInfo) => void) {
  const { t } = useLocale();
  const current = useRef(snapshot);
  current.current = snapshot;
  const [usage, setUsage] = useState<UsageAccount[]>(getCachedAccountUsage);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [error, setError] = useState<{ key: string; message: string }>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string>();
  const busyRef = useRef<string | undefined>(undefined);
  const loadingRef = useRef(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const refresh = useCallback(async (force = false) => {
    if (loadingRef.current) return;
    if (!current.current.daemon.running) {
      setLoading(false);
      setRefreshError(t("启动本地服务后可管理账号。", "Start the local service to manage accounts."));
      return;
    }
    loadingRef.current = true;
    const token = ++generation.current;
    setLoading(true); setRefreshError("");
    try {
      const results = await Promise.allSettled([
        window.prospero.accountAction({ type: "agent.accounts.list", requestId: crypto.randomUUID() }),
        loadAccountUsage(force),
      ]);
      if (!alive.current || generation.current !== token) return;
      if (results[1].status === "fulfilled") setUsage(results[1].value);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => displayError(result.reason));
      if (results[0].status === "fulfilled" && results[0].value["ok"] === false) failures.push(t("无法读取账号列表，请重试。", "Unable to read the account list. Retry."));
      setRefreshError(failures.join(" · "));
    } finally {
      if (alive.current && generation.current === token) { loadingRef.current = false; setLoading(false); }
    }
  }, [t]);
  useEffect(() => {
    alive.current = true;
    loadingRef.current = false;
    setLoading(false);
    void refresh();
    return () => { alive.current = false; generation.current++; loadingRef.current = false; };
  }, [refresh, snapshot.daemon.running]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const perform = async (key: string, action: () => Promise<void>, failureMessage?: string) => {
    if (busyRef.current || loadingRef.current) return false;
    if (!current.current.daemon.running) {
      setError({ key, message: t("启动本地服务后可管理账号。", "Start the local service to manage accounts.") });
      return false;
    }
    busyRef.current = key; setBusy(key); setError(undefined); setNotice("");
    try {
      await action();
      if (alive.current) void refresh();
      return true;
    } catch (reason) {
      if (alive.current) setError({ key, message: failureMessage ?? displayError(reason) });
      return false;
    } finally {
      if (busyRef.current === key) { busyRef.current = undefined; if (alive.current) setBusy(undefined); }
    }
  };
  const openLogin = (id: string, account: JsonObject) => {
    if (!alive.current) return;
    onOpenSession(id, provisionalAccountLoginSession(account, id));
    void window.prospero.listSessions({ ids: [id], limit: 1 }).then(page => {
      const session = page.items.find(item => item.id === id);
      if (session && alive.current) onOpenSession(id, session);
    }).catch(() => undefined);
  };
  const runAction = (account: JsonObject, type: AccountAction, scope: "protocol" | "engine" = "protocol") => {
    const accountId = text(account["id"]);
    return perform(accountId + ":" + type + (type === "agent.account.api.test" ? ":" + scope : ""), async () => {
      const result = await window.prospero.accountAction({
        ...(type === "agent.account.api.test" ? accountApiTestAction(accountId, scope) : { type, accountId }),
        requestId: crypto.randomUUID(),
        ...(type === "agent.account.login" ? { cols: 120, rows: 40 } : {}),
      });
      if (result["cancelled"] === true) return;
      const validation = record(result[scope === "engine" ? "engineValidation" : "validation"]);
      if (result["ok"] === false && (type !== "agent.account.api.test" || !Object.keys(validation).length)) throw new Error(text(result["error"], t("账号操作失败", "Account action failed")));
      const sessionId = text(result["sessionId"]);
      if (type === "agent.account.login" && !sessionId) throw new Error(t("登录会话未返回，请重试登录。", "No sign-in session was returned. Retry sign-in."));
      if (sessionId) openLogin(sessionId, account);
      if (alive.current) setNotice(type === "agent.account.api.test" ? text(validation["detail"], t("验证已完成", "Validation completed")) : t("账号操作已完成", "Account action completed"));
    });
  };
  const createManaged = (input: { agent: "codex" | "claude"; name: string }) => perform("managed-create", async () => {
    const existing = new Set(current.current.accounts.map(account => text(account["id"])));
    const result = await createManagedAccountFlow(input, existing, message => window.prospero.accountAction(message));
    if (result.account && result.sessionId) openLogin(result.sessionId, result.account);
    if (!alive.current) return;
    if (result.login === "failed" && result.account) {
      setError({ key: text(result.account["id"]) + ":agent.account.login", message: t("账号已创建，但登录未启动。请从此账号重试登录。", "The account was created, but sign-in did not start. Retry sign-in from this account.") });
    } else if (result.login === "unavailable") {
      setError({ key: "managed-create", message: t("账号已创建，但未返回对应账号。请刷新列表后登录。", "The account was created but was missing from the result. Refresh the list to sign in.") });
    }
    setNotice(result.login === "started" ? t("独立 CLI 账号已创建", "Isolated CLI account created") : t("账号已创建，可以从账号卡片继续登录。", "Account created. Continue signing in from its card."));
  }, t("创建账号失败，请重试。", "Unable to create the account. Retry."));
  const createApi = (input: JsonObject) => perform("api-create", async () => {
    const result = await window.prospero.accountAction({ ...input, type: "agent.account.api.create", requestId: crypto.randomUUID() });
    if (result["ok"] === false) throw new Error(t("保存 API Profile 失败", "Unable to save API profile"));
    if (alive.current) setNotice(t("API Profile 已保存", "API profile saved"));
  }, t("保存 API Profile 失败，请检查配置后重试。", "Unable to save the API profile. Check the configuration and retry."));
  return { usage, loading, busy, error, notice, refreshError, refresh, runAction, createManaged, createApi };
}
