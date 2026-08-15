/**
 * Immutable runtime image for detached structured-supervisor owners.
 *
 * The daemon itself may outlive a build or package upgrade.  A detached
 * runner therefore never starts from mutable dist: it starts from a private,
 * content-addressed image below the daemon's state home.  In addition to the
 * runner's relative closure, the image contains complete resolved bare
 * packages and their dependency trees needed by Node ESM. This deliberately
 * avoids writing a cache beside an installed (and potentially read-only)
 * package or retaining links into mutable node_modules.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveStructuredSupervisorRunnerPath } from "./structured-supervisor-client.js";

const SNAPSHOT_PREFIX = "structured-supervisor-";
const STAGING_PREFIX = ".structured-supervisor-staging-";
const LEASE_DIR = "leases";
const SNAPSHOT_VERSION = 2;
const LEASE_VERSION = 1;
const FINAL_GC_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const STAGING_GC_AGE_MS = 24 * 60 * 60 * 1_000;
const LEASE_HEARTBEAT_MS = 30_000;
const LEASE_STALE_MS = LEASE_HEARTBEAT_MS * 4;
const MAX_CAPTURE_ATTEMPTS = 3;

const MODULE_SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
] as const;

interface SnapshotFile {
  /** POSIX-like path below the image root, never an absolute source path. */
  target: string;
  mode: 0o600 | 0o700;
  source?: string;
  contents?: string;
}

interface RuntimeImage {
  files: SnapshotFile[];
  runnerTarget: string;
}

type PackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

interface RuntimeLeaseFile {
  version: 1;
  digest: string;
  pid: number;
  heartbeatAt: number;
}

interface SnapshotRecord {
  version: 2;
  digest: string;
  files: Array<{ path: string; mode: 0o600 | 0o700 }>;
}

export interface StructuredSupervisorRuntimeSnapshot {
  /** Exact immutable executable passed to Node for each new detached owner. */
  runnerPath: string;
  /** Private image directory, useful only for local diagnostics/tests. */
  directory: string;
  /** Refreshes the owning daemon's liveness lease. */
  heartbeat(): void;
  /** Releases only this daemon's exact lease; it never removes the image. */
  release(): void;
}

export interface StructuredSupervisorRuntimeSnapshotOptions {
  /** State-owned, private root; production passes <prospero home>/runtime. */
  runtimeRoot: string;
  /** Test seam; production always resolves the runner beside this daemon. */
  runnerPath?: string;
  /** Exercises the source-stability retry without weakening production checks. */
  afterCopyForTest?: (attempt: number) => void;
}

/**
 * This image relies on POSIX owner mode bits as part of its security proof.
 * Node's Windows chmod/stat compatibility values are not a Windows ACL, so
 * accepting them here would turn an unverifiable image into executable state.
 * Windows session persistence belongs to the Session Host's N-API
 * secure-state boundary instead; it must not reuse this format.
 */
function requirePosixRuntimeImagePlatform(): void {
  if (process.platform === "win32") {
    throw new Error(
      "POSIX structured supervisor runtime snapshot is unsupported on win32: Node chmod/stat mode bits do not prove a private Windows ACL; use the Windows Session Host N-API secure-state boundary",
    );
  }
}

function privateFileMode(mode: number): mode is 0o600 | 0o700 {
  return (mode & 0o077) === 0 && ((mode & 0o777) === 0o600 || (mode & 0o777) === 0o700);
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
    return metadata.isFile() && !metadata.isSymbolicLink() && privateFileMode(metadata.mode);
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(dir: string): void {
  ensureNoSymlinkAncestors(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  ensureNoSymlinkAncestors(dir);
  const metadata = lstatSync(dir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("structured supervisor runtime path is not a directory");
  }
  chmodSync(dir, 0o700);
}

/** A private leaf is insufficient when a writable ancestor is a symlink. */
function ensureNoSymlinkAncestors(directory: string): void {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("structured supervisor runtime path has an unsafe ancestor");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function imagePath(...parts: string[]): string {
  const result = path.posix.join(...parts.map((part) => part.split(path.sep).join("/")));
  if (result === "." || result.startsWith("../") || path.posix.isAbsolute(result)) {
    throw new Error("structured supervisor runtime image path escaped its root");
  }
  return result;
}

function moduleSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const imports = new Set<string>();
  for (const pattern of MODULE_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const offset = match.index ?? 0;
      // Package JSDoc frequently contains `import("./types")` references to
      // declaration-only files. Those are not runtime edges (and resolving
      // them would make a valid JS package look incomplete).
      const blockStart = source.lastIndexOf("/*", offset);
      if (blockStart > source.lastIndexOf("*/", offset)) continue;
      const lineStart = source.lastIndexOf("\n", offset) + 1;
      const lineComment = source.indexOf("//", lineStart);
      if (lineComment >= lineStart && lineComment < offset) continue;
      const specifier = match[1];
      if (specifier) imports.add(specifier);
    }
  }
  return [...imports];
}

function sourceFileMode(file: string): 0o600 | 0o700 {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("structured supervisor runtime module is unsafe");
  }
  return (metadata.mode & 0o100) === 0 ? 0o600 : 0o700;
}

