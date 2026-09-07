import {
  C2SAgentAccountApiModelsGetSchema,
  C2SAgentAccountConfigGetSchema,
  C2SAgentAccountConfigSetSchema,
  S2CAgentAccountApiModelsResultSchema,
  S2CAgentAccountConfigResultSchema,
} from "@prospero/protocol";

export function accountModelsRequest(value: unknown, requestId: string) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("模型目录请求无效 / Invalid model catalog request");
  const result = C2SAgentAccountApiModelsGetSchema.safeParse({ ...value, type: "agent.account.api.models.get", requestId });
  if (!result.success) throw new Error("模型目录请求无效 / Invalid model catalog request");
  const { accountId, protocol, baseUrl, apiKey } = result.data;
  if (accountId ? protocol !== undefined || baseUrl !== undefined || apiKey !== undefined : !protocol || !baseUrl || !apiKey) {
    throw new Error("使用保存的账号或完整草稿连接 / Use a saved account or a complete draft connection");
  }
  return result.data;
}

export function accountConfigRequest(value: unknown, requestId: string, write: boolean) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("配置请求无效 / Invalid configuration request");
  const result = write
    ? C2SAgentAccountConfigSetSchema.safeParse({ ...value, type: "agent.account.config.set", requestId })
    : C2SAgentAccountConfigGetSchema.safeParse({ ...value, type: "agent.account.config.get", requestId });
  if (!result.success) throw new Error("配置请求无效 / Invalid configuration request");
  return result.data;
}

export function accountModelsResult(value: unknown, requestId?: string) {
  const result = S2CAgentAccountApiModelsResultSchema.safeParse(value);
  if (!result.success || requestId !== undefined && result.data.requestId !== requestId) throw new Error("模型目录响应无效 / Invalid model catalog response");
  return result.data;
}

export function accountConfigResult(value: unknown, requestId?: string, accountId?: string) {
  const result = S2CAgentAccountConfigResultSchema.safeParse(value);
  if (!result.success || requestId !== undefined && result.data.requestId !== requestId || accountId !== undefined && result.data.config && result.data.config.accountId !== accountId) throw new Error("配置响应无效 / Invalid configuration response");
  return result.data;
}
