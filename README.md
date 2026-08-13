# Prospero

> **在手机上，操控 Mac 上的所有 Coding Agent。**
>
> Control every coding agent on your Mac — from anywhere.

[![CI](https://github.com/linn0x/Prospero/actions/workflows/ci.yml/badge.svg)](https://github.com/linn0x/Prospero/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-22c55e)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20iOS%20%7C%20Android-0ea5e9)
![Local First](https://img.shields.io/badge/architecture-local--first-8b5cf6)

Prospero 把你的 iPhone 或 Android 手机变成 Mac 上**所有 Coding Agent 的遥控器**。Agent
继续在电脑上运行，完整使用已有仓库、工具链、账号与登录状态；你可以在手机上随时查看进度、
回复问题、处理审批、追加指令或直接接管任务。

无论是 Claude Code、Codex、OpenCode、Grok、Trae，还是任意 Agent CLI，都能进入同一个移动端
控制界面。Prospero 深度理解已适配 Agent 的消息与工具；面对其他 Agent，则用完整 PTY/TUI
保留终端能力。

> “Spirits, which by mine art I have from their confines called to enact my present fancies.”
>
> — Prospero, [*The Tempest*, Act IV, Scene I](https://www.folger.edu/explore/shakespeares-works/the-tempest/read/4/1/)

## 一部手机，掌控 Mac 上的所有 Agent

| | 产品能力 |
| --- | --- |
| 📱 | **所有 Agent，一个移动入口** — 从手机创建、恢复、切换和停止 Claude Code、Codex、OpenCode、Grok、Trae、Shell 及自定义 CLI 会话 |
| 👀 | **进度不再锁在电脑屏幕里** — 随时查看消息、推理、工具调用、diff、子 Agent 和实时终端输出 |
| ✅ | **关键时刻直接处理** — 在手机上回答 Agent 提问、批准或拒绝操作、追加指令、切换模型与模式，必要时立即停止任务 |
| ⌨️ | **结构化体验，终端能力不丢失** — 已适配 Agent 使用原生交互；任意 CLI 都能通过完整 PTY/TUI 操控 |
| 🗂️ | **连项目也能一起操作** — 浏览和编辑 Mac 上的文件，查看 Git 状态与 diff，完成 stage、commit 等常用操作 |
| 🔐 | **无需把开发环境搬上云** — Agent 和项目留在 Mac，通过 LAN 或 WireGuard 直连；断线后自动恢复会话状态与增量输出 |
| 🪄 | **从单个 Agent 到完整工作流** — 在手机上用 DAG 拆分任务、派发 worker、处理 Gate，并跟踪每个任务的显式交付状态 |
| 🌳 | **并行任务互不干扰** — `esaytree` 为 Agent 创建安全、快速、可回滚的 Git worktree，保护主工作区 |

## 不只是远程终端，也不是另一朵 Agent 云

| 常见妥协 | Prospero 的选择 |
| --- | --- |
| 为远程运行迁移仓库、凭据与工具链 | **Agent 留在 Mac**，完整复用 Keychain、MCP、证书、私有工具和现有登录状态 |
| 手机上只能看到一块终端屏幕 | **Agent-aware 移动交互**，审批、提问、工具、diff 和任务状态都能直接操作 |
| 每种 Agent 都需要不同的远控方案 | **一个 App 接入所有 Agent**，结构化适配与 PTY 兜底同时覆盖 |
| 离开电脑就失去上下文 | **手机与 Mac 状态一致**，从口袋里继续处理当前任务 |
| 多个 Agent 并行时相互覆盖 | **可视化编排 + 隔离 worktree**，让协作过程更安全、更可预测 |

## How to use

> 需要 macOS 14+、Node.js 22+，以及至少一个已登录的 Agent CLI。构建 iOS 客户端需要
> Xcode；Android 客户端需要 JDK 17 与 Android SDK。

### 1. 在 Mac 启动 Prospero

```bash
git clone https://github.com/linn0x/Prospero.git
cd Prospero
npm ci
npm run build -w @prospero/daemon
node apps/daemon/dist/cli.js start --name my-mac
```

### 2. 在手机运行客户端

```bash
# iPhone 真机
npm run ios -w @prospero/mobile -- --device

# Android 设备或模拟器
npm run android -w @prospero/mobile
```

### 3. 扫码配对并启动 Agent

保持 daemon 运行，在另一个终端生成配对二维码：

```bash
node apps/daemon/dist/cli.js pair --name my-phone
```

用 Prospero App 扫描二维码，选择 Mac 上的项目与 Agent，即可创建会话。同一局域网可直接连接；
离开局域网时，让手机与 Mac 加入同一个 WireGuard 或 Tailscale 私有网络。

> [!NOTE]
> **Prospero 正在寻找同行者。** 欢迎成为 Contributor：分享想法、改进体验、修复问题，
> 或和我们一起定义本地 Coding Agent 的未来。

## License

Prospero 采用 [MIT License](LICENSE) 开源。
