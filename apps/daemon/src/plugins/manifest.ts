import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export type PluginServiceMode = "manual" | "auto";
export type PluginServiceHealth = "unknown" | "healthy" | "unhealthy";

export interface PluginServiceManifest {
  id: string;
  mode: PluginServiceMode;
  command: string[];
  cwd: string;
  env: Record<string, string>;
  portEnv: string;
  healthPath: string | null;
  configKey: string;
}

export interface ProsperoPluginManifest {
  schemaVersion: "prospero-plugin/v1";
  name: string;
  version: string | null;
  root: string;
  manifestPath: string;
  skillsRoot: string | null;
  agentsRoot: string | null;
  runtimeRoot: string | null;
  bootstrap: string | null;
  services: PluginServiceManifest[];
}

export interface PublicProsperoPlugin {
  name: string;
  version: string | null;
  root: string;
  skillsRoot: string | null;
  agentsRoot: string | null;
  runtimeRoot: string | null;
  bootstrap: string | null;
  services: Array<{
    id: string;
    mode: PluginServiceMode;
    command: string[];
    cwd: string;
    envKeys: string[];
    portEnv: string;
    healthPath: string | null;
  }>;
}

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginManifestError";
  }
}

function objectValue(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginManifestError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, context: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new PluginManifestError(`${context} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, context: string): string | null {
  if (value === undefined) return null;
  return stringValue(value, context);
}

function assertIdentifier(value: string, context: string): void {
  if (!PLUGIN_ID_PATTERN.test(value)) throw new PluginManifestError(`${context} is invalid`);
}

function assertEnvName(value: string, context: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new PluginManifestError(`${context} is invalid`);
}

function containsSecretName(value: string): boolean {
  return /token|secret|cookie/i.test(value);
}

function assertNoSecretFields(value: unknown, pathParts: string[] = []): void {
  if (typeof value === "string") {
    if (containsSecretName(value)) {
      throw new PluginManifestError(`${pathParts.join(".") || "manifest"} must not contain secret material`);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, [...pathParts, String(index)]));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (containsSecretName(key)) {
      throw new PluginManifestError(`${[...pathParts, key].join(".")} must not contain secret material`);
    }
    assertNoSecretFields(item, [...pathParts, key]);
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function existingAncestor(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function resolveWithinPlugin(root: string, rootReal: string, raw: string, base = root): string {
  const target = path.resolve(base, raw);
  if (!inside(root, target)) throw new PluginManifestError(`${raw} escapes plugin root`);
  const ancestor = existingAncestor(target);
  try {
    if (!inside(rootReal, realpathSync(ancestor))) throw new PluginManifestError(`${raw} escapes plugin root`);
  } catch (error) {
    if (error instanceof PluginManifestError) throw error;
    throw new PluginManifestError(`${raw} cannot be resolved`);
  }
  return target;
}

function pathLike(value: string): boolean {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) return false;
  return value.startsWith(".") || value.startsWith("/") || value.includes("/") || value.includes("\\") ||
    /\.(?:cjs|js|mjs|py|sh|ts)$/i.test(value);
}

function resolveCommandPart(root: string, rootReal: string, cwd: string, value: string): string {
  if (!pathLike(value)) return value;
  const base = path.isAbsolute(value)
    ? root
    : value.startsWith(".") || (!value.includes("/") && !value.includes("\\"))
      ? cwd
      : root;
  return resolveWithinPlugin(root, rootReal, value, base);
}

function arrayOfStrings(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new PluginManifestError(`${context} must be a non-empty argv array`);
  }
  return value.map((item, index) => stringValue(item, `${context}.${String(index)}`, 2048));
}

function parseEnv(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const raw = objectValue(value, "service.env");
  const out: Record<string, string> = {};
  const entries = Object.entries(raw);
  if (entries.length > 128) throw new PluginManifestError("service.env has too many entries");
  for (const [key, item] of entries) {
    assertEnvName(key, `service.env.${key}`);
    out[key] = stringValue(item, `service.env.${key}`, 4096);
  }
  return out;
}

function parseHealthPath(value: unknown): string | null {
  if (value === undefined) return null;
  const healthPath = stringValue(value, "service.health_path", 256);
  if (!healthPath.startsWith("/") || healthPath.includes("://")) {
    throw new PluginManifestError("service.health_path is invalid");
  }
  return healthPath;
}

function parseService(root: string, rootReal: string, value: unknown): PluginServiceManifest {
  const raw = objectValue(value, "service");
  const id = stringValue(raw["id"], "service.id", 64);
  assertIdentifier(id, "service.id");
  const mode = raw["mode"] === undefined ? "manual" : stringValue(raw["mode"], "service.mode", 16);
  if (mode !== "manual" && mode !== "auto") throw new PluginManifestError("service.mode is invalid");
  if (typeof raw["command"] === "string") throw new PluginManifestError("service.command must be an argv array");
  const cwd = resolveWithinPlugin(root, rootReal, optionalString(raw["cwd"], "service.cwd") ?? ".", root);
  const cwdMetadata = lstatSync(cwd);
  if (!cwdMetadata.isDirectory() || cwdMetadata.isSymbolicLink()) {
    throw new PluginManifestError("service.cwd must be a directory inside plugin root");
  }
  const command = arrayOfStrings(raw["command"], "service.command")
    .map((part) => resolveCommandPart(root, rootReal, cwd, part));
  const env = parseEnv(raw["env"]);
  const portEnv = optionalString(raw["port_env"], "service.port_env") ?? "PORT";
  assertEnvName(portEnv, "service.port_env");
  const healthPath = parseHealthPath(raw["health_path"]);
  const configKey = createHash("sha256")
    .update(JSON.stringify({ id, mode, command, cwd, env, portEnv, healthPath }))
    .digest("hex");
  return { id, mode, command, cwd, env, portEnv, healthPath, configKey };
}

export function parseProsperoPluginManifest(pluginRoot: string, manifestPath: string, value: unknown): ProsperoPluginManifest {
  const metadata = lstatSync(pluginRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new PluginManifestError("plugin root must be a directory");
  const root = path.resolve(pluginRoot);
  const rootReal = realpathSync(root);
  assertNoSecretFields(value);
  const raw = objectValue(value, "manifest");
  if (raw["schema_version"] !== "prospero-plugin/v1") {
    throw new PluginManifestError("schema_version is invalid");
  }
  const name = stringValue(raw["name"], "name", 64);
  assertIdentifier(name, "name");
  const version = optionalString(raw["version"], "version");
  const relativeField = (key: string): string | null => {
    const value = optionalString(raw[key], key);
    return value === null ? null : resolveWithinPlugin(root, rootReal, value, root);
  };
  const servicesRaw = raw["services"] === undefined ? [] : raw["services"];
  if (!Array.isArray(servicesRaw) || servicesRaw.length > 32) {
    throw new PluginManifestError("services must be an array");
  }
  const seen = new Set<string>();
  const services = servicesRaw.map((service) => {
    const parsed = parseService(root, rootReal, service);
    if (seen.has(parsed.id)) throw new PluginManifestError(`duplicate service id: ${parsed.id}`);
    seen.add(parsed.id);
    return parsed;
  });
  return {
    schemaVersion: "prospero-plugin/v1",
    name,
    version,
    root,
    manifestPath,
    skillsRoot: relativeField("skills_root"),
    agentsRoot: relativeField("agents_root"),
    runtimeRoot: relativeField("runtime_root"),
    bootstrap: relativeField("bootstrap"),
    services,
  };
}

export function publicPlugin(plugin: ProsperoPluginManifest): PublicProsperoPlugin {
  return {
    name: plugin.name,
    version: plugin.version,
    root: plugin.root,
    skillsRoot: plugin.skillsRoot,
    agentsRoot: plugin.agentsRoot,
    runtimeRoot: plugin.runtimeRoot,
    bootstrap: plugin.bootstrap,
    services: plugin.services.map((service) => ({
      id: service.id,
      mode: service.mode,
      command: [...service.command],
      cwd: service.cwd,
      envKeys: Object.keys(service.env).sort(),
      portEnv: service.portEnv,
      healthPath: service.healthPath,
    })),
  };
}
