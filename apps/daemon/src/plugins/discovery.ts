import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import {
  parseProsperoPluginManifest,
  publicPlugin,
  type ProsperoPluginManifest,
  type PublicProsperoPlugin,
} from "./manifest.js";

export interface PluginDiscoveryError {
  root: string;
  manifestPath: string | null;
  message: string;
}

export interface PluginDiscoveryResult {
  plugins: ProsperoPluginManifest[];
  errors: PluginDiscoveryError[];
}

export interface PublicPluginDiscoveryResult {
  items: PublicProsperoPlugin[];
  errors: PluginDiscoveryError[];
}

export function pluginInstallRoot(home: string): string {
  return path.join(home, "plugins");
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(dir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${dir} is not a safe directory`);
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && statSync(dir).uid !== process.getuid()) {
      throw new Error(`${dir} is not owned by the current user`);
    }
    chmodSync(dir, 0o700);
  }
}

export function discoverProsperoPlugins(home: string): PluginDiscoveryResult {
  const root = pluginInstallRoot(home);
  const errors: PluginDiscoveryError[] = [];
  const plugins: ProsperoPluginManifest[] = [];
  try {
    ensurePrivateDirectory(home);
    ensurePrivateDirectory(root);
  } catch (error) {
    return {
      plugins,
      errors: [{
        root,
        manifestPath: null,
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    return {
      plugins,
      errors: [{
        root,
        manifestPath: null,
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
  for (const entry of entries) {
    if (/\.backup-\d+$/.test(entry.name)) continue;
    const pluginRoot = path.join(root, entry.name);
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) {
        errors.push({ root: pluginRoot, manifestPath: null, message: "plugin root cannot be a symlink" });
      }
      continue;
    }
    const manifestPath = path.join(pluginRoot, "prospero-plugin.json");
    try {
      ensurePrivateDirectory(pluginRoot);
      const manifest = parseProsperoPluginManifest(
        pluginRoot,
        manifestPath,
        JSON.parse(readFileSync(manifestPath, "utf8")),
      );
      if (manifest.name !== entry.name) throw new Error("manifest name must match plugin directory");
      plugins.push(manifest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      errors.push({
        root: pluginRoot,
        manifestPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { plugins, errors };
}

export function publicPluginDiscovery(home: string): PublicPluginDiscoveryResult {
  const discovered = discoverProsperoPlugins(home);
  return {
    items: discovered.plugins.map(publicPlugin),
    errors: discovered.errors,
  };
}