function resolveModule(specifier: string, from: string): string {
  const resolved = createRequire(from).resolve(specifier);
  if (resolved.startsWith("node:")) throw new Error("built-in module does not have a runtime file");
  const real = realpathSync(resolved);
  sourceFileMode(real);
  return real;
}

/** Resolve a declared package even when it intentionally has no root export. */
function resolvePackageDirectory(specifier: string, from: string): string {
  const name = packageName(specifier);
  const paths = createRequire(from).resolve.paths(specifier);
  if (!paths) throw new Error("structured supervisor runtime package has no lookup paths");
  for (const lookup of paths) {
    const candidate = path.join(lookup, name);
    try {
      const metadata = lstatSync(candidate);
      if (!metadata.isDirectory() && !metadata.isSymbolicLink()) continue;
      const directory = realpathSync(candidate);
      const canonical = lstatSync(directory);
      if (!canonical.isDirectory() || canonical.isSymbolicLink()) continue;
      const manifest = lstatSync(path.join(directory, "package.json"));
      if (manifest.isFile() && !manifest.isSymbolicLink()) return directory;
    } catch { /* keep Node's normal lookup order */ }
  }
  throw new Error("structured supervisor runtime package dependency is missing");
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? `${parts[0] ?? ""}/${parts[1] ?? ""}` : parts[0] ?? "";
  if (!name || name === "@") throw new Error("structured supervisor runtime has an invalid bare module specifier");
  return name;
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:") && !specifier.startsWith("file:");
}

/**
 * Discover the runner's relative graph and copy every resolved bare package
 * in full, including assets and recursively resolved production dependencies.
 * Each dependency is placed beneath its importing package, so nested package
 * versions retain Node's normal lookup semantics without source symlinks.
 */
