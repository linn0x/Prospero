# Android 端计划(M3)

> 状态:**代码实现、release 构建与 API 35 模拟器回归已完成(2026-08-04)**。上游决策见 [architecture-exploration.md](architecture-exploration.md) §7「iOS 优先的落地含义」。
> 中端真机、真实 WiFi↔WG、中文 IME 与外部 ntfy 通知栏属于设备/服务验收，结果栏明确保留为待验，不以模拟器冒充完成。

## 1. 目标与非目标

**目标**:同一份 `apps/mobile` 代码,在 Android 上达到与 iOS 对等的可用性 ——
配对、会话列表、聊天与审批、终端、文件面板全部可用,推送走 ntfy。

**非目标**:
- 不为 Android 重做交互。差异只在平台约束逼迫时才引入(返回键、通知渠道、权限时机)。
- 不追求低端机的终端洪峰性能。见 §5 风险,必要时降级而非重写。
- 不上架 Google Play。个人自用直接装 APK,和 iOS 侧的 ad-hoc 签名对等。

## 2. 开工前盘点(2026-08-04,基于实际代码)

daemon 侧**基本无需改动**——协议、加密、会话、文件操作都与平台无关,
`notify.ts` 也已经同时支持 Bark 与 ntfy(字段取并集,各自忽略不认识的)。
`hello` 的 `clientInfo.platform` 已含 `"android"`,`connection.ts` 也已按 `Platform.OS` 填。

App 侧真正的阻塞项只有一条,其余是打磨:

| 项 | 状态 | 说明 |
|---|---|---|
| `Alert.prompt` | 🟢 已修复 | 已换成受控 `PromptDialog`，Android 模拟器实测新建目录、重命名与校验均可用。 |
| `expo-symbols` | 🟢 已就绪 | `Icon.tsx` 已按 `Platform.OS === "ios"` 分支,非 iOS 回落到 `FALLBACK` 表里的字符。 |
| `expo-glass-effect` | 🟢 已清理 | 未引用的 iOS 专属依赖已移除。 |
| ntfy 推送 | 🟢 代码已就绪 | daemon 会把 `click/url` 指到具体主机与会话；release 冷启动深链已验证，外部 ntfy 通知栏待真机验收。 |
| mDNS 发现 | 🟢 已适配 | Manifest 含组播/网络权限，zeroconf 原生层持有组播锁；8 秒无结果会明确回退到扫码，不再静默。真机 ROM 兼容性待验。 |
| 键盘避让 | 🟢 已修复 | Android 15 edge-to-edge 下单靠 `adjustResize` 仍会遮挡，已为会话、配对、文件编辑显式启用高度避让并在模拟器复测。 |
| 手势/触感/文件传输 | 🟢 跨平台 | gesture-handler、haptics、file-system、sharing、document-picker 均双平台。 |

## 3. 任务分解

### A1 打通构建(0.5 天)
- `npx expo prebuild -p android`;`app.json` 里 `android.package` 与 adaptiveIcon 已配好。
- 生成 debug keystore,写 `scripts/build-apk.sh` —— 对标 `build-ipa.sh`:
  一条命令从源码到装进设备,签名参数不硬编码在脚本里。
- **DoD**:真机装上能启动到主机列表页。

### A2 修平台断裂(1 天)
- **`Alert.prompt` 替换**:做一个 `PromptDialog` 组件(受控 Modal + TextInput),
  双平台统一走它。顺带解决 iOS 上 `Alert.prompt` 无法定制校验的问题。
- 移除 `expo-glass-effect`。
- 返回键:Android 硬件返回在文件编辑态应触发"放弃修改"确认,而不是直接退出。
  当前 `headerLeft` 的守卫只拦头部按钮,拦不住硬件键 —— 需 `useNavigation` 的 `beforeRemove`。
- **DoD**:文件面板全部操作在 Android 可用;编辑未保存时按返回键有确认。

### A3 权限与通知(1 天)
- Android 13+ 的 `POST_NOTIFICATIONS` 由实际显示通知的 **ntfy App** 请求；Prospero 自身通过 `blockedPermissions` 明确不声明它。
- ntfy 接收:装 ntfy 官方 App(F-Droid 版可纯 LAN 直连自建服务器)接推送,
  点击深链回 Prospero —— 与 iOS 的 Bark 路径同构,**Prospero 自身不需要推送权限**。
