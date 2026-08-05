import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commit, diff, discard, stage, status, unstage } from "../src/git-ops.js";

const temps: string[] = [];

function repo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-git-"));
  temps.push(dir);
  const g = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  g("init", "-b", "main");
  g("config", "user.email", "test@example.com");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "# hello\n");
  g("add", ".");
  g("commit", "-m", "init");
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("git 状态", () => {
  it("干净仓库:有分支名,无改动", async () => {
    const st = await status(repo());
    expect(st.branch).toBe("main");
    expect(st.files).toEqual([]);
    expect(st.staged).toBe(false);
  });

  it("非 git 目录返回空态而不是报错 —— UI 该显示空,不该显示错误", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-nogit-"));
    temps.push(dir);
    const st = await status(dir);
    expect(st.branch).toBeNull();
    expect(st.files).toEqual([]);
  });

  it("区分工作区改动与未跟踪文件", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "README.md"), "# changed\n");
    writeFileSync(path.join(dir, "new.txt"), "new\n");

    const st = await status(dir);
    const readme = st.files.find((f) => f.path === "README.md");
    const fresh = st.files.find((f) => f.path === "new.txt");
    expect(readme?.worktree).toBe("M");
    expect(readme?.untracked).toBe(false);
    expect(fresh?.untracked).toBe(true);
  });

  it("路径含空格和中文时解析正确(靠 -z 分隔)", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "a b 中文.txt"), "x\n");
    const st = await status(dir);
    expect(st.files.some((f) => f.path === "a b 中文.txt")).toBe(true);
  });

  it("子目录里的文件路径是相对仓库根的", async () => {
    const dir = repo();
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "main.ts"), "x\n");
    const st = await status(dir);
    expect(st.files.some((f) => f.path === "src/main.ts")).toBe(true);
  });
});

describe("暂存与提交", () => {
  it("暂存后 staged 为真,取消后为假", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "README.md"), "# changed\n");

    await stage(dir, ["README.md"]);
    let st = await status(dir);
    expect(st.staged).toBe(true);
    expect(st.files.find((f) => f.path === "README.md")?.index).toBe("M");

    await unstage(dir, ["README.md"]);
    st = await status(dir);
    expect(st.staged).toBe(false);
  });

  it("提交返回短 hash,且提交后工作区变干净", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "README.md"), "# changed\n");
    await stage(dir, ["README.md"]);

    const hash = await commit(dir, "改了 README");
    expect(hash).toMatch(/^[0-9a-f]{7,}$/);
    expect((await status(dir)).files).toEqual([]);
  });

  it("空提交信息被拒", async () => {
    const dir = repo();
    await expect(commit(dir, "   ")).rejects.toThrow(/empty/);
  });
});

describe("diff", () => {
  it("已跟踪文件的改动能出补丁", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "README.md"), "# hello\nmore\n");
    const patch = await diff(dir, "README.md", false);
    expect(patch).toContain("+more");
  });

  it("暂存后要看 --cached 才有内容", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "README.md"), "# hello\nmore\n");
    await stage(dir, ["README.md"]);
    expect(await diff(dir, "README.md", false)).toBe("");
    expect(await diff(dir, "README.md", true)).toContain("+more");
  });

  it("未跟踪文件也给得出内容 —— 否则点开是一片空白", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "brand-new.txt"), "hello world\n");
    expect(await diff(dir, "brand-new.txt", false)).toContain("hello world");
  });
});

describe("丢弃", () => {
  it("恢复单个文件的工作区改动", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "README.md"), "# ruined\n");
    await discard(dir, "README.md");
    expect((await status(dir)).files).toEqual([]);
  });
});

describe("路径约束", () => {
  it("越界路径在交给 git 之前就被拒", async () => {
    const dir = repo();
    await expect(diff(dir, "../outside.txt", false)).rejects.toThrow(/escapes|does not exist/);
    await expect(stage(dir, ["../outside.txt"])).rejects.toThrow(/escapes|does not exist/);
    await expect(discard(dir, "../outside.txt")).rejects.toThrow(/escapes|does not exist/);
  });
});
