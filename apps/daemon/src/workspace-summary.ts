import { execFile } from "node:child_process";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export interface WorkspaceSummary {
  branch: string | null;
  sizeBytes: number | null;
  sizeComplete: boolean;
  checkedAt: number;
}

/** Read only HEAD, avoiding a full git status scan of every homepage repository. */
export async function workspaceBranch(cwd: string): Promise<string | null> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  const git = async (args: string[]) => (await run("git", args, {
    cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" }, timeout: 2_000, maxBuffer: 16_384, windowsHide: true,
  })).stdout.trim();
  try { return (await git(["symbolic-ref", "--short", "-q", "HEAD"])) || null; }
  catch {
    try { return `detached · ${await git(["rev-parse", "--short", "HEAD"])}`; }
    catch { return null; }
  }
}

/** Bound CPU/IO per homepage request; never follow symlinks or junctions. */
export async function workspaceSize(root: string, limits: { maxEntries?: number; maxMs?: number } = {}): Promise<Pick<WorkspaceSummary, "sizeBytes" | "sizeComplete">> {
  const maxEntries = limits.maxEntries ?? 20_000;
  const deadline = Date.now() + (limits.maxMs ?? 1_500);
  const base = await realpath(root).catch(() => null);
  if (!base) return { sizeBytes: null, sizeComplete: false };
  const directories = [base];
  const seenLinks = new Set<string>();
  let sizeBytes = 0;
  let count = 0;
  let complete = true;
  const contains = (target: string) => target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  while (directories.length > 0) {
    if (count >= maxEntries || Date.now() >= deadline) return { sizeBytes, sizeComplete: false };
    const directory = directories.pop()!;
    // Recheck queued directories: a directory may have been replaced by a link since enumeration.
    const actual = await realpath(directory).catch(() => null);
    const info = await lstat(directory).catch(() => null);
    if (!actual || !contains(actual) || !info?.isDirectory() || info.isSymbolicLink()) {
      if (directory === base) return { sizeBytes: null, sizeComplete: false };
      complete = false; continue;
    }
    const handle = await opendir(directory).catch(() => null);
    if (!handle) {
      if (directory === base) return { sizeBytes: null, sizeComplete: false };
      complete = false; continue;
    }
    try {
      for await (const entry of handle) {
        if (count >= maxEntries || Date.now() >= deadline) return { sizeBytes, sizeComplete: false };
        count += 1;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) { directories.push(full); continue; }
        if (!entry.isFile()) continue;
        const file = await lstat(full).catch(() => null);
        if (!file?.isFile()) { complete = false; continue; }
        if (file.nlink > 1 && file.ino > 0) {
          const identity = `${file.dev}:${file.ino}`;
          if (seenLinks.has(identity)) continue;
          seenLinks.add(identity);
        }
        sizeBytes += file.size;
      }
    } catch { complete = false; }
  }
  return { sizeBytes, sizeComplete: complete };
}

const cache = new Map<string, WorkspaceSummary>();
const pending = new Map<string, Promise<WorkspaceSummary>>();
const queue: (() => void)[] = [];
let active = 0;

/** Coalesce repeat requests and allow at most two scans across all paired clients. */
export async function readWorkspaceSummary(root: string): Promise<WorkspaceSummary> {
  const key = path.resolve(root);
  const previous = cache.get(key);
  if (previous && Date.now() - previous.checkedAt < 60_000) return previous;
  const inflight = pending.get(key);
  if (inflight) return inflight;
  if (pending.size >= 6) return { branch: null, sizeBytes: null, sizeComplete: false, checkedAt: Date.now() };
  const task = (async () => {
    if (active >= 2) await new Promise<void>((resolve) => queue.push(resolve));
    else active += 1;
    try {
      const [branch, size] = await Promise.all([workspaceBranch(root), workspaceSize(root)]);
      const result = { branch, ...size, checkedAt: Date.now() };
      cache.delete(key);
      cache.set(key, result);
      if (cache.size > 128) cache.delete(cache.keys().next().value!);
      return result;
    } finally {
      const next = queue.shift();
      if (next) next(); else active -= 1;
    }
  })();
  pending.set(key, task);
  try { return await task; } finally { pending.delete(key); }
}
