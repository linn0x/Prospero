import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
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
  AgentApiValidation,
  AgentApiEngineValidation,
  AgentModelCapabilitySupport,
  AgentExecutionEngine,
  AgentAccountCapabilities,
  AgentModelCapabilities,
  AgentAccountStatus,
  AgentCredentialKind,
  CodeAgentKind,
  SessionInfo,
  AgentAccountConfig,
  AgentApiCatalogModel,
  AgentReasoningEffort,
  C2SAgentAccountApiModelsGet,
  C2SAgentAccountConfigSet,
  ModelSourceAction,
  ModelSourceBinding,
  ModelSourceMigration,
  S2CModelSourceResult,
} from "@prospero/protocol";
import { ApiHeadersSchema, AgentApiEngineValidationSchema, AgentApiValidationSchema, AgentModelCapabilitiesSchema, ModelSourceBindingSchema, getAgentAccountCapabilities, getAgentAccountEngine } from "@prospero/protocol";
import { programCommandFor } from "./agents.js";
import { claudeModelCapabilityEnvironment, codexModelCapabilityArgs, getModelCapabilitySupport } from "./api-profile-capabilities.js";
import { fetchApiModels, type ApiModelCatalogOptions } from "./agent-api-models.js";
import { getAccountConfig, readAccountOverrides, saveAccountConfig, supportedAccountEfforts, type AccountConfigTarget } from "./agent-account-config.js";
import { AgentAccountFeatureError } from "./agent-account-feature-error.js";
import type { AgentModelCatalog } from "./adapters/types.js";
import { ModelSources, type SourceMigrationEntry } from "./model-sources.js";

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
  modelSource?: ModelSourceBinding;
  /** Present only when apiProfile was explicitly saved but failed validation. Never sent to clients. */
  invalidApiProfile?: { raw: unknown };
  apiValidation?: AgentApiValidation;
  apiValidationRevision?: string;
  apiEngineValidation?: AgentApiEngineValidation;
  apiEngineValidationRevision?: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredApiProfile {
  provider: AgentApiProvider;
  protocol: AgentApiProtocol;
  baseUrl: string;
  model: string;
  modelCapabilities?: AgentModelCapabilities;
  headers?: Record<string, string>;
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
  sourceAllowsNewSessions?: boolean;
  defaultModel?: string;
  defaultEffort?: AgentReasoningEffort;
  environment: Record<string, string>;
  /** 已配置的 API Profile，不含 secret，供状态与会话启动区分。 */
  apiProfile?: AgentApiProfile;
  modelSource?: ModelSourceBinding;
  engine?: AgentExecutionEngine;
  capabilities?: AgentAccountCapabilities;
  modelCapabilitySupport?: AgentModelCapabilitySupport;
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
  modelCapabilities?: AgentModelCapabilities | null;
}

export interface AgentAccountManagerOptions {
  /** Test seam for storage faults; a production writer must durably replace this file. */
  metadataWriter?: (file: string, contents: string) => void;
  now?: () => number;
  runtimeTtlMs?: number;
  runtimeFailureTtlMs?: number;
  /** Rechecked after a queued mutation starts, so a stale request snapshot cannot miss a new session lease. */
  accountInUse?: (accountId: string) => boolean;
}

interface AccountTransaction {
  version: 1;
  metadata: unknown;
  credential: { accountId: string; agent: CodeAgentKind; value: AgentAccountCredential | null };
}

function validAccountIdentities(accounts: StoredAccount[]): boolean {
  return new Set(accounts.map((account) => account.id)).size === accounts.length &&
    accounts.every((account) => /^[A-Za-z0-9-]{1,100}$/.test(account.id) && !Object.values(NATIVE_IDS).includes(account.id));
}

function validAccountDefaults(store: AccountStore): boolean {
  return (["claude", "codex"] as const).every((agent) => {
    const id = store.defaults[agent];
    return id === undefined || id === NATIVE_IDS[agent] || store.accounts.some((account) => account.id === id && account.agent === agent);
  });
}

function serializeStore(store: AccountStore): unknown {
  return { ...store, accounts: store.accounts.map(({ invalidApiProfile, ...account }) => ({
    ...account, ...(invalidApiProfile ? { apiProfile: invalidApiProfile.raw } : {}),
  })) };
}

function canonical(value: unknown): string {
  const ordered = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(ordered)
    : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]))
      : entry;
  return JSON.stringify(ordered(value));
}

