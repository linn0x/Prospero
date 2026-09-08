import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ModelSourceSchema, type AgentApiCatalogModel, type AgentApiProvider, type AgentApiProtocol, type AgentModelCapabilities, type AgentReasoningEffort, type ModelSource, type ModelSourceAction, type ModelSourceBinding, type ModelSourceRoute } from "@prospero/protocol";
import { AgentAccountFeatureError } from "./agent-account-feature-error.js";
import { fetchApiModels, type ApiModelCatalogInput } from "./agent-api-models.js";

export type SourceProfile = { provider: AgentApiProvider; protocol: AgentApiProtocol; baseUrl: string; model: string; modelCapabilities?: AgentModelCapabilities };
type NormalizeProfile = (protocol: AgentApiProtocol, baseUrl: string, model: string, capabilities?: AgentModelCapabilities) => SourceProfile;
type Credential = { sourceId: string; id: string; revision: number; secret: string };
export type FrozenSourceBinding = Omit<ModelSourceBinding, "current"> & { accountId: string; credentialId: string; credentialRevision: number; profile: SourceProfile; defaultEffort?: AgentReasoningEffort };
type Registry = { version: 1; sources: ModelSource[]; credentials: Credential[]; bindings: FrozenSourceBinding[]; creations?: Array<{ operationId: string; sourceId: string; fingerprint: string }> };
export type SourceMigrationEntry = { accountId: string; name: string; profile: SourceProfile; secret: string; defaultEffort?: AgentReasoningEffort };
type Options = { fetchModels?: (input: ApiModelCatalogInput) => Promise<AgentApiCatalogModel[]>; now?: () => number };
const idPattern = /^[A-Za-z0-9-]{1,100}$/;
const MAX_BYTES = 8 * 1024 * 1024;

function fail(code: "invalid_request" | "invalid_config" | "not_found" | "conflict" | "storage" | "busy" | "limit_exceeded", message: string): never {
  throw new AgentAccountFeatureError(code, message);
}

function key(value: string): string {
  const secret = value.trim();
  if (!secret || secret.length > 8192 || /[\u0000-\u001f\u007f]/.test(secret)) fail("invalid_request", "API Key 格式无效 / Invalid API key");
  return secret;
}

