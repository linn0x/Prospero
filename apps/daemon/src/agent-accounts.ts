import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import type {
  AgentAccount,
  AgentAccountStatus,
  AgentCredentialKind,
  CodeAgentKind,
  SessionInfo,
} from "@prospero/protocol";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");
const CLAUDE_KEYCHAIN_SERVICE = "com.prospero.code-agent.claude";
const CLAUDE_CREDENTIAL_FILE = ".prospero-credential.json";
const MISSING_CLAUDE_CREDENTIAL = "prospero-managed-account-not-authenticated";
const NATIVE_IDS: Record<CodeAgentKind, string> = {
  codex: "native-codex",
  claude: "native-claude",
};

interface StoredAccount {
  id: string;
  agent: CodeAgentKind;
  name: string;
  createdAt: number;
  updatedAt: number;
}

interface AccountStore {
  version: 1;
  accounts: StoredAccount[];
  defaults: Partial<Record<CodeAgentKind, string>>;
}

export interface AccountBinding {
  id: string;
  agent: CodeAgentKind;
  name: string;
  managed: boolean;
  environment: Record<string, string>;
  /** Never contains the secret itself; only lets status/UI describe the configured source. */
  credentialKind?: AgentCredentialKind;
}

export interface AccountLoginSpec {
  binding: AccountBinding;
  command: { file: string; args: string[] };
}

export type AccountCommandRunner = (
  file: string,
  args: string[],
  environment: Record<string, string>,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface AgentAccountCredential {
  kind: AgentCredentialKind;
  secret: string;
}

/** Injectable so tests never touch the host Keychain. */
export interface AgentAccountCredentialStore {
  read(accountId: string, root: string): AgentAccountCredential | null;
  write(accountId: string, root: string, credential: AgentAccountCredential): Promise<void>;
  delete(accountId: string, root: string): Promise<void>;
}

export class AgentAccountError extends Error {
  constructor(
    message: string,
    readonly code:
      | "account_not_found"
      | "account_in_use"
      | "account_not_managed"
      | "account_invalid"
      | "agent_unavailable",
  ) {
    super(message);
    this.name = "AgentAccountError";
  }
}

function isCodeAgent(value: unknown): value is CodeAgentKind {
  return value === "codex" || value === "claude";
}

function parseStore(value: unknown): AccountStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, accounts: [], defaults: {} };
  }
  const raw = value as Record<string, unknown>;
  const accounts = Array.isArray(raw["accounts"])
    ? raw["accounts"].flatMap((entry): StoredAccount[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const account = entry as Record<string, unknown>;
        if (
          typeof account["id"] !== "string" ||
          account["id"].length === 0 ||
          account["id"].length > 100 ||
          !isCodeAgent(account["agent"]) ||
          typeof account["name"] !== "string" ||
          account["name"].trim().length === 0 ||
          typeof account["createdAt"] !== "number" ||
          typeof account["updatedAt"] !== "number"
        ) {
          return [];
        }
        return [{
          id: account["id"],
          agent: account["agent"],
          name: account["name"].trim().slice(0, 80),
          createdAt: Math.max(0, Math.round(account["createdAt"])),
          updatedAt: Math.max(0, Math.round(account["updatedAt"])),
        }];
      })
    : [];
  const rawDefaults =
    raw["defaults"] && typeof raw["defaults"] === "object" && !Array.isArray(raw["defaults"])
      ? (raw["defaults"] as Record<string, unknown>)
      : {};
  const defaults: Partial<Record<CodeAgentKind, string>> = {};
  for (const agent of ["claude", "codex"] as const) {
    const accountId = rawDefaults[agent];
    if (typeof accountId === "string" && accountId.length <= 100) defaults[agent] = accountId;
  }
  return { version: 1, accounts, defaults };
}

function activeCount(sessions: SessionInfo[], accountId: string): number {
  return sessions.filter(
    (session) =>
      session.accountId === accountId && session.status !== "done" && session.status !== "died",
  ).length;
}

function cleanName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 80) {
    throw new AgentAccountError("账号名称应为 1–80 个字符", "account_invalid");
  }
  return name;
}

