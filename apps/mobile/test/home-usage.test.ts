import { describe, expect, it } from "vitest";
import type { UsageAccount } from "@prospero/protocol";
import { homeUsageAccounts } from "../src/lib/home-usage";

describe("host summary accounts", () => {
  it("hides API profiles while retaining subscriptions and legacy accounts", () => {
    const accounts: UsageAccount[] = [
      { agent: "claude", source: "api", accountId: "api-1", available: true, windows: [] },
      { agent: "codex", source: "subscription", accountId: "subscription-1", available: true, windows: [] },
      { agent: "claude", source: "unknown", available: false, windows: [] },
      { agent: "codex", available: false, windows: [] },
    ];
    expect(homeUsageAccounts(accounts)).toEqual(accounts.slice(1));
    expect(accounts).toHaveLength(4);
  });
});
