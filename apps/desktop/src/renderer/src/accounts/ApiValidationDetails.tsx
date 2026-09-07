import type { JsonObject } from "../../../shared/types";
import { record, text } from "../state";
import { useLocale } from "../locale";
import { accountApiStatus, accountApiEngineStatus, modelCapabilitySupportRows, modelCapabilityLabel } from "../account-profile-form";

export function ApiValidationDetails({ account, engineValidationSupported }: { account: JsonObject; engineValidationSupported: boolean }) {
  const { t } = useLocale();
  const validation = record(account["apiValidation"]);
  const checks = record(validation["checks"]);
  const engineValidation = record(account["apiEngineValidation"]);
  const engineChecks = record(engineValidation["checks"]);
  const support = modelCapabilitySupportRows(record(account["apiProfile"]), record(account["modelCapabilitySupport"]));
  const label = (value: unknown): string => value === "passed" ? t("通过", "Passed") : value === "failed" ? t("失败", "Failed") : t("未测试", "Not tested");
  const timestamp = (value: JsonObject): string => typeof value["checkedAt"] === "number" ? new Date(value["checkedAt"]).toLocaleString() : "";
  return <div className="usage-note grid gap-2" role="status">
    <div>
      <strong>{t("API 协议", "API protocol")} · {t(accountApiStatus(account), accountApiStatus(account, true))}</strong>
      {account["apiProfileError"] ? <p>{text(account["apiProfileError"])}</p> : Object.keys(validation).length > 0 && <>
        <p>{t("运行环境", "Runtime")}: {label(checks["runtime"])} · {t("流式响应", "Streaming")}: {label(checks["streaming"])} · {t("工具调用", "Tool calls")}: {label(checks["tools"])}</p>
        <p>{text(validation["detail"])} {timestamp(validation)}</p>
      </>}
    </div>
    {(engineValidationSupported || Object.keys(engineValidation).length > 0) && <div>
      <strong className={engineValidation["status"] === "failed" ? "text-destructive" : undefined}>{t(accountApiEngineStatus(account), accountApiEngineStatus(account, true))}</strong>
      {Object.keys(engineValidation).length > 0 && <>
        <p>{t("运行环境", "Runtime")}: {label(engineChecks["runtime"])} · {t("配置加载", "Configuration")}: {label(engineChecks["configuration"])} · {t("流式响应", "Streaming")}: {label(engineChecks["streaming"])} · {t("工具执行", "Tool execution")}: {label(engineChecks["tools"])}</p>
        <p>{text(engineValidation["engine"])} {text(engineValidation["cliVersion"])} · {timestamp(engineValidation)}</p>
        <p>{text(engineValidation["detail"])}</p>
      </>}
    </div>}
    {support.length > 0 && <div>
      <strong>{t("模型能力生效情况", "Model capability support")}</strong>
      {support.map(({ key, status }) => <p key={key}>{t(modelCapabilityLabel(key), modelCapabilityLabel(key, true))}: {status === "enforced" ? t("已接入本地配置", "Applied to local configuration") : status === "unsupported" ? t("已保存，当前引擎未应用", "Saved, but not applied by this engine") : t("未报告生效情况", "Enforcement not reported")}</p>)}
    </div>}
    {!account["apiProfileError"] && <p>{engineValidationSupported
      ? t("两项验证均会发送少量真实请求，可能消耗额度。API 检查验证协议；Agent 验证在隔离环境中检查实际引擎的配置、响应和工具执行。", "Both checks send small real requests and may use credits. API checks verify the protocol; Agent checks validate the actual engine's configuration, responses, and tool execution in an isolated environment.")
      : t("测试会向配置的服务发送少量请求，可能消耗额度；检查 API 协议，不代表完整 Agent 执行已验证。", "Testing sends small requests to the configured service and may use credits. API protocol checks do not verify full agent execution.")}</p>}
  </div>;
}
