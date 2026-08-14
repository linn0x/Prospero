import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationService } from "../src/orchestration/collaboration.js";
import { orchestrationControlApi } from "../src/orchestration/control-api.js";
import { DispatchService, type WorkerSessionManager } from "../src/orchestration/dispatch.js";
import { createEsaytree } from "../src/orchestration/esaytree.js";
import { OrchestrationStore } from "../src/orchestration/store.js";
import {
  WorktreeAssetError,
  WorktreeAssetService,
} from "../src/orchestration/worktree-assets.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "prospero-worktree-assets-"));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(): { root: string; repo: string; assets: string } {
  const root = temporaryRoot();
  const repo = path.join(root, "repo");
  const assets = path.join(root, "assets");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "assets@example.test"]);
  git(repo, ["config", "user.name", "Asset Tests"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "base"]);
  return { root, repo, assets };
}

async function registeredAsset(
  store: OrchestrationStore,
  repo: string,
  assets: string,
  name: string,
) {
  const run = store.createRun({ objective: name });
  const created = await createEsaytree({
    repo,
    name,
    at: path.join(assets, name),
    branch: `prospero/${name}`,
    cloneIgnored: false,
  });
  return {
    created,
    asset: store.registerWorktreeAsset({
      kind: "worker",
      runId: run.id,
      taskId: `task-${name}`,
      repo,
      path: created.path,
      branch: created.branch,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("编排工作树资产检查与清理", () => {
  it("把路径丢失、dirty、未进入目标、等价补丁和可安全清理区分开", async () => {
    const { repo, assets } = repository();
    const store = new OrchestrationStore();
    const service = new WorktreeAssetService(store);

    const missing = await registeredAsset(store, repo, assets, "missing");
    rmSync(missing.created.path, { recursive: true, force: true });
    expect((await service.inspect(missing.asset.id, "main")).state).toBe("missing");

    const dirty = await registeredAsset(store, repo, assets, "dirty");
    writeFileSync(path.join(dirty.created.path, "tracked.txt"), "dirty\n");
    expect((await service.inspect(dirty.asset.id, "main")).state).toBe("dirty");

    const unmerged = await registeredAsset(store, repo, assets, "unmerged");
    writeFileSync(path.join(unmerged.created.path, "tracked.txt"), "unmerged\n");
    git(unmerged.created.path, ["add", "tracked.txt"]);
    git(unmerged.created.path, ["commit", "-m", "worker patch"]);
    expect((await service.inspect(unmerged.asset.id, "main")).state).toBe("unmerged");
    // targetRef 省略时也必须以登记的源仓 HEAD 为目标，不能把 worker 自己的 HEAD
    // 错当目标而误判为安全。
    expect((await service.inspect(unmerged.asset.id)).state).toBe("unmerged");

    const detached = await registeredAsset(store, repo, assets, "detached");
    git(detached.created.path, ["checkout", "--detach"]);
    writeFileSync(path.join(detached.created.path, "tracked.txt"), "detached unmerged\n");
    git(detached.created.path, ["add", "tracked.txt"]);
    git(detached.created.path, ["commit", "-m", "detached patch"]);
    expect(await service.inspect(detached.asset.id, "main")).toMatchObject({
      state: "unmerged",
      branch: null,
    });

    const equivalent = await registeredAsset(store, repo, assets, "equivalent");
    writeFileSync(path.join(equivalent.created.path, "tracked.txt"), "equivalent\n");
    git(equivalent.created.path, ["add", "tracked.txt"]);
    git(equivalent.created.path, ["commit", "-m", "worker equivalent patch"]);
    const workerCommit = git(equivalent.created.path, ["rev-parse", "HEAD"]);
    // 改变目标分支的 parent，确保 cherry-pick 生成不同 commit id，才能测到
    // “补丁等价但提交没有被目标直接包含”的分支。
    writeFileSync(path.join(repo, "main-only.txt"), "main\n");
    git(repo, ["add", "main-only.txt"]);
    git(repo, ["commit", "-m", "main-only"]);
    git(repo, ["cherry-pick", workerCommit]);
    expect((await service.inspect(equivalent.asset.id, "main")).state).toBe("equivalent");

    const safe = await registeredAsset(store, repo, assets, "safe");
    expect(await service.inspect(safe.asset.id, "main")).toMatchObject({
      state: "safe_to_clean",
      dirty: false,
      aheadCommitCount: 0,
    });
  });

  it("cleanup 必须显式确认、在删除前重新检查，并默认保留恢复分支", async () => {
    const { repo, assets } = repository();
    const store = new OrchestrationStore();
    const service = new WorktreeAssetService(store);
    const { asset, created } = await registeredAsset(store, repo, assets, "cleanup");

    await expect(service.cleanup({ assetId: asset.id, targetRef: "main", confirm: false }))
      .rejects.toMatchObject({ code: "cleanup_confirmation_required" } satisfies Partial<WorktreeAssetError>);
    expect(() => readFileSync(path.join(created.path, "tracked.txt"), "utf8")).not.toThrow();

    await expect(service.inspect(asset.id, "main")).resolves.toMatchObject({ state: "safe_to_clean" });
    // cleanup 不采信旧检查结果；检查和删除之间出现的改动必须再次挡住删除。
    writeFileSync(path.join(created.path, "tracked.txt"), "late dirty change\n");
    await expect(service.cleanup({ assetId: asset.id, targetRef: "main", confirm: true }))
      .rejects.toMatchObject({ code: "worktree_not_cleanable" } satisfies Partial<WorktreeAssetError>);
    expect(readFileSync(path.join(created.path, "tracked.txt"), "utf8")).toBe("late dirty change\n");
    git(created.path, ["checkout", "--", "tracked.txt"]);

    const cleaned = await service.cleanup({ assetId: asset.id, targetRef: "main", confirm: true });
    expect(cleaned).toMatchObject({ branchDeleted: false, warning: null });
    expect(store.getWorktreeAsset(asset.id)).toMatchObject({
      state: "cleaned",
      branch: "prospero/cleanup",
      cleanup: { branchDeleted: false },
    });
    expect(git(repo, ["branch", "--list", "prospero/cleanup"])).toBe("prospero/cleanup");
  });

  it("Run 删除后不删除或失联资产，并拒绝清理未合并补丁", async () => {
    const { repo, assets } = repository();
    const store = new OrchestrationStore();
    const service = new WorktreeAssetService(store);
    const { asset, created } = await registeredAsset(store, repo, assets, "retained");
    writeFileSync(path.join(created.path, "tracked.txt"), "unmerged\n");
    git(created.path, ["add", "tracked.txt"]);
    git(created.path, ["commit", "-m", "keep this"]);

    const deletion = store.deleteRun(asset.runId);
    expect(deletion.preservedWorktreeAssetIds).toEqual([asset.id]);
    expect(store.getWorktreeAsset(asset.id)).toMatchObject({
      runId: asset.runId,
      path: created.path,
      branch: "prospero/retained",
      runDeletedAt: expect.any(Number),
      state: "preserved",
    });
    await expect(service.cleanup({ assetId: asset.id, targetRef: "main", confirm: true }))
      .rejects.toMatchObject({ code: "worktree_not_cleanable" } satisfies Partial<WorktreeAssetError>);
    expect(git(created.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("prospero/retained");
  });

  it("worker:new 在创建会话前登记独立资产，并把 dispatch 归属回填", async () => {
    const { repo } = repository();
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "worker 登记" });
    const task = store.createTask({ runId: run.id, title: "实现", spec: "实现" });
    const sessions: WorkerSessionManager = {
      async create(input) {
        return {
          id: "worker-session",
          agent: input.agent,
          kind: "structured",
          title: "worker",
          cwd: input.cwd ?? repo,
          status: "idle",
          createdAt: Date.now(),
          cols: 120,
          rows: 40,
        };
      },
      async chatSend() {},
      requirePty() { return { writeInput() {} }; },
      async kill() {},
    };

    const started = await new DispatchService(store, sessions).startWorker({
      taskId: task.id,
      agent: "codex",
      worktree: "new",
      cwd: repo,
    });
    expect(started.worktree?.assetId).toBeTruthy();
    expect(store.getWorktreeAsset(started.worktree!.assetId)).toMatchObject({
      kind: "worker",
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      repo: realpathSync.native(repo),
      path: started.worktree?.path,
      branch: expect.stringMatching(new RegExp(`^prospero/${run.id}/${task.id}/`)),
      state: "active",
    });
  });
});

describe("资产持久化迁移与控制 API", () => {
  it("从 v1 orchestration.json 保守迁移 Run 与 worker 的既有路径，不触碰磁盘", () => {
    const home = temporaryRoot();
    const original = new OrchestrationStore();
    const run = original.createRun({ objective: "迁移" });
    original.setRunAutomation(run.id, {
      state: "paused",
      agent: "codex",
      approvalPolicy: "standard",
      workspace: "run",
      cwd: "/legacy/repo",
      workspacePath: "/legacy/worktree/subdir",
      branch: "prospero/legacy/run",
      startedAt: 10,
      updatedAt: 10,
      lastError: null,
    });
    const task = original.createTask({ runId: run.id, title: "worker", spec: "迁移" });
    const dispatch = original.createDispatch({
      taskId: task.id,
      sessionId: "legacy-worker",
      worktreePath: "/legacy/worker-worktree",
    });
    const legacy = original.snapshot() as unknown as Record<string, unknown>;
    legacy.version = 1;
    delete legacy.worktreeAssets;
    writeFileSync(path.join(home, "orchestration.json"), JSON.stringify(legacy));

    const migrated = new OrchestrationStore(home);
    expect(migrated.listWorktreeAssets()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "run",
        runId: run.id,
        repo: "/legacy/repo",
        path: "/legacy/worktree/subdir",
        branch: "prospero/legacy/run",
        state: "preserved",
        legacy: true,
      }),
      expect.objectContaining({
        kind: "worker",
        runId: run.id,
        taskId: task.id,
        dispatchId: dispatch.id,
        repo: "/legacy/worker-worktree",
        path: "/legacy/worker-worktree",
        legacy: true,
      }),
    ]));
    expect(JSON.parse(readFileSync(path.join(home, "orchestration.json"), "utf8"))).toMatchObject({
      version: 2,
    });
    migrated.close();
  });

  it("控制 API 对 cleanup 强制 operationId 与 confirm，并让 inspect 返回安全结论", async () => {
    const { repo, assets } = repository();
    const store = new OrchestrationStore();
    const { asset } = await registeredAsset(store, repo, assets, "api");
    const unusedSessions: WorkerSessionManager = {
      async create() { throw new Error("not used"); },
      async chatSend() { throw new Error("not used"); },
      requirePty() { throw new Error("not used"); },
      async kill() {},
    };
    const api = orchestrationControlApi(
      store,
      new DispatchService(store, unusedSessions),
      new CollaborationService(store),
    );
    const signal = new AbortController().signal;

    await expect(api("worktree.cleanup", {
      assetId: asset.id,
      targetRef: "main",
      confirm: false,
      operationId: "cleanup-no-confirm",
      actorSessionId: null,
    }, signal)).rejects.toMatchObject({ code: "cleanup_confirmation_required" });
    await expect(api("worktree.cleanup", {
      assetId: asset.id,
      targetRef: "main",
      confirm: true,
      actorSessionId: null,
    }, signal)).rejects.toMatchObject({ code: "bad_params" });
    await expect(api("worktree.inspect", {
      assetId: asset.id,
      targetRef: "main",
      actorSessionId: null,
    }, signal)).resolves.toMatchObject({ state: "safe_to_clean" });
  });
});
