/** Private liveness leases shared by daemon runtime images and their owners. */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const LEASE_DIR = "leases";
const LEASE_VERSION = 1;

export const STRUCTURED_RUNTIME_LEASE_HEARTBEAT_MS = 30_000;

interface RuntimeLeaseFile {
  version: 1;
  digest: string;
  pid: number;
  heartbeatAt: number;
}

export interface StructuredSupervisorRuntimeLease {
  heartbeat(): void;
  release(): void;
}

function isPrivateDirectory(directory: string): boolean {
  try {
    const metadata = lstatSync(directory);
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

function ensurePrivateDirectory(directory: string): void {
  ensureNoSymlinkAncestors(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  ensureNoSymlinkAncestors(directory);
  if (!isPrivateDirectory(directory)) throw new Error("structured supervisor runtime lease directory is unsafe");
  chmodSync(directory, 0o700);
}

function ensureNoSymlinkAncestors(directory: string): void {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const metadata = lstatSync(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("structured supervisor runtime lease path has an unsafe ancestor");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function atomicPrivateJson(file: string, value: RuntimeLeaseFile): void {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* exact temporary cleanup only */ }
  }
}

export function createStructuredSupervisorRuntimeLease(
  runtimeRoot: string,
  digest: string,
): StructuredSupervisorRuntimeLease {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("structured supervisor runtime lease digest is invalid");
  ensurePrivateDirectory(runtimeRoot);
  const directory = path.join(runtimeRoot, LEASE_DIR);
  ensurePrivateDirectory(directory);
  const file = path.join(directory, `${digest}-${process.pid}-${randomBytes(12).toString("hex")}.json`);
  let released = false;
  const heartbeat = (): void => {
    if (released) return;
    atomicPrivateJson(file, { version: LEASE_VERSION, digest, pid: process.pid, heartbeatAt: Date.now() });
  };
  heartbeat();
  return {
    heartbeat,
    release: (): void => {
      if (released) return;
      released = true;
      try { rmSync(file, { force: true }); } catch { /* PID/liveness protects a failed release */ }
    },
  };
}

/**
 * A detached owner may lazily import SDK code after its daemon has exited.
 * Hold a second lease only when the executable is exactly a validated frozen
 * runner path. Mutable/dist and legacy runners deliberately get no lease.
 */
export function createStructuredSupervisorHostLease(
  runnerFile: string,
): StructuredSupervisorRuntimeLease | null {
  const dist = path.dirname(runnerFile);
  const snapshot = path.dirname(dist);
  const runtimeRoot = path.dirname(snapshot);
  const match = /^structured-supervisor-([a-f0-9]{64})$/.exec(path.basename(snapshot));
  if (
    path.basename(runnerFile) !== "structured-supervisor-runner.js" || path.basename(dist) !== "dist" ||
    !match || !isPrivateDirectory(runtimeRoot) || !isPrivateDirectory(snapshot) || !isPrivateDirectory(dist)
  ) return null;
  try { ensureNoSymlinkAncestors(runtimeRoot); } catch { return null; }
  const record = path.join(snapshot, "snapshot.json");
  if (!isPrivateFile(record)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(record, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    // snapshot.json records the payload digest; the directory name also
    // covers that record, so it intentionally is not self-referential.
    const value = parsed as { version?: unknown; digest?: unknown };
    if (value.version !== 2 || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) return null;
  } catch {
    return null;
  }
  return createStructuredSupervisorRuntimeLease(runtimeRoot, match[1]!);
}
