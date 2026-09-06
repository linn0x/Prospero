import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** SQLite's WAL-reset corruption fix was also backported to two older lines. */
export function sqliteSupportsSafeWal(version: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parts) return false;
  const major = Number(parts[1]), minor = Number(parts[2]), patch = Number(parts[3]);
  return major > 3 || (major === 3 && (
    minor > 51 || (minor === 51 && patch >= 3)
    || (minor === 50 && patch >= 7) || (minor === 44 && patch >= 6)
  ));
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function canonicalSystemPrefix(file: string): string {
  const resolved = path.resolve(file);
  // macOS exposes these system-owned aliases even through os.tmpdir(). All
  // application-controlled path components are still checked without following.
  if (process.platform === "darwin") {
    for (const alias of ["/var", "/tmp"]) {
      if (resolved.startsWith(`${alias}/`)) return realpathSync(alias) + resolved.slice(alias.length);
    }
  }
  return resolved;
}

function inspectParents(directory: string): void {
  const parent = path.dirname(directory);
  if (parent !== directory) inspectParents(parent);
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe SQLite directory");
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

function inspectFile(file: string, readOnly: boolean): boolean {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
      || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Unsafe SQLite file");
    }
    if (readOnly) {
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("SQLite file is not private");
    } else {
      chmodSync(file, 0o600);
    }
    return true;
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}

/**
 * Opens a local private database; each caller owns application_id/user_version.
 * RO never creates the database or changes its directory. SQLite may create
 * private WAL sidecars in the already private directory when opening an archive.
 * WAL fix details: https://sqlite.org/wal.html#walresetbug
 */
export function openPrivateSqlite(file: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  const target = canonicalSystemPrefix(file);
  const directory = path.dirname(target);
  const readOnly = options.readOnly === true;
  inspectParents(directory);
  if (!readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || (process.getuid && parent.uid !== process.getuid())) throw new Error("Unsafe SQLite directory");
  if (readOnly) {
    if (process.platform !== "win32" && (parent.mode & 0o077) !== 0) throw new Error("SQLite directory is not private");
  } else {
    chmodSync(directory, 0o700);
  }
  const exists = inspectFile(target, readOnly);
  for (const suffix of ["-wal", "-shm", "-journal"]) inspectFile(target + suffix, readOnly);
  if (!exists) {
    if (readOnly) throw new Error("SQLite database does not exist");
    const fd = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (process.platform !== "win32") {
      const directoryFd = openSync(directory, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    }
  }
  const db = new DatabaseSync(target, { readOnly, allowExtension: false, enableDoubleQuotedStringLiterals: false });
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;");
    if (readOnly) {
      db.exec("PRAGMA query_only=ON");
    } else {
      const version = String(db.prepare("SELECT sqlite_version() AS version").get()?.["version"]);
      db.exec(`PRAGMA journal_mode=${sqliteSupportsSafeWal(version) ? "WAL" : "DELETE"}; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304;`);
    }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) inspectFile(target + suffix, readOnly);
    return db;
  } catch {
    db.close();
    throw new Error("SQLite database could not be opened safely");
  }
}
