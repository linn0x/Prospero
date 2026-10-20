// Finalize an ad-hoc signed local bundle after codesign changes runtime hashes.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeManifest, verifyRuntimeManifest } from "./runtime-manifest.mjs";

if (process.platform !== "darwin") throw new Error("Local macOS packaging requires macOS");
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(desktop, "../../dist/desktop");
const app = process.argv[2] ? path.resolve(process.argv[2])
  : [path.join(output, `mac-${process.arch}`, "Prospero.app"), path.join(output, "mac", "Prospero.app")]
    .find(candidate => existsSync(candidate));
if (!app) throw new Error("No packaged Prospero app found");
// This helper must never replace a distribution certificate with ad-hoc signing.
// codesign writes its signature description to stderr.
const details = spawnSync("codesign", ["-dv", app], { encoding: "utf8" });
if (details.status !== 0 || !details.stderr.includes("Signature=adhoc")) {
  throw new Error("Only ad-hoc signed local bundles may be finalized");
}
const runtime = path.join(app, "Contents/Resources/runtime");
const manifestPath = path.join(runtime, "runtime-manifest.json");
const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
const manifest = runtimeManifest(runtime, previous.platform, previous.architecture);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
// Re-sign only the outer bundle; nested runtime signatures must remain intact.
execFileSync("codesign", ["--force", "--sign", "-", "--options", "runtime",
  "--entitlements", path.join(desktop, "assets/entitlements.mac.plist"), app], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
verifyRuntimeManifest(runtime);
console.log(JSON.stringify({ ok: true, app, runtimeManifestVerified: true }));