function cleanCredential(
  kind: AgentCredentialKind,
  rawSecret: string,
): AgentAccountCredential {
  const secret = rawSecret.trim();
  if (secret.length < 20 || secret.length > 8192 || /[\r\n\0]/.test(secret)) {
    throw new AgentAccountError("凭据格式无效", "account_invalid");
  }
  return { kind, secret };
}

function parseCredential(raw: string): AgentAccountCredential | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      (value["kind"] !== "oauth_token" && value["kind"] !== "api_key") ||
      typeof value["secret"] !== "string"
    ) {
      return null;
    }
    return cleanCredential(value["kind"], value["secret"]);
  } catch {
    return null;
  }
}

function childEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * On macOS the secret lives in a Prospero-specific Keychain item. `security -w` is
 * intentionally fed through a private PTY so the secret is never placed in argv.
 * Other daemon platforms use a mode-0600 file inside that account's mode-0700 root.
 */
class SystemCredentialStore implements AgentAccountCredentialStore {
  read(accountId: string, root: string): AgentAccountCredential | null {
    if (process.platform === "darwin") {
      try {
        const raw = execFileSync(
          "/usr/bin/security",
          [
            "find-generic-password",
            "-a",
            accountId,
            "-s",
            CLAUDE_KEYCHAIN_SERVICE,
            "-w",
          ],
          {
            encoding: "utf8",
            timeout: 8_000,
            maxBuffer: 16 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        return parseCredential(raw.trim());
      } catch {
        return null;
      }
    }

    try {
      return parseCredential(readFileSync(path.join(root, CLAUDE_CREDENTIAL_FILE), "utf8"));
    } catch {
      return null;
    }
  }

  async write(
    accountId: string,
    root: string,
    credential: AgentAccountCredential,
  ): Promise<void> {
    const payload = JSON.stringify(credential);
    if (process.platform === "darwin") {
      await this.writeKeychain(accountId, payload);
      return;
    }

    mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, CLAUDE_CREDENTIAL_FILE);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, payload, { mode: 0o600 });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  }

  async delete(accountId: string, root: string): Promise<void> {
    if (process.platform === "darwin") {
      if (this.read(accountId, root) === null) return;
      try {
        execFileSync(
          "/usr/bin/security",
          ["delete-generic-password", "-a", accountId, "-s", CLAUDE_KEYCHAIN_SERVICE],
          { timeout: 8_000, stdio: "ignore" },
        );
      } catch (error) {
        throw new AgentAccountError(
          `无法从 macOS Keychain 删除 Claude 凭据: ${error instanceof Error ? error.message : String(error)}`,
          "agent_unavailable",
        );
      }
      return;
    }

    try {
      unlinkSync(path.join(root, CLAUDE_CREDENTIAL_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private writeKeychain(accountId: string, payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: import("node-pty").IPty;
      try {
        child = pty.spawn(
          "/usr/bin/security",
          [
            "add-generic-password",
            "-U",
            "-a",
            accountId,
            "-s",
            CLAUDE_KEYCHAIN_SERVICE,
            "-l",
            "Prospero Claude Code account",
            "-T",
            "/usr/bin/security",
            "-w",
          ],
          {
            name: "xterm-256color",
            cols: 80,
            rows: 24,
            cwd: os.homedir(),
            env: childEnvironment(),
          },
        );
      } catch (error) {
        reject(
          new AgentAccountError(
            `无法打开 macOS Keychain: ${error instanceof Error ? error.message : String(error)}`,
            "agent_unavailable",
          ),
        );
        return;
      }

      let supplied = false;
      let settled = false;
      let output = "";
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new AgentAccountError("写入 macOS Keychain 超时", "agent_unavailable"));
      }, 30_000);

      child.onData((chunk) => {
        // Never retain more than the prompt itself, and never append `payload`.
        output = `${output}${chunk}`.slice(-2048);
        if (!supplied && /password data|password.*item|密码/i.test(output)) {
          supplied = true;
          child.write(`${payload}\r`);
        }
      });
      child.onExit(({ exitCode }) => {
        if (exitCode === 0 && supplied) {
          finish();
          return;
        }
        finish(new AgentAccountError("无法把 Claude 凭据写入 macOS Keychain", "agent_unavailable"));
      });
    });
  }
}

