import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { StateStore } from "../src/main/state-store";
import { timelineEvent } from "../src/renderer/src/timeline-controller";

const binary = resolve("../../target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const fixtures: { directory: string; runtime: RustRuntime }[] = [];

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-subagents-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  return { directory, dataDir, runtime };
}

function initRepo(directory: string): string {
  const repo = resolve(directory, "repo");
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  git(["init", "-q", repo]);
  return repo;
}

// Fake CLI: one Task-tool subagent turn. The nested frames carry
// parent_tool_use_id, exactly like the real headless CLI emits them.
const FAKE_CLAUDE = `#!/usr/bin/env python3
import json, sys
def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()
emit({"type": "system", "subtype": "init", "session_id": "fake-subagents"})
sys.stdin.readline()
emit({"type": "system", "subtype": "task_started", "task_id": "task-1",
      "tool_use_id": "toolu_1", "subagent_type": "Explore",
      "task_type": "search", "description": "find things",
      "prompt": "search the repo"})
emit({"type": "assistant", "message": {"role": "assistant", "content": [
    {"type": "tool_use", "id": "toolu_1", "name": "Task",
     "input": {"description": "find things", "prompt": "search the repo"}}]}})
emit({"type": "stream_event", "parent_tool_use_id": "toolu_1",
      "event": {"type": "content_block_start", "index": 0,
                "content_block": {"type": "text", "text": ""}}})
emit({"type": "stream_event", "parent_tool_use_id": "toolu_1",
      "event": {"type": "content_block_delta", "index": 0,
                "delta": {"type": "text_delta", "text": "subagent whispers"}}})
emit({"type": "stream_event", "parent_tool_use_id": "toolu_1",
      "event": {"type": "content_block_stop", "index": 0}})
emit({"type": "assistant", "parent_tool_use_id": "toolu_1",
      "message": {"role": "assistant", "content": [
    {"type": "tool_use", "id": "call_sub", "name": "Bash",
     "input": {"command": "ls"}}]}})
emit({"type": "user", "parent_tool_use_id": "toolu_1",
      "message": {"role": "user", "content": [
    {"type": "tool_result", "tool_use_id": "call_sub",
     "is_error": False, "content": "done"}]}})
emit({"type": "system", "subtype": "task_progress", "task_id": "task-1",
      "summary": "halfway"})
emit({"type": "system", "subtype": "task_notification", "task_id": "task-1",
      "status": "completed", "summary": "found things"})
emit({"type": "user", "message": {"role": "user", "content": [
    {"type": "tool_result", "tool_use_id": "toolu_1",
     "is_error": False, "content": "task finished"}]}})
emit({"type": "result", "subtype": "success", "is_error": False})
sys.stdout.flush()
`;

describe.skipIf(process.platform === "win32")("Claude Task-tool subagents through the Rust bridge", () => {
  let previousBin: string | undefined;

  afterEach(async () => {
    for (const { directory, runtime } of fixtures.splice(0)) {
      expect((await runtime.stop()).ok).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
    if (previousBin === undefined) delete process.env["PROSPERO_CLAUDE_BIN"];
    else process.env["PROSPERO_CLAUDE_BIN"] = previousBin;
  });

  it("renders one collapsing card and serves the detail transcript", async () => {
    const { directory, runtime } = fixture();
    const repo = initRepo(directory);
    const cli = resolve(directory, "fake-claude");
    writeFileSync(cli, FAKE_CLAUDE);
    chmodSync(cli, 0o755);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    process.env["PROSPERO_CLAUDE_BIN"] = cli;
    expect((await runtime.start()).ok).toBe(true);

    const created = await runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "structured", agent: "claude", cwd: repo, approvalPolicy: "standard" },
    });
    const sessionId = String(created!["id"]);
    await runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
      method: "POST",
      body: { type: "chat.send", text: "spawn a worker" },
    });

    const signal = new AbortController().signal;
    let card: Record<string, unknown> | undefined;
    await viWaitFor(async () => {
      const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, signal);
      card = page.items.find(record => record.body.kind === "subagent");
      expect(card, "subagent card should reach the main timeline").toBeTruthy();
      const finished = page.items.some(
        record => record.body.kind === "turn_end" && (record.body as { finish?: string }).finish === "completed",
      );
      expect(finished).toBe(true);
    });

    // The card keeps exactly one id across lifecycle rewrites and projects to
    // the legacy "subagent.started" chat event the renderer folds.
    const body = card!.body as Record<string, unknown>;
    expect(body["subagentId"]).toBe("toolu_1");
    expect(body["name"]).toBe("Explore");
    expect(body["role"]).toBe("search");
    expect(body["status"]).toBe("completed");
    expect(body["canMessage"]).toBe(false);
    expect(body["summary"]).toBe("found things");
    const event = timelineEvent(card as never);
    expect(event["kind"]).toBe("subagent.started");
    expect((event["subagent"] as Record<string, unknown>)["id"]).toBe("toolu_1");
    expect((event["subagent"] as Record<string, unknown>)["preview"]).toBe("found things");

    // Subagent-owned text and tool calls stay off the main timeline.
    const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, signal);
    expect(page.items.some(record => record.preview === "subagent whispers")).toBe(false);
    expect(page.items.some(record => record.body.kind === "tool"
      && (record.body as { name?: string }).name === "Bash")).toBe(false);
    expect(page.items.filter(record => record.body.kind === "subagent")).toHaveLength(1);

    // The detail route the desktop "查看执行详情" pane calls.
    const snapshot = await runtime.request(
      `/_prospero/control/session/${sessionId}/subagent/toolu_1/events`,
    ) as Record<string, unknown>;
    const subagent = snapshot["subagent"] as Record<string, unknown>;
    expect(subagent["id"]).toBe("toolu_1");
    expect(subagent["name"]).toBe("Explore");
    expect(subagent["status"]).toBe("completed");
    expect(typeof snapshot["evSeq"]).toBe("number");
    const events = snapshot["events"] as Array<Record<string, unknown>>;
    expect(events.some(item => item["kind"] === "assistant.text" && item["text"] === "subagent whispers")).toBe(true);
    expect(events.some(item => item["kind"] === "tool.end" && item["summary"] === "done")).toBe(true);

    // Unknown subagent ids are a failing request (404 from the daemon).
    await expect(runtime.request(
      `/_prospero/control/session/${sessionId}/subagent/ghost/events`,
    )).rejects.toThrow();
  }, 30_000);
});

async function viWaitFor(check: () => Promise<void>, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
