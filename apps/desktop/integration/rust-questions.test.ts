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
  const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-questions-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  return { directory, dataDir, runtime };
}

function initRepo(directory: string): string {
  const repo = resolve(directory, "repo");
  const result = spawnSync("git", ["init", "-q", repo], { cwd: directory, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return repo;
}

// Fake CLI: one AskUserQuestion turn. It blocks on the control_response and
// records exactly what the daemon wrote back.
const FAKE_CLAUDE = `#!/usr/bin/env python3
import json, os, sys
def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\\n")
    sys.stdout.flush()
emit({"type": "system", "subtype": "init", "session_id": "fake-questions"})
sys.stdin.readline()
emit({"type": "assistant", "message": {"role": "assistant", "content": [
    {"type": "tool_use", "id": "toolu_q", "name": "AskUserQuestion",
     "input": {"questions": []}}]}})
emit({"type": "control_request", "request_id": "req-q",
      "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion",
                  "input": {"questions": [
                      {"header": "选择方案", "question": "用哪种方案",
                       "multiSelect": False,
                       "options": [{"label": "方案 A", "description": "更快"},
                                   {"label": "方案 B", "description": "更稳"}]}]}}})
answer = sys.stdin.readline()
with open(os.path.join(os.getcwd(), "answers.log"), "w", encoding="utf-8") as log:
    log.write(answer)
emit({"type": "user", "message": {"role": "user", "content": [
    {"type": "tool_result", "tool_use_id": "toolu_q",
     "is_error": '"deny"' in answer, "content": "noted"}]}})
emit({"type": "result", "subtype": "success", "is_error": False})
sys.stdout.flush()
`;

describe.skipIf(process.platform === "win32")("Claude AskUserQuestion through the Rust bridge", () => {
  let previousBin: string | undefined;

  afterEach(async () => {
    for (const { directory, runtime } of fixtures.splice(0)) {
      expect((await runtime.stop()).ok).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
    if (previousBin === undefined) delete process.env["PROSPERO_CLAUDE_BIN"];
    else process.env["PROSPERO_CLAUDE_BIN"] = previousBin;
  });

  async function startSession(runtime: RustRuntime, repo: string): Promise<string> {
    const created = await runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "structured", agent: "claude", cwd: repo, approvalPolicy: "standard" },
    });
    const sessionId = String(created!["id"]);
    await runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
      method: "POST",
      body: { type: "chat.send", text: "ask me something" },
    });
    return sessionId;
  }

  async function waitForQuestion(runtime: RustRuntime, sessionId: string) {
    const signal = new AbortController().signal;
    let card: Record<string, unknown> | undefined;
    await viWaitFor(async () => {
      const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, signal);
      card = page.items.find(record => record.body.kind === "question");
      expect(card, "question card should reach the main timeline").toBeTruthy();
    });
    return card!;
  }

  async function waitForCompletion(runtime: RustRuntime, sessionId: string): Promise<void> {
    const signal = new AbortController().signal;
    await viWaitFor(async () => {
      const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, signal);
      expect(page.items.some(
        record => record.body.kind === "turn_end" && (record.body as { finish?: string }).finish === "completed",
      )).toBe(true);
    });
  }

  it("shows the question card and forwards native answers to the CLI", async () => {
    const { directory, runtime } = fixture();
    const repo = initRepo(directory);
    const cli = resolve(directory, "fake-claude");
    writeFileSync(cli, FAKE_CLAUDE);
    chmodSync(cli, 0o755);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    process.env["PROSPERO_CLAUDE_BIN"] = cli;
    expect((await runtime.start()).ok).toBe(true);

    const sessionId = await startSession(runtime, repo);
    const card = await waitForQuestion(runtime, sessionId);

    const body = card.body as Record<string, unknown>;
    expect(body["requestId"]).toBe("req-q");
    expect(body["resolved"]).toBe(false);
    const questions = body["questions"] as Array<Record<string, unknown>>;
    expect(questions).toHaveLength(1);
    expect(questions[0]!["question"]).toBe("用哪种方案");
    expect(questions[0]!["allowOther"]).toBe(true);
    expect(questions[0]!["multiSelect"]).toBe(false);
    const options = questions[0]!["options"] as Array<Record<string, unknown>>;
    expect(options.map(option => option["label"])).toEqual(["方案 A", "方案 B"]);

    // The renderer folds the persisted record into the existing question card.
    const event = timelineEvent(card as never);
    expect(event["kind"]).toBe("question.request");
    expect(event["reqId"]).toBe("req-q");

    await runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
      method: "POST",
      body: { type: "question.respond", reqId: "req-q", answers: [{ questionId: "q1", values: ["方案 A"] }] },
    });
    await waitForCompletion(runtime, sessionId);

    // The CLI must receive the native answers map keyed by question text.
    const frame = JSON.parse(readFileSync(resolve(repo, "answers.log"), "utf8"));
    expect(frame["response"]["response"]["behavior"]).toBe("allow");
    expect(frame["response"]["response"]["updatedInput"]["answers"]).toEqual({ "用哪种方案": "方案 A" });

    // The persisted card flips to resolved so the UI shows "已回答".
    const signal = new AbortController().signal;
    const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, signal);
    const resolved = page.items.find(record => record.body.kind === "question");
    expect((resolved!.body as Record<string, unknown>)["resolved"]).toBe(true);

    // Answering twice is a failing request (request no longer pending).
    await expect(runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
      method: "POST",
      body: { type: "question.respond", reqId: "req-q", answers: [], cancelled: true },
    })).rejects.toThrow();
  }, 30_000);

  it("cancelling the question allows the tool with an empty answers map", async () => {
    const { directory, runtime } = fixture();
    const repo = initRepo(directory);
    const cli = resolve(directory, "fake-claude");
    writeFileSync(cli, FAKE_CLAUDE);
    chmodSync(cli, 0o755);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    process.env["PROSPERO_CLAUDE_BIN"] = cli;
    expect((await runtime.start()).ok).toBe(true);

    const sessionId = await startSession(runtime, repo);
    await waitForQuestion(runtime, sessionId);
    await runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
      method: "POST",
      body: { type: "question.respond", reqId: "req-q", answers: [], cancelled: true },
    });
    await waitForCompletion(runtime, sessionId);

    const frame = JSON.parse(readFileSync(resolve(repo, "answers.log"), "utf8"));
    expect(frame["response"]["response"]["behavior"]).toBe("allow");
    expect(frame["response"]["response"]["updatedInput"]["answers"]).toEqual({});
  }, 30_000);
});

async function viWaitFor(check: () => Promise<void>, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() - started >= timeoutMs) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
