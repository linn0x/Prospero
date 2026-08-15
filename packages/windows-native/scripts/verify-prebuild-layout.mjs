import { existsSync, readFileSync } from "node:fs";
const capabilityNames = ["processIdentity", "secureNamedPipe", "jobObject", "detachedHost", "conPty"];
for (const arch of ["x64", "arm64"]) {
  const directory = new URL(`../prebuilds/win32-${arch}/`, import.meta.url);
  const manifestPath = new URL("manifest.json", directory);
  if (!existsSync(manifestPath)) throw new Error(`Missing ${manifestPath.pathname}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.platform !== "win32" || manifest.arch !== arch) {
    throw new Error(`Invalid prebuild metadata in ${manifestPath.pathname}`);
  }
  if (manifest.artifact?.file !== "prospero_windows_native.node") {
    throw new Error(`Unexpected native artifact name in ${manifestPath.pathname}`);
  }
  if (!/^[a-fA-F0-9]{64}$/.test(manifest.artifact?.sha256 ?? "")) {
    throw new Error(`Invalid artifact SHA-256 format in ${manifestPath.pathname}`);
  }
  if (manifest.native?.abiVersion !== 1 || manifest.native?.napiVersion !== 8) {
    throw new Error(`Invalid native ABI metadata in ${manifestPath.pathname}`);
  }
  if (
    !manifest.native?.capabilities ||
    capabilityNames.some((name) => typeof manifest.native.capabilities[name] !== "boolean")
  ) {
    throw new Error(`Invalid capability map in ${manifestPath.pathname}`);
  }
  if (!["valid", "unsigned", "unverified", "invalid"].includes(manifest.authenticode?.status)) {
    throw new Error(`Invalid Authenticode status in ${manifestPath.pathname}`);
  }
  if (
    manifest.authenticode.status === "valid" &&
    !/^[a-fA-F0-9]{40}$/.test(manifest.authenticode.thumbprintSha1 ?? "")
  ) {
    throw new Error(`Invalid Authenticode thumbprint format in ${manifestPath.pathname}`);
  }
}
