import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import {
  AgentAccountError,
  AgentAccountManager,
  LocalFileCredentialStore,
  type AccountCommandRunner,
  type AgentAccountCredential,
  type AgentAccountCredentialStore,
} from "../src/agent-accounts.js";
import type { AdapterContext, AgentAdapter } from "../src/adapters/types.js";
import { SessionManager } from "../src/session-manager.js";

const temps: string[] = [];

function tempHome(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "prospero-accounts-"));
  temps.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temps.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function signedInRunner(calls: Array<{ file: string; args: string[]; env: Record<string, string> }>): AccountCommandRunner {
  return async (file, args, env) => {
    calls.push({ file, args, env });
    if (file === "claude" && args[0] === "auth" && args[1] === "status") {
      return {
        stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (file === "codex" && args[0] === "login" && args[1] === "status") {
      return { stdout: "Logged in using ChatGPT", stderr: "", exitCode: 0 };
    }
    return { stdout: "Logged out", stderr: "", exitCode: 0 };
  };
}

class EnvAdapter implements AgentAdapter {
  constructor(private readonly contexts: AdapterContext[]) {}
  async start(context: AdapterContext): Promise<void> {
    this.contexts.push(context);
  }
  async send(): Promise<void> {}
  async respondPermission(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class MemoryCredentialStore implements AgentAccountCredentialStore {
  readonly values = new Map<string, AgentAccountCredential>();
  readonly deleted: string[] = [];

  read(accountId: string): AgentAccountCredential | null {
    return this.values.get(accountId) ?? null;
  }

  async write(
    accountId: string,
    _root: string,
    credential: AgentAccountCredential,
  ): Promise<void> {
    this.values.set(accountId, credential);
  }

  async delete(accountId: string): Promise<void> {
    this.values.delete(accountId);
    this.deleted.push(accountId);
  }
}

describe("Code Agent 账号隔离", () => {
  it("默认凭据存储使用账号私有文件并可在 daemon 重启后读取", async () => {
    const home = tempHome();
    const apiKey = "local-profile-api-key";
    const first = new AgentAccountManager(home, signedInRunner([]));
    const account = await first.createApi("codex", "本地 Profile", {
      baseUrl: "https://gateway.example.com/v1",
      model: "local-model",
      apiKey,
    });
    const root = account.environment["CODEX_HOME"]!;
    const credentialFile = path.join(root, ".prospero-credential.json");
    const markerFile = path.join(root, ".prospero-credential-local-v1");

    expect(readFileSync(credentialFile, "utf8")).toBe(JSON.stringify({
      kind: "api_key",
      secret: apiKey,
    }));
    expect(existsSync(markerFile)).toBe(true);
    expect(readFileSync(path.join(home, "agent-accounts.json"), "utf8")).not.toContain(apiKey);
    if (process.platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
      expect(statSync(markerFile).mode & 0o777).toBe(0o600);
    }

    const replacementKey = "replacement-local-profile-api-key";
    await first.configureApi(account.id, {
      baseUrl: "https://gateway.example.com/v1",
      model: "local-model",
      apiKey: replacementKey,
    });
    expect(readFileSync(credentialFile, "utf8")).toContain(replacementKey);

    const restarted = new AgentAccountManager(home, signedInRunner([]));
    expect(restarted.resolve(account.id, "codex").environment["OPENAI_API_KEY"])
      .toBe(replacementKey);
    await restarted.logout(account.id);
    expect(existsSync(credentialFile)).toBe(false);
    expect(existsSync(markerFile)).toBe(true);
  });

  it("旧 macOS Keychain 凭据只读迁移一次，删除后不会重新导入", async () => {
    const root = path.join(tempHome(), "agent-accounts", "claude", "legacy-account");
    const legacy = {
      kind: "api_key" as const,
      secret: "legacy-keychain-api-key",
    };
    let legacyReads = 0;
    const migrate = new LocalFileCredentialStore((accountId) => {
      legacyReads += 1;
      expect(accountId).toBe("legacy-account");
      return legacy;
    });

    expect(migrate.read("legacy-account", root)).toEqual(legacy);
    expect(legacyReads).toBe(1);
    expect(readFileSync(path.join(root, ".prospero-credential.json"), "utf8"))
      .toBe(JSON.stringify(legacy));

    const afterRestart = new LocalFileCredentialStore(() => {
      throw new Error("local file should win");
    });
    expect(afterRestart.read("legacy-account", root)).toEqual(legacy);
    await afterRestart.delete("legacy-account", root);

    const afterDelete = new LocalFileCredentialStore(() => {
      legacyReads += 1;
      return legacy;
    });
    expect(afterDelete.read("legacy-account", root)).toBeNull();
    expect(legacyReads).toBe(1);

    const retryRoot = path.join(tempHome(), "agent-accounts", "claude", "retry-account");
    let retryReads = 0;
    const unavailable = new LocalFileCredentialStore(() => {
      retryReads += 1;
      throw new Error("Keychain locked");
    });
    expect(unavailable.read("retry-account", retryRoot)).toBeNull();
    expect(existsSync(path.join(retryRoot, ".prospero-credential-local-v1"))).toBe(false);

    const retry = new LocalFileCredentialStore(() => {
      retryReads += 1;
      return legacy;
    });
    expect(retry.read("retry-account", retryRoot)).toEqual(legacy);
    expect(retryReads).toBe(2);
  });

  it("区分 Codex 未登录与状态命令异常", async () => {
    const signedOut = new AgentAccountManager(tempHome(), async () => ({
      stdout: "",
      stderr: "Not logged in",
      exitCode: 1,
    }));
    await expect(signedOut.snapshot([])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "native-codex", status: "signed_out" }),
      ]),
    );

    const failed = new AgentAccountManager(tempHome(), async (file) => ({
      stdout: "",
      stderr: file === "codex" ? "unexpected failure" : "",
      exitCode: 1,
    }));
    await expect(failed.snapshot([])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "native-codex",
          status: "error",
          detail: "Codex CLI 无法读取登录状态",
        }),
      ]),
    );
  });

  it("只保存元数据，并为 Codex/Claude 生成不同的官方配置目录", async () => {
    const home = tempHome();
    const calls: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
    const credentialStore = new MemoryCredentialStore();
    const manager = new AgentAccountManager(home, signedInRunner(calls), credentialStore);
    const codex = manager.create("codex", "工作 Codex");
    const claude = manager.create("claude", "个人 Claude");

    expect(codex.environment).toMatchObject({
      CODEX_HOME: path.join(home, "agent-accounts", "codex", codex.id),
      CODEX_SQLITE_HOME: path.join(home, "agent-accounts", "codex", codex.id),
    });
    expect(claude.environment).toMatchObject({
      CLAUDE_CONFIG_DIR: path.join(home, "agent-accounts", "claude", claude.id),
    });
    expect(codex.environment["OPENAI_API_KEY"]).toBe("");
    expect(claude.environment["ANTHROPIC_API_KEY"]).toBe("");
    expect(claude.environment["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(
      "prospero-managed-account-not-authenticated",
    );
    const codexRootStat = statSync(codex.environment["CODEX_HOME"]!);
    const storeStat = statSync(path.join(home, "agent-accounts.json"));
    expect(codexRootStat.isDirectory()).toBe(true);
    expect(storeStat.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(codexRootStat.mode & 0o777).toBe(0o700);
      expect(storeStat.mode & 0o777).toBe(0o600);
    }

    const disk = readFileSync(path.join(home, "agent-accounts.json"), "utf8");
    expect(disk).toContain("工作 Codex");
    expect(disk).not.toMatch(/token|apiKey|accessToken/i);

    const beforeCredential = await manager.snapshot([]);
    expect(beforeCredential).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: claude.id, status: "signed_out" }),
      ]),
    );

    const oauthToken = "sk-ant-oat01-test-account-token-that-is-long-enough";
    await manager.setCredential(claude.id, "oauth_token", oauthToken);
    const isolatedClaude = manager.resolve(claude.id, "claude");
    expect(isolatedClaude.environment["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(oauthToken);
    expect(isolatedClaude.credentialKind).toBe("oauth_token");
    expect(readFileSync(path.join(home, "agent-accounts.json"), "utf8")).not.toContain(oauthToken);

    const snapshot = await manager.snapshot([]);
    expect(snapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: codex.id, status: "signed_in", authMethod: "ChatGPT" }),
        expect.objectContaining({ id: claude.id, status: "signed_in", authMethod: "claude.ai" }),
        expect.objectContaining({ id: "native-codex", managed: false }),
        expect.objectContaining({ id: "native-claude", managed: false }),
      ]),
    );
    expect(calls.some((call) => call.env["CODEX_HOME"] === codex.environment["CODEX_HOME"])).toBe(true);
    expect(calls.some((call) => call.env["CLAUDE_CONFIG_DIR"] === claude.environment["CLAUDE_CONFIG_DIR"])).toBe(true);
  });

  it("原生 Codex 刷新登录副本，额度查询使用独立 SQLite runtime", () => {
    const home = tempHome();
    const sharedCodexHome = tempHome();
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const previousCodexHome = process.env["CODEX_HOME"];
    process.env["CODEX_HOME"] = sharedCodexHome;
    try {
      writeFileSync(sharedAuth, JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: "2026-08-20T10:00:00.000Z",
        tokens: { account_id: "first" },
      }));
      const manager = new AgentAccountManager(home, signedInRunner([]));
      const first = manager.resolve("native-codex", "codex");
      const isolatedAuth = path.join(first.environment["CODEX_HOME"]!, "auth.json");
      expect(JSON.parse(readFileSync(isolatedAuth, "utf8"))).toMatchObject({
        tokens: { account_id: "first" },
      });

      writeFileSync(sharedAuth, JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: "2026-08-21T10:00:00.000Z",
        tokens: { account_id: "refreshed" },
      }));
      writeFileSync(path.join(sharedCodexHome, "config.toml"), [
        "[mcp_servers.prospero]",
        "command = 'must-not-run-during-usage-read'",
      ].join("\n"));
      const refreshed = manager.resolve("native-codex", "codex");
      expect(JSON.parse(readFileSync(isolatedAuth, "utf8"))).toMatchObject({
        tokens: { account_id: "refreshed" },
      });

      const usageEnvironment = manager.usageEnvironment(refreshed);
      const usageRoot = path.join(home, "agent-accounts", "codex-usage", "native-codex");
      const usageHome = path.join(usageRoot, "home");
      const usageSqlite = path.join(usageRoot, "sqlite");
      expect(usageEnvironment["CODEX_HOME"]).toBe(usageHome);
      expect(usageEnvironment["CODEX_SQLITE_HOME"]).toBe(usageSqlite);
      expect(usageEnvironment["CODEX_SQLITE_HOME"]).not.toBe(
        refreshed.environment["CODEX_SQLITE_HOME"],
      );
      expect(JSON.parse(readFileSync(path.join(usageHome, "auth.json"), "utf8"))).toMatchObject({
        tokens: { account_id: "refreshed" },
      });
      expect(existsSync(path.join(usageHome, "config.toml"))).toBe(false);
    } finally {
      if (previousCodexHome === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = previousCodexHome;
    }
  });

  it("两个账号能在同一个项目 cwd 工作，但适配器环境彼此隔离", async () => {
    const home = tempHome();
    const accounts = new AgentAccountManager(home, signedInRunner([]));
    const first = accounts.create("codex", "A");
    const second = accounts.create("codex", "B");
    const contexts: AdapterContext[] = [];
    const sessions = new SessionManager({
      home,
      accountResolver: (accountId, agent) => accounts.resolve(accountId, agent),
      adapterFactory: () => new EnvAdapter(contexts),
    });

    const project = path.join(home, "shared-project");
    const left = await sessions.create({
      agent: "codex",
      accountId: first.id,
      kind: "structured",
      cwd: project,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    const right = await sessions.create({
      agent: "codex",
      accountId: second.id,
      kind: "structured",
      cwd: project,
      cols: 80,
      rows: 24,
      allowShell: false,
    });

    expect(left.cwd).toBe(project);
    expect(right.cwd).toBe(project);
    expect(left.accountId).toBe(first.id);
    expect(right.accountId).toBe(second.id);
    expect(contexts.map((context) => context.cwd)).toEqual([project, project]);
    expect(contexts[0]?.env["CODEX_HOME"]).not.toBe(contexts[1]?.env["CODEX_HOME"]);
    await sessions.flushPersistence();
    await sessions.disposeAll();

    const restoredContexts: AdapterContext[] = [];
    const restoredManager = new SessionManager({
      home,
      accountResolver: (accountId, agent) => accounts.resolve(accountId, agent),
      adapterFactory: () => new EnvAdapter(restoredContexts),
    });
    const restored = await restoredManager.restoreStructured();
    expect(restored.map((session) => session.accountId)).toEqual([first.id, second.id]);
    expect(restoredContexts.map((context) => context.env["CODEX_HOME"])).toEqual([
      first.environment["CODEX_HOME"],
      second.environment["CODEX_HOME"],
    ]);
    await restoredManager.disposeAll();
  });

  it("第三方 API Profile 为 Claude/Codex 注入独立端点、模型和凭据", async () => {
    const home = tempHome();
    const credentialStore = new MemoryCredentialStore();
    const accounts = new AgentAccountManager(home, signedInRunner([]), credentialStore);
    const codexKey = "codex-third-party-key";
    const claudeKey = "claude-third-party-key";
    const codex = await accounts.createApi("codex", "公司网关", {
      baseUrl: "https://openai-gateway.example.com/v1/responses",
      model: "acme-coder",
      apiKey: codexKey,
    });
    const claude = await accounts.createApi("claude", "Claude 网关", {
      baseUrl: "https://anthropic-gateway.example.com/v1",
      model: "acme-claude",
      apiKey: claudeKey,
    });

    expect(codex.apiProfile).toEqual({
      provider: "openai_compatible",
      protocol: "openai_responses",
      baseUrl: "https://openai-gateway.example.com/v1",
      model: "acme-coder",
    });
    expect(codex.environment).toMatchObject({
      OPENAI_API_KEY: codexKey,
      OPENAI_BASE_URL: "",
      CODEX_HOME: path.join(home, "agent-accounts", "codex", codex.id),
    });
    expect(codex.codexAppServerArgs).toEqual(expect.arrayContaining([
      'model_provider="prospero"',
      'model="acme-coder"',
      'model_providers.prospero.base_url="https://openai-gateway.example.com/v1"',
      'model_providers.prospero.wire_api="responses"',
    ]));
    expect(claude.apiProfile).toEqual({
      provider: "anthropic_compatible",
      protocol: "anthropic",
      baseUrl: "https://anthropic-gateway.example.com",
      model: "acme-claude",
    });
    expect(claude.environment).toMatchObject({
      ANTHROPIC_API_KEY: claudeKey,
      ANTHROPIC_BASE_URL: "https://anthropic-gateway.example.com",
      CLAUDE_CODE_API_BASE_URL: "",
      ANTHROPIC_MODEL: "acme-claude",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CONFIG_DIR: path.join(home, "agent-accounts", "claude", claude.id),
    });
    expect(codex.environment["CODEX_HOME"]).not.toBe(claude.environment["CLAUDE_CONFIG_DIR"]);

    const disk = readFileSync(path.join(home, "agent-accounts.json"), "utf8");
    expect(disk).toContain("openai-gateway.example.com");
    expect(disk).not.toContain(codexKey);
    expect(disk).not.toContain(claudeKey);

    await accounts.configureApi(codex.id, {
      baseUrl: "https://replacement.example.com/v1",
      model: "replacement-coder",
      apiKey: "replacement-key",
    });
    const configured = accounts.resolve(codex.id, "codex");
    expect(configured.environment["OPENAI_API_KEY"]).toBe("replacement-key");
    expect(configured.codexAppServerArgs).toEqual(expect.arrayContaining([
      'model="replacement-coder"',
      'model_providers.prospero.base_url="https://replacement.example.com/v1"',
    ]));

    const contexts: AdapterContext[] = [];
    const sessions = new SessionManager({
      home,
      accountResolver: (accountId, agent) => accounts.resolve(accountId, agent),
      adapterFactory: () => new EnvAdapter(contexts),
    });
    await sessions.create({
      agent: "codex",
      accountId: codex.id,
      kind: "structured",
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    expect(contexts[0]?.codexAppServerArgs).toEqual(configured.codexAppServerArgs);
    await sessions.disposeAll();

    await accounts.logout(codex.id);
    expect(accounts.resolve(codex.id, "codex").environment["OPENAI_API_KEY"]).toBe("");
  });

  it("Chat Completions Profile 使用隔离 OpenCode runtime 且空 key 更新保留凭据", async () => {
    const home = tempHome();
    const calls: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
    const credentialStore = new MemoryCredentialStore();
    const accounts = new AgentAccountManager(home, signedInRunner(calls), credentialStore);
    const apiKey = "chat-profile-secret";
    const profile = await accounts.createApi("codex", "Chat 网关", {
      provider: "openai_compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://chat.example.com/v1/chat/completions/",
      model: "chat-coder",
      apiKey,
    });

    expect(profile.apiProfile).toEqual({
      provider: "openai_compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://chat.example.com/v1",
      model: "chat-coder",
    });
    expect(profile.adapterAgent).toBe("opencode");
    expect(profile.codexAppServerArgs).toBeUndefined();
    expect(profile.environment).toMatchObject({
      OPENAI_API_KEY: apiKey,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    });
    expect(new Set([
      profile.environment["XDG_CONFIG_HOME"],
      profile.environment["XDG_DATA_HOME"],
      profile.environment["XDG_CACHE_HOME"],
      profile.environment["XDG_STATE_HOME"],
    ]).size).toBe(4);
    const config = readFileSync(profile.environment["PROSPERO_API_PROFILE_CONFIG"]!, "utf8");
    expect(config).not.toContain(apiKey);
    expect(JSON.parse(config)).toMatchObject({
      model: "prospero/chat-coder",
      provider: {
        prospero: {
          npm: "@ai-sdk/openai-compatible",
          env: ["OPENAI_API_KEY"],
          options: { baseURL: "https://chat.example.com/v1" },
          models: { "chat-coder": { name: "chat-coder", tool_call: true } },
        },
      },
    });
    const secondProfile = await accounts.createApi("codex", "Chat 网关副本", {
      provider: "openai_compatible",
      protocol: "openai_chat_completions",
      baseUrl: "https://chat.example.com/v1",
      model: "chat-coder",
      apiKey,
    });
    expect(secondProfile.environment["PROSPERO_API_PROFILE_CONFIG"])
      .not.toBe(profile.environment["PROSPERO_API_PROFILE_CONFIG"]);
    expect(secondProfile.environment["XDG_DATA_HOME"]).not.toBe(profile.environment["XDG_DATA_HOME"]);

    await accounts.configureApi(profile.id, {
      name: "Chat 网关 2",
      baseUrl: "https://chat-2.example.com/v1/chat/completions",
      model: "chat-coder-2",
      apiKey: "",
    });
    expect(credentialStore.values.get(profile.id)?.secret).toBe(apiKey);
    expect(accounts.resolve(profile.id, "codex")).toMatchObject({
      name: "Chat 网关 2",
      apiProfile: {
        protocol: "openai_chat_completions",
        baseUrl: "https://chat-2.example.com/v1",
        model: "chat-coder-2",
      },
    });
    await expect(accounts.configureApi(profile.id, {
      name: "",
      apiKey: "must-not-be-written",
    })).rejects.toMatchObject({ code: "account_invalid" });
    expect(credentialStore.values.get(profile.id)?.secret).toBe(apiKey);

    const selectedAdapters: string[] = [];
    const sessions = new SessionManager({
      home,
      accountResolver: (accountId, agent) => accounts.resolve(accountId, agent),
      adapterFactory: (agent) => {
        selectedAdapters.push(agent);
        return new EnvAdapter([]);
      },
    });
    await expect(sessions.launchModels("codex", profile.id)).resolves.toEqual({
      models: [{ id: "chat-coder-2", label: "chat-coder-2", supportedEfforts: [], isDefault: true }],
      currentModel: "chat-coder-2",
    });
    expect(selectedAdapters).toEqual([]);
    await expect(sessions.create({
      agent: "codex",
      accountId: profile.id,
      kind: "structured",
      resume: { id: "native-codex-thread" },
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: false,
    })).rejects.toThrow(/暂不支持接回/);
    expect(selectedAdapters).toEqual([]);
    await expect(sessions.create({
      agent: "codex",
      accountId: profile.id,
      kind: "structured",
      mode: "plan",
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: false,
    })).rejects.toThrow(/暂不支持 Plan/);
    await expect(sessions.create({
      agent: "codex",
      accountId: profile.id,
      kind: "structured",
      model: "another-model",
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: false,
    })).rejects.toThrow(/只能使用已配置的模型/);
    await sessions.create({
      agent: "codex",
      accountId: profile.id,
      kind: "structured",
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    expect(selectedAdapters).toEqual(["opencode"]);
    await expect(accounts.configureApi(profile.id, {
      protocol: "openai_responses",
    }, sessions.list())).rejects.toMatchObject({ code: "account_in_use" });
    await expect(accounts.configureApi(profile.id, {
      name: "运行中的 Chat",
      apiKey: "rotated-chat-key",
    }, sessions.list())).rejects.toMatchObject({ code: "account_in_use" });
    await expect(accounts.configureApi(profile.id, {
      name: "运行中的 Chat",
    }, sessions.list())).resolves.toBeUndefined();
    await expect(accounts.setCredential(
      profile.id,
      "api_key",
      "rotated-through-credential-action",
      sessions.list(),
    )).rejects.toMatchObject({ code: "account_in_use" });
    await expect(accounts.logout(profile.id, sessions.list()))
      .rejects.toMatchObject({ code: "account_in_use" });
    expect(credentialStore.values.get(profile.id)?.secret).toBe(apiKey);
    await sessions.disposeAll();
    await accounts.snapshot([]);
    expect(calls.some((call) => call.file === "opencode" && call.args[0] === "--version")).toBe(true);
  });

  it("旧 API Profile 推断协议并迁移 endpoint", () => {
    const home = tempHome();
    writeFileSync(path.join(home, "agent-accounts.json"), JSON.stringify({
      version: 1,
      accounts: [
        { id: "legacy-chat", agent: "codex", name: "旧 Chat", apiProfile: { baseUrl: "https://chat.example.com/v1/chat/completions", model: "chat" }, createdAt: 1, updatedAt: 1 },
        { id: "legacy-responses", agent: "codex", name: "旧 Responses", apiProfile: { provider: "openai_compatible", baseUrl: "https://responses.example.com/v1", model: "responses" }, createdAt: 1, updatedAt: 1 },
        { id: "legacy-anthropic", agent: "claude", name: "旧 Anthropic", apiProfile: { provider: "anthropic_compatible", baseUrl: "https://anthropic.example.com/v1/messages", model: "claude" }, createdAt: 1, updatedAt: 1 },
      ],
      defaults: {},
    }));

    const accounts = new AgentAccountManager(home, signedInRunner([]), new MemoryCredentialStore());
    expect(accounts.resolve("legacy-chat").apiProfile).toMatchObject({ protocol: "openai_chat_completions", baseUrl: "https://chat.example.com/v1" });
    expect(accounts.resolve("legacy-responses").apiProfile).toMatchObject({ protocol: "openai_responses", baseUrl: "https://responses.example.com/v1" });
    expect(accounts.resolve("legacy-anthropic").apiProfile).toMatchObject({ protocol: "anthropic", baseUrl: "https://anthropic.example.com" });
    accounts.rename("legacy-chat", "迁移后的 Chat");
    const persisted = JSON.parse(readFileSync(path.join(home, "agent-accounts.json"), "utf8")) as { accounts: unknown[] };
    expect(persisted.accounts[0]).toMatchObject({ name: "迁移后的 Chat", apiProfile: { protocol: "openai_chat_completions" } });
  });

  it("第三方 API Profile 拒绝会将密钥发送到非本机 HTTP 或 URL 查询参数的地址", async () => {
    const home = tempHome();
    const accounts = new AgentAccountManager(home, signedInRunner([]), new MemoryCredentialStore());
    await expect(accounts.createApi("codex", "不安全", {
      baseUrl: "http://gateway.example.com/v1",
      model: "test-model",
      apiKey: "key",
    })).rejects.toMatchObject({ code: "account_invalid" } satisfies Partial<AgentAccountError>);
    await expect(accounts.createApi("claude", "含查询", {
      baseUrl: "https://gateway.example.com/v1?token=do-not-store",
      model: "test-model",
      apiKey: "key",
    })).rejects.toMatchObject({ code: "account_invalid" } satisfies Partial<AgentAccountError>);
    await expect(accounts.createApi("codex", "协议错配", {
      provider: "anthropic_compatible",
      protocol: "anthropic",
      baseUrl: "https://gateway.example.com",
      model: "test-model",
      apiKey: "key",
    })).rejects.toMatchObject({ code: "account_invalid" } satisfies Partial<AgentAccountError>);
  });

  it("活动会话阻止删除，结束后才注销并移除隔离目录", async () => {
    const home = tempHome();
    const calls: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
    const credentialStore = new MemoryCredentialStore();
    const accounts = new AgentAccountManager(home, signedInRunner(calls), credentialStore);
    const account = accounts.create("claude", "临时账号");
    await accounts.setCredential(
      account.id,
      "api_key",
      "sk-ant-api03-test-account-key-that-is-long-enough",
    );
    const session = {
      id: "session-1",
      agent: "claude",
      accountId: account.id,
      accountName: account.name,
      kind: "structured",
      title: "test",
      cwd: home,
      status: "idle",
      createdAt: 1,
      cols: 80,
      rows: 24,
    } satisfies SessionInfo;

    await expect(accounts.delete(account.id, [session])).rejects.toMatchObject({
      code: "account_in_use",
    } satisfies Partial<AgentAccountError>);
    expect(statSync(account.environment["CLAUDE_CONFIG_DIR"]!).isDirectory()).toBe(true);

    await accounts.delete(account.id, [{ ...session, status: "done" }]);
    expect(() => statSync(account.environment["CLAUDE_CONFIG_DIR"]!)).toThrow();
    expect(credentialStore.deleted).toContain(account.id);
    expect(calls.some((call) => call.file === "claude" && call.args.join(" ") === "auth logout")).toBe(false);
  });

  it("删除账号后终态历史仍可在 daemon 重启时只读恢复", async () => {
    const home = tempHome();
    const accounts = new AgentAccountManager(home, signedInRunner([]), new MemoryCredentialStore());
    const account = await accounts.createApi("codex", "可删除 Profile", {
      baseUrl: "https://gateway.example.com/v1",
      model: "coder",
      apiKey: "profile-key",
    });
    const first = new SessionManager({
      home,
      accountResolver: (accountId, agent) => accounts.resolve(accountId, agent),
      adapterFactory: () => new EnvAdapter([]),
    });
    const session = await first.create({
      agent: "codex",
      accountId: account.id,
      kind: "structured",
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    await first.kill(session.id, { preserveHistory: true });
    await accounts.delete(account.id, first.list());
    await first.disposeAll();

    const starts: AdapterContext[] = [];
    const restarted = new SessionManager({
      home,
      accountResolver: (accountId, agent) => accounts.resolve(accountId, agent),
      adapterFactory: () => new EnvAdapter(starts),
    });
    expect(await restarted.restoreStructured()).toEqual([
      expect.objectContaining({ id: session.id, status: "done", accountId: account.id }),
    ]);
    expect(starts).toEqual([]);
    await restarted.disposeAll();
  });

  it.skipIf(process.platform === "win32")("账号会话启动期间拒绝破坏配置并在启动失败后释放 lease", async () => {
    const home = tempHome();
    const accounts = new AgentAccountManager(home, signedInRunner([]), new MemoryCredentialStore());
    const account = await accounts.createApi("codex", "启动中 Profile", {
      baseUrl: "https://gateway.example.com/v1",
      model: "coder",
      apiKey: "profile-key",
    });
    let entered!: () => void;
    let rejectLaunch!: (error: Error) => void;
    const launchEntered = new Promise<void>((resolve) => { entered = resolve; });
    const launch = new Promise<never>((_resolve, reject) => { rejectLaunch = reject; });
    const sessions = new SessionManager({
      home,
      accountResolver: (accountId, agent) => accounts.resolve(accountId, agent),
      supervisorLauncher: async () => {
        entered();
        return launch;
      },
    });
    const creating = sessions.create({
      agent: "codex",
      accountId: account.id,
      kind: "structured",
      cwd: home,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    await launchEntered;

    expect(sessions.list()).toEqual([]);
    expect(sessions.accountInUse(account.id)).toBe(true);
    await expect(accounts.configureApi(account.id, {
      baseUrl: "https://other.example.com/v1",
    }, sessions.list(), sessions.accountInUse(account.id))).rejects.toMatchObject({ code: "account_in_use" });
    await expect(accounts.setCredential(
      account.id,
      "api_key",
      "replacement-key",
      sessions.list(),
      sessions.accountInUse(account.id),
    )).rejects.toMatchObject({ code: "account_in_use" });
    await expect(accounts.logout(account.id, sessions.list(), sessions.accountInUse(account.id)))
      .rejects.toMatchObject({ code: "account_in_use" });
    await expect(accounts.delete(account.id, sessions.list(), sessions.accountInUse(account.id)))
      .rejects.toMatchObject({ code: "account_in_use" });

    rejectLaunch(new Error("launch failed"));
    await expect(creating).rejects.toThrow(/launch failed/);
    expect(sessions.accountInUse(account.id)).toBe(false);
    await expect(accounts.configureApi(account.id, {
      baseUrl: "https://other.example.com/v1",
    }, sessions.list(), sessions.accountInUse(account.id))).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("账号登录 PTY 启动期间持有相同 lease", async () => {
    const home = tempHome();
    const accounts = new AgentAccountManager(home, signedInRunner([]), new MemoryCredentialStore());
    const account = accounts.create("claude", "登录中账号");
    let entered!: () => void;
    let rejectLaunch!: (error: Error) => void;
    const launchEntered = new Promise<void>((resolve) => { entered = resolve; });
    const launch = new Promise<never>((_resolve, reject) => { rejectLaunch = reject; });
    const sessions = new SessionManager({
      home,
      ptySupervisorLauncher: async () => {
        entered();
        return launch;
      },
    });
    const creating = sessions.createAccountLogin({
      binding: account,
      command: { file: "claude", args: ["auth", "login"] },
    }, 80, 24);
    await launchEntered;

    expect(sessions.list()).toEqual([]);
    expect(sessions.accountInUse(account.id)).toBe(true);
    await expect(accounts.delete(account.id, sessions.list(), sessions.accountInUse(account.id)))
      .rejects.toMatchObject({ code: "account_in_use" });
    rejectLaunch(new Error("login launch failed"));
    await expect(creating).rejects.toThrow(/login launch failed/);
    expect(sessions.accountInUse(account.id)).toBe(false);
    await expect(accounts.delete(account.id, [], sessions.accountInUse(account.id))).resolves.toBeUndefined();
  });
});
