#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const command = args[0] ?? "install";
const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const label = valueArg("--label") ?? "ai.prospero.daemon.rust";
const uid = process.getuid?.() ?? Number(execFileSync("id", ["-u"], { encoding: "utf8" }).trim());
const domain = `user/${uid}`;
const service = `${domain}/${label}`;
const launchAgents = path.join(homedir(), "Library", "LaunchAgents");
const plist = path.join(launchAgents, `${label}.plist`);
const dataDir = path.resolve(valueArg("--data-dir") ?? path.join(homedir(), "Library", "Application Support", "Prospero Rust", "daemon"));
const legacyHome = path.resolve(valueArg("--legacy-home") ?? path.join(homedir(), ".prospero"));
const binary = path.resolve(valueArg("--binary") ?? path.join(runtimeRoot, "prosperod-rs"));
const node = path.resolve(valueArg("--node") ?? path.join(runtimeRoot, "node", "node"));
const port = valueArg("--port") ?? "7424";
const bind = valueArg("--bind") ?? "0.0.0.0";
const logDir = path.resolve(valueArg("--log-dir") ?? path.join(homedir(), "Library", "Logs", "Prospero"));
const pathValue = valueArg("--path") ?? loginPath();

function valueArg(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function run(file, fileArgs, options = {}) {
  const result = spawnSync(file, fileArgs, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(output || `${file} ${fileArgs.join(" ")} failed`);
  }
  return result.stdout ?? "";
}

function tryRun(file, fileArgs) {
  return spawnSync(file, fileArgs, { encoding: "utf8" });
}

function xml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}

function loginPath() {
  const shell = process.env.SHELL || "/bin/zsh";
  const result = spawnSync(shell, ["-lc", "printf %s \"$PATH\""], { encoding: "utf8" });
  const captured = result.status === 0 ? result.stdout : "";
  const parts = [
    runtimeRoot,
    path.join(runtimeRoot, "node"),
    captured,
    process.env.PATH ?? "",
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  ].filter(Boolean).join(":").split(":").filter(Boolean);
  return [...new Set(parts)].join(":");
}

function plistBody() {
  const programArguments = [binary, "start", "--home", dataDir, "--port", port, "--bind", bind];
  const environment = {
    PATH: pathValue,
    PROSPERO_HOME: dataDir,
    PROSPERO_LEGACY_HOME: legacyHome,
    PROSPERO_NODE: node,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((item) => `    <string>${xml(item)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join("\n")}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(homedir())}</string>
  <key>LimitLoadToSessionType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logDir, "prosperod-rs.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logDir, "prosperod-rs.err.log"))}</string>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
`;
}

function install() {
  if (process.platform !== "darwin") throw new Error("LaunchAgent install is macOS only");
  if (!existsSync(binary)) throw new Error(`Missing Rust daemon binary: ${binary}`);
  if (!existsSync(node)) throw new Error(`Missing runtime node: ${node}`);
  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(plist, plistBody(), { encoding: "utf8", mode: 0o600 });
  chmodSync(plist, 0o600);
  tryRun("launchctl", ["bootout", service]);
  run("launchctl", ["bootstrap", domain, plist]);
  run("launchctl", ["enable", service]);
  run("launchctl", ["kickstart", "-k", service]);
  print({ ok: true, label, plist, dataDir, service });
}

function uninstall() {
  tryRun("launchctl", ["bootout", service]);
  rmSync(plist, { force: true });
  print({ ok: true, label, plist, service });
}

function status() {
  const result = tryRun("launchctl", ["print", service]);
  print({
    ok: result.status === 0,
    label,
    plist,
    dataDir,
    service,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  });
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  if (command === "install" || command === "restart") install();
  else if (command === "uninstall") uninstall();
  else if (command === "status") status();
  else if (command === "print-plist") process.stdout.write(plistBody());
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
