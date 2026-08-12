import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const temps: string[] = [];

function fixture(): { repo: string; storage: string } {
  const repo = mkdtempSync(path.join(os.tmpdir(), "prospero-esaytree-cli-repo-"));
  const storage = mkdtempSync(path.join(os.tmpdir(), "prospero-esaytree-cli-store-"));
  temps.push(repo, storage);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git("add", ".");
  git("commit", "-m", "init");
  return { repo, storage };
}

async function cli(
  repo: string,
  storage: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return await exec(path.resolve("bin/esaytree"), [...args, "-C", repo, "--json"], {
    cwd: path.resolve("."),
    env: { ...process.env, ESAYTREE_ROOT: storage },
  });
}

afterEach(() => {
  for (const value of temps.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("esaytree CLI", () => {
  it("提供稳定的 new/list/switch/rm 单文档 JSON 生命周期", async () => {
    const { repo, storage } = fixture();
    const createdRaw = await cli(repo, storage, ["new", "demo"]);
    const created = JSON.parse(createdRaw.stdout) as {
      schema: string;
      schema_version: number;
      kind: string;
      data: { task: { name: string; path: string; mode: string; cow: boolean } };
    };
    expect(createdRaw.stdout.trim().split("\n")).toHaveLength(1);
    expect(created).toMatchObject({
      schema: "esaytree.dev/cli/v1",
      schema_version: 1,
      kind: "esaytree.task-new",
      data: { task: { name: "demo" } },
    });
    expect(["copy-on-write", "git-checkout"]).toContain(created.data.task.mode);
    expect(typeof created.data.task.cow).toBe("boolean");

    const listed = JSON.parse((await cli(repo, storage, ["list"])).stdout) as {
      kind: string;
      data: { tasks: Array<{ name: string; path: string }> };
    };
    expect(listed.kind).toBe("esaytree.task-list");
    expect(listed.data.tasks).toEqual([
      expect.objectContaining({ name: "demo", path: created.data.task.path }),
    ]);

    const switched = JSON.parse((await cli(repo, storage, ["switch", "demo"])).stdout) as {
      kind: string;
      data: { task: { path: string } };
    };
    expect(switched).toMatchObject({
      kind: "esaytree.task-switch",
      data: { task: { path: created.data.task.path } },
    });

    const removed = JSON.parse((await cli(repo, storage, ["rm", "demo"])).stdout) as {
      kind: string;
      data: { task: { name: string } };
    };
    expect(removed).toEqual(expect.objectContaining({
      kind: "esaytree.task-remove",
      data: { task: { name: "demo" } },
    }));
    expect(execFileSync("git", ["branch", "--list", "esaytree/demo"], {
      cwd: repo,
      encoding: "utf8",
    })).toBe("");
  });

  it("JSON 错误包含稳定错误码与退出码", async () => {
    const { repo, storage } = fixture();
    try {
      await cli(repo, storage, ["switch", "missing"]);
      throw new Error("expected esaytree switch to fail");
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      expect(failure.code).toBe(3);
      expect(JSON.parse(failure.stdout ?? "{}")).toMatchObject({
        schema: "esaytree.dev/cli/v1",
        kind: "esaytree.error",
        error: { code: "worktree_missing" },
      });
    }
  });
});
