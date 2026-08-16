/** Executable entrypoint for the native detached Windows Session Host. */
import { runDetachedWindowsSessionHostFromEnvironment } from "./windows-session-host-runner.js";

void runDetachedWindowsSessionHostFromEnvironment().catch((error) => {
  // Bootstrap contains no capability/credential; do not serialize arbitrary
  // errors that may carry provider context into the detached host's stderr.
  process.stderr.write(`Windows Session Host failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
