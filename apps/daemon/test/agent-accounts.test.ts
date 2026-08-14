import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import {
  AgentAccountError,
  AgentAccountManager,
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
    sessions.flushPersistence();
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
      baseUrl: "https://openai-gateway.example.com/v1/",
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
      baseUrl: "https://anthropic-gateway.example.com/v1",
      model: "acme-claude",
    });
    expect(claude.environment).toMatchObject({
      ANTHROPIC_API_KEY: claudeKey,
      ANTHROPIC_BASE_URL: "https://anthropic-gateway.example.com/v1",
      CLAUDE_CODE_API_BASE_URL: "https://anthropic-gateway.example.com/v1",
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
});
