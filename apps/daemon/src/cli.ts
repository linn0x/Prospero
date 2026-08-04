#!/usr/bin/env node
/**
 * prosperod — Prospero macOS 宿主 daemon。
 * W2 实现:start(WS 服务)/ pair(打印 QR)/ status。
 * M1 期间在终端里手动运行(继承终端的 TCC 权限),不装 LaunchAgent。
 */
import { PROTOCOL_VERSION } from "@prospero/protocol";

const cmd = process.argv[2] ?? "start";

switch (cmd) {
  case "start":
  case "pair":
  case "status":
    console.log(
      `prosperod v0.0.1 (protocol v${PROTOCOL_VERSION}) — "${cmd}" 尚未实现,见 docs/m1-plan.md W2`,
    );
    break;
  default:
    console.error(`未知命令: ${cmd}(可用:start | pair | status)`);
    process.exit(1);
}
