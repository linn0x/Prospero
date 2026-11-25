const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function resolveOuterSigningIdentity(appPath) {
  const details = spawnSync("codesign", ["-dvv", appPath], { encoding: "utf8" });
  if (details.status !== 0) {
    throw new Error(`Failed to inspect code signature on ${appPath}: ${details.stderr || details.stdout}`);
  }
  if (details.stderr.includes("Signature=adhoc")) {
    return { identity: "-", isAdhoc: true };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "prospero-after-sign-"));
  try {
    const certPrefix = path.join(tempDir, "cert");
    execFileSync("codesign", ["-dvv", `--extract-certificates=${certPrefix}`, appPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const leafCert = `${certPrefix}0`;
    if (!existsSync(leafCert)) {
      throw new Error(`No extracted leaf certificate found for ${appPath}`);
    }
    const output = execFileSync(
      "openssl",
      ["x509", "-inform", "DER", "-in", leafCert, "-noout", "-fingerprint", "-sha1"],
      { encoding: "utf8" },
    );
    const sha1 = output.replace(/^.*=/, "").replace(/:/g, "").trim().toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(sha1)) {
      throw new Error(`Unexpected certificate SHA-1 fingerprint for ${appPath}: ${output.trim()}`);
    }
    return { identity: sha1, isAdhoc: false };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = async function afterSignMac(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const runtimeDir = path.join(appPath, "Contents", "Resources", "runtime");
  const manifestPath = path.join(runtimeDir, "runtime-manifest.json");
  if (!existsSync(manifestPath)) {
    return;
  }

  const { identity, isAdhoc } = resolveOuterSigningIdentity(appPath);
  const { runtimeManifest, verifyRuntimeManifest } = await import(
    pathToFileURL(path.join(__dirname, "runtime-manifest.mjs")).href
  );

  const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifest = runtimeManifest(runtimeDir, previous.platform, previous.architecture);

  if (JSON.stringify(previous.files) !== JSON.stringify(manifest.files)) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const configuredEntitlements = context.packager.platformSpecificBuildOptions?.entitlements;
    const entitlementsPath = configuredEntitlements
      ? path.resolve(context.packager.projectDir, configuredEntitlements)
      : path.join(context.packager.projectDir, "assets", "entitlements.mac.plist");

    // Re-sign only the outer bundle so nested runtime binary hashes stay unchanged.
    const args = ["--force", "--sign", identity, "--options", "runtime"];
    if (!isAdhoc) {
      args.push("--timestamp");
    }
    args.push("--entitlements", entitlementsPath, appPath);
    execFileSync("codesign", args, { stdio: "inherit" });
  }

  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });
  verifyRuntimeManifest(runtimeDir);
};
