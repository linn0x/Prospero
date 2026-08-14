import { chmodSync, existsSync } from "node:fs";
import path from "node:path";

if (process.platform === "darwin") {
  const helper = path.join(
    process.cwd(),
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
    "spawn-helper",
  );
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
