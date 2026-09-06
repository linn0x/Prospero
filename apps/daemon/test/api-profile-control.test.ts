import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentApiValidation } from "@prospero/protocol";
import { createDaemonServer, type DaemonServer, type DaemonServerOptions } from "../src/ws-server.js";

const fixtures: Array<{ server: DaemonServer; home: string }> = [];
afterEach(async () => {
  for (const { server, home } of fixtures.splice(0)) {
    await server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

function passed(): AgentApiValidation {
  return { status: "passed", checkedAt: Date.now(), engine: "opencode",
    checks: { runtime: "passed", streaming: "passed", tools: "passed" },
    detail: "CLI 和 API 协议测试通过；未验证完整 Agent 执行。", latencyMs: 10 };
}

async function setup(probe: NonNullable<DaemonServerOptions["apiProfileProbe"]>) {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-profile-control-"));
  const server = await createDaemonServer({
    home, port: 0, bindAddr: "127.0.0.1", workspaceRoot: home,
    useTmux: false, structuredSupervisor: false, ptySupervisor: false, windowsSessionHost: false,
    accountRunner: async () => ({ stdout: "not logged in", stderr: "", exitCode: 0 }),
    apiProfileProbe: probe,
  });
  fixtures.push({ server, home });
  const status = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as { controlToken: string; capabilities: string[] };
  const request = async (body: Record<string, unknown>, authenticated = true) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/_prospero/control/accounts`, {
      method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${status.controlToken}` } : {}) },
      body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }),
    });
    return { response, text: await response.text() };
  };
  const created = await request({ type: "agent.account.api.create", agent: "codex", name: "Local fixture",
    protocol: "openai_chat_completions", baseUrl: "http://127.0.0.1:1/v1", model: "fixture", apiKey: "private-fixture-key",
    modelCapabilities: { contextWindow: 32000, maxOutputTokens: 4096 } });
  expect(created.response.status).toBe(200);
  const accountId = (JSON.parse(created.text) as { accountId: string }).accountId;
  return { server, request, accountId, status };
}

describe("API Profile control actions", () => {
  it("only tests on an authenticated explicit action and invalidates results after edits", async () => {
    let calls = 0;
    const { server, request, accountId, status } = await setup(async (binding) => {
      calls += 1;
      expect(binding.engine).toBe("opencode");
      expect(binding.apiProfile?.modelCapabilities).toEqual({ contextWindow: 32000, maxOutputTokens: 4096 });
      return passed();
    });
    expect(status.capabilities).toContain("agent.api-validation.v1");
    await request({ type: "agent.accounts.list" });
    expect(calls).toBe(0);
    expect((await request({ type: "agent.account.api.test", accountId }, false)).response.status).toBe(401);
    expect(calls).toBe(0);
    const result = await request({ type: "agent.account.api.test", accountId });
    expect(result.response.status).toBe(200);
    expect(result.text).not.toContain("private-fixture-key");
    const body = JSON.parse(result.text);
    expect(body).toMatchObject({ action: "api_test", ok: true, accountId, validation: { status: "passed" } });
    expect(body.accounts.find((account: { id: string }) => account.id === accountId)).toMatchObject({
      apiValidation: { checks: { runtime: "passed", streaming: "passed", tools: "passed" } },
    });
    expect(calls).toBe(1);
    const configured = await request({ type: "agent.account.api.configure", accountId, modelCapabilities: null });
    expect(configured.response.status).toBe(200);
    const account = (await server.accounts.snapshot([])).find((item) => item.id === accountId);
    expect(account?.apiProfile?.modelCapabilities).toBeUndefined();
    expect(account?.apiValidation).toBeUndefined();
    expect(calls).toBe(1);
    expect((await request({ type: "agent.account.api.test", accountId: "native-codex" })).response.status).toBe(403);
    expect(calls).toBe(1);
  });

  it("rejects overlapping tests and changes while a bounded probe is in progress", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: (result: AgentApiValidation) => void;
    const pending = new Promise<AgentApiValidation>((resolve) => { finish = resolve; });
    const { request, accountId } = await setup(async () => { entered(); return pending; });
    const first = request({ type: "agent.account.api.test", accountId });
    await started;
    try {
      const duplicate = await request({ type: "agent.account.api.test", accountId });
      expect(duplicate.response.status).toBe(409);
      expect(JSON.parse(duplicate.text)).toMatchObject({ ok: false, action: "api_test" });
      expect((await request({ type: "agent.account.api.configure", accountId, model: "changed" })).response.status).toBe(409);
    } finally { finish(passed()); }
    expect((await first).response.status).toBe(200);
  });
});
