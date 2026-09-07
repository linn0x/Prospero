import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";
import { LineCounter, parseDocument, stringify as stringifyYaml } from "yaml";
import { AgentReasoningEffortSchema, type AgentAccountConfig, type AgentReasoningEffort, type CodeAgentKind } from "@prospero/protocol";
import type { AgentModelCatalog } from "./adapters/types.js";
import { AgentAccountFeatureError } from "./agent-account-feature-error.js";

export interface AccountConfigTarget {
  rootsDir: string;
  agent: CodeAgentKind;
  accountId: string;
  model?: string;
  reasoningDisabled?: boolean;
  declaredEfforts?: string[];
  engine?: string;
}

export interface AccountOverrides {
  default_model?: string;
  default_effort?: AgentReasoningEffort;
}

const maxBytes = 16_384;
const documentId = (target: AccountConfigTarget): string => `${target.agent}-overrides`;
const format = (target: AccountConfigTarget): "toml" | "yaml" => target.agent === "codex" ? "toml" : "yaml";
const hash = (content: string): string => createHash("sha256").update(content).digest("hex");

function safeRoot(target: AccountConfigTarget, create: boolean): string | undefined {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(target.accountId)) throw new AgentAccountFeatureError("invalid_request", "账号 ID 无效");
  const anchorInfo = lstatSync(target.rootsDir);
  if (anchorInfo.isSymbolicLink() || !anchorInfo.isDirectory()) throw new AgentAccountFeatureError("forbidden", "账号目录必须是真实私有目录");
  const anchor = realpathSync(target.rootsDir);
  let current = anchor;
  for (const part of [target.agent, target.accountId]) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AgentAccountFeatureError("storage", "无法访问账号配置目录");
      if (!create) return undefined;
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) throw new AgentAccountFeatureError("forbidden", "账号配置目录不允许符号链接");
    if (create) chmodSync(current, 0o700);
  }
  return current;
}

function readFile(file: string): string | undefined {
  let descriptor: number | undefined;
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || realpathSync(file) !== file) throw new AgentAccountFeatureError("forbidden", "配置文档不允许链接或非普通文件");
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > maxBytes) throw new AgentAccountFeatureError("forbidden", "配置文档已变更或超过大小限制");
    const content = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(content) > maxBytes) throw new AgentAccountFeatureError("limit_exceeded", "配置文档超过大小限制");
    return content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof AgentAccountFeatureError) throw error;
    throw new AgentAccountFeatureError("storage", "读取配置文档失败");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function parse(content: string, target: AccountConfigTarget, strict: boolean): AccountOverrides {
  if (Buffer.byteLength(content) > maxBytes) throw new AgentAccountFeatureError("limit_exceeded", "配置文档超过大小限制");
  let data: unknown;
  try {
    if (format(target) === "toml") data = TOML.parse(content);
    else {
      const lineCounter = new LineCounter();
      const document = parseDocument(content, { uniqueKeys: true, prettyErrors: false, lineCounter });
      const error = document.errors[0];
      if (error) {
        const position = lineCounter.linePos(error.pos[0]);
        throw new AgentAccountFeatureError("syntax", "YAML 语法错误", position.line, position.col);
      }
      data = document.toJS({ maxAliasCount: 0 });
    }
  } catch (error) {
    if (error instanceof AgentAccountFeatureError) throw error;
    const failure = error as { line?: unknown; col?: unknown };
    const line = typeof failure.line === "number" ? failure.line + 1 : undefined;
    const column = typeof failure.col === "number" ? failure.col + 1 : undefined;
    throw new AgentAccountFeatureError("syntax", `${format(target).toUpperCase()} 语法错误`, line, column);
  }
  if (data === null || data === undefined) return {};
  if (typeof data !== "object" || Array.isArray(data)) throw new AgentAccountFeatureError("invalid_config", "配置必须是字段映射");
  const record = data as Record<string, unknown>;
  const keys = target.model ? ["default_effort"] : ["default_model", "default_effort"];
  if (strict && Object.keys(record).some((key) => !keys.includes(key))) throw new AgentAccountFeatureError("invalid_config", "配置包含不允许编辑的字段；凭据、环境变量与执行设置不能写入此文档");
  const effort = AgentReasoningEffortSchema.safeParse(record["default_effort"]);
  if (record["default_effort"] !== undefined && !effort.success) throw new AgentAccountFeatureError("invalid_config", "默认推理强度无效");
  const model = record["default_model"];
  if (!target.model && model !== undefined && (typeof model !== "string" || !model.trim() || model.length > 300 || /[\r\n\0]/.test(model))) {
    throw new AgentAccountFeatureError("invalid_config", "默认模型无效");
  }
  return { ...(!target.model && typeof model === "string" ? { default_model: model } : {}), ...(effort.success ? { default_effort: effort.data } : {}) };
}

function stringify(value: AccountOverrides, target: AccountConfigTarget): string {
  return format(target) === "toml" ? TOML.stringify(value as Record<string, string>) : stringifyYaml(value);
}

function filePath(root: string, target: AccountConfigTarget): string {
  return path.join(root, `prospero-overrides.${format(target)}`);
}

export function readAccountOverrides(target: AccountConfigTarget): AccountOverrides {
  const root = safeRoot(target, false);
  if (!root) return {};
  const content = readFile(filePath(root, target));
  return content === undefined ? {} : parse(content, target, false);
}

