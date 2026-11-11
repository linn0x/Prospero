import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The native Ghostty view currently targets macOS.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.PROSPERO_GHOSTTY_SOURCE || resolve(homedir(), "Library/Caches/Prospero-native/ghostty-v1.3.1");
const zig = process.env.PROSPERO_ZIG || resolve(homedir(), "Library/Caches/Prospero-native/zig-aarch64-macos-0.15.2/zig");
// The Metal compiler only ships with full Xcode (plus its separately downloaded Metal
// Toolchain), never with the Command Line Tools that xcode-select often points at.
function metalDeveloper() {
  if (process.env.PROSPERO_GHOSTTY_METAL_DEVELOPER_DIR) return process.env.PROSPERO_GHOSTTY_METAL_DEVELOPER_DIR;
  const selected = spawnSync("xcode-select", ["-p"], { encoding: "utf8" }).stdout.trim();
  const xcodes = readdirSync("/Applications").filter((name) => /^Xcode.*\.app$/.test(name)).sort()
    .map((name) => `/Applications/${name}/Contents/Developer`);
  const found = [selected, ...xcodes].find((dir) =>
    spawnSync("xcrun", ["-sdk", "macosx", "metal", "--version"], { stdio: "ignore", env: { ...process.env, DEVELOPER_DIR: dir } }).status === 0);
  if (!found) throw new Error("No Xcode with a working Metal compiler; install Xcode, run `xcodebuild -downloadComponent MetalToolchain`, or set PROSPERO_GHOSTTY_METAL_DEVELOPER_DIR.");
  return found;
}
const metalDeveloperDir = process.argv.includes("--skip-library") ? "" : metalDeveloper();
const revision = "332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28";
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error || ""}`);
};
if (!existsSync(source)) throw new Error(`Clone ghostty-org/ghostty at ${revision} into ${source}, and install Zig 0.15.2 (or set PROSPERO_GHOSTTY_SOURCE / PROSPERO_ZIG).`);
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).stdout.trim();
if (head !== revision) throw new Error(`Ghostty API revision mismatch: expected ${revision}, got ${head}`);
const patch = resolve(root, "native/ghostty/standalone-library.patch");
const patched = spawnSync("git", ["apply", "--reverse", "--check", patch], { cwd: source, stdio: "ignore" }).status === 0;
if (!patched) {
  run("git", ["checkout", "--", "."], { cwd: source });
  run("git", ["apply", patch], { cwd: source });
} else if (spawnSync("git", ["diff", "--quiet", "--", "include/ghostty.h", "src/apprt/embedded.zig", "src/main_c.zig", "src/build/GhosttyLib.zig", "pkg/libpng/build.zig"], { cwd: source }).status !== 0) {
  run("git", ["checkout", "--", "include/ghostty.h", "src/apprt/embedded.zig", "src/main_c.zig", "src/build/GhosttyLib.zig", "pkg/libpng/build.zig"], { cwd: source });
}
const developerDir = process.env.PROSPERO_GHOSTTY_DEVELOPER_DIR || "/Library/Developer/CommandLineTools";
// Only libSystem's own (first) `targets:` list matters; later re-exported documents in
// the same .tbd may still mention arm64 when libSystem itself is arm64e-only.
const hasArm64Stubs = (sdk) => {
  try {
    const tbd = readFileSync(join(sdk, "usr/lib/libSystem.tbd"), "utf8");
    const start = tbd.indexOf("targets:");
    return start >= 0 && /\barm64-macos\b/.test(tbd.slice(start, tbd.indexOf("]", start)));
  } catch { return false; }
};

// Zig 0.15's Mach-O linker cannot read arm64e-only libSystem stubs (Xcode 26.4+,
// macOS 27 SDKs). Zig asks `xcrun --show-sdk-path` for the native SDK, so when the
// default one is arm64e-only, answer with the newest installed SDK that still ships
// arm64 stubs.
function linkableSdk() {
  if (process.env.PROSPERO_GHOSTTY_SDK) return process.env.PROSPERO_GHOSTTY_SDK;
  const current = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8", env: { ...process.env, DEVELOPER_DIR: developerDir } }).stdout.trim();
  if (hasArm64Stubs(current)) return null;
  const sdks = join(developerDir, "SDKs");
  const candidate = (existsSync(sdks) ? readdirSync(sdks) : [])
    .filter((name) => /^MacOSX\d+(\.\d+)*\.sdk$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((name) => join(sdks, name))
    .find(hasArm64Stubs);
  if (!candidate) throw new Error(`${current} only has arm64e stubs, which Zig 0.15 cannot link; install an SDK with arm64 stubs (e.g. MacOSX15.4.sdk) under ${sdks} or set PROSPERO_GHOSTTY_SDK.`);
  return candidate;
}

// Command shims that sit first on PATH for the duration of `zig build`.
function toolShims() {
  const dir = mkdtempSync(join(tmpdir(), "prospero-ghostty-shims-"));
  // Zig writes archive members that are not 8-byte aligned and have mode 0. Apple's
  // libtool silently drops them while building libghostty-fat.a (including
  // libghostty_zcu.o, i.e. all of Ghostty's API) and ld refuses them outright.
  // Unpack each input archive and give the real libtool plain object files.
  writeFileSync(join(dir, "libtool"), `#!/bin/sh