function collectRuntimeImage(runner: string): RuntimeImage {
  const canonicalRunner = realpathSync(runner);
  sourceFileMode(canonicalRunner);
  const sourceRoot = path.dirname(canonicalRunner);
  const rootMetadata = lstatSync(sourceRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("structured supervisor dist root is unsafe");
  }

  const files = new Map<string, SnapshotFile>();
  const visiting = new Set<string>();
  const copiedPackages = new Map<string, string>();
  const trustedRoot = trustedPackageRoot(sourceRoot);
  const addFile = (source: string, target: string): void => {
    const prior = files.get(target);
    if (prior) {
      if (prior.source !== source) throw new Error("structured supervisor runtime image has conflicting modules");
      return;
    }
    files.set(target, { source, target, mode: sourceFileMode(source) });
  };

  const copyPackageTree = (packageRoot: string, packageTarget: string): void => {
    const visitDirectory = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        // Dependencies are explicitly copied below; following this directory
        // could retain a linked/mutable nested node_modules tree.
        if (entry.name === "node_modules") continue;
        const source = path.join(directory, entry.name);
        const metadata = lstatSync(source);
        if (metadata.isSymbolicLink()) {
          throw new Error("structured supervisor runtime package contains a symlink");
        }
        if (metadata.isDirectory()) {
          visitDirectory(source);
          continue;
        }
        if (!metadata.isFile()) throw new Error("structured supervisor runtime package contains an unsafe entry");
        addFile(source, imagePath(packageTarget, path.relative(packageRoot, source)));
      }
    };
    visitDirectory(packageRoot);
  };

  const visit = (source: string, target: string): void => {
    const key = `${source}\0${target}`;
    if (visiting.has(key)) return;
    visiting.add(key);
    addFile(source, target);
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith("node:")) continue;
      if (!isBareSpecifier(specifier)) {
        const resolved = resolveModule(specifier, source);
        const relative = path.relative(sourceRoot, resolved);
        if (!isWithin(sourceRoot, resolved)) {
          throw new Error("structured supervisor runtime relative dependency escapes dist");
        }
        visit(resolved, imagePath("dist", relative));
        continue;
      }
      const dependency = resolveModule(specifier, source);
      const dependencyTarget = imagePath(path.posix.dirname(target), "node_modules", packageName(specifier));
      visitPackageEntry(dependency, dependencyTarget);
    }
  };

  const visitPackage = (packageRoot: string, packageTarget: string): void => {
    if (!isWithin(trustedRoot, packageRoot)) {
      throw new Error("structured supervisor runtime package resolves outside the trusted installation root");
    }
    const copied = copiedPackages.get(packageTarget);
    if (copied) {
      if (copied !== packageRoot) throw new Error("structured supervisor runtime image has conflicting package versions");
      return;
    }
    copiedPackages.set(packageTarget, packageRoot);
    copyPackageTree(packageRoot, packageTarget);

    const manifestFile = path.join(packageRoot, "package.json");
    let manifest: PackageManifest;
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid package manifest");
      manifest = parsed as PackageManifest;
    } catch {
      throw new Error("structured supervisor runtime package manifest is invalid");
    }
    const dependencies = packageDependencies(manifest);
    for (const [dependencyName, optional] of dependencies) {
      try {
        const dependency = resolvePackageDirectory(dependencyName, manifestFile);
        visitPackage(dependency, imagePath(packageTarget, "node_modules", packageName(dependencyName)));
      } catch (error) {
        if (!optional) throw error;
      }
    }
  };

  const visitPackageEntry = (entry: string, packageTarget: string): void => {
    visitPackage(realpathSync(packageRootFor(entry)), packageTarget);
  };

  const runnerTarget = imagePath("dist", path.relative(sourceRoot, canonicalRunner));
  visit(canonicalRunner, runnerTarget);
  // Node needs an ESM package boundary after the image moves below daemon home.
  files.set("package.json", {
    target: "package.json",
    mode: 0o600,
    contents: `${JSON.stringify({ private: true, type: "module" })}\n`,
  });
  return { files: [...files.values()].sort((a, b) => a.target.localeCompare(b.target)), runnerTarget };
}

function packageRootFor(entry: string): string {
  let directory = path.dirname(entry);
  while (true) {
    const candidate = path.join(directory, "package.json");
    try {
      const metadata = lstatSync(candidate);
      if (metadata.isFile() && !metadata.isSymbolicLink()) return directory;
    } catch { /* walk upward */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("structured supervisor runtime package root is missing");
    directory = parent;
  }
}

/** Workspace links are accepted only after their real target stays in here. */
function trustedPackageRoot(sourceRoot: string): string {
  let directory = realpathSync(sourceRoot);
  let nearestPackage: string | undefined;
  // A published package can depend on siblings hoisted beneath its enclosing
  // node_modules. The trust boundary is that *physical node_modules*, not
  // its parent install prefix: a globally installed package must never make
  // arbitrary files below (for example) /usr/local/lib trusted runtime code.
  // Walking to the outermost node_modules also covers pnpm's physical nested
  // layout when a sibling was hoisted to the outer dependency tree.
  let installedNodeModules: string | undefined;
  while (true) {
    const manifest = path.join(directory, "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "workspaces" in parsed) {
        return realpathSync(directory);
      }
      nearestPackage ??= realpathSync(directory);
    } catch { /* continue to the next ancestor */ }
    if (path.basename(directory) === "node_modules") {
      const metadata = lstatSync(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("structured supervisor runtime installation root is unsafe");
      }
      installedNodeModules = realpathSync(directory);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return installedNodeModules ?? nearestPackage ?? directory;
    directory = parent;
  }
}

function packageDependencies(manifest: PackageManifest): Array<[name: string, optional: boolean]> {
  const dependencies = new Map<string, boolean>();
  for (const name of Object.keys(manifest.dependencies ?? {})) dependencies.set(name, false);
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) dependencies.set(name, true);
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    dependencies.set(name, optional);
  }
  return [...dependencies.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function digestFiles(files: readonly SnapshotFile[], root?: string): string {
  const digest = createHash("sha256");
  digest.update(`structured-supervisor-runtime-v${String(SNAPSHOT_VERSION)}\0`);
  for (const file of files) {
    digest.update(file.target).update("\0").update(String(file.mode)).update("\0");
    if (!root && file.contents !== undefined) {
      digest.update(createHash("sha256").update(file.contents).digest());
      continue;
    }
    const source = root ? path.join(root, file.target) : file.source;
    if (!source) throw new Error("structured supervisor runtime file has no source");
    const metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (root && !privateFileMode(metadata.mode))) {
      throw new Error("structured supervisor runtime image is unsafe or changed");
    }
    digest.update(createHash("sha256").update(readFileSync(source)).digest());
  }
  return digest.digest("hex");
}

