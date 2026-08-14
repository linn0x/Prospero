import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationService } from "../src/orchestration/collaboration.js";
import { orchestrationControlApi } from "../src/orchestration/control-api.js";
import { DispatchService, type WorkerSessionManager } from "../src/orchestration/dispatch.js";
import { createEsaytree, removeWorktree } from "../src/orchestration/esaytree.js";
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

async function migratedLegacyWorker(
  repo: string,
  assets: string,
  name: string,
): Promise<{
  store: OrchestrationStore;
  assetId: string;
  path: string;
  branch: string;
}> {
  const original = new OrchestrationStore();
  const run = original.createRun({ objective: `legacy ${name}` });
  const task = original.createTask({ runId: run.id, title: name, spec: name });
  const created = await createEsaytree({
    repo,
    name: `legacy-${name}`,
    at: path.join(assets, `legacy-${name}`),
    branch: `prospero/legacy-${name}`,
    cloneIgnored: false,
  });
  const dispatch = original.createDispatch({
    taskId: task.id,
    sessionId: `legacy-session-${name}`,
    worktreePath: created.path,
  });
  const legacy = original.snapshot() as unknown as Record<string, unknown>;
  legacy.version = 1;
  delete legacy.worktreeAssets;
  const home = temporaryRoot();
  writeFileSync(path.join(home, "orchestration.json"), JSON.stringify(legacy));
  const store = new OrchestrationStore(home);
  const asset = store.listWorktreeAssets().find((candidate) => candidate.dispatchId === dispatch.id);
  if (!asset) throw new Error("v1 worker asset was not migrated");
  return { store, assetId: asset.id, path: created.path, branch: created.branch! };
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

  it("cleanup 拒绝仍由 live settled session 使用的工作树，并记录后续处理原因", async () => {
    const { repo, assets } = repository();
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "live settled worker" });
    const task = store.createTask({ runId: run.id, title: "实现", spec: "" });
    const created = await createEsaytree({
      repo,
      name: "live-settled",
      at: path.join(assets, "live-settled"),
      branch: "prospero/live-settled",
      cloneIgnored: false,
    });
    const asset = store.registerWorktreeAsset({
      kind: "worker",
      runId: run.id,
      taskId: task.id,
      repo,
      path: created.path,
      branch: created.branch,
    });
    const dispatch = store.createDispatch({
      taskId: task.id,
      sessionId: "settled-but-live",
      worktreePath: created.path,
    });
    store.linkWorktreeAssetDispatch(asset.id, dispatch.id);
    store.setTaskStatus(task.id, "done", "已交付");
    store.setDispatchState(dispatch.id, "succeeded", "已交付");
    const sessions = {
      infoOf() {
        return {
          id: "settled-but-live",
          agent: "codex" as const,
          kind: "structured" as const,
          title: "worker",
          cwd: created.path,
          status: "running" as const,
          createdAt: 1,
          cols: 80,
          rows: 24,
        };
      },
    };
    const service = new WorktreeAssetService(store, undefined, sessions);
    const trackedBeforeCleanup = readFileSync(path.join(created.path, "tracked.txt"), "utf8");

    await expect(service.cleanup({ assetId: asset.id, targetRef: "main", confirm: true }))
      .rejects.toMatchObject({ code: "worktree_not_cleanable" } satisfies Partial<WorktreeAssetError>);
    expect(readFileSync(path.join(created.path, "tracked.txt"), "utf8")).toBe(trackedBeforeCleanup);
    expect(store.getWorktreeAsset(asset.id)).toMatchObject({
      state: "preserved",
      lastError: expect.stringContaining("settled-but-live"),
    });
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
    const oldTask = store.createTask({ runId: run.id, title: "旧 writer", spec: "" });
    const oldDispatch = store.createDispatch({
      taskId: oldTask.id,
      sessionId: "old-live-session",
      worktreePath: repo,
    });
    const oldAsset = store.registerWorktreeAsset({
      kind: "worker",
      runId: run.id,
      taskId: oldTask.id,
      repo,
      path: repo,
      branch: "main",
    });
    store.linkWorktreeAssetDispatch(oldAsset.id, oldDispatch.id);
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
      infoOf(sid) {
        if (sid !== "old-live-session") throw new Error("not used");
        return {
          id: sid,
          agent: "codex",
          kind: "structured",
          title: "old worker",
          cwd: repo,
          status: "running",
          createdAt: 1,
          cols: 80,
          rows: 24,
        };
      },
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
    // `new` 创建独立目录，不复用旧 writer 的 cwd，因此不应被 none 模式的租约挡住。
    expect(started.worktree?.path).not.toBe(repo);
  });

  it("deleteBranch 在检查后分支被推进时保留新提交并报告 warning", async () => {
    const { repo, assets } = repository();
    const store = new OrchestrationStore();
    const { asset, created } = await registeredAsset(store, repo, assets, "branch-race");
    const oldCommit = git(created.path, ["rev-parse", "HEAD"]);
    const advancedCommit = git(repo, ["commit-tree", `${oldCommit}^{tree}`, "-p", oldCommit]);
    const service = new WorktreeAssetService(store, {
      async remove(context, target, options) {
        expect(context).toBe(realpathSync.native(repo));
        await removeWorktree(context, target, options);
        // Simulate another actor advancing the just-inspected branch after the
        // worktree removal and before cleanup's branch deletion.
        git(context, ["update-ref", `refs/heads/${asset.branch!}`, advancedCommit, oldCommit]);
      },
    });

    const cleaned = await service.cleanup({
      assetId: asset.id,
      targetRef: "main",
      confirm: true,
      deleteBranch: true,
    });
    expect(cleaned).toMatchObject({ branchDeleted: false, warning: expect.stringContaining(asset.branch!) });
    expect(git(repo, ["rev-parse", `refs/heads/${asset.branch}`])).toBe(advancedCommit);
  });

  it("worker session.create 或 chat 失败后，已创建资产仍会同步持久化并可发现", async () => {
    const { root, repo } = repository();
    const createHome = path.join(root, "create-failure-state");
    const createStore = new OrchestrationStore(createHome);
    const createRun = createStore.createRun({ objective: "create failure" });
    const createTask = createStore.createTask({ runId: createRun.id, title: "worker", spec: "worker" });
    const createFails: WorkerSessionManager = {
      async create() { throw new Error("session.create failed"); },
      async chatSend() { throw new Error("not reached"); },
      requirePty() { throw new Error("not reached"); },
      async kill() {},
      infoOf() { throw new Error("not used"); },
    };
    await expect(new DispatchService(createStore, createFails).startWorker({
      taskId: createTask.id, agent: "codex", worktree: "new", cwd: repo,
    })).rejects.toThrow("session.create failed");
    createStore.close();
    const reloadedAfterCreate = new OrchestrationStore(createHome);
    expect(reloadedAfterCreate.listWorktreeAssets(createRun.id)).toEqual([
      expect.objectContaining({ kind: "worker", taskId: createTask.id, state: "preserved", dispatchId: null }),
    ]);
    reloadedAfterCreate.close();

    const chatHome = path.join(root, "chat-failure-state");
    const chatStore = new OrchestrationStore(chatHome);
    const chatRun = chatStore.createRun({ objective: "chat failure" });
    const chatTask = chatStore.createTask({ runId: chatRun.id, title: "worker", spec: "worker" });
    const chatFails: WorkerSessionManager = {
      async create(input) {
        return {
          id: "chat-failure-session",
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
      async chatSend() { throw new Error("chatSend failed"); },
      requirePty() { throw new Error("not reached"); },
      async kill() {},
      infoOf() { throw new Error("not used"); },
    };
    await expect(new DispatchService(chatStore, chatFails).startWorker({
      taskId: chatTask.id, agent: "codex", worktree: "new", cwd: repo,
    })).rejects.toThrow("chatSend failed");
    chatStore.close();
    const reloadedAfterChat = new OrchestrationStore(chatHome);
    expect(reloadedAfterChat.listWorktreeAssets(chatRun.id)).toEqual([
      expect.objectContaining({
        kind: "worker",
        taskId: chatTask.id,
        state: "preserved",
        dispatchId: expect.any(String),
      }),
    ]);
    reloadedAfterChat.close();
  });
});