export function supportedAccountEfforts(target: AccountConfigTarget, overrides: AccountOverrides, catalog?: AgentModelCatalog): AgentReasoningEffort[] {
  if (target.reasoningDisabled || target.engine === "opencode") return [];
  const model = target.model ?? overrides.default_model ?? catalog?.currentModel;
  const entry = catalog?.models.find((item) => item.id === model) ?? catalog?.models.find((item) => item.isDefault);
  const values = target.model ? target.declaredEfforts ?? [] : entry?.supportedEfforts ?? [];
  const engineValues = target.agent === "claude" ? ["low", "medium", "high", "xhigh", "max"] : AgentReasoningEffortSchema.options;
  return [...new Set(values)].flatMap((value) => {
    const effort = AgentReasoningEffortSchema.safeParse(value);
    return effort.success && engineValues.includes(effort.data) ? [effort.data] : [];
  });
}

export function getAccountConfig(target: AccountConfigTarget, activeSessions: number, catalog?: AgentModelCatalog): AgentAccountConfig {
  const root = safeRoot(target, false);
  const original = root ? readFile(filePath(root, target)) : undefined;
  const overrides = original === undefined ? {} : parse(original, target, false);
  return {
    accountId: target.accountId,
    documents: [{ id: documentId(target), label: "Prospero overrides", format: format(target), content: stringify(overrides, target), revision: hash(original ?? ""), writable: true, generated: false,
      editableKeys: target.model ? ["default_effort"] : ["default_model", "default_effort"] }],
    ...(overrides.default_effort ? { defaultEffort: overrides.default_effort } : {}),
    ...(overrides.default_model ? { defaultModel: overrides.default_model } : {}),
    supportedEfforts: supportedAccountEfforts(target, overrides, catalog),
    appliesTo: "new_sessions",
    activeSessions,
  };
}

function writeAtomic(root: string, file: string, content: string, beforeCommit?: () => void): void {
  const temporary = path.join(root, `.prospero-config-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    beforeCommit?.();
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    if (process.platform !== "win32") {
      const directory = openSync(root, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch {}
  }
}

export function saveAccountConfig(target: AccountConfigTarget, input: { documentId: string; revision: string; content?: string | undefined; defaultEffort?: AgentReasoningEffort | null | undefined }, activeSessions: number, catalog?: AgentModelCatalog): AgentAccountConfig {
  if (input.documentId !== documentId(target)) throw new AgentAccountFeatureError("forbidden", "此账号不支持该配置文档");
  if (input.content === undefined && input.defaultEffort === undefined) throw new AgentAccountFeatureError("invalid_request", "没有需要保存的配置");
  const root = safeRoot(target, true)!;
  const file = filePath(root, target);
  const previous = readFile(file);
  if (hash(previous ?? "") !== input.revision) throw new AgentAccountFeatureError("conflict", "配置已被其它操作修改，请重新加载后保存");
  const next = parse(input.content ?? previous ?? "", target, true);
  if (input.defaultEffort === null) delete next.default_effort;
  else if (input.defaultEffort !== undefined) next.default_effort = input.defaultEffort;
  if (next.default_effort && !target.model && !next.default_model) {
    const model = catalog?.currentModel ?? catalog?.models.find((item) => item.isDefault)?.id;
    if (model) next.default_model = model;
  }
  if (next.default_model && !catalog?.models.some((model) => model.id === next.default_model)) throw new AgentAccountFeatureError("invalid_config", "默认模型不在当前账号的可用模型目录中");
  if (next.default_effort && !supportedAccountEfforts(target, next, catalog).includes(next.default_effort)) throw new AgentAccountFeatureError("invalid_config", "所选模型尚未声明支持此推理强度，请使用模型默认值或更新模型能力");
  const contents = stringify(next, target);
  const backup = `${file}.bak`;
  readFile(backup);
  const conflict = (): AgentAccountFeatureError => new AgentAccountFeatureError("conflict", "配置已被其它操作修改，已保留外部版本，请重新加载后保存");
  const assertRevision = (): void => {
    safeRoot(target, false);
    if (hash(readFile(file) ?? "") !== input.revision) throw conflict();
  };
  let attempted = false;
  try {
    assertRevision();
    if (previous !== undefined) writeAtomic(root, backup, previous);
    attempted = true;
    writeAtomic(root, file, contents, assertRevision);
  } catch (error) {
    try {
      safeRoot(target, false);
      const current = readFile(file);
      if (current !== previous) {
        if (!attempted || current !== contents) throw conflict();
        const assertWritten = (): void => {
          safeRoot(target, false);
          if (readFile(file) !== contents) throw conflict();
        };
        if (previous === undefined) { assertWritten(); unlinkSync(file); }
        else writeAtomic(root, file, previous, assertWritten);
      }
    } catch (rollbackError) {
      if (rollbackError instanceof AgentAccountFeatureError && rollbackError.code === "conflict") throw rollbackError;
      throw new AgentAccountFeatureError("storage", "保存配置结果不确定，请检查备份并重新加载");
    }
    if (error instanceof AgentAccountFeatureError) throw error;
    throw new AgentAccountFeatureError("storage", "保存配置失败，原配置已保留");
  }
  return getAccountConfig(target, activeSessions, catalog);
}
