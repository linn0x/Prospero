#!/usr/bin/env node
//
// 把 Rust daemon 运行时(prosperod-rs + prospero CLI + LaunchAgent 安装器)暂存到 .runtime,
// 供 electron-builder 作为 extraResources 打进安装包。
//
//   node scripts/prepare-runtime.mjs [--arch arm64|x64] [--skip-build]
//
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageExecutionHost } from "./runtime-manifest.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "..", "..");
const runtimeRoot = path.join(appRoot, ".runtime");

const args = process.argv.slice(2);
const arch = args.includes("--arch") ? args[args.indexOf("--arch") + 1] : process.arch;
const skipBuild = args.includes("--skip-build");

if (process.platform !== "darwin") {
  console.error("这个脚本目前只覆盖 macOS;Windows 请用 prepare-runtime.ps1。");
  process.exit(1);
}

const run = (command, commandArgs, cwd = repoRoot) =>
  execFileSync(command, commandArgs, { cwd, stdio: "inherit" });

if (!skipBuild) {
  run("npm", ["run", "build", "--workspace=@prospero/protocol"]);
}

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });

const rustBinary = path.join(repoRoot, "target", "release", "prosperod-rs");
const stagedRustBinary = path.join(runtimeRoot, "prosperod-rs");
const rustCli = path.join(repoRoot, "target", "release", "prospero");
const stagedRustCli = path.join(runtimeRoot, "prospero");
if (!existsSync(rustBinary)) {
  throw new Error(`缺少 Rust daemon release binary: ${rustBinary}`);
}
if (!existsSync(rustCli)) {
  throw new Error(`缺少 Rust worker CLI release binary: ${rustCli}`);
}
copyFileSync(rustBinary, stagedRustBinary);
chmodSync(stagedRustBinary, 0o755);
copyFileSync(rustCli, stagedRustCli);
chmodSync(stagedRustCli, 0o755);
stageExecutionHost(path.join(repoRoot, "target", "release"), runtimeRoot, process.platform, arch);
const launchAgentInstaller = path.join(appRoot, "scripts", "install-rust-daemon-launchagent.mjs");
const stagedLaunchAgentInstaller = path.join(runtimeRoot, "install-rust-daemon-launchagent.mjs");
copyFileSync(launchAgentInstaller, stagedLaunchAgentInstaller);
chmodSync(stagedLaunchAgentInstaller, 0o755);
const launchAgentShellInstaller = path.join(appRoot, "scripts", "install-rust-daemon-launchagent.sh");
const stagedLaunchAgentShellInstaller = path.join(runtimeRoot, "install-rust-daemon-launchagent.sh");
copyFileSync(launchAgentShellInstaller, stagedLaunchAgentShellInstaller);
chmodSync(stagedLaunchAgentShellInstaller, 0o755);

console.log(`运行时已暂存到 ${runtimeRoot}`);
