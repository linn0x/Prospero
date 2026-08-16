/**
 * Out-of-band cancellation for the blocking pipe-I/O worker.
 *
 * Both workers load the same verified addon in the same Node process, so its
 * native opaque-handle registry is shared.  The primary worker owns ordinary
 * I/O; this tiny control worker is deliberately limited to the two native
 * operations which interrupt a pending ReadFile/ConnectNamedPipe.  This
 * avoids placing a close request behind the very read it must cancel.
 */
import { parentPort } from "node:worker_threads";
import { writeFileSync } from "node:fs";
import {
  loadWindowsNative,
  type SecureNamedPipeConnectionHandle,
  type SecureNamedPipeServerHandle,
} from "@prospero/windows-native";

if (!parentPort) throw new Error("Windows session host native cancellation worker requires a parent port");

const testDiagnosticPath = process.env["PROSPERO_WINDOWS_SESSION_HOST_TEST_DIAGNOSTIC"];
function writeTestDiagnostic(stage: string): void {
  if (typeof testDiagnosticPath !== "string" || testDiagnosticPath.length === 0) return;
  try { writeFileSync(testDiagnosticPath, JSON.stringify({ version: 1, stage })); }
  catch { /* CI-only diagnostic must not change worker behavior */ }
}
writeTestDiagnostic("canceller_module_loaded");

interface Request {
  readonly id: number;
  readonly op: "initialize" | "disconnectConnection" | "closeServer";
  readonly args?: { readonly handle?: unknown };
}

let native: ReturnType<typeof loadWindowsNative> | null = null;

function binding(): ReturnType<typeof loadWindowsNative> {
  if (!native) {
    writeTestDiagnostic("canceller_binding_loading");
    native = loadWindowsNative();
    writeTestDiagnostic("canceller_binding_loaded");
  }
  return native;
}

function handle(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n) throw new Error("native pipe handle is invalid");
  return value;
}

function request(op: Request["op"], args: Request["args"]): unknown {
  const addon = binding();
  if (op === "initialize") return { report: addon.getAbiInfo() };
  if (op === "disconnectConnection") {
    addon.disconnectSecureNamedPipeConnection(handle(args?.handle) as SecureNamedPipeConnectionHandle);
    return undefined;
  }
  addon.closeSecureNamedPipeServer(handle(args?.handle) as SecureNamedPipeServerHandle);
  return undefined;
}

parentPort.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const value = message as Partial<Request>;
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id) ||
    (value.op !== "initialize" && value.op !== "disconnectConnection" && value.op !== "closeServer")) return;
  writeTestDiagnostic("canceller_request_received");
  try { parentPort!.postMessage({ id: value.id, ok: true, value: request(value.op, value.args) }); }
  catch (error) { parentPort!.postMessage({ id: value.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
