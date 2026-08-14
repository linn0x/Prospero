import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEsaytree,
  defaultWorktreeRoot,
  ignoredDirs,
  listManagedWorktrees,
  listWorktrees,
  removeManagedWorktree,
  removeWorktree,
} from "../src/orchestration/esaytree.js";

const temps: string[] = [];

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-esaytree-"));
  temps.push(dir);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  mkdirSync(path.join(dir, "apps", "mobile", "node_modules", "fixture"), { recursive: true });
  writeFileSync(path.join(dir, "apps", "mobile", "node_modules", "fixture", "index.js"), "ok\n");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("esaytree", () => {
  it("能识别 monorepo 嵌套的 ignored 依赖目录", async () => {
    const root = repo();
    await expect(ignoredDirs(root)).resolves.toContain("apps/mobile/node_modules");
  });

  it("从提交快照创建隔离工作区，同时用 CoW 路径复用 ignored 依赖", async () => {
    const root = repo();
    // 这些本地状态都不应泄漏到 worker；ignored 目录则应复用。
    writeFileSync(path.join(root, "README.md"), "# local edit\n");
    writeFileSync(path.join(root, "staged.txt"), "staged\n");
    git(root, "add", "staged.txt");
    writeFileSync(path.join(root, "untracked.txt"), "untracked\n");

    // 覆盖旧调用允许把目标放进源仓内部的情况，确保不会发生递归复制。
    const target = path.join(root, ".workers", "one");
    const created = await createEsaytree({
      repo: root,
      at: target,
      name: "one",
      branch: "prospero/test-worker",
    });

    expect(created.path).toBe(target);
    expect(["copy-on-write", "git-checkout"]).toContain(created.mode);
    expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe("# fixture\n");
    expect(existsSync(path.join(target, "staged.txt"))).toBe(false);
    expect(existsSync(path.join(target, "untracked.txt"))).toBe(false);
    expect(readFileSync(
      path.join(target, "apps", "mobile", "node_modules", "fixture", "index.js"),
      "utf8",
    )).toBe("ok\n");
    expect(git(target, "status", "--porcelain")).toBe("");

    writeFileSync(path.join(target, "README.md"), "# worker edit\n");
    writeFileSync(
      path.join(target, "apps", "mobile", "node_modules", "fixture", "index.js"),
      "worker\n",
    );
    expect(readFileSync(path.join(root, "README.md"), "utf8")).toBe("# local edit\n");
    expect(readFileSync(
      path.join(root, "apps", "mobile", "node_modules", "fixture", "index.js"),
      "utf8",
    )).toBe("ok\n");

    const canonicalTarget = realpathSync.native(target);
    expect(
      (await listWorktrees(root)).some(
        (worktree) => realpathSync.native(worktree.path) === canonicalTarget,
      ),
    ).toBe(true);
    await removeWorktree(root, target, { deleteBranch: true });
    expect(existsSync(target)).toBe(false);
    expect((await listWorktrees(root)).some((worktree) => worktree.path === canonicalTarget)).toBe(false);
    expect(git(root, "branch", "--list", "prospero/test-worker")).toBe("");
  });

  it("clean 模式不会把 ignored 依赖带入工作区", async () => {
    const root = repo();
    const target = path.join(root, ".workers", "clean");
    await createEsaytree({
      repo: root,
      at: target,
      name: "clean",
      branch: "prospero/clean-worker",
      cloneIgnored: false,
    });
    expect(existsSync(path.join(target, "apps", "mobile", "node_modules"))).toBe(false);
    await removeWorktree(root, target, { deleteBranch: true });
  });

  it("拒绝路径穿越名称，并在默认根目录中提供 list/switch/rm 生命周期", async () => {
    const root = repo();
    await expect(createEsaytree({ repo: root, name: "../escape" })).rejects.toMatchObject({
      code: "invalid_name",
    });

    const managedRoot = defaultWorktreeRoot(root);
    temps.push(managedRoot);
    const created = await createEsaytree({
      repo: root,
      name: "feature-one",
      branch: "esaytree/feature-one",
    });
    expect(created.path).toBe(path.join(managedRoot, "feature-one"));
    await expect(listManagedWorktrees(root)).resolves.toEqual([
      expect.objectContaining({
        name: "feature-one",
        branch: "refs/heads/esaytree/feature-one",
      }),
    ]);

    await removeManagedWorktree(root, "feature-one", { deleteBranch: true });
    expect(existsSync(created.path)).toBe(false);
    expect(git(root, "branch", "--list", "esaytree/feature-one")).toBe("");
  });

  it("创建失败不会留下目标目录、worktree 登记或新分支", async () => {
    const root = repo();
    const target = path.join(root, ".workers", "broken");
    await expect(createEsaytree({
      repo: root,
      at: target,
      name: "broken",
      branch: "esaytree/broken",
      baseRef: "missing-ref",
    })).rejects.toMatchObject({ code: "git_failed" });
    expect(existsSync(target)).toBe(false);
    expect(git(root, "branch", "--list", "esaytree/broken")).toBe("");
    expect((await listWorktrees(root)).some((worktree) => worktree.path === target)).toBe(false);
  });
});
