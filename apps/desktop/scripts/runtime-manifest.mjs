import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function runtimeManifest(directory, platform, architecture) {
  const extension = platform === "win32" ? ".exe" : "";
  const names = ["prosperod-rs", "prospero", "prospero-execution-host", "prospero-budget-host"].map(name => name + extension);
  const files = Object.fromEntries(names.map(name => {
    const file = path.join(directory, name);
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`Runtime artifact missing or linked: ${name}`);
    return [name, createHash("sha256").update(readFileSync(file)).digest("hex")];
  }));
  return { formatVersion: 1, hostProtocolVersion: 1, platform, architecture, files };
}

export function stageExecutionHost(source, destination, platform, architecture) {
  const extension = platform === "win32" ? ".exe" : "";
  for (const binaryName of ["prospero-execution-host", "prospero-budget-host"]) {
  const name = `${binaryName}${extension}`;
  const file = path.join(source, name);
  if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error(`Missing execution Host release binary: ${file}`);
  copyFileSync(file, path.join(destination, name));
  chmodSync(path.join(destination, name), 0o755);
  }
  const manifest = runtimeManifest(destination, platform, architecture);
  writeFileSync(path.join(destination, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

export function verifyRuntimeManifest(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "runtime-manifest.json"), "utf8"));
  if (manifest.formatVersion !== 1 || manifest.hostProtocolVersion !== 1) throw new Error("Unsupported runtime manifest");
  const actual = runtimeManifest(directory, manifest.platform, manifest.architecture);
  if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files)) throw new Error("Runtime artifacts differ from pinned manifest");
  return manifest;
}
