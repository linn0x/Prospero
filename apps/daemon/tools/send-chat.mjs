#!/usr/bin/env node
/**
 * 调试探针:不经手机,直接向最新的结构化会话发一条消息。
 *   node apps/daemon/tools/send-chat.mjs "你的消息"
 *
 * 首次使用前先登记设备:node apps/daemon/dist/cli.js pair --name cli-probe
 * 密钥持久化在 ~/.prospero/probe-keys.json —— daemon 对设备做 TOFU 公钥绑定,
 * 每次换新密钥会被正确地拒绝。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { clientHandshake, generateKeyPairB64, parseS2C } from "@prospero/protocol";

const home = process.env.PROSPERO_HOME ?? path.join(process.env.HOME, ".prospero");
const read = (f, fallback) => {
  try {
    return JSON.parse(readFileSync(path.join(home, f), "utf8"));
  } catch {
    return fallback;
  }
};

const devices = read("devices.json", { devices: [] }).devices;
const identity = read("identity.json", null);
const cfg = read("config.json", { port: 7423 });
if (!identity) {
  console.error(`未找到 daemon 身份(${home}/identity.json),请先启动 prosperod`);
  process.exit(1);
}

const dev = devices.find((d) => d.name === "cli-probe");
if (!dev) {
  console.error("请先登记探针设备:node apps/daemon/dist/cli.js pair --name cli-probe");
  process.exit(1);
}

// 复用同一密钥对,否则会撞上 daemon 的 TOFU 绑定
const keyFile = path.join(home, "probe-keys.json");
let keys;
if (existsSync(keyFile)) {
  keys = JSON.parse(readFileSync(keyFile, "utf8"));
} else {
  keys = generateKeyPairB64();
  writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
}

const text = process.argv[2] ?? "Say PONG";
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws`);
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

const { frame, channel } = clientHandshake(identity.publicKey, {
  type: "hello",
  token: dev.token,
  clientPubKey: keys.publicKey,
  clientInfo: { platform: "ios", appVersion: "probe" },
});

ws.on("close", (code, reason) => {
  console.error(`连接被关闭 code=${code} ${reason.toString()}`);
  process.exit(1);
});

ws.on("message", (raw) => {
  const m = parseS2C(channel.open(raw.toString()));
  if (m.type === "error") {
    console.error(`daemon 报错 [${m.code}] ${m.message}`);
    process.exit(1);
  }
  if (m.type !== "hello.ok") return;
  const target = m.sessions.filter((s) => s.kind === "structured").pop();
  if (!target) {
    console.error("没有结构化会话,请先在 App 里新建 opencode/claude 会话");
    process.exit(1);
  }
  console.log(`→ ${target.title} (${target.id.slice(0, 8)}): ${text}`);
  ws.send(channel.seal({ type: "chat.send", sid: target.id, text }));
  setTimeout(() => process.exit(0), 2000);
});

ws.send(frame);