- 本地网络:Android 无 iOS 那套 TCC 弹窗,但 mDNS 需组播锁。
- **DoD**:App 挂后台时,Mac 侧待审批能推到手机通知栏,点击可回到对应会话。

### A4 终端性能实测(0.5 天,前置到最早)
- 跑与 iOS 相同的 spike 场景:`find /` 洪峰、1 万行 scrollback 滚动。
- 记录 fps 与输入延迟,写进 [spike-webview-terminal.md](spike-webview-terminal.md)。
- **这一项要最先做**,因为结论会决定 A5 的排期(见 §5)。

### A5 打磨与验收(1–2 天)
- 状态栏/导航栏配色、深色主题、safe area。
- 长列表滚动、软键盘 resize、IME(中文输入法在 `TextInput` 与终端里的行为)。
- 按 §4 的表逐项记录。

## 4. 验收标准

沿用 M1 的 A1–A7,数值目标不变(打点已在 `connection.ts` 里,
`lastAttachMs` / `lastResumeMs` 会显示在会话页头部):

| # | 指标 | 目标 | Android 特有注意 |
|---|---|---|---|
| A1 | attach 上屏 | <200ms | 与 iOS 同 |
| A2 | 断线重连 | <500ms | 与 iOS 同 |
| A3 | WiFi↔WG 切换 | <2s | Android 的 VPN API 行为与 iOS 不同,需单独验 |
| A4 | 洪峰渲染 | ≥30fps | **最大风险项**,见 §5 |
| A5 | 后台→前台恢复 | <500ms | Android 后台限制比 iOS 宽松,预期更好 |
| A6 | 首次配对 | <60s | 含 ntfy 配置的话会更长,分开计时 |
| A7 | 打字回显 | <50ms | 需覆盖中文 IME |

额外一条:**A8 返回键行为**——每一屏按返回都符合预期,不会跳过未保存确认,
不会退出到空白页。

## 5. 风险与预案

| 风险 | 判断 | 预案 |
|---|---|---|
| **低端 Android WebView 终端卡顿** | 这是当初 iOS 优先的主因,风险从未消失,只是被推迟了。Android WebView 的 WebGL 支持与 GPU 差异远大于 iOS。 | A4 先测。不达标时:①关掉 WebGL renderer 退回 canvas;②降低 scrollback 上限;③最后才考虑原生终端组件。**不引入 Termux TerminalView(GPLv3 传染)**。 |
| ROM 碎片化导致 mDNS 失效 | 中。国内 ROM 常限制组播。 | 发现本就是可降级功能,QR 地址簿是主路径。检测不到时明确提示而非静默。 |
| 后台被系统杀 | 中。国产 ROM 的省电策略激进。 | WS 断了靠 ntfy 唤起,与 iOS 同构;即时通知优先给 ntfy 加后台/省电白名单，需保持前台 WS 时再给 Prospero 放行。 |
| 中文 IME 在终端里行为异常 | 中。WebView 里的 IME 组合输入容易丢字。 | A5 专项验;必要时终端输入走原生 `TextInput` 隐藏层再转发。 |

## 6. 需要用户侧准备

1. 一台 Android 真机(优先中端机,别用旗舰 —— 旗舰测不出 A4 的真实风险)
2. 自建或公用 ntfy 服务(`ntfy.sh` 公用 topic 即可先跑通)
3. Android SDK / platform-tools(`adb`)

## 7. 工作量估计

**4–5 天**,其中 A4 的结论可能让 A5 翻倍。建议顺序:A1 → **A4** → A2 → A3 → A5,
把最大的不确定性放在最前面。

## 8. 实施与验收记录(2026-08-04)

### 8.1 仓库内任务

