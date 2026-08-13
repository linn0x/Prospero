# Prospero

> Local-first control plane for coding agents — run them on your Mac, supervise them from anywhere.

Prospero 是本地 Coding Agent 的跨设备控制中枢。Claude Code、Codex、OpenCode 等 Agent 继续运行在你的 Mac 上，直接使用现有仓库、工具链、账号和登录状态；你可以通过 macOS、iOS 或 Android 随时查看进度、处理审批并接管任务。

## 产品能力

- **统一管理多种 Agent**：在一个界面中创建、恢复、停止和切换 Claude Code、Codex、OpenCode、Grok、Trae、Shell 及自定义 CLI 会话。
- **理解 Agent，而不只是转发终端**：原生展示消息、推理、工具调用、审批、提问、文件 diff 和子 Agent 状态；未适配的 CLI 仍可通过完整 PTY/TUI 使用。
- **随时从手机监督工作**：查看实时进度、批准或拒绝操作、回答问题、追加指令、切换模型与模式，并在异常时立即停止任务。
- **直接操作项目**：跨设备浏览和编辑文件，查看 Git 状态与 diff，完成 stage、commit 等常用操作，无需回到电脑前。
- **编排多个 Agent 协作**：用 DAG 拆分任务和依赖，派发 worker，通过 Gate 等待人工决策，并以显式的 done/fail 状态可靠推进流程。
- **隔离并发工作区**：通过 `esaytree` 为 Agent 创建安全、快速、可回滚的 Git worktree，减少并行修改对主工作区的干扰。
- **隔离多个账号**：同一项目可使用多个 Codex 或 Claude Code 账号，配置、凭据和原生会话历史互不混用。
- **跨网络无感恢复**：在局域网或 WireGuard 网络中自动寻找可用地址；断线后恢复会话状态和增量输出。

## Prospero 的优势

| 优势 | 带来的价值 |
| --- | --- |
| **本地执行** | 完整复用本机仓库、Keychain、MCP、证书、私有工具和已有登录状态 |
| **无需 Prospero 云中转** | 控制链路通过 LAN 或 WireGuard 直连，项目和会话数据留在自己的设备上 |
| **结构化交互 + PTY 兜底** | 深度适配时获得原生体验，面对任意 CLI 时仍保留完整可用性 |
| **真正适合移动端** | 审批、提问、diff 和任务状态针对手机重新设计，不是缩小版桌面终端 |
| **监督与编排一体化** | 从单个会话到多 Agent 工作流，共用一致的状态、权限和人工决策机制 |
| **工作区安全优先** | 通过隔离 worktree 和显式任务交付，降低并行 Agent 相互覆盖的风险 |

Prospero 目前是源码优先的早期项目，macOS 主机端、iOS/Android 客户端及核心控制与编排能力均已实现，暂未提供面向普通用户的稳定签名安装包。

## License

Prospero 采用 [MIT License](LICENSE) 开源。