set -e
if [ "$1" != "-static" ] || [ "$2" != "-o" ]; then exec /usr/bin/libtool "$@"; fi
out=$3; shift 3
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
i=0
for input in "$@"; do
  i=$((i + 1)); mkdir "$work/$i"
  case "$input" in
    /*) path=$input ;;
    *) path=$PWD/$input ;;
  esac
  case "$input" in
    *.a) (cd "$work/$i" && /usr/bin/ar -x "$path" && rm -f __.SYMDEF* && chmod 644 ./*) ;;
    *) cp "$path" "$work/$i/" ;;
  esac
done
exec /usr/bin/libtool -static -o "$out" "$work"/*/*
`);
  chmodSync(join(dir, "libtool"), 0o755);
  const sdk = linkableSdk();
  if (sdk) {
    writeFileSync(join(dir, "xcrun"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--show-sdk-path" ]; then echo '${sdk}'; exit 0; fi
done
exec /usr/bin/xcrun "$@"
`);
    chmodSync(join(dir, "xcrun"), 0o755);
    console.log(`Using ${sdk} for Zig's native SDK`);
  }
  return dir;
}

if (!process.argv.includes("--skip-library")) {
  const shims = toolShims();
  const env = {
    ...process.env,
    PATH: `${shims}${delimiter}${process.env.PATH}`,
    DEVELOPER_DIR: developerDir,
    PROSPERO_GHOSTTY_METAL_DEVELOPER_DIR: metalDeveloperDir,
  };
  const args = ["build", "-Doptimize=ReleaseFast", "-Dapp-runtime=none", "-Demit-xcframework=false", "-Demit-macos-app=false", "-Demit-docs=false", "-Demit-themes=false"];
  try {
    const first = spawnSync(zig, args, { cwd: source, stdio: "inherit", env });
    const proxies = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].filter((key) => env[key]);
    if (first.status !== 0 && proxies.length > 0) {
      // Zig 0.15's package fetcher gets "400 Bad Request" through some local HTTP proxies.
      console.log(`zig build failed with ${proxies.join("/")} set; retrying without the proxy`);
      for (const key of proxies) delete env[key];
      run(zig, args, { cwd: source, env });
    } else if (first.status !== 0) {
      throw new Error(`${zig} failed (${first.status}): ${first.error || ""}`);
    }
  } finally {
    rmSync(shims, { recursive: true, force: true });
  }
}
const include = process.env.PROSPERO_NODE_HEADERS || resolve(homedir(), `Library/Caches/node-gyp/${process.versions.node}/include/node`);
if (!existsSync(resolve(include, "node_api.h"))) throw new Error(`Node-API headers missing at ${include}; set PROSPERO_NODE_HEADERS.`);
const out = resolve(root, ".native/ghostty"); mkdirSync(out, { recursive: true });
run("xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "-fblocks", "-mmacosx-version-min=14.0", "-bundle", "-undefined", "dynamic_lookup", "-I", include, "-I", resolve(source, "include"), resolve(root, "native/ghostty/ghostty.mm"), resolve(source, "zig-out/lib/libghostty.a"), "-framework", "Cocoa", "-framework", "QuartzCore", "-framework", "Metal", "-framework", "CoreText", "-framework", "CoreGraphics", "-framework", "Carbon", "-framework", "IOSurface", "-framework", "CoreVideo", "-o", resolve(out, "ghostty.node")]);
// `-undefined dynamic_lookup` lets a libghostty.a without Ghostty's own objects link
// "successfully"; the addon then calls a null ghostty_init and the app segfaults on launch.
const missing = spawnSync("nm", ["-u", resolve(out, "ghostty.node")], { encoding: "utf8" }).stdout
  .split("\n").map((line) => line.trim()).filter((symbol) => symbol.startsWith("_ghostty_"));
if (missing.length) throw new Error(`ghostty.node has unresolved Ghostty symbols (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}); libghostty.a is incomplete.`);
run("xcrun", ["clang++", "-std=c++17", "-O2", "-mmacosx-version-min=14.0", resolve(root, "native/ghostty/relay.cc"), "-o", resolve(out, "prospero-terminal-relay")]);
cpSync(resolve(source, "zig-out/share/ghostty"), resolve(out, "resources"), { recursive: true });
cpSync(resolve(root, "native/ghostty/config"), resolve(out, "config"));
cpSync(resolve(source, "LICENSE"), resolve(out, "GHOSTTY-LICENSE"));
writeFileSync(resolve(out, "build.json"), JSON.stringify({ revision, platform: process.platform, arch: process.arch, version: "1.3.1" }, null, 2));
console.log(`Native Ghostty staged at ${out}`);
