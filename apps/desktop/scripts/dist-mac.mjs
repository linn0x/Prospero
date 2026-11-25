#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRuntimeManifest } from "./runtime-manifest.mjs";

if (process.platform !== "darwin") {
  throw new Error("macOS Developer ID packaging requires macOS");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");

function usage() {
  console.log(`Usage: node scripts/dist-mac.mjs [options]

Options:
  --identity <name-or-hash>   Match Developer ID Application identity by SHA-1 hash or substring
  --team <TEAMID>             Match Developer ID Application identity by Apple Team ID
  --arch <arm64|x64>          Target architecture (default: ${process.arch})
  --targets <list>            Comma-separated electron-builder targets (default: dmg)
  --build-rust                Run cargo build --release -p prosperod-rs --locked
  --rebuild-native            Run npm run build:native:mac
  --skip-build                Skip electron-vite build and @prospero/protocol rebuild
  --notarize                  Notarize DMG using APPLE_KEYCHAIN_PROFILE
  --notarize-profile <name>   Notarize and staple DMG using xcrun notarytool keychain profile
  -h, --help                  Show this help message
`);
}

function parseArgs(argv) {
  const options = {
    identity: undefined,
    team: undefined,
    arch: process.arch,
    targets: ["dmg"],
    buildRust: false,
    rebuildNative: false,
    skipBuild: false,
    notarizeProfile: undefined,
  };
  let useEnvNotarize = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else if (arg === "--identity") {
      options.identity = argv[++i];
      if (!options.identity) throw new Error("--identity requires a value");
    } else if (arg === "--team") {
      options.team = argv[++i];
      if (!options.team) throw new Error("--team requires a value");
    } else if (arg === "--arch") {
      options.arch = argv[++i];
      if (options.arch !== "arm64" && options.arch !== "x64") {
        throw new Error(`Unsupported macOS architecture: ${options.arch}`);
      }
    } else if (arg === "--targets") {
      const raw = argv[++i];
      if (!raw) throw new Error("--targets requires a comma-separated value");
      options.targets = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
      if (options.targets.length === 0) throw new Error("--targets cannot be empty");
    } else if (arg === "--build-rust") {
      options.buildRust = true;
    } else if (arg === "--rebuild-native") {
      options.rebuildNative = true;
    } else if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--notarize") {
      useEnvNotarize = true;
    } else if (arg === "--notarize-profile") {
      options.notarizeProfile = argv[++i];
      if (!options.notarizeProfile) throw new Error("--notarize-profile requires a profile name");
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (useEnvNotarize && !options.notarizeProfile) {
    options.notarizeProfile = process.env.APPLE_KEYCHAIN_PROFILE;
    if (!options.notarizeProfile) {
      throw new Error("--notarize requires APPLE_KEYCHAIN_PROFILE or --notarize-profile <name>");
    }
  }
  return options;
}

function listDeveloperIdIdentities() {
  const stdout = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  });
  const identities = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application:[^"]+)"$/);
    if (match) {
      identities.push({ hash: match[1], name: match[2] });
    }
  }
  return identities;
}

function certificateHasTeamOu(certName, team) {
  const pem = execFileSync("security", ["find-certificate", "-c", certName, "-p"], {
    encoding: "utf8",
  });
  const subject = spawnSync("openssl", ["x509", "-noout", "-subject"], {
    input: pem,
    encoding: "utf8",
  });
  if (subject.status !== 0) return false;
  return new RegExp(`\\bOU\\s*=\\s*${team}\\b`).test(subject.stdout);
}

function resolveSigningIdentity(options) {
  const all = listDeveloperIdIdentities();
  if (all.length === 0) {
    throw new Error(
      'No valid "Developer ID Application" certificate found in keychain. Install your Developer ID Application certificate and private key first.',
    );
  }

  let matches = all;
  const qualifier = options.identity ?? process.env.MAC_SIGN_IDENTITY ?? process.env.CSC_NAME;
  if (qualifier) {
    const normalized = qualifier.replace(/^Developer ID Application:\s*/i, "").trim();
    matches = matches.filter(
      (item) =>
        item.hash.toUpperCase() === normalized.toUpperCase() ||
        item.name.toLowerCase().includes(normalized.toLowerCase()),
    );
  }

  if (options.team) {
    const team = options.team.trim();
    matches = matches.filter(
      (item) => item.name.includes(`(${team})`) || certificateHasTeamOu(item.name, team),
    );
  }

  if (matches.length === 0) {
    throw new Error(
      `No "Developer ID Application" identity matched your filter. Available:\n${all.map((id) => `  - ${id.hash} "${id.name}"`).join("\n")}`,
    );
  }

  if (matches.length > 1) {
    throw new Error(
      `Multiple "Developer ID Application" identities found; specify --identity or --team:\n${matches.map((id) => `  - ${id.hash} "${id.name}"`).join("\n")}`,
    );
  }

  return matches[0];
}

