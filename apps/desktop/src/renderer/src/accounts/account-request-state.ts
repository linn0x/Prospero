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

export function configEffortSupported(config: AgentAccountConfig, effort: string): boolean {
  return !effort || config.supportedEfforts.some(value => value === effort);
}

export function configDraftChanged(config: AgentAccountConfig | undefined, documentId: string, content: string, effort: string): boolean {
  const document = config?.documents.find(item => item.id === documentId);
  return Boolean(document && (content !== document.content || effort !== (config?.defaultEffort ?? "")));
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
