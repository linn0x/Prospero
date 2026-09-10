import type { ChildProcess } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}

function smallFile(file: string): string | undefined {
  try {
    if (statSync(file).size > 65_536) return undefined;
    return readFileSync(file, "utf8");
  } catch { return undefined; }
}

function envValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(environment).find(key => key.toUpperCase() === name.toUpperCase());
  return key ? environment[key] : undefined;
}

/** Resolve the selected PATH entry, not an unrelated Codex installation later in PATH. */
function commandOnPath(environment: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const extensions = (envValue(environment, "PATHEXT") ?? ".EXE;.CMD;.BAT;.COM").split(";")
    .filter(extension => /^\.\w+$/.test(extension)).map(extension => extension.toLowerCase());
  const workingDirectory = path.resolve(cwd);
  const directories = [workingDirectory, ...(envValue(environment, "PATH") ?? "").split(";")]
    .map(entry => entry.replace(/^"(.*)"$/, "$1"));
  // Match cross-spawn: Windows cwd first, PATHEXT lookup, then extensionless
  // launchers as a second pass. Never skip a selected custom shim for a later exe.
  for (const suffixes of [extensions, [""]]) {
    for (const directory of directories) for (const extension of suffixes) {
      const candidate = path.resolve(workingDirectory, directory, `codex${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Recognize npm/pnpm's launcher without executing or rewriting a user's custom shim. */
function npmPackageRoot(command: string): string | undefined {
  let script = command;
  if (/\.(?:cmd|bat)$/i.test(command)) {
    const source = smallFile(command);
    // Leave wrappers that add their own CLI arguments in control.
    const reference = source?.match(/"(?:%dp0%|%~dp0)[\\/]([^"\r\n]*?[\\/]bin[\\/]codex\.js)"[ \t]+%\*[ \t]*(?:\r?\n|$)/i)?.[1];
    if (!reference) return undefined;
    script = path.resolve(path.dirname(command), reference.replace(/[\\/]/g, path.sep));
  }
  try {
    const root = path.dirname(path.dirname(realpathSync(script)));
    const metadata = JSON.parse(smallFile(path.join(root, "package.json")) ?? "null") as { name?: string } | null;
    return metadata?.name === "@openai/codex" ? root : undefined;
  } catch { return undefined; }
}

/**
 * Only called on Windows. Launch the native exe from the selected official npm
 * install so windowsHide applies to Codex itself and its PID is the registered
 * provider. cmd -> node -> codex.exe loses both properties. Keep custom shims
 * and standalone installs working; never evaluate a shim to discover its target.
 */
export function windowsCodexCommand(environment: NodeJS.ProcessEnv, cwd: string, arch = process.arch): { file: string; env: NodeJS.ProcessEnv } {
  const command = commandOnPath(environment, cwd);
  if (!command) return { file: "codex", env: environment };
  if (/\.(?:exe|com)$/i.test(command)) return { file: command, env: environment };
  const root = npmPackageRoot(command);
  const target = arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : undefined;
  if (!root || !target) return { file: command, env: environment };
  const vendorRoots: string[] = [];
  try {
    const manifest = createRequire(path.join(root, "package.json")).resolve(`@openai/codex-win32-${arch}/package.json`);
    vendorRoots.push(path.join(path.dirname(manifest), "vendor"));
  } catch { /* Older CLI releases shipped vendor directly in @openai/codex. */ }
  vendorRoots.push(path.join(root, "vendor"));
  for (const vendor of vendorRoots) {
    for (const directory of ["bin", "codex"]) {
      const file = path.join(vendor, target, directory, "codex.exe");
      if (!isFile(file)) continue;
      const env: NodeJS.ProcessEnv = { ...environment, CODEX_MANAGED_PACKAGE_ROOT: root };
      // Older npm launchers supplied rg and other bundled helpers through PATH.
      const helpers = path.join(vendor, target, "path");
      try {
        if (statSync(helpers).isDirectory()) {
          const key = Object.keys(env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
          env[key] = [helpers, env[key]].filter(Boolean).join(";");
        }
      } catch { /* Modern native releases locate helpers beside their executable. */ }
      return { file, env };
    }
  }
  // Preserve the official launcher's actionable missing-dependency diagnostic.
  return { file: command, env: environment };
}

const stopping = new WeakMap<ChildProcess, Promise<void>>();

/** EOF lets app-server stop its own helpers; killing a .cmd PID never did that. */
export function stopWindowsCodexProcess(proc: ChildProcess): Promise<void> {
  const pending = stopping.get(proc);
  if (pending) return pending;
  if (proc.exitCode != null || proc.signalCode != null || proc.pid === undefined) return Promise.resolve();
  const stopped = new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (timer) clearTimeout(timer);
      proc.removeListener("exit", finish);
      proc.removeListener("error", finish);
      resolve();
    };
    proc.once("exit", finish);
    proc.once("error", finish);
    timer = setTimeout(() => {
      // Exact owned child only. Durable session descendants still belong to
      // the Session Host's Job; no taskkill, breakaway or detached provider.
      timer = setTimeout(finish, 500);
      try { proc.kill(); } catch { /* Already exited. */ }
    }, 1_500);
    try { proc.stdin?.end(); } catch { /* The bounded kill still runs. */ }
  });
  stopping.set(proc, stopped);
  return stopped;
}
