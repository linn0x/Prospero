/**
 * Immutable runtime image for detached structured-supervisor owners.
 *
 * A daemon can keep serving while a developer builds or upgrades the package.
 * Starting a child directly from dist would then mix the daemon's old launcher
 * with whatever happened to replace dist. At daemon start we instead copy the
 * runner's complete relative-module closure into a private image and launch
 * every new owner from that image. Package dependencies remain resolved from
 * the installed daemon's node_modules ancestry; credentials and mutable
 * session data are intentionally not copied here.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveStructuredSupervisorRunnerPath } from "./structured-supervisor-client.js";

const RUNTIME_DIR = ".prospero-runtime";
const SNAPSHOT_PREFIX = "structured-supervisor-";
const STAGING_PREFIX = ".structured-supervisor-staging-";
const MAX_SNAPSHOTS = 8;
const MAX_SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const RELATIVE_IMPORT_PATTERNS = [
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
] as const;

export interface StructuredSupervisorRuntimeSnapshot {
  /** Exact immutable executable passed to Node for each new detached owner. */
  runnerPath: string;
  /** Private image directory, useful only for local diagnostics/tests. */
  directory: string;
}

function isPrivateDirectory(file: string): boolean {
  try {
    const metadata = lstatSync(file);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

function isPrivateFile(file: string): boolean {
  try {
    const metadata = lstatSync(file);
    return metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(dir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("structured supervisor runtime path is not a directory");
  }
  chmodSync(dir, 0o700);
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function readRelativeImports(file: string, sourceRoot: string): string[] {
  const source = readFileSync(file, "utf8");
  const imports = new Set<string>();
  for (const pattern of RELATIVE_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier || !specifier.endsWith(".js")) {
        throw new Error("structured supervisor runtime has an unsupported relative module specifier");
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!isWithin(sourceRoot, resolved)) {
        throw new Error("structured supervisor runtime relative dependency escapes dist");
      }
      imports.add(resolved);
    }
  }
  return [...imports];
}

/** Discover the runner's actual runtime closure, rejecting links and escapes. */
function collectRuntimeModules(runner: string): { sourceRoot: string; modules: string[] } {
  const sourceRoot = path.dirname(runner);
  const rootMetadata = lstatSync(sourceRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("structured supervisor dist root is unsafe");
  }
  const modules = new Set<string>();
  const visit = (file: string): void => {
    if (modules.has(file)) return;
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("structured supervisor runtime module is unsafe");
    }
    modules.add(file);
    for (const dependency of readRelativeImports(file, sourceRoot)) visit(dependency);
  };
  visit(runner);
  return { sourceRoot, modules: [...modules] };
}

/** Do not recursively remove a cache entry until every child was inspected. */
function privateTree(directory: string): boolean {
  if (!isPrivateDirectory(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const metadata = lstatSync(child);
    if (metadata.isSymbolicLink()) return false;
    if (metadata.isDirectory()) {
      if (!privateTree(child)) return false;
    } else if (!metadata.isFile() || !isPrivateFile(child)) {
      return false;
    }
  }
  return true;
}

function removePrivateSnapshot(directory: string): void {
  if (privateTree(directory)) rmSync(directory, { recursive: true, force: true });
}

/**
 * Bounded best-effort cache cleanup. Only exact names we create are eligible;
 * a changed mode, a symlink/reparse point, or an unfamiliar entry is retained.
 */
function cleanupRuntimeCache(root: string): void {
  const now = Date.now();
  const entries = readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const known = entry.name.startsWith(SNAPSHOT_PREFIX) || entry.name.startsWith(STAGING_PREFIX);
      if (!known || !entry.isDirectory()) return [];
      const directory = path.join(root, entry.name);
      try {
        const metadata = lstatSync(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || !isPrivateDirectory(directory)) return [];
        return [{ directory, modifiedAt: metadata.mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.modifiedAt - b.modifiedAt);
  const excess = Math.max(0, entries.length - MAX_SNAPSHOTS);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (now - entry.modifiedAt >= MAX_SNAPSHOT_AGE_MS || index < excess) {
      try { removePrivateSnapshot(entry.directory); } catch { /* retain an unsafe/busy cache entry */ }
    }
  }
}

function writePrivate(file: string, value: string): void {
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Freeze the currently compiled structured runner at daemon startup. The
 * image deliberately contains only executable modules and a minimal ESM
 * package marker; it never contains session bootstrap/configuration data.
 */
export function createStructuredSupervisorRuntimeSnapshot(): StructuredSupervisorRuntimeSnapshot {
  const runner = resolveStructuredSupervisorRunnerPath();
  const runnerMetadata = lstatSync(runner);
  if (!runnerMetadata.isFile() || runnerMetadata.isSymbolicLink()) {
    throw new Error("structured supervisor runner is unsafe or missing");
  }
  const { sourceRoot, modules } = collectRuntimeModules(runner);
  const runtimeRoot = path.join(path.dirname(sourceRoot), RUNTIME_DIR);
  ensurePrivateDirectory(runtimeRoot);
  cleanupRuntimeCache(runtimeRoot);

  const staging = mkdtempSync(path.join(runtimeRoot, STAGING_PREFIX));
  chmodSync(staging, 0o700);
  try {
    const destinationRoot = path.join(staging, "dist");
    ensurePrivateDirectory(destinationRoot);
    for (const source of modules) {
      const relative = path.relative(sourceRoot, source);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("structured supervisor runtime module escaped dist");
      }
      const destination = path.join(destinationRoot, relative);
      ensurePrivateDirectory(path.dirname(destination));
      copyFileSync(source, destination, 0);
      chmodSync(destination, 0o600);
    }
    // Node must preserve ESM semantics after the image is moved out of dist.
    writePrivate(path.join(staging, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
    writePrivate(path.join(staging, "snapshot.json"), `${JSON.stringify({
      version: 1,
      createdAt: Date.now(),
      modules: modules.map((file) => path.relative(sourceRoot, file)).sort(),
    })}\n`);
    const directory = path.join(runtimeRoot, `${SNAPSHOT_PREFIX}${randomBytes(12).toString("hex")}`);
    renameSync(staging, directory);
    chmodSync(directory, 0o700);
    const snapshotRunner = path.join(directory, "dist", path.relative(sourceRoot, runner));
    if (!isPrivateFile(snapshotRunner)) throw new Error("structured supervisor runtime snapshot is incomplete");
    return { runnerPath: snapshotRunner, directory };
  } catch (error) {
    try { removePrivateSnapshot(staging); } catch { /* do not widen deletion after a failed snapshot */ }
    throw error;
  }
}
