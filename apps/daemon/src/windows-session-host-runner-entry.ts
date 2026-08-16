/** Executable entrypoint for the native detached Windows Session Host. */
import { writeFileSync } from "node:fs";
import { runDetachedWindowsSessionHostFromEnvironment } from "./windows-session-host-runner.js";

const testDiagnosticPath = process.env["PROSPERO_WINDOWS_SESSION_HOST_TEST_DIAGNOSTIC"];

function writeAcceptanceDiagnostic(stage: "entry_loaded" | "entry_failed", error?: unknown): void {
  if (typeof testDiagnosticPath !== "string" || testDiagnosticPath.length === 0) return;
  const message = error instanceof Error
    ? error.message.replace(/[\r\n|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 320)
    : undefined;
  try {
    writeFileSync(testDiagnosticPath, JSON.stringify({ version: 1, stage, ...(message ? { message } : {}) }));
  } catch { /* CI-only diagnostic must not change host startup behavior */ }
}

writeAcceptanceDiagnostic("entry_loaded");
void runDetachedWindowsSessionHostFromEnvironment().catch((error) => {
  writeAcceptanceDiagnostic("entry_failed", error);
  // Bootstrap contains no capability/credential; do not serialize arbitrary
  // errors that may carry provider context into the detached host's stderr.
  process.stderr.write(`Windows Session Host failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
