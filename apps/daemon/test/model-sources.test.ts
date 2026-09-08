import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSource, ModelSourceAction } from "@prospero/protocol";
import { AgentAccountManager, LocalFileCredentialStore } from "../src/agent-accounts.js";
import { ModelSources, type FrozenSourceBinding } from "../src/model-sources.js";
import { SessionManager } from "../src/session-manager.js";

const temporary: string[] = [];
function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "prospero-model-sources-"));
  temporary.push(home);
  const accounts = new AgentAccountManager(home, async () => ({ stdout: "", stderr: "", exitCode: 0 }), new LocalFileCredentialStore(null));
  return { home, accounts, act: (action: ModelSourceAction) => accounts.modelSourceAction(action) };
}
afterEach(() => { for (const home of temporary.splice(0)) rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function sourceWithRoutes(act: (action: ModelSourceAction) => ReturnType<AgentAccountManager["modelSourceAction"]>): Promise<ModelSource> {
  const created = (await act({ kind: "create", name: "Shared endpoint", endpoints: [{ protocol: "openai_responses", baseUrl: "https://models.invalid/v1" }], credential: { name: "Primary", apiKey: "synthetic-source-key-first" } })).sources![0]!;
  return (await act({ kind: "routes.set", sourceId: created.id, revision: created.revision, routes: ["model-a", "model-b"].map(model => ({ name: model, model, protocol: "openai_responses", credentialId: created.credentials[0]!.id, enabled: true })) })).sources![0]!;
}

describe("shared model sources", () => {
  it.each(["corrupt", "missing"])("isolates %s registry storage from independent profiles while source bindings fail closed", async damage => {
    const { home, accounts, act } = fixture();
    const independent = await accounts.createApi("codex", "Independent", { baseUrl: "https://independent.invalid/v1", model: "independent", apiKey: "synthetic-independent" });
    const legacy = await accounts.createApi("codex", "Legacy", { baseUrl: "https://legacy.invalid/v1", model: "legacy", apiKey: "synthetic-legacy" });
    const source = await sourceWithRoutes(act);
    const bound = await act({ kind: "bind", sourceId: source.id, routeId: source.routes[0]!.id, revision: source.revision });
    const preview = await act({ kind: "migration.preview" });
    const group = preview.migrations!.find(item => item.accounts.some(account => account.id === legacy.id))!;
    await act({ kind: "migration.apply", migrationId: group.id, name: "Migrated" });
    const registry = path.join(home, "model-sources", ".registry.json");
    if (damage === "corrupt") writeFileSync(registry, "synthetic-invalid-registry", { mode: 0o600 });
    else rmSync(registry);
    const restarted = new AgentAccountManager(home, async () => ({ stdout: "", stderr: "", exitCode: 0 }), new LocalFileCredentialStore(null));
    for (const manager of [accounts, restarted]) {
      expect(manager.resolveForSession(independent.id).environment.OPENAI_API_KEY).toBe("synthetic-independent");
      expect(() => manager.resolveForSession(bound.accountId!)).toThrow();
      expect(() => manager.resolveForSession(legacy.id)).toThrow();
    }
    await restarted.configureApi(independent.id, { model: "updated" });
    expect(restarted.resolve(independent.id).apiProfile?.model).toBe("updated");
    await restarted.setCredential(independent.id, "api_key", "synthetic-replaced");
    expect(restarted.resolve(independent.id).environment.OPENAI_API_KEY).toBe("synthetic-replaced");
    if (process.platform !== "win32") expect(statSync(path.join(home, "model-source-bindings.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(home, "model-source-bindings.json"), "utf8")).not.toContain("synthetic-");
  });

  it("backfills the binding index for existing migrations and removes membership on rollback", async () => {
    const { home, accounts, act } = fixture();
    const legacy = await accounts.createApi("codex", "Legacy", { baseUrl: "https://legacy.invalid/v1", model: "legacy", apiKey: "synthetic-legacy" });
    const original = readFileSync(path.join(home, "agent-accounts.json"), "utf8");
    const group = (await act({ kind: "migration.preview" })).migrations![0]!;
    await act({ kind: "migration.apply", migrationId: group.id, name: "Migrated" });
    expect(readFileSync(path.join(home, "agent-accounts.json"), "utf8")).toBe(original);
    rmSync(path.join(home, "model-source-bindings.json"));
    const restarted = new AgentAccountManager(home, async () => ({ stdout: "", stderr: "", exitCode: 0 }), new LocalFileCredentialStore(null));
    expect(restarted.resolve(legacy.id).modelSource?.legacy).toBe(true);
    expect(restarted.modelSources.isBound(legacy.id)).toBe(true);
    await restarted.modelSourceAction({ kind: "migration.rollback", accountIds: [legacy.id] });
    expect(restarted.modelSources.isBound(legacy.id)).toBe(false);
    writeFileSync(path.join(home, "model-sources", ".registry.json"), "invalid", { mode: 0o600 });
    expect(restarted.resolve(legacy.id).environment.OPENAI_API_KEY).toBe("synthetic-legacy");
  });

  it("does not publish a registry change when the binding index cannot be persisted", async () => {
    const { home, act } = fixture();
    const source = await sourceWithRoutes(act);
    const file = path.join(home, "model-sources", ".registry.json");
    const original = readFileSync(file, "utf8");
    const index = path.join(home, "model-source-bindings.json");
    rmSync(index); mkdirSync(index);
    await expect(act({ kind: "bind", sourceId: source.id, routeId: source.routes[0]!.id, revision: source.revision })).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("queries large binding snapshots without cloning source routes and rebuilds indexes after changes", () => {
    const { home } = fixture();
    const registry = new ModelSources(home, (protocol, baseUrl, model) => ({ protocol, baseUrl, model, provider: "openai_compatible" }));
    const source = registry.create({ kind: "create", name: "Large fixture", endpoints: [{ protocol: "openai_responses", baseUrl: "https://models.invalid/v1" }], credential: { name: "Key", apiKey: "synthetic-large-key" }, routes: Array.from({ length: 500 }, (_, index) => ({ name: `Model ${index}`, model: `model-${index}`, protocol: "openai_responses", enabled: true })) });
    const file = path.join(home, "model-sources", ".registry.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const bindings: FrozenSourceBinding[] = source.routes.map(route => ({ accountId: `account-${route.id}`, sourceId: source.id, routeId: route.id, revision: source.revision, sourceName: source.name, routeName: route.name, legacy: false, credentialId: route.credentialId, credentialRevision: 1, profile: { provider: "openai_compatible", protocol: route.protocol, baseUrl: source.endpoints[0]!.baseUrl, model: route.model } }));
    raw.bindings = bindings;
    writeFileSync(file, JSON.stringify(raw), { mode: 0o600 });
    registry.list();
    const clone = vi.spyOn(globalThis, "structuredClone");
    for (const binding of bindings) {
      expect(registry.publicBinding(binding.accountId)?.current).toBe(true);
      expect(registry.allowsNewSessions(binding)).toBe(true);
    }
    expect(clone).not.toHaveBeenCalled();
    clone.mockRestore();
    const external = new ModelSources(home, (protocol, baseUrl, model) => ({ protocol, baseUrl, model, provider: "openai_compatible" }));
    external.change({ kind: "update", sourceId: source.id, revision: source.revision, enabled: false }, new Set());
    expect(registry.publicBinding(bindings[0]!.accountId)?.current).toBe(false);
    expect(registry.allowsNewSessions(bindings[0]!)).toBe(false);
    const copy = registry.source(source.id); copy.routes.length = 0;
    expect(registry.source(source.id).routes).toHaveLength(500);
  });
  it("creates the source, credential and selected model parameters atomically and replays the entire setup", async () => {
    const { home, act, accounts } = fixture();
    const input = { kind: "create" as const, operationId: "onboarding", name: "Gateway", endpoints: [{ protocol: "openai_responses" as const, baseUrl: "https://models.invalid/v1" }], credential: { name: "Primary", apiKey: "synthetic-onboarding-key" }, routes: [
      { name: "Default", model: "model-a", protocol: "openai_responses" as const, enabled: true, modelCapabilities: { contextWindow: 128000, maxOutputTokens: 16000, tools: true, supportedEfforts: ["high" as const] }, defaultEffort: "high" as const },
      { name: "Unknown", model: "model-b", protocol: "openai_responses" as const, enabled: true },
    ] };
    await expect(act({ ...input, routes: [...input.routes, { name: "Invalid", model: "bad", protocol: "anthropic", enabled: true }] })).rejects.toThrow();
    expect((await act({ kind: "list" })).sources).toEqual([]);
    expect(existsSync(path.join(home, "model-sources", ".registry.json"))).toBe(false);
    const source = (await act(input)).sources![0]!;
    expect(source.routes).toHaveLength(2);
    expect(source.revision).toBe(1);
    expect(source.defaultRouteId).toBe(source.routes[0]!.id);
    expect(new Set(source.routes.map(route => route.credentialId))).toEqual(new Set([source.credentials[0]!.id]));
    expect((await act(input)).sources).toEqual([source]);
    await expect(act({ ...input, routes: input.routes.slice(0, 1) })).rejects.toMatchObject({ code: "conflict" });
    const bound = await act({ kind: "bind", sourceId: source.id, routeId: source.routes[0]!.id, revision: 1 });
    expect(accounts.resolve(bound.accountId!).apiProfile?.modelCapabilities).toEqual(input.routes[0]!.modelCapabilities);
    expect(accounts.resolve(bound.accountId!).defaultEffort).toBe("high");
    expect(source.routes[1]).not.toHaveProperty("modelCapabilities");
  });
  it("replays the same creation after a lost response without duplicating the source", async () => {
    const { home, act } = fixture();
    const input = { kind: "create" as const, operationId: "source-create-operation", name: "Retry safe", endpoints: [{ protocol: "openai_responses" as const, baseUrl: "https://models.invalid/v1" }], credential: { name: "Shared", apiKey: "synthetic-operation-key" } };
    const first = (await act(input)).sources![0]!;
    const restarted = new AgentAccountManager(home, async () => ({ stdout: "", stderr: "", exitCode: 0 }), new LocalFileCredentialStore(null));
    expect((await restarted.modelSourceAction(input)).sources).toEqual([first]);
    await expect(restarted.modelSourceAction({ ...input, name: "Changed" })).rejects.toMatchObject({ code: "conflict" });
    expect(JSON.stringify(await restarted.modelSourceAction({ kind: "list" }))).not.toContain("fingerprint");
  });
  it("stores credentials privately and binds multiple models without per-account credential copies", async () => {
    const { home, accounts, act } = fixture();
    const source = await sourceWithRoutes(act);
    const ids: string[] = [];
    for (const route of source.routes) {
      const result = await act({ kind: "bind", sourceId: source.id, routeId: route.id, revision: source.revision });
      ids.push(result.accountId!);
      const binding = accounts.resolve(result.accountId!);
      expect(binding.apiProfile?.model).toBe(route.model);
      expect(binding.environment.OPENAI_API_KEY).toBe("synthetic-source-key-first");
      expect(existsSync(path.join(home, "agent-accounts", "codex", result.accountId!, ".prospero-credential.json"))).toBe(false);
      expect((await act({ kind: "bind", sourceId: source.id, routeId: route.id, revision: source.revision })).accountId).toBe(result.accountId);
    }
    expect(new Set(ids).size).toBe(2);
    expect(JSON.stringify(await act({ kind: "list" }))).not.toContain("synthetic-source-key-first");
    expect(readFileSync(path.join(home, "agent-accounts.json"), "utf8")).not.toContain("synthetic-source-key-first");
    if (process.platform !== "win32") {
      expect(statSync(path.join(home, "model-sources")).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(home, "model-sources", ".registry.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("pins old connections and credentials while new sessions use the latest source revision", async () => {
    const { home, accounts, act } = fixture();
    let source = await sourceWithRoutes(act);
    const routeId = source.routes[0]!.id;
    const oldId = (await act({ kind: "bind", sourceId: source.id, routeId, revision: source.revision })).accountId!;
    source = (await act({ kind: "credential.set", sourceId: source.id, revision: source.revision, credentialId: source.credentials[0]!.id, name: "Rotated", apiKey: "synthetic-source-key-second" })).sources![0]!;
    source = (await act({ kind: "update", sourceId: source.id, revision: source.revision, endpoints: [{ protocol: "openai_responses", baseUrl: "https://changed.invalid/v1" }] })).sources![0]!;
    const newId = (await act({ kind: "bind", sourceId: source.id, routeId, revision: source.revision })).accountId!;
    expect(newId).not.toBe(oldId);
    const restarted = new AgentAccountManager(home, async () => ({ stdout: "", stderr: "", exitCode: 0 }), new LocalFileCredentialStore(null));
    expect(restarted.resolve(oldId).apiProfile?.baseUrl).toBe("https://models.invalid/v1");
    expect(restarted.resolve(oldId).environment.OPENAI_API_KEY).toBe("synthetic-source-key-first");
    expect(restarted.resolve(oldId).modelSource?.current).toBe(false);
    expect(restarted.resolve(newId).apiProfile?.baseUrl).toBe("https://changed.invalid/v1");
    expect(restarted.resolve(newId).environment.OPENAI_API_KEY).toBe("synthetic-source-key-second");
    await expect(accounts.configureApi(oldId, { apiKey: "synthetic-independent" })).rejects.toThrow("模型源");
    await expect(accounts.setCredential(oldId, "api_key", "synthetic-independent")).rejects.toThrow("模型源");
    await expect(accounts.logout(oldId)).rejects.toThrow("模型源");
  });

  it("rejects stale revisions and unsafe connection changes without altering existing data", async () => {
    const { act } = fixture();
    const source = await sourceWithRoutes(act);
    await expect(act({ kind: "update", sourceId: source.id, revision: 1, name: "stale" })).rejects.toMatchObject({ code: "conflict" });
    await expect(act({ kind: "update", sourceId: source.id, revision: source.revision, endpoints: [{ protocol: "openai_responses", baseUrl: "https://user:secret@evil.invalid/v1" }] })).rejects.toThrow();
    await expect(act({ kind: "credential.remove", sourceId: source.id, revision: source.revision, credentialId: source.credentials[0]!.id })).rejects.toMatchObject({ code: "busy" });
    expect((await act({ kind: "list" })).sources![0]!).toEqual(source);
  });

  it("disables new source launches without changing existing bindings and refuses referenced deletion", async () => {
    const { accounts, act } = fixture();
    let source = await sourceWithRoutes(act);
    const accountId = (await act({ kind: "bind", sourceId: source.id, routeId: source.routes[0]!.id, revision: source.revision })).accountId!;
    source = (await act({ kind: "update", sourceId: source.id, revision: source.revision, enabled: false })).sources![0]!;
    await expect(act({ kind: "bind", sourceId: source.id, routeId: source.routes[0]!.id, revision: source.revision })).rejects.toThrow("停用");
    expect(accounts.resolve(accountId).apiProfile?.model).toBe("model-a");
    await expect(act({ kind: "delete", sourceId: source.id, revision: source.revision })).rejects.toMatchObject({ code: "busy" });
  });

  it("also blocks new sessions through a pinned account after disabling the source without ending existing sessions", async () => {
    const { home, accounts, act } = fixture();
    const source = await sourceWithRoutes(act);
    const accountId = (await act({ kind: "bind", sourceId: source.id, routeId: source.routes[0]!.id, revision: source.revision })).accountId!;
    let starts = 0;
    const manager = new SessionManager({ persistPath: path.join(home, "sessions.json"), useTmux: false, structuredSupervisor: false, ptySupervisor: false, windowsSessionHost: false,
      accountResolver: (id, agent) => accounts.resolveForSession(id, agent),
      adapterFactory: () => ({ async start() { starts++; }, async send() {}, async respondPermission() {}, async interrupt() {}, async dispose() {} }),
    });
    try {
      const input = { agent: "codex" as const, kind: "structured" as const, accountId, cwd: home, cols: 80, rows: 24, allowShell: true };
      const running = await manager.create(input);
      await act({ kind: "update", sourceId: source.id, revision: source.revision, enabled: false });
      await expect(manager.create(input)).rejects.toThrow("停用新会话");
      expect(starts).toBe(1);
      expect(manager.getStructured(running.id)).toBeDefined();
      expect(manager.getStructured(running.id)?.info().status).not.toBe("died");
    } finally { await manager.disposeAll(); }
  });

  it("does not publish a usable account if account metadata persistence fails", async () => {
    const { home, act } = fixture();
    const source = await sourceWithRoutes(act);
    const broken = new AgentAccountManager(home, async () => ({ stdout: "", stderr: "", exitCode: 0 }), new LocalFileCredentialStore(null), { metadataWriter: () => { throw Error("synthetic write failure"); } });
    await expect(broken.modelSourceAction({ kind: "bind", sourceId: source.id, routeId: source.routes[0]!.id, revision: source.revision })).rejects.toThrow();
    expect(existsSync(path.join(home, "agent-accounts.json"))).toBe(false);
    expect(broken.modelSources.bindingAccounts(source.id)).toEqual([]);
  });

  it("requires explicit migration, deduplicates equal keys, and restores the original profiles unchanged", async () => {
    const { home, accounts, act } = fixture();
    const ids: string[] = [];
    for (const [model, apiKey] of [["model-a", "synthetic-shared"], ["model-b", "synthetic-shared"], ["model-c", "synthetic-other"]]) {
      ids.push((await accounts.createApi("codex", model!, { baseUrl: "https://same.invalid/v1/responses", model: model!, apiKey: apiKey! })).id);
    }
    const original = readFileSync(path.join(home, "agent-accounts.json"), "utf8");
    expect((await act({ kind: "list" })).sources).toEqual([]);
    const preview = await act({ kind: "migration.preview" });
    expect(preview.migrations).toHaveLength(1);
    expect(preview.migrations![0]!.credentialCount).toBe(2);
    expect(JSON.stringify(preview)).not.toContain("synthetic-shared");
    const source = (await act({ kind: "migration.apply", migrationId: preview.migrations![0]!.id, name: "Imported" })).sources![0]!;
    expect(source.credentials).toHaveLength(2);
    expect(source.routes).toHaveLength(3);
    expect(readFileSync(path.join(home, "agent-accounts.json"), "utf8")).toBe(original);
    for (const id of ids) expect(accounts.resolve(id).modelSource?.legacy).toBe(true);
    await act({ kind: "migration.rollback", accountIds: ids });
    expect(readFileSync(path.join(home, "agent-accounts.json"), "utf8")).toBe(original);
    for (const id of ids) expect(accounts.resolve(id).modelSource).toBeUndefined();
    expect(accounts.resolve(ids[2]!).environment.OPENAI_API_KEY).toBe("synthetic-other");
  });

  it("rejects migration when a key changes after preview", async () => {
    const { accounts, act } = fixture();
    const account = await accounts.createApi("codex", "Legacy", { baseUrl: "https://same.invalid/v1", model: "model-a", apiKey: "synthetic-original" });
    const migration = (await act({ kind: "migration.preview" })).migrations![0]!;
    await accounts.configureApi(account.id, { apiKey: "synthetic-edited" });
    await expect(act({ kind: "migration.apply", migrationId: migration.id, name: "Imported" })).rejects.toMatchObject({ code: "conflict" });
    expect((await act({ kind: "list" })).sources).toEqual([]);
  });

  it("merges a confirmed group into an existing source without merging distinct credentials", async () => {
    const { accounts, act } = fixture();
    const existing = await sourceWithRoutes(act);
    const shared = await accounts.createApi("codex", "Shared credential", { baseUrl: "https://models.invalid/v1", model: "import-a", apiKey: "synthetic-source-key-first" });
    await accounts.createApi("codex", "Different credential", { baseUrl: "https://models.invalid/v1", model: "import-b", apiKey: "synthetic-distinct" });
    const preview = (await act({ kind: "migration.preview" })).migrations![0]!;
    const result = await act({ kind: "migration.apply", migrationId: preview.id, name: existing.name, target: { sourceId: existing.id, revision: existing.revision } });
    expect(result.sources).toHaveLength(1);
    expect(result.sources![0]!.credentials).toHaveLength(2);
    expect(result.sources![0]!.routes).toHaveLength(4);
    expect(result.sources![0]!.revision).toBe(existing.revision + 1);
    expect(accounts.resolve(shared.id).environment.OPENAI_API_KEY).toBe("synthetic-source-key-first");
  });

  it("preserves declared default effort and rejects per-binding configuration edits", async () => {
    const { accounts, act } = fixture();
    let source = await sourceWithRoutes(act);
    source = (await act({ kind: "routes.set", sourceId: source.id, revision: source.revision, routes: [{ ...source.routes[0]!, modelCapabilities: { reasoning: true, supportedEfforts: ["low", "high"] }, defaultEffort: "high" }] })).sources![0]!;
    const accountId = (await act({ kind: "bind", sourceId: source.id, revision: source.revision, routeId: source.routes.find(route => route.model === "model-a")!.id })).accountId!;
    expect(accounts.resolve(accountId).defaultEffort).toBe("high");
    await expect(accounts.setConfig({ accountId, documentId: "codex-overrides", revision: "a".repeat(64), defaultEffort: "low" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps protocols separate at the same URL and rejects undeclared reasoning defaults", async () => {
    const { act } = fixture();
    const source = (await act({ kind: "create", name: "Multi protocol", endpoints: [{ protocol: "openai_responses", baseUrl: "https://same.invalid/v1" }, { protocol: "anthropic", baseUrl: "https://same.invalid/v1" }], credential: { name: "Key", apiKey: "synthetic-api-key" } })).sources![0]!;
    expect(source.endpoints.map(endpoint => endpoint.baseUrl)).toEqual(["https://same.invalid/v1", "https://same.invalid"]);
    await expect(act({ kind: "routes.set", sourceId: source.id, revision: source.revision, routes: [{ name: "A", model: "a", protocol: "openai_responses", credentialId: source.credentials[0]!.id, enabled: true, defaultEffort: "high" }] })).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("shares bounded model catalogs only for the same endpoint and credential revision", async () => {
    const { home } = fixture();
    let finish: ((models: Array<{ id: string }>) => void) | undefined;
    const fetchModels = vi.fn(() => new Promise<Array<{ id: string }>>(resolve => { finish = resolve; }));
    const registry = new ModelSources(home, (protocol, baseUrl, model) => ({ protocol, baseUrl, model, provider: protocol === "anthropic" ? "anthropic_compatible" : "openai_compatible" }), { fetchModels });
    let source = registry.create({ kind: "create", name: "Catalog", endpoints: [{ protocol: "openai_responses", baseUrl: "https://catalog.invalid/v1" }], credential: { name: "A", apiKey: "synthetic-catalog-key" } });
    const input = { kind: "models" as const, sourceId: source.id, revision: source.revision, protocol: "openai_responses" as const, credentialId: source.credentials[0]!.id };
    const first = registry.models(input), second = registry.models(input);
    expect(fetchModels).toHaveBeenCalledTimes(1);
    finish!([{ id: "one" }]);
    expect(await first).toEqual(await second);
    await registry.models(input);
    expect(fetchModels).toHaveBeenCalledTimes(1);
    registry.change({ kind: "credential.set", sourceId: source.id, revision: source.revision, credentialId: input.credentialId, name: "A", apiKey: "synthetic-replaced-key" }, new Set());
    source = registry.source(source.id);
    const rotated = registry.models({ ...input, revision: source.revision });
    expect(fetchModels).toHaveBeenCalledTimes(2);
    finish!([{ id: "two" }]);
    expect(await rotated).toEqual([{ id: "two" }]);
  });

  it("fails closed on corrupt storage without disclosing its contents", async () => {
    const { home, act } = fixture();
    await sourceWithRoutes(act);
    writeFileSync(path.join(home, "model-sources", ".registry.json"), "synthetic-private-fragment", { mode: 0o600 });
    await expect(act({ kind: "list" })).rejects.toThrow("原文件已保留");
    await act({ kind: "list" }).catch(error => expect(String(error)).not.toContain("synthetic-private-fragment"));
  });

  it.skipIf(process.platform === "win32")("rejects symlinked or publicly readable credential storage", async () => {
    const { home, act } = fixture();
    await sourceWithRoutes(act);
    const file = path.join(home, "model-sources", ".registry.json");
    chmodSync(file, 0o644);
    await expect(act({ kind: "list" })).rejects.toThrow("不安全");
    chmodSync(file, 0o600);
    const foreign = path.join(home, "foreign");
    writeFileSync(foreign, "untouched", { mode: 0o600 });
    rmSync(file); symlinkSync(foreign, file);
    await expect(act({ kind: "list" })).rejects.toThrow("不安全");
    expect(readFileSync(foreign, "utf8")).toBe("untouched");
  });
});
