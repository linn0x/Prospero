# M1 实施计划(iOS MVP,约 2 周)

> 状态:执行中(始于 2026-08-04)。上游设计见 [architecture-exploration.md](architecture-exploration.md)。

## 1. 目标与验收

**M1 结束时**:iPhone 真机扫码配对 Mac → 会话列表 → 新建 claude / codex / opencode / grok / trae / **shell** 任意会话(全部终端形态)→ 终端秒开渲染、键盘工具条可操作 → WiFi↔WireGuard 切换与锁屏回前台均无感恢复。

| # | 验收指标 | 目标 | 测法 |
|---|---|---|---|
| A1 | 会话 attach 上屏(LAN) | <200ms | App 打点:发 attach → 快照渲染完成 |
| A2 | 断线重连恢复 | <500ms | 关 WiFi 再开 / 杀 WS |
| A3 | WiFi↔WG 切换自动恢复 | <2s,零手动操作 | 手机切蜂窝+WG / 回 WiFi |
| A4 | 洪峰输出渲染 | ≥30fps 不冻结 | Spike 基准(W4) |
| A5 | 锁屏→回前台恢复 | <500ms | 锁屏 1 分钟后回 App |
| A6 | 首次配对全流程 | <60s | 扫码到首个会话建立 |
| A7 | 打字回显(LAN) | 体感即时(<50ms) | shell 会话实测 |

不在 M1:结构化聊天 UI 与审批卡片(M2)、推送(M2)、Android(M3)、菜单栏壳(M3)、tmux 保活(M3)。

## 2. 仓库结构(npm workspaces)

```
Prospero/
  package.json              # workspaces: apps/*, packages/*
  tsconfig.base.json
  docs/
  packages/
    protocol/               # 共享:消息类型 + zod 校验 + E2E 加密 + QR 载荷
  apps/
    daemon/                 # prosperod(Node 22)
      src/
        pty-session.ts      # node-pty + @xterm/headless 镜像 + serialize + seq 环形缓冲
        session-manager.ts
        ws-server.ts        # 鉴权握手、合帧、背压
        pairing.ts          # QR 生成、token 存储(0600)、设备注册表
        discovery.ts        # bonjour-service + 网卡枚举
        agents.ts           # 各 agent 的 spawn 配置(命令/env/TERM)
        cli.ts              # prosperod start|pair|status
      dev-client.html       # 浏览器 xterm 调试页(先于 App 验证协议)
    mobile/                 # Expo App(W3 用 create-expo 生成)
```

## 3. 锁定技术栈(版本经 2026-08 调研核实)

| 层 | 选择 | 说明 |
|---|---|---|
| 运行时 | Node 22(本机 v22.16.0 ✓) | node-pty 在 Bun 不可用,不用 Bun |
| PTY | `node-pty` ^1.1.0 | 自带 darwin-arm64 prebuild |
| 终端状态 | `@xterm/headless` ^6.0 + `@xterm/addon-serialize` ^0.14 | 快照秒开的核心 |
| 传输 | `ws` + JSON envelope | 二进制帧优化留到需要时 |
| 发现 | `bonjour-service` ^1.4 | `_prospero._tcp` |
| E2E | `tweetnacl`(Happy 同款,RN 已验证) | X25519 配对 + secretbox 会话加密 |
| 校验 | `zod` | 协议消息运行时校验 |
| App | Expo(最新稳定 SDK)+ `expo-dev-client` | 需自定义 Info.plist,Expo Go 不够用 |
| App 终端 | `react-native-webview` + xterm.js(WebGL renderer) | 不达标则切 SwiftTerm native module |
| App 扫码 | `expo-camera` | |
| 测试 | `vitest`(protocol/daemon) | |

## 4. 任务分解(对应任务清单 #1–#6)

### W0 仓库基建(#1,0.5 天)
monorepo + TS 配置 + protocol/daemon 骨架。DoD:`npm install`、`tsc --noEmit` 通过。

