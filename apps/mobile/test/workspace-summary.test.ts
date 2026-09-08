import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostConnection } from "../src/lib/connection";
import { getWorkspaceSummary } from "../src/lib/workspace-summary";

const summary = { branch: "main", sizeBytes: 1024, sizeComplete: true, checkedAt: 1 };
function connection(supported = true) {
  return { supportsWorkspaceSummary: supported, workspaceSummary: vi.fn().mockResolvedValue(summary),
    gitStatus: vi.fn().mockResolvedValue({ branch: "legacy" }) };
}
const read = (c: ReturnType<typeof connection>, host = "host", path = "/repo", sid = "session") =>
  getWorkspaceSummary(c as unknown as HostConnection, host, path, sid);
afterEach(() => vi.useRealTimers());

describe("workspace metadata cache and compatibility", () => {
  it("coalesces requests for the same directory while isolating devices and connections", async () => {
    const c = connection();
    const a = read(c);
    expect(read(c, "host", "/repo", "another-session")).toBe(a);
    await expect(a).resolves.toEqual(summary);
    await read(c, "second-device");
    await read(c, "host", "/other-repo");
    expect(c.workspaceSummary).toHaveBeenCalledTimes(3);
    const replacement = connection();
    await read(replacement);
    expect(replacement.workspaceSummary).toHaveBeenCalledOnce();
  });

  it("falls back to real Git status on older daemons without inventing a size", async () => {
    const c = connection(false);
    await expect(read(c)).resolves.toMatchObject({ branch: "legacy", sizeBytes: null, sizeComplete: false });
    expect(c.workspaceSummary).not.toHaveBeenCalled();
    expect(c.gitStatus).toHaveBeenCalledWith("session");
  });

  it("expires successful metadata and retries failures", async () => {
    vi.useFakeTimers();
    const c = connection();
    c.workspaceSummary.mockRejectedValueOnce(new Error("offline"));
    await expect(read(c)).rejects.toThrow("offline");
    await read(c);
    expect(c.workspaceSummary).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_001);
    await read(c);
    expect(c.workspaceSummary).toHaveBeenCalledTimes(3);
  });
});
