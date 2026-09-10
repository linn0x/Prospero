import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTools } from "../src/main/project-tools";

// Windows process startup makes repository integration tests slower under parallel builds.
vi.setConfig({ testTimeout: 20_000 });

const fixtures: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "prospero-project-tools-")); fixtures.push(root);
  const trash = vi.fn(async () => {});
  return { root, trash, tools: new ProjectTools(() => [root], trash) };
}
function git(root: string, ...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }); }
async function repository(initialCommit = true) {
  const result = await fixture(), { root } = result;
  git(root, "init", "-b", "main"); git(root, "config", "user.email", "test@example.com"); git(root, "config", "user.name", "Test"); git(root, "config", "commit.gpgsign", "false");
  await writeFile(path.join(root, "README.md"), "# Project\nhello world\n");
  if (initialCommit) { git(root, "add", "."); git(root, "commit", "-m", "Initial commit"); }
  return result;
}
afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("prospero-project-tools-")) throw new Error("Invalid fixture cleanup path");
    await rm(resolved, { recursive: true, force: true });
  }
});

describe("desktop project files", () => {
  it("restricts roots, traversal, Git internals and Windows path aliases", async () => {
    const { root, tools } = await fixture();
    await expect(tools.list(path.dirname(root), "")).rejects.toThrow("Add this project first");
    for (const file of ["../escape", ".git/config", "a/../../escape", "C:/Windows", "a:stream", "\0"]) await expect(tools.read(root, file)).rejects.toThrow();
    if (process.platform === "win32") for (const file of [".git./config", ".git /config", "NUL", "con.txt"]) await expect(tools.mutateFile(root, { kind: "create-file", path: file })).rejects.toThrow();
  });
  it("creates, previews, saves, renames and trashes exact project files without overwriting destinations", async () => {
    const { root, tools, trash } = await fixture();
    await tools.mutateFile(root, { kind: "create-directory", path: "src" });
    await tools.mutateFile(root, { kind: "create-file", path: "src/中文 notes.txt" });
    let preview = await tools.read(root, "src/中文 notes.txt");
    await tools.mutateFile(root, { kind: "save", path: preview.path, version: preview.version, content: "你好\r\nProspero\n" });
    preview = await tools.read(root, preview.path);
    expect(preview).toMatchObject({ kind: "text", content: "你好\r\nProspero\n", truncated: false });
    await expect(tools.mutateFile(root, { kind: "create-file", path: preview.path })).rejects.toThrow();
    await writeFile(path.join(root, "src/existing.txt"), "keep");
    await expect(tools.mutateFile(root, { kind: "rename", path: preview.path, destination: "src/existing.txt" })).rejects.toThrow("Destination already exists");
    await tools.mutateFile(root, { kind: "rename", path: preview.path, destination: "src/renamed.txt" });
    await tools.mutateFile(root, { kind: "trash", path: "src/renamed.txt" });
    expect(trash).toHaveBeenCalledExactlyOnceWith(path.join(root, "src/renamed.txt"));
    expect(await readFile(path.join(root, "src/existing.txt"), "utf8")).toBe("keep");
    await expect(tools.mutateFile(root, { kind: "trash", path: "." })).rejects.toThrow();
  });
  it("detects external edits and serializes competing saves", async () => {
    const { root, tools } = await fixture();
    await writeFile(path.join(root, "file.txt"), "original");
    const preview = await tools.read(root, "file.txt");
    await writeFile(path.join(root, "file.txt"), "agent edit");
    await expect(tools.mutateFile(root, { kind: "save", path: preview.path, version: preview.version, content: "my edit" })).rejects.toThrow("File changed on disk");
    const current = await tools.read(root, "file.txt");
    const results = await Promise.allSettled(["first", "second"].map(content => tools.mutateFile(root, { kind: "save", path: current.path, version: current.version, content })));
    expect(results.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message).toContain("File changed on disk");
    expect(await readFile(path.join(root, "file.txt"), "utf8")).toBe(results[0]!.status === "fulfilled" ? "first" : "second");
  });
  it("previews images, detects binary files and limits large files", async () => {
    const { root, tools } = await fixture();
    await writeFile(path.join(root, "image.png"), Buffer.from("89504e4700", "hex"));
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, "large.txt"), "a".repeat(1024 * 1024 + 1));
    expect(await tools.read(root, "image.png")).toMatchObject({ kind: "image", content: "data:image/png;base64,iVBORwA=" });
    expect(await tools.read(root, "binary.bin")).toMatchObject({ kind: "binary", content: "" });
    const large = await tools.read(root, "large.txt");
    expect(large.truncated).toBe(true); expect(large.content.length).toBe(1024 * 1024);
    await expect(tools.mutateFile(root, { kind: "save", path: "large.txt", version: large.version, content: "small" })).rejects.toThrow("File exceeds 1 MB");
  });
  it("rejects directory symlink escapes for reads, saves and search", async () => {
    const { root, tools } = await fixture(); const outside = await fixture();
    await writeFile(path.join(outside.root, "secret.txt"), "needle");
    await symlink(outside.root, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(tools.read(root, "escape/secret.txt")).rejects.toThrow();
    await expect(tools.mutateFile(root, { kind: "create-file", path: "escape/new.txt" })).rejects.toThrow();
    expect((await tools.search(root, "needle", { caseSensitive: false, wholeWord: false, pathFilter: "" })).matches).toEqual([]);
    await mkdir(path.join(root, "real")); await writeFile(path.join(root, "keep.txt"), "keep");
    await symlink(path.join(root, "real"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(tools.mutateFile(root, { kind: "rename", path: "keep.txt", destination: "alias/moved.txt" })).rejects.toThrow("symbolic link");
    expect(await readFile(path.join(root, "keep.txt"), "utf8")).toBe("keep");
  });
});

describe("project search", () => {
  it("searches ignored-aware content with line numbers, Unicode, case, word and path filters", async () => {
    const { root, tools } = await repository();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/code.ts"), "Hello planet\nhelloWorld\nhello 你好\n");
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n"); await writeFile(path.join(root, "ignored.txt"), "hello");
    const options = { caseSensitive: false, wholeWord: false, pathFilter: "src/" };
    const result = await tools.search(root, "hello", options);
    expect(result.matches.map(match => match.line)).toEqual([1, 2, 3]);
    expect((await tools.search(root, "hello", { ...options, caseSensitive: true, wholeWord: true })).matches.map(match => match.line)).toEqual([3]);
    expect((await tools.search(root, "你好", options)).matches[0]).toMatchObject({ path: "src/code.ts", line: 3, column: 7 });
    expect((await tools.search(root, "hello", { ...options, pathFilter: "" })).matches.some(match => match.path === "ignored.txt")).toBe(false);
  });
  it("bounds results and cancels outstanding searches", async () => {
    const { root, tools } = await fixture();
    await writeFile(path.join(root, "many.txt"), "needle\n".repeat(700));
    const options = { caseSensitive: false, wholeWord: false, pathFilter: "" };
    const result = await tools.search(root, "needle", options);
    expect(result.matches).toHaveLength(500); expect(result.truncated).toBe(true);
    const pending = tools.search(root, "needle", options); tools.cancelSearch();
    await expect(pending).rejects.toThrow("cancelled");
    expect((await tools.search(root, "missing", options)).matches).toEqual([]);
  });
});

describe("desktop Git workflow", () => {
  it("supports first commit and unstaging in a repository with no HEAD", async () => {
    const { root, tools } = await repository(false);
    expect((await tools.gitStatus(root)).branch).toBe("main"); expect(await tools.history(root)).toEqual([]);
    await tools.mutateGit(root, { kind: "stage", paths: ["README.md"] });
    await tools.mutateGit(root, { kind: "unstage", paths: ["README.md"] });
    expect((await tools.gitStatus(root)).staged).toBe(false);
    expect(await readFile(path.join(root, "README.md"), "utf8")).toContain("hello");
    await tools.mutateGit(root, { kind: "stage", paths: ["README.md"] });
    await tools.mutateGit(root, { kind: "commit", message: "First commit" });
    expect(await tools.history(root)).toEqual([expect.objectContaining({ subject: "First commit", author: "Test" })]);
  });
  it("reviews worktree/index separately and commits only staged files", async () => {
    const { root, tools } = await repository();
    await writeFile(path.join(root, "README.md"), "# Edited\n"); await writeFile(path.join(root, "new.txt"), "new\n");
    expect(await tools.diff(root, "README.md", false)).toContain("+# Edited");
    expect(await tools.diff(root, "new.txt", false)).toContain("+new");
    await tools.mutateGit(root, { kind: "stage", paths: ["README.md"] });
    expect(await tools.diff(root, "README.md", true)).toContain("+# Edited");
    await tools.mutateGit(root, { kind: "commit", message: "Update README" });
    expect((await tools.gitStatus(root)).files.map(file => file.path)).toEqual(["new.txt"]);
  });
  it("handles renamed paths, deleted directories and literal pathspec characters", async () => {
    const { root, tools } = await repository();
    await mkdir(path.join(root, "removed")); await writeFile(path.join(root, "removed/file.txt"), "old");
    await writeFile(path.join(root, "[literal].txt"), "old"); await writeFile(path.join(root, "l.txt"), "keep");
    git(root, "add", "."); git(root, "commit", "-m", "Fixtures");
    await rename(path.join(root, "README.md"), path.join(root, "重命名 notes.md"));
    git(root, "add", "--", "README.md", "重命名 notes.md");
    const renamed = (await tools.gitStatus(root)).files.find(file => file.index === "R");
    expect(renamed).toMatchObject({ path: "重命名 notes.md", originalPath: "README.md" });
    await tools.mutateGit(root, { kind: "unstage", paths: ["重命名 notes.md", "README.md"] });
    expect((await tools.gitStatus(root)).staged).toBe(false);
    const removed = path.resolve(root, "removed"); expect(path.dirname(removed)).toBe(root);
    await rm(removed, { recursive: true });
    await tools.mutateGit(root, { kind: "stage", paths: ["removed/file.txt"] });
    expect(await tools.diff(root, "removed/file.txt", true)).toContain("-old");
    await writeFile(path.join(root, "[literal].txt"), "changed"); await writeFile(path.join(root, "l.txt"), "unrelated");
    await tools.mutateGit(root, { kind: "stage", paths: ["[literal].txt"] });
    expect((await tools.gitStatus(root)).files.find(file => file.path === "l.txt")?.index).toBe(" ");
  });
  it("shows non-repositories and rejects an enclosing repository outside the selected project", async () => {
    const plain = await fixture(); expect((await plain.tools.gitStatus(plain.root)).branch).toBeNull();
    const { root } = await repository(); const child = path.join(root, "child"); await mkdir(child);
    const tools = new ProjectTools(() => [child], async () => {});
    await expect(tools.gitStatus(child)).rejects.toThrow("Open repository root");
    await expect(tools.mutateGit(child, { kind: "stage", paths: ["../README.md"] })).rejects.toThrow();
  });
});
