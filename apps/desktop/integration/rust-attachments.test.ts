import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { StateStore } from "../src/main/state-store";

const binary = resolve("../../target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const fixtures: { directory: string; runtime: RustRuntime }[] = [];

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "rust-attach-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  return { directory, runtime, store };
}

// Records the opening user frame, then streams a reply. Each chained turn is
// a separate process; the second one logs too so the drain can be checked.
const ATTACH_CLAUDE = `#!/usr/bin/env python3
import json, os, sys, time
def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\\n")
    sys.stdout.flush()
emit({"type": "system", "subtype": "init", "session_id": "fake-attach"})
resume = any(arg.startswith("--resume=") for arg in sys.argv[1:])
line = sys.stdin.readline()
with open(os.path.join(os.getcwd(), "frames.log"), "a", encoding="utf-8") as log:
    log.write(line)
if not resume:
    time.sleep(2.0)
emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0,
      "content_block": {"type": "text", "text": ""}}})
emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0,
      "delta": {"type": "text_delta", "text": "seen"}}})
emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})
emit({"type": "result", "subtype": "success", "is_error": False})
sys.stdout.flush()
`;

async function viWaitFor(check: () => Promise<void>, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() - started >= timeoutMs) throw error;
      await new Promise(resolveFn => setTimeout(resolveFn, 200));
    }
  }
}

describe.skipIf(process.platform === "win32")("Image attachments through the Rust bridge", () => {
  let previousBin: string | undefined;

  afterEach(async () => {
    for (const { directory, runtime } of fixtures.splice(0)) {
      expect((await runtime.stop()).ok).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
    if (previousBin === undefined) delete process.env["PROSPERO_CLAUDE_BIN"];
    else process.env["PROSPERO_CLAUDE_BIN"] = previousBin;
  });

  async function setup() {
    const { directory, runtime, store } = fixture();
    const cli = resolve(directory, "fake-claude.py");
    writeFileSync(cli, ATTACH_CLAUDE);
    chmodSync(cli, 0o755);
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    process.env["PROSPERO_CLAUDE_BIN"] = cli;
    expect((await runtime.start()).ok).toBe(true);

    const created = await runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "structured", agent: "claude", cwd: directory, approvalPolicy: "standard" },
    });
    const sessionId = String(created!["id"]);

    function send(body: Record<string, unknown>) {
      return runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
        method: "POST",
        body: { type: "chat.send", ...body },
      });
    }

    const workspace = directory;
    return { directory, runtime, store, sessionId, send, workspace };
  }

  it("forwards images as an images-first frame and records metadata-only refs", async () => {
    const { runtime, sessionId, send, workspace } = await setup();

    await send({
      text: "look at these",
      attachments: [
        { mimeType: "image/png", dataB64: "iVBORw0KGgo=", name: "diagram.png" },
        { mimeType: "image/jpeg", dataB64: "/9j/4AAQ" },
      ],
    });

    // Wait for turn completion.
    await viWaitFor(async () => {
      const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, new AbortController().signal);
      expect(page.items.filter(r => r.body.kind === "turn_end")).toHaveLength(1);
    });

    const frames = readFileSync(resolve(workspace, "frames.log"), "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    expect(frames).toHaveLength(1);
    const blocks = frames[0]!.message.content;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
    expect(blocks[1]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } });
    expect(blocks[2]).toEqual({ type: "text", text: "look at these" });

    // The timeline user record carries refs (id/mime/name), never the bytes.
    const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, new AbortController().signal);
    const user = page.items.find(r => r.body.kind === "message" && r.body.role === "user");
    expect(user).toBeTruthy();
    const refs = (user!.body as { attachments?: { id: string; mimeType: string; name?: string }[] }).attachments;
    expect(refs).toHaveLength(2);
    expect(refs![0]!.id).toEqual(expect.any(String));
    expect(refs![0]!.mimeType).toBe("image/png");
    expect(refs![0]!.name).toBe("diagram.png");
    expect(refs![1]!.name).toBeUndefined();
    expect(JSON.stringify(refs)).not.toContain("iVBORw0KGgo");
  }, 60_000);

  it("accepts an image-only message and rejects bad MIME or empty sends", async () => {
    const { runtime, sessionId, send } = await setup();

    await expect(send({ text: "", attachments: [{ mimeType: "image/gif", dataB64: "R0lGOD" }] })).resolves.toBeTruthy();
    await viWaitFor(async () => {
      const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, new AbortController().signal);
      expect(page.items.filter(r => r.body.kind === "turn_end")).toHaveLength(1);
    });

    await expect(send({ text: "x", attachments: [{ mimeType: "application/octet-stream", dataB64: "AAAA" }] })).rejects.toThrow(/图片类型/);
    await expect(send({ text: "", attachments: [] })).rejects.toThrow(/消息内容/);
  }, 60_000);

  it("parks a busy-turn image on the queue with attachmentCount and drains it", async () => {
    const { runtime, store, sessionId, send, workspace } = await setup();

    await send({ text: "first prompt" });
    // Give the first turn a moment to become running.
    await new Promise(resolveFn => setTimeout(resolveFn, 400));
    await send({
      text: "second prompt",
      delivery: "queue",
      attachments: [{ mimeType: "image/webp", dataB64: "UklGRh4A", name: "shot.webp" }],
    });

    const queued = store.snapshot().daemon.sessions.find(s => s.id === sessionId)?.messageQueue ?? [];
    expect(queued).toHaveLength(1);
    expect(queued[0]!.attachmentCount).toBe(1);

    await viWaitFor(async () => {
      const page = await runtime.readTimeline(sessionId, { before: null, after: null, limit: 100 }, new AbortController().signal);
      expect(page.items.filter(r => r.body.kind === "turn_end")).toHaveLength(2);
    }, 20000);

    const frames = readFileSync(resolve(workspace, "frames.log"), "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    expect(frames).toHaveLength(2);
    expect(frames[1]!.message.content[0]).toMatchObject({ type: "image", source: { media_type: "image/webp", data: "UklGRh4A" } });
    expect(frames[1]!.message.content[1]).toEqual({ type: "text", text: "second prompt" });

    await viWaitFor(async () => {
      expect(store.snapshot().daemon.sessions.find(s => s.id === sessionId)?.messageQueue ?? []).toHaveLength(0);
    });
  }, 60_000);
});
