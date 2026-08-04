import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { clientHandshake, generateKeyPairB64, parseS2C } from "@prospero/protocol";

const devices = JSON.parse(readFileSync(process.env.HOME + "/.prospero/devices.json", "utf8")).devices;
const identity = JSON.parse(readFileSync(process.env.HOME + "/.prospero/identity.json", "utf8"));
let cfg = { port: 7423 };
try {
  cfg = JSON.parse(readFileSync(process.env.HOME + "/.prospero/config.json", "utf8"));
} catch {
  // 未落盘时用默认端口
}
// 用一个新设备条目避免与手机的 TOFU 绑定冲突
const dev = devices.find(d => d.name === "cli-probe");
if (!dev) { console.error("请先: node apps/daemon/dist/cli.js pair --name cli-probe"); process.exit(1); }

const keys = generateKeyPairB64();
const ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ws`);
await new Promise(r => ws.once("open", r));
const { frame, channel } = clientHandshake(identity.publicKey, {
  type: "hello", token: dev.token, clientPubKey: keys.publicKey,
  clientInfo: { platform: "ios", appVersion: "probe" },
});
ws.on("message", (raw) => {
  const m = parseS2C(channel.open(raw.toString()));
  if (m.type === "hello.ok") {
    const target = m.sessions.filter(s => s.kind === "structured").pop();
    if (!target) { console.log("没有结构化会话"); process.exit(0); }
    console.log("目标会话:", target.id, target.title);
    ws.send(channel.seal({ type: "chat.send", sid: target.id, text: process.argv[2] ?? "Say PONG" }));
    setTimeout(() => process.exit(0), 3000);
  }
});
ws.send(frame);
