/**
 * Test-only Codex app-server stand-in: it records its PID, accepts stdin, and
 * deliberately never answers initialize. The launch rollback test therefore
 * proves that the detached runner and this provider child share cleanup fate.
 */
import { writeFileSync } from "node:fs";

const pidFile = process.env.PROSPERO_TEST_PROVIDER_PID_FILE;
if (pidFile) writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });

process.stdin.resume();
setInterval(() => {}, 1_000);
