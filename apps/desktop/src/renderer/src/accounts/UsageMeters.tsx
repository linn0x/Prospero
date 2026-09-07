import type { UsageAccount, UsageWindow } from "../../../shared/types";
import { useLocale } from "../locale";

export function UsageMeters({ usage }: { usage?: UsageAccount | undefined }) {
  const { t } = useLocale();
  if (!usage) return <p className="usage-note">{t("额度将在账号登录后显示", "Usage appears after the account signs in")}</p>;
  if (!usage.available) return <p className="usage-note">{usage.reason ?? t("这个账号暂无可读取的额度", "Usage is unavailable for this account")}</p>;
  const latestDaily = usage.dailyUsage?.at(-1);
  return <div className="usage-meters">{(usage.lifetimeTokens !== undefined || usage.creditsUnlimited !== undefined || usage.creditsBalance !== undefined) && <div className="usage-summary-grid"><div><span>{t("累计 Tokens", "Lifetime tokens")}</span><strong>{usage.lifetimeTokens?.toLocaleString() ?? "—"}</strong></div><div><span>Credits</span><strong>{usage.creditsUnlimited ? t("无限", "Unlimited") : usage.creditsBalance ?? "—"}</strong></div>{latestDaily && <div><span>{latestDaily.date}</span><strong>{latestDaily.tokens.toLocaleString()}</strong></div>}</div>}{usage.windows.map((window: UsageWindow, index) => {
    const label = window.label;
    const remaining = Math.max(0, Math.round(100 - window.utilization));
    return <div className="usage-meter" key={`${window.label}-${String(index)}`}><div><span>{label}</span><strong>{remaining}% {t("可用", "available")}</strong></div><div className="usage-track"><i style={{ width: `${String(remaining)}%` }} /></div>{window.resetsAt && <small>{new Date(window.resetsAt).toLocaleString()} {t("重置", "reset")}</small>}</div>;
  })}{usage.spendRemainingPercent !== undefined && <div className="usage-meter"><div><span>{t("消费上限", "Spend limit")} {usage.spendUsed ?? "—"} / {usage.spendLimit ?? "—"}</span><strong>{Math.round(usage.spendRemainingPercent)}% {t("可用", "available")}</strong></div><div className="usage-track"><i style={{ width: `${String(usage.spendRemainingPercent)}%` }} /></div></div>}{usage.windows.length === 0 && <p className="usage-note">{usage.reason ?? t("账号已连接，但未返回套餐限流窗口。", "The account is connected, but no plan rate-limit windows were returned.")}</p>}</div>;
}
