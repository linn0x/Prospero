const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

const repoRoot = path.resolve(__dirname, "../../..");
const args = process.argv.slice(2);
const timeoutMs = Number(valueArg("--timeout-ms") || 120000);
const requirePackaged = args.includes("--require-packaged");
const appPath = valueArg("--app") ?? defaultAppPath();
if (requirePackaged && !appPath) {
  throw new Error("No packaged app was found; run electron-builder --dir before the packaged Rust smoke.");
}
const binary = appPath ? appBinary(appPath) : require("electron");
const binaryArgs = appPath ? ["--smoke-test", "--require-rust-backend"] : [path.resolve(__dirname, ".."), "--smoke-test", "--require-rust-backend"];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-packaged-rust-"));
const home = path.join(root, "home");
const rustHome = path.join(root, "rust-home");
const switchFile = path.join(root, "runtime-switch.json");

function valueArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function appBinary(value) {
  if (process.platform === "darwin") return path.join(value, "Contents", "MacOS", "Prospero");
  if (process.platform === "win32") return path.join(value, "Prospero.exe");
  return path.join(value, "prospero");
}

function defaultAppPath() {
  const candidates = process.platform === "darwin"
    ? [
      path.join(repoRoot, "dist", "desktop", `mac-${process.arch}`, "Prospero.app"),
      path.join(repoRoot, "dist", "desktop", "mac", "Prospero.app"),
    ]
    : process.platform === "win32"
      ? [
        path.join(repoRoot, "dist", "desktop", `win-${process.arch}-unpacked`),
        path.join(repoRoot, "dist", "desktop", "win-unpacked"),
      ]
      : [];
  return candidates.find(candidate => fs.existsSync(appBinary(candidate)));
}

async function main() {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(rustHome, { recursive: true });
  const desktopState = path.join(rustHome, "desktop", "desktop.json");
  fs.mkdirSync(path.dirname(desktopState), { recursive: true });
  fs.writeFileSync(desktopState, JSON.stringify({ settings: { startDaemonOnLaunch: true, minimizeToTray: false } }));
  const child = spawn(binary, binaryArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PROSPERO_BACKEND: "rust",
      PROSPERO_RUST_HOME: rustHome,
      PROSPERO_RUNTIME_SWITCH_FILE: switchFile,
      PROSPERO_HOME: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  assert.equal(code, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /Prospero bundled daemon ready/);
  assert.match(stdout, /Prospero desktop smoke test passed/);
  if (fs.existsSync(switchFile)) {
    const state = JSON.parse(fs.readFileSync(switchFile, "utf8"));
    assert.notEqual(state.backend, "legacy", JSON.stringify(state));
  }
  const report = {
    ok: true,
    scenario: "packaged-rust-desktop-smoke",
    binary,
    appPath: appPath ?? null,
    platform: process.platform,
    arch: process.arch,
    stdout: stdout.split(/\r?\n/).filter(Boolean),
  };
  const output = valueArg("--output");
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) fs.writeFileSync(output, text);
  else process.stdout.write(text);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
