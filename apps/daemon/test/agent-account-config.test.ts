import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAccountManager, LocalFileCredentialStore } from "../src/agent-accounts.js";
import { getAccountConfig, saveAccountConfig, type AccountConfigTarget } from "../src/agent-account-config.js";
import type { AgentModelCatalog } from "../src/adapters/types.js";
import { SessionManager } from "../src/session-manager.js";

const homes: string[] = [];
const faults = vi.hoisted(() => ({ target: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: (source: string, target: string) => {
    if (target === faults.target) { faults.target = undefined; throw new Error("private-storage-error"); }
    actual.renameSync(source, target);
  } };
});
afterEach(() => { faults.target = undefined; for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function setup(agent: "claude" | "codex" = "codex") {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-safe-config-"));
  homes.push(home);
  const rootsDir = path.join(home, "agent-accounts");
  mkdirSync(rootsDir);
  const target: AccountConfigTarget = { rootsDir, agent, accountId: "synthetic-account" };
  const catalog: AgentModelCatalog = { currentModel: "fixture-model", models: [{ id: "fixture-model", label: "Fixture", supportedEfforts: ["low", "high"], isDefault: true }] };
  const file = path.join(rootsDir, agent, target.accountId, `prospero-overrides.${agent === "codex" ? "toml" : "yaml"}`);
  const save = (content?: string, defaultEffort?: "low" | "high" | null) => {
    const current = getAccountConfig(target, 2, catalog);
    return saveAccountConfig(target, { documentId: current.documents[0]!.id, revision: current.documents[0]!.revision,
      ...(content !== undefined ? { content } : {}), ...(defaultEffort !== undefined ? { defaultEffort } : {}) }, 2, catalog);
  };
  return { home, target, catalog, file, save };
}

describe("account advanced configuration", () => {
  it.each(["codex", "claude"] as const)("declares and saves private %s overrides with an atomic backup and model-bound effort", (agent) => {
    const { target, catalog, file, save } = setup(agent);
    const original = getAccountConfig(target, 2, catalog);
    expect(original).toMatchObject({ appliesTo: "new_sessions", activeSessions: 2, supportedEfforts: ["low", "high"], documents: [{ generated: false, writable: true }] });
    expect(existsSync(file)).toBe(false);
    const first = save(undefined, "high");
    expect(first).toMatchObject({ defaultEffort: "high", defaultModel: "fixture-model" });
    const contents = readFileSync(file, "utf8");
    expect(first.documents[0]!.revision).not.toBe(original.documents[0]!.revision);
    const second = save(undefined, "low");
    expect(second.defaultEffort).toBe("low");
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(contents);
    expect(readdirSync(path.dirname(file))).toEqual(expect.arrayContaining([path.basename(file), `${path.basename(file)}.bak`]));
    expect(readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(`${file}.bak`).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    expect(save(undefined, null).defaultEffort).toBeUndefined();
  });

  it("rejects unlisted documents and traversal before touching a file", () => {
    const { target, catalog } = setup();
    const revision = getAccountConfig(target, 0).documents[0]!.revision;
    for (const documentId of ["../auth.json", "/tmp/arbitrary.toml", "auth", "claude-overrides"]) {
      expect(() => saveAccountConfig(target, { documentId, revision, content: "" }, 0, catalog)).toThrow(/不支持/);
    }
    expect(() => getAccountConfig({ ...target, accountId: "../../escape" }, 0)).toThrow(/ID/);
  });

  it.each([["codex", 'default_effort = ["high"'], ["claude", "default_effort: [high"]] as const)("reports safe syntax locations for %s without echoing input", (agent, content) => {
    const { save } = setup(agent);
    let error: unknown;
    try { save(content); } catch (value) { error = value; }
    expect(error).toMatchObject({ code: "syntax", line: expect.any(Number), column: expect.any(Number) });
    expect(JSON.stringify(error)).not.toContain(content);
  });

  it("strips credential/env fields from reads and rejects them on save", () => {
    const { target, catalog, file, save } = setup();
    save(undefined, "high");
    writeFileSync(file, 'default_effort = "high"\napi_key = "private-secret"\n[env]\nTOKEN = "other-secret"\n');
    const publicConfig = getAccountConfig(target, 0, catalog);
    expect(publicConfig.documents[0]!.content).toContain("high");
    expect(JSON.stringify(publicConfig)).not.toMatch(/private-secret|other-secret|api_key|TOKEN/);
    expect(() => save('api_key = "new-secret"')).toThrow(/不允许/);
  });

  it("detects external writes and does not overwrite them on a stale revision", () => {
    const { target, catalog, file, save } = setup();
    const first = save(undefined, "high");
    writeFileSync(file, 'default_effort = "low"\n');
    expect(() => saveAccountConfig(target, { documentId: first.documents[0]!.id, revision: first.documents[0]!.revision, defaultEffort: null }, 0, catalog)).toThrow(/其它操作/);
    expect(readFileSync(file, "utf8")).toContain("low");
  });

  it.skipIf(process.platform === "win32")("rejects parent, file and backup symlinks without following them", () => {
    const { target, catalog, file } = setup();
    const external = path.join(target.rootsDir, "external");
    mkdirSync(external);
    symlinkSync(external, path.join(target.rootsDir, "codex"));
    expect(() => getAccountConfig(target, 0, catalog)).toThrow(/符号链接/);
    rmSync(path.join(target.rootsDir, "codex"));
    mkdirSync(path.dirname(file), { recursive: true });
    const secret = path.join(external, "auth.json");
    writeFileSync(secret, "private-auth");
    symlinkSync(secret, file);
    expect(() => getAccountConfig(target, 0)).toThrow(/链接/);
    rmSync(file);
    symlinkSync(secret, `${file}.bak`);
    const initial = getAccountConfig(target, 0);
    expect(() => saveAccountConfig(target, { documentId: initial.documents[0]!.id, revision: initial.documents[0]!.revision, defaultEffort: "high" }, 0, catalog)).toThrow(/链接/);
    expect(readFileSync(secret, "utf8")).toBe("private-auth");
    expect(lstatSync(`${file}.bak`).isSymbolicLink()).toBe(true);
  });

  it("rolls back a failed final rename and retains a recoverable private backup", () => {
    const { file, save } = setup();
    save(undefined, "high");
    const previous = readFileSync(file, "utf8");
    faults.target = realpathSync(file);
    expect(() => save(undefined, "low")).toThrow(/原配置已保留/);
    expect(readFileSync(file, "utf8")).toBe(previous);
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(previous);
  });

  it("filters effort by the selected model and rejects unknown or disabled capabilities", () => {
    const { target, catalog, save } = setup();
    expect(() => save('default_effort = "max"')).toThrow(/尚未声明/);
    expect(() => save('default_model = "unknown-model"')).toThrow(/可用模型目录/);
    expect(getAccountConfig({ ...target, model: "external", declaredEfforts: ["low", "high", "made-up"] }, 0, catalog).supportedEfforts).toEqual(["low", "high"]);
    expect(getAccountConfig({ ...target, reasoningDisabled: true }, 0, catalog).supportedEfforts).toEqual([]);
    expect(getAccountConfig({ ...target, engine: "opencode" }, 0, catalog).supportedEfforts).toEqual([]);
  });

  it("persists API defaults across profile regeneration and keeps stored credentials out of catalog results", async () => {
    const { home } = setup();
    const manager = new AgentAccountManager(home, async () => ({ stdout: "", stderr: "", exitCode: 0 }), new LocalFileCredentialStore(null));
    const account = await manager.createApi("codex", "API", { baseUrl: "https://models.example/v1", model: "custom", apiKey: "saved-private-key", modelCapabilities: { supportedEfforts: ["low", "high"] } });
    const current = await manager.getConfig(account.id);
    await manager.setConfig({ accountId: account.id, documentId: current.documents[0]!.id, revision: current.documents[0]!.revision, defaultEffort: "high" });
    expect(manager.resolve(account.id)).toMatchObject({ defaultEffort: "high", defaultModel: "custom" });
    await manager.configureApi(account.id, { name: "renamed" });
    expect((await manager.getConfig(account.id)).defaultEffort).toBe("high");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"data":[{"id":"custom"}]}'));
    expect(await manager.apiModels({ accountId: account.id }, { fetch: fetcher })).toEqual([{ id: "custom" }]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer saved-private-key" });
    await expect(manager.apiModels({ accountId: account.id, baseUrl: "https://evil.example" }, { fetch: fetcher })).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const before = readFileSync(path.join(home, "agent-accounts.json"), "utf8");
    const draftFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"data":[{"id":"draft-model"}]}'));
    await manager.apiModels({ protocol: "anthropic", baseUrl: "https://draft.example", apiKey: "draft-private-key" }, { fetch: draftFetcher });
    expect(readFileSync(path.join(home, "agent-accounts.json"), "utf8")).toBe(before);
    expect(JSON.stringify(await manager.snapshot([]))).not.toMatch(/saved-private-key|draft-private-key/);
    expect((await new AgentAccountManager(home, undefined, new LocalFileCredentialStore(null)).getConfig(account.id)).defaultEffort).toBe("high");
  });

  it("applies saved API effort only to new sessions and preserves an existing session across daemon restore", async () => {
    const { home } = setup();
    const accounts = new AgentAccountManager(home, async () => ({ stdout: "", stderr: "", exitCode: 0 }), new LocalFileCredentialStore(null));
    const account = await accounts.createApi("codex", "API", { baseUrl: "https://models.example/v1", model: "custom", apiKey: "private-key", modelCapabilities: { supportedEfforts: ["low", "high"] } });
    const saveEffort = async (defaultEffort: "low" | "high") => {
      const config = await accounts.getConfig(account.id);
      await accounts.setConfig({ accountId: account.id, documentId: config.documents[0]!.id, revision: config.documents[0]!.revision, defaultEffort });
    };
    await saveEffort("high");
    const states: Array<Record<string, unknown> | undefined> = [];
    const createManager = () => new SessionManager({ home, accountResolver: (id, agent) => accounts.resolve(id, agent), adapterFactory: (_agent, state) => {
      states.push(state);
      return { start: async () => {}, send: async () => {}, respondPermission: async () => {}, interrupt: async () => {}, dispose: async () => {} };
    } });
    const first = createManager();
    const original = await first.create({ agent: "codex", accountId: account.id, kind: "structured", cwd: home, cols: 80, rows: 24, allowShell: false });
    expect(states[0]).toMatchObject({ model: "custom", effort: "high" });
    await saveEffort("low");
    expect(first.requireStructured(original.id).persistentState().adapterState["effort"]).toBe("high");
    await first.disposeAll();
    const restarted = createManager();
    try {
      await restarted.restoreStructured();
      expect(states[1]).toMatchObject({ model: "custom", effort: "high" });
      await restarted.create({ agent: "codex", accountId: account.id, kind: "structured", cwd: home, cols: 80, rows: 24, allowShell: false });
      expect(states[2]).toMatchObject({ model: "custom", effort: "low" });
    } finally { await restarted.disposeAll(); }
  });
});