### W1 protocol 包(#2,1 天)
- 消息类型 + zod schema:envelope `{type, sid?, seq?, payload}`;C2S `hello / session.create / session.attach / term.input / term.resize / permission.respond / session.interrupt / session.kill`;S2C `hello.ok / session.state / term.snapshot / term.output / permission.request / turn.end / error`(结构化轨消息 M2 再扩展,类型名先占位)
- seq 语义:S→C 每会话单调递增;attach 携带 `lastSeq`,gap 可补则增量、不可补则全量快照
- E2E:配对 = QR 中的 daemon X25519 公钥 + token;App 生成密钥对,`hello` 里带公钥;`nacl.box` 派生会话密钥,之后全消息 secretbox + nonce 计数
- QR 载荷:`prospero://pair?d=<base64({v,name,addrs[],port,token,pubKey})>`
- DoD:vitest 覆盖编解码/加解密往返/seq 补发逻辑

### W2 daemon(#3,3–4 天)
- `PtySession`:spawn(env `TERM=xterm-256color`)→ 输出同时喂 headless xterm(镜像)与订阅者;**应答 DSR `ESC[6n`**(Claude Code Ink 必需);输出合帧 flush(约 16–33ms);环形缓冲(默认 1MB/会话)支持 seq 续传;`serialize()` 出快照(scrollback 上限 2000 行)
- `agents.ts`:`shell`(`$SHELL -il`)/ `claude` / `codex` / `opencode` / `grok` / `trae` 的启动命令与工作目录约定;M1 全部走 PTY 轨
- WS 服务:握手(token + E2E)→ 路由;背压:客户端 ack 窗口,超限暂停 PTY 读
- 配对:`prosperod pair` 终端打印 QR(`qrcode-terminal`);设备注册表 `~/.prospero/devices.json`(0600,含 `allowShell`)
- 发现:枚举 en0/utun* 全部地址(QR 载荷用)+ Bonjour 广播
- DoD:`dev-client.html` 在浏览器里开 shell + claude 会话,输入/滚动/resize 正常;kill -9 客户端网络后重连 seq 续传正确
- 已知点:daemon 在终端里手动跑(继承终端 TCC 权限),不装 LaunchAgent(M3 再由菜单栏壳接管)

### W3 mobile(#4,3–4 天,后段与 W2 收尾并行)
- `create-expo` 生成 + expo-dev-client;Info.plist:`NSLocalNetworkUsageDescription` + `NSBonjourServices: [_prospero._tcp]` + 相机权限
- 配对流程:扫码 → 存主机(地址簿)→ 本地网络权限引导页(主动预触发弹窗,检测静默失败给引导)
- `ConnectionManager`:候选地址并发竞速(首个完成 E2E 握手者胜)、指数退避、AppState 回前台立即重连
- 会话列表:状态徽标(running / idle / died),下拉新建(选 agent 类型 + cwd)
- 终端视图:WebView 内 xterm.js + WebGL renderer;快照 `write()` 上屏、增量流写入、`postMessage` 桥输入;字号/resize 适配;虚拟键盘工具条(Esc/Tab/Ctrl-C/↑↓/`/`)
- 运行方式:`npx expo run:ios --device`(本地构建,免 EAS)
- DoD:真机完成 A1/A2/A5/A6/A7 初测

### W4 Spike:WKWebView 终端性能(#5,0.5–1 天,第一周内)
- 场景:`find /` 洪峰、claude 全速跑任务、1 万行 scrollback 滚动
- 记录:fps、输入延迟、attach 耗时 → `docs/spike-webview-terminal.md`
- 不达标(<30fps)→ 决策记录,W3 终端视图切 SwiftTerm(MIT)Expo native module 方案

### W5 联调验收(#6,1–2 天)
- 全链路 + WiFi↔WG 切换实测(需要 WG 测试环境,见 §6)
- 验收表 A1–A7 逐项记录数据,附本文档末尾

## 5. 两周日程

| 日 | 内容 |
|---|---|
| D1 | W0 基建 + W1 协议类型/加密 |
| D2–D3 | W2:PtySession + WS 服务,dev-client.html 跑通 shell 会话 |
| D4 | W3:Expo 初始化 + 连接层,真机首连 |
| D5 | W4 Spike 基准 + 渲染路线定案;W2 配对/QR |
| D6–D8 | W3:配对流程/权限引导/会话列表/键盘工具条/终端打磨 |
| D9 | W2 收尾:重连续传/竞速/背压打磨 |
| D10 | W5 联调验收,缺陷清偿,M1 收口 |

