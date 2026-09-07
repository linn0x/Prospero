import type { AccountModelsInput, JsonObject } from "../../../shared/types";
import { record, text } from "../state";
import { accountApiConnectionLocked, accountApiProfileNameAction, accountApiProtocolDefaults, accountApiProtocolFromProfile, accountApiProvider, modelCapabilityDraft, parseModelCapabilities, type AccountApiProtocol, type ModelCapabilityDraft } from "../account-profile-form";

export interface AccountEditDraft {
  name: string;
  protocol: AccountApiProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  modelCapabilities: ModelCapabilityDraft;
}

export function accountModelCatalogRequest(draft: Pick<AccountEditDraft, "protocol" | "baseUrl" | "apiKey">, account?: JsonObject): AccountModelsInput | undefined {
  if (draft.apiKey.trim() && draft.baseUrl.trim()) return { protocol: draft.protocol, baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim() };
  if (!account || account["apiProfileError"] || !text(account["id"])) return undefined;
  const profile = record(account["apiProfile"]);
  if (draft.protocol !== accountApiProtocolFromProfile(profile, text(account["agent"])) || draft.baseUrl.trim() !== text(profile["baseUrl"])) return undefined;
  return { accountId: text(account["id"]) };
}

export function accountCreateApiInput(draft: AccountEditDraft, protocolsSupported: boolean, validationSupported: boolean): JsonObject {
  if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim() || !draft.apiKey.trim()) throw new Error("Complete the API connection fields / 请填写完整 API 连接配置");
  if (!protocolsSupported && draft.protocol === "openai_chat_completions") throw new Error("Upgrade the daemon to use Chat Completions / 请升级 daemon 后使用 Chat Completions");
  const modelCapabilities = validationSupported ? parseModelCapabilities(draft.modelCapabilities, {}, draft.protocol) : null;
  return { agent: accountApiProtocolDefaults(draft.protocol).agent, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), apiKey: draft.apiKey.trim(),
    ...(protocolsSupported ? { provider: accountApiProvider(draft.protocol), protocol: draft.protocol } : {}),
    ...(modelCapabilities ? { modelCapabilities } : {}),
  };
}

export function accountEditActions(account: JsonObject, draft: AccountEditDraft, protocolsSupported: boolean, validationSupported: boolean): JsonObject[] {
  const accountId = text(account["id"]);
  const name = draft.name.trim();
  if (!accountId || !name || name.length > 80) throw new Error("Account name is required / 请填写账号名称");
  const renamed = name !== text(account["name"], text(account["agent"]));
  const profile = record(account["apiProfile"]);
  const isApi = Boolean(Object.keys(profile).length || account["apiProfileError"]);
  if (!isApi) return renamed ? [{ type: "agent.account.rename", accountId, name }] : [];
  if (accountApiConnectionLocked(account)) return renamed ? [accountApiProfileNameAction(accountId, name, protocolsSupported)] : [];
  const baseUrl = draft.baseUrl.trim();
  const model = draft.model.trim();
  const apiKey = draft.apiKey.trim();
  if (!baseUrl || !model) throw new Error("API URL and model are required / 请填写 API 地址与模型");
  const initialCapabilities = record(profile["modelCapabilities"]);
  const capabilitiesChanged = validationSupported && JSON.stringify(draft.modelCapabilities) !== JSON.stringify(modelCapabilityDraft(initialCapabilities));
  const modelCapabilities = validationSupported ? parseModelCapabilities(draft.modelCapabilities, initialCapabilities, draft.protocol) : undefined;
  const changed = Boolean(account["apiProfileError"]) || baseUrl !== text(profile["baseUrl"]) || model !== text(profile["model"]) || Boolean(apiKey) || capabilitiesChanged
    || protocolsSupported && draft.protocol !== accountApiProtocolFromProfile(profile, text(account["agent"]));
  if (protocolsSupported) return renamed || changed ? [{ type: "agent.account.api.configure", accountId, name, provider: accountApiProvider(draft.protocol), protocol: draft.protocol, baseUrl, model,
    ...(apiKey ? { apiKey } : {}), ...(capabilitiesChanged ? { modelCapabilities: modelCapabilities ?? null } : {}) }] : [];
  if (changed && !apiKey) throw new Error("The older daemon requires the API Key again to change connection settings / 旧版 daemon 要求重新输入 API Key 才能修改连接设置");
  return [
    ...(changed ? [{ type: "agent.account.api.configure", accountId, baseUrl, model, apiKey }] : []),
    ...(renamed ? [{ type: "agent.account.rename", accountId, name }] : []),
  ];
}
