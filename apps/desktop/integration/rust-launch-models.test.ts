import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RustRuntime } from "../src/main/rust-runtime";
import { StateStore } from "../src/main/state-store";

const binary = resolve("../../target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const fixtures: { directory: string; runtime: RustRuntime }[] = [];

// One fake CLI covers every Rust invocation shape:
// - `auth status --json` (accounts probe)
// - the catalog-only initialize handshake (no turn flags)
// - a normal headless turn (captures argv, idles until the daemon kills it)
function installFakeClaude(directory: string, capture: string): string {
  const cli = resolve(directory, "fake-claude-launch.py");
  writeFileSync(cli, `#!/usr/bin/env python3
import json, os, sys, time

argv = sys.argv[1:]
if argv == ["auth", "status", "--json"]:
    sys.stdout.write('{"loggedIn":true}')
    sys.exit(0)

catalog_args = ["-p", "--output-format", "stream-json",
                "--input-format", "stream-json", "--verbose"]
if argv == catalog_args:
    frame = json.loads(sys.stdin.readline())
    assert frame["type"] == "control_request" and frame["request"]["subtype"] == "initialize"
    rid = frame["request_id"]
    sys.stdout.write(json.dumps({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": rid, "response": {"session_state": "idle", "models": [
            {"value": "default", "displayName": "Default",
             "supportedEffortLevels": ["low", "medium", "high"]},
            {"value": "opus[1m]", "displayName": "Opus (1M)", "description": "long context",
             "supportedEffortLevels": ["low", "max"]},
        ]}},
    }) + "\\n")
    sys.stdout.flush()
    sys.exit(0)

# Turn process: announce init, capture argv, then idle.
sys.stdout.write(json.dumps({"type": "system", "subtype": "init", "session_id": "fake-launch"}) + "\\n")
sys.stdout.flush()
with open(os.environ["CAPTURE"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps(argv) + "\\n")
sys.stdin.readline()
time.sleep(3600)
`);
  chmodSync(cli, 0o755);
  return cli;
}

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "prospero-r-launch-"));
  const dataDir = resolve(directory, "daemon");
  const store = new StateStore(resolve(directory, "desktop"), "api");
  const runtime = new RustRuntime(store, binary, dataDir);
  fixtures.push({ directory, runtime });
  return { directory, runtime };
}

describe.skipIf(process.platform === "win32")("Launch model catalog through the Rust bridge", () => {
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

  it("serves the catalog for native claude and rejects other agents", async () => {
    const { directory, runtime } = fixture();
    const capture = resolve(directory, "argv.jsonl");
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    previousCapture = process.env["CAPTURE"];
    process.env["PROSPERO_CLAUDE_BIN"] = installFakeClaude(directory, capture);
    process.env["CAPTURE"] = capture;
    expect((await runtime.start()).ok).toBe(true);

    const catalog = await runtime.request(
      "/_prospero/control/launch/models?agent=claude&accountId=native-claude",
    );
    const models = catalog!["models"] as Array<Record<string, unknown>>;
    expect(models.map((model) => model["id"])).toEqual(["default", "opus[1m]"]);
    expect(models[0]).toMatchObject({
      label: "Default",
      supportedEfforts: ["low", "medium", "high"],
      isDefault: true,
    });
    expect(models[1]!["description"]).toBe("long context");
    expect(catalog!["currentModel"]).toBe("default");

    await expect(runtime.request(
      "/_prospero/control/launch/models?agent=codex&accountId=native-codex",
    )).rejects.toThrow(/尚未接入/);
    await expect(runtime.request(
      "/_prospero/control/launch/models?agent=claude",
    )).rejects.toThrow(/尚未接入/);
    await expect(runtime.request(
      "/_prospero/control/launch/models?agent=claude&accountId=managed-x",
    )).rejects.toThrow(/此账号尚未接入|尚未接入/);
  }, 60_000);

  it("forwards model/effort on session creation to every CLI turn", async () => {
    const { directory, runtime } = fixture();
    const workspace = resolve(directory, "workspace");
    mkdirSync(workspace, { recursive: true });
    const capture = resolve(directory, "argv.jsonl");
    previousBin = process.env["PROSPERO_CLAUDE_BIN"];
    previousCapture = process.env["CAPTURE"];
    process.env["PROSPERO_CLAUDE_BIN"] = installFakeClaude(directory, capture);
    process.env["CAPTURE"] = capture;
    expect((await runtime.start()).ok).toBe(true);

    const created = await runtime.request("/_prospero/control/session/create", {
      method: "POST",
      body: {
        kind: "structured", agent: "claude", cwd: workspace, approvalPolicy: "standard",
        accountId: "native-claude", model: "opus[1m]", effort: "high",
      },
    });
    expect(created!["agent"]).toBe("claude");
    const sessionId = String(created!["id"]);

    await runtime.request(`/_prospero/control/session/${sessionId}/interact`, {
      method: "POST",
      body: { type: "chat.send", text: "go" },
    });

    await waitForFile(capture);
    const argv = JSON.parse(readFileSync(capture, "utf8").split("\n").find(Boolean)!) as string[];
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus[1m]");
    expect(argv).toContain("--effort");
    expect(argv[argv.indexOf("--effort") + 1]).toBe("high");

    // Invalid selections are rejected in the bridge before reaching the daemon.
    for (const body of [
      { kind: "structured", agent: "claude", cwd: workspace, approvalPolicy: "standard", accountId: "native-claude", model: "x".repeat(161) },
      { kind: "structured", agent: "claude", cwd: workspace, approvalPolicy: "standard", accountId: "native-claude", effort: "high\n" },
    ]) {
      await expect(runtime.request("/_prospero/control/session/create", { method: "POST", body }))
        .rejects.toThrow(/无效/);
    }
  }, 60_000);
});

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!existsSync(path) || readFileSync(path, "utf8").trim() === "") {
    if (Date.now() - started > timeoutMs) throw new Error(`capture file never appeared: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
