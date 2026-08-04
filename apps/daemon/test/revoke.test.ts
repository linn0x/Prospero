import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authenticate, loadDevices, mintDevice, revokeDevices } from "../src/pairing.js";

const temps: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-revoke-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const clientInfo = { platform: "ios" as const, appVersion: "test" };
// authenticate 要求 32 字节 base64 公钥
const clientPubKey = Buffer.alloc(32, 7).toString("base64");

describe("设备撤销", () => {
  it("撤销后该 token 不再能通过认证", () => {
    const home = tempHome();
    const device = mintDevice(home, { name: "phone", allowShell: true });

    expect(authenticate(home, { type: "hello", token: device.token, clientPubKey, clientInfo })).not.toBeNull();

    const removed = revokeDevices(home, "phone");
    expect(removed).toHaveLength(1);
    expect(loadDevices(home)).toHaveLength(0);

    expect(authenticate(home, { type: "hello", token: device.token, clientPubKey, clientInfo })).toBeNull();
  });

  it("只撤销同名的,其他设备不受影响", () => {
    const home = tempHome();
    const keep = mintDevice(home, { name: "ipad", allowShell: false });
    mintDevice(home, { name: "phone", allowShell: true });

    revokeDevices(home, "phone");

    const left = loadDevices(home);
    expect(left).toHaveLength(1);
    expect(left[0]?.name).toBe("ipad");
    expect(authenticate(home, { type: "hello", token: keep.token, clientPubKey, clientInfo })).not.toBeNull();
  });

  it("同名多台一起撤 —— 留一条还能连上是最糟的结果", () => {
    const home = tempHome();
    const first = mintDevice(home, { name: "phone", allowShell: true });
    const second = mintDevice(home, { name: "phone", allowShell: true });
    expect(first.token).not.toBe(second.token);

    expect(revokeDevices(home, "phone")).toHaveLength(2);
    expect(loadDevices(home)).toHaveLength(0);
    expect(authenticate(home, { type: "hello", token: second.token, clientPubKey, clientInfo })).toBeNull();
  });

  it("撤销不存在的设备是空操作,不抛错", () => {
    const home = tempHome();
    mintDevice(home, { name: "phone", allowShell: true });
    expect(revokeDevices(home, "nobody")).toEqual([]);
    expect(loadDevices(home)).toHaveLength(1);
  });

  it("重写后的 devices.json 仍是 0600", () => {
    const home = tempHome();
    mintDevice(home, { name: "a", allowShell: true });
    mintDevice(home, { name: "b", allowShell: true });
    revokeDevices(home, "a");
    const mode = statSync(path.join(home, "devices.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

