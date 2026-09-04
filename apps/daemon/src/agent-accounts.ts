import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AgentAccount,
  AgentApiProfile,
  AgentApiProtocol,
  AgentApiProvider,
  AgentAccountStatus,
  AgentCredentialKind,
  CodeAgentKind,
  SessionInfo,
} from "@prospero/protocol";
import { programCommandFor } from "./agents.js";

const execFile = promisify(execFileCallback);
const LEGACY_MACOS_KEYCHAIN_SERVICE = "com.prospero.code-agent.claude";
const ACCOUNT_CREDENTIAL_FILE = ".prospero-credential.json";
const LOCAL_CREDENTIAL_MARKER = ".prospero-credential-local-v1";
const MISSING_CLAUDE_CREDENTIAL = "prospero-managed-account-not-authenticated";
const NATIVE_IDS: Record<CodeAgentKind, string> = {
  codex: "native-codex",
  claude: "native-claude",
};

interface StoredAccount {
  id: string;
  agent: CodeAgentKind;
  name: string;
  /** 非敏感的第三方 API 连接信息；key 单独存账号目录的私有文件。 */
  apiProfile?: StoredApiProfile;
  createdAt: number;
  updatedAt: number;
}

interface StoredApiProfile {
  provider: AgentApiProvider;
  protocol: AgentApiProtocol;
  baseUrl: string;
  model: string;
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
  /** 已配置的 API Profile，不含 secret，供状态与会话启动区分。 */
  apiProfile?: AgentApiProfile;
  adapterAgent?: "opencode";
  /** Codex app-server 的受控配置覆盖；避免修改用户的全局 config.toml。 */
  codexAppServerArgs?: string[];
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

export interface ApiProfileInput {
  name?: string;
  provider?: AgentApiProvider;
  protocol?: AgentApiProtocol;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** Injectable so tests can exercise account behavior without writing credentials to disk. */
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
        const apiProfile = parseStoredApiProfile(account["agent"], account["apiProfile"]);
        return [{
          id: account["id"],
          agent: account["agent"],
          name: account["name"].trim().slice(0, 80),
          ...(apiProfile ? { apiProfile } : {}),
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

function cleanApiKey(rawSecret: string): AgentAccountCredential {
  const secret = rawSecret.trim();
  if (secret.length === 0 || secret.length > 8192 || /[\r\n\0]/.test(secret)) {
    throw new AgentAccountError("API Key 格式无效", "account_invalid");
  }
  return { kind: "api_key", secret };
}

function apiProviderFor(agent: CodeAgentKind): AgentApiProvider {
  return agent === "codex" ? "openai_compatible" : "anthropic_compatible";
}

function apiProtocolFor(agent: CodeAgentKind): AgentApiProtocol {
  return agent === "codex" ? "openai_responses" : "anthropic";
}

function cleanApiProfile(
  agent: CodeAgentKind,
  rawBaseUrl: string,
  rawModel: string,
  provider: AgentApiProvider = apiProviderFor(agent),
  protocol: AgentApiProtocol = apiProtocolFor(agent),
): StoredApiProfile {
  const baseUrl = rawBaseUrl.trim();
  const model = rawModel.trim();
  if (baseUrl.length === 0 || baseUrl.length > 2000 || /[\r\n\0]/.test(baseUrl)) {
    throw new AgentAccountError("API 地址格式无效", "account_invalid");
  }
  if (model.length === 0 || model.length > 300 || /[\r\n\0]/.test(model)) {
    throw new AgentAccountError("模型名称格式无效", "account_invalid");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AgentAccountError("API 地址必须是完整 URL", "account_invalid");
  }
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) ||
      url.username || url.password || url.search || url.hash) {
    throw new AgentAccountError("API 地址必须使用 HTTPS（localhost 可使用 HTTP）", "account_invalid");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  const suffixes = protocol === "openai_responses"
    ? ["/responses"]
    : protocol === "openai_chat_completions"
      ? ["/chat/completions"]
      : ["/v1/messages", "/v1"];
  const suffix = suffixes.find((candidate) => url.pathname.toLowerCase().endsWith(candidate));
  if (suffix) {
    url.pathname = url.pathname.slice(0, -suffix.length) || "/";
  }
  const normalized = url.toString().replace(/\/$/, "");
  const valid = agent === "codex"
    ? provider === "openai_compatible" && (protocol === "openai_responses" || protocol === "openai_chat_completions")
    : provider === "anthropic_compatible" && protocol === "anthropic";
  if (!valid) throw new AgentAccountError("所选 Agent、Provider 与 API 协议不兼容", "account_invalid");
  return { provider, protocol, baseUrl: normalized, model };
}

function parseStoredApiProfile(agent: CodeAgentKind, value: unknown): StoredApiProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw["baseUrl"] !== "string" || typeof raw["model"] !== "string") return undefined;
  try {
    const provider = raw["provider"] === "openai_compatible" || raw["provider"] === "anthropic_compatible"
      ? raw["provider"]
      : apiProviderFor(agent);
    const protocol = raw["protocol"] === "openai_responses" || raw["protocol"] === "openai_chat_completions" || raw["protocol"] === "anthropic"
      ? raw["protocol"]
      : agent === "codex" && /\/chat\/completions\/*$/i.test(raw["baseUrl"])
        ? "openai_chat_completions"
        : apiProtocolFor(agent);
    return cleanApiProfile(agent, raw["baseUrl"], raw["model"], provider, protocol);
  } catch {
    return undefined;
  }
}

function publicApiProfile(agent: CodeAgentKind, profile: StoredApiProfile): AgentApiProfile {
  return { ...profile, provider: profile.provider ?? apiProviderFor(agent) };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexProviderArgs(profile: StoredApiProfile): string[] {
  return [
    "-c", `model_provider=${tomlString("prospero")}`,
    "-c", `model=${tomlString(profile.model)}`,
    "-c", `model_providers.prospero.name=${tomlString("Prospero external API")}`,
    "-c", `model_providers.prospero.base_url=${tomlString(profile.baseUrl)}`,
    "-c", `model_providers.prospero.env_key=${tomlString("OPENAI_API_KEY")}`,
    "-c", `model_providers.prospero.wire_api=${tomlString("responses")}`,
    "-c", "model_providers.prospero.requires_openai_auth=false",
  ];
}

function opencodeProfileEnvironment(
  root: string,
  profile: StoredApiProfile,
  apiKey: string,
): Record<string, string> {
  const data = path.join(root, "xdg-data");
  const cache = path.join(root, "xdg-cache");
  const state = path.join(root, "xdg-state");
  const config = path.join(root, "xdg-config");
  const configDirectory = path.join(config, "opencode");
  const configFile = path.join(configDirectory, "opencode.json");
  for (const directory of [data, cache, state, config, configDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const contents = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: `prospero/${profile.model}`,
    small_model: `prospero/${profile.model}`,
    provider: {
      prospero: {
        npm: "@ai-sdk/openai-compatible",
        name: "Prospero API Profile",
        env: ["OPENAI_API_KEY"],
        options: {
          baseURL: profile.baseUrl,
        },
        models: {
          [profile.model]: { name: profile.model, tool_call: true },
        },
      },
    },
  });
  let current = "";
  try { current = readFileSync(configFile, "utf8"); } catch {}
  if (current !== contents) writePrivateFile(configFile, contents);
  const fingerprint = createHash("sha256").update(contents).update("\0").update(apiKey).digest("hex");
  return {
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    XDG_CONFIG_HOME: config,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    PROSPERO_API_PROFILE_CONFIG: configFile,
    PROSPERO_API_PROFILE_FINGERPRINT: fingerprint,
    PROSPERO_API_PROFILE_MODEL: `prospero/${profile.model}`,
    OPENAI_API_KEY: apiKey,
  };
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
    return value["kind"] === "api_key"
      ? cleanApiKey(value["secret"])
      : cleanCredential(value["kind"], value["secret"]);
  } catch {
    return null;
  }
}

type LegacyCredentialReader = (accountId: string) => AgentAccountCredential | null;

function writePrivateFile(target: string, contents: string): void {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Read-only bridge for credentials saved by older macOS builds. Never writes or deletes Keychain items. */
function readLegacyMacosKeychainCredential(accountId: string): AgentAccountCredential | null {
  try {
    const raw = execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        accountId,
        "-s",
        LEGACY_MACOS_KEYCHAIN_SERVICE,
        "-w",
      ],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 16 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return parseCredential(raw.trim());
  } catch (error) {
    // `security` uses 44 for an absent item. Timeouts/locked Keychains remain retryable
    // and must not be mistaken for a definitive miss by the migration marker.
    if ((error as { status?: unknown }).status === 44) return null;
    throw error;
  }
}

function credentialFile(root: string): string {
  return path.join(root, ACCOUNT_CREDENTIAL_FILE);
}

function localCredentialMarker(root: string): string {
  return path.join(root, LOCAL_CREDENTIAL_MARKER);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Credentials live in a mode-0600 file inside the account's mode-0700 root on every
 * platform. macOS only receives a one-time, read-only legacy Keychain migration; new
 * saves and deletes never invoke Keychain, so they cannot wait on a system prompt.
 */
export class LocalFileCredentialStore implements AgentAccountCredentialStore {
  constructor(
    private readonly legacyReader: LegacyCredentialReader | null =
      process.platform === "darwin" ? readLegacyMacosKeychainCredential : null,
  ) {}

  read(accountId: string, root: string): AgentAccountCredential | null {
    const target = credentialFile(root);
    try {
      const credential = parseCredential(readFileSync(target, "utf8"));
      try {
        chmodSync(target, 0o600);
        this.markLocal(root);
      } catch {
        // The credential is still readable for this process; a later explicit save can repair permissions.
      }
      return credential;
    } catch (error) {
      if (!isMissingFile(error)) return null;
    }

    if (existsSync(localCredentialMarker(root)) || this.legacyReader === null) {
      return null;
    }

    let migrated: AgentAccountCredential | null = null;
    try {
      migrated = this.legacyReader(accountId);
    } catch {
      // A locked/slow Keychain is not a definitive miss. Do not create the marker,
      // so the user can unlock it or simply save a new local credential and retry.
      return null;
    }
    try {
      if (migrated) this.writeLocal(root, migrated);
      else this.markLocal(root);
    } catch {
      // Migration is best-effort. Keep the recovered value in this daemon's in-memory cache.
    }
    return migrated;
  }

  async write(
    _accountId: string,
    root: string,
    credential: AgentAccountCredential,
  ): Promise<void> {
    this.writeLocal(root, credential);
  }

  async delete(_accountId: string, root: string): Promise<void> {
    this.markLocal(root);
    try {
      unlinkSync(credentialFile(root));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }

  private writeLocal(root: string, credential: AgentAccountCredential): void {
    this.markLocal(root);
    writePrivateFile(credentialFile(root), JSON.stringify(credential));
  }

  private markLocal(root: string): void {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const marker = localCredentialMarker(root);
    if (existsSync(marker)) {
      chmodSync(marker, 0o600);
      return;
    }
    writePrivateFile(marker, "local-file-v1\n");
  }
}

async function defaultRunner(
  file: string,
  args: string[],
  environment: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const command = programCommandFor(file, args);
  try {
    const result = await execFile(command.file, command.args, {
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
      const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
      const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
      if (
        process.platform === "win32" &&
        /is not recognized as an internal or external command|不是内部或外部命令/i.test(
          `${stdout}\n${stderr}`,
        )
      ) {
        throw new AgentAccountError(`未安装 ${file}`, "agent_unavailable");
      }
      return {
        stdout,
        stderr,
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
 * managed Claude 与第三方 API Profile 的显式凭据写入账号目录的 0600 私有文件。
 * 项目 cwd 不在这里，因此多个账号
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
    private readonly credentialStore: AgentAccountCredentialStore = new LocalFileCredentialStore(),
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
        if (agent === "codex") {
          // 本机默认 Codex 也必须隔离 CODEX_HOME：daemon 的 app-server 会持有
          // ~/.codex 里的 thread-writer-locks，与 Codex 桌面应用共享同一份 home 时
          // 会把后者的线程锁成“在另一个应用中打开”。隔离后两者互不相扰。
          const root = this.rootFor("codex", NATIVE_IDS.codex);
          mkdirSync(root, { recursive: true, mode: 0o700 });
          chmodSync(root, 0o700);
          this.migrateNativeCodexAuth(root);
          return {
            id: accountId,
            agent,
            name: "本机默认",
            managed: false,
            environment: { CODEX_HOME: root, CODEX_SQLITE_HOME: root },
          };
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
    const credential = (account.agent === "claude" || account.apiProfile)
      ? this.claudeCredential(account.id, root)
      : null;
    const apiProfile = account.apiProfile
      ? publicApiProfile(account.agent, account.apiProfile)
      : undefined;
    const environment = apiProfile
      ? apiProfile.protocol === "openai_chat_completions" && account.apiProfile
        ? opencodeProfileEnvironment(
            root,
            account.apiProfile,
            credential?.kind === "api_key" ? credential.secret : "",
          )
        : account.agent === "codex"
          ? {
            // 自定义 provider 只从本 Profile 的 key 取值，不能回退 daemon 的全局环境。
            OPENAI_API_KEY: credential?.kind === "api_key" ? credential.secret : "",
            OPENAI_BASE_URL: "",
            OPENAI_API_BASE: "",
            OPENAI_ORGANIZATION: "",
            CODEX_API_KEY: "",
            CODEX_ACCESS_TOKEN: "",
            CODEX_REFRESH_TOKEN: "",
            CODEX_HOME: root,
            CODEX_SQLITE_HOME: root,
          }
          : {
            ANTHROPIC_API_KEY: credential?.kind === "api_key" ? credential.secret : "",
            ANTHROPIC_AUTH_TOKEN: "",
            ANTHROPIC_BASE_URL: apiProfile.baseUrl,
            ANTHROPIC_MODEL: apiProfile.model,
            CLAUDE_CODE_API_BASE_URL: "",
            CLAUDE_CODE_OAUTH_TOKEN: "",
            CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
            CLAUDE_CODE_OAUTH_SCOPES: "",
            CLAUDE_CODE_USE_BEDROCK: "",
            CLAUDE_CODE_USE_VERTEX: "",
            CLAUDE_CODE_USE_FOUNDRY: "",
            CLAUDE_CODE_USE_GATEWAY: "",
            CLAUDE_CONFIG_DIR: root,
          }
      :
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
            };
    return {
      id: account.id,
      agent: account.agent,
      name: account.name,
      managed: true,
      environment,
      ...(apiProfile ? { apiProfile } : {}),
      ...(apiProfile?.protocol === "openai_chat_completions" ? { adapterAgent: "opencode" as const } : {}),
      ...(apiProfile?.protocol === "openai_responses" && account.agent === "codex" && account.apiProfile
        ? { codexAppServerArgs: codexProviderArgs(account.apiProfile) }
        : {}),
      ...(credential ? { credentialKind: credential.kind } : {}),
    };
  }

  /**
   * 额度查询只读取账号身份，不应与正在运行的 thread 共用 SQLite runtime。
   * 本机默认账号每次查询前同步最新 auth.json 到专用目录，但绝不复用用户的
   * config.toml/plugins/MCP 配置。否则一次只读额度查询也会启动用户 MCP，甚至
   * 让一个 Prospero MCP 用真实 ~/.prospero 覆盖正在运行的 daemon control socket。
   */
  usageEnvironment(binding: AccountBinding): Record<string, string> {
    if (binding.agent !== "codex" || binding.apiProfile) return binding.environment;
    const usageRoot = path.join(this.rootsDir, "codex-usage", binding.id);
    const usageHome = path.join(usageRoot, "home");
    const usageSqlite = path.join(usageRoot, "sqlite");
    for (const directory of [usageRoot, usageHome, usageSqlite]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    if (binding.id === NATIVE_IDS.codex) this.migrateNativeCodexAuth(usageHome);
    return {
      ...binding.environment,
      ...(binding.id === NATIVE_IDS.codex
        ? { CODEX_HOME: usageHome }
        : {}),
      CODEX_SQLITE_HOME: usageSqlite,
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

  async createApi(
    agent: CodeAgentKind,
    rawName: string,
    input: ApiProfileInput,
  ): Promise<AccountBinding> {
    const now = Date.now();
    if (input.baseUrl === undefined || input.model === undefined || input.apiKey === undefined) {
      throw new AgentAccountError("API Profile 缺少连接信息", "account_invalid");
    }
    const profile = cleanApiProfile(
      agent,
      input.baseUrl,
      input.model,
      input.provider,
      input.protocol,
    );
    const credential = cleanApiKey(input.apiKey);
    const account: StoredAccount = {
      id: randomUUID(),
      agent,
      name: cleanName(rawName),
      apiProfile: profile,
      createdAt: now,
      updatedAt: now,
    };
    const root = this.rootFor(agent, account.id);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    await this.credentialStore.write(account.id, root, credential);
    this.credentialCache.set(account.id, credential);
    this.store.accounts.push(account);
    if (!this.store.defaults[agent]) this.store.defaults[agent] = account.id;
    this.persist();
    return this.resolve(account.id, agent);
  }

  async configureApi(
    accountId: string,
    input: ApiProfileInput,
    sessions: SessionInfo[] = [],
    inUse = false,
  ): Promise<void> {
    const account = this.requireManaged(accountId);
    if (!account.apiProfile) {
      throw new AgentAccountError("这个账号不是第三方 API Profile", "account_invalid");
    }
    const profile = cleanApiProfile(
      account.agent,
      input.baseUrl ?? account.apiProfile.baseUrl,
      input.model ?? account.apiProfile.model,
      input.provider ?? account.apiProfile.provider,
      input.protocol ?? account.apiProfile.protocol,
    );
    const name = input.name === undefined ? account.name : cleanName(input.name);
    const apiKey = input.apiKey?.trim() ?? "";
    const updatesCredential = apiKey.length > 0;
    if (
      (inUse || activeCount(sessions, accountId) > 0) &&
      (updatesCredential ||
        profile.provider !== account.apiProfile.provider ||
        profile.protocol !== account.apiProfile.protocol ||
        profile.baseUrl !== account.apiProfile.baseUrl ||
        profile.model !== account.apiProfile.model)
    ) {
      throw new AgentAccountError("这个 Profile 仍有活动会话，只能更新名称", "account_in_use");
    }
    const root = this.rootFor(account.agent, account.id);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    if (updatesCredential) {
      const credential = cleanApiKey(apiKey);
      await this.credentialStore.write(account.id, root, credential);
      this.credentialCache.set(account.id, credential);
    }
    account.apiProfile = profile;
    account.name = name;
    account.updatedAt = Date.now();
    this.persist();
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
    sessions: SessionInfo[] = [],
    inUse = false,
  ): Promise<void> {
    const account = this.requireManaged(accountId);
    if (account.apiProfile) {
      if (inUse || activeCount(sessions, accountId) > 0) {
        throw new AgentAccountError("这个 Profile 仍有活动会话，不能更新 API Key", "account_in_use");
      }
      if (kind !== "api_key") {
        throw new AgentAccountError("第三方 API Profile 只能使用 API Key", "account_invalid");
      }
    } else if (account.agent !== "claude") {
      throw new AgentAccountError("Codex 请使用官方设备登录流程", "account_invalid");
    }
    const root = this.rootFor(account.agent, account.id);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const credential = account.apiProfile
      ? cleanApiKey(rawSecret)
      : cleanCredential(kind, rawSecret);
    await this.credentialStore.write(account.id, root, credential);
    this.credentialCache.set(account.id, credential);
    account.updatedAt = Date.now();
    this.persist();
  }

  loginSpec(accountId: string): AccountLoginSpec {
    const binding = this.resolve(accountId);
    if (binding.apiProfile) {
      throw new AgentAccountError("第三方 API Profile 无需 CLI 登录，请配置 API Key", "account_invalid");
    }
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

  async logout(accountId: string, sessions: SessionInfo[] = [], inUse = false): Promise<void> {
    const binding = this.resolve(accountId);
    if (binding.apiProfile && (inUse || activeCount(sessions, accountId) > 0)) {
      throw new AgentAccountError("这个 Profile 仍有活动会话，不能移除 API Key", "account_in_use");
    }
    if ((binding.agent === "claude" && binding.managed) || binding.apiProfile) {
      const root = this.rootFor(binding.agent, binding.id);
      await this.credentialStore.delete(binding.id, root);
      this.credentialCache.set(binding.id, null);
      if (binding.apiProfile) return;
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

  async delete(accountId: string, sessions: SessionInfo[], inUse = false): Promise<void> {
    const account = this.requireManaged(accountId);
    const count = activeCount(sessions, accountId);
    if (inUse || count > 0) {
      throw new AgentAccountError(`这个账号仍有${count > 0 ? ` ${String(count)} 个会话` : "会话正在启动"}，请先结束会话`, "account_in_use");
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
      ...(binding.apiProfile ? { apiProfile: binding.apiProfile } : {}),
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
      if (binding.apiProfile) {
        const version = await this.runner(binding.adapterAgent ?? binding.agent, ["--version"], binding.environment);
        if (version.exitCode !== 0) {
          return { status: "unavailable", detail: `${binding.adapterAgent ?? binding.agent} CLI 不可用` };
        }
        if (binding.credentialKind !== "api_key") {
          return { status: "signed_out", detail: "需要配置该 Profile 的 API Key" };
        }
        return {
          status: "signed_in",
          authMethod: "API Key",
          detail: `${binding.apiProfile.protocol ?? binding.apiProfile.provider} · ${new URL(binding.apiProfile.baseUrl).host}`,
        };
      }
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
      if (result.exitCode !== 0) {
        return { status: "error", detail: "Codex CLI 无法读取登录状态" };
      }
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

  private sharedCodexHome(): string {
    return process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
  }

  private codexAuthRefresh(file: string): number {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const value = raw["last_refresh"];
      const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 隔离本机默认 Codex 的 thread/SQLite 状态，同时让会话继承用户最新的登录凭据。
   * 只同步 auth.json，不复制 config.toml；源凭据变新时再次同步，避免 refresh token
   * 轮换后隔离账号仍长期使用旧副本。
   */
  private migrateNativeCodexAuth(root: string): void {
    const target = path.join(root, "auth.json");
    const sharedCodexHome = this.sharedCodexHome();
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    if (!existsSync(sharedAuth) || sharedAuth === target) return;
    if (
      existsSync(target) &&
      this.codexAuthRefresh(sharedAuth) <= this.codexAuthRefresh(target)
    ) {
      return;
    }
    try {
      copyFileSync(sharedAuth, target);
      chmodSync(target, 0o600);
    } catch {
      // 迁移失败只是退化为“需要在账号页重新登录”，不影响隔离本身。
    }
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
