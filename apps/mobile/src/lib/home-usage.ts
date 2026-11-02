import type { UsageAccount } from "@prospero/protocol";

/** API profiles stay available in the account picker, but do not fill the host summary. */
export function homeUsageAccounts(accounts: readonly UsageAccount[]): UsageAccount[] {
  return accounts.filter((account) => account.source !== "api");
}
