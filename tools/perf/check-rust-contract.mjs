import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const binary = path.join(root, "target/debug", process.platform === "win32" ? "prosperod-rs.exe" : "prosperod-rs");
const result = spawnSync(binary, ["types"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
if (result.status !== 0 || result.error) throw new Error("Build prosperod-rs before checking the TypeScript contract");
if (readFileSync(path.join(root, "packages/protocol/src/rust-daemon.ts"), "utf8") !== result.stdout) throw new Error("Rust and TypeScript contract differ; regenerate with prosperod-rs types --output packages/protocol/src/rust-daemon.ts");
process.stdout.write("Rust / TypeScript contract matches\n");
