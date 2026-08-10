import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  ignoredDirs,
  listWorktrees,
  removeWorktree,
} from "../src/orchestration/worktree.js";

const temps: string[] = [];

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-worktree-"));
  temps.push(dir);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  mkdirSync(path.join(dir, "apps", "mobile", "node_modules", "fixture"), { recursive: true });
  writeFileSync(path.join(dir, "apps", "mobile", "node_modules", "fixture", "index.js"), "ok\n");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("worktree", () => {
  it("能识别 monorepo 嵌套的 ignored 依赖目录", async () => {
    const root = repo();
    await expect(ignoredDirs(root)).resolves.toContain("apps/mobile/node_modules");
  });

  it("创建后会复制忽略目录，移除后不留下 worktree 元数据", async () => {
    const root = repo();
    const target = path.join(root, ".workers", "one");
    const created = await createWorktree({
      repo: root,
      at: target,
      branch: "prospero/test-worker",
    });

    expect(created.path).toBe(target);
    expect(existsSync(path.join(target, "README.md"))).toBe(true);
    expect(existsSync(path.join(target, "apps", "mobile", "node_modules", "fixture", "index.js"))).toBe(true);
    const canonicalTarget = realpathSync(target);
    expect((await listWorktrees(root)).some((worktree) => worktree.path === canonicalTarget)).toBe(true);

    await removeWorktree(root, target);

    expect(existsSync(target)).toBe(false);
    expect((await listWorktrees(root)).some((worktree) => worktree.path === canonicalTarget)).toBe(false);
  });
});
