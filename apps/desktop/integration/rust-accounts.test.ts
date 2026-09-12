import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { StateStore } from "../src/main/state-store";

const binary = resolve("../../target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const fixtures: { directory: string; runtime: RustRuntime }[] = [];

// The status probe is argv-exact: any other invocation exits non-zero so a
// regression that mutates user CLI state fails this test. The answer body is
// delivered via an env var (the daemon probe inherits the environment).
const ACCOUNT_CLAUDE = `#!/usr/bin/env python3
import os, sys
if sys.argv[1:] != ["auth", "status", "--json"]:
    sys.exit(3)
body = os.environ.get("PROSPERO_FAKE_STATUS", "")
if body:
    sys.stdout.write(body)
`;

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "rust-accounts-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  return { directory, runtime, store };
}

describe.skipIf(process.platform === "win32")("Native account discovery through the Rust bridge", () => {
  let previousBin: string | undefined;
  let previousStatus: string | undefined;

  afterEach(async () => {
    for (const { directory, runtime } of fixtures.splice(0)) {
      expect((await runtime.stop()).ok).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
    if (previousBin === undefined) delete process.env["PROSPERO_CLAUDE_BIN"];
    else process.env["PROSPERO_CLAUDE_BIN"] = previousBin;
    if (previousStatus === undefined) delete process.env["PROSPERO_FAKE_STATUS"];
    else process.env["PROSPERO_FAKE_STATUS"] = previousStatus;
  });

  async function setup(scenario: string) {
    const { directory, runtime, store } = fixture();
    const cli = resolve(directory, "fake-claude.py");
    writeFileSync(cli, ACCOUNT_CLAUDE);
    chmodSync(cli, 0o755);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    previousStatus = process.env["PROSPERO_FAKE_STATUS"];
    process.env["PROSPERO_CLAUDE_BIN"] = cli;
    process.env["PROSPERO_FAKE_STATUS"] = scenario;
    expect((await runtime.start()).ok).toBe(true);
    return { directory, runtime, store };
  }

  function list(runtime: RustRuntime) {
    return runtime.request("/_prospero/control/accounts", {
      method: "POST",
      body: { type: "agent.accounts.list", requestId: "bridge-1" },
    });
  }

  it("returns the native-claude account with a fresh signed_in probe", async () => {
    const { runtime } = await setup('{"loggedIn":true,"authMethod":"api-token","apiProvider":"anthropic"}');
    const result = await list(runtime);
    expect(result).toMatchObject({
      type: "agent.accounts.result",
      requestId: "bridge-1",
      action: "list",
      ok: true,
    });
    const accounts = result!["accounts"] as unknown[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "native-claude",
      agent: "claude",
      name: "本机默认",
      managed: false,
      isDefault: true,
      status: "signed_in",
      authMethod: "api-token",
      detail: "anthropic",
      capabilities: {
        sessionKinds: ["pty", "structured"],
        plan: true,
        resume: true,
        modelSelection: true,
        reasoningEffort: true,
      },
    });
  }, 30_000);

  it("maps a logged-out probe to signed_out", async () => {
    const { runtime } = await setup('{"loggedIn":false}');
    const result = await list(runtime);
    const accounts = result!["accounts"] as Record<string, unknown>[];
    expect(accounts[0]!["status"]).toBe("signed_out");
    expect(accounts[0]!["authMethod"]).toBeUndefined();
  }, 30_000);

  it("rejects every non-list account action", async () => {
    const { runtime } = await setup('{"loggedIn":true}');
    for (const type of [
      "agent.account.create",
      "agent.account.api.create",
      "agent.account.api.configure",
      "agent.account.api.test",
      "agent.account.rename",
      "agent.account.default",
      "agent.account.login",
      "agent.account.credential.set",
      "agent.account.logout",
      "agent.account.delete",
    ]) {
      await expect(runtime.request("/_prospero/control/accounts", {
        method: "POST",
        body: { type, requestId: "bridge-x", accountId: "native-claude" },
      })).rejects.toThrow(/尚未接入/);
    }
  }, 30_000);

  it("accepts the native account id when creating a structured session", async () => {
    const { directory, runtime } = await setup('{"loggedIn":true}');
    const created = await runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "structured", agent: "claude", cwd: directory, approvalPolicy: "standard", accountId: "native-claude" },
    });
    expect(created!["agent"]).toBe("claude");
    await expect(runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "structured", agent: "claude", cwd: directory, approvalPolicy: "standard", accountId: "managed-x" },
    })).rejects.toThrow(/此账号尚未接入/);
  }, 30_000);
});