function resolveElectronBuilderBin() {
  const candidates = [
    path.join(desktopDir, "node_modules", ".bin", "electron-builder"),
    path.join(repoRoot, "node_modules", ".bin", "electron-builder"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function run(command, args, cwd, env = process.env) {
  execFileSync(command, args, { cwd, env, stdio: "inherit" });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const identity = resolveSigningIdentity(options);
  console.log(`Using signing identity: ${identity.name} (${identity.hash})`);

  const releaseDir = path.join(repoRoot, "target", "release");
  const requiredRustBinaries = [
    "prosperod-rs",
    "prospero",
    "prospero-execution-host",
    "prospero-budget-host",
  ];
  const missingRust = requiredRustBinaries.some(
    (name) => !existsSync(path.join(releaseDir, name)),
  );
  if (options.buildRust || missingRust) {
    run("cargo", ["build", "--release", "-p", "prosperod-rs", "--locked"], repoRoot);
  }

  const nativeDir = path.join(desktopDir, ".native", "ghostty");
  const missingNative =
    !existsSync(path.join(nativeDir, "ghostty.node")) ||
    !existsSync(path.join(nativeDir, "prospero-terminal-relay"));
  if (options.rebuildNative || missingNative) {
    run("npm", ["run", "build:native:mac"], desktopDir);
  }

  const prepareArgs = ["scripts/prepare-runtime.mjs", "--arch", options.arch];
  if (options.skipBuild) {
    prepareArgs.push("--skip-build");
  }
  run("node", prepareArgs, desktopDir);

  if (!options.skipBuild) {
    run("npm", ["run", "build"], desktopDir);
  }

  const builderBin = resolveElectronBuilderBin();
  const builderArgs = ["--mac", ...options.targets, `--${options.arch}`, "-c.dmg.sign=true"];
  const builderEnv = {
    ...process.env,
    CSC_NAME: identity.hash,
    CSC_IDENTITY_AUTO_DISCOVERY: "true",
    CSC_FOR_PULL_REQUEST: "true",
  };

  if (builderBin) {
    run(builderBin, builderArgs, desktopDir, builderEnv);
  } else {
    run("npx", ["electron-builder", ...builderArgs], desktopDir, builderEnv);
  }

  const desktopPkg = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
  const distDir = path.join(repoRoot, "dist", "desktop");
  const appPath = [
    path.join(distDir, `mac-${options.arch}`, `${desktopPkg.build.productName}.app`),
    path.join(distDir, "mac", `${desktopPkg.build.productName}.app`),
  ].find((candidate) => existsSync(candidate));
  if (!appPath) {
    throw new Error(`Packaged .app not found under ${distDir}`);
  }

  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });
  verifyRuntimeManifest(path.join(appPath, "Contents", "Resources", "runtime"));

  let dmgPath = null;
  if (options.targets.includes("dmg")) {
    dmgPath = path.join(
      distDir,
      `${desktopPkg.build.productName}-${desktopPkg.version}-mac-${options.arch}.dmg`,
    );
    if (!existsSync(dmgPath)) {
      throw new Error(`Expected DMG not found: ${dmgPath}`);
    }

    const inspect = spawnSync("codesign", ["-dvv", dmgPath], { encoding: "utf8" });
    if (inspect.status !== 0 || !inspect.stderr.includes("Timestamp=")) {
      run("codesign", ["--force", "--sign", identity.hash, "--timestamp", dmgPath], desktopDir);
    }

    run("codesign", ["--verify", "--verbose=2", dmgPath], desktopDir);
    const verified = spawnSync("codesign", ["-dvv", dmgPath], { encoding: "utf8" });
    if (
      verified.status !== 0 ||
      !verified.stderr.includes("Authority=Developer ID Application:") ||
      !verified.stderr.includes("Timestamp=")
    ) {
      throw new Error(`DMG signature verification missing Developer ID or timestamp:\n${verified.stderr}`);
    }

    if (options.notarizeProfile) {
      run(
        "xcrun",
        ["notarytool", "submit", dmgPath, "--keychain-profile", options.notarizeProfile, "--wait"],
        desktopDir,
      );
      run("xcrun", ["stapler", "staple", dmgPath], desktopDir);
      run("xcrun", ["stapler", "validate", dmgPath], desktopDir);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        identity: identity.name,
        hash: identity.hash,
        arch: options.arch,
        app: appPath,
        dmg: dmgPath,
        notarized: Boolean(options.notarizeProfile && dmgPath),
        runtimeManifestVerified: true,
      },
      null,
      2,
    ),
  );
}

main();
