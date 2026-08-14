import { execFileSync } from "node:child_process";
import {
  cpSync,
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
  type EsaytreeOperations,
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
  writeFileSync(path.join(dir, ".gitignore"), [
    "node_modules/",
    "build/",
    ".cache/",
    ".expo/",
    "ios/build/",
    ".claude/",
  ].join("\n"));
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  mkdirSync(path.join(dir, "apps", "mobile", "node_modules", "fixture"), { recursive: true });
  writeFileSync(path.join(dir, "apps", "mobile", "node_modules", "fixture", "index.js"), "ok\n");
  mkdirSync(path.join(dir, "build"), { recursive: true });
  mkdirSync(path.join(dir, ".cache"), { recursive: true });
  mkdirSync(path.join(dir, ".expo"), { recursive: true });
  mkdirSync(path.join(dir, "ios", "build"), { recursive: true });
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  writeFileSync(path.join(dir, "build", "artifact"), "build\n");
  writeFileSync(path.join(dir, ".cache", "cache"), "cache\n");
  writeFileSync(path.join(dir, ".expo", "state"), "expo\n");
  writeFileSync(path.join(dir, "ios", "build", "artifact"), "ios build\n");
  writeFileSync(path.join(dir, ".claude", "private"), "private\n");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

/** 真实临时 Git 仓上的受控 CoW 后端；实体 cp 只用于故障注入，不冒充生产严格语义。 */
const cowAvailable: EsaytreeOperations = {
  cloneCow(source, target) {
    cpSync(source, target, { recursive: true });
  },
  // 严格 CoW 成功不应统计 31 GiB 依赖或读取实体复制的剩余空间。
  availableBytes: () => {
    throw new Error("实体复制预检不应在 CoW 成功时运行");
  },
};

function cowFailure(code: "ENOSYS" | "EXDEV"): EsaytreeOperations {
  return {
    cloneCow() {
      const error = new Error(code) as NodeJS.ErrnoException;
      error.code = code;
      throw error;
    },
    availableBytes: () => 100 * 1024 ** 3,
  };
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
    await expect(ignoredDirs(root)).resolves.not.toContain("build");
    await expect(ignoredDirs(root)).resolves.not.toContain(".cache");
    await expect(ignoredDirs(root)).resolves.not.toContain(".expo");
    await expect(ignoredDirs(root)).resolves.not.toContain("ios/build");
    await expect(ignoredDirs(root)).resolves.not.toContain(".claude");
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
      operations: cowAvailable,
    });

    expect(created.path).toBe(target);
    expect(created).toMatchObject({ mode: "git-checkout", cow: true, cowBackend: "injected" });
    expect(created.preservedIgnored).toEqual(["apps/mobile/node_modules"]);
    expect(created.skippedIgnored.map((item) => item.dir)).toEqual(
      expect.arrayContaining(["build", ".cache", ".expo", "ios/build", ".claude"]),
    );
    expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe("# fixture\n");
    expect(existsSync(path.join(target, "staged.txt"))).toBe(false);
    expect(existsSync(path.join(target, "untracked.txt"))).toBe(false);
    expect(readFileSync(
      path.join(target, "apps", "mobile", "node_modules", "fixture", "index.js"),
      "utf8",
    )).toBe("ok\n");
    expect(existsSync(path.join(target, "build"))).toBe(false);
    expect(existsSync(path.join(target, ".cache"))).toBe(false);
    expect(existsSync(path.join(target, ".expo"))).toBe(false);
    expect(existsSync(path.join(target, "ios", "build"))).toBe(false);
    expect(existsSync(path.join(target, ".claude"))).toBe(false);
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

  it.skipIf(process.platform !== "darwin")(
    "macOS 同卷路径由 clonefile 严格确认 CoW，而非 cp -c 的静默 fallback",
    async () => {
      const root = repo();
      const target = path.join(root, ".workers", "macos-clonefile");
      const created = await createEsaytree({
        repo: root,
        at: target,
        name: "macos-clonefile",
        branch: "esaytree/macos-clonefile",
      });
      expect(created).toMatchObject({
        mode: "git-checkout",
        cow: true,
        cowBackend: "macos_clonefile",
      });
      await removeWorktree(root, target, { deleteBranch: true });
    },
  );

  it("clean 模式不会把 ignored 依赖带入工作区", async () => {
    const root = repo();
    const target = path.join(root, ".workers", "clean");
    await createEsaytree({
      repo: root,
      at: target,
      name: "clean",
      branch: "prospero/clean-worker",
      cloneIgnored: false,
      operations: cowAvailable,
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

  it("CoW 后端 ENOSYS 时默认不实体复制依赖，且报告可操作原因", async () => {
    const root = repo();
    const target = path.join(root, ".workers", "enosys");
    const created = await createEsaytree({
      repo: root,
      at: target,
      name: "enosys",
      branch: "esaytree/enosys",
      operations: cowFailure("ENOSYS"),
    });

    expect(created).toMatchObject({ mode: "git-checkout", cow: false, cowBackend: "none" });
    expect(created.fallbackReason).toContain("ENOSYS");
    expect(existsSync(path.join(target, "apps", "mobile", "node_modules"))).toBe(false);
    expect(created.skippedIgnored).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dir: "apps/mobile/node_modules",
        strategy: "skipped",
        reason: expect.stringContaining("未显式启用"),
      }),
    ]));
    await removeWorktree(root, target, { deleteBranch: true });
  });

  it("跨卷 CoW 故障允许受限的实体副本，副本写入不会污染源依赖", async () => {
    const root = repo();
    const target = path.join(root, ".workers", "cross-volume");
    const created = await createEsaytree({
      repo: root,
      at: target,
      name: "cross-volume",
      branch: "esaytree/cross-volume",
      operations: cowFailure("EXDEV"),
      fallbackCopyIgnored: true,
      maxFallbackCopyBytes: 1024 * 1024,
      minFreeBytes: 1024,
    });

    expect(created.fallbackReason).toContain("EXDEV");
    expect(created.clones).toEqual(expect.arrayContaining([
      expect.objectContaining({ dir: "apps/mobile/node_modules", strategy: "copy", cow: false }),
    ]));
    const targetDependency = path.join(target, "apps", "mobile", "node_modules", "fixture", "index.js");
    writeFileSync(targetDependency, "worker copy\n");
    expect(readFileSync(path.join(root, "apps", "mobile", "node_modules", "fixture", "index.js"), "utf8"))
      .toBe("ok\n");
    await removeWorktree(root, target, { deleteBranch: true });
  });

  it("空间不足预检不写任何实体依赖副本", async () => {
    const root = repo();
    const target = path.join(root, ".workers", "no-space");
    const operations: EsaytreeOperations = {
      ...cowFailure("ENOSYS"),
      availableBytes: () => 1_024,
    };
    const created = await createEsaytree({
      repo: root,
      at: target,
      name: "no-space",
      branch: "esaytree/no-space",
      operations,
      fallbackCopyIgnored: true,
      maxFallbackCopyBytes: 1024 * 1024,
      minFreeBytes: 2048,
    });

    expect(existsSync(path.join(target, "apps", "mobile", "node_modules"))).toBe(false);
    expect(created.skippedIgnored).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dir: "apps/mobile/node_modules",
        strategy: "skipped",
        reason: expect.stringContaining("安全保留"),
      }),
    ]));
    await removeWorktree(root, target, { deleteBranch: true });
  });

  it("实体复制上限在写入前拒绝依赖副本", async () => {
    const root = repo();
    const target = path.join(root, ".workers", "copy-limit");
    const created = await createEsaytree({
      repo: root,
      at: target,
      name: "copy-limit",
      branch: "esaytree/copy-limit",
      operations: cowFailure("ENOSYS"),
      fallbackCopyIgnored: true,
      maxFallbackCopyBytes: 0,
      minFreeBytes: 0,
    });

    expect(existsSync(path.join(target, "apps", "mobile", "node_modules"))).toBe(false);
    expect(created.skippedIgnored).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dir: "apps/mobile/node_modules",
        strategy: "skipped",
        reason: expect.stringContaining("上限"),
      }),
    ]));
    await removeWorktree(root, target, { deleteBranch: true });
  });

  it("CoW 在写出残片后失败也会回滚目标、worktree 登记和新分支", async () => {
    const root = repo();
    const target = path.join(root, ".workers", "partial-cow");
    const operations: EsaytreeOperations = {
      cloneCow(source, destination) {
        cpSync(source, destination, { recursive: true });
        if (!path.basename(destination).startsWith(".esaytree-cow-probe-")) {
          const error = new Error("injected partial ENOSYS") as NodeJS.ErrnoException;
          error.code = "ENOSYS";
          throw error;
        }
      },
      availableBytes: () => 100 * 1024 ** 3,
    };

    await expect(createEsaytree({
      repo: root,
      at: target,
      name: "partial-cow",
      branch: "esaytree/partial-cow",
      fallbackToCheckout: false,
      operations,
    })).rejects.toMatchObject({ code: "cow_unavailable" });
    expect(existsSync(target)).toBe(false);
    expect(git(root, "branch", "--list", "esaytree/partial-cow")).toBe("");
    expect((await listWorktrees(root)).some((worktree) => worktree.path === target)).toBe(false);
  });
});
