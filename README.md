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

正常升级不会要求重新配对：当前客户端会在 v10/v9/v8/v7/v5 兼容窗口内自动协商，
iOS 的配对 token 与设备私钥保存在 Keychain。只有主动撤销设备、轮换 daemon
身份密钥或改变 iOS Bundle ID 才需要重新扫码。

手机主机页进入「Agent 编排」，或 Mac App 打开「编排」→「可视化新建」，即可在
DAG 画布上创建任务、设置前置依赖并一次性发布，再选择 Agent/worktree 派发 worker。
同一 Run 可在手机切换「拓扑 / 列表」查看，或点「编辑图」修改仍处于 pending 的节点；
pending 节点也可从图中删除，已派发/结束节点自动锁定，Mac 与 iOS 编辑器都支持撤销/重做。
Run 标题旁的垃圾桶可删除整条编排；仍有 worker 时会拒绝，Run worktree 会保留以免丢失
未合并代码。发布采用 operationId
幂等与 revision 冲突保护，断线重试不会重复建图，Mac 与手机也不会静默覆盖彼此的更新。
任务运行中可先「停止」worker，任务会进入 failed 并保留为可重试状态；pending/blocked
任务可直接取消。取消不是完成，因此依赖该任务的下游节点不会被错误放行。自动运行期间执行
停止、取消或重试会先暂停自动派发，避免后台立即覆盖人工干预。

手工画完 DAG 后可点「自动运行」：daemon 会在 worker **显式** `task done` 后自动派发
下游节点，不再需要逐个点。默认整张 Run 共用一个新 worktree 并安全串行执行——这样
上下游能看到同一份累计改动，同时不污染当前分支。不同任务各自开 worktree 只有在并行
任务确实会改代码时才有价值；自动合并与冲突处理完成前，不能让依赖链使用彼此隔离、
成果却未合并的工作树。

隔离工作区现由自研的 `esaytree` 引擎创建：先建立无检出的 linked worktree，再用文件系统
CoW 克隆并还原到干净提交快照。源仓的 staged、unstaged、untracked 改动不会进入 worker，
完全 ignored 的依赖目录则默认复用；创建失败会自动回滚登记、目录和新分支。构建后可直接运行
`apps/daemon/bin/esaytree doctor/new/list/switch/rm`，完整契约见
[docs/esaytree.md](docs/esaytree.md)。

Mac App 的日常构建会自动选择钥匙串中的 Apple Development / Developer ID 身份，
让 TCC 授权在升级间保持稳定。首次从旧 ad-hoc 构建切换到稳定签名时可能还需确认
一次；之后保持 `com.linn0x.prospero.shell` 与同一 Team 即无需反复授权。无开发者
证书的临时构建可显式设置 `ALLOW_ADHOC_SIGNING=1`。

Android 侧载构建会把首次使用的升级签名稳定保存为
`~/.prospero/android-side-load.keystore`，后续 `expo prebuild --clean` 仍复用同一证书；
因此 `adb install -r` 能保留 App 数据和配对。正式分发时仍应换成受保护的 release key。

### Codex / Claude Code 多账号

手机主机页进入「Code Agent 账号」即可新增、重命名、设为默认、登录、注销和删除账号。
Prospero 的账号元数据只保存名称与隔离目录 ID。每个 Codex 账号使用独立 `CODEX_HOME`；
每个 Claude Code 账号使用独立 `CLAUDE_CONFIG_DIR`，并注入该账号自己的订阅令牌或 API
key，因此配置、原生会话历史和 MCP/插件状态互不混用。macOS 的 Claude `/login` 默认共享
系统 Keychain，所以 managed Claude 账号改用 `claude setup-token`：令牌经已配对的端到端加密
通道导入，并写入 Prospero 专用的 macOS Keychain 项，不会写进账号元数据或会话持久化文件。

账号环境和项目目录是两层：多个账号可以把同一个项目路径作为 `cwd`。Mac 工具栏启动
Codex/Claude 时也可选择同一组账号。若多个任务会同时修改相同文件，仍建议按任务使用
git worktree；这解决的是并发写冲突，与账号隔离无关。Goal 协调者派发同类 worker 时会
自动继承协调者账号，手工/自动编排则可显式选择账号。

Mac 工具栏的「启动 Agent」可直接创建本机会话：默认启动 Codex 的结构化对话，
也可选择 Claude Code、OpenCode、Grok、Trae 或由 tmux 托管的 Shell。选择支持原生适配的
Code Agent 时会自动切到结构化模式；启动后 Mac 会自动载入对应工作台，而不是只留下一个
Shell。对话、工具过程、审批和问题都能直接在 Mac App 内操作，PTY/TUI 则以内嵌 xterm 呈现；
所有会话仍统一对手机可见。等待批准/回答会以高优先级横幅和操作卡显示，不再藏在状态行里。
正在生成时可点「停止本轮」；它只中断当前回复并保留会话，与「结束」删除整个会话区分开。
子 Agent 以 Codex 风格的名称身份胶囊显示；Mac 会话页点名称可实时查看该 Agent
自己的消息、推理、工具与权限过程，iOS 的会话顶部也保留始终可达的名称栏。
Codex 子线程使用原生 `thread/read(includeTurns:true)` 补齐 daemon 启动前或事件裁剪前
的完整过程；旧版误把父线程显示为“Codex 子 Agent 1”的记录会在恢复时自动清理。

## 规划形态

- **prosperod** — macOS 常驻 daemon(Node 22 / TypeScript):PTY 通用轨 + 各 agent 结构化适配(Agent SDK / opencode serve / codex app-server),WebSocket 统一协议,mDNS + QR 配对
- **app** — React Native (Expo) 客户端(iOS 先行,Android 同库跟进):会话列表 / 聊天与审批卡片 / 终端视图(agent 会话与 shell 会话通用),多地址并发竞速重连
- **shell**(后期)— SwiftUI 菜单栏壳:TCC 权限归属、Bonjour、开机自启
