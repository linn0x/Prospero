import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const INVALID_ENTRY_GRACE_MS = 1_000;
const MAX_LEASE_MS = 120_000;

interface LockRecord {
  pid: number;
  createdAt: number;
  number?: number;
}

export interface FilesystemLock {
  release(): void;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readRecord(file: string): LockRecord | null {
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Partial<LockRecord>;
    if (!Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 1) return null;
    if (!Number.isSafeInteger(record.createdAt) || (record.createdAt ?? 0) <= 0) return null;
    if (record.number !== undefined && (!Number.isSafeInteger(record.number) || record.number < 1)) return null;
    return record as LockRecord;
  } catch {
    return null;
  }
}

function entryExpired(file: string, record: LockRecord | null, now: number): boolean {
  if (record) return !processAlive(record.pid) || now - record.createdAt > MAX_LEASE_MS;
  try {
    return now - statSync(file).mtimeMs > INVALID_ENTRY_GRACE_MS;
  } catch {
    return false;
  }
}

function ensureLockRoot(home: string, name: string): string {
  const root = path.join(home, `.${name}.lock`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(root);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error(`unsafe lock directory: ${root}`);
  }
  chmodSync(root, 0o700);
  return root;
}

function lockEntries(root: string): Array<{ id: string; number: number; file: string }> {
  const now = Date.now();
  const result: Array<{ id: string; number: number; file: string }> = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith("choosing-") && !name.startsWith("ticket-")) continue;
    const file = path.join(root, name);
    const record = readRecord(file);
    if (entryExpired(file, record, now)) {
      rmSync(file, { force: true });
      continue;
    }
    if (!name.startsWith("ticket-") || record?.number === undefined) continue;
    result.push({ id: name.slice("ticket-".length), number: record.number, file });
  }
  return result;
}

function choosingEntries(root: string): string[] {
  const now = Date.now();
  const result: string[] = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith("choosing-")) continue;
    const file = path.join(root, name);
    const record = readRecord(file);
    if (entryExpired(file, record, now)) {
      rmSync(file, { force: true });
      continue;
    }
    result.push(name.slice("choosing-".length));
  }
  return result;
}

function startContender(root: string): { id: string; choosing: string; ticket: string } {
  const id = `${String(process.pid)}-${randomBytes(12).toString("hex")}`;
  const choosing = path.join(root, `choosing-${id}`);
  const ticket = path.join(root, `ticket-${id}`);
  const createdAt = Date.now();
  writeFileSync(choosing, JSON.stringify({ pid: process.pid, createdAt }), { flag: "wx", mode: 0o600 });
  try {
    const number = lockEntries(root).reduce((max, entry) => Math.max(max, entry.number), 0) + 1;
    writeFileSync(ticket, JSON.stringify({ pid: process.pid, createdAt, number }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(ticket, { force: true });
    rmSync(choosing, { force: true });
    throw error;
  }
  rmSync(choosing, { force: true });
  return { id, choosing, ticket };
}

function ownsTurn(root: string, id: string): boolean {
  if (choosingEntries(root).some((entry) => entry !== id)) return false;
  const entries = lockEntries(root).sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  return entries[0]?.id === id;
}

function releaseContender(contender: { choosing: string; ticket: string }): void {
  try { rmSync(contender.choosing, { force: true }); } catch {}
  try { rmSync(contender.ticket, { force: true }); } catch {}
}

export function acquireFilesystemLockSync(
  home: string,
  name: string,
  timeoutMs = 10_000,
): FilesystemLock {
  const root = ensureLockRoot(home, name);
  const contender = startContender(root);
  const deadline = Date.now() + timeoutMs;
  try {
    while (!ownsTurn(root, contender.id)) {
      if (Date.now() >= deadline) throw new Error(`timed out acquiring ${name} lock`);
      Atomics.wait(WAIT_BUFFER, 0, 0, 5);
    }
  } catch (error) {
    releaseContender(contender);
    throw error;
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      releaseContender(contender);
    },
  };
}

export async function acquireFilesystemLock(
  home: string,
  name: string,
  timeoutMs = 10_000,
): Promise<FilesystemLock> {
  const root = ensureLockRoot(home, name);
  const contender = startContender(root);
  const deadline = Date.now() + timeoutMs;
  try {
    while (!ownsTurn(root, contender.id)) {
      if (Date.now() >= deadline) throw new Error(`timed out acquiring ${name} lock`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } catch (error) {
    releaseContender(contender);
    throw error;
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      releaseContender(contender);
    },
  };
}

export function writePrivateFileAtomic(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${String(process.pid)}.${randomBytes(12).toString("hex")}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, data);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    try {
      const directory = openSync(path.dirname(file), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch {}
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}