function ensureTargetParent(staging: string, target: string): string {
  const destination = path.join(staging, target);
  const parent = path.dirname(destination);
  ensurePrivateDirectory(parent);
  return destination;
}

function copyImage(staging: string, image: RuntimeImage): void {
  for (const file of image.files) {
    const destination = ensureTargetParent(staging, file.target);
    if (file.contents !== undefined) {
      writeFileSync(destination, file.contents, { mode: file.mode });
    } else if (file.source) {
      sourceFileMode(file.source);
      // APFS/ReFS and other CoW filesystems avoid a cold-start byte-for-byte
      // copy of large platform SDK assets. COPYFILE_FICLONE never creates a
      // hardlink; when cloning is unavailable Node safely falls back to a
      // normal copy, which is still covered by the destination digest below.
      copyFileSync(file.source, destination, fsConstants.COPYFILE_FICLONE);
    } else {
      throw new Error("structured supervisor runtime file has no source");
    }
    chmodSync(destination, file.mode);
    if (!isPrivateFile(destination)) throw new Error("structured supervisor runtime copy is unsafe");
  }
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

function privateWrite(file: string, value: string): void {
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function atomicPrivateJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    privateWrite(temporary, `${JSON.stringify(value)}\n`);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* exact temporary cleanup only */ }
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves neither death nor ownership. Any error other than ESRCH is
    // treated as potentially live: a false positive only retains a cache;
    // a false negative could delete code still lazily loaded by a host.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function readActiveLeases(runtimeRoot: string, now: number): Set<string> | null {
  const directory = path.join(runtimeRoot, LEASE_DIR);
  try {
    if (!isPrivateDirectory(directory)) return null;
    const active = new Set<string>();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return null;
      const file = path.join(directory, entry.name);
      if (!isPrivateFile(file)) return null;
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const lease = parsed as Partial<RuntimeLeaseFile>;
      const pid = lease.pid;
      const heartbeatAt = lease.heartbeatAt;
      if (
        lease.version !== LEASE_VERSION || !validDigest(lease.digest) ||
        typeof pid !== "number" || !Number.isSafeInteger(pid) ||
        typeof heartbeatAt !== "number" || !Number.isFinite(heartbeatAt)
      ) return null;
      const alive = processAlive(pid);
      const expired = now - heartbeatAt > LEASE_STALE_MS;
      // Event loops can be blocked beyond the heartbeat interval. A lease is
      // collectible only once its owner is proven gone *and* it is expired.
      if (alive || !expired) {
        active.add(lease.digest);
        continue;
      }
      // A stale/dead lease is an exact private file created by us, so it is
      // safe to remove. Its snapshot remains subject to the final GC age.
      try { rmSync(file, { force: true }); } catch { return null; }
    }
    return active;
  } catch {
    return null;
  }
}

function snapshotDigestFromName(name: string): string | null {
  const match = new RegExp(`^${SNAPSHOT_PREFIX}([a-f0-9]{64})$`).exec(name);
  return match?.[1] ?? null;
}

/**
 * Final images are collected only when their content-addressed lease has no
 * live daemon owner. A live PID *or* a fresh heartbeat retains an image;
 * malformed lease state disables final GC rather than risking an old daemon's
 * launcher.
 * Staging images have never been published and can be collected independently.
 */
