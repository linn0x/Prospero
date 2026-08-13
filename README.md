# Prospero

> **让 Agent 留在你的 Mac，让控制权跟你走。**
>
> Run locally. Supervise anywhere. Orchestrate everything.

[![CI](https://github.com/linn0x/Prospero/actions/workflows/ci.yml/badge.svg)](https://github.com/linn0x/Prospero/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-22c55e)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20iOS%20%7C%20Android-0ea5e9)
![Local First](https://img.shields.io/badge/architecture-local--first-8b5cf6)

Prospero 是面向 Coding Agent 的本地优先控制中枢。Claude Code、Codex、OpenCode 等 Agent
继续运行在你的 Mac 上，直接使用已有仓库、工具链、账号与登录状态；你可以从 macOS、iOS
或 Android 查看进度、处理审批，并编排多个 Agent 完成复杂任务。

## 为什么叫 Prospero？

> “Spirits, which by mine art I have from their confines called to enact my present fancies.”
>
> — Prospero, [*The Tempest*, Act IV, Scene I](https://www.folger.edu/explore/shakespeares-works/the-tempest/read/4/1/)

## 一块控制面，接住整个 Agent 工作流

| | 产品能力 |
| --- | --- |
| 🎛️ | **多 Agent，一个入口** — 创建、恢复、停止和切换 Claude Code、Codex、OpenCode、Grok、Trae、Shell 及自定义 CLI 会话 |
| 🧠 | **理解 Agent，而不只转发终端** — 原生呈现消息、推理、工具调用、审批、提问、diff 与子 Agent；任意 CLI 仍有完整 PTY/TUI 兜底 |
| 📱 | **离开电脑也不失控** — 从手机查看实时进度、回答问题、处理审批、追加指令、切换模型，并在需要时立即停止任务 |
| 🗂️ | **项目操作随身可用** — 浏览和编辑文件，查看 Git 状态与 diff，完成 stage、commit 等常用操作 |
| 🪄 | **把目标编排成工作流** — 用 DAG 拆分任务与依赖，派发 worker，通过 Gate 引入人工决策，并以显式 done/fail 状态可靠推进 |
| 🌳 | **并行工作彼此隔离** — `esaytree` 为 Agent 快速创建安全、可回滚的 Git worktree，保护主工作区 |
| 👤 | **多个账号互不干扰** — 同一项目可切换多个 Codex 或 Claude Code 账号，配置、凭据和原生会话历史保持隔离 |
| 🔐 | **连接直达你的 Mac** — 通过 LAN 或 WireGuard 通信，无需 Prospero 云账号、托管环境或消息中转服务 |

## 不是另一朵 Agent 云，而是你的控制层

| 常见妥协 | Prospero 的选择 |
| --- | --- |
| 为远程运行迁移仓库、凭据与工具链 | **本地执行**，完整复用 Keychain、MCP、证书、私有工具和现有登录状态 |
| 只能远程看到一块终端屏幕 | **Agent-aware 交互**，审批、提问、工具、diff 和任务状态都能直接操作 |
| 深度绑定单一 Agent | **结构化适配 + PTY 兜底**，既有原生体验，也不把选择权锁死 |
| 并行 Agent 相互覆盖工作区 | **隔离 worktree + 显式交付**，让协作过程更安全、更可预测 |
| 人离开桌面就失去上下文 | **macOS、iOS、Android 状态一致**，关键监督动作随时可用 |

> [!NOTE]
> Prospero 目前是源码优先的早期项目。macOS 主机端、iOS/Android 客户端及核心控制与编排
> 能力均已实现，暂未提供面向普通用户的稳定签名安装包。

## License

Prospero 采用 [MIT License](LICENSE) 开源。
