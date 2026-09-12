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
  const directory = mkdtempSync(resolve(tmpdir(), "prospero-rust-modes-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  return { directory, runtime };
}

function initRepo(directory: string): string {
  const repo = resolve(directory, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  git(["init", "-q"]);
  git(["symbolic-ref", "HEAD", "refs/heads/master"]);
  git(["config", "user.email", "test@prospero.local"]);
  git(["config", "user.name", "Prospero Test"]);
  return repo;
}

// Fake CLI records its argv for every turn, answers one result frame, idles.
function installArgvClaude(directory: string, capture: string): string {
  const cli = resolve(directory, "fake-claude-args.py");
  writeFileSync(cli, `#!/usr/bin/env python3
import json, os, sys, time
sys.stdout.write(json.dumps({"type": "system", "subtype": "init", "session_id": "fake-modes"}) + "\\n")
sys.stdout.flush()
target = os.environ["CAPTURE"]
with open(target, "a", encoding="utf-8") as handle:
    handle.write(json.dumps(sys.argv[1:]) + "\\n")
sys.stdin.readline()
time.sleep(3600)
`);
  chmodSync(cli, 0o755);
  return cli;
}

describe.skipIf(process.platform === "win32")("Claude collaboration modes through the Rust bridge", () => {
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

  it("serves the catalog and applies plan mode to the next CLI turn", async () => {
    const { directory, runtime } = fixture();
    const repo = initRepo(directory);
    const capture = resolve(directory, "argv.jsonl");
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    previousCapture = process.env["CAPTURE"];
    process.env["PROSPERO_CLAUDE_BIN"] = installArgvClaude(directory, capture);
    process.env["CAPTURE"] = capture;
    expect((await runtime.start()).ok).toBe(true);

    const created = await runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: { kind: "structured", agent: "claude", cwd: repo, approvalPolicy: "standard" },
    });
    const sessionId = String(created!["id"]);

    const catalog = await runtime.request(`/_prospero/control/session/${sessionId}/modes`);
    const modes = catalog!["modes"] as Array<Record<string, unknown>>;
    expect(modes.map(mode => mode["id"])).toEqual(["default", "plan"]);
    expect(catalog!["currentMode"]).toBe("default");

    const switched = await runtime.request(`/_prospero/control/session/${sessionId}/modes`, {
      method: "POST",
      body: { mode: "plan" },
    });
    expect(switched!["currentMode"]).toBe("plan");
    const reread = await runtime.request(`/_prospero/control/session/${sessionId}/modes`);
    expect(reread!["currentMode"]).toBe("plan");

    await runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
      method: "POST",
      body: { type: "chat.send", text: "please plan only" },
    });

    await viWaitForFile(capture);
    const argv = JSON.parse(readFileSync(capture, "utf8").split("\n").find(Boolean)!) as string[];
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");

    await expect(runtime.request(`/_prospero/control/session/${sessionId}/modes`, {
      method: "POST",
      body: { mode: "yolo" },
    })).rejects.toThrow();
  }, 60_000);
});

async function viWaitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!existsSync(path) || readFileSync(path, "utf8").trim() === "") {
    if (Date.now() - started > timeoutMs) throw new Error(`capture file never appeared: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