function cleanupRuntimeCache(runtimeRoot: string): void {
  const now = Date.now();
  const active = readActiveLeases(runtimeRoot, now);
  for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(runtimeRoot, entry.name);
    let metadata;
    try {
      metadata = lstatSync(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || !isPrivateDirectory(directory)) continue;
    } catch { continue; }
    if (entry.name.startsWith(STAGING_PREFIX)) {
      if (now - metadata.mtimeMs >= STAGING_GC_AGE_MS) {
        try { removePrivateSnapshot(directory); } catch { /* retain uncertain staging */ }
      }
      continue;
    }
    const digest = snapshotDigestFromName(entry.name);
    if (!digest || active === null || active.has(digest) || now - metadata.mtimeMs < FINAL_GC_AGE_MS) continue;
    try { removePrivateSnapshot(directory); } catch { /* retain uncertain final image */ }
  }
}

function expectedSnapshotRecord(digest: string, image: RuntimeImage): SnapshotRecord {
  return {
    version: SNAPSHOT_VERSION,
    digest,
    files: image.files.map((file) => ({ path: file.target, mode: file.mode })),
  };
}

/**
 * The directory key covers every copied image file *and* its immutable record.
 * The record holds the payload hash (rather than its own name) to avoid a
 * self-referential hash while still making metadata tampering non-reusable.
 */
function imageDigest(contentDigest: string, record: SnapshotRecord): string {
  return createHash("sha256")
    .update("structured-supervisor-runtime-image-v2\0")
    .update(contentDigest)
    .update("\0")
    .update(JSON.stringify(record))
    .digest("hex");
}

function matchesSnapshotRecord(value: unknown, expected: SnapshotRecord): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SnapshotRecord>;
  if (record.version !== expected.version || record.digest !== expected.digest || !Array.isArray(record.files)) return false;
  return record.files.length === expected.files.length && record.files.every((file, index) => {
    const wanted = expected.files[index];
    return !!wanted && file && typeof file === "object" && !Array.isArray(file) &&
      (file as { path?: unknown }).path === wanted.path && (file as { mode?: unknown }).mode === wanted.mode;
  });
}

/**
 * A content digest proves the expected bytes, but cannot prove absence.  Keep
 * the snapshot an exact mirror of its record so a private, injected file (or
 * directory, link, type, or mode change) never becomes executable baggage
 * that a later process silently trusts.
 */
function hasExactSnapshotInventory(directory: string, image: RuntimeImage): boolean {
  const expectedFiles = new Map<string, 0o600 | 0o700>(
    image.files.map((file) => [file.target, file.mode]),
  );
  expectedFiles.set("snapshot.json", 0o600);
  const expectedDirectories = new Set<string>([""]);
  for (const file of expectedFiles.keys()) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      expectedDirectories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();

  const walk = (relative: string): boolean => {
    const current = relative
      ? path.join(directory, ...relative.split("/"))
      : directory;
    let metadata;
    try {
      metadata = lstatSync(current);
    } catch {
      return false;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) return false;
    seenDirectories.add(relative);

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const childPath = path.join(current, entry.name);
      let childMetadata;
      try {
        childMetadata = lstatSync(childPath);
      } catch {
        return false;
      }
      if (expectedDirectories.has(child)) {
        if (!childMetadata.isDirectory() || childMetadata.isSymbolicLink()) return false;
        if (!walk(child)) return false;
        continue;
      }
      const expectedMode = expectedFiles.get(child);
      if (
        expectedMode === undefined || !childMetadata.isFile() || childMetadata.isSymbolicLink() ||
        (childMetadata.mode & 0o777) !== expectedMode
      ) return false;
      seenFiles.add(child);
    }
    return true;
  };

  return walk("") &&
    seenFiles.size === expectedFiles.size && [...expectedFiles.keys()].every((file) => seenFiles.has(file)) &&
    seenDirectories.size === expectedDirectories.size && [...expectedDirectories].every((child) => seenDirectories.has(child));
}

function validExistingSnapshot(
  directory: string,
  digest: string,
  contentDigest: string,
  image: RuntimeImage,
): boolean {
  if (!privateTree(directory)) return false;
  const recordFile = path.join(directory, "snapshot.json");
  if (!isPrivateFile(recordFile)) return false;
  try {
    const expected = expectedSnapshotRecord(contentDigest, image);
    if (!matchesSnapshotRecord(JSON.parse(readFileSync(recordFile, "utf8")), expected)) return false;
    if (!hasExactSnapshotInventory(directory, image)) return false;
    return imageDigest(contentDigest, expected) === digest && digestFiles(image.files, directory) === contentDigest;
  } catch {
    return false;
  }
}

