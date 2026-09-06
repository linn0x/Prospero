import { describe, expect, it } from "vitest";
import {
  accountApiProtocolDefaults,
  accountApiStatus,
  accountApiEngineStatus,
  modelCapabilitySupportRows,
  modelTokenLimit,
  updateModelTokenLimit,
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


describe("API validation presentation and token limits", () => {
  it("keeps configured and validated states distinct", () => {
    expect(accountApiStatus({ status: "signed_in" })).toBe("已配置 · 未验证");
    expect(accountApiStatus({ status: "unavailable" })).toBe("运行环境不可用");
    expect(accountApiStatus({ status: "error", apiProfileError: "Invalid profile" })).toBe("配置需要修复");
  });

  it("preserves declared capabilities while allowing unknown token limits", () => {
    const metadata = { tools: false, vision: true, contextWindow: 1000 };
    expect(updateModelTokenLimit(metadata, "maxOutputTokens", "200"))
      .toEqual({ ...metadata, maxOutputTokens: 200 });
    expect(updateModelTokenLimit(metadata, "contextWindow", ""))
      .toEqual({ tools: false, vision: true });
    expect(modelTokenLimit(" ")).toBeUndefined();
    for (const raw of ["0", "-1", "1.5", "1e3", "9007199254740992"]) {
      expect(() => modelTokenLimit(raw)).toThrow();
    }
  });
});


describe("engine validation and model capability support", () => {
  it("keeps engine validation independent of protocol validation", () => {
    expect(accountApiEngineStatus({})).toBe("Agent 执行未验证");
    expect(accountApiEngineStatus({ apiEngineValidation: { status: "failed", checkedAt: 1, engine: "codex", checks: { runtime: "passed", configuration: "passed", streaming: "failed", tools: "not_tested" }, detail: "No stream" } })).toBe("Agent 执行验证失败");
  });

  it("does not call unsupported or unreported declarations enforced", () => {
    expect(modelCapabilitySupportRows({
      apiProfile: { provider: "openai_compatible", protocol: "openai_responses", baseUrl: "https://example.test/v1", model: "sample", modelCapabilities: { contextWindow: 1000, tools: true, vision: false } },
      modelCapabilitySupport: { contextWindow: "unsupported", tools: "enforced", reasoning: "enforced" },
    })).toEqual([
      { key: "contextWindow", label: "上下文窗口", detail: "已保存，当前引擎未应用" },
      { key: "tools", label: "工具调用", detail: "已接入本地配置" },
      { key: "vision", label: "图片输入", detail: "未报告生效情况" },
    ]);
  });
});
