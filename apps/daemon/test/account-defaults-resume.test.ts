import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountBinding } from "../src/agent-accounts.js";
import { SessionManager } from "../src/session-manager.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("account defaults and native conversation resume", () => {
  it.each(["codex", "claude"] as const)("preserves the native %s conversation unless the user explicitly chooses a model", async (agent) => {
    const home = mkdtempSync(path.join(os.tmpdir(), "prospero-default-resume-"));
    homes.push(home);
    const account: AccountBinding = { id: "test-account", agent, name: "Test", managed: true, environment: {}, defaultModel: "new-account-default", defaultEffort: "high" };
    const states: Array<Record<string, unknown> | undefined> = [];
    const manager = new SessionManager({ home, accountResolver: () => account, adapterFactory: (_agent, state) => {
      states.push(state);
      return { start: async () => {}, send: async () => {}, respondPermission: async () => {}, interrupt: async () => {}, dispose: async () => {} };
    } });
    const input = { agent, accountId: account.id, kind: "structured" as const, cwd: home, cols: 80, rows: 24, allowShell: false };
    try {
      await manager.create({ ...input, resume: { id: "original-native-conversation" } });
      expect(states[0]).toEqual({ [agent === "codex" ? "threadId" : "sessionId"]: "original-native-conversation" });
      await manager.create({ ...input, resume: { id: "explicit-native-conversation" }, model: "explicit-model", effort: "low" });
      expect(states[1]).toMatchObject({ model: "explicit-model", effort: "low" });
      await manager.create(input);
      expect(states[2]).toMatchObject({ model: "new-account-default", effort: "high" });
    } finally { await manager.disposeAll(); }
  });

  it("retains a Profile's fixed model without injecting a new default effort into native resume", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "prospero-api-default-resume-"));
    homes.push(home);
    const account: AccountBinding = { id: "api-account", agent: "codex", name: "API", managed: true, environment: {}, defaultModel: "fixed-model", defaultEffort: "high", apiProfile: { provider: "openai_compatible", protocol: "openai_responses", baseUrl: "https://example.test/v1", model: "fixed-model" } };
    const states: Array<Record<string, unknown> | undefined> = [];
    const manager = new SessionManager({ home, accountResolver: () => account, adapterFactory: (_agent, state) => {
      states.push(state);
      return { start: async () => {}, send: async () => {}, respondPermission: async () => {}, interrupt: async () => {}, dispose: async () => {} };
    } });
    try {
      await manager.create({ agent: "codex", accountId: account.id, kind: "structured", cwd: home, cols: 80, rows: 24, allowShell: false, resume: { id: "native-api-thread" } });
      expect(states[0]).toMatchObject({ threadId: "native-api-thread", model: "fixed-model" });
      expect(states[0]).not.toHaveProperty("effort");
    } finally { await manager.disposeAll(); }
  });
});
