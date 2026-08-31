#!/usr/bin/env node
//
// 把 daemon 运行时(node 解释器 + 已安装的 @prospero/daemon)暂存到 .runtime,
// 供 electron-builder 作为 extraResources 打进安装包。
//
//   node scripts/prepare-runtime.mjs [--arch arm64|x64] [--skip-build]
//
// 这是 prepare-runtime.ps1 的 macOS 对应物。两份脚本刻意分开:Windows 那条路
// 已经在 CI 上跑绿了,不值得为了合并而冒险改它。等 macOS 这条也稳定之后
// 再合成一份跨平台脚本。
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  run("npm", ["run", "build", "--workspace=@prospero/daemon"]);
}

rmSync(runtimeRoot, { recursive: true, force: true });
const nodeRoot = path.join(runtimeRoot, "node");
const daemonRoot = path.join(runtimeRoot, "daemon");
const packRoot = path.join(runtimeRoot, "packs");
for (const dir of [runtimeRoot, nodeRoot, packRoot]) mkdirSync(dir, { recursive: true });

// 打包机上正在跑这个脚本的解释器就是要随包分发的那个 —— 版本必然与构建一致。
copyFileSync(process.execPath, path.join(nodeRoot, "node"));

const npmCache = path.join(repoRoot, ".npm-cache");
// windows-native 是 daemon 的硬依赖,即使在 macOS 上用不到也要能解析,
// 否则下面的 npm install 会因为找不到它而失败。
for (const workspace of ["./packages/protocol", "./packages/windows-native", "./apps/daemon"]) {
  run("npm", [
    "pack", workspace,
    "--pack-destination", packRoot,
    "--cache", npmCache,
    ...(workspace === "./apps/daemon" ? ["--ignore-scripts"] : []),
  ]);
}

const pack = (prefix) => {
  const found = readdirSync(packRoot).find((name) => name.startsWith(prefix) && name.endsWith(".tgz"));
  if (!found) throw new Error(`运行时暂存不完整:缺少 ${prefix}*.tgz`);
  return `file:packs/${found}`;
};

writeFileSync(
  path.join(runtimeRoot, "package.json"),
  `${JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@prospero/protocol": pack("prospero-protocol-"),
      "@prospero/windows-native": pack("prospero-windows-native-"),
      "@prospero/daemon": pack("prospero-daemon-"),
    },
  }, null, 2)}\n`,
);

run("npm", [
  "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
  "--cache", npmCache, "--os", "darwin", "--cpu", arch,
], runtimeRoot);

// `npm install --ignore-scripts` preserves the node-pty binary but drops the
// executable bit from its macOS spawn helper. The detached PTY host then exits
// before creating its socket, which surfaces in the UI only as connect ENOENT.
const ptySpawnHelper = path.join(
  runtimeRoot,
  "node_modules",
  "node-pty",
  "prebuilds",
  `darwin-${arch}`,
  "spawn-helper",
);
if (!existsSync(ptySpawnHelper)) {
  throw new Error(`安装出的运行时缺少 node-pty spawn-helper: ${ptySpawnHelper}`);
}
chmodSync(ptySpawnHelper, 0o755);

const installedDaemon = path.join(runtimeRoot, "node_modules", "@prospero", "daemon");
if (!existsSync(path.join(installedDaemon, "dist", "cli.js"))) {
  throw new Error("安装出的运行时里没有 daemon/dist/cli.js");
}
// daemon 必须留在 node_modules 里,不能像 Windows 那样拷到 runtime/daemon。
//
// daemon 启动时会为结构化 supervisor 构建一份运行时镜像,而它的信任边界是
// "从 dist 往上找到的最近一个 node_modules"。把包拷出去之后,那个边界会退化成
// runtime/daemon 自己,它的依赖(全在 runtime/node_modules)就成了边界外的东西,
// 于是 fail closed:"resolves outside the trusted installation root",daemon 起不来。
//
// Windows 上碰不到这条:ws-server 里那段镜像构建显式跳过 win32(那边走
// Session Host 的 N-API 安全边界),所以同样的布局在 Windows 打包里一直没暴露。
rmSync(daemonRoot, { recursive: true, force: true });

// 只留本机架构需要的东西。这些删除都限定在刚重建的 .runtime 里。
const oppositeArch = arch === "arm64" ? "x64" : "arm64";
for (const target of [
  path.join(runtimeRoot, "node_modules", "node-pty", "prebuilds", `darwin-${oppositeArch}`),
  path.join(runtimeRoot, "node_modules", "node-pty", "prebuilds", "win32-x64"),
  path.join(runtimeRoot, "node_modules", "node-pty", "prebuilds", "win32-arm64"),
  path.join(runtimeRoot, "node_modules", "node-pty", "third_party"),
  // 自己源码的 npm tarball 只是安装过程的中间产物,没有理由跟着安装包分发。
  path.join(runtimeRoot, "packs"),
  path.join(runtimeRoot, "package-lock.json"),
]) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(runtimeRoot)) throw new Error(`拒绝删除 .runtime 之外的路径:${resolved}`);
  rmSync(resolved, { recursive: true, force: true });
}

// 上面剪掉 node_modules/@prospero/daemon 之后,.bin 里指向它的 shim 就悬空了。
// Windows 上这些 shim 是 .cmd 文件,删掉目标只是留下一个没用的文件;macOS 上
// 它们是符号链接,codesign 遇到悬空链接会直接失败(ENOENT),整个签名过不去。
// 按"目标不存在就清掉"处理,不写死名字。
const binRoot = path.join(runtimeRoot, "node_modules", ".bin");
if (existsSync(binRoot)) {
  for (const entry of readdirSync(binRoot)) {
    const link = path.join(binRoot, entry);
    if (!existsSync(link)) rmSync(link, { force: true });
  }
}

console.log(`运行时已暂存到 ${runtimeRoot}`);