async function defaultRunner(
  file: string,
  args: string[],
  environment: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFile(file, args, {
      env: { ...process.env, ...environment },
      timeout: 12_000,
      maxBuffer: 256 * 1024,
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0 };
  } catch (error) {
    const failure = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    // login status 的“未登录”通常以 exit 1 返回；保留输出让调用方区分，
    // 但绝不把它原样送到手机客户端。
    if (failure.code === "ENOENT") {
      throw new AgentAccountError(`未安装 ${file}`, "agent_unavailable");
    }
    if (typeof failure.stdout === "string" || typeof failure.stderr === "string") {
      return {
        stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        stderr: typeof failure.stderr === "string" ? failure.stderr : "",
        exitCode: typeof failure.code === "number" ? failure.code : 1,
      };
    }
    throw error;
  }
}

/**
 * Code Agent 账号目录管理。
 *
 * 元数据只写名称、默认项和隔离目录；Codex 由官方 CLI 写入独立 CODEX_HOME，
 * managed Claude 的显式凭据写入系统安全存储。项目 cwd 不在这里，因此多个账号
 * 可以进入同一项目，同时不会共享 agent 用户态配置。
 */
export class AgentAccountManager {
  private readonly storeFile: string;
  private readonly rootsDir: string;
  private readonly credentialCache = new Map<string, AgentAccountCredential | null>();
  private store: AccountStore;

  constructor(
    private readonly home: string,
    private readonly runner: AccountCommandRunner = defaultRunner,
    private readonly credentialStore: AgentAccountCredentialStore = new SystemCredentialStore(),
  ) {
    this.storeFile = path.join(home, "agent-accounts.json");
    this.rootsDir = path.join(home, "agent-accounts");
    mkdirSync(this.rootsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.rootsDir, 0o700);
    this.store = this.load();
  }

  nativeId(agent: CodeAgentKind): string {
    return NATIVE_IDS[agent];
  }

  defaultId(agent: CodeAgentKind): string {
    const selected = this.store.defaults[agent];
    if (selected === NATIVE_IDS[agent]) return selected;
    if (selected && this.store.accounts.some((account) => account.id === selected && account.agent === agent)) {
      return selected;
    }
    return NATIVE_IDS[agent];
  }

  resolve(accountId: string, expectedAgent?: CodeAgentKind): AccountBinding {
    for (const agent of ["claude", "codex"] as const) {
      if (accountId === NATIVE_IDS[agent]) {
        if (expectedAgent && expectedAgent !== agent) {
          throw new AgentAccountError("账号与所选 Agent 不匹配", "account_invalid");
        }
        return { id: accountId, agent, name: "本机默认", managed: false, environment: {} };
      }
    }
    const account = this.store.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new AgentAccountError("账号不存在或已删除", "account_not_found");
    if (expectedAgent && expectedAgent !== account.agent) {
      throw new AgentAccountError("账号与所选 Agent 不匹配", "account_invalid");
    }
    const root = this.rootFor(account.agent, account.id);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const credential = account.agent === "claude"
      ? this.claudeCredential(account.id, root)
      : null;
    return {
      id: account.id,
      agent: account.agent,
      name: account.name,
      managed: true,
      environment:
        account.agent === "codex"
          ? {
              // 不能只换目录：daemon 若带着全局 API key 启动，子进程仍会绕过
              // 账号目录。空值经两种 CLI 验证会按“未设置”处理。
              OPENAI_API_KEY: "",
              CODEX_API_KEY: "",
              CODEX_ACCESS_TOKEN: "",
              CODEX_REFRESH_TOKEN: "",
              CODEX_HOME: root,
              CODEX_SQLITE_HOME: root,
            }
          : {
              ANTHROPIC_API_KEY: "",
              ANTHROPIC_AUTH_TOKEN: "",
              // macOS Claude `/login` lives in a process-global Keychain item. An
              // explicit per-account credential (or a non-secret sentinel) prevents
              // managed sessions from silently falling back to that shared identity.
              CLAUDE_CODE_OAUTH_TOKEN:
                credential?.kind === "oauth_token"
                  ? credential.secret
                  : MISSING_CLAUDE_CREDENTIAL,
              CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
              CLAUDE_CODE_OAUTH_SCOPES: "",
              CLAUDE_CODE_USE_BEDROCK: "",
              CLAUDE_CODE_USE_VERTEX: "",
              CLAUDE_CODE_USE_FOUNDRY: "",
              CLAUDE_CONFIG_DIR: root,
              ...(credential?.kind === "api_key"
                ? { ANTHROPIC_API_KEY: credential.secret, CLAUDE_CODE_OAUTH_TOKEN: "" }
                : {}),
            },
      ...(credential ? { credentialKind: credential.kind } : {}),
    };
  }