function createLease(runtimeRoot: string, digest: string): { heartbeat(): void; release(): void } {
  const directory = path.join(runtimeRoot, LEASE_DIR);
  ensurePrivateDirectory(directory);
  const file = path.join(directory, `${digest}-${process.pid}-${randomBytes(12).toString("hex")}.json`);
  let released = false;
  const heartbeat = (): void => {
    if (released) return;
    const value: RuntimeLeaseFile = { version: LEASE_VERSION, digest, pid: process.pid, heartbeatAt: Date.now() };
    atomicPrivateJson(file, value);
  };
  heartbeat();
  return {
    heartbeat,
    release: (): void => {
      if (released) return;
      released = true;
      try { rmSync(file, { force: true }); } catch { /* stale lease will be checked before GC */ }
    },
  };
}

/**
 * Freeze the compiled structured runner at daemon startup. Concurrent builds
 * are fail-closed: source is fingerprinted before and after the copy, and a
 * changed graph retries rather than publishing a mixed image.
 */
export function createStructuredSupervisorRuntimeSnapshot(
  options: StructuredSupervisorRuntimeSnapshotOptions,
): StructuredSupervisorRuntimeSnapshot {
  requirePosixRuntimeImagePlatform();
  const runner = options.runnerPath ?? resolveStructuredSupervisorRunnerPath();
  const runnerMetadata = lstatSync(runner);
  if (!runnerMetadata.isFile() || runnerMetadata.isSymbolicLink()) {
    throw new Error("structured supervisor runner is unsafe or missing");
  }
  ensurePrivateDirectory(options.runtimeRoot);
  ensurePrivateDirectory(path.join(options.runtimeRoot, LEASE_DIR));
  cleanupRuntimeCache(options.runtimeRoot);

  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
    const image = collectRuntimeImage(runner);
    const contentDigest = digestFiles(image.files);
    const record = expectedSnapshotRecord(contentDigest, image);
    const digest = imageDigest(contentDigest, record);
    const directory = path.join(options.runtimeRoot, `${SNAPSHOT_PREFIX}${digest}`);
    if (validExistingSnapshot(directory, digest, contentDigest, image)) {
      // Re-read the source graph before adopting a shared final image.
      const current = collectRuntimeImage(runner);
      if (digestFiles(current.files) !== contentDigest) continue;
      const lease = createLease(options.runtimeRoot, digest);
      return {
        runnerPath: path.join(directory, image.runnerTarget),
        directory,
        heartbeat: lease.heartbeat,
        release: lease.release,
      };
    }

    const staging = mkdtempSync(path.join(options.runtimeRoot, STAGING_PREFIX));
    chmodSync(staging, 0o700);
    try {
      copyImage(staging, image);
      options.afterCopyForTest?.(attempt);
      // Copy correctness and source stability are separate checks: either a
      // short read or a concurrent overwrite rejects this attempt.
      if (digestFiles(image.files, staging) !== contentDigest) {
        throw new Error("structured supervisor runtime snapshot copy mismatch");
      }
      const current = collectRuntimeImage(runner);
      if (digestFiles(current.files) !== contentDigest) continue;

      privateWrite(path.join(staging, "snapshot.json"), `${JSON.stringify(record)}\n`);
      const published = path.join(options.runtimeRoot, `${SNAPSHOT_PREFIX}${digest}`);
      try {
        renameSync(staging, published);
      } catch (error) {
        // A concurrent daemon may have won publication of this same content.
        if (!validExistingSnapshot(published, digest, contentDigest, image)) throw error;
      }
      if (!validExistingSnapshot(published, digest, contentDigest, image)) {
        throw new Error("structured supervisor runtime snapshot is incomplete");
      }
      const lease = createLease(options.runtimeRoot, digest);
      return {
        runnerPath: path.join(published, image.runnerTarget),
        directory: published,
        heartbeat: lease.heartbeat,
        release: lease.release,
      };
    } finally {
      // rename moved staging on success; exact private-path cleanup is safe on
      // retry/failure and never broadens to a user-owned root.
      try { removePrivateSnapshot(staging); } catch { /* retain uncertain staging */ }
    }
  }
  throw new Error("structured supervisor runtime changed while creating immutable snapshot");
}
