import { chmodSync, existsSync } from "node:fs";
import path from "node:path";

if (process.platform === "darwin") {
  for (const arch of ["arm64", "x64"]) {
    const helper = path.join(
      process.cwd(),
      "node_modules",
      "node-pty",
      "prebuilds",
      `darwin-${arch}`,
      "spawn-helper",
    );
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