  create(agent: CodeAgentKind, rawName: string): AccountBinding {
    const now = Date.now();
    const account: StoredAccount = {
      id: randomUUID(),
      agent,
      name: cleanName(rawName),
      createdAt: now,
      updatedAt: now,
    };
    this.store.accounts.push(account);
    if (!this.store.defaults[agent]) this.store.defaults[agent] = account.id;
    const binding = this.resolve(account.id, agent);
    this.persist();
    return binding;
  }

  rename(accountId: string, rawName: string): void {
    const account = this.requireManaged(accountId);
    account.name = cleanName(rawName);
    account.updatedAt = Date.now();
    this.persist();
  }

  setDefault(accountId: string): void {
    const binding = this.resolve(accountId);
    this.store.defaults[binding.agent] = binding.id;
    this.persist();
  }

  async setCredential(
    accountId: string,
    kind: AgentCredentialKind,
    rawSecret: string,
  ): Promise<void> {
    const account = this.requireManaged(accountId);
    if (account.agent !== "claude") {
      throw new AgentAccountError("Codex 请使用官方设备登录流程", "account_invalid");
    }
    const root = this.rootFor(account.agent, account.id);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const credential = cleanCredential(kind, rawSecret);
    await this.credentialStore.write(account.id, root, credential);
    this.credentialCache.set(account.id, credential);
    account.updatedAt = Date.now();
    this.persist();
  }

  loginSpec(accountId: string): AccountLoginSpec {
    const binding = this.resolve(accountId);
    if (binding.agent === "claude" && binding.managed) {
      return {
        binding: {
          ...binding,
          // setup-token must run without the previously imported credential. It
          // prints a new inference-only token which the user imports into Prospero.
          environment: {
            ...binding.environment,
            ANTHROPIC_API_KEY: "",
            ANTHROPIC_AUTH_TOKEN: "",
            CLAUDE_CODE_OAUTH_TOKEN: "",
            CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
            CLAUDE_CODE_OAUTH_SCOPES: "",
          },
        },
        command: { file: "claude", args: ["setup-token"] },
      };
    }
    return {
      binding,
      command:
        binding.agent === "codex"
          ? { file: "codex", args: ["login", "--device-auth"] }
          : { file: "claude", args: ["auth", "login"] },
    };
  }