/** Injectable so tests can exercise account behavior without writing credentials to disk. */
export interface AgentAccountCredentialStore {
  /** Implementations without readStrict must return null only for confirmed absence and throw on I/O errors. */
  read(accountId: string, root: string): AgentAccountCredential | null;
  /** A transaction must distinguish an absent key from an unreadable/corrupt key. */
  readStrict?(accountId: string, root: string): AgentAccountCredential | null;
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
          typeof account["updatedAt"] !== "number" ||
          !Number.isFinite(account["createdAt"]) || !Number.isFinite(account["updatedAt"])
        ) {
          return [];
        }
        const hasApiProfile = Object.hasOwn(account, "apiProfile");
        const apiProfile = parseStoredApiProfile(account["agent"], account["apiProfile"]);
        const validation = AgentApiValidationSchema.safeParse(account["apiValidation"]);
        const engineValidation = AgentApiEngineValidationSchema.safeParse(account["apiEngineValidation"]);
        return [{
          id: account["id"],
          agent: account["agent"],
          name: account["name"].trim().slice(0, 80),
          ...(apiProfile ? { apiProfile } : {}),
          ...(account["modelSource"] !== undefined ? { modelSource: ModelSourceBindingSchema.parse(account["modelSource"]) } : {}),
          ...(hasApiProfile && !apiProfile ? { invalidApiProfile: { raw: account["apiProfile"] } } : {}),
          ...(apiProfile && validation.success && typeof account["apiValidationRevision"] === "string"
            ? { apiValidation: validation.data, apiValidationRevision: account["apiValidationRevision"] } : {}),
          ...(apiProfile && engineValidation.success && typeof account["apiEngineValidationRevision"] === "string"
            ? { apiEngineValidation: engineValidation.data, apiEngineValidationRevision: account["apiEngineValidationRevision"] } : {}),
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
  modelCapabilities?: AgentModelCapabilities | null,
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
  const capabilities = modelCapabilities == null ? undefined : AgentModelCapabilitiesSchema.safeParse(modelCapabilities);
  if (capabilities && !capabilities.success) {
    throw new AgentAccountError("模型能力配置无效：上下文和输出上限须为正整数，输出不能超过上下文", "account_invalid");
  }
  if (protocol === "openai_chat_completions" && capabilities?.success &&
      ((capabilities.data.contextWindow === undefined) !== (capabilities.data.maxOutputTokens === undefined))) {
    // OpenCode's limit object requires both fields; avoid inventing an unknown model limit.
    throw new AgentAccountError("Chat Completions Profile 的上下文窗口与最大输出必须同时填写或同时留空", "account_invalid");
  }
  return { provider, protocol, baseUrl: normalized, model,
    ...(capabilities?.success ? { modelCapabilities: capabilities.data } : {}),
  };
}

function parseStoredApiProfile(agent: CodeAgentKind, value: unknown): StoredApiProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw["baseUrl"] !== "string" || typeof raw["model"] !== "string") return undefined;
  try {
    if (Object.hasOwn(raw, "provider") && raw["provider"] !== "openai_compatible" && raw["provider"] !== "anthropic_compatible") return undefined;
    if (Object.hasOwn(raw, "protocol") && raw["protocol"] !== "openai_responses" && raw["protocol"] !== "openai_chat_completions" && raw["protocol"] !== "anthropic") return undefined;
    if (Object.hasOwn(raw, "modelCapabilities") && !AgentModelCapabilitiesSchema.safeParse(raw["modelCapabilities"]).success) return undefined;
    const provider = (raw["provider"] ?? apiProviderFor(agent)) as AgentApiProvider;
    const protocol = raw["protocol"] !== undefined
      ? raw["protocol"] as AgentApiProtocol
      : agent === "codex" && /\/chat\/completions\/*$/i.test(raw["baseUrl"])
        ? "openai_chat_completions"
        : apiProtocolFor(agent);
    return { ...cleanApiProfile(agent, raw["baseUrl"], raw["model"], provider, protocol, raw["modelCapabilities"] as AgentModelCapabilities | undefined), ...(raw["headers"] !== undefined ? { headers: ApiHeadersSchema.parse(raw["headers"]) } : {}) };
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
    ...Object.keys(profile.headers ?? {}).flatMap((name, index) => ["-c", `model_providers.prospero.env_http_headers.${tomlString(name)}=${tomlString(`PROSPERO_API_HEADER_${index}`)}`]),
    ...codexModelCapabilityArgs(profile),
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
          ...(profile.headers ? { headers: profile.headers } : {}),
        },
        models: {
          [profile.model]: {
            name: profile.model,
            // Keep the adapter's existing tool runtime enabled until a profile explicitly disables it.
            tool_call: profile.modelCapabilities?.tools ?? true,
            ...(profile.modelCapabilities?.reasoning !== undefined ? { reasoning: profile.modelCapabilities.reasoning } : {}),
            ...(profile.modelCapabilities?.vision !== undefined
              ? { modalities: { input: profile.modelCapabilities.vision ? ["text", "image"] : ["text"], output: ["text"] } } : {}),
            ...(profile.modelCapabilities?.contextWindow !== undefined || profile.modelCapabilities?.maxOutputTokens !== undefined
              ? { limit: {
                  ...(profile.modelCapabilities.contextWindow !== undefined ? { context: profile.modelCapabilities.contextWindow } : {}),
                  ...(profile.modelCapabilities.maxOutputTokens !== undefined ? { output: profile.modelCapabilities.maxOutputTokens } : {}),
                } } : {}),
          },
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
    const file = openSync(temporary, "r+");
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, target);
    chmodSync(target, 0o600);
    syncDirectory(path.dirname(target));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function syncDirectory(directory: string): void {
  // Node does not support opening directories for fsync on Windows.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function executableIdentity(file: string, environment: Record<string, string>): string {
  const searchPath = environment["PATH"] ?? process.env["PATH"] ?? "";
  const extensions = process.platform === "win32"
    ? ["", ...(environment["PATHEXT"] ?? process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.PS1").split(";")]
    : [""];
  const bases = path.isAbsolute(file) ? [file] : searchPath.split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, file));
  for (const base of bases) for (const extension of extensions) {
    try {
      const candidate = `${base}${extension}`;
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      const resolved = realpathSync(candidate);
      const stat = statSync(resolved);
      if (stat.isFile()) return `${resolved}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch {}
  }
  return `missing:${file}:${searchPath}`;
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
    return this.readLocal(accountId, root, false);
  }

  readStrict(accountId: string, root: string): AgentAccountCredential | null {
    return this.readLocal(accountId, root, true);
  }

  private readLocal(accountId: string, root: string, strict: boolean): AgentAccountCredential | null {
    const target = credentialFile(root);
    try {
      const credential = parseCredential(readFileSync(target, "utf8"));
      if (strict && !credential) throw new AgentAccountError("账号凭据文件损坏，尚未修改配置", "account_invalid");
      try {
        chmodSync(target, 0o600);
        this.markLocal(root);
      } catch {
        // The credential is still readable for this process; a later explicit save can repair permissions.
      }
      return credential;
    } catch (error) {
      if (!isMissingFile(error)) {
        if (strict) throw new AgentAccountError("账号凭据文件不可读或损坏，尚未修改配置", "account_invalid");
        return null;
      }
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
      if (strict) throw new AgentAccountError("旧账号凭据暂时不可读取，尚未修改配置", "account_invalid");
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
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    // A migration marker must never become durable before its recovered secret:
    // after a crash, an absent credential still needs to retry the legacy reader.
    writePrivateFile(credentialFile(root), JSON.stringify(credential));
    this.markLocal(root);
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
  private readonly journalFile: string;
  private recoveryPending = false;
  private recoveryPromise: Promise<void> = Promise.resolve();
  private failedClosed = false;
  private mutationQueue: Promise<void> = Promise.resolve();
  private queuedMutations = 0;
  private readonly runtimeVersions = new Map<string, { expiresAt: number; result: Promise<boolean> }>();
  private readonly pendingCredentials = new Map<string, AgentAccountCredential | null>();
  private store: AccountStore;
  readonly modelSources: ModelSources;
  private readonly sourceMigrations = new Map<string, { at: number; accounts: Array<{ id: string; revision: string }>; preview: ModelSourceMigration }>();

  constructor(
    private readonly home: string,
    private readonly runner: AccountCommandRunner = defaultRunner,
    private readonly credentialStore: AgentAccountCredentialStore = new LocalFileCredentialStore(),
    private readonly options: AgentAccountManagerOptions = {},
  ) {
    this.storeFile = path.join(home, "agent-accounts.json");
    this.journalFile = path.join(home, ".agent-accounts-transaction.json");
    this.rootsDir = path.join(home, "agent-accounts");
    this.modelSources = new ModelSources(home, (protocol, baseUrl, model, capabilities) => cleanApiProfile(protocol === "anthropic" ? "claude" : "codex", baseUrl, model, protocol === "anthropic" ? "anthropic_compatible" : "openai_compatible", protocol, capabilities));
    mkdirSync(this.rootsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.rootsDir, 0o700);
    this.store = this.load();
    if (existsSync(this.journalFile)) {
      this.recoveryPending = true;
      this.recoveryPromise = this.recoverTransaction().catch(() => { this.failedClosed = true; }).finally(() => { this.recoveryPending = false; });
    }
  }

  /** Daemon startup must await this before opening account/session controls. */
  async ready(): Promise<void> {
    await this.recoveryPromise;
    this.assertHealthy();
  }

  private assertHealthy(): void {
    if (this.recoveryPending) throw new AgentAccountError("账号存储事务正在恢复，请稍后重试", "account_in_use");
    if (this.failedClosed) throw new AgentAccountError("账号存储事务恢复失败，已停止所有账号操作；请修复存储后重启", "account_invalid");
  }

  private assertSynchronousWrite(): void {
    this.assertHealthy();
    if (this.queuedMutations > 0) throw new AgentAccountError("账号配置正在保存，请稍后重试", "account_in_use");
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.queuedMutations += 1;
    const result = this.mutationQueue.then(async () => {
      await this.ready();
      return operation();
    });
    this.mutationQueue = result.then(() => {}, () => {});
    return result.catch((error: unknown) => {
      if (error instanceof AgentAccountError || error instanceof AgentAccountFeatureError) throw error;
      throw new AgentAccountError("账号存储操作失败，请检查存储后重试", "account_invalid");
    }).finally(() => { this.queuedMutations -= 1; });
  }

  nativeId(agent: CodeAgentKind): string {
    return NATIVE_IDS[agent];
  }

  defaultId(agent: CodeAgentKind): string {
    this.assertHealthy();
    const selected = this.store.defaults[agent];
    if (selected === NATIVE_IDS[agent]) return selected;
    if (selected && this.store.accounts.some((account) => account.id === selected && account.agent === agent)) {
      return selected;
    }
    return NATIVE_IDS[agent];
  }

  /** Metadata-only lookup for frequent session snapshots; never reads credentials or writes runtime config. */
  capabilitiesFor(accountId: string, expectedAgent?: CodeAgentKind): AgentAccountCapabilities {
    this.assertHealthy();
    const nativeAgent = (["claude", "codex"] as const).find((agent) => NATIVE_IDS[agent] === accountId);
    const account = nativeAgent ? { agent: nativeAgent } : this.store.accounts.find((entry) => entry.id === accountId);
    if (!account) throw new AgentAccountError("账号不存在或已删除", "account_not_found");
    if (expectedAgent && expectedAgent !== account.agent) throw new AgentAccountError("账号与所选 Agent 不匹配", "account_invalid");
    const stored = account as StoredAccount;
    return getAgentAccountCapabilities({ agent: account.agent, apiProfile: stored.apiProfile,
      ...(stored.invalidApiProfile ? { apiProfileError: "invalid" } : {}),
    });
  }

  resolve(accountId: string, expectedAgent?: CodeAgentKind): AccountBinding {
    this.assertHealthy();
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
    if (account.invalidApiProfile) {
      throw new AgentAccountError("API Profile 配置损坏，请修复连接配置或删除此账号", "account_invalid");
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
    const configTarget = this.configurationTarget(account);
    const overrides = readAccountOverrides(configTarget);
    const sourceBinding = this.sourceBinding(account);
    const requestedEffort = overrides.default_effort ?? sourceBinding?.defaultEffort;
    const defaultEffort = requestedEffort && (!apiProfile || supportedAccountEfforts(configTarget, overrides).includes(requestedEffort))
      ? requestedEffort : undefined;
    const defaultModel = apiProfile?.model ?? overrides.default_model;
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
            ...Object.fromEntries(Object.values(apiProfile.headers ?? {}).map((value, index) => [`PROSPERO_API_HEADER_${index}`, value])),
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
            ANTHROPIC_CUSTOM_HEADERS: Object.entries(apiProfile.headers ?? {}).map(([name, value]) => `${name}: ${value}`).join("\n"),
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
            ...claudeModelCapabilityEnvironment(apiProfile),
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
      environment: { ...environment, ...(apiProfile ? { PROSPERO_API_PROFILE_VISION: apiProfile.modelCapabilities?.vision === false ? "0" : "1" } : {}),
        ...(account.agent === "claude" && defaultModel ? { ANTHROPIC_MODEL: defaultModel } : {}),
        ...(account.agent === "claude" && defaultEffort ? { CLAUDE_CODE_EFFORT_LEVEL: defaultEffort } : {}),
      },
      ...(defaultModel ? { defaultModel } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
      ...(apiProfile ? { apiProfile } : {}),
      ...(sourceBinding ? { modelSource: this.modelSources.publicBinding(account.id)!, sourceAllowsNewSessions: this.modelSources.allowsNewSessions(sourceBinding) } : {}),
      engine: getAgentAccountEngine({ agent: account.agent, apiProfile }),
      capabilities: getAgentAccountCapabilities({ agent: account.agent, apiProfile }),
      ...(apiProfile ? { modelCapabilitySupport: getModelCapabilitySupport(apiProfile) } : {}),
      ...(apiProfile?.protocol === "openai_chat_completions" ? { adapterAgent: "opencode" as const } : {}),
      ...(apiProfile?.protocol === "openai_responses" && account.agent === "codex" && account.apiProfile
        ? { codexAppServerArgs: codexProviderArgs(account.apiProfile) }
        : {}),
      ...(credential ? { credentialKind: credential.kind } : {}),
    };
  }

  /** Session creation must not race a credential transaction; ordinary snapshots may read its old version. */
  resolveForSession(accountId: string, expectedAgent?: CodeAgentKind): AccountBinding {
    this.assertSynchronousWrite();
    return this.resolve(accountId, expectedAgent);
  }

  async apiModels(input: Omit<C2SAgentAccountApiModelsGet, "type" | "requestId">, options: ApiModelCatalogOptions = {}): Promise<AgentApiCatalogModel[]> {
    await this.ready();
    if (input.accountId) {
      if (input.protocol !== undefined || input.baseUrl !== undefined || input.apiKey !== undefined || input.headers !== undefined) throw new AgentAccountFeatureError("invalid_request", "使用保存凭据时不能替换连接地址；请先保存 Profile 或使用独立草稿凭据");
      const account = this.requireManaged(input.accountId);
      if (!account.apiProfile) throw new AgentAccountFeatureError("invalid_request", "此账号不是有效的 API Profile");
      const credential = this.claudeCredential(account.id, this.rootFor(account.agent, account.id));
      if (credential?.kind !== "api_key") throw new AgentAccountFeatureError("authentication", "请先保存此 Profile 的 API Key");
      return fetchApiModels({ ...account.apiProfile, apiKey: credential.secret }, options);
    }
    if (!input.protocol || !input.baseUrl || !input.apiKey) throw new AgentAccountFeatureError("invalid_request", "请填写协议、API 地址和 API Key 后拉取模型");
    return fetchApiModels({ protocol: input.protocol, baseUrl: input.baseUrl, apiKey: input.apiKey, ...(input.headers ? { headers: input.headers } : {}) }, options);
  }

  async modelSourceAction(action: ModelSourceAction): Promise<Omit<S2CModelSourceResult, "type" | "requestId" | "ok" | "accounts">> {
    await this.ready();
    if (action.kind === "list") return { sources: this.modelSources.list() };
    if (action.kind === "models") return { models: await this.modelSources.models(action) };
    return this.serializeMutation(async () => {
      const knownAccounts = new Set(this.store.accounts.map(account => account.id));
      if (action.kind === "migration.preview") return this.previewSourceMigrations();
      if (action.kind === "migration.apply") {
        const plan = this.sourceMigrations.get(action.migrationId);
        if (!plan || Date.now() - plan.at > 300_000) throw new AgentAccountFeatureError("conflict", "迁移预览已过期，请重新预览 / Migration preview expired; preview again");
        const entries: SourceMigrationEntry[] = plan.accounts.map(({ id, revision }) => {
          const account = this.requireManaged(id);
          if (!account.apiProfile || this.modelSources.binding(id) || this.captureApiValidationRevision(id) !== revision) throw new AgentAccountFeatureError("conflict", "Profile 已修改，请重新预览 / Profile changed; preview again");
          const credential = this.readCredential(id, this.rootFor(account.agent, id));
          if (credential?.kind !== "api_key") throw new AgentAccountFeatureError("authentication", "Profile 的凭据不可用 / Profile credential is unavailable");
          const binding = this.resolve(id);
          return { accountId: id, name: account.name, profile: account.apiProfile, secret: credential.secret, ...(binding.defaultEffort ? { defaultEffort: binding.defaultEffort } : {}) };
        });
        this.modelSources.migrate(action.name, entries, action.target);
        this.sourceMigrations.delete(action.migrationId);
      } else if (action.kind === "migration.rollback") {
        for (const id of action.accountIds) {
          const account = this.requireManaged(id);
          const binding = this.modelSources.binding(id);
          if (!binding?.legacy || !account.apiProfile) throw new AgentAccountFeatureError("invalid_request", "只能还原迁移前的独立 Profile / Only migrated profiles can be restored");
          const credential = this.credentialStore.readStrict ? this.credentialStore.readStrict(id, this.rootFor(account.agent, id)) : this.credentialStore.read(id, this.rootFor(account.agent, id));
          if (credential?.kind !== "api_key" || credential.secret !== this.modelSources.bindingCredential(id) || canonical(account.apiProfile) !== canonical(binding.profile)) throw new AgentAccountFeatureError("conflict", "原 Profile 或凭据已修改，未执行还原 / Original profile or credential changed; restore was not applied");
        }
        this.modelSources.unbind(action.accountIds);
        for (const id of action.accountIds) this.credentialCache.delete(id);
      } else if (action.kind === "bind") {
        const { source, route, profile } = this.modelSources.route(action.sourceId, action.routeId, action.revision);
        if (profile.modelCapabilities?.tools === false) throw new AgentAccountFeatureError("unsupported", "此模型未启用 Agent 所需的工具调用 / This model does not enable agent tool calls");
        const existing = this.modelSources.currentBinding(action.sourceId, action.routeId, action.revision, knownAccounts);
        if (existing) return { accountId: existing.accountId };
        const id = randomUUID();
        this.modelSources.bind(id, source.id, route.id, source.revision);
        const now = Date.now();
        const account: StoredAccount = { id, agent: profile.protocol === "anthropic" ? "claude" : "codex", name: `${source.name} / ${route.name}`.slice(0, 80), apiProfile: profile, modelSource: this.modelSources.publicBinding(id)!, createdAt: now, updatedAt: now };
        const next = structuredClone(this.store);
        next.accounts.push(account);
        try { this.commitMetadata(next); }
        catch (error) { this.modelSources.unbind([id]); throw error; }
        return { accountId: id };
      } else if (action.kind === "create") this.modelSources.create(action);
      else this.modelSources.change(action, knownAccounts);
      return { sources: this.modelSources.list() };
    });
  }

  private previewSourceMigrations(): { migrations: ModelSourceMigration[]; skippedAccounts: number } {
    this.sourceMigrations.clear();
    const groups = new Map<string, Array<{ account: StoredAccount; secret: string; revision: string }>>();
    let skippedAccounts = 0;
    for (const account of this.store.accounts) {
      if (!account.apiProfile || this.modelSources.binding(account.id)) continue;
      try {
        const credential = this.readCredential(account.id, this.rootFor(account.agent, account.id));
        if (credential?.kind !== "api_key") { skippedAccounts++; continue; }
        const key = JSON.stringify([account.apiProfile.protocol, account.apiProfile.baseUrl, account.apiProfile.headers]);
        const group = groups.get(key) ?? [];
        group.push({ account, secret: credential.secret, revision: this.captureApiValidationRevision(account.id) });
        groups.set(key, group);
      } catch { skippedAccounts++; }
    }
    const migrations: ModelSourceMigration[] = [];
    for (const group of groups.values()) {
      if (group.length > 500 || migrations.length >= 100) { skippedAccounts += group.length; continue; }
      const profile = group[0]!.account.apiProfile!;
      const preview: ModelSourceMigration = { id: randomUUID(), name: new URL(profile.baseUrl).host.slice(0, 80), baseUrl: profile.baseUrl, protocol: profile.protocol, credentialCount: new Set(group.map(item => item.secret)).size,
        accounts: group.map(item => ({ id: item.account.id, name: item.account.name, model: item.account.apiProfile!.model })) };
      this.sourceMigrations.set(preview.id, { at: Date.now(), preview, accounts: group.map(item => ({ id: item.account.id, revision: item.revision })) });
      migrations.push(preview);
    }
    return { migrations, skippedAccounts };
  }

  private configurationTarget(account: StoredAccount): AccountConfigTarget {
    if (account.invalidApiProfile) throw new AgentAccountFeatureError("invalid_config", "请先修复 API Profile 连接配置");
    return { rootsDir: this.rootsDir, agent: account.agent, accountId: account.id,
      ...(account.apiProfile ? { model: account.apiProfile.model, reasoningDisabled: account.apiProfile.modelCapabilities?.reasoning === false,
        declaredEfforts: account.apiProfile.modelCapabilities?.supportedEfforts ?? [], engine: getAgentAccountEngine(account) } : {}),
    };
  }

  async getConfig(accountId: string, sessions: SessionInfo[] = [], catalog?: AgentModelCatalog): Promise<AgentAccountConfig> {
    await this.ready();
    return getAccountConfig(this.configurationTarget(this.requireManaged(accountId)), activeCount(sessions, accountId), catalog);
  }

  async setConfig(input: Omit<C2SAgentAccountConfigSet, "type" | "requestId">, sessions: SessionInfo[] = [], catalog?: AgentModelCatalog): Promise<AgentAccountConfig> {
    return this.serializeMutation(async () => {
      const account = this.requireManaged(input.accountId);
      if (this.sourceBinding(account)) throw new AgentAccountFeatureError("forbidden", "请在模型源中编辑模型默认参数 / Edit model defaults in the model source");
      return saveAccountConfig(this.configurationTarget(account), input, activeCount(sessions, input.accountId), catalog);
    });
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
    this.assertSynchronousWrite();
    const now = Date.now();
    const account: StoredAccount = {
      id: randomUUID(),
      agent,
      name: cleanName(rawName),
      createdAt: now,
      updatedAt: now,
    };
    const next = structuredClone(this.store);
    next.accounts.push(account);
    if (!next.defaults[agent]) next.defaults[agent] = account.id;
    this.commitMetadata(next);
    return this.resolve(account.id, agent);
  }

  async createApi(
    agent: CodeAgentKind,
    rawName: string,
    input: ApiProfileInput,
  ): Promise<AccountBinding> {
    return this.serializeMutation(() => this.createApiUnlocked(agent, rawName, input));
  }

  private async createApiUnlocked(agent: CodeAgentKind, rawName: string, input: ApiProfileInput): Promise<AccountBinding> {
    const now = Date.now();
    if (input.baseUrl === undefined || input.model === undefined || input.apiKey === undefined) {
      throw new AgentAccountError("API Profile 缺少连接信息", "account_invalid");
    }
    if (input.modelCapabilities === null) {
      throw new AgentAccountError("创建 Profile 时模型能力须为配置对象或省略", "account_invalid");
    }
    const profile = cleanApiProfile(
      agent,
      input.baseUrl,
      input.model,
      input.provider,
      input.protocol,
      input.modelCapabilities,
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
    const next = structuredClone(this.store);
    next.accounts.push(account);
    if (!next.defaults[agent]) next.defaults[agent] = account.id;
    await this.commitAccountChange(next, account, credential);
    return this.resolve(account.id, agent);
  }

  async configureApi(
    accountId: string,
    input: ApiProfileInput,
    sessions: SessionInfo[] = [],
    inUse = false,
  ): Promise<void> {
    return this.serializeMutation(() => this.configureApiUnlocked(accountId, input, sessions, inUse));
  }

  private async configureApiUnlocked(accountId: string, input: ApiProfileInput, sessions: SessionInfo[], inUse: boolean): Promise<void> {
    const account = structuredClone(this.requireManaged(accountId));
    if (!account.apiProfile && !account.invalidApiProfile) {
      throw new AgentAccountError("这个账号不是第三方 API Profile", "account_invalid");
    }
    const profile = cleanApiProfile(
      account.agent,
      input.baseUrl ?? account.apiProfile?.baseUrl ?? "",
      input.model ?? account.apiProfile?.model ?? "",
      input.provider ?? account.apiProfile?.provider,
      input.protocol ?? account.apiProfile?.protocol,
      input.modelCapabilities === undefined ? account.apiProfile?.modelCapabilities : input.modelCapabilities,
    );
    const name = input.name === undefined ? account.name : cleanName(input.name);
    if (account.apiProfile?.headers) profile.headers = account.apiProfile.headers;
    const apiKey = input.apiKey?.trim() ?? "";
    const updatesCredential = apiKey.length > 0;
    const connectionChanged = JSON.stringify(profile) !== JSON.stringify(account.apiProfile);
    if (this.sourceBinding(account) && (updatesCredential || connectionChanged)) throw new AgentAccountError("请在模型源中编辑连接；旧会话绑定不会改写", "account_in_use");
    if (
      (inUse || this.options.accountInUse?.(accountId) || activeCount(sessions, accountId) > 0) &&
      (updatesCredential || connectionChanged)
    ) {
      throw new AgentAccountError("这个 Profile 仍有活动会话，只能更新名称", "account_in_use");
    }
    account.apiProfile = profile;
    delete account.invalidApiProfile;
    if (connectionChanged || updatesCredential) this.clearApiValidation(account);
    account.name = name;
    account.updatedAt = Date.now();
    const next = structuredClone(this.store);
    next.accounts = next.accounts.map((entry) => entry.id === account.id ? account : entry);
    await this.commitAccountChange(next, account, updatesCredential ? cleanApiKey(apiKey) : undefined);
  }

  rename(accountId: string, rawName: string): void {
    this.assertSynchronousWrite();
    const account = structuredClone(this.requireManaged(accountId));
    account.name = cleanName(rawName);
    account.updatedAt = Date.now();
    const next = structuredClone(this.store);
    next.accounts = next.accounts.map((entry) => entry.id === account.id ? account : entry);
    this.commitMetadata(next);
  }

  setDefault(accountId: string): void {
    this.assertSynchronousWrite();
    const binding = this.resolve(accountId);
    const next = structuredClone(this.store);
    next.defaults[binding.agent] = binding.id;
    this.commitMetadata(next);
  }

  async setCredential(
    accountId: string,
    kind: AgentCredentialKind,
    rawSecret: string,
    sessions: SessionInfo[] = [],
    inUse = false,
  ): Promise<void> {
    return this.serializeMutation(() => this.setCredentialUnlocked(accountId, kind, rawSecret, sessions, inUse));
  }

  private async setCredentialUnlocked(accountId: string, kind: AgentCredentialKind, rawSecret: string, sessions: SessionInfo[], inUse: boolean): Promise<void> {
    const account = structuredClone(this.requireManaged(accountId));
    if (this.sourceBinding(account)) throw new AgentAccountError("请在模型源中更新共享凭据", "account_in_use");
    if (account.invalidApiProfile) {
      throw new AgentAccountError("API Profile 配置损坏，请先修复连接配置", "account_invalid");
    }
    if (account.apiProfile) {
      if (inUse || this.options.accountInUse?.(accountId) || activeCount(sessions, accountId) > 0) {
        throw new AgentAccountError("这个 Profile 仍有活动会话，不能更新 API Key", "account_in_use");
      }
      if (kind !== "api_key") {
        throw new AgentAccountError("第三方 API Profile 只能使用 API Key", "account_invalid");
      }
    } else if (account.agent !== "claude") {
      throw new AgentAccountError("Codex 请使用官方设备登录流程", "account_invalid");
    }
    const credential = account.apiProfile
      ? cleanApiKey(rawSecret)
      : cleanCredential(kind, rawSecret);
    this.clearApiValidation(account);
    account.updatedAt = Date.now();
    const next = structuredClone(this.store);
    next.accounts = next.accounts.map((entry) => entry.id === account.id ? account : entry);
    await this.commitAccountChange(next, account, credential);
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
    return this.serializeMutation(() => this.logoutUnlocked(accountId, sessions, inUse));
  }

  private async logoutUnlocked(accountId: string, sessions: SessionInfo[] = [], inUse = false): Promise<void> {
    const binding = this.resolve(accountId);
    if (binding.modelSource) throw new AgentAccountError("请在模型源中管理共享凭据", "account_in_use");
    if (binding.apiProfile && (inUse || this.options.accountInUse?.(accountId) || activeCount(sessions, accountId) > 0)) {
      throw new AgentAccountError("这个 Profile 仍有活动会话，不能移除 API Key", "account_in_use");
    }
    if ((binding.agent === "claude" && binding.managed) || binding.apiProfile) {
      const root = this.rootFor(binding.agent, binding.id);
      const account = structuredClone(this.requireManaged(binding.id));
      this.clearApiValidation(account);
      account.updatedAt = Date.now();
      const next = structuredClone(this.store);
      next.accounts = next.accounts.map((entry) => entry.id === account.id ? account : entry);
      await this.commitAccountChange(next, account, null);
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
    return this.serializeMutation(() => this.deleteUnlocked(accountId, sessions, inUse));
  }

  private async deleteUnlocked(accountId: string, sessions: SessionInfo[], inUse: boolean): Promise<void> {
    const account = this.requireManaged(accountId);
    const count = activeCount(sessions, accountId);
    if (inUse || this.options.accountInUse?.(accountId) || count > 0) {
      throw new AgentAccountError(`这个账号仍有${count > 0 ? ` ${String(count)} 个会话` : "会话正在启动"}，请先结束会话`, "account_in_use");
    }
    if (account.agent === "codex" && !account.apiProfile && !account.invalidApiProfile) {
      await this.logoutUnlocked(accountId);
    }
    const next = structuredClone(this.store);
    next.accounts = next.accounts.filter((candidate) => candidate.id !== accountId);
    if (next.defaults[account.agent] === accountId) next.defaults[account.agent] = NATIVE_IDS[account.agent];
    await this.commitAccountChange(next, account, null);
    this.credentialCache.delete(account.id);
    rmSync(this.rootFor(account.agent, account.id), { recursive: true, force: true });
  }

  async snapshot(sessions: SessionInfo[]): Promise<AgentAccount[]> {
    await this.ready();
    const records = [
      ...(["claude", "codex"] as const).map((agent) => ({
        id: NATIVE_IDS[agent], agent, name: "本机默认", createdAt: 0, updatedAt: 0, managed: false,
      })),
      ...this.store.accounts.map((account) => ({ ...account, managed: true })),
    ];
    const snapshot = await Promise.all(records.map(async (record): Promise<AgentAccount> => {
      const base = {
        id: record.id, agent: record.agent, name: record.name, managed: record.managed,
        isDefault: this.defaultId(record.agent) === record.id,
        createdAt: record.createdAt, updatedAt: record.updatedAt,
        activeSessions: activeCount(sessions, record.id),
      };
      const stored = this.store.accounts.find((account) => account.id === record.id);
      if (stored?.invalidApiProfile) {
        const apiProfileError = "API Profile 配置损坏，请修复连接配置或删除此账号";
        return { ...base, status: "error", apiProfileError, detail: apiProfileError,
          capabilities: getAgentAccountCapabilities({ agent: record.agent, apiProfileError }),
        };
      }
      try {
        if (stored && (stored.agent === "claude" || stored.apiProfile)) {
          this.credentialCache.set(stored.id, this.pendingCredentials.has(stored.id)
            ? this.pendingCredentials.get(stored.id) ?? null
            : this.readCredential(stored.id, this.rootFor(stored.agent, stored.id)));
        }
        const revision = stored?.apiProfile && (stored.apiValidation || stored.apiEngineValidation)
          ? this.captureApiValidationRevision(record.id) : undefined;
        const apiValidation = stored?.apiValidation && stored.apiValidationRevision === revision
          ? stored.apiValidation : undefined;
        const apiEngineValidation = stored?.apiEngineValidation && stored.apiEngineValidationRevision === revision
          ? stored.apiEngineValidation : undefined;
        const binding = this.resolve(record.id, record.agent);
        return {
          ...base,
          ...(binding.apiProfile ? { apiProfile: binding.apiProfile } : {}),
          ...(binding.modelSource ? { modelSource: binding.modelSource } : {}),
          engine: getAgentAccountEngine(binding),
          capabilities: getAgentAccountCapabilities(binding),
          ...(apiValidation ? { apiValidation } : {}),
          ...(apiEngineValidation ? { apiEngineValidation } : {}),
          ...(binding.modelCapabilitySupport ? { modelCapabilitySupport: binding.modelCapabilitySupport } : {}),
          ...await this.status(binding, apiValidation, apiEngineValidation),
        };
      } catch {
        return { ...base, ...(stored?.apiProfile ? { apiProfile: publicApiProfile(stored.agent, stored.apiProfile) } : {}),
          status: "error", detail: "无法读取账号运行配置或凭据，请检查本地账号存储",
          capabilities: getAgentAccountCapabilities({ agent: record.agent, apiProfileError: "storage unavailable" }),
        };
      }
    }));
    this.assertHealthy();
    return snapshot;
  }

  /** Opaque connection/key revision. Never include this value in a client snapshot. */
  captureApiValidationRevision(accountId: string): string {
    const account = this.requireManaged(accountId);
    if (!account.apiProfile || account.invalidApiProfile) {
      throw new AgentAccountError("此账号没有有效的 API Profile", "account_invalid");
    }
    // Re-read before accepting a result so a replaced/removed credential cannot keep an old green badge.
    const credential = this.pendingCredentials.has(account.id) ? this.pendingCredentials.get(account.id) ?? null
      : this.readCredential(account.id, this.rootFor(account.agent, account.id));
    this.credentialCache.set(account.id, credential);
    return createHash("sha256").update(JSON.stringify({
      agent: account.agent, profile: account.apiProfile,
      credential: credential ?? null,
    })).digest("hex");
  }

  recordApiValidation(accountId: string, revision: string, validation: AgentApiValidation): boolean {
    this.assertHealthy();
    if (this.queuedMutations > 0) return false;
    const parsed = AgentApiValidationSchema.safeParse(validation);
    const account = this.store.accounts.find((candidate) => candidate.id === accountId);
    if (!account?.apiProfile || account.invalidApiProfile || !parsed.success ||
        parsed.data.engine !== getAgentAccountEngine({ agent: account.agent, apiProfile: account.apiProfile }) ||
        revision !== this.captureApiValidationRevision(accountId)) return false;
    const next = structuredClone(this.store);
    const updated = next.accounts.find((entry) => entry.id === accountId)!;
    updated.apiValidation = parsed.data;
    updated.apiValidationRevision = revision;
    this.commitMetadata(next);
    return true;
  }

  recordApiEngineValidation(accountId: string, revision: string, validation: AgentApiEngineValidation): boolean {
    this.assertHealthy();
    if (this.queuedMutations > 0) return false;
    const parsed = AgentApiEngineValidationSchema.safeParse(validation);
    const account = this.store.accounts.find((candidate) => candidate.id === accountId);
    if (!account?.apiProfile || account.invalidApiProfile || !parsed.success ||
        parsed.data.engine !== getAgentAccountEngine({ agent: account.agent, apiProfile: account.apiProfile }) ||
        revision !== this.captureApiValidationRevision(accountId)) return false;
    const next = structuredClone(this.store);
    const updated = next.accounts.find((entry) => entry.id === accountId)!;
    updated.apiEngineValidation = parsed.data;
    updated.apiEngineValidationRevision = revision;
    this.commitMetadata(next);
    return true;
  }

  private clearApiValidation(account: StoredAccount): void {
    delete account.apiValidation;
    delete account.apiValidationRevision;
    delete account.apiEngineValidation;
    delete account.apiEngineValidationRevision;
  }

  private async status(
    binding: AccountBinding,
    validation?: AgentApiValidation,
    engineValidation?: AgentApiEngineValidation,
  ): Promise<{ status: AgentAccountStatus; authMethod?: string; detail?: string }> {
    try {
      if (binding.apiProfile) {
        if (!await this.runtimeAvailable(binding)) {
          return { status: "unavailable", detail: `${binding.adapterAgent ?? binding.agent} CLI 不可用` };
        }
        if (binding.credentialKind !== "api_key") {
          return { status: "signed_out", detail: "需要配置该 Profile 的 API Key" };
        }
        return {
          status: "signed_in",
          authMethod: "API Key",
          detail: `${engineValidation ? engineValidation.status === "passed" ? "引擎验证通过" : "引擎验证失败" : validation ? validation.status === "passed" ? "协议测试通过" : "连接测试失败" : "已配置，尚未测试连接"} · ${binding.apiProfile.protocol ?? binding.apiProfile.provider} · ${new URL(binding.apiProfile.baseUrl).host}`,
        };
      }
      if (binding.agent === "claude") {
        if (binding.managed && !binding.credentialKind) {
          if (!await this.runtimeAvailable(binding)) return { status: "unavailable", detail: "claude CLI 不可用" };
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

  private runtimeAvailable(binding: AccountBinding): Promise<boolean> {
    const engine = binding.adapterAgent ?? binding.agent;
    const command = programCommandFor(engine, ["--version"], process.platform, binding.environment);
    const key = JSON.stringify([engine, executableIdentity(engine, binding.environment), executableIdentity(command.file, binding.environment)]);
    const now = this.options.now ?? Date.now;
    const current = this.runtimeVersions.get(key);
    if (current && current.expiresAt > now()) return current.result;
    // Cache only CLI availability, never per-account credentials or provider validation.
    const entry = { expiresAt: Number.POSITIVE_INFINITY, result: Promise.resolve(false) };
    entry.result = this.runner(engine, ["--version"], binding.environment).then((result) => result.exitCode === 0, () => false).then((available) => {
      entry.expiresAt = now() + (available ? this.options.runtimeTtlMs ?? 60_000 : this.options.runtimeFailureTtlMs ?? 5_000);
      return available;
    });
    this.runtimeVersions.set(key, entry);
    if (this.runtimeVersions.size > 32) this.runtimeVersions.delete(this.runtimeVersions.keys().next().value!);
    return entry.result;
  }

  private requireManaged(accountId: string): StoredAccount {
    this.assertHealthy();
    if (Object.values(NATIVE_IDS).includes(accountId)) {
      throw new AgentAccountError("本机默认环境不能重命名或删除", "account_not_managed");
    }
    const account = this.store.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new AgentAccountError("账号不存在或已删除", "account_not_found");
    return account;
  }

  private claudeCredential(accountId: string, root: string): AgentAccountCredential | null {
    if (this.pendingCredentials.has(accountId)) return this.pendingCredentials.get(accountId) ?? null;
    if (this.credentialCache.has(accountId)) {
      return this.credentialCache.get(accountId) ?? null;
    }
    const credential = this.readCredential(accountId, root);
    this.credentialCache.set(accountId, credential);
    return credential;
  }

  private sourceBinding(account: StoredAccount) {
    if (!account.apiProfile || !account.modelSource && !this.modelSources.isBound(account.id)) return undefined;
    const binding = this.modelSources.binding(account.id);
    if (!binding) throw new AgentAccountError("模型源绑定缺失，已停止连接", "account_invalid");
    return binding;
  }

  private readCredential(accountId: string, root: string): AgentAccountCredential | null {
    try {
      const account = this.store.accounts.find(item => item.id === accountId);
      if (account?.apiProfile) {
        const binding = this.sourceBinding(account);
        if (binding) {
          if (canonical(binding.profile) !== canonical(account.apiProfile)) throw new AgentAccountError("模型源绑定与账号不一致", "account_invalid");
          return { kind: "api_key", secret: this.modelSources.bindingCredential(accountId)! };
        }
      }
      const credential = this.credentialStore.readStrict
        ? this.credentialStore.readStrict(accountId, root)
        : this.credentialStore.read(accountId, root);
      return credential ? { ...credential } : null;
    }
    catch { throw new AgentAccountError("读取账号凭据失败", "account_invalid"); }
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
      const raw: unknown = JSON.parse(readFileSync(this.storeFile, "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid account metadata");
      const metadata = raw as Record<string, unknown>;
      if (!Array.isArray(metadata["accounts"]) || (metadata["version"] !== undefined && metadata["version"] !== 1) ||
          (metadata["defaults"] !== undefined && (!metadata["defaults"] || typeof metadata["defaults"] !== "object" || Array.isArray(metadata["defaults"])))) {
        throw new Error("invalid account metadata structure");
      }
      const store = parseStore(raw);
      const rawDefaults = (metadata["defaults"] ?? {}) as Record<string, unknown>;
      if (store.accounts.length !== metadata["accounts"].length || !validAccountIdentities(store.accounts) || !validAccountDefaults(store) ||
          (["claude", "codex"] as const).some((agent) => rawDefaults[agent] !== undefined && rawDefaults[agent] !== store.defaults[agent])) {
        throw new Error("invalid account metadata entries");
      }
      return store;
    } catch (error) {
      if (!isMissingFile(error)) this.failedClosed = true;
      return { version: 1, accounts: [], defaults: {} };
    }
  }

  private writeMetadata(store: AccountStore): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    (this.options.metadataWriter ?? writePrivateFile)(this.storeFile, JSON.stringify(serializeStore(store), null, 2));
  }

  private commitMetadata(store: AccountStore): void {
    const readCurrent = (): string | undefined => {
      try { return readFileSync(this.storeFile, "utf8"); }
      catch (error) { if (isMissingFile(error)) return undefined; throw error; }
    };
    let previous: string | undefined;
    try { previous = readCurrent(); }
    catch { throw new AgentAccountError("无法读取账号元数据，尚未修改配置", "account_invalid"); }
    try { this.writeMetadata(store); }
    catch {
      // Atomic rename may have completed before chmod/directory fsync failed.
      // A metadata-only write has no key transition to replay; refuse all reads
      // if its observed file changed or became unreadable rather than publishing stale memory.
      try { this.failedClosed ||= readCurrent() !== previous; }
      catch { this.failedClosed = true; }
      throw new AgentAccountError(this.failedClosed
        ? "账号元数据保存结果不确定，已停止所有账号操作；请检查存储后重启"
        : "账号元数据保存失败，原配置已保留", "account_invalid");
    }
    this.store = store;
  }

  private writeJournal(transaction: AccountTransaction): void {
    const contents = JSON.stringify(transaction);
    if (Buffer.byteLength(contents) > 4 * 1024 * 1024) throw new AgentAccountError("账号事务超出存储大小上限，尚未修改配置", "account_invalid");
    writePrivateFile(this.journalFile, contents);
  }

  private clearJournal(): void {
    unlinkSync(this.journalFile);
    syncDirectory(this.home);
  }

  private async writeTransactionCredential(change: AccountTransaction["credential"]): Promise<void> {
    const root = this.rootFor(change.agent, change.accountId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    if (change.value) await this.credentialStore.write(change.accountId, root, { ...change.value });
    else await this.credentialStore.delete(change.accountId, root);
    syncDirectory(root);
    syncDirectory(path.dirname(root));
    syncDirectory(this.rootsDir);
  }

  private readTransaction(): { transaction: AccountTransaction; store: AccountStore } {
    const stat = statSync(this.journalFile);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("invalid account transaction file");
    const raw = JSON.parse(readFileSync(this.journalFile, "utf8")) as AccountTransaction;
    if (!raw || raw.version !== 1 || !raw.credential || !isCodeAgent(raw.credential.agent) ||
        typeof raw.credential.accountId !== "string" ||
        !/^[A-Za-z0-9-]{1,100}$/.test(raw.credential.accountId) || Object.values(NATIVE_IDS).includes(raw.credential.accountId)) {
      throw new Error("invalid account transaction");
    }
    const store = parseStore(raw.metadata);
    if (!validAccountIdentities(store.accounts) || !validAccountDefaults(store) || canonical(serializeStore(store)) !== canonical(raw.metadata)) throw new Error("invalid account transaction metadata");
    if (raw.credential.value !== null) {
      const credential = parseCredential(JSON.stringify(raw.credential.value));
      if (!credential || canonical(credential) !== canonical(raw.credential.value)) throw new Error("invalid account transaction credential");
    }
    const account = store.accounts.find((entry) => entry.id === raw.credential.accountId);
    if (account && account.agent !== raw.credential.agent) throw new Error("invalid account transaction agent");
    if (!account && raw.credential.value !== null) throw new Error("invalid orphan transaction credential");
    if (account?.apiProfile && raw.credential.value && raw.credential.value.kind !== "api_key") throw new Error("invalid profile transaction credential");
    if (canonical(raw) !== canonical({ version: 1, metadata: raw.metadata, credential: raw.credential })) throw new Error("invalid transaction fields");
    chmodSync(this.journalFile, 0o600);
    return { transaction: raw, store };
  }

  private async recoverTransaction(): Promise<void> {
    const { transaction, store } = this.readTransaction();
    await this.writeTransactionCredential(transaction.credential);
    this.writeMetadata(store);
    this.clearJournal();
    this.store = store;
    this.credentialCache.set(transaction.credential.accountId, transaction.credential.value);
    this.failedClosed = false;
  }

  /** Journal is durable before either resource changes; recovery redoes its complete target state. */
  private async commitAccountChange(next: AccountStore, account: StoredAccount, credential?: AgentAccountCredential | null): Promise<void> {
    if (credential === undefined) {
      this.commitMetadata(next);
      return;
    }
    const previous = this.store;
    const previousCredential = previous.accounts.some((entry) => entry.id === account.id)
      ? this.readCredential(account.id, this.rootFor(account.agent, account.id)) : null;
    const change = { accountId: account.id, agent: account.agent, value: credential };
    const transaction: AccountTransaction = { version: 1, metadata: serializeStore(next), credential: change };
    this.pendingCredentials.set(account.id, previousCredential);
    this.credentialCache.set(account.id, previousCredential);
    let journalWritten = false;
    let committed = false;
    try {
      this.writeJournal(transaction);
      journalWritten = true;
      await this.writeTransactionCredential(change);
      this.writeMetadata(next);
      committed = true;
      this.store = next;
      this.credentialCache.set(account.id, credential);
      this.clearJournal();
    } catch {
      if (committed) {
        // Metadata commit succeeded: retain the redo journal and fail the entire manager closed.
        this.failedClosed = true;
      } else if (journalWritten || existsSync(this.journalFile)) {
        try {
          const rollback = { accountId: account.id, agent: account.agent, value: previousCredential };
          this.writeJournal({ version: 1, metadata: serializeStore(previous), credential: rollback });
          await this.writeTransactionCredential(rollback);
          this.writeMetadata(previous);
          this.clearJournal();
          this.credentialCache.set(account.id, previousCredential);
        } catch { this.failedClosed = true; }
      }
      throw new AgentAccountError(this.failedClosed
        ? "账号保存失败且恢复尚未完成，已停止所有账号操作；请修复存储后重启"
        : "账号保存失败，原配置和凭据已保留", "account_invalid");
    } finally {
      this.pendingCredentials.delete(account.id);
    }
  }
}
