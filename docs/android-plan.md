# Android 端计划(M3)

> 状态:未开工。上游决策见 [architecture-exploration.md](architecture-exploration.md) §7「iOS 优先的落地含义」——
> 选 RN/Expo 的理由之一就是 Android 能同库跟进,这份文档把"跟进"落到具体条目。

## 1. 目标与非目标

**目标**:同一份 `apps/mobile` 代码,在 Android 上达到与 iOS 对等的可用性 ——
配对、会话列表、聊天与审批、终端、文件面板全部可用,推送走 ntfy。

**非目标**:
- 不为 Android 重做交互。差异只在平台约束逼迫时才引入(返回键、通知渠道、权限时机)。
- 不追求低端机的终端洪峰性能。见 §5 风险,必要时降级而非重写。
- 不上架 Google Play。个人自用直接装 APK,和 iOS 侧的 ad-hoc 签名对等。

## 2. 现状盘点(2026-08-04,基于实际代码)

daemon 侧**基本无需改动**——协议、加密、会话、文件操作都与平台无关,
`notify.ts` 也已经同时支持 Bark 与 ntfy(字段取并集,各自忽略不认识的)。
`hello` 的 `clientInfo.platform` 已含 `"android"`,`connection.ts` 也已按 `Platform.OS` 填。

App 侧真正的阻塞项只有一条,其余是打磨:

| 项 | 状态 | 说明 |
|---|---|---|
| `Alert.prompt` | 🔴 **阻塞** | RN 的 `Alert.prompt` 是 **iOS 专属**。文件面板的「重命名」「新建文件夹」两处在用(`files/[sid].tsx:196,230`),Android 上点了**没有任何反应**。必须换成自绘输入弹窗。 |
| `expo-symbols` | 🟢 已就绪 | `Icon.tsx` 已按 `Platform.OS === "ios"` 分支,非 iOS 回落到 `FALLBACK` 表里的字符。 |
| `expo-glass-effect` | 🟡 清理 | 在 `package.json` 里但**全代码未引用**,且 iOS 专属。直接移除依赖。 |
| ntfy 推送 | 🟢 daemon 已就绪 | `prosperod notify --url https://ntfy.sh/<topic>` 即可。App 侧需要接收端(见 §3.4)。 |
| mDNS 发现 | 🟡 待验 | `discovery.ts` 用 zeroconf,Android 需 `CHANGE_WIFI_MULTICAST_STATE` 且部分 ROM 会静默失败。发现本就是"锦上添花"(WG 场景永远发现不到),降级路径已有。 |
| 键盘避让 | 🟡 待调 | `KeyboardAvoidingView` 的 `behavior` 已按 iOS 条件化(`undefined` on Android),需真机验证软键盘不遮输入框。 |
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
- Android 13+ 的 `POST_NOTIFICATIONS` 运行时权限。
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
| 后台被系统杀 | 中。国产 ROM 的省电策略激进。 | WS 断了靠 ntfy 唤起,与 iOS 同构;文档里明示需要给 Prospero 加白名单。 |
| 中文 IME 在终端里行为异常 | 中。WebView 里的 IME 组合输入容易丢字。 | A5 专项验;必要时终端输入走原生 `TextInput` 隐藏层再转发。 |

## 6. 需要用户侧准备

1. 一台 Android 真机(优先中端机,别用旗舰 —— 旗舰测不出 A4 的真实风险)
2. 自建或公用 ntfy 服务(`ntfy.sh` 公用 topic 即可先跑通)
3. Android SDK / platform-tools(`adb`)

## 7. 工作量估计

**4–5 天**,其中 A4 的结论可能让 A5 翻倍。建议顺序:A1 → **A4** → A2 → A3 → A5,
把最大的不确定性放在最前面。
