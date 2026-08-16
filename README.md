# Prospero

> **在手机上，操控 Mac 或 Windows 上的所有 Coding Agent。**
>
> Control every coding agent on your computer — from anywhere.

[![CI](https://github.com/linn0x/Prospero/actions/workflows/ci.yml/badge.svg)](https://github.com/linn0x/Prospero/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-22c55e)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20iOS%20%7C%20Android-0ea5e9)
![Local First](https://img.shields.io/badge/architecture-local--first-8b5cf6)

Prospero 把你的 iPhone 或 Android 手机变成 Mac 或 Windows 电脑上**所有 Coding Agent 的遥控器**。Agent
继续在电脑上运行，完整使用已有仓库、工具链、账号与登录状态；你可以在手机上随时查看进度、
回复问题、处理审批、追加指令或直接接管任务。

无论是 Claude Code、Codex、DeepSeek Harness、OpenCode、Grok、Trae，还是任意 Agent CLI，都能进入同一个移动端
控制界面。Prospero 深度理解已适配 Agent 的消息与工具；面对其他 Agent，则用完整 PTY/TUI
保留终端能力。

> “Spirits, which by mine art I have from their confines called to enact my present fancies.”
>
> — Prospero, [*The Tempest*, Act IV, Scene I](https://www.folger.edu/explore/shakespeares-works/the-tempest/read/4/1/)

## 一部手机，掌控电脑上的所有 Agent

| | 产品能力 |
| --- | --- |
| 📱 | **所有 Agent，一个移动入口** — 从手机创建、恢复、切换和停止 Claude Code、Codex、DeepSeek Harness、OpenCode、Grok、Trae、Shell 及自定义 CLI 会话 |
| 👀 | **进度不再锁在电脑屏幕里** — 随时查看消息、推理、工具调用、diff、子 Agent 和实时终端输出 |
| ✅ | **关键时刻直接处理** — 在手机上回答 Agent 提问、批准或拒绝操作、追加指令、切换模型与模式，必要时立即停止任务 |
| ⌨️ | **结构化体验，终端能力不丢失** — 已适配 Agent 使用原生交互；任意 CLI 都能通过完整 PTY/TUI 操控 |
| 🗂️ | **连项目也能一起操作** — 浏览和编辑电脑上的文件，查看 Git 状态与 diff，完成 stage、commit 等常用操作 |
| 🔐 | **无需把开发环境搬上云** — Agent 和项目留在本机；优先通过 LAN 或 WireGuard 直连，必要时可用自托管 relay 传输 E2E 密文 |
| 🪄 | **从单个 Agent 到完整工作流** — 在手机上用 DAG 拆分任务、派发 worker、处理 Gate，并跟踪每个任务的显式交付状态 |
| 🌳 | **并行任务互不干扰** — `esaytree` 为 Agent 创建安全、快速、可回滚的 Git worktree，保护主工作区 |

## 不只是远程终端，也不是另一朵 Agent 云

| 常见妥协 | Prospero 的选择 |
| --- | --- |
| 为远程运行迁移仓库、凭据与工具链 | **Agent 留在本机**，完整复用 Keychain/Windows 用户配置、MCP、证书、私有工具和现有登录状态 |
| 手机上只能看到一块终端屏幕 | **Agent-aware 移动交互**，审批、提问、工具、diff 和任务状态都能直接操作 |
| 每种 Agent 都需要不同的远控方案 | **一个 App 接入所有 Agent**，结构化适配与 PTY 兜底同时覆盖 |
| 离开电脑就失去上下文 | **手机与电脑状态一致**，从口袋里继续处理当前任务 |
| 多个 Agent 并行时相互覆盖 | **可视化编排 + 隔离 worktree**，让协作过程更安全、更可预测 |

## 多 Agent 编排：从目标到可验收交付

Prospero 的编排层不依赖某个 Agent 或 IDE：Run、Task、Dispatch、Gate、协作消息和工作树资产都由
daemon 持久管理，协调者 Agent 与手机只是它的客户端。你可以从手机主机页进入 **Goal**，用一句话创建目标，
再让协调者调查、拆分、派发和验收。

| 阶段 | Prospero 负责什么 |
| --- | --- |
| **Goal / Run** | 为目标创建独立 Run 与协调者会话；活动 Run 和历史记录分开展示 |
| **DAG 拆分** | Task 可声明依赖与层级；只有依赖全部完成的节点才会 ready，成环会被拒绝 |
| **执行** | 可手工派发多个隔离 worker 并行工作，也可一键自动推进；当前自动模式在 Run 共享工作树中串行执行，确保下游看见上游改动 |
| **人机协作** | coordinator 与 worker 可通过持久邮箱发送、询问和回复；需要人决定时创建 Gate，手机可直接处理 |
| **显式交付** | worker 必须明确执行 `task done` 或 `task fail`；Agent 暂时空闲、结束一轮对话或断线都不会被误判为完成 |
| **验收与恢复** | 只有 Task、活动 Dispatch 和待决 Gate 全部收口后 Run 才能完成；daemon 重启会根据持久状态与存活会话重新对账，不重复派发 |

手工并行时，`esaytree` 会为 worker 建立独立 Git worktree；自动模式则让整张 Run 共享一个隔离工作树并安全串行推进。
CoW 依赖复用不可用时会安全降级，不会把 ignored 缓存偷偷变成实体副本。工作树在成功、失败或停止后都默认保留，
只有经过只读检查并显式确认后才会清理。

编排契约、恢复语义和 CLI 全景见 [编排交接文档](docs/orchestration-handoff.md)；工作树安全规则见
[esaytree 设计](docs/esaytree.md)。

## Windows 支持

Windows 11 是受支持的 daemon 平台，不只是可以打开仓库或连接手机。Windows 与 macOS 使用相同的配对协议、
端到端加密连接、移动端界面和编排状态机；本地 worker CLI 通过 Windows named pipe 与 control token 访问 daemon。

| 能力 | Windows 11 状态 |
| --- | --- |
| daemon、扫码配对、LAN / WireGuard / relay | ✅ 支持；relay 仍只转发 E2E 密文 |
| Shell 与 Agent CLI | ✅ 支持 PowerShell/cmd，以及 Claude Code、Codex、DeepSeek Harness、OpenCode、Grok、Trae 和自定义 CLI |
| 结构化聊天 | ✅ Claude Code、Codex、DeepSeek Harness、OpenCode、Grok 可用；其余 Agent 使用完整 PTY/TUI |
| DAG / Goal / Gate / worker 编排 | ✅ 支持手工与自动编排；使用 worktree 时需安装 Git for Windows |
| daemon 重启时保活 Agent | ✅ PTY 与 Claude Code / Codex / DeepSeek Harness / OpenCode / Grok structured 会话使用每会话 Windows Session Host；daemon 只重连已验证的 owner，不重复启动 agent |
| 原生分发与 CI | ✅ x64、arm64 都有预编译 N-API 路径；PR 验证原生 ABI/加载拒绝 unsigned artifact，`v*` release 再签名、校验并在两种架构加载 signed artifact |

在 Windows 上，Session Host 而非 daemon 持有 ConPTY、structured adapter、Job Object 和 append-only journal。正常退出或强制结束
daemon 后，新 daemon 只会以 manifest 的 epoch、PID+FILETIME、pipe peer identity 和 capability 重新 attach；身份不符、host 已死
或状态不完整时会显示为不可用/只读，而不是静默补开一条命令。原生 binding 在 **host 创建前**缺失、签名/ABI 不通过或能力不足时，
Windows 会明确使用 daemon 内 `direct` 会话；它不具备重启保活语义。已启动 host 的 attach、身份或 Job 策略错误不会回退到
direct，以免创建重复 agent。显式 **Kill** 与 daemon 停止不同：Kill 持久化终态 fence 并终止受控 Job；Stop/Interrupt 只请求中断。

这项保证只覆盖 daemon 生命周期，不覆盖 Windows 注销、系统关机/重启、睡眠/断电或 EDR 强制终止。此类场景之后会保留可审计的
journal/终态历史，但不会自动重放 native 命令或宣称 in-flight turn 已恢复。架构、安全边界、状态含义和操作步骤见
[Windows Session Host 运维与排障](docs/windows-session-host-operations.md)；N-API 安装、签名和 release 校验见
[Windows N-API native boundary](docs/windows-native-boundary.md)。macOS/Linux 仍分别使用 detached structured supervisor 与可选
`tmux` PTY 托管。

Windows 当前没有独立托盘应用，请在 PowerShell 或 cmd 中运行 `prosperod`。命令、配置目录和手机客户端与 macOS 版本一致。

## How to use

> 以下 daemon 命令可在 Mac 终端或 Windows PowerShell/cmd 中执行。需要 macOS 14+ 或 Windows 11、
> Node.js 22+，以及至少一个已登录的 Agent CLI。构建 iOS 客户端需要 Xcode；Android 客户端需要
> JDK 17 与 Android SDK。

### 1. 在电脑上启动 Prospero

```bash
git clone https://github.com/linn0x/Prospero.git
cd Prospero
npm ci
npm run build -w @prospero/daemon
node apps/daemon/dist/cli.js start --name my-computer
```

使用 DeepSeek Harness 前，在运行 daemon 的同一 Node.js 环境安装官方 CLI。Prospero 会启动仅监听
`127.0.0.1` 随机端口的 `dsh web` host，并通过官方 RPC/SSE 接入多轮会话、工具审批、问题和模型目录：

```bash
npm install -g @deepseek-ai/dsh
dsh web
```

首次运行 `dsh web` 时在 **Settings → Models** 配置 DeepSeek API Key，并选择工作区。Windows 上若使用
nvm 切换 Node.js，需在新版本下重新安装 `dsh`，然后重启 Prospero daemon，让它继承新的 `PATH`。

Windows 的 signed release 包会携带 x64 与 arm64 N-API prebuild；loader 在创建 Session Host 前验证签名、hash、ABI 和能力集。
直接从源码 checkout 执行 `npm ci`/本机 native build 不会把 unsigned 开发 addon 变成 production artifact，因此会走明确的
`direct` fallback，而不是伪装成可保活 host。发布包的签名、安装和验收规则见 [Windows N-API native boundary](docs/windows-native-boundary.md)。

### 2. 构建并安装手机客户端

```bash
# 连接 iPhone 后，选择真机并安装
npm run ios -w @prospero/mobile -- --device

# 安装到已连接的 Android 设备或模拟器
npm run android -w @prospero/mobile
```

这两条命令会在电脑上编译原生客户端、安装到手机或模拟器，并启动 Metro 开发服务；
不是在手机终端中运行。iPhone 真机需先在 Xcode 中登录 Apple ID 并完成开发签名配置。

### 3. 扫码配对并启动 Agent

保持 daemon 运行，在电脑的另一个终端生成配对二维码：

```bash
node apps/daemon/dist/cli.js pair --name my-phone
```

用 Prospero App 扫描二维码，选择电脑上的项目与 Agent，即可创建会话。同一局域网可直接连接；
离开局域网时，让手机与电脑加入同一个 WireGuard 或 Tailscale 私有网络。

### 4. 可选：发起一个 Goal 编排

在手机的主机页新建会话并选择 **Goal**，填写最终目标、项目目录和协调者 Agent。启动后可进入
**Agent 编排**查看 DAG：让协调者通过会话拆任务，或在图上手工创建、编辑依赖；随后选择
**自动运行**串行推进共享 Run worktree，也可以为 ready Task 手工派发独立 worker 并行执行。

运行中可从手机打开 worker 会话、停止任务、重试失败节点和处理 Gate。所有节点显式交付且没有
活动 worker 或待决 Gate 后，再完成 Goal；工作树仍会保留，便于验收 diff 后按需清理。

### 5. 可选：自托管 relay 与三种连接模式

relay 让已配对手机在没有直连路径时抵达自己的 daemon；它只转发端到端加密数据，不能读取聊天、终端或文件内容。
部署说明、备份恢复、升级和回滚见 [relay runbook](apps/relay/README.md)。先在 relay 主机按该文档配置 DNS、`.env` 和
Compose，再在 daemon 的服务环境注入默认 URL（或只为本机指定 `--url`）：

```bash
PROSPERO_DEFAULT_RELAY_URL=wss://relay.example.com \
  node apps/daemon/dist/cli.js relay enable
node apps/daemon/dist/cli.js relay status --json
node apps/daemon/dist/cli.js pair --name my-phone
```

Windows PowerShell 中可这样设置默认 relay：

```powershell
$env:PROSPERO_DEFAULT_RELAY_URL = "wss://relay.example.com"
node apps/daemon/dist/cli.js relay enable
node apps/daemon/dist/cli.js relay status --json
node apps/daemon/dist/cli.js pair --name my-phone
```

新 QR 会包含独立 relay 凭证，App 默认使用 `auto`：直连和 relay 同时竞速，首个完成 E2E `hello.ok` 的路径获胜。
也可在主机设置中改为 `direct`（仅 LAN/WireGuard）或 `relay`（仅 relay）。启用 relay 之前创建的设备没有可追溯的
relay 凭证，必须重新扫码；`relay rotate-key --yes` 也会要求所有设备重新扫码，但不会使原来的直连配对失效。

> [!IMPORTANT]
> 本仓交付的是可部署制品和 runbook，不是已完成的真实公网部署证明。当前容量资格为 **inconclusive/waived**：没有
> 5k host / 1k stream pair / 600 秒成功结论，没有 16 GiB 环境资格、同环境 direct RTT baseline，也没有公网 DNS TLS/WSS 验证。
> 完整证据和限制见 [release status](docs/relay-release.md)。

> [!NOTE]
> **Prospero 正在寻找同行者。** 欢迎成为 Contributor：分享想法、改进体验、修复问题，
> 或和我们一起定义本地 Coding Agent 的未来。

## License

Prospero 采用 [MIT License](LICENSE) 开源。