describe("资产持久化迁移与控制 API", () => {
  it("真实 v1 worker 迁移后默认 HEAD 不自指，显式 main 可区分未合入、等价、已合入与 detached", async () => {
    const { repo, assets } = repository();
    const unmerged = await migratedLegacyWorker(repo, assets, "unmerged");
    const unmergedService = new WorktreeAssetService(unmerged.store);
    writeFileSync(path.join(unmerged.path, "unmerged.txt"), "worker only\n");
    git(unmerged.path, ["add", "unmerged.txt"]);
    git(unmerged.path, ["commit", "-m", "legacy worker only"]);
    expect(unmerged.store.getWorktreeAsset(unmerged.assetId)).toMatchObject({
      repo: unmerged.path,
      path: unmerged.path,
      legacy: true,
    });
    // This is the historical regression: v1 repo===path must use the primary
    // worktree's HEAD, not the worker's own HEAD.
    await expect(unmergedService.inspect(unmerged.assetId)).resolves.toMatchObject({ state: "unmerged" });
    await expect(unmergedService.inspect(unmerged.assetId, "main"))
      .resolves.toMatchObject({ state: "unmerged" });

    const detached = await migratedLegacyWorker(repo, assets, "detached");
    git(detached.path, ["checkout", "--detach"]);
    writeFileSync(path.join(detached.path, "detached.txt"), "worker only\n");
    git(detached.path, ["add", "detached.txt"]);
    git(detached.path, ["commit", "-m", "legacy detached worker only"]);
    await expect(new WorktreeAssetService(detached.store).inspect(detached.assetId, "main"))
      .resolves.toMatchObject({ state: "unmerged", branch: null });

    const equivalent = await migratedLegacyWorker(repo, assets, "equivalent");
    writeFileSync(path.join(equivalent.path, "equivalent.txt"), "same patch\n");
    git(equivalent.path, ["add", "equivalent.txt"]);
    git(equivalent.path, ["commit", "-m", "legacy equivalent patch"]);
    const equivalentCommit = git(equivalent.path, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(repo, "main-only.txt"), "main\n");
    git(repo, ["add", "main-only.txt"]);
    git(repo, ["commit", "-m", "main-only"]);
    git(repo, ["cherry-pick", equivalentCommit]);
    await expect(new WorktreeAssetService(equivalent.store).inspect(equivalent.assetId, "main"))
      .resolves.toMatchObject({ state: "equivalent" });

    const safe = await migratedLegacyWorker(repo, assets, "safe");
    const safeService = new WorktreeAssetService(safe.store);
    await expect(safeService.inspect(safe.assetId, "main"))
      .resolves.toMatchObject({ state: "safe_to_clean" });
    // cleanup must reuse the primary worktree context found above; passing the
    // legacy self-reference would otherwise make git worktree remove unsafe.
    await expect(safeService.cleanup({
      assetId: safe.assetId,
      targetRef: "main",
      confirm: true,
      deleteBranch: true,
    })).resolves.toMatchObject({ branchDeleted: true, warning: null });
    expect(() => readFileSync(path.join(safe.path, "tracked.txt"), "utf8")).toThrow();
    expect(git(repo, ["branch", "--list", safe.branch])).toBe("");
  });

  it("v1 Run 的 monorepo 子目录会解析到 worktree 根后再检查和清理", async () => {
    const { repo, assets } = repository();
    const packageDir = path.join("packages", "app");
    mkdirSync(path.join(repo, packageDir), { recursive: true });
    writeFileSync(path.join(repo, packageDir, "package.json"), "{}\n");
    git(repo, ["add", packageDir]);
    git(repo, ["commit", "-m", "add monorepo package"]);

    const created = await createEsaytree({
      repo,
      name: "legacy-run-subdir",
      at: path.join(assets, "legacy-run-subdir"),
      branch: "prospero/legacy-run-subdir",
      cloneIgnored: false,
    });
    const original = new OrchestrationStore();
    const run = original.createRun({ objective: "legacy run subdir" });
    original.setRunAutomation(run.id, {
      state: "paused",
      agent: "codex",
      approvalPolicy: "standard",
      workspace: "run",
      cwd: path.join(repo, packageDir),
      workspacePath: path.join(created.path, packageDir),
      branch: created.branch,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    });
    const legacy = original.snapshot() as unknown as Record<string, unknown>;
    legacy.version = 1;
    delete legacy.worktreeAssets;
    const home = temporaryRoot();
    writeFileSync(path.join(home, "orchestration.json"), JSON.stringify(legacy));

    const migrated = new OrchestrationStore(home);
    const asset = migrated.listWorktreeAssets(run.id).find((candidate) => candidate.kind === "run");
    if (!asset) throw new Error("v1 Run asset was not migrated");
    expect(asset).toMatchObject({
      repo: path.join(repo, packageDir),
      path: path.join(created.path, packageDir),
      legacy: true,
    });

    const service = new WorktreeAssetService(migrated);
    await expect(service.inspect(asset.id, "main"))
      .resolves.toMatchObject({ state: "safe_to_clean", registered: true });
    await expect(service.cleanup({ assetId: asset.id, targetRef: "main", confirm: true }))
      .resolves.toMatchObject({ branchDeleted: false, warning: null });
    expect(() => readFileSync(path.join(created.path, packageDir, "package.json"), "utf8")).toThrow();
    expect(git(repo, ["branch", "--list", created.branch!])).toBe(created.branch);
    migrated.close();
  });

  it("没有独立源 worktree 的自指 legacy 候选只能返回 unknown", async () => {
    const { repo } = repository();
    const store = new OrchestrationStore();
    const run = store.createRun({ objective: "self reference" });
    const asset = store.registerWorktreeAsset({
      kind: "worker",
      runId: run.id,
      taskId: "legacy-self",
      repo,
      path: repo,
      branch: "main",
    });
    await expect(new WorktreeAssetService(store).inspect(asset.id))
      .resolves.toMatchObject({ state: "unknown" });
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
      infoOf() { throw new Error("not used"); },
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
