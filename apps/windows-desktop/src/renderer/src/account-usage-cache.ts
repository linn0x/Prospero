import type { UsageAccount } from "../../shared/types";

const STORAGE_KEY = "prospero.accountUsage.v1";
const FRESH_FOR_MS = 60_000;

type CachedUsage = {
  accounts: UsageAccount[];
  savedAt: number;
};

function readStoredUsage(): CachedUsage | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<CachedUsage> | null;
    if (!value || !Array.isArray(value.accounts) || typeof value.savedAt !== "number") return undefined;
    const accounts = value.accounts.filter((account): account is UsageAccount => (
      account !== null
      && typeof account === "object"
      && typeof account.agent === "string"
      && Array.isArray(account.windows)
    ));
    return { accounts, savedAt: value.savedAt };
  } catch {
    return undefined;
  }
}

let cachedUsage = readStoredUsage();
let requestInFlight: Promise<UsageAccount[]> | undefined;

export function getCachedAccountUsage(): UsageAccount[] {
  return cachedUsage?.accounts ?? [];
}

export function loadAccountUsage(force = false): Promise<UsageAccount[]> {
  if (!force && cachedUsage && Date.now() - cachedUsage.savedAt < FRESH_FOR_MS) {
    return Promise.resolve(cachedUsage.accounts);
  }
  if (requestInFlight) return requestInFlight;

  requestInFlight = window.prospero.getUsage()
    .then((report) => {
      const accounts = report.accounts ?? [];
      cachedUsage = { accounts, savedAt: Date.now() };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedUsage));
      } catch {
        // The in-memory cache is still useful when storage is unavailable.
      }
      return accounts;
    })
    .finally(() => { requestInFlight = undefined; });
  return requestInFlight;
}

export function prefetchAccountUsage(): void {
  void loadAccountUsage().catch(() => {
    // The accounts page reports refresh failures when it is visible.
  });
}
