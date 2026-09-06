import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAccountManager, LocalFileCredentialStore } from "../src/agent-accounts.js";
import { getModelCapabilitySupport } from "../src/api-profile-capabilities.js";
import type { AgentApiProfile } from "@prospero/protocol";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
const { ClaudeAdapter } = await import("../src/adapters/claude.js");
const { SessionManager } = await import("../src/session-manager.js");
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function manager() {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-capability-fixture-"));
  homes.push(home);
  return { home, accounts: new AgentAccountManager(home, async () => ({ stdout: "1.0.0", stderr: "", exitCode: 0 }), new LocalFileCredentialStore(null)) };
}

describe("API profile model declarations in runtime configuration", () => {
  it("passes Codex context and reasoning overrides without inventing an output flag", async () => {
    const { accounts } = manager();
    const binding = await accounts.createApi("codex", "Fixture", { baseUrl: "http://127.0.0.1:1/v1", model: "fixture", apiKey: "fixture-key",
      modelCapabilities: { contextWindow: 32000, maxOutputTokens: 2048, vision: false, reasoning: false } });
    expect(binding.codexAppServerArgs).toContain("model_context_window=32000");
    expect(binding.codexAppServerArgs).toContain("model_supports_reasoning_summaries=false");
    expect(binding.codexAppServerArgs).toContain('model_reasoning_summary="none"');
    expect(binding.codexAppServerArgs?.join(" ")).not.toContain("model_max_output_tokens");
    expect(binding.environment["PROSPERO_API_PROFILE_VISION"]).toBe("0");
    const account = (await accounts.snapshot([])).find((item) => item.id === binding.id);
    expect(account?.modelCapabilitySupport).toEqual({ contextWindow: "enforced", maxOutputTokens: "unsupported", vision: "enforced", reasoning: "unsupported" });
  });

  it("applies Claude limits and disabled thinking to the SDK launch, then clears overrides", async () => {
    const { accounts } = manager();
    const binding = await accounts.createApi("claude", "Fixture", { baseUrl: "http://127.0.0.1:1", model: "gateway-model", apiKey: "fixture-key",
      modelCapabilities: { contextWindow: 32000, maxOutputTokens: 2048, vision: false, reasoning: false } });
    sdk.query.mockReturnValue({ [Symbol.asyncIterator]: async function* () {}, interrupt: async () => {} });
    const adapter = new ClaudeAdapter();
    await adapter.start({ cwd: os.tmpdir(), env: binding.environment, emit: () => {} });
    expect(sdk.query.mock.lastCall?.[0]).toMatchObject({ options: { thinking: { type: "disabled" }, env: {
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "32000", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2048", MAX_THINKING_TOKENS: "0",
    } } });
    expect(adapter.acceptsImages).toBe(false);
    await adapter.dispose();
    await accounts.configureApi(binding.id, { modelCapabilities: null }, []);
    expect(accounts.resolve(binding.id).environment).toMatchObject({
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "", MAX_THINKING_TOKENS: "", PROSPERO_API_PROFILE_VISION: "1",
    });
  });

  it("labels Claude family context and unsupported native image input conservatively", () => {
    const base: AgentApiProfile = { provider: "anthropic_compatible", protocol: "anthropic", baseUrl: "https://example.invalid", model: "claude-custom",
      modelCapabilities: { contextWindow: 32000, reasoning: true, vision: true } };
    expect(getModelCapabilitySupport(base)).toEqual({ contextWindow: "unsupported", reasoning: "unsupported", vision: "enforced" });
    expect(getModelCapabilitySupport({ ...base, provider: "openai_compatible", protocol: "openai_chat_completions" }))
      .toEqual({ contextWindow: "enforced", reasoning: "enforced", vision: "unsupported" });
  });

  it("rejects disabled image input at the manager boundary before an older owner can receive it", async () => {
    const { accounts, home } = manager();
    const account = await accounts.createApi("codex", "Fixture", { baseUrl: "http://127.0.0.1:1/v1", model: "fixture", apiKey: "fixture-key", modelCapabilities: { vision: false } });
    const send = vi.fn(async () => {});
    const sessions = new SessionManager({ home, accountResolver: (id, agent) => accounts.resolve(id, agent),
      adapterFactory: () => ({ start: async () => {}, send, respondPermission: async () => {}, interrupt: async () => {}, dispose: async () => {} }) });
    try {
      const session = await sessions.create({ agent: "codex", kind: "structured", accountId: account.id, cwd: home, cols: 80, rows: 24, allowShell: true });
      await expect(sessions.chatSend(session.id, "image", [{ mimeType: "image/png", dataB64: "aGVsbG8=" }])).rejects.toThrow("已关闭图片能力");
      expect(send).not.toHaveBeenCalled();
      await sessions.chatSend(session.id, "text");
      expect(send).toHaveBeenCalledOnce();
    } finally { await sessions.disposeAll(); }
  });
});
