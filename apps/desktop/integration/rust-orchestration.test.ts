import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { RustClient } from "../src/main/rust-client";
import { StateStore } from "../src/main/state-store";

const binary = resolve("../../target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const fixtures: { directory: string; runtime: RustRuntime }[] = [];

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-orch-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  return { directory, dataDir, store, runtime };
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function initRepo(directory: string): string {
  const repo = resolve(directory, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  git(["symbolic-ref", "HEAD", "refs/heads/master"], repo);
  git(["config", "user.email", "test@prospero.local"], repo);
  git(["config", "user.name", "Prospero Test"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  writeFileSync(resolve(repo, "README.md"), "# base\n");
  git(["add", "README.md"], repo);
  git(["commit", "-q", "-m", "base"], repo);
  return repo;
}

/// Fake claude: announce init, swallow one prompt line, idle until killed.
/// Writes nothing into the worktree, so safety inspection sees a clean tree.
const FAKE_CLAUDE = `#!/usr/bin/env python3
import json, sys, time
sys.stdout.write(json.dumps({"type": "system", "subtype": "init", "session_id": "fake-orch-worker"}) + "\\n")
sys.stdout.flush()
sys.stdin.readline()
while True:
    time.sleep(1)
`;

function installFakeClaude(directory: string): string {
  const cli = resolve(directory, "fake-claude.py");
  writeFileSync(cli, FAKE_CLAUDE);
  chmodSync(cli, 0o755);
  return cli;
}

function clientFor(dataDir: string): RustClient {
  const connection = JSON.parse(readFileSync(resolve(dataDir, "connection.json"), "utf8")) as { baseUrl: string; token: string };
  return new RustClient(connection.baseUrl, connection.token);
}

const action = (runtime: RustRuntime, method: string, params: Record<string, unknown>, timeoutMs?: number) =>
  runtime.request("/_prospero/control/orchestration/action", { method: "POST", body: { method, params }, timeoutMs }) as Promise<Record<string, unknown>>;

describe.skipIf(process.platform === "win32")("orchestration through the desktop Rust bridge", () => {
  let previousBin: string | undefined;

  afterEach(async () => {
    for (const { directory, runtime } of fixtures.splice(0)) {
      expect((await runtime.stop()).ok).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
    if (previousBin === undefined) delete process.env["PROSPERO_CLAUDE_BIN"];
    else process.env["PROSPERO_CLAUDE_BIN"] = previousBin;
  });

  it("projects a created graph, drives a worker with manual delivery, and preserves the asset past run deletion", async () => {
    const { directory, dataDir, store, runtime } = fixture();
    const repo = initRepo(directory);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    process.env["PROSPERO_CLAUDE_BIN"] = installFakeClaude(directory);
    expect((await runtime.start()).ok).toBe(true);

    // ── graph.create through the desktop action bridge ──────────────────────
    const longSpec = "S".repeat(500);
    const graph = await action(runtime, "graph.create", {
      operationId: crypto.randomUUID(),
      objective: "stage 8 acceptance",
      nodes: [
        { clientId: "a", title: "isolated worker", spec: "work in a fresh worktree", deps: [] },
        { clientId: "b", title: "cwd worker", spec: longSpec, deps: ["a"] },
      ],
    });
    const runId = String((graph["run"] as Record<string, unknown>)["id"]);
    const idMap = graph["idMap"] as Record<string, string>;
    const taskA = idMap["a"]!;
    const taskB = idMap["b"]!;

    const projected = store.snapshot().orchestration;
    expect(projected.runs).toHaveLength(1);
    expect(projected.runs[0]!["id"]).toBe(runId);
    expect(projected.runs[0]!["automation"]).toBeNull();
    expect(projected.tasks).toHaveLength(2);
    const projectedB = projected.tasks.find(task => task["id"] === taskB)!;
    expect(String(projectedB["spec"])).toHaveLength(320);
    expect(projectedB["specTruncated"]).toBe(true);
    expect(projectedB["resultTruncated"]).toBe(false);

    // The task detail bridge returns the untruncated record.
    const fullTask = await runtime.request(`/_prospero/control/orchestration/task/${taskB}`);
    expect(String(fullTask!["spec"])).toHaveLength(500);
    const runTasks = await runtime.request(`/_prospero/control/orchestration/run/${runId}/tasks`);
    expect(runTasks!["items"] as unknown[]).toHaveLength(2);

    // ── gate resolved through the desktop bridge ───────────────────────────
    const client = clientFor(dataDir);
    const gate = await client.createGate(runId, { taskId: null, question: "ship it?", options: ["yes", "no"] });
    const resolvedGate = await runtime.request(`/_prospero/control/orchestration/gate/${gate.id}/resolve`, { method: "POST", body: { decision: "yes" } });
    expect(resolvedGate!["status"]).toBe("resolved");
    expect(store.snapshot().orchestration.gates[0]!["decision"]).toBe("yes");

    // ── isolated worker: worktree + manual success delivery ────────────────
    const startOperationId = crypto.randomUUID();
    const start = await action(runtime, "worker.start", {
      operationId: startOperationId, taskId: taskA, agent: "claude", cwd: repo,
      worktree: "new", kind: "structured", approvalPolicy: "standard",
    }, 180_000);
    const worktree = start["worktree"] as Record<string, unknown>;
    const dispatchId = String((start["dispatch"] as Record<string, unknown>)["id"]);
    const sessionId = String(start["sessionId"]);
    expect(worktree).toBeTruthy();
    const treePath = String(worktree["path"]);
    expect(existsSync(treePath)).toBe(true);
    expect((start["dispatch"] as Record<string, unknown>)["worktreePath"]).toBe(treePath);
    let snapshot = store.snapshot().orchestration;
    expect(snapshot.dispatches.some(d => d["id"] === dispatchId && d["worktreePath"] === treePath)).toBe(true);
    expect(snapshot.worktreeAssets.some(asset => asset["path"] === treePath && asset["taskId"] === taskA)).toBe(true);

    // Retrying the same operationId replays the frozen outcome — no second tree.
    const replay = await action(runtime, "worker.start", {
      operationId: startOperationId, taskId: taskA, agent: "claude", cwd: repo,
      worktree: "new", kind: "structured",
    }, 180_000);
    expect(String((replay["dispatch"] as Record<string, unknown>)["id"])).toBe(dispatchId);
    expect(store.snapshot().orchestration.worktreeAssets.filter(asset => asset["taskId"] === taskA)).toHaveLength(1);

    // Manual delivery (no prospero CLI in Rust mode).
    const settled = await runtime.request(`/_prospero/control/orchestration/dispatch/${dispatchId}/settle`, {
      method: "POST", body: { success: true, outcome: "delivered: verified by hand" },
    });
    expect((settled!["task"] as Record<string, unknown>)["status"]).toBe("done");
    expect((settled!["dispatch"] as Record<string, unknown>)["state"]).toBe("succeeded");

    // The live worker session must end before its worktree can be cleaned.
    await client.agentClose(sessionId);
    const inspection = await action(runtime, "worktree.inspect", { assetId: String(worktree["id"]), targetRef: "master" }, 180_000);
    expect(inspection["state"]).toBe("safe_to_clean");
    const cleanup = await action(runtime, "worktree.cleanup", {
      operationId: crypto.randomUUID(), assetId: String(worktree["id"]),
      targetRef: "master", confirm: true, deleteBranch: false,
    }, 180_000);
    expect((cleanup["asset"] as Record<string, unknown>)["state"]).toBe("cleaned");
    expect(existsSync(treePath)).toBe(false);

    // ── cwd-mode worker, then stop converges the task to failed ────────────
    const startB = await action(runtime, "worker.start", {
      operationId: crypto.randomUUID(), taskId: taskB, agent: "claude", cwd: repo,
      worktree: "none", kind: "structured", approvalPolicy: "standard",
    }, 180_000);
    expect((startB["dispatch"] as Record<string, unknown>)["worktreePath"]).toBeNull();
    const stopped = await action(runtime, "worker.stop", {
      operationId: crypto.randomUUID(), taskId: taskB, reason: "Stopped from Prospero desktop",
    });
    expect((stopped["task"] as Record<string, unknown>)["status"]).toBe("failed");

    // Deleting a settled run keeps the asset row as provenance (no FK cascade).
    const deletion = await action(runtime, "run.delete", { operationId: crypto.randomUUID(), runId });
    expect(deletion["runId"]).toBe(runId);
    snapshot = store.snapshot().orchestration;
    expect(snapshot.runs.some(run => run["id"] === runId)).toBe(false);
    expect(snapshot.worktreeAssets.some(asset => asset["runId"] === runId && asset["state"] === "cleaned")).toBe(true);
  }, 60_000);

  it("refuses unbridged automation, non-Claude workers and run deletion while a dispatch is live", async () => {
    const { directory, runtime } = fixture();
    const repo = initRepo(directory);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    process.env["PROSPERO_CLAUDE_BIN"] = installFakeClaude(directory);
    expect((await runtime.start()).ok).toBe(true);

    const graph = await action(runtime, "graph.create", {
      operationId: crypto.randomUUID(), objective: "guard rails",
      nodes: [{ clientId: "a", title: "only task", spec: "go", deps: [] }],
    });
    const runId = String((graph["run"] as Record<string, unknown>)["id"]);
    const taskId = String((graph["idMap"] as Record<string, string>)["a"]);

    await expect(action(runtime, "automation.start", { operationId: crypto.randomUUID(), runId, agent: "claude", cwd: repo, approvalPolicy: "standard", workspace: "run" }))
      .rejects.toThrow("尚未接入");
    await expect(action(runtime, "automation.pause", { operationId: crypto.randomUUID(), runId }))
      .rejects.toThrow("尚未接入");
    await expect(action(runtime, "worker.start", { operationId: crypto.randomUUID(), taskId, agent: "codex", cwd: repo, worktree: "new" }))
      .rejects.toThrow("Claude");
    await expect(action(runtime, "worker.start", { operationId: crypto.randomUUID(), taskId, agent: "claude", cwd: repo, worktree: "new", accountId: "acct-1" }))
      .rejects.toThrow("账号");
    await expect(action(runtime, "worker.start", { operationId: crypto.randomUUID(), taskId, agent: "claude", cwd: repo, worktree: "new", approvalPolicy: "yolo" }))
      .rejects.toThrow("yolo");

    await action(runtime, "worker.start", {
      operationId: crypto.randomUUID(), taskId, agent: "claude", cwd: repo,
      worktree: "none", kind: "structured",
    }, 180_000);
    // Active dispatch: run deletion must surface the daemon 400.
    await expect(action(runtime, "run.delete", { operationId: crypto.randomUUID(), runId }))
      .rejects.toThrow(/400/);
  }, 60_000);

  it("refreshes the projection when an external orchestration event arrives", async () => {
    const { dataDir, store, runtime } = fixture();
    expect((await runtime.start()).ok).toBe(true);
    const client = clientFor(dataDir);
    expect(store.snapshot().orchestration.runs).toHaveLength(0);
    await client.createRun({ objective: "external mutation", coordinatorSessionId: null });
    await vi.waitFor(() => {
      expect(store.snapshot().orchestration.runs.some(run => run["objective"] === "external mutation")).toBe(true);
    }, { timeout: 4000, interval: 100 });
  }, 15_000);
});
