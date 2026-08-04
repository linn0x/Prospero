#!/usr/bin/env node
/**
 * prosperod — Prospero macOS 宿主 daemon。
 * M1 期间在终端里手动运行(继承终端的 TCC 权限),不装 LaunchAgent(M3 由菜单栏壳接管)。
 */
import { createRequire } from "node:module";
import os from "node:os";
import { Command } from "commander";
import { encodePairingQR } from "@prospero/protocol";
import { advertise, candidateAddrs, resolveBindAddr } from "./discovery.js";
import { Notifier } from "./notify.js";
import {
  DEFAULT_PORT,
  buildPairingPayload,
  loadConfig,
  loadDevices,
  loadIdentity,
  mintDevice,
  prosperoHome,
  saveConfig,
} from "./pairing.js";
import { createDaemonServer } from "./ws-server.js";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal") as typeof import("qrcode-terminal");

const program = new Command();
program.name("prosperod").description("Prospero macOS agent hub").version("0.0.1");

program
  .command("start", { isDefault: true })
  .description("启动 daemon(WS 服务 + Bonjour 广播)")
  .option("-p, --port <port>", "监听端口", (v) => parseInt(v, 10))
  .option(
    "-b, --bind <addr>",
    "只监听这个网卡/地址(如 utun10 或 10.0.0.2);默认全部网卡",
  )
  .option("--dev", "开发模式:提供浏览器调试页,loopback 允许明文协议", false)
  .option("--no-bonjour", "不做 mDNS 广播(交给菜单栏壳,由它承担本地网络 TCC)")
  .option("--name <name>", "对外显示的主机名")
  .action(async (opts: { port?: number; bind?: string; dev: boolean; bonjour: boolean; name?: string }) => {
    const home = prosperoHome();
    const config = loadConfig(home);
    const port = opts.port ?? config.port;
    // 0.0.0.0 是"取消绑定"的写法,不是一个要绑的地址
    const rawBind = opts.bind ?? config.bind;
    const bindSpec = rawBind && rawBind !== "0.0.0.0" ? rawBind : undefined;
    // 记住端口与绑定,pair 命令要用同一份
    if (
      (opts.port !== undefined && opts.port !== config.port) ||
      (opts.bind !== undefined && opts.bind !== config.bind)
    ) {
      const { bind: _dropped, ...rest } = config;
      saveConfig(home, { ...rest, port, ...(bindSpec ? { bind: bindSpec } : {}) });
    }
    const bindAddr = bindSpec ? resolveBindAddr(bindSpec) : undefined;
    const server = await createDaemonServer({
      home,
      port,
      bindAddr,
      devMode: opts.dev,
      hostName: opts.name,
      notify: config.notify ?? null,
    });
    const stopAdvertise = opts.bonjour
      ? advertise(server.port, `Prospero @ ${opts.name ?? os.hostname()}`)
      : () => {};

    const devices = loadDevices(home);
    console.log(`prosperod v0.0.1 已启动(home: ${home})`);
    console.log(`已配对设备: ${devices.length} 台${devices.length === 0 ? " —— 运行 `prosperod pair` 生成配对二维码" : ""}`);
    if (bindAddr) {
      console.log(`监听地址(已绑定 ${bindSpec}${bindSpec === bindAddr ? "" : ` → ${bindAddr}`}):`);
      console.log(`  ws://${bindAddr}:${server.port}/ws`);
      console.log("  其余网卡不监听 —— 配对二维码也只会带这一个地址");
    } else {
      console.log("监听地址(候选,客户端并发竞速):");
      for (const addr of candidateAddrs()) {
        console.log(`  ws://${addr}:${server.port}/ws`);
      }
    }
    if (opts.dev) {
      console.log(`开发调试页: http://127.0.0.1:${server.port}/`);
    }
    console.log(
      server.notifier.enabled
        ? "推送: 已启用(App 未在线时,待审批会推到锁屏)"
        : "推送: 未配置(运行 `prosperod notify --url <bark/ntfy 地址>` 开启)",
    );

    const shutdown = async (): Promise<void> => {
      console.log("\n[prosperod] 正在退出(会话进程将随之终止)…");
      stopAdvertise();
      await server.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });

program
  .command("pair")
  .description("为一台新设备生成配对二维码(含全部网卡地址 + token + 公钥)")
  .option("--name <name>", "设备名", "iphone")
  .option("--no-shell", "该设备禁止 shell/custom 会话(完整用户权限)")
  .action((opts: { name: string; shell: boolean }) => {
    const home = prosperoHome();
    const config = loadConfig(home);
    const device = mintDevice(home, { name: opts.name, allowShell: opts.shell });
    const payload = buildPairingPayload(home, {
      token: device.token,
      port: config.port,
      bind: config.bind,
    });
    if (payload.addrs.length === 0) {
      console.error("警告:未发现可用网卡地址(WiFi/WG 均未连接?),二维码不可用。");
    }
    const url = encodePairingQR(payload);
    qrcode.generate(url, { small: true });
    console.log(`设备「${device.name}」已登记(allowShell=${String(device.allowShell)})`);
    console.log(`地址: ${payload.addrs.join(", ")}  端口: ${payload.port}`);
    console.log(`配对串(扫码不便时手动输入):\n${url}`);
    console.log("注意:二维码含访问凭证,请勿截图外传。daemon 重启无需重新配对。");
  });

program
  .command("notify")
  .description("配置推送通道(App 未在线时把待审批推到锁屏)")
  .option("--url <url>", "Bark 或 ntfy 端点,如 https://api.day.app/<key> 或 https://ntfy.sh/<topic>")
  .option("--off", "关闭推送")
  .option("--test", "发一条测试推送")
  .action(async (opts: { url?: string; off?: boolean; test?: boolean }) => {
    const home = prosperoHome();
    const config = loadConfig(home);
    if (opts.off) {
      const { notify: _dropped, ...rest } = config;
      saveConfig(home, rest);
      console.log("推送已关闭");
      return;
    }
    if (opts.url) {
      saveConfig(home, { ...config, notify: { url: opts.url } });
      console.log(`推送端点已保存:${opts.url}`);
    }
    const current = loadConfig(home).notify;
    if (!current) {
      console.log("推送未配置。示例:");
      console.log("  prosperod notify --url https://api.day.app/你的设备key   # Bark(iOS)");
      console.log("  prosperod notify --url https://ntfy.sh/你的topic          # ntfy(Android)");
      return;
    }
    console.log(`当前端点:${current.url}`);
    if (opts.test) {
      const ok = await new Notifier(current).send({
        title: "Prospero 测试推送",
        body: "如果你看到这条,推送通道已打通。",
        url: "prospero://",
      });
      console.log(ok ? "测试推送已发出 ✓" : "测试推送失败 ✗(检查端点与网络)");
    }
  });

program
  .command("status")
  .description("查看身份、配置与已配对设备")
  .action(() => {
    const home = prosperoHome();
    const identity = loadIdentity(home);
    const config = loadConfig(home);
    const devices = loadDevices(home);
    console.log(`home:      ${home}`);
    console.log(`身份公钥:  ${identity.publicKey.slice(0, 12)}…`);
    console.log(`端口:      ${config.port}(默认 ${DEFAULT_PORT})`);
    console.log(`推送:      ${config.notify ? config.notify.url : "未配置"}`);
    console.log(`监听:      ${config.bind ?? "0.0.0.0(全部网卡)"}`);
    console.log(`候选地址:  ${candidateAddrs().join(", ") || "(无)"}`);
    console.log(`设备(${devices.length}):`);
    for (const d of devices) {
      const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "从未连接";
      console.log(
        `  - ${d.name}  allowShell=${String(d.allowShell)}  绑定=${d.clientPubKey ? "已绑定" : "未绑定"}  最近: ${seen}`,
      );
    }
  });

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