  async logout(accountId: string): Promise<void> {
    const binding = this.resolve(accountId);
    if (binding.agent === "claude" && binding.managed) {
      const root = this.rootFor(binding.agent, binding.id);
      await this.credentialStore.delete(binding.id, root);
      this.credentialCache.set(binding.id, null);
      // Clean credentials created by older Prospero builds on Linux/Windows. On
      // macOS we deliberately do not call `claude auth logout`: that command would
      // mutate Claude's shared native Keychain identity.
      rmSync(path.join(root, ".credentials.json"), { force: true });
      return;
    }
    const command =
      binding.agent === "codex"
        ? { file: "codex", args: ["logout"] }
        : { file: "claude", args: ["auth", "logout"] };
    try {
      const result = await this.runner(command.file, command.args, binding.environment);
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode !== 0 && !/not logged in|not currently logged/i.test(output)) {
        throw new Error(`exit ${String(result.exitCode)}`);
      }
    } catch (error) {
      if (error instanceof AgentAccountError) throw error;
      throw new AgentAccountError(
        `注销 ${binding.name} 失败: ${error instanceof Error ? error.message : String(error)}`,
        "agent_unavailable",
      );
    }
  }

  async delete(accountId: string, sessions: SessionInfo[]): Promise<void> {
    const account = this.requireManaged(accountId);
    const count = activeCount(sessions, accountId);
    if (count > 0) {
      throw new AgentAccountError(`这个账号仍有 ${String(count)} 个会话，请先结束会话`, "account_in_use");
    }
    // logout clears the account-specific credential before its isolated root.
    await this.logout(accountId);
    const root = this.rootFor(account.agent, account.id);
    rmSync(root, { recursive: true, force: true });
    this.store.accounts = this.store.accounts.filter((candidate) => candidate.id !== accountId);
    if (this.store.defaults[account.agent] === accountId) {
      this.store.defaults[account.agent] = NATIVE_IDS[account.agent];
    }
    this.persist();
  }

  async snapshot(sessions: SessionInfo[]): Promise<AgentAccount[]> {
    const stored = [...this.store.accounts];
    const records: Array<{
      binding: AccountBinding;
      createdAt: number;
      updatedAt: number;
    }> = [
      ...(["claude", "codex"] as const).map((agent) => ({
        binding: this.resolve(NATIVE_IDS[agent], agent),
        createdAt: 0,
        updatedAt: 0,
      })),
      ...stored.map((account) => ({
        binding: this.resolve(account.id, account.agent),
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })),
    ];
    const statuses = await Promise.all(records.map(({ binding }) => this.status(binding)));
    return records.map(({ binding, createdAt, updatedAt }, index) => ({
      id: binding.id,
      agent: binding.agent,
      name: binding.name,
      managed: binding.managed,
      isDefault: this.defaultId(binding.agent) === binding.id,
      ...statuses[index]!,
      createdAt,
      updatedAt,
      activeSessions: activeCount(sessions, binding.id),
    }));
  }

  private async status(
    binding: AccountBinding,
  ): Promise<{ status: AgentAccountStatus; authMethod?: string; detail?: string }> {
    try {
      if (binding.agent === "claude") {
        if (binding.managed && !binding.credentialKind) {
          await this.runner("claude", ["--version"], binding.environment);
          return { status: "signed_out", detail: "需要生成并导入独立凭据" };
        }
        const result = await this.runner("claude", ["auth", "status", "--json"], binding.environment);
        const raw = result.stdout.trim();
        if (!raw) return { status: "signed_out" };
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed["loggedIn"] !== true) return { status: "signed_out" };
        const method = typeof parsed["authMethod"] === "string" ? parsed["authMethod"] : undefined;
        const provider = typeof parsed["apiProvider"] === "string" ? parsed["apiProvider"] : undefined;
        return {
          status: "signed_in",
          ...(method ? { authMethod: method } : {}),
          ...(provider ? { detail: provider } : {}),
        };
      }
      const result = await this.runner("codex", ["login", "status"], binding.environment);
      const output = `${result.stdout}\n${result.stderr}`.trim();
      if (/not logged in/i.test(output) || output.length === 0) return { status: "signed_out" };
      const match = output.match(/logged in(?: using| with)?\s+(.+)/i);
      return {
        status: "signed_in",
        ...(match?.[1] ? { authMethod: match[1].trim().slice(0, 200) } : {}),
      };
    } catch (error) {
      if (error instanceof AgentAccountError && error.code === "agent_unavailable") {
        return { status: "unavailable", detail: error.message };
      }
      return { status: "error", detail: "无法读取登录状态" };
    }
  }

  private requireManaged(accountId: string): StoredAccount {
    if (Object.values(NATIVE_IDS).includes(accountId)) {
      throw new AgentAccountError("本机默认环境不能重命名或删除", "account_not_managed");
    }
    const account = this.store.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new AgentAccountError("账号不存在或已删除", "account_not_found");
    return account;
  }

  private claudeCredential(accountId: string, root: string): AgentAccountCredential | null {
    if (this.credentialCache.has(accountId)) {
      return this.credentialCache.get(accountId) ?? null;
    }
    const credential = this.credentialStore.read(accountId, root);
    this.credentialCache.set(accountId, credential);
    return credential;
  }

  private rootFor(agent: CodeAgentKind, accountId: string): string {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(accountId)) {
      throw new AgentAccountError("账号 ID 无效", "account_invalid");
    }
    return path.join(this.rootsDir, agent, accountId);
  }

  private load(): AccountStore {
    try {
      return parseStore(JSON.parse(readFileSync(this.storeFile, "utf8")));
    } catch {
      return { version: 1, accounts: [], defaults: {} };
    }
  }

  private persist(): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const temp = `${this.storeFile}.tmp`;
    writeFileSync(temp, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    renameSync(temp, this.storeFile);
    chmodSync(this.storeFile, 0o600);
  }
}
