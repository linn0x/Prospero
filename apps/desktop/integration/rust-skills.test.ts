import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { StateStore } from "../src/main/state-store";

const binary = resolve("../../target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const fixtures: { directory: string; runtime: RustRuntime }[] = [];

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-skills-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  return { directory, dataDir, store, runtime };
}

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function initRepo(directory: string): string {
  const repo = resolve(directory, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  git(["symbolic-ref", "HEAD", "refs/heads/master"], repo);
  git(["config", "user.email", "test@prospero.local"], repo);
  git(["config", "user.name", "Prospero Test"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  return repo;
}

function installCaptureClaude(directory: string, capture: string): string {
  // Announce init, then append every received stdin frame to $CAPTURE and idle.
  const cli = resolve(directory, "fake-claude.py");
  writeFileSync(cli, `#!/usr/bin/env python3
import json, os, sys, time
sys.stdout.write(json.dumps({"type": "system", "subtype": "init", "session_id": "fake-skills"}) + "\\n")
sys.stdout.flush()
target = os.environ["CAPTURE"]
while True:
    line = sys.stdin.readline()
    if not line:
        break
    with open(target, "a", encoding="utf-8") as handle:
        handle.write(line)
`);
  chmodSync(cli, 0o755);
  return cli;
}

describe.skipIf(process.platform === "win32")("skill discovery and composer expansion through the Rust bridge", () => {
  let previousBin: string | undefined;
  let previousCapture: string | undefined;

  afterEach(async () => {
    for (const { directory, runtime } of fixtures.splice(0)) {
      expect((await runtime.stop()).ok).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
    if (previousBin === undefined) delete process.env["PROSPERO_CLAUDE_BIN"];
    else process.env["PROSPERO_CLAUDE_BIN"] = previousBin;
    if (previousCapture === undefined) delete process.env["CAPTURE"];
    else process.env["CAPTURE"] = previousCapture;
  });

  it("lists skills, completes $ mentions and expands SKILL.md into the CLI prompt", async () => {
    const { directory, runtime } = fixture();
    const repo = initRepo(directory);
    const capture = resolve(directory, "frames.jsonl");
    mkdirSync(resolve(repo, ".claude/skills/review"), { recursive: true });
    writeFileSync(resolve(repo, ".claude/skills/review/SKILL.md"), [
      "---",
      "name: review",
      "description: Review the change",
      "---",
      "# Review checklist",
      "Run cargo test before shipping.",
      "",
    ].join("\n"));
    mkdirSync(resolve(repo, "src"), { recursive: true });
    writeFileSync(resolve(repo, "src/main.rs"), "fn main() {}\n");

    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    previousCapture = process.env["CAPTURE"];
    process.env["PROSPERO_CLAUDE_BIN"] = installCaptureClaude(directory, capture);
    process.env["CAPTURE"] = capture;
    expect((await runtime.start()).ok).toBe(true);

    // Skills list through the legacy-shaped desktop control route.
    const list = await runtime.request(`/_prospero/control/skills?cwd=${encodeURIComponent(repo)}`);
    const items = list!["items"] as Array<Record<string, unknown>>;
    expect(items.some(item => item["name"] === "review")).toBe(true);

    // Create a structured session and ask for skill suggestions.
    const created = await runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "structured", agent: "claude", cwd: repo, approvalPolicy: "standard" },
    });
    const sessionId = String(created!["id"]);
    const suggestions = await runtime.request(
      `/_prospero/control/session/${sessionId}/suggestions?kind=skill&query=revi`,
    );
    const matches = suggestions!["items"] as Array<Record<string, unknown>>;
    expect(matches.some(item => item["value"] === "review")).toBe(true);

    // Send a message carrying both a $skill and an @file mention.
    await runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
      method: "POST",
      body: { type: "chat.send", text: "请 $review 并检查 @src/main.rs" },
    });

    // The frame written to the fake CLI must contain the expanded skill body
    // and the file-reference block while keeping the user text.
    await viWaitForFile(capture);
    const frame = JSON.parse(readFileSync(capture, "utf8").split("\n").find(Boolean)!) as {
      message?: { content?: string };
    };
    const content = frame.message?.content ?? "";
    expect(content).toContain("[Prospero selected Agent Skills]");
    expect(content).toContain("Run cargo test before shipping.");
    expect(content).toContain("[Prospero file references]");
    expect(content).toContain("- src/main.rs");
    expect(content).toContain("请 $review 并检查 @src/main.rs");
  }, 60_000);
});

async function viWaitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!existsSync(path) || readFileSync(path, "utf8").trim() === "") {
    if (Date.now() - started > timeoutMs) throw new Error(`capture file never appeared: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
