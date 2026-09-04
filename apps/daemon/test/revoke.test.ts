import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticate,
  deviceId,
  loadIdentity,
  loadDevices,
  mintDevice,
  revokeDevice,
  revokeDevices,
  type AuthFailure,
} from "../src/pairing.js";

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

function runMintWorker(home: string, prefix: string, count: number): Promise<void> {
  const pairing = pathToFileURL(path.resolve(import.meta.dirname, "../dist/pairing.js")).href;
  const source = [
    `import { mintDevice } from ${JSON.stringify(pairing)};`,
    `const home = ${JSON.stringify(home)};`,
    `const prefix = ${JSON.stringify(prefix)};`,
    `for (let i = 0; i < ${String(count)}; i++) mintDevice(home, { name: prefix + i, allowShell: true });`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: "pipe" });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `mint worker exited ${String(code)}`));
    });
  });
}

function runIdentityWorker(home: string): Promise<string> {
  const pairing = pathToFileURL(path.resolve(import.meta.dirname, "../dist/pairing.js")).href;
  const source = `import { loadIdentity } from ${JSON.stringify(pairing)}; console.log(loadIdentity(${JSON.stringify(home)}).publicKey);`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `identity worker exited ${String(code)}`));
    });
  });
}

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

  it("稳定 id 只撤销选中的同名设备", () => {
    const home = tempHome();
    const first = mintDevice(home, { name: "phone", allowShell: true });
    const second = mintDevice(home, { name: "phone", allowShell: true });

    expect(deviceId(first)).toHaveLength(43);
    expect(revokeDevice(home, deviceId(first))?.token).toBe(first.token);
    expect(loadDevices(home).map((device) => device.token)).toEqual([second.token]);
    expect(revokeDevice(home, deviceId(first))).toBeNull();
  });

  it("多进程同时登记不会截断 JSON 或丢失设备", async () => {
    const home = tempHome();
    await Promise.all(Array.from({ length: 8 }, (_, index) => runMintWorker(home, `p${String(index)}-`, 20)));

    const devices = loadDevices(home);
    expect(devices).toHaveLength(160);
    expect(new Set(devices.map((device) => device.name)).size).toBe(160);
    expect(new Set(devices.map((device) => device.token)).size).toBe(160);
  }, 20_000);

  it("多进程首次启动只会生成一个 daemon 身份", async () => {
    const home = tempHome();
    const keys = await Promise.all(Array.from({ length: 8 }, () => runIdentityWorker(home)));

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(loadIdentity(home).publicKey);
  }, 20_000);

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
    const info = statSync(path.join(home, "devices.json"));
    expect(info.isFile()).toBe(true);
    if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o600);
  });

  it("拒绝时能说出到底是哪一种失败 —— 两种的处理方式完全不同", () => {
    // 手机上只会看到一句模糊的"配对已失效",Mac 这边必须留下能定位的痕迹:
    // token 不认识是配对码过期,公钥不符是重装或 token 泄漏
    const home = tempHome();
    const d = mintDevice(home, { name: "reason", allowShell: false });
    const seen: AuthFailure[] = [];
    const fail = (r: AuthFailure): void => { seen.push(r); };

    authenticate(home, { type: "hello", token: "nope", clientPubKey, clientInfo }, fail);
    expect(seen).toEqual(["unknown_token"]);

    // 先正常连一次完成 TOFU 绑定,再换一把公钥来
    expect(authenticate(home, { type: "hello", token: d.token, clientPubKey, clientInfo })).not.toBeNull();
    const other = "B".repeat(43) + "=";
    authenticate(home, { type: "hello", token: d.token, clientPubKey: other, clientInfo }, fail);
    expect(seen).toEqual(["unknown_token", "key_mismatch"]);
  });
});
