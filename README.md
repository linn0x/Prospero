# Prospero

用手机(**iOS 优先**,Android 随后)丝滑远控 macOS 上的 code agent(opencode / Claude Code / Codex / Grok / Trae 及任意 CLI),并内置远程 Shell(免 sshd 的 SSH 平替)。局域网 / WireGuard 直连,零云中转,端到端加密。

> "…my so potent art." — 像 Prospero 差遣 Ariel 一样,从掌心差遣你的 agents。

- 架构探索与技术选型:[docs/architecture-exploration.md](docs/architecture-exploration.md)
- M1 实施计划(执行中):[docs/m1-plan.md](docs/m1-plan.md)

## 规划形态

- **prosperod** — macOS 常驻 daemon(Node 22 / TypeScript):PTY 通用轨 + 各 agent 结构化适配(Agent SDK / opencode serve / codex app-server),WebSocket 统一协议,mDNS + QR 配对
- **app** — React Native (Expo) 客户端(iOS 先行,Android 同库跟进):会话列表 / 聊天与审批卡片 / 终端视图(agent 会话与 shell 会话通用),多地址并发竞速重连
- **shell**(后期)— SwiftUI 菜单栏壳:TCC 权限归属、Bonjour、开机自启
