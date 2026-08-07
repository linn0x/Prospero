# Prospero

用手机(**iOS 优先**,Android 随后)丝滑远控 macOS 上的 code agent(OpenCode / Claude Code / Codex / Grok / Trae 及任意 CLI),并内置远程 Shell(免 sshd 的 SSH 平替)。局域网 / WireGuard 直连,零云中转,端到端加密。

> "…my so potent art." — 像 Prospero 差遣 Ariel 一样,从掌心差遣你的 agents。

- 架构探索与技术选型:[docs/architecture-exploration.md](docs/architecture-exploration.md)
- M1 实施计划(执行中):[docs/m1-plan.md](docs/m1-plan.md)
- M3 计划:[Android 端](docs/android-plan.md) · [语音输入](docs/voice-input-plan.md)

## 快速开始(M1)

```bash
npm install && npm run typecheck        # 构建 protocol/daemon

# Mac 侧
node apps/daemon/dist/cli.js start      # 启动 daemon(加 --dev 可用浏览器调试页)
node apps/daemon/dist/cli.js pair       # 生成手机配对二维码

# iPhone 侧(需 Xcode + 真机)
cd apps/mobile && npx expo run:ios --device
# App 内「扫码配对」→ 允许本地网络权限 → 新建会话
```

## 规划形态

- **prosperod** — macOS 常驻 daemon(Node 22 / TypeScript):PTY 通用轨 + 各 agent 结构化适配(Agent SDK / opencode serve / codex app-server),WebSocket 统一协议,mDNS + QR 配对
- **app** — React Native (Expo) 客户端(iOS 先行,Android 同库跟进):会话列表 / 聊天与审批卡片 / 终端视图(agent 会话与 shell 会话通用),多地址并发竞速重连
- **shell**(后期)— SwiftUI 菜单栏壳:TCC 权限归属、Bonjour、开机自启
