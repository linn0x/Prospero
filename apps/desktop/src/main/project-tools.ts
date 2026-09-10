import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { listDir, readForEdit, resolveWithin, MAX_EDIT_BYTES } from "../../../daemon/src/fs-ops";
import { git, status } from "../../../daemon/src/git-ops";
import type { FileMutation, FilePreview, GitMutation, SearchResult } from "../shared/project-tools";

const ignored = new Set([".git", "node_modules", ".runtime", "dist", "out", "build", "target", ".next", ".venv", "venv", "__pycache__"]);
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".bmp": "image/bmp", ".svg": "image/svg+xml" };
const digest = (content: Buffer): string => createHash("sha256").update(content).digest("hex");
function string(value: unknown, max = 4096): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error("无效的参数 / Invalid argument");
  return value;
}
function relative(value: unknown, allowRoot = false): string {
  const rel = string(value).replaceAll("\\", "/");
  if ((!allowRoot && (!rel || rel === ".")) || path.isAbsolute(rel) || rel.split("/").some(part => part === ".." || part.toLowerCase() === ".git") || /[:]/.test(rel)) throw new Error("路径必须位于项目内，且不能操作 .git / Invalid project path");
  if (process.platform === "win32" && rel.split("/").some(part => part !== "." && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) throw new Error("Windows 文件名无效 / Invalid Windows filename");
  return rel;
}
const equalPath = (a: string, b: string): boolean => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Reuses the daemon's file/Git primitives, with the desktop's selected-project boundary. */
export class ProjectTools {
  private searchController?: AbortController;
  private mutations = new Map<string, Promise<unknown>>();
  constructor(private roots: () => string[], private trash: (absolutePath: string) => Promise<void>) {}
  async root(raw: unknown): Promise<string> {
    const requested = path.resolve(string(raw));
    if (!this.roots().some(root => equalPath(path.resolve(root), requested))) throw new Error("请先添加此项目 / Add this project first");
    const resolved = await realpath(requested);
    if (!(await lstat(resolved)).isDirectory()) throw new Error("项目目录不可用 / Project directory unavailable");
    return resolved;
  }
  async list(raw: unknown, rel: unknown) { return (await listDir(await this.root(raw), relative(rel, true))).filter(entry => entry.name.toLowerCase() !== ".git"); }
  async read(raw: unknown, rel: unknown): Promise<FilePreview> {
    const root = await this.root(raw), file = relative(rel);
    const result = await readForEdit(root, file);
    const mime = imageTypes[path.extname(file).toLowerCase()];
    return { path: file, size: result.size, version: digest(result.content), truncated: result.truncated, kind: mime && !result.truncated ? "image" : result.binary ? "binary" : "text", content: mime && !result.truncated ? `data:${mime};base64,${result.content.toString("base64")}` : result.binary ? "" : result.content.toString("utf8") };
  }
  private async exclusive<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    const next = (this.mutations.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.mutations.set(key, next);
    try { return await next; } finally { if (this.mutations.get(key) === next) this.mutations.delete(key); }
  }
  async mutateFile(raw: unknown, input: FileMutation): Promise<void> {
    const root = await this.root(raw);
    await this.exclusive(root, async () => {
      if (!input || typeof input !== "object") throw new Error("Invalid file operation");
      const rel = relative(input.path), target = await resolveWithin(root, rel);
      if (equalPath(target, root)) throw new Error("Cannot modify project root");
      // Mutations must never follow a symlink to a different file.
      if (!equalPath(path.resolve(root, rel), target) || (await lstat(target).catch(() => null))?.isSymbolicLink()) throw new Error("不能修改符号链接 / Cannot modify symbolic links");
      if (input.kind === "create-directory") await mkdir(target);
      else if (input.kind === "create-file") { const handle = await open(target, "wx"); await handle.close(); }
      else if (input.kind === "trash") await this.trash(target);
      else if (input.kind === "rename") {
        const destinationPath = relative(input.destination);
        const destination = await resolveWithin(root, destinationPath);
        if (!equalPath(path.resolve(root, destinationPath), destination)) throw new Error("不能移入符号链接目录 / Cannot move into a symbolic link");
        if (await lstat(destination).catch(() => null)) throw new Error("目标已存在 / Destination already exists");
        await rename(target, destination);
      } else if (input.kind === "save") {
        const content = Buffer.from(string(input.content, MAX_EDIT_BYTES), "utf8");
        if (content.length > MAX_EDIT_BYTES) throw new Error("文件超过 1 MB / File exceeds 1 MB");
        const handle = await open(target, "r+");
        try {
          if ((await handle.stat()).size > MAX_EDIT_BYTES) throw new Error("文件超过 1 MB / File exceeds 1 MB");
          const current = await handle.readFile();
          if (digest(current) !== string(input.version, 64)) throw new Error("文件已被外部修改，请重新打开后再编辑 / File changed on disk. Reopen it before editing.");
          let offset = 0;
          while (offset < content.length) { const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset); if (!bytesWritten) throw new Error("Unable to save file"); offset += bytesWritten; }
          await handle.truncate(content.length);
        } finally { await handle.close(); }
      } else throw new Error("Invalid file operation");
    });
  }
  cancelSearch(): void { this.searchController?.abort(); }
  async search(raw: unknown, rawQuery: unknown, options: { caseSensitive: boolean; wholeWord: boolean; pathFilter: string }): Promise<SearchResult> {
    this.cancelSearch();
    const controller = new AbortController(); this.searchController = controller;
    const root = await this.root(raw), query = string(rawQuery, 256);
    if (!options || typeof options.caseSensitive !== "boolean" || typeof options.wholeWord !== "boolean") throw new Error("Invalid search options");
    const filter = string(options.pathFilter, 256).toLowerCase();
    const result: SearchResult = { matches: [], scanned: 0, skipped: 0, truncated: false };
    if (!query.trim()) return result;
    const needle = options.caseSensitive ? query : query.toLowerCase();
    const deadline = Date.now() + 12_000;
    const stopped = (): boolean => {
      if (controller.signal.aborted) throw new Error("Search cancelled");
      if (Date.now() > deadline || result.scanned >= 10_000 || result.matches.length >= 500) { result.truncated = true; return true; }
      return false;
    };
    const inspect = async (file: string): Promise<void> => {
      if (filter && !file.toLowerCase().includes(filter)) return;
      if (file.split("/").some(part => ignored.has(part))) return;
      try {
        const resolved = await resolveWithin(root, relative(file));
        if ((await lstat(resolved)).size > MAX_EDIT_BYTES) { result.skipped++; return; }
        const data = await readForEdit(root, file); result.scanned++;
        if (data.binary || data.truncated) { result.skipped++; return; }
        const lines = data.content.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          if (stopped()) return;
          const line = lines[index]!, haystack = options.caseSensitive ? line : line.toLowerCase();
          let from = 0;
          while (from <= haystack.length) {
            const column = haystack.indexOf(needle, from);
            if (column < 0) break;
            const word = (char: string) => /[\p{L}\p{N}_]/u.test(char);
            if (!options.wholeWord || (!word(haystack[column - 1] ?? "") && !word(haystack[column + needle.length] ?? ""))) {
              const start = Math.max(0, column - 100);
              result.matches.push({ path: file, line: index + 1, column: column + 1, text: `${start ? "…" : ""}${line.slice(start, start + 400)}` }); break;
            }
            from = column + needle.length;
          }
        }
      } catch (error) { if (controller.signal.aborted) throw error; result.skipped++; }
    };
    // Git supplies ignored-file semantics; non-repositories get a bounded directory walk.
    let files: string[] | undefined;
    try { files = (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean); } catch { /* Git unavailable or not a repository. */ }
    if (files) {
      for (const file of new Set(files)) { if (stopped()) break; await inspect(file); }
    } else {
      let visited = 0;
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 30 || visited++ > 20_000) { result.truncated = true; return; }
        for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
          if (stopped()) return;
          if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
          const file = dir ? `${dir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(file, depth + 1); else if (entry.isFile()) await inspect(file);
        }
      };
      await walk("", 0);
    }
    return result;
  }
  private async gitRoot(raw: unknown): Promise<string> {
    const root = await this.root(raw);
    const repository = await git(root, ["rev-parse", "--show-toplevel"]).catch(() => "");
    if (repository && !equalPath(await realpath(repository.trim()), root)) throw new Error(`请打开 Git 仓库根目录 / Open repository root: ${repository.trim()}`);
    return root;
  }
  async gitStatus(raw: unknown) { return status(await this.gitRoot(raw)); }
  async history(raw: unknown) {
    const root = await this.gitRoot(raw);
    if (!(await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => ""))) return [];
    const output = await git(root, ["log", "-30", "--format=%h%x00%s%x00%an%x00%aI%x00"]);
    const fields = output.split("\0"), entries = [];
    for (let i = 0; i + 3 < fields.length; i += 4) entries.push({ hash: fields[i]!.trim(), subject: fields[i + 1]!, author: fields[i + 2]!, date: fields[i + 3]! });
    return entries;
  }
  async diff(raw: unknown, input: unknown, staged: unknown): Promise<string> {
    const root = await this.gitRoot(raw), file = relative(input);
    if (typeof staged !== "boolean") throw new Error("Invalid diff mode");
    const current = await status(root);
    const entry = current.files.find(entry => entry.path === file);
    if (!entry) return "";
    if (entry.untracked) {
      const data = await readForEdit(root, file);
      if (data.binary) return "Binary file";
      return `${data.truncated ? "Preview truncated to 1 MB\n" : ""}@@ -0,0 +1 @@\n${data.content.toString("utf8").split("\n").map(line => `+${line}`).join("\n")}`;
    }
    return git(root, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", ...(staged ? ["--cached"] : []), "--", file, ...(entry.originalPath ? [entry.originalPath] : [])]);
  }
  async mutateGit(raw: unknown, input: GitMutation): Promise<void> {
    const root = await this.gitRoot(raw);
    await this.exclusive(root, async () => {
      if (!input || typeof input !== "object") throw new Error("Invalid Git operation");
      if (input.kind === "commit") {
        const message = string(input.message, 4000).trim();
        if (!message) throw new Error("请输入提交说明 / Enter a commit message");
        await git(root, ["commit", "-m", message]);
      } else if (input.kind === "stage" || input.kind === "unstage") {
        if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 500) throw new Error("Invalid Git paths");
        const paths = input.paths.map(file => relative(file));
        const current = await status(root);
        const allowed = new Set(current.files.flatMap(file => [file.path, ...(file.originalPath ? [file.originalPath] : [])]));
        if (paths.some(file => !allowed.has(file))) throw new Error("文件状态已更新，请刷新 / File status changed. Refresh first.");
        if (input.kind === "stage") await git(root, ["add", "--", ...paths]);
        else {
          const head = await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "");
          await git(root, head ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "--", ...paths]);
        }
      } else throw new Error("Invalid Git operation");
    });
  }
}
