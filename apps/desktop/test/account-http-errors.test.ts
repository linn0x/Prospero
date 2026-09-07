import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountConfigResult, accountModelsResult } from "../src/shared/account-features";
import { DaemonRuntime } from "../src/main/daemon-runtime";
import { StateStore } from "../src/main/state-store";

vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => "" } }));
const homes: string[] = [];
function runtime() {
  const home = mkdtempSync(join(tmpdir(), "prospero-account-http-"));
  homes.push(home);
  writeFileSync(join(home, "status.json"), JSON.stringify({ pid: process.pid, port: 7431, controlToken: "synthetic-control-token" }));
  return new DaemonRuntime(new StateStore(home));
}
afterEach(() => { vi.restoreAllMocks(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe("structured account errors over the desktop control transport", () => {
  it("preserves conflicts for the editor without changing ordinary request error behavior", async () => {
    const result = { type: "agent.account.config.result", requestId: "request", ok: false, error: { code: "conflict", message: "Reload configuration" } };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(result), { status: 409 }));
    const daemon = runtime();
    const response = await daemon.request("/_prospero/control/accounts", { method: "POST", acceptJsonError: true });
    expect(accountConfigResult(response, "request", "profile").error?.code).toBe("conflict");
    await expect(daemon.request("/_prospero/control/accounts")).rejects.toThrow();
  });
  it("retains provider failure categories while refusing malformed error payloads", async () => {
    const result = { type: "agent.account.api.models.result", requestId: "request", ok: false, models: [], error: { code: "authentication", message: "Check credential" } };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 400 }));
    const daemon = runtime();
    expect(accountModelsResult(await daemon.request("/_prospero/control/accounts", { acceptJsonError: true }), "request").error?.code).toBe("authentication");
    fetch.mockResolvedValueOnce(new Response("not-json-private-response", { status: 500 }));
    const malformed = await daemon.request("/_prospero/control/accounts", { acceptJsonError: true });
    expect(() => accountModelsResult(malformed, "request")).toThrow("Invalid model catalog response");
  });
});
