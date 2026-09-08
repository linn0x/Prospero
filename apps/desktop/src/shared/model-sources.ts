import { C2SModelSourceActionSchema, S2CModelSourceResultSchema, type ModelSourceAction } from "@prospero/protocol";

export function modelSourceRequest(value: unknown, requestId: string) {
  const parsed = C2SModelSourceActionSchema.safeParse({ type: "model.source.action", requestId, action: value });
  if (!parsed.success) throw new Error("模型源请求无效 / Invalid model source request");
  return parsed.data;
}

export function modelSourceResult(value: unknown, requestId?: string, action?: ModelSourceAction["kind"]) {
  const parsed = S2CModelSourceResultSchema.safeParse(value);
  if (!parsed.success || requestId !== undefined && parsed.data.requestId !== requestId) throw new Error("模型源响应无效 / Invalid model source response");
  if (parsed.data.ok && parsed.data.error || !parsed.data.ok && !parsed.data.error) throw new Error("模型源响应状态无效 / Invalid model source result status");
  if (parsed.data.ok && action) {
    const data = parsed.data;
    const valid = action === "bind" ? data.accountId && data.accounts?.some(account => account.id === data.accountId)
      : action === "models" ? !!data.models
        : action === "migration.preview" ? !!data.migrations : !!data.sources;
    if (!valid) throw new Error("模型源响应缺少结果 / Missing model source result");
  }
  return parsed.data;
}
