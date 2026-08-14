/**
 * 连接失败分类。
 *
 * "连接失败"这四个字对用户毫无用处 —— 是权限没给、电脑没开机、还是配对失效,
 * 处理方式完全不同。这里把每个候选地址的失败原因归类,合成一条可执行的提示。
 */

export type AttemptFailure =
  /** WebSocket 立刻报错:多半是本地网络权限被拒或路由不通 */
  | "unreachable"
  /** 连上了 TCP 但握手期间被关闭:daemon 版本不匹配或协议错 */
  | "handshake"
  /** 超时:地址存在但没人应答(电脑睡眠 / daemon 未运行 / 防火墙丢包) */
  | "timeout"
  /** 鉴权失败:token 失效或设备密钥变化 */
  | "auth"
  /** 协议版本不符:App 与 daemon 有一端旧了 */
  | "version"
  /** 这台设备已在电脑端被移除 */
  | "revoked"
  /** 对面证明不了自己是配对时那台电脑(换了密钥,或有中间人) */
  | "untrusted";

export interface AttemptResult {
  addr: string;
  failure: AttemptFailure;
  detail?: string;
}

export interface Diagnosis {
  /** 一句话结论 */
  summary: string;
  /** 用户下一步能做的事 */
  hint: string;
  /** 重试无意义(需人工处理)时为 true */
  fatal: boolean;
}

export type ClientPlatform = "ios" | "android";

export function diagnose(
  results: AttemptResult[],
  isFirstEver: boolean,
  platform: ClientPlatform = "ios",
): Diagnosis {
  if (results.length === 0) {
    return {
      summary: "没有可用地址",
      hint: "请在这台主机的连接设置里添加电脑地址；token 与设备密钥仍会保留，无需重新扫码。",
      fatal: true,
    };
  }

  // 以下几类对所有候选地址都成立,重试没有意义 —— 早于"哪个地址通"的判断。

  // 安全性最高优先:证明失败意味着对面不是配对时那台电脑,不该被淹没在网络问题里
  if (results.some((r) => r.failure === "untrusted")) {
    return {
      summary: "无法确认这台电脑的身份",
      hint:
        "对方没能证明自己持有配对时记录的密钥。可能是电脑上的 prosperod 重置过身份(~/.prospero/identity.json 被删)," +
        "也可能有人在中间冒充。确认无误后重新扫码配对;若你没做过重置,先别连。",
      fatal: true,
    };
  }

  if (results.some((r) => r.failure === "revoked")) {
    return {
      summary: "此设备已被移除",
      hint: "你在电脑端撤销了这台设备。要恢复使用,请运行 prosperod pair 重新扫码配对。",
      fatal: true,
    };
  }

  if (results.some((r) => r.failure === "version")) {
    return {
      summary: "App 与 daemon 无共同协议版本",
      hint:
        "请升级较旧的一端。现有配对凭据会保留，不要重新扫码；升级完成后直接重试连接。" +
        `移动端构建脚本:apps/mobile/scripts/${platform === "android" ? "build-apk.sh" : "build-ipa.sh"}。`,
      fatal: true,
    };
  }

  if (results.some((r) => r.failure === "auth")) {
    return {
      summary: "配对已失效",
      hint: "token 无效或此设备的密钥已变化。请在电脑上运行 prosperod pair 重新扫码。",
      fatal: true,
    };
  }

  const kinds = new Set(results.map((r) => r.failure));

  if (kinds.size === 1 && kinds.has("unreachable")) {
    return {
      summary: "无法连接到任何地址",
      hint: isFirstEver
        ? platform === "ios"
          ? "首次连接通常是「本地网络」权限被拒。请到 设置 › Prospero › 本地网络 打开开关,再重试。"
          : "Android 不需要单独的本地网络运行时权限。请确认手机与电脑在同一网络(或 WireGuard 已连接)；地址变化可在主机连接设置里修改，无需重新扫码。"
        : "请确认手机与电脑在同一网络(或 WireGuard 已连接),且电脑未休眠。",
      fatal: false,
    };
  }

  if (kinds.has("timeout")) {
    return {
      summary: "地址可达但无应答",
      hint: "电脑在线但 prosperod 没有响应。请确认它正在运行(node apps/daemon/dist/cli.js start),或检查防火墙。",
      fatal: false,
    };
  }

  if (kinds.has("handshake")) {
    const detail = results.find((r) => r.failure === "handshake")?.detail;
    return {
      summary: "握手失败",
      hint:
        detail === "version"
          ? "App 与 daemon 的协议版本不一致,请更新其中较旧的一端。"
          : "连接被 daemon 拒绝。查看电脑上 prosperod 的日志了解原因。",
      fatal: false,
    };
  }

  return {
    summary: "连接失败",
    hint: "稍后会自动重试。若持续失败,请检查网络与 prosperod 状态。",
    fatal: false,
  };
}