- [x] Expo SDK 57 CNG `prebuild --clean`，SDK 36 / Build Tools 36，API 24–36 release APK。
- [x] `scripts/build-apk.sh`：自动补齐 SDK、构建 protocol、生成原生工程、离线 release、v2 签名校验、可选 adb 安装与启动；签名凭据不写进脚本。
- [x] `Alert.prompt` 全部替换为跨平台受控 `PromptDialog`，补文件名纯函数与测试；移除 `expo-glass-effect`。
- [x] 文件编辑态使用 Expo Router 同一导航上下文的 `beforeRemove`，覆盖 Android 硬件返回/系统导航；未保存内容必须确认。
- [x] Manifest 加入 mDNS 所需网络/组播权限、`usesCleartextTraffic`(只承载应用层 E2E 加密的局域网 `ws://`)、暗色主题、`adjustResize`、禁备份；明确移除 `POST_NOTIFICATIONS`。
- [x] ntfy payload 同时写 `click` / `url`，默认深链到 `prospero://host/<hostId>/session/<sid>`；用户显式配置的全局 deep link 仍可覆盖。
- [x] 冷启动深链补根路由，返回不会退出到空白页；Android 首次连接诊断不再误导到 iOS「本地网络」设置。
- [x] mDNS 扫描 8 秒停止并显示扫码降级说明；状态栏、导航栏、safe area、Android monospace 与 WebView hardware layer 已适配。
- [x] 会话、配对、文件编辑在 Android edge-to-edge 下显式避让 IME；侧载与 ntfy 步骤见 [`apps/mobile/README.md`](../apps/mobile/README.md)。

### 8.2 已执行的 release / 模拟器回归

环境：Android 15(API 35) Pixel 8 arm64 AVD，release APK，Mac daemon 经 `adb reverse` 连接。

| 项 | 结果 |
|---|---|
| CNG → Gradle release → 签名 → 安装 → 启动 | 通过；APK 约 121 MiB，package `com.linn0x.prospero`，v2 debug 侧载签名 |
| 最终 Manifest | `minSdk=24`、`targetSdk=36`、`adjustResize`、`usesCleartextTraffic=true`、mDNS 四项网络权限、`prospero://`；无 `POST_NOTIFICATIONS` |
| 配对/连接 | 配对深链、加密握手、主机/会话列表通过；回环 RTT 19–90ms |
| A1 / A5 打点 | attach 27ms；恢复 34–63ms(均为 AVD 回环基线) |
| A4 洪峰 | 10,000 行完整收尾，webgl 45fps；`find /` 洪峰 webgl 62fps / 88KB/s，无冻结，详见 [spike](spike-webview-terminal.md) |
| ntfy 点击目标 | 无进程冷启动会话深链成功(`LaunchState: COLD`)，直接恢复对应终端；返回落到主机列表 |
| A2 / A8 文件与返回 | 新建目录、重命名、编辑均通过；硬件返回显示「放弃修改」，取消保留编辑、确认后内容未落盘 |
| A5 UI / IME resize | 深色系统栏和底部 safe area 正常；终端输入栏及文件编辑器均移到软键盘上方 |
| 工程检查 | `expo-doctor` 20/20、Expo 依赖检查、TypeScript、mobile 38/38、protocol 29/29、daemon 通知+加密链路 15/15、APK 签名/manifest 通过 |

模拟器由宿主 CPU/GPU 驱动，本轮还因内存压力使用了 software GL；上表的 fps 只能算 Android 路径回归，不能作为真机性能结论。

完整 `npm test` 另跑了在线第三方 agent 集成；除跳过项外仅 1 项失败。失败项是既有 Claude 在线用例「允许后工具真正执行」——文件与 `tool.end(success)` 已到达，但 Claude CLI 两次都在 132–133 秒内没有发 `turn.end`；Android、通知、协议与 daemon 链路的定向测试均通过，本计划没有改动该适配器。

### 8.3 仍需外部条件的最终验收

- [ ] 中端 Android 真机安装并启动 APK(A1 DoD)，再跑 10,000 行与 `find /`，确认真实 WebView/GPU ≥30fps。
- [ ] 真机 WiFi↔WireGuard 切换(A3)、断线重连(A2)和真实后台冻结/恢复(A5)计时。
- [ ] Gboard/厂商中文输入法在聊天 `TextInput` 与终端中的组合输入、候选、回车行为(A7)。
- [ ] 真机 ntfy App 授予通知权限并订阅 topic；Prospero 在后台/被杀时触发待审批，通知栏到达且点击进入对应会话(A3 DoD)。
- [ ] 至少一台会限制组播或后台的目标 ROM 验证 mDNS 成功/8 秒扫码降级和省电白名单说明。