## 6. 需要用户侧准备的事项(不阻塞开工)

1. **iPhone 真机 + Xcode**(D4 起需要;免费 Apple ID 可跑 `expo run:ios --device`,7 天重签)
2. **$99 Apple Developer 账号**(建议,TestFlight 日常自用;不买则接受 7 天重签)
3. **WireGuard 测试环境**(D9–D10 用:Mac 与手机各一端,验证 A3;仅验 LAN 也可先收口)
4. Mac 上已装好各 agent CLI(claude/codex/opencode/grok/trae,缺哪个就先跳过哪个)

## 7. 风险与预案(M1 范围)

| 风险 | 预案 |
|---|---|
| WKWebView xterm 性能不达标 | W4 第一周就验;切 SwiftTerm native module(接口已按可替换设计:终端视图组件只吃 snapshot/delta/input 三个口) |
| node-pty prebuild 在本机异常 | 退 `@replit/ruspty`;接口封装在 PtySession 内 |
| tweetnacl 纯 JS 性能 | KB 级消息微秒~毫秒级,超标则换 react-native-libsodium(JSI) |
| npm 源/公司网络问题 | 切换 registry 镜像重试 |
| Claude Code 在 PTY 下渲染异常(DSR/粘贴) | 已知坑清单在探索文档 §3,逐项处理;>1KB 粘贴分片 |

## 8. 验收记录

### 模拟器验收(2026-08-04,iOS 26.5 模拟器 / iPhone 17 Pro)

全链路跑通:**配对 → 连接(E2E 握手)→ 建会话 → 终端渲染 → 洪峰输出 → 断线自动重连**。

| # | 指标 | 模拟器结果 | 说明 |
|---|---|---|---|
| A1 | attach 上屏 | ✅ 主观秒开 | 精确打点待真机 |
| A2 | 断线重连 | ✅ 自动恢复 | kill daemon → 重启,App 无需人工干预自动重连 |
| A3 | WiFi↔WG 切换 | ⏳ 待真机 | 模拟器与 Mac 同栈,无法验证 |
| A4 | 洪峰渲染 | ✅ **58fps @150KB/s** | 验收线 30fps,约 2 倍余量([spike 报告](spike-webview-terminal.md)) |
| A5 | 锁屏→回前台 | ⚠️ 部分 | 后台/前台切换画面完整保留;模拟器不严格挂起 socket,真实挂起待真机 |
| A6 | 配对流程 | ✅ | 深链 `prospero://pair?d=…` 解析入库、主机卡片显示全部网卡地址 |
| A7 | 打字回显 | ⏳ 待真机 | 无键盘自动化;协议侧已由 daemon 集成测试覆盖 |

其他已验证:8000 行洪峰完整无丢行;会话列表状态徽标(运行中/已完成/已退出)正确;custom / shell / codex 会话均可创建;WebGL renderer 生效未回退。

**过程中修掉的缺陷**:WebView 从 daemon HTTP 加载终端页 → daemon 不可用时永久白屏。已改为内联进 App(详见 spike 报告)。

### 已知待办(不阻塞 M1)

- 断线时会话列表仍显示上次状态(如"运行中"),应加降级视觉提示
- 深链重复进入 host 页会堆叠导航栈(自动化测试路径专有,真机用户不触发)
- 多地址竞速失败时,错误消息只报了其中一个地址

### 真机验收(W5,待做)

_待填:A1/A3/A5/A7 精确数据、软键盘 resize 与 IME、WireGuard 切换。_

## 9. M2 进展(2026-08-04)

M2 主体已完成并在模拟器验证:

| 项 | 状态 |
|---|---|
| 协议结构化轨(agent.event / chat.snapshot / 审批) | ✅ |
| opencode 适配器(HTTP + SSE) | ✅ 实测一轮对话 3.5s |
| Claude Code 适配器(Agent SDK + canUseTool) | ✅ 审批链路含拒绝/允许双向验证 |
| Chat UI(气泡/推理折叠/工具卡片/审批卡片/用量) | ✅ 模拟器截图验证 |
| 测试 | 47 个全绿(protocol 30 / daemon 12 / mobile 11 中的对应部分) |

**剩余**:Codex app-server 适配器、Grok headless 适配器、Bark 推送通道、
`--resume` 会话恢复、真机验收。
