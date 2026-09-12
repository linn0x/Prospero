import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { StateStore } from "../src/main/state-store";

const binary = resolve("../../target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const fixtures: { directory: string; runtime: RustRuntime }[] = [];

function fixture(prefix: string) {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  return { directory, runtime, store };
}

function initRepo(directory: string): string {
  const repo = resolve(directory, "repo");
  const result = spawnSync("git", ["init", "-q", repo], { cwd: directory, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return repo;
}

function installCli(directory: string, name: string, script: string): string {
  const cli = resolve(directory, name);
  writeFileSync(cli, script);
  chmodSync(cli, 0o755);
  return cli;
}

// Every turn is a separate process; the daemon passes --resume from turn two.
// The first turn idles long enough for the test to queue messages mid-turn.
const QUEUE_CLAUDE = `#!/usr/bin/env python3
import json, os, sys, time
def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()
emit({"type": "system", "subtype": "init", "session_id": "fake-queue"})
resume = any(arg.startswith("--resume=") for arg in sys.argv[1:])
frame = json.loads(sys.stdin.readline())
with open(os.path.join(os.getcwd(), "prompts.log"), "a", encoding="utf-8") as log:
    log.write(frame["message"]["content"] + "\\n")
if not resume:
    time.sleep(2.0)
emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0,
      "content_block": {"type": "text", "text": ""}}})
emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
      "delta": {"type": "text_delta", "text": "second turn" if resume else "first turn"}}})
emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
emit({"type": "result", "subtype": "success", "is_error": False})
sys.stdout.flush()
`;

// Reads the opening prompt straight from fd 0, then collects extra steer
// frames for a window. A buffered readline would swallow coalesced frames.
const STEER_CLAUDE = `#!/usr/bin/env python3
import json, os, select, sys, time
def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()
def read_line_raw():
    data = bytearray()
    while True:
        chunk = os.read(0, 1)
        if not chunk or chunk == b"\\n":
            break
        data.extend(chunk)
    return data.decode("utf-8", "replace")
emit({"type": "system", "subtype": "init", "session_id": "fake-steer"})
read_line_raw()
extras = []
deadline = time.time() + 3.0
while time.time() < deadline:
    ready, _, _ = select.select([sys.stdin], [], [], 0.2)
    if not ready:
        continue
    frame = read_line_raw()
    if frame:
        extras.append(frame)
with open(os.path.join(os.getcwd(), "steered.log"), "w", encoding="utf-8") as log:
    log.write("\\n".join(extras))
emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0,
      "content_block": {"type": "text", "text": ""}}})
emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
      "delta": {"type": "text_delta", "text": "steered turn"}}})
emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
emit({"type": "result", "subtype": "success", "is_error": False})
sys.stdout.flush()
`;

describe.skipIf(process.platform === "win32")("Busy message queue and steer through the Rust bridge", () => {
  let previousBin: string | undefined;

  afterEach(async () => {
    for (const { directory, runtime } of fixtures.splice(0)) {
      expect((await runtime.stop()).ok).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
    if (previousBin === undefined) delete process.env["PROSPERO_CLAUDE_BIN"];
    else process.env["PROSPERO_CLAUDE_BIN"] = previousBin;
  });

  async function createSession(runtime: RustRuntime, repo: string): Promise<string> {
    const created = await runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "structured", agent: "claude", cwd: repo, approvalPolicy: "standard" },
    });
    return String(created!["id"]);
  }

  function send(runtime: RustRuntime, sessionId: string, body: Record<string, unknown>) {
    return runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
      method: "POST",
      body: { type: "chat.send", ...body },
    });
  }

  function queueAction(runtime: RustRuntime, sessionId: string, queueId: string, action: "remove" | "guide") {
    return runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
      method: "POST",
      body: { type: action === "remove" ? "chat.queue.remove" : "chat.queue.guide", queueId },
    });
  }

  function projectedQueue(store: StateStore, sessionId: string) {
    return store.snapshot().daemon.sessions.find(session => session.id === sessionId)?.messageQueue ?? [];
  }

  async function waitForTurns(runtime: RustRuntime, sessionId: string, count: number): Promise<void> {
    const signal = new AbortController().signal;
    await viWaitFor(async () => {
      const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, signal);
      expect(page.items.filter(
        record => record.body.kind === "turn_end"
          && (record.body as { finish?: string }).finish === "completed",
      )).toHaveLength(count);
    });
  }

  it("enqueues busy messages into the session projection and drains them FIFO", async () => {
    const { directory, runtime, store } = fixture("prospero-rust-queue-");
    const repo = initRepo(directory);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    process.env["PROSPERO_CLAUDE_BIN"] = installCli(directory, "fake-claude-queue.py", QUEUE_CLAUDE);
    expect((await runtime.start()).ok).toBe(true);

    const sessionId = await createSession(runtime, repo);
    await send(runtime, sessionId, { text: "first prompt" });
    // Stay inside the first turn's busy window before queuing more.
    await new Promise(resolve => setTimeout(resolve, 400));
    await send(runtime, sessionId, { text: "second prompt" });
    await send(runtime, sessionId, { text: "third prompt" });

    let queued = projectedQueue(store, sessionId);
    expect(queued.map(item => item.text)).toEqual(["second prompt", "third prompt"]);
    expect(queued.every(item => item.kind === "queue" && item.attachmentCount === 0)).toBe(true);

    await waitForTurns(runtime, sessionId, 3);
    // The session-list projection refreshes on the event poll; wait for it to clear.
    await viWaitFor(async () => expect(projectedQueue(store, sessionId)).toHaveLength(0));

    const prompts = readFileSync(resolve(repo, "prompts.log"), "utf8").split("\n").filter(Boolean);
    expect(prompts).toEqual(["first prompt", "second prompt", "third prompt"]);
  }, 60_000);

  it("steers the live turn when delivery is steer and audits the text", async () => {
    const { directory, runtime, store } = fixture("prospero-rust-steer-");
    const repo = initRepo(directory);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    process.env["PROSPERO_CLAUDE_BIN"] = installCli(directory, "fake-claude-steer.py", STEER_CLAUDE);
    expect((await runtime.start()).ok).toBe(true);

    const sessionId = await createSession(runtime, repo);
    await send(runtime, sessionId, { text: "do the task" });
    await new Promise(resolve => setTimeout(resolve, 400));
    await send(runtime, sessionId, { text: "also check the tests", delivery: "steer" });

    await waitForTurns(runtime, sessionId, 1);
    expect(projectedQueue(store, sessionId)).toHaveLength(0);
    const steered = readFileSync(resolve(repo, "steered.log"), "utf8");
    expect(steered).toContain("also check the tests");

    const signal = new AbortController().signal;
    const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, signal);
    const audited = page.items.some(record =>
      record.body.kind === "message"
      && (record.body as Record<string, unknown>)["role"] === "user"
      && record.preview === "also check the tests"
      && record.id.includes("steer"));
    expect(audited, "steered text must be recorded as a user message").toBe(true);
  }, 60_000);

  it("removes a queued message and guides another into the live turn", async () => {
    const { directory, runtime, store } = fixture("prospero-rust-queue-ops-");
    const repo = initRepo(directory);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    process.env["PROSPERO_CLAUDE_BIN"] = installCli(directory, "fake-claude-steer.py", STEER_CLAUDE);
    expect((await runtime.start()).ok).toBe(true);

    const sessionId = await createSession(runtime, repo);
    await send(runtime, sessionId, { text: "working" });
    await new Promise(resolve => setTimeout(resolve, 400));
    await send(runtime, sessionId, { text: "drop me" });
    await send(runtime, sessionId, { text: "urgent note" });

    const queued = projectedQueue(store, sessionId);
    expect(queued.map(item => item.text)).toEqual(["drop me", "urgent note"]);
    await queueAction(runtime, sessionId, queued[0]!.id, "remove");
    const remaining = projectedQueue(store, sessionId);
    expect(remaining.map(item => item.text)).toEqual(["urgent note"]);

    await queueAction(runtime, sessionId, remaining[0]!.id, "guide");
    await waitForTurns(runtime, sessionId, 1);
    expect(projectedQueue(store, sessionId)).toHaveLength(0);
    const steered = readFileSync(resolve(repo, "steered.log"), "utf8");
    expect(steered).toContain("urgent note");
    expect(steered).not.toContain("drop me");
  }, 60_000);
});

async function viWaitFor(check: () => Promise<void>, timeoutMs = 30_000): Promise<void> {
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
