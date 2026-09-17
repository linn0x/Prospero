import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const outputPath = valueArg("--output");
const releaseBinary = args.includes("--release");
const seconds = valueArg("--seconds") ?? "20";
const sessions = valueArg("--sessions") ?? "8";
const evidenceRoot = valueArg("--evidence-dir") ?? path.join(root, "target", "prospero-acceptance");
mkdirSync(evidenceRoot, { recursive: true });

function valueArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function run(name, command, commandArgs, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  return {
    name,
    command: [command, ...commandArgs].join(" "),
    ok: result.status === 0,
    status: result.status,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout?.slice(-16000) ?? "",
    stderr: result.stderr?.slice(-16000) ?? "",
  };
}

const checks = [];
const buildArgs = releaseBinary ? ["build", "--release", "--workspace", "--locked"] : ["build", "--workspace", "--locked"];
checks.push(run("rust-workspace-build", "cargo", buildArgs));
if (checks.at(-1).ok) {
  const acceptancePath = path.join(evidenceRoot, `rust-daemon-${platform()}-${arch()}.json`);
  const acceptance = run("rust-daemon-acceptance", process.execPath, [
    "tools/perf/rust-daemon-acceptance.mjs",
    ...(releaseBinary ? ["--release"] : []),
    "--seconds", seconds,
    "--sessions", sessions,
    "--output", acceptancePath,
  ]);
  checks.push(acceptance);
  if (acceptance.ok && existsSync(acceptancePath)) {
    acceptance.report = JSON.parse(readFileSync(acceptancePath, "utf8"));
    if (platform() === "win32") {
      acceptance.ok = acceptance.report.capabilities?.includes("terminal.windows.conpty") === true
        && acceptance.report.userFlows?.some(flow => flow.name === "terminal-round-trip" && flow.transport === "ConPTY" && flow.inputEchoed === true) === true;
      if (!acceptance.ok) acceptance.stderr = `${acceptance.stderr}\nWindows ConPTY user-flow evidence missing`;
    }
  }
}
if (platform() === "win32") {
  const sessionHost = run("windows-native-session-host", "npm.cmd", ["run", "test:native", "--workspace=@prospero/windows-native"], { env: { ...process.env, PROSPERO_WINDOWS_SIGNED_SESSION_HOST_TEST: "1" } });
  sessionHost.userFlow = {
    name: "windows-session-host",
    nativeBoundary: true,
    userVisible: sessionHost.ok,
  };
  checks.push(sessionHost);
} else {
  checks.push({ name: "windows-native-session-host", ok: true, skipped: true, reason: "not-win32" });
}

const report = {
  ok: checks.every(check => check.ok),
  scenario: "rust-real-machine-check",
  environment: { platform: platform(), arch: arch(), release: release(), node: process.version },
  checks,
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) writeFileSync(outputPath, text);
else process.stdout.write(text);
process.exitCode = report.ok ? 0 : 1;
