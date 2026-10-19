import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The native Ghostty view currently targets macOS.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.env.PROSPERO_GHOSTTY_SOURCE || resolve(homedir(), "Library/Caches/Prospero-native/ghostty-v1.3.1");
const zig = process.env.PROSPERO_ZIG || resolve(homedir(), "Library/Caches/Prospero-native/zig-aarch64-macos-0.15.2/zig");
const metalDeveloperDir = process.env.PROSPERO_GHOSTTY_METAL_DEVELOPER_DIR || spawnSync("xcode-select", ["-p"], { encoding: "utf8" }).stdout.trim();
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
if (!patched) run("git", ["apply", patch], { cwd: source });
if (!process.argv.includes("--skip-library")) {
  run(zig, ["build", "-Doptimize=ReleaseFast", "-Dapp-runtime=none", "-Demit-xcframework=false", "-Demit-macos-app=false", "-Demit-docs=false", "-Demit-themes=false"], {
    cwd: source,
    // Zig 0.15's Mach-O linker cannot read Xcode 26.4's arm64e-only stubs.
    env: {
      ...process.env,
      DEVELOPER_DIR: process.env.PROSPERO_GHOSTTY_DEVELOPER_DIR || "/Library/Developer/CommandLineTools",
      PROSPERO_GHOSTTY_METAL_DEVELOPER_DIR: metalDeveloperDir,
    },
  });
}
const include = process.env.PROSPERO_NODE_HEADERS || resolve(homedir(), `Library/Caches/node-gyp/${process.versions.node}/include/node`);
if (!existsSync(resolve(include, "node_api.h"))) throw new Error(`Node-API headers missing at ${include}; set PROSPERO_NODE_HEADERS.`);
const out = resolve(root, ".native/ghostty"); mkdirSync(out, { recursive: true });
run("xcrun", ["clang++", "-std=c++17", "-fobjc-arc", "-fblocks", "-mmacosx-version-min=14.0", "-bundle", "-undefined", "dynamic_lookup", "-I", include, "-I", resolve(source, "include"), resolve(root, "native/ghostty/ghostty.mm"), resolve(source, "zig-out/lib/libghostty.a"), "-framework", "Cocoa", "-framework", "QuartzCore", "-framework", "Metal", "-framework", "CoreText", "-framework", "CoreGraphics", "-framework", "Carbon", "-framework", "IOSurface", "-framework", "CoreVideo", "-o", resolve(out, "ghostty.node")]);
run("xcrun", ["clang++", "-std=c++17", "-O2", "-mmacosx-version-min=14.0", resolve(root, "native/ghostty/relay.cc"), "-o", resolve(out, "prospero-terminal-relay")]);
cpSync(resolve(source, "zig-out/share/ghostty"), resolve(out, "resources"), { recursive: true });
cpSync(resolve(root, "native/ghostty/config"), resolve(out, "config"));
cpSync(resolve(source, "LICENSE"), resolve(out, "GHOSTTY-LICENSE"));
writeFileSync(resolve(out, "build.json"), JSON.stringify({ revision, platform: process.platform, arch: process.arch, version: "1.3.1" }, null, 2));
console.log(`Native Ghostty staged at ${out}`);
