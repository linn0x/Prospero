import { describe, expect, it, vi } from "vitest";
import type { AgentAccountConfig, JsonObject } from "../src/shared/types";
import { AccountRequestGate, configDraftChanged, configEffortSupported, createManagedAccountFlow } from "../src/renderer/src/accounts/account-request-state";

describe("account request lifecycle", () => {
  it("allows a second effect setup after StrictMode cleanup and rejects the first result", () => {
    const gate = new AccountRequestGate();
    const first = gate.begin()!;
    gate.invalidate();
    const second = gate.begin()!;
    expect(second).toBeGreaterThan(first);
    expect(gate.current(first)).toBe(false);
    expect(gate.finish(first)).toBe(false);
    expect(gate.current(second)).toBe(true);
    expect(gate.begin()).toBeUndefined();
    expect(gate.finish(second)).toBe(true);
    expect(gate.begin()).toBeTypeOf("number");
  });

  it("does not apply a previous account's asynchronous result or unlock its replacement", async () => {
    const gate = new AccountRequestGate();
    const applied: string[] = [];
    let resolveOld: ((value: string) => void) | undefined;
    const old = gate.begin()!;
    const request = new Promise<string>(resolve => { resolveOld = resolve; }).then(value => {
      if (gate.current(old)) applied.push(value);
      gate.finish(old);
    });
    gate.invalidate();
    const replacement = gate.begin()!;
    resolveOld!("previous-account");
    await request;
    expect(applied).toEqual([]);
    expect(gate.current(replacement)).toBe(true);
    expect(gate.begin()).toBeUndefined();
  });

  it("deduplicates clicks, permits retries, and invalidates closing requests", () => {
    const gate = new AccountRequestGate();
    const request = gate.begin()!;
    expect(gate.begin()).toBeUndefined();
    gate.finish(request);
    const retry = gate.begin()!;
    expect(gate.current(retry)).toBe(true);
    gate.invalidate();
    expect(gate.current(retry)).toBe(false);
  });
});

describe("advanced account draft", () => {
  const config: AgentAccountConfig = {
    accountId: "account", documents: [{ id: "config", label: "Config", format: "toml", content: 'model = "example"', revision: "a".repeat(64), writable: true, generated: true, editableKeys: ["model"] }],
    defaultEffort: "xhigh", supportedEfforts: ["low", "medium", "high"], appliesTo: "new_sessions", activeSessions: 1,
  };

  it("keeps outdated effort values identifiable and supports clearing them", () => {
    expect(configEffortSupported(config, "xhigh")).toBe(false);
    expect(configEffortSupported(config, "")).toBe(true);
    expect(configEffortSupported(config, "high")).toBe(true);
    expect(configDraftChanged(config, "config", config.documents[0]!.content, "")).toBe(true);
  });

  it("detects document and effort edits without altering source content or revision", () => {
    const before = structuredClone(config);
    expect(configDraftChanged(config, "config", config.documents[0]!.content, "xhigh")).toBe(false);
    expect(configDraftChanged(config, "config", "draft", "xhigh")).toBe(true);
    expect(configDraftChanged(config, "config", config.documents[0]!.content, "high")).toBe(true);
    expect(configDraftChanged(undefined, "config", "draft", "high")).toBe(false);
    expect(configDraftChanged(config, "missing", "draft", "high")).toBe(false);
    expect(config).toEqual(before);
  });
});

describe("create and sign in", () => {
  const account = { id: "new-account", name: "Work", agent: "codex", managed: true };
  const input = { agent: "codex" as const, name: "Work" };

  it("reports a completed creation when login fails so the form does not recreate it", async () => {
    const execute = vi.fn<(message: JsonObject) => Promise<JsonObject>>()
      .mockResolvedValueOnce({ ok: true, accountId: account.id, accounts: [account] })
      .mockRejectedValueOnce(new Error("Login unavailable"));
    await expect(createManagedAccountFlow(input, new Set(), execute)).resolves.toEqual({ account, login: "failed" });
    expect(execute.mock.calls.map(call => call[0]["type"])).toEqual(["agent.account.create", "agent.account.login"]);
    expect(execute.mock.calls[1]![0]["accountId"]).toBe(account.id);
  });

  it("returns the session after a successful login", async () => {
    const execute = vi.fn<(message: JsonObject) => Promise<JsonObject>>()
      .mockResolvedValueOnce({ ok: true, accountId: account.id, accounts: [account] })
      .mockResolvedValueOnce({ ok: true, sessionId: "login-session" });
    await expect(createManagedAccountFlow(input, new Set(), execute)).resolves.toEqual({ account, sessionId: "login-session", login: "started" });
  });

  it("does not sign in an existing account when the created account is missing", async () => {
    const execute = vi.fn<(message: JsonObject) => Promise<JsonObject>>().mockResolvedValue({ ok: true, accounts: [account] });
    await expect(createManagedAccountFlow(input, new Set([account.id]), execute)).resolves.toEqual({ login: "unavailable" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([{ ok: false }, { ok: true }, { ok: false, cancelled: true }])("preserves creation when sign-in returns %j", async login => {
    const execute = vi.fn<(message: JsonObject) => Promise<JsonObject>>()
      .mockResolvedValueOnce({ ok: true, accountId: account.id, accounts: [account] })
      .mockResolvedValueOnce(login);
    const result = await createManagedAccountFlow(input, new Set(), execute);
    expect(result.account).toEqual(account);
    expect(result.login).toBe("cancelled" in login ? "cancelled" : "failed");
  });

  it("does not propagate service error content or start login after creation failed", async () => {
    const execute = vi.fn<(message: JsonObject) => Promise<JsonObject>>().mockResolvedValue({ ok: false, error: "sensitive upstream output" });
    await expect(createManagedAccountFlow(input, new Set(), execute)).rejects.toThrow("Unable to create account");
    expect(execute).toHaveBeenCalledOnce();
  });
});