function signature(file: string): string {
  if (!existsSync(file)) return "absent";
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())) fail("storage", "模型源存储文件不安全 / Unsafe model source storage");
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function writePrivate(file: string, body: string, expected: string): string {
  const directory = path.dirname(file), temporary = path.join(directory, `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    if (signature(file) !== expected) fail("conflict", "模型源文件已修改，请刷新后重试 / Model source storage changed; refresh and retry");
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, body); fsyncSync(fd); closeSync(fd); fd = undefined;
    if (signature(file) !== expected) fail("conflict", "模型源文件已修改，请刷新后重试 / Model source storage changed; refresh and retry");
    renameSync(temporary, file);
    if (process.platform !== "win32") { const dir = openSync(directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
    return signature(file);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}

export class ModelSources {
  private readonly root: string;
  private readonly file: string;
  private readonly membershipFile: string;
  private membership: Set<string> | undefined;
  private membershipSignature = "absent";
  private data: Registry | undefined;
  private indexed: Registry | undefined;
  private sourcesById = new Map<string, ModelSource>();
  private bindingsByAccount = new Map<string, FrozenSourceBinding>();
  private routesBySource = new Map<string, Map<string, ModelSourceRoute>>();
  private credentialsByVersion = new Map<string, Credential>();
  private diskSignature = "absent";
  private readonly catalogs = new Map<string, { at: number; models: AgentApiCatalogModel[] }>();
  private readonly requests = new Map<string, Promise<AgentApiCatalogModel[]>>();

  constructor(home: string, private readonly normalize: NormalizeProfile, private readonly options: Options = {}) {
    this.root = path.join(home, "model-sources");
    this.file = path.join(this.root, ".registry.json");
    this.membershipFile = path.join(home, "model-source-bindings.json");
  }

  list(): ModelSource[] { return this.load().sources.map(source => ModelSourceSchema.parse(source)); }

  source(id: string, revision?: number): ModelSource {
    return structuredClone(this.sourceRecord(id, revision));
  }

  private sourceRecord(id: string, revision?: number): ModelSource {
    this.index();
    const source = this.sourcesById.get(id);
    if (!source) fail("not_found", "模型源不存在 / Model source not found");
    if (revision !== undefined && source.revision !== revision) fail("conflict", "模型源已修改，请刷新后重试 / Model source changed; refresh and retry");
    return source;
  }

  private index(): void {
    const data = this.load();
    if (this.indexed === data) return;
    this.sourcesById = new Map(data.sources.map(source => [source.id, source]));
    this.bindingsByAccount = new Map(data.bindings.map(binding => [binding.accountId, binding]));
    this.routesBySource = new Map(data.sources.map(source => [source.id, new Map(source.routes.map(route => [route.id, route]))]));
    this.credentialsByVersion = new Map(data.credentials.map(credential => [`${credential.sourceId}:${credential.id}:${credential.revision}`, credential]));
    this.indexed = data;
  }

  binding(accountId: string): FrozenSourceBinding | undefined {
    this.index();
    const binding = this.bindingsByAccount.get(accountId);
    return binding && structuredClone(binding);
  }

  publicBinding(accountId: string): ModelSourceBinding | undefined {
    this.index();
    const binding = this.bindingsByAccount.get(accountId);
    if (!binding) return undefined;
    return { sourceId: binding.sourceId, routeId: binding.routeId, sourceName: binding.sourceName, routeName: binding.routeName, revision: binding.revision, legacy: binding.legacy,
      current: this.sourcesById.get(binding.sourceId)!.revision === binding.revision };
  }

  allowsNewSessions(binding: FrozenSourceBinding): boolean {
    const source = this.sourceRecord(binding.sourceId);
    const route = this.routesBySource.get(source.id)?.get(binding.routeId);
    return source.enabled && route?.enabled === true && route.modelCapabilities?.tools !== false;
  }

  bindingCredential(accountId: string): string | undefined {
    this.index();
    const binding = this.bindingsByAccount.get(accountId);
    return binding && this.credential(binding.sourceId, binding.credentialId, binding.credentialRevision).secret;
  }

  bindingAccounts(sourceId: string): Array<{ accountId: string; legacy: boolean }> {
    return this.load().bindings.filter(item => item.sourceId === sourceId).map(({ accountId, legacy }) => ({ accountId, legacy }));
  }

  currentBinding(sourceId: string, routeId: string, revision: number, knownAccounts: ReadonlySet<string>): FrozenSourceBinding | undefined {
    this.route(sourceId, routeId, revision);
    const binding = this.load().bindings.find(item => item.sourceId === sourceId && item.routeId === routeId && item.revision === revision && knownAccounts.has(item.accountId));
    return binding && structuredClone(binding);
  }

  route(sourceId: string, routeId: string, revision: number): { source: ModelSource; route: ModelSourceRoute; profile: SourceProfile } {
    const source = this.source(sourceId, revision);
    const route = source.routes.find(item => item.id === routeId);
    if (!source.enabled || !route?.enabled) fail("invalid_request", "模型源或模型已停用 / Model source or route is disabled");
    const endpoint = source.endpoints.find(item => item.protocol === route.protocol);
    if (!endpoint) fail("invalid_config", "模型协议缺少连接地址 / Missing protocol endpoint");
    return { source, route, profile: this.normalize(route.protocol, endpoint.baseUrl, route.model, route.modelCapabilities) };
  }

  bind(accountId: string, sourceId: string, routeId: string, revision: number, legacy = false): FrozenSourceBinding {
    const { source, route, profile } = this.route(sourceId, routeId, revision);
    if (!idPattern.test(accountId) || this.binding(accountId)) fail("conflict", "账号已有模型源绑定 / Account already has a model source binding");
    const credential = source.credentials.find(item => item.id === route.credentialId);
    if (!credential) fail("invalid_config", "模型凭据不存在 / Model credential not found");
    const binding: FrozenSourceBinding = { accountId, sourceId, routeId, revision, sourceName: source.name, routeName: route.name, legacy, profile, credentialId: credential.id, credentialRevision: credential.revision,
      ...(route.defaultEffort ? { defaultEffort: route.defaultEffort } : {}) };
    const next = structuredClone(this.load());
    next.bindings.push(binding);
    this.save(next);
    return structuredClone(binding);
  }

  unbind(accountIds: readonly string[]): void {
    const ids = new Set(accountIds);
    const next = structuredClone(this.load());
    next.bindings = next.bindings.filter(binding => !ids.has(binding.accountId));
    this.save(next);
  }

  create(input: Extract<ModelSourceAction, { kind: "create" }>): ModelSource {
    const next = structuredClone(this.load());
    const endpoints = this.endpoints(input.endpoints), secret = key(input.credential.apiKey);
    const fingerprint = createHash("sha256").update(JSON.stringify([input.name, endpoints, input.credential.name, secret, input.routes ?? []])).digest("hex");
    const receipt = input.operationId && next.creations?.find(item => item.operationId === input.operationId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint || !next.sources.some(source => source.id === receipt.sourceId)) fail("conflict", "此创建请求已处理，请刷新确认 / This creation request was already processed; refresh to confirm");
      return this.source(receipt.sourceId);
    }
    const id = randomUUID(), credentialId = randomUUID(), now = this.now();
    const routes = (input.routes ?? []).map(route => ({ ...route, id: randomUUID(), credentialId }));
    const source: ModelSource = { id, name: input.name, revision: 1, enabled: true, endpoints, credentials: [{ id: credentialId, name: input.credential.name, revision: 1 }], routes, ...(routes[0] ? { defaultRouteId: routes[0].id } : {}), createdAt: now, updatedAt: now };
    next.sources.push(source);
    next.credentials.push({ sourceId: id, id: credentialId, revision: 1, secret });
    if (input.operationId) next.creations = [...(next.creations ?? []), { operationId: input.operationId, sourceId: id, fingerprint }];
    this.save(next);
    return this.source(id);
  }

  change(input: Extract<ModelSourceAction, { sourceId: string }>, knownAccounts: ReadonlySet<string>): void {
    const source = this.source(input.sourceId, input.revision);
    const next = structuredClone(this.load());
    switch (input.kind) {
      case "update":
        if (input.name !== undefined) source.name = input.name;
        if (input.enabled !== undefined) source.enabled = input.enabled;
        if (input.endpoints) source.endpoints = this.endpoints(input.endpoints);
        if (input.defaultRouteId) source.defaultRouteId = input.defaultRouteId;
        break;
      case "credential.set": {
        const existing = input.credentialId && source.credentials.find(item => item.id === input.credentialId);
        if (input.credentialId && !existing) fail("not_found", "凭据不存在 / Credential not found");
        if (!existing && !input.apiKey) fail("invalid_request", "新增凭据需要 API Key / A new credential requires an API key");
        const credential = existing || { id: randomUUID(), name: input.name, revision: 0 };
        credential.name = input.name;
        if (input.apiKey !== undefined) {
          credential.revision++;
          next.credentials.push({ sourceId: source.id, id: credential.id, revision: credential.revision, secret: key(input.apiKey) });
        }
        if (!existing) source.credentials.push(credential);
        break;
      }
      case "credential.remove":
        if (source.routes.some(route => route.credentialId === input.credentialId)) fail("busy", "仍有模型引用此凭据，请先修改模型 / Models still reference this credential");
        source.credentials = source.credentials.filter(item => item.id !== input.credentialId);
        break;
      case "routes.set":
        for (const inputRoute of input.routes) {
          if (inputRoute.id && !source.routes.some(route => route.id === inputRoute.id)) fail("not_found", "模型路由不存在 / Model route not found");
          const route = { ...inputRoute, id: inputRoute.id ?? randomUUID() };
          source.routes = [...source.routes.filter(item => item.id !== route.id), route];
          source.defaultRouteId ??= route.id;
        }
        break;
      case "route.remove":
        source.routes = source.routes.filter(route => route.id !== input.routeId);
        if (source.defaultRouteId === input.routeId) {
          delete source.defaultRouteId;
          if (source.routes[0]) source.defaultRouteId = source.routes[0].id;
        }
        break;
      case "delete":
        if (next.bindings.some(binding => binding.sourceId === source.id && knownAccounts.has(binding.accountId))) fail("busy", "已有账号引用此模型源，可先停用以保留会话 / Referenced by accounts; disable the source to preserve sessions");
        next.sources = next.sources.filter(item => item.id !== source.id);
        next.credentials = next.credentials.filter(item => item.sourceId !== source.id);
        next.bindings = next.bindings.filter(item => item.sourceId !== source.id);
        next.creations = next.creations?.map(item => item.sourceId === source.id ? { ...item, fingerprint: "deleted" } : item) ?? [];
        this.save(next);
        return;
      default: fail("invalid_request", "不支持的模型源修改 / Unsupported model source update");
    }
    source.revision++;
    source.updatedAt = this.now();
    next.sources = next.sources.map(item => item.id === source.id ? source : item);
    this.save(next);
  }

  migrate(name: string, entries: SourceMigrationEntry[], target?: { sourceId: string; revision: number }): ModelSource {
    if (!entries.length || entries.length > 500) fail("invalid_request", "没有可迁移的 Profile / No profiles to migrate");
    const next = structuredClone(this.load());
    const sourceId = target?.sourceId ?? randomUUID(), now = this.now();
    const source: ModelSource = target ? this.source(target.sourceId, target.revision) : { id: sourceId, name, revision: 1, enabled: true, endpoints: [], credentials: [], routes: [], createdAt: now, updatedAt: now };
    if (target) { source.revision++; source.updatedAt = now; }
    for (const entry of entries) {
      if (next.bindings.some(binding => binding.accountId === entry.accountId)) fail("conflict", "Profile 已被迁移，请重新预览 / Profile already migrated; preview again");
      const endpoint = source.endpoints.find(item => item.protocol === entry.profile.protocol);
      if (endpoint && endpoint.baseUrl !== entry.profile.baseUrl) fail("invalid_request", "同一协议的连接地址不一致 / Protocol endpoint addresses differ");
      if (!endpoint) source.endpoints.push({ protocol: entry.profile.protocol, baseUrl: entry.profile.baseUrl });
      const secret = key(entry.secret);
      let credential = next.credentials.find(item => item.sourceId === sourceId && item.secret === secret && source.credentials.some(current => current.id === item.id && current.revision === item.revision));
      if (!credential) {
        credential = { sourceId, id: randomUUID(), revision: 1, secret };
        next.credentials.push(credential);
        source.credentials.push({ id: credential.id, revision: 1, name: `Key ${source.credentials.length + 1}` });
      }
      const route: ModelSourceRoute = { id: randomUUID(), name: entry.name, protocol: entry.profile.protocol, model: entry.profile.model, credentialId: credential.id, enabled: true,
        ...(entry.profile.modelCapabilities ? { modelCapabilities: entry.profile.modelCapabilities } : {}), ...(entry.defaultEffort ? { defaultEffort: entry.defaultEffort } : {}) };
      source.routes.push(route);
      source.defaultRouteId ??= route.id;
      next.bindings.push({ accountId: entry.accountId, sourceId, routeId: route.id, sourceName: source.name, routeName: route.name, revision: source.revision, legacy: true, credentialId: credential.id, credentialRevision: credential.revision, profile: entry.profile,
        ...(entry.defaultEffort ? { defaultEffort: entry.defaultEffort } : {}) });
    }
    if (source.credentials.length > 32 || source.routes.length > 500) fail("limit_exceeded", "模型源最多支持 32 组凭据与 500 个模型，请拆分迁移 / Split this migration: a source supports 32 credentials and 500 models");
    if (target) next.sources = next.sources.map(item => item.id === sourceId ? source : item);
    else next.sources.push(source);
    this.save(next);
    return this.source(sourceId);
  }

  async models(input: Extract<ModelSourceAction, { kind: "models" }>): Promise<AgentApiCatalogModel[]> {
    const source = this.source(input.sourceId, input.revision);
    const endpoint = source.endpoints.find(item => item.protocol === input.protocol);
    const credential = source.credentials.find(item => item.id === input.credentialId);
    if (!endpoint || !credential) fail("not_found", "连接或凭据不存在 / Endpoint or credential not found");
    const cacheKey = JSON.stringify([source.id, endpoint.protocol, endpoint.baseUrl, credential.id, credential.revision]);
    const cached = this.catalogs.get(cacheKey);
    if (cached && this.now() - cached.at < 300_000) return structuredClone(cached.models);
    const pending = this.requests.get(cacheKey);
    if (pending) return structuredClone(await pending);
    if (this.requests.size >= 4) fail("busy", "模型目录繁忙，请稍后重试 / Model catalog is busy");
    const request = (this.options.fetchModels ?? fetchApiModels)({ protocol: endpoint.protocol, baseUrl: endpoint.baseUrl, apiKey: this.credential(source.id, credential.id, credential.revision).secret }).then(models => {
      this.catalogs.delete(cacheKey);
      this.catalogs.set(cacheKey, { at: this.now(), models: structuredClone(models) });
      while (this.catalogs.size > 40) this.catalogs.delete(this.catalogs.keys().next().value!);
      return models;
    }).finally(() => { this.requests.delete(cacheKey); });
    this.requests.set(cacheKey, request);
    return structuredClone(await request);
  }

  private credential(sourceId: string, id: string, revision: number): Credential {
    this.index();
    const credential = this.credentialsByVersion.get(`${sourceId}:${id}:${revision}`);
    if (!credential) fail("storage", "模型源凭据缺失，已停止连接 / Missing model source credential");
    return credential;
  }

  private endpoints(endpoints: ModelSource["endpoints"]): ModelSource["endpoints"] {
    if (new Set(endpoints.map(item => item.protocol)).size !== endpoints.length) fail("invalid_request", "每种协议只能配置一个端点 / Each protocol needs a single endpoint");
    return endpoints.map(item => ({ protocol: item.protocol, baseUrl: this.normalize(item.protocol, item.baseUrl, "catalog").baseUrl }));
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  isBound(accountId: string): boolean { return this.membershipIds().has(accountId); }

  private membershipIds(): Set<string> {
    const current = signature(this.membershipFile);
    if (this.membership && current === this.membershipSignature) return this.membership;
    if (current === "absent") {
      const ids = new Set(existsSync(this.file) ? this.load().bindings.map(binding => binding.accountId) : []);
      this.membership = ids; this.membershipSignature = current;
      if (existsSync(this.file)) this.writeMembership(ids);
      return ids;
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.membershipFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (fstatSync(fd).size > MAX_BYTES) throw new Error();
      const value = JSON.parse(readFileSync(fd, "utf8")) as { version?: unknown; accountIds?: unknown };
      if (value?.version !== 1 || !Array.isArray(value.accountIds) || value.accountIds.length > 10000 || value.accountIds.some(id => typeof id !== "string" || !idPattern.test(id)) || signature(this.membershipFile) !== current) throw new Error();
      this.membership = new Set(value.accountIds as string[]); this.membershipSignature = current;
      return this.membership;
    } catch { return fail("storage", "模型源绑定索引无法读取 / Model source binding index is unreadable"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  private writeMembership(ids: Set<string>): void {
    if (this.membershipSignature !== "absent" && this.membership?.size === ids.size && [...ids].every(id => this.membership!.has(id))) return;
    const body = JSON.stringify({ version: 1, accountIds: [...ids] });
    this.membershipSignature = writePrivate(this.membershipFile, body, this.membershipSignature);
    this.membership = ids;
  }

  private checkRoot(create = false): void {
    if (!existsSync(this.root)) { if (!create) return; mkdirSync(this.root, { mode: 0o700 }); }
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid())) fail("storage", "模型源目录不安全 / Unsafe model source directory");
  }

  private validate(value: Registry): Registry {
    if (value.version !== 1 || !Array.isArray(value.sources) || value.sources.length > 100 || !Array.isArray(value.credentials) || value.credentials.length > 10_000 || !Array.isArray(value.bindings) || value.bindings.length > 10_000) fail("limit_exceeded", "模型源存储格式或数量超限 / Model source storage limit or format error");
    const sources = value.sources.map(item => ModelSourceSchema.parse(item));
    const creations = value.creations ?? [];
    if (!Array.isArray(creations) || creations.length > 10000 || new Set(creations.map(item => item.operationId)).size !== creations.length || creations.some(item => !idPattern.test(item.operationId) || !idPattern.test(item.sourceId) || !/^(?:[a-f0-9]{64}|deleted)$/.test(item.fingerprint))) fail("invalid_config", "模型源创建记录无效 / Invalid source creation records");
    if (new Set(sources.map(item => item.id)).size !== sources.length || new Set(value.bindings.map(item => item.accountId)).size !== value.bindings.length ||
      new Set(value.credentials.map(item => `${item.sourceId}:${item.id}:${item.revision}`)).size !== value.credentials.length) fail("invalid_config", "模型源标识冲突 / Duplicate model source identity");
    for (const credential of value.credentials) if (!idPattern.test(credential.id) || !sources.some(source => source.id === credential.sourceId) || !Number.isSafeInteger(credential.revision) || credential.revision < 1 || typeof credential.secret !== "string" || key(credential.secret) !== credential.secret) fail("invalid_config", "模型源凭据格式错误 / Invalid model source credential");
    const hasCredential = (sourceId: string, id: string, revision: number) => value.credentials.some(item => item.sourceId === sourceId && item.id === id && item.revision === revision);
    for (const source of sources) {
      source.endpoints = this.endpoints(source.endpoints);
      if (new Set(source.credentials.map(item => item.id)).size !== source.credentials.length || new Set(source.routes.map(item => item.id)).size !== source.routes.length) fail("invalid_config", "模型或凭据标识冲突 / Duplicate route or credential identity");
      if (source.defaultRouteId && !source.routes.some(route => route.id === source.defaultRouteId)) fail("invalid_config", "默认模型不存在 / Default model not found");
      for (const credential of source.credentials) if (!hasCredential(source.id, credential.id, credential.revision)) fail("invalid_config", "模型源凭据缺失 / Missing model source credential");
      for (const route of source.routes) {
        const endpoint = source.endpoints.find(item => item.protocol === route.protocol);
        if (!endpoint || !source.credentials.some(item => item.id === route.credentialId)) fail("invalid_config", "模型引用了不存在的连接或凭据 / Invalid model endpoint or credential reference");
        this.normalize(route.protocol, endpoint.baseUrl, route.model, route.modelCapabilities);
        if (route.defaultEffort && (route.protocol === "openai_chat_completions" || !route.modelCapabilities?.supportedEfforts?.includes(route.defaultEffort))) fail("invalid_config", "推理档位不受此模型路由支持 / Unsupported reasoning effort");
      }
    }
    for (const binding of value.bindings) {
      if (!idPattern.test(binding.accountId) || !sources.some(source => source.id === binding.sourceId) || !idPattern.test(binding.routeId) || !Number.isSafeInteger(binding.revision) || binding.revision < 1 || typeof binding.legacy !== "boolean" || typeof binding.sourceName !== "string" || binding.sourceName.length > 80 || typeof binding.routeName !== "string" || binding.routeName.length > 80 || !hasCredential(binding.sourceId, binding.credentialId, binding.credentialRevision)) fail("invalid_config", "会话模型绑定格式错误 / Invalid session model binding");
      binding.profile = this.normalize(binding.profile.protocol, binding.profile.baseUrl, binding.profile.model, binding.profile.modelCapabilities);
    }
    return { version: 1, sources, credentials: value.credentials, bindings: value.bindings, creations };
  }

  private load(): Registry {
    this.checkRoot();
    const currentSignature = signature(this.file);
    if (this.data && currentSignature === this.diskSignature) return this.data;
    if (currentSignature === "absent") {
      if (this.data && this.diskSignature !== "absent") fail("storage", "模型源文件已消失，已停止连接 / Model source storage disappeared");
      this.data = { version: 1, sources: [], credentials: [], bindings: [] };
      return this.data;
    }
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      if (fstatSync(fd).size > MAX_BYTES) fail("limit_exceeded", "模型源文件过大 / Model source storage is too large");
      const data = this.validate(JSON.parse(readFileSync(fd, "utf8")) as Registry);
      if (signature(this.file) !== currentSignature) fail("conflict", "模型源文件已修改，请重试 / Model source storage changed");
      this.data = data;
      this.diskSignature = currentSignature;
      return data;
    } catch { return fail("storage", "模型源存储无法读取，原文件已保留 / Model source storage is unreadable; the original file was preserved"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  private save(data: Registry): void {
    const validated = this.validate(data);
    const body = JSON.stringify(validated);
    if (Buffer.byteLength(body) > MAX_BYTES) fail("limit_exceeded", "模型源存储空间已达上限 / Model source storage limit reached");
    this.checkRoot(true);
    try {
      const ids = new Set(validated.bindings.map(binding => binding.accountId));
      this.membershipIds();
      this.writeMembership(new Set([...(this.data?.bindings.map(binding => binding.accountId) ?? []), ...ids]));
      this.diskSignature = writePrivate(this.file, body, this.diskSignature);
      this.data = validated;
      this.writeMembership(ids);
    } catch (error) {
      if (error instanceof AgentAccountFeatureError) throw error;
      fail("storage", "模型源保存失败，请刷新确认后重试 / Model source save failed; refresh before retrying");
    }
  }
}
