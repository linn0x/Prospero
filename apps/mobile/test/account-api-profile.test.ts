import { describe, expect, it } from "vitest";
import {
  accountApiProtocolDefaults,
  accountApiProfileRequiresStructured,
  accountApiProtocolForAgent,
  accountApiProtocolFromProfile,
  accountApiProtocolsForAgent,
  accountApiProviderForProtocol,
} from "../src/lib/account-api-profile";

describe("account API profiles", () => {
  it("keeps legacy daemon profiles on their agent defaults", () => {
    expect(accountApiProtocolFromProfile("codex", undefined)).toBe("openai_responses");
    expect(accountApiProtocolFromProfile("claude", undefined)).toBe("anthropic");
    expect(accountApiProtocolForAgent("codex")).toBe("openai_responses");
  });

  it("offers Chat Completions only when the daemon advertises protocol support", () => {
    expect(accountApiProtocolsForAgent("codex", false)).toEqual(["openai_responses"]);
    expect(accountApiProtocolsForAgent("codex", true)).toEqual([
      "openai_responses",
      "openai_chat_completions",
    ]);
    expect(accountApiProtocolsForAgent("claude", true)).toEqual(["anthropic"]);
  });

  it("uses endpoint-prefix defaults for each protocol", () => {
    expect(accountApiProtocolDefaults("openai_chat_completions").baseUrl).toBe(
      "https://api.openai.com/v1",
    );
    expect(accountApiProtocolDefaults("anthropic").baseUrl).toBe(
      "https://api.anthropic.com",
    );
  });

  it("maps each protocol to its explicit provider", () => {
    expect(accountApiProviderForProtocol("openai_responses")).toBe("openai_compatible");
    expect(accountApiProviderForProtocol("openai_chat_completions")).toBe("openai_compatible");
    expect(accountApiProviderForProtocol("anthropic")).toBe("anthropic_compatible");
  });

  it("keeps Chat Completions profiles on structured sessions", () => {
    expect(accountApiProfileRequiresStructured("codex", "openai_chat_completions")).toBe(true);
    expect(accountApiProfileRequiresStructured("codex", "openai_responses")).toBe(false);
    expect(accountApiProfileRequiresStructured("claude", "anthropic")).toBe(false);
  });
});
