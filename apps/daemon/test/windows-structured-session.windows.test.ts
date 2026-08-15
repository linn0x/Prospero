import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { attachWindowsSessionHost } from "../src/windows-session-host-client.js";
import { launchDetachedWindowsSessionHost } from "../src/windows-session-host-runner.js";

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === "win32")("Windows structured Session Host native integration", () => {
  it("puts the detached host in the real N-API Job before its provider starts, survives daemon detach, then kills provider and grandchild after reply", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "prospero-windows-structured-"));
    temporary.push(root);
    const sessionId = "windows-real-structured";
    const epoch = "windows-real-structured-epoch-0001";
    const fixture = pathToFileURL(fileURLToPath(new URL("./fixtures/windows-structured-fake-adapter-host.mjs", import.meta.url))).href;
    const manifest = await launchDetachedWindowsSessionHost({
      sessionId,
      epoch,
      pipeName: `\\\\.\\pipe\\prospero.${sessionId}.${Date.now()}`,
      stateDirectory: path.join(root, "native-state"),
      handlerModule: fixture,
      readOnlyMethods: [],
    });
    const first = await attachWindowsSessionHost(manifest);
    await first.acquireMutationLease();
    const started = await first.command("structured.send", { text: "hold approval" }, true, "send-original") as { providerPid: number; grandchildPid: number };
    expect(processIsAlive(started.providerPid)).toBe(true);
    expect(processIsAlive(started.grandchildPid)).toBe(true);
    // Simulate daemon exit: disconnect only. The host and its Job keep the
    // fake provider alive, and no offline policy resolves the request.
    await first.dispose();

    const second = await attachWindowsSessionHost(manifest);
    await second.acquireMutationLease();
    const replay = await second.replay(0);
    expect(replay.events).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        type: "structured.event",
        body: expect.objectContaining({ kind: "permission.request", reqId: "real-native-approval" }),
      }),
    }));
    await second.command("structured.respondPermission", { reqId: "real-native-approval", reply: "once" }, true, "resolve-original");
    const killed = await second.command("structured.kill", {}, true, "kill-original") as { providerPid: number; grandchildPid: number };
    await second.dispose();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(processIsAlive(killed.providerPid)).toBe(false);
    expect(processIsAlive(killed.grandchildPid)).toBe(false);
  });
});
