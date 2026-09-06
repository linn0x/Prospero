import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentApiEngineValidation, AgentApiValidation } from "@prospero/protocol";
import { AgentAccountManager, LocalFileCredentialStore, type AgentAccountCredential, type AgentAccountCredentialStore, type AccountCommandRunner } from "../src/agent-accounts.js";

const homes: string[] = [];
const journalName = ".agent-accounts-transaction.json";
const faults = vi.hoisted(() => ({ journalPath: undefined as string | undefined, readPath: undefined as string | undefined, renamePath: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: unknown[]) => {
    if (faults.readPath && String(args[0]) === faults.readPath) throw Object.assign(new Error("private-storage-payload"), { code: "EACCES" });
    return Reflect.apply(actual.readFileSync, undefined, args);
  }, renameSync: (...args: unknown[]) => {
    if (faults.renamePath && String(args[1]) === faults.renamePath) throw new Error("private-rename-payload");
    return Reflect.apply(actual.renameSync, undefined, args);
  }, fsyncSync: (fd: number) => {
    if (faults.journalPath && actual.existsSync(faults.journalPath) && actual.fstatSync(fd).isDirectory()) {
      faults.journalPath = undefined;
      throw new Error("journal-private-payload must not be echoed");
    }
    actual.fsyncSync(fd);
  } };
});
function home(): string { const result = mkdtempSync(path.join(os.tmpdir(), "prospero-account-tx-")); homes.push(result); return result; }
afterEach(() => { faults.journalPath = undefined; faults.readPath = undefined; faults.renamePath = undefined; for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const runner: AccountCommandRunner = async (file, args) => ({ stdout: args[0] === "--version" ? `${file} 1.2.3` : file === "claude" ? '{"loggedIn":false}' : "Not logged in", stderr: "", exitCode: 0 });
class Credentials implements AgentAccountCredentialStore {
  readonly values = new Map<string, AgentAccountCredential>();
  onWrite?: (id: string, value: AgentAccountCredential) => Promise<void>;
  read(id: string): AgentAccountCredential | null { return this.values.get(id) ?? null; }
  async write(id: string, _root: string, value: AgentAccountCredential): Promise<void> { await this.onWrite?.(id, value); this.values.set(id, value); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
}
const profileInput = { baseUrl: "https://old.example/v1", model: "old-model", apiKey: "old-secret" };

describe("account transaction durability", () => {
  it("failed first credential migration never leaves a marker that hides the surviving legacy key after restart", () => {
    const root = path.join(home(), "account");
    const credential: AgentAccountCredential = { kind: "api_key", secret: "legacy-secret" };
    let reads = 0;
    const legacyReader = (): AgentAccountCredential => { reads += 1; return credential; };
    faults.renamePath = path.join(root, ".prospero-credential.json");
    expect(new LocalFileCredentialStore(legacyReader).readStrict("account", root)).toEqual(credential);
    expect(existsSync(path.join(root, ".prospero-credential-local-v1"))).toBe(false);
    faults.renamePath = undefined;
    expect(new LocalFileCredentialStore(legacyReader).readStrict("account", root)).toEqual(credential);
    expect(reads).toBe(2);
    expect(existsSync(path.join(root, ".prospero-credential-local-v1"))).toBe(true);
    expect(new LocalFileCredentialStore(null).readStrict("account", root)).toEqual(credential);
  });

  it("an unreadable old credential cannot be mistaken for absence or deleted by rollback", async () => {
    const directory = home();
    let metadataWrites = 0;
    const manager = new AgentAccountManager(directory, runner, new LocalFileCredentialStore(null), { metadataWriter: (file, contents) => {
      metadataWrites += 1;
      if (metadataWrites > 1) throw new Error("must not get as far as metadata write");
      writeFileSync(file, contents, { mode: 0o600 });
    } });
    const profile = await manager.createApi("codex", "Profile", profileInput);
    const keyFile = path.join(profile.environment["CODEX_HOME"]!, ".prospero-credential.json");
    const previous = readFileSync(keyFile, "utf8");
    faults.readPath = keyFile;
    await expect(manager.configureApi(profile.id, { model: "next", apiKey: "next-secret" })).rejects.toThrow(/^读取账号凭据失败$/);
    expect(metadataWrites).toBe(1);
    expect((await manager.snapshot([])).find((entry) => entry.id === profile.id)).toMatchObject({ status: "error", apiProfile: { model: "old-model" } });
    expect(existsSync(path.join(directory, journalName))).toBe(false);
    faults.readPath = undefined;
    expect(readFileSync(keyFile, "utf8")).toBe(previous);
  });

  it.each([
    "invalid-secret-json", "{}", '{"accounts":"broken"}', '{"accounts":[{}]}',
    '{"accounts":[],"defaults":{"codex":"missing-profile"}}',
    '{"accounts":[{"id":"native-codex","agent":"codex","name":"shadowed profile","createdAt":1,"updatedAt":1}]}',
    '{"accounts":[{"id":"id","agent":"codex","name":"bad timestamp","createdAt":1e400,"updatedAt":1}]}',
  ])("existing corrupt metadata blocks native fallback: %s", async (contents) => {
    const directory = home();
    writeFileSync(path.join(directory, "agent-accounts.json"), contents, { mode: 0o600 });
    const manager = new AgentAccountManager(directory, runner, new Credentials());
    await expect(manager.ready()).rejects.toThrow(/停止所有账号操作/);
    expect(() => manager.resolve("native-codex")).toThrow(/停止所有账号操作/);
    await expect(manager.snapshot([])).rejects.toThrow(/停止所有账号操作/);
    expect(readFileSync(path.join(directory, "agent-accounts.json"), "utf8")).toBe(contents);
  });

  it("metadata I/O failure blocks initialization without overwriting existing accounts", async () => {
    const directory = home();
    const storeFile = path.join(directory, "agent-accounts.json");
    const credentials = new Credentials();
    const original = new AgentAccountManager(directory, runner, credentials);
    await original.createApi("codex", "Profile", profileInput);
    const contents = readFileSync(storeFile, "utf8");
    faults.readPath = storeFile;
    const failed = new AgentAccountManager(directory, runner, credentials);
    await expect(failed.ready()).rejects.toThrow(/停止所有账号操作/);
    expect(() => failed.defaultId("codex")).toThrow(/停止所有账号操作/);
    faults.readPath = undefined;
    expect(readFileSync(storeFile, "utf8")).toBe(contents);
  });
  it.skipIf(process.platform === "win32")("journal rename followed by directory fsync failure cannot replay a failed new value", async () => {
    const directory = home();
    const credentials = new Credentials();
    const manager = new AgentAccountManager(directory, runner, credentials);
    const account = await manager.createApi("codex", "Profile", profileInput);
    faults.journalPath = path.join(directory, journalName);
    await expect(manager.configureApi(account.id, { model: "uncommitted", apiKey: "uncommitted-secret" })).rejects.toThrow(/原配置和凭据已保留/);
    expect(existsSync(path.join(directory, journalName))).toBe(false);
    const restarted = new AgentAccountManager(directory, runner, credentials);
    await restarted.ready();
    expect(restarted.resolve(account.id)).toMatchObject({ apiProfile: { model: "old-model" }, environment: { OPENAI_API_KEY: "old-secret" } });
  });
  it("metadata write-then-failure restores both configuration and key, including after restart", async () => {
    const directory = home();
    const credentials = new Credentials();
    let fail = false;
    const manager = new AgentAccountManager(directory, runner, credentials, { metadataWriter: (file, contents) => {
      writeFileSync(file, contents, { mode: 0o600 });
      if (fail) { fail = false; throw new Error("new-secret must never appear in errors"); }
    } });
    const account = await manager.createApi("codex", "Profile", profileInput);
    fail = true;
    await expect(manager.configureApi(account.id, { baseUrl: "https://new.example/v1", apiKey: "new-secret" })).rejects.toThrow("原配置和凭据已保留");
    expect(manager.resolve(account.id)).toMatchObject({ apiProfile: { baseUrl: profileInput.baseUrl }, environment: { OPENAI_API_KEY: "old-secret" } });
    expect(existsSync(path.join(directory, journalName))).toBe(false);
    const restarted = new AgentAccountManager(directory, runner, credentials);
    await restarted.ready();
    expect(restarted.resolve(account.id)).toMatchObject({ apiProfile: { baseUrl: profileInput.baseUrl }, environment: { OPENAI_API_KEY: "old-secret" } });
    expect(readFileSync(path.join(directory, "agent-accounts.json"), "utf8")).not.toMatch(/old-secret|new-secret/);
  });

  it("failed create, rename and default writes never publish an uncommitted in-memory store", async () => {
    const directory = home();
    const credentials = new Credentials();
    let failures = 0;
    const manager = new AgentAccountManager(directory, runner, credentials, { metadataWriter: (file, contents) => {
      if (failures-- > 0) throw new Error("metadata unavailable");
      writeFileSync(file, contents, { mode: 0o600 });
    } });
    const original = manager.create("codex", "original");
    failures = 1;
    expect(() => manager.create("codex", "failed native")).toThrow();
    failures = 1;
    expect(() => manager.rename(original.id, "failed rename")).toThrow();
    expect(manager.resolve(original.id).name).toBe("original");
    failures = 1;
    expect(() => manager.setDefault("native-codex")).toThrow();
    expect(manager.defaultId("codex")).toBe(original.id);
    failures = 1;
    await expect(manager.createApi("codex", "failed profile", profileInput)).rejects.toThrow();
    expect(credentials.values.size).toBe(0);
    expect((await manager.snapshot([])).filter((entry) => entry.managed).map((entry) => entry.name)).toEqual(["original"]);
    expect(existsSync(path.join(directory, journalName))).toBe(false);
  });

  it.each(["configure", "rename", "default", "create"])("metadata-only %s write-then-throw fails closed instead of mixing stale memory with the committed file", async (action) => {
    const directory = home();
    const credentials = new Credentials();
    let fail = false;
    const manager = new AgentAccountManager(directory, runner, credentials, { metadataWriter: (file, contents) => {
      writeFileSync(file, contents, { mode: 0o600 });
      if (fail) throw new Error("post-rename private-payload failure");
    } });
    const profile = await manager.createApi("codex", "original", profileInput);
    fail = true;
    const operation = async (): Promise<unknown> => action === "configure" ? manager.configureApi(profile.id, { model: "new-model" })
      : action === "rename" ? manager.rename(profile.id, "new-name")
        : action === "default" ? manager.setDefault("native-codex") : manager.create("codex", "new-account");
    await expect(operation()).rejects.toThrow(/保存结果不确定，已停止所有账号操作/);
    expect(() => manager.resolve("native-claude")).toThrow(/停止所有账号操作/);
    await expect(manager.snapshot([])).rejects.toThrow(/停止所有账号操作/);
    const restarted = new AgentAccountManager(directory, runner, credentials);
    await restarted.ready();
    expect(restarted.resolve(profile.id).environment["OPENAI_API_KEY"]).toBe("old-secret");
    if (action === "configure") expect(restarted.resolve(profile.id).apiProfile?.model).toBe("new-model");
    if (action === "rename") expect(restarted.resolve(profile.id).name).toBe("new-name");
    if (action === "default") expect(restarted.defaultId("codex")).toBe("native-codex");
    if (action === "create") expect((await restarted.snapshot([])).some((entry) => entry.name === "new-account")).toBe(true);
  });

  it.each(["before_key", "after_key", "after_metadata", "corrupt_metadata"])("replays a real durable journal after a crash at %s", async (phase) => {
    const source = home();
    const credentials = new Credentials();
    const manager = new AgentAccountManager(source, runner, credentials);
    const account = await manager.createApi("codex", "Profile", profileInput);
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    credentials.onWrite = async () => { entered(); await new Promise<void>(() => {}); };
    void manager.configureApi(account.id, { baseUrl: "https://next.example/v1", model: "next-model", apiKey: "next-secret" });
    await entry;
    const journal = readFileSync(path.join(source, journalName), "utf8");
    if (process.platform !== "win32") expect(statSync(path.join(source, journalName)).mode & 0o777).toBe(0o600);
    // Reproduce each independently persisted resource at process death, using the actual emitted WAL.
    const target = home();
    const raw = JSON.parse(journal);
    writeFileSync(path.join(target, journalName), journal, { mode: 0o600 });
    writeFileSync(path.join(target, "agent-accounts.json"), phase === "corrupt_metadata" ? "incomplete" : phase === "after_metadata" ? JSON.stringify(raw.metadata) : readFileSync(path.join(source, "agent-accounts.json"), "utf8"));
    const recoveredCredentials = new Credentials();
    recoveredCredentials.values.set(account.id, { kind: "api_key", secret: phase === "before_key" ? "old-secret" : "next-secret" });
    const recovered = new AgentAccountManager(target, runner, recoveredCredentials);
    expect(() => recovered.resolve(account.id)).toThrow(/正在恢复/);
    await recovered.ready();
    expect(recovered.resolve(account.id)).toMatchObject({ apiProfile: { baseUrl: "https://next.example/v1", model: "next-model" }, environment: { OPENAI_API_KEY: "next-secret" } });
    expect(existsSync(path.join(target, journalName))).toBe(false);
  });

  it("rollback failure blocks the whole manager and a fresh manager completes the rollback journal", async () => {
    const directory = home();
    const credentials = new Credentials();
    let fail = false;
    const manager = new AgentAccountManager(directory, runner, credentials, { metadataWriter: (file, contents) => {
      if (fail) throw new Error("storage unavailable with private payload");
      writeFileSync(file, contents, { mode: 0o600 });
    } });
    const account = await manager.createApi("codex", "Profile", profileInput);
    fail = true;
    await expect(manager.configureApi(account.id, { model: "next", apiKey: "next-secret" })).rejects.toThrow(/停止所有账号操作/);
    expect(() => manager.resolve("native-codex")).toThrow(/停止所有账号操作/);
    expect(() => manager.defaultId("claude")).toThrow(/停止所有账号操作/);
    await expect(manager.snapshot([])).rejects.toThrow(/停止所有账号操作/);
    await expect(manager.configureApi(account.id, { model: "retry" })).rejects.toThrow(/停止所有账号操作/);
    const restarted = new AgentAccountManager(directory, runner, credentials);
    await restarted.ready();
    expect(restarted.resolve(account.id)).toMatchObject({ apiProfile: { model: "old-model" }, environment: { OPENAI_API_KEY: "old-secret" } });
  });

  it.each(["invalid-json-secret", JSON.stringify({ version: 1, metadata: {}, credential: { accountId: "id", agent: "codex", value: null } })])("a corrupt journal fails closed and never echoes its payload", async (contents) => {
    const directory = home();
    writeFileSync(path.join(directory, journalName), contents, { mode: 0o600 });
    const manager = new AgentAccountManager(directory, runner, new Credentials());
    await expect(manager.ready()).rejects.toThrow(/^账号存储事务恢复失败/);
    expect(() => manager.resolve("native-claude")).toThrow(/停止所有账号操作/);
    expect(existsSync(path.join(directory, journalName))).toBe(true);
  });

  it("serializes concurrent changes while snapshots and revision capture retain the old complete version", async () => {
    const directory = home();
    const credentials = new Credentials();
    const manager = new AgentAccountManager(directory, runner, credentials);
    const account = await manager.createApi("codex", "Profile", profileInput);
    const revision = manager.captureApiValidationRevision(account.id);
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    credentials.onWrite = async (id, value) => { credentials.values.set(id, value); entered(); await gate; };
    const first = manager.configureApi(account.id, { baseUrl: "https://next.example/v1", apiKey: "next-secret" });
    await entry;
    const second = manager.configureApi(account.id, { model: "second-model" });
    expect(() => manager.resolveForSession(account.id, "codex")).toThrow(/正在保存/);
    expect(() => manager.resolveForSession("native-claude", "claude")).toThrow(/正在保存/);
    expect(manager.resolve(account.id)).toMatchObject({ apiProfile: { baseUrl: profileInput.baseUrl }, environment: { OPENAI_API_KEY: "old-secret" } });
    expect(manager.captureApiValidationRevision(account.id)).toBe(revision);
    const snapshot = (await manager.snapshot([])).find((entry) => entry.id === account.id);
    expect(snapshot?.apiProfile).toMatchObject({ baseUrl: profileInput.baseUrl, model: "old-model" });
    expect(() => manager.rename(account.id, "interleaving")).toThrow(/正在保存/);
    release();
    await Promise.all([first, second]);
    expect(manager.resolve(account.id)).toMatchObject({ apiProfile: { baseUrl: "https://next.example/v1", model: "second-model" }, environment: { OPENAI_API_KEY: "next-secret" } });
    expect(manager.captureApiValidationRevision(account.id)).not.toBe(revision);
    expect(manager.resolveForSession(account.id, "codex").apiProfile?.model).toBe("second-model");
  });

  it("rechecks live session leases after queued mutations begin", async () => {
    const directory = home();
    const credentials = new Credentials();
    const leased = new Set<string>();
    const manager = new AgentAccountManager(directory, runner, credentials, { accountInUse: (id) => leased.has(id) });
    const blocking = await manager.createApi("codex", "blocking", profileInput);
    const target = await manager.createApi("codex", "target", profileInput);
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    credentials.onWrite = async (id) => { if (id === blocking.id) { entered(); await gate; } };
    const first = manager.configureApi(blocking.id, { apiKey: "blocking-key" });
    await entry;
    const attempts = [
      manager.configureApi(target.id, { model: "racing-model", apiKey: "racing-key" }, [], false),
      manager.setCredential(target.id, "api_key", "racing-key", [], false),
      manager.logout(target.id, [], false),
      manager.delete(target.id, [], false),
    ].map((operation) => operation.catch((error: unknown) => error));
    leased.add(target.id);
    release();
    await first;
    for (const outcome of await Promise.all(attempts)) expect(outcome).toMatchObject({ code: "account_in_use" });
    expect(manager.resolve(target.id)).toMatchObject({ apiProfile: { model: "old-model" }, environment: { OPENAI_API_KEY: "old-secret" } });
  });
});

describe("CLI version cache and independent validation", () => {
  it("coalesces version checks across profiles and snapshots, expires by TTL and observes executable replacement", async () => {
    const directory = home();
    const credentials = new Credentials();
    let now = 0;
    let versions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const commands: AccountCommandRunner = async (file, args, env) => {
      if (args[0] === "--version") { versions += 1; await gate; }
      return runner(file, args, env);
    };
    const previousPath = process.env["PATH"];
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    const cli = path.join(bin, "codex");
    writeFileSync(cli, "first", { mode: 0o700 });
    process.env["PATH"] = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      const manager = new AgentAccountManager(directory, commands, credentials, { now: () => now, runtimeTtlMs: 100 });
      const first = await manager.createApi("codex", "first", profileInput);
      const second = await manager.createApi("codex", "second", profileInput);
      await manager.logout(second.id);
      const snapshots = [manager.snapshot([]), manager.snapshot([])];
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(versions).toBe(1);
      release();
      const [snapshot] = await Promise.all(snapshots);
      expect(snapshot?.find((entry) => entry.id === first.id)?.status).toBe("signed_in");
      expect(snapshot?.find((entry) => entry.id === second.id)?.status).toBe("signed_out");
      await manager.snapshot([]);
      expect(versions).toBe(1);
      now = 101;
      await manager.snapshot([]);
      expect(versions).toBe(2);
      writeFileSync(cli, "replacement-version", { mode: 0o700 });
      chmodSync(cli, 0o700);
      await manager.snapshot([]);
      expect(versions).toBe(3);
    } finally { if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath; }
  });

  it("negative CLI results expire quickly without becoming account authentication state", async () => {
    let now = 0;
    let versions = 0;
    const manager = new AgentAccountManager(home(), async (file, args, env) => {
      if (args[0] === "--version") return { stdout: "", stderr: "", exitCode: ++versions === 1 ? 1 : 0 };
      return runner(file, args, env);
    }, new Credentials(), { now: () => now, runtimeFailureTtlMs: 5 });
    const account = await manager.createApi("codex", "Profile", profileInput);
    expect((await manager.snapshot([])).find((entry) => entry.id === account.id)?.status).toBe("unavailable");
    await manager.snapshot([]);
    expect(versions).toBe(1);
    now = 6;
    expect((await manager.snapshot([])).find((entry) => entry.id === account.id)?.status).toBe("signed_in");
    expect(versions).toBe(2);
  });

  it("persists independent engine evidence and invalidates both kinds on key or profile changes", async () => {
    const directory = home();
    const credentials = new Credentials();
    const manager = new AgentAccountManager(directory, runner, credentials);
    const account = await manager.createApi("codex", "Profile", profileInput);
    const wire: AgentApiValidation = { status: "passed", checkedAt: 1, engine: "codex", checks: { runtime: "passed", streaming: "passed", tools: "passed" }, detail: "wire" };
    const engine: AgentApiEngineValidation = { status: "passed", checkedAt: 2, engine: "codex", cliVersion: "1.2.3", checks: { runtime: "passed", configuration: "passed", streaming: "passed", tools: "passed" }, detail: "engine" };
    const revision = manager.captureApiValidationRevision(account.id);
    expect(manager.recordApiValidation(account.id, revision, wire)).toBe(true);
    expect(manager.recordApiEngineValidation(account.id, revision, { ...engine, checks: { ...engine.checks, configuration: "not_tested" } })).toBe(false);
    expect(manager.recordApiEngineValidation(account.id, revision, engine)).toBe(true);
    const restarted = new AgentAccountManager(directory, runner, credentials);
    expect((await restarted.snapshot([])).find((entry) => entry.id === account.id)).toMatchObject({ apiValidation: wire, apiEngineValidation: engine });
    await restarted.configureApi(account.id, { model: "new" });
    const current = (await restarted.snapshot([])).find((entry) => entry.id === account.id);
    expect(current?.apiValidation).toBeUndefined();
    expect(current?.apiEngineValidation).toBeUndefined();
    expect(restarted.recordApiEngineValidation(account.id, revision, engine)).toBe(false);
    const updated = restarted.captureApiValidationRevision(account.id);
    expect(restarted.recordApiValidation(account.id, updated, wire)).toBe(true);
    expect(restarted.recordApiEngineValidation(account.id, updated, engine)).toBe(true);
    await restarted.logout(account.id);
    const loggedOut = (await restarted.snapshot([])).find((entry) => entry.id === account.id);
    expect(loggedOut?.apiValidation).toBeUndefined();
    expect(loggedOut?.apiEngineValidation).toBeUndefined();
  });
});
