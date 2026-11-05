import type { AgentAccountConfig, JsonObject } from "../../../shared/types";
import { selectCreatedAccount } from "../account-profile-form";
import { record, text } from "../state";

export class AccountRequestGate {
  private generation = 0;
  private pending: number | undefined;

  begin(): number | undefined {
    if (this.pending !== undefined) return undefined;
    this.pending = ++this.generation;
    return this.pending;
  }

  current(token: number): boolean {
    return this.pending === token && this.generation === token;
  }

  finish(token: number): boolean {
    if (!this.current(token)) return false;
    this.pending = undefined;
    return true;
  }

  invalidate(): void {
    this.generation++;
    this.pending = undefined;
  }
}

export function formatEnvLines(env?: Record<string, string> | null): string {
  if (!env) return "";
  return Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function parseEnvLines(raw: string): { env: Record<string, string> | null; error?: string } {
  const result: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      return { env: null, error: `第 ${i + 1} 行格式应为 KEY=VALUE / Line ${i + 1} must be KEY=VALUE` };
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
      return { env: null, error: `环境变量名无效: ${key} / Invalid variable name: ${key}` };
    }
    result[key] = value;
  }
  return { env: Object.keys(result).length > 0 ? result : null };
}

export function configEffortSupported(config: AgentAccountConfig, effort: string): boolean {
  return !effort || config.supportedEfforts.some(value => value === effort);
}

export function configDraftChanged(
  config: AgentAccountConfig | undefined,
  documentId: string,
  content: string,
  effort: string,
  extra?: { defaultModel?: string; proxyUrl?: string; noProxy?: string; envText?: string },
): boolean {
  const document = config?.documents.find(item => item.id === documentId);
  if (!document) return false;
  if (content !== document.content || effort !== (config?.defaultEffort ?? "")) return true;
  if (!extra) return false;
  if ((extra.defaultModel ?? "").trim() !== (config?.defaultModel ?? "")) return true;
  if ((extra.proxyUrl ?? "").trim() !== (config?.proxyUrl ?? "")) return true;
  if ((extra.noProxy ?? "").trim() !== (config?.noProxy ?? "")) return true;
  if ((extra.envText ?? "").trim() !== formatEnvLines(config?.env).trim()) return true;
  return false;
}

export async function createManagedAccountFlow(
  input: { agent: "codex" | "claude"; name: string },
  existing: Set<string>,
  execute: (message: JsonObject) => Promise<JsonObject>,
): Promise<{ account?: JsonObject; sessionId?: string; login: "started" | "failed" | "cancelled" | "unavailable" }> {
  const result = await execute({ type: "agent.account.create", requestId: crypto.randomUUID(), ...input });
  if (result["ok"] === false) throw new Error("Unable to create account");
  const accounts = Array.isArray(result["accounts"]) ? result["accounts"].map(record) : [];
  const account = selectCreatedAccount(accounts, text(result["accountId"]), input.name, input.agent, existing);
  if (!account || existing.has(text(account["id"]))) return { login: "unavailable" };
  try {
    const login = await execute({ type: "agent.account.login", requestId: crypto.randomUUID(), accountId: text(account["id"]), cols: 120, rows: 40 });
    if (login["cancelled"] === true) return { account, login: "cancelled" };
    const sessionId = text(login["sessionId"]);
    if (login["ok"] === false || !sessionId) return { account, login: "failed" };
    return { account, sessionId, login: "started" };
  } catch {
    return { account, login: "failed" };
  }
}
