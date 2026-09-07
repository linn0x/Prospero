import type { AgentAccountFeatureError } from "../../../shared/types";

export function featureErrorText(error: AgentAccountFeatureError | undefined, t: (zh: string, en: string) => string): string {
  const messages: Record<string, [string, string]> = {
    authentication: ["认证失败，请检查 API Key。", "Authentication failed. Check the API key."],
    unsupported: ["服务或 daemon 尚不支持此功能。", "This service or daemon does not support this feature."],
    network: ["连接失败，请检查网络与服务地址后重试。", "Connection failed. Check the network and service URL, then retry."],
    timeout: ["请求超时，请重试。", "The request timed out. Retry."],
    invalid_format: ["服务返回了无法识别的目录格式。", "The service returned an unrecognized catalog format."],
    empty_catalog: ["服务未返回模型，仍可手动填写模型 ID。", "No models were returned. You can still enter a model ID."],
    limit_exceeded: ["返回内容超过限制，请缩小配置后重试。", "The response exceeded the allowed limit."],
    invalid_request: ["请检查输入的连接或配置内容。", "Check the connection or configuration values."],
    not_found: ["账号或配置已不存在，请重新加载。", "The account or configuration no longer exists. Reload."],
    forbidden: ["此配置不允许编辑。", "This configuration cannot be edited."],
    conflict: ["配置已在别处修改。请先重新加载，避免覆盖新内容。", "The configuration changed elsewhere. Reload before saving."],
    syntax: ["配置语法有误，请修正后保存。", "Correct the configuration syntax before saving."],
    invalid_config: ["配置包含不支持的字段或值。", "The configuration contains unsupported fields or values."],
    storage: ["配置保存失败，原内容已保留，请重试。", "Saving failed. The original configuration was retained. Retry."],
    busy: ["账号正在处理其他操作，请稍后重试。", "Another account operation is running. Retry shortly."],
  };
  const message = messages[error?.code ?? ""] ?? ["操作失败，请重试。", "The operation failed. Retry."];
  return t(message[0], message[1]) + (error?.line ? t(" 第 " + error.line + " 行", " Line " + error.line) + (error.column ? t("，第 " + error.column + " 列", ", column " + error.column) : "") : "");
}
