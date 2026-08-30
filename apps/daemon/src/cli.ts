#!/usr/bin/env node
/**
 * prosperod — Prospero local agent host daemon。
 * M1 期间在终端里手动运行(继承终端的 TCC 权限),不装 LaunchAgent(M3 由菜单栏壳接管)。
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { encodePairingQR, validateRelayUrl } from "@prospero/protocol";
import { advertise, candidateAddrs, resolveBindAddr } from "./discovery.js";
import { Notifier } from "./notify.js";
import {
  DEFAULT_PORT,
  buildPairingPayload,
  deviceRelayCredentials,
  deriveRelayRouteId,
  effectiveRelayUrl,
  generateRelayHostSecret,
  issueRelayCredentials,
  loadConfig,
  loadDevices,
  loadIdentity,
  revokeDevices,
  rotateIdentity,
  mintDevice,
  prosperoHome,
  relayPairingForDevice,
  persistRelayCredentials,
  rotateRelayKey,
  saveConfig,
} from "./pairing.js";
import { createDaemonServer } from "./ws-server.js";
import { DAEMON_VERSION } from "./version.js";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal") as typeof import("qrcode-terminal");

function hasWindowsAdministratorToken(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const whoami = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "whoami.exe");
    const groups = execFileSync(whoami, ["/groups", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_000,
    });
    return /S-1-16-(12288|16384)/.test(groups);
  } catch {
    return false;
  }
}

const program = new Command();
program.name("prosperod").description("Prospero local agent hub").version(DAEMON_VERSION);

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
  .option("--tmux", "会话跑在 tmux 里,daemon 重启后进程与画面都还在(需已装 tmux)", false)
  .option("--name <name>", "对外显示的主机名")
  .option("--home <path>", "daemon 状态目录（桌面端托管使用）")
  .option("--full-access", "标记为由 Windows 桌面端以管理员权限启动", false)
  .action(async (opts: { port?: number; bind?: string; dev: boolean; bonjour: boolean; tmux: boolean; name?: string; home?: string; fullAccess: boolean }) => {
    const home = opts.home ? path.resolve(opts.home) : prosperoHome();
    const fullAccess = opts.fullAccess && hasWindowsAdministratorToken();
    if (opts.fullAccess && !fullAccess) throw new Error("完整访问模式需要 Windows 管理员权限");
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
    let shutdownRequested = false;
    let shutdown = async (): Promise<void> => {};
    const server = await createDaemonServer({
      home,
      port,
      fullAccess,
      requestShutdown: () => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        void shutdown();
      },
      bindAddr,
      useTmux: opts.tmux,
      devMode: opts.dev,
      hostName: opts.name,
      notify: config.notify ?? null,
    });
    const stopAdvertise = opts.bonjour
      ? advertise(server.port, `Prospero @ ${opts.name ?? os.hostname()}`)
      : () => {};

    const devices = loadDevices(home);
    console.log(`prosperod v${DAEMON_VERSION} 已启动(home: ${home})`);
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
      console.log(`dev 明文口令: ${server.devToken}`);
      console.log("  ⚠︎ 该口令等同完整 shell 权限,每次启动都会更换,请勿外传");
    }
    if (server.restoredSessions > 0) {
      console.log(`已恢复 ${server.restoredSessions} 个上次保留的会话`);
    }
    if (opts.tmux) {
      console.log(
        server.manager.tmuxEnabled
          ? "会话托管: tmux(daemon 重启后会话进程存活)"
          : "会话托管: 已请求 tmux 但未找到 tmux,已退回直接 spawn(daemon 退出会杀掉会话)",
      );
    }
    console.log("对话持久化: 已启用(事件历史 + Agent 原生会话恢复)");
    console.log(
      server.notifier.enabled
        ? "推送: 已启用(App 未在线时,待审批会推到锁屏)"
        : "推送: 未配置(运行 `prosperod notify --url <bark/ntfy 地址>` 开启)",
    );

    shutdown = async (): Promise<void> => {
      console.log("\n[prosperod] 正在保存会话并退出…");
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
  .option("--no-orchestration", "该设备只能查看编排与处理 Gate，不能创建任务或派发 worker")
  .option("--dev", "只用于 ws://loopback relay 开发二维码", false)
  .action((opts: { name: string; shell: boolean; orchestration: boolean; dev: boolean }) => {
    const home = prosperoHome();
    const config = loadConfig(home);
    if (config.relay?.enabled) {
      const relayUrl = effectiveRelayUrl(config);
      if (!relayUrl || !config.relay.hostSecret) {
        console.error("relay 已启用但配置不完整；请先运行 prosperod relay enable --url <wss URL>。");
        process.exitCode = 1;
        return;
      }
      try {
        validateRelayUrl(relayUrl, { allowInsecureLoopback: opts.dev });
        deriveRelayRouteId(config.relay.hostSecret);
      } catch (error) {
        console.error(`无法生成 relay 配对二维码：${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
    }
    const device = mintDevice(home, {
      name: opts.name,
      allowShell: opts.shell,
      allowOrchestration: opts.shell && opts.orchestration,
    });
    // Direct pairing records intentionally have no relay credential.  When
    // relay is enabled we add it only to the QR about to be rendered, then
    // persist it afterwards; enabling relay later cannot promote an unseen
    // credential into an active one.
    const issuedDevice = config.relay?.enabled ? issueRelayCredentials(device) : device;
    const payload = buildPairingPayload(home, {
      token: issuedDevice.token,
      port: config.port,
      bind: config.bind,
      relay: relayPairingForDevice(config, issuedDevice) ?? undefined,
    });
    if (payload.addrs.length === 0 && !payload.relay) {
      console.error("警告:未发现可用网卡地址且 relay 未就绪,二维码不可用。");
    } else if (payload.addrs.length === 0 && payload.relay) {
      console.log("未发现可用网卡地址；将生成 relay-only 配对二维码。");
    }
    const url = encodePairingQR(payload, { allowInsecureLoopback: opts.dev });
    qrcode.generate(url, { small: true });
    if (payload.relay) persistRelayCredentials(home, issuedDevice);
    console.log(
      `设备「${device.name}」已登记(allowShell=${String(device.allowShell)}, ` +
      `allowOrchestration=${String(device.allowOrchestration ?? device.allowShell)})`,
    );
    console.log(`地址: ${payload.addrs.join(", ") || "(relay-only)"}  端口: ${payload.port}`);
    if (payload.relay) console.log(`中继: ${payload.relay.url}`);
    console.log(`配对串(扫码不便时手动输入):\n${url}`);
    console.log("注意:二维码含访问凭证,请勿截图外传。daemon 重启无需重新配对。");
  });

const relay = program
  .command("relay")
  .description("配置并查看公网 relay（relay token 与 hostSecret 永不打印）");

relay
  .command("enable")
  .description("启用 relay；无 --url 时使用已有 override 或 PROSPERO_DEFAULT_RELAY_URL")
  .option("--url <url>", "覆盖 relay 完整 WSS URL")
  .option("--dev", "仅允许 ws://localhost/loopback 开发 relay", false)
  .action((opts: { url?: string; dev: boolean }) => {
    const home = prosperoHome();
    const config = loadConfig(home);
    const url = opts.url ?? effectiveRelayUrl(config);
    if (!url) {
      console.error("无法启用 relay：未设置 --url，且 PROSPERO_DEFAULT_RELAY_URL 不存在。");
      process.exitCode = 1;
      return;
    }
    try {
      validateRelayUrl(url, { allowInsecureLoopback: opts.dev });
    } catch (error) {
      console.error(`无法启用 relay：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return;
    }
    const previous = config.relay;
    saveConfig(home, {
      ...config,
      relay: {
        enabled: true,
        ...(opts.url !== undefined ? { url: opts.url } : previous?.url ? { url: previous.url } : {}),
        hostSecret: previous?.hostSecret ?? generateRelayHostSecret(),
      },
    });
    console.log(`relay 已启用：${url}`);
    console.log("运行中的 daemon 会热加载此配置；新配对二维码会带 relay 凭证。");
  });

relay
  .command("disable")
  .description("停止 relay 注册连接；不删除 URL 或 hostSecret")
  .action(() => {
    const home = prosperoHome();
    const config = loadConfig(home);
    saveConfig(home, {
      ...config,
      relay: {
        enabled: false,
        ...(config.relay?.url ? { url: config.relay.url } : {}),
        ...(config.relay?.hostSecret ? { hostSecret: config.relay.hostSecret } : {}),
      },
    });
    console.log("relay 已关闭；运行中的 daemon 会断开 relay 连接。");
  });

relay
  .command("status")
  .description("查看 relay 配置及 daemon 运行时状态")
  .option("--json", "输出机器可读 JSON", false)
  .action((opts: { json: boolean }) => {
    const home = prosperoHome();
    const config = loadConfig(home);
    const devices = loadDevices(home);
    const url = effectiveRelayUrl(config) ?? null;
    let routeId: string | null = null;
    if (config.relay?.hostSecret) {
      try {
        routeId = deriveRelayRouteId(config.relay.hostSecret);
      } catch {
        // Keep status usable for hand-edited/corrupt config; runtime reports a
        // sanitized configuration error rather than exposing secret material.
      }
    }
    let runtime: Record<string, unknown> | undefined;
    try {
      const raw = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as { relay?: Record<string, unknown> };
      runtime = raw.relay;
    } catch {
      // daemon may not be running; config status is still useful.
    }
    const legacy = devices.filter((device) => deviceRelayCredentials(device) === null).length;
    const result = {
      enabled: config.relay?.enabled === true,
      url,
      routeId,
      state: runtime?.["state"] ?? (config.relay?.enabled ? "offline" : "disabled"),
      updatedAt: runtime?.["updatedAt"] ?? null,
      lastConnectedAt: runtime?.["lastConnectedAt"] ?? null,
      lastError: runtime?.["lastError"] ?? null,
      devices: runtime?.["devices"] ?? { total: devices.length, ready: 0, needsRePair: legacy },
      rePairRequired: legacy > 0,
    };
    if (opts.json) {
      console.log(JSON.stringify(result));
      return;
    }
    console.log(`relay: ${result.enabled ? result.state : "disabled"}`);
    console.log(`URL: ${result.url ?? "未配置"}`);
    console.log(`已就绪设备: ${(result.devices as { ready?: number }).ready ?? 0}`);
    if (result.rePairRequired) console.log(`提示: ${legacy} 台旧设备没有 relay 凭证，需重新配对；仍可直连。`);
    if (typeof result.lastError === "string") console.log(`最近错误: ${result.lastError}`);
  });

relay
  .command("rotate-key")
  .description("轮换 relay route key；所有设备需重新配对才能继续使用 relay")
  .option("-y, --yes", "跳过确认")
  .action((opts: { yes?: boolean }) => {
    const home = prosperoHome();
    const config = loadConfig(home);
    const devices = loadDevices(home);
    if (opts.yes !== true) {
      console.log("这会轮换 relay host key，并移除所有设备的 relay 凭证。");
      console.log("直连配对不会失效，但每台设备必须重新扫码才可继续经 relay 连接。");
      console.log("确认请加 --yes 重跑: prosperod relay rotate-key --yes");
      return;
    }
    rotateRelayKey(home, config);
    console.log(`已轮换 relay key；${devices.length} 台设备需要重新配对后才能使用 relay。`);
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
  .command("rotate-key")
  .description("更换 daemon 身份密钥(所有设备需重新配对)")
  .option("-y, --yes", "跳过确认")
  .action((opts: { yes?: boolean }) => {
    const home = prosperoHome();
    const devices = loadDevices(home);
    if (opts.yes !== true) {
      console.log("这会更换 daemon 的身份密钥,并清空已配对设备。");
      console.log(`当前已配对 ${String(devices.length)} 台,全部需要重新扫码。`);
      console.log("确认请加 --yes 重跑:prosperod rotate-key --yes");
      return;
    }
    const fresh = rotateIdentity(home);
    console.log(`已更换身份密钥,新公钥 ${fresh.publicKey.slice(0, 12)}…`);
    console.log(`已清空 ${String(devices.length)} 台设备的配对,请重新运行 prosperod pair。`);
    console.log("正在运行的 daemon 需要重启才会使用新密钥。");
  });

program
  .command("revoke")
  .argument("<name>", "要撤销的设备名(见 `prosperod status`)")
  .description("撤销设备:删除凭证,并立刻断开它当前的连接")
  .action((name: string) => {
    const home = prosperoHome();
    const removed = revokeDevices(home, name);
    if (removed.length === 0) {
      const names = loadDevices(home).map((d) => d.name);
      console.error(
        names.length === 0
          ? `没有名为「${name}」的设备(当前一台都没配对)`
          : `没有名为「${name}」的设备。已配对:${names.join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`已撤销 ${removed.length} 台名为「${name}」的设备`);
    console.log("运行中的 daemon 会立刻断开它;手机需要重新扫码才能再连。");
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
        `  - ${d.name}  allowShell=${String(d.allowShell)}  ` +
        `allowOrchestration=${String(d.allowOrchestration ?? d.allowShell)}  ` +
        `绑定=${d.clientPubKey ? "已绑定" : "未绑定"}  最近: ${seen}`,
      );
    }
  });

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
