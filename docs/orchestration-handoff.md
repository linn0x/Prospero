# 编排:交接状态

**日期** 2026-08-13 · **接续** [orchestration-plan.md](orchestration-plan.md)

一句话:M1(地基)+M2(派发)+M3(协作 CLI)写完；M4 已具备手机与 Mac 的可视化 DAG 新建/编辑、拓扑查看、自动/手工 worker 派发，以及停止、取消、重试的生命周期管理；Mac 还可直接启动并聚合本地 Agent 会话。

---

## 零、本轮集成后的不可变约定

### 状态与 Gate

- `ready` 始终是派生值：仅 `pending` 且所有依赖均为 `done` 的 Task 才可派发；不落盘，
  `cancelled` 依赖也绝不放行下游。
- Session 的 `idle`、重连或恢复只能提示人查看，不能推断交付。只有 worker 的
  `prospero task done` / `task fail`（或协调者的显式操作）能结算 Task；`done` 不可回写，
  只有 `failed` 能重试回 `pending`。
- Task Gate 把 Task 置为 `blocked`；最后一个待决 Gate 被以相同决定解决后，Task 回到
  `pending`，由正常 ready/派发路径重新检查。Run-level Gate 不改变任一 Task，但会阻止
  Run 完成：所有 Task 已结算也仍保持 `active`，解开 Gate 后由自动调度器 kick 并经同一
  `completeRun` 入口收口。
- 一个 Run 只有在 Task、活动 Dispatch 和待决 Gate 都已结算时才能完成；`completed` 与
  `abandoned` 均为只读历史。停止、取消、重试会先暂停自动 Run，不能与队列推进竞态。
- **只有调用方提供相同的** `operationId` 时，才以方法和 payload 指纹绑定：运行中请求共享
  promise，完成记录随 `orchestration.json` 落盘；同一 id 改参数返回冲突。未提供 id 的调用不作
  通用去重，不能把“任意重试都幂等”当作约定。`prospero worker start` 的
  `--operation-id` 是可选的：遇到不确定请求是否送达时，调用方须以**同一个** id 重试；Task
  失败后先 `task retry` 再派发是新的逻辑操作，必须使用新的 id（或省略该选项），不能按 Task ID
  自动派生并永久复用 operationId。

### 启动恢复与旧状态

daemon 启动顺序不可调换：control socket 就绪后先恢复 SessionManager，再调用
`DispatchService.reconcilePersistedSessions()`，最后才恢复自动队列和 coordinator 首提示。对每个
结构化 worker，`restoreStructured()` 有两道针对已结算 Dispatch 的封存闸门：第一道在
`adapter.start()` **之前**即时读取 Store，已结算便只恢复审计历史、绝不接回原生会话；第二道在
`adapter.start()` 返回后、`drainQueue()` 之前重新读取 Store，若此窗口内收到了 `task.done` /
`task.fail`，同步封存并阻止旧队列发送。随后 `reconcilePersistedSessions()` 才作为兜底，对账
消失、真正终态或仍存活但已交付的会话，不能替代前两道闸门。真正终态只包括 `done` 和
`died`：结构化会话的 `completed` 只是本轮结束，和 `idle`、`waiting_*` 一样仍能接受下一轮
chat，也继续持有工作树 writer 租约。活动 Dispatch 找不到会话、或会话真正终态但没有显式
交付时，原子收敛为 `abandoned + failed` 并保留原因；`starting`（包括恢复到 `completed` 的
结构化 worker）恢复为 `running`，不会重复派发。已落盘为 `succeeded`/`failed` 却仍活着的
worker（包含 `completed`）会被停止并保留会话历史，防止重启后继续
消费旧队列。自动 Run 遇到已收敛的失败会暂停并留下诊断，而不是假装继续；Goal 首提示的
`pending` 投递账本会在重启后重试。

状态文件现为 `version: 2`。读取 `version: 1` 时只补保守的 legacy 工作树资产，不移动路径、
不改分支；旧 worker 的 `repo === path` 只当待检查候选，找不到不同于目标工作树的可靠源仓
上下文就返回 `unknown`，不能清理。

### Supervisor 升级、回滚与孤儿

结构化会话由每会话 supervisor 持有；daemon 只是可替换的控制/展示客户端。升级或 daemon
重启只能断开 facade，不能向这些会话发送 `interrupt`、`dispose` 或 `kill`。新 daemon 在 control
socket 就绪后会扫描私有 manifest、按事件序号重连 live owner，再做 Dispatch 对账；因此 worker
的 `completed` 仍是可继续聊天的状态，Dispatch 继续为 `running`，Task 仍为 `dispatched`，直到
worker 显式 `prospero task done` / `task fail`。

若必须回滚，只停止 daemon 并启动兼容的旧版本，必要时关闭**新建** supervisor 会话；绝不可把
杀掉 live supervisor 当作回滚步骤。待审批/待回答的原始 request ID 会在重连后继续等待处理，
离线本身从不等于批准。

启动时发现 PID、0600 socket、token 或协议不可信的 manifest，会保留为只读 `died` 会话（UI 显示
“已退出”），绝不自动补开一条 worker/原生 turn。运维清理前必须检查该会话的 0600 manifest 和
`session.json`、确认精确 `supervisorPid` 已不存在且没有 daemon 已重连，先归档整个 0700 会话目录；
之后才能删除 manifest 中精确记录的随机 `/tmp/prospero-supervisor-<nonce>.sock`。不得通配删除
`/tmp`、不得删除 nonterminal 历史或附件。详细步骤和故障证据见
[structured-agent-supervisor.md](structured-agent-supervisor.md)。

### API 与客户端入口

- snapshot / 手机协议：`orchestration.snapshot`、`orchestration.gate.resolve`；客户端以前台
  重取完整快照作为断线和后台恢复基线。
- 本地 control socket：`graph.create` / `graph.apply`、`automation.start` / `pause`、
  `task.done` / `fail` / `retry` / `cancel`、`worker.start` / `stop`、`gate.create` /
  `resolve`，以及下列工作树接口。写操作遵守 coordinator/owner 权限和 `operationId` 幂等。
- worker / coordinator CLI：

  ```bash
  prospero worker start --task TASK_ID --agent codex --worktree new \
    --skill api-search psm-to-repo \
    [--operation-id RETRY_ID]
  prospero worktree list [--run RUN_ID]
  prospero worktree inspect --id WT_ASSET_ID --target main
  prospero worktree cleanup --id WT_ASSET_ID --target main \
    --operation-id UNIQUE_ID --confirm
  ```

  `task create --skill ...` 将默认 Skill 固化在 Task；`worker start --skill ...` 可只覆盖本次
  Dispatch。每次最多 5 个，名称必须来自当前 worker cwd 可发现的项目/用户 Skill 根；派发
  fail-closed 解析并在 Dispatch 保存实际路径和 SHA-256。多个 Run 可并行派发；自动执行只在
  同一 Run 内串行，跨 Run 不共享全局队列。

  control socket 的普通短 RPC 默认等待 15 秒。只有 `worker.start` 使用命令级 5 分钟上限，
  给 esaytree CoW（或 CoW 不可用时的依赖复制）和 agent session 创建完成后再返回；这不是无限
  等待，也不改变 `task.done`、`worktree.inspect` 等短 RPC 的 15 秒窗口。`check --wait` /
  `ask` 的显式长等待仍是各自的无超时语义，不适用该命令级上限。

- 手机和 Mac 都将 active Run 与 completed/abandoned 历史分组、折叠历史；待决 Gate 优先进入
  紧凑概览。两端都有进入编排详情、解开 Gate、停止 worker、取消 pending/blocked、重试 failed
  和查看/检查工作树的生命周期入口。已清理资产以持久 cleanup 记录为准，不能被旧 snapshot 的
  `safe_to_clean` 反向显示为可清理。

### 工作树安全规则

每次创建 Run 共享工作树或 worker 新工作树，均在创建会话前登记独立资产账本。删除 Run 只写
`runDeletedAt`，不删除目录、分支或资产记录；worker 停止、异常退出和 Run 删除均默认保留工作树。
`inspect` 仅只读 Git，并在可靠的源仓/主工作树固定目标 SHA 后给出 `missing`、`dirty`、
`unmerged`、`equivalent`、`safe_to_clean` 或 `unknown`。legacy monorepo 子目录会先解析实际
worktree 根目录；自指或缺少可靠上下文一律 `unknown`。

`cleanup` 必须同时具备新 `operationId` 和 `confirm`，并在删除前于同一可靠上下文重新检查；
只接受 `equivalent` / `safe_to_clean`，使用非 force 的 Git 移除作为第二道保护。默认保留恢复
分支；请求 `--delete-branch` 时以检查到的 branch commit 作为 expected-old 原子删除，若分支
期间推进，目录移除仍可成功但分支保留并返回 warning。绝不将这套 API 用于用户现有工作树；
测试只创建和清理自己的临时 `git init` 目录。

---

## 一、已完成(已 typecheck + 测试通过)

| 文件 | 内容 | 验证 |
| --- | --- | --- |
| `docs/orchestration-plan.md` | 总设计:模型、分层、worktree 方案、分期 | — |
| `src/orchestration/model.ts` | 数据模型 + 任务状态机 + 成环检测 | 随 store 一起测 |
| `src/orchestration/store.ts` | JSON 持久化,Run/Task/Dispatch/Message/Gate/工作树资产全套 CRUD | 43 个用例全过 |
| `src/orchestration/esaytree.ts` | 无检出 worktree + 整仓 CoW + 干净快照还原 + ignored 依赖复用 + 失败回滚 | 真实 Git 生命周期测试 |
| `test/orchestration-store.test.ts` | 43 个用例 | 全过 |
| `src/control-socket.ts` | `~/.prospero/control.sock` 的 token 鉴权 NDJSON RPC + 0600 token 文件 | 4 个用例全过 |
| `src/orchestration/{control-api,dispatch}.ts` | socket 方法、协调者权限、ready 校验、建会话/worktree/前导词/显式交付、worker 停止与重启对账收敛 | dispatch/recovery/control API 回归全过 |
| `src/orchestration-cli.ts` + `bin/prospero` | worker/协调者会话内的 `prospero` CLI | daemon 端到端用例全过 |
| `src/orchestration/collaboration.ts` | 持久邮箱的 wait/ask/reply 语义；client 断开可取消长等待 | 4 个用例全过 |
| `test/orchestration-{cli,session-env,collaboration,control-api}.test.ts` | CLI→daemon 往返、身份环境、长轮询/问答、worker 自动 report、决策门 | 9 个用例全过 |
| `packages/protocol` + `src/ws-server.ts` + 手机/Mac 编排页 | 编排快照 / Gate；原子 DAG 新建、编辑与 pending 节点删除；Run 管理删除；手工或静态自动 worker 派发；Goal 协调者会话 | protocol、daemon、mobile、Swift build 全过 |
| `src/orchestration/automation.ts` | 人工 DAG 一键运行；整张 Run 共享隔离 worktree，显式交付后安全串行推进，支持暂停/恢复/重启续跑 | 真实 git worktree + 状态推进测试 |
| 协议 v9 + `hosts.ts` | v9→v8→v7→v5 滚动兼容；能力协商；token/设备私钥迁入 iOS Keychain | 协议、daemon 集成与移动端迁移测试全过 |

本轮集成验收（2026-08-13）：

```bash
npm run typecheck
npm test
npm test --workspace @prospero/mobile
cd apps/shell && swift build --scratch-path /tmp/prospero-swift-b0ef31b22c72
git diff --check
git status --short
```

结果：TypeScript typecheck 通过；daemon 35 个文件、318 项（4 项显式 skipped）通过；
mobile 26 个文件、163 项通过；Swift debug build 通过；diff 检查和 Git 状态干净。Swift 使用
本任务专用 scratch 目录，避免复用从其他绝对路径带入的 Swift module cache，未清理任何用户工作树。

跑验证:

```bash
npx tsc --build --force packages/protocol apps/daemon
cd apps/daemon && npx vitest run test/orchestration-store.test.ts
```

本轮 M2/M3 的完整验证（2026-08-09）:

```bash
npx tsc --build --force packages/protocol apps/daemon
cd apps/daemon && npx vitest run \
  test/daemon.test.ts test/orchestration-cli.test.ts test/control-socket.test.ts \
  test/orchestration-store.test.ts test/orchestration-dispatch.test.ts \
  test/orchestration-session-env.test.ts test/orchestration-collaboration.test.ts \
  test/orchestration-control-api.test.ts test/tmux.test.ts
```

结果:9 个文件、56 个用例全过。

### 已经确立、别再重新讨论的决定

1. **状态只认显式转移,绝不猜。** `SessionStatus` 回到 `idle` 或 `completed` 都只当"去看一眼"的
   提示，不自动把任务判成 done；后者只代表结构化 agent 的一轮结束，仍可继续 chat。任务完成必须
   worker 显式 `task done` 或协调者显式验收；把“暂时空闲”当成“已经交付”会制造无法可靠恢复的误报。
2. **`ready` 是派生值,不落盘。** `pending` 且 deps 全 `done` 即 ready。存下来就有两份真相。
3. **依赖被 `cancelled` 不算放行。** 前提没了就该有人显式改依赖,不能让任务在半截地基上开工。
4. **`done` 是终态。** 要改就新建任务,不改历史。只有 `failed` 能退回 `pending` 重试。
5. **门解开后退回 `pending` 而不是 `dispatched`。** 挡着这段时间依赖和 worker 都可能变了。
6. **不上 SQLite。** 几十个任务、几百条消息,查询全是按 runId 过滤,跟现有
   `pty-sessions.json` 一个路子就够。

### 写的过程中真实抓到的 bug(已修,别改回去)

`createDispatch` 原本只查状态机,而 `canTransition` 为了让重试命令幂等**允许同状态自转**,
于是 `dispatched → dispatched` 合法,同一个任务能派给两个 worker,两个 agent 在同一份代码上
互相覆盖。现在改成先查 `activeDispatchFor()` 显式拦截。`store.ts` 里那段注释别删。

---

## 二、产品入口与仍可迭代项

### M4 手机端与 Mac（已完成主路径）

1. protocol 已加入 `orchestration.snapshot` 与 `orchestration.gate.resolve`；App 前台定时重取快照，iOS/Android 从后台回来不会依赖易丢的增量事件。
2. 新建会话的手机竖屏将项目收为可点按更换的紧凑上下文栏，让配置区占余下全部空间；iPad、Android 平板与横屏手机自动改为项目/配置双栏。对已有项目左滑“新会话”会把该项目固定在项目栏。
3. Goal 会新建结构化协调者会话、创建并关联 Run、把目标与 `prospero task` / `gate` 协作约定发给协调者。主机页可查看进行中的 Goal、任务计数，并直接解开 pending Gate。
4. 手机新增 Agent 编排中心：创建无 coordinator 的手工 Run、添加 Task、选择前置依赖、选择 Agent/worktree/审批策略并派发 worker，可直接打开 worker 会话。
5. Mac Goal 页同步支持新建手工 Run、任务依赖和 worker 派发；写操作走 loopback + 每次启动轮换的 control token。
6. 已配对设备新增 `allowOrchestration` 能力；升级前记录缺少该字段时沿用 `allowShell`，因此无需重新扫码。
7. `orchestration.graph.v1` 支持一次原子创建完整 DAG；`operationId` 在 daemon 重启后仍幂等，`graphRevision` 用乐观并发控制阻止 Mac/iPhone 静默互相覆盖。旧 v7/v5 客户端不看到新能力，仍沿用原配对连接。
8. Mac 与 iOS 均提供自动分层 DAG 编辑器、已有 Run 的「编辑图」入口和撤销/重做；pending 节点可改可删，已派发/结束节点只读，删除与依赖重连按 revision 原子提交，客户端会阻止循环依赖。
9. 人工 Run 可「自动运行」：默认创建一张图共用的 Run worktree，一次只派一个 worker；worker 显式 `task done` 后自动启动下游，全部完成后 Run 才完成。暂停只阻止后续派发，不强杀当前 worker。
10. Mac 与 iOS 可删除整条 Run；活动 worker 会阻止删除，Run/Task/Dispatch/Message/Gate 记录一并清理，但可能含未合并代码的 Run worktree 明确保留。
11. Mac 与 iOS 均可停止活动 worker、取消 pending/blocked 任务、重试 failed 任务；停止与意外退出都会原子收敛 Dispatch/Task 状态。取消不会释放下游依赖，自动执行中的生命周期操作会先暂停 Run。
12. Mac 全局工具栏可直接启动本地 Agent；默认 Shell + PTY，也可启动 Claude/Codex/OpenCode/Grok/Trae，并为支持的 Agent 切换结构化模式。创建仍走 loopback + control token，SessionManager、tmux 恢复和手机侧会话列表保持单一真相。
13. Mac 会话页提供醒目的「停止本轮」且保留会话；Codex app-server 中断严格携带官方 `TurnInterruptParams` 要求的 `threadId + turnId`，不再静默吞掉协议错误。手机原有停止入口同步受益，无需升级客户端。
14. 后续仍可补充：每任务 worktree 的自动合并/冲突处理与安全并行、画布拖拽位置持久化、Run 归档，以及更丰富的 worktree diff/合并视图。M3 邮箱继续复用现有实现；检查与安全清理已交付。
15. Mac 会话页可按名称进入子 Agent 的独立实时过程，展示消息、推理、工具、权限与提问；读取走 loopback + control token。iOS 增加常驻名称栏与 `subagent.history.v1` 按需历史，长会话即使截断早期启动事件仍可进入。Codex 通过 `thread/read(includeTurns:true)` 恢复原生 turn/item，晚到的 `agentNickname`/`agentRole` 会补全既有身份；发现时严格校验 `parentThreadId`，恢复时自动清掉旧版误记的父线程伪子 Agent。

### esaytree 测试（已补）

`test/esaytree.test.ts` 使用临时 `git init` 仓库覆盖 monorepo ignored 目录识别、源仓本地状态清理、
CoW/checkout 双路径、修改隔离、clean 模式、默认根目录生命周期、分支清理和失败无残留；
`test/esaytree-cli.test.ts` 固定 `new/list/switch/rm` 的单文档 JSON 契约、错误码与退出码。

---

### 工作树资产生命周期（v2）

`orchestration.json` 的 `version: 2` 新增独立的 `worktreeAssets` 账本。每次创建 Run
共享工作树或 `worker --worktree new` 时，都会在创建会话前立即登记 `runId`、可选
`taskId/dispatchId`、`repo`、`path`、`branch`、创建时间和当前安全状态。删除 Run 只会给
资产写入 `runDeletedAt`，不会删除目录、分支或资产记录。

旧版 `version: 1` 文件在读取时只做保守迁移：从 `Run.automation` 与
`Dispatch.worktreePath` 补出 legacy 资产，原路径和分支均不触碰；worker 旧记录缺少 repo
时先把其 path 作为待复核候选，必须经过检查后才能清理。

控制 socket / 会话 CLI 的接口为：

```bash
prospero worktree list [--run RUN_ID]
prospero worktree inspect --id WT_ASSET_ID --target main
prospero worktree cleanup --id WT_ASSET_ID --target main \
  --operation-id UNIQUE_ID --confirm
```

`inspect` 只读 Git，明确返回 `missing`、`dirty`、`unmerged`、`equivalent` 或
`safe_to_clean`（元数据异常为 `unknown`）。目标 ref 会先在与待检查工作树不同的、可靠的
源仓/主工作树中固定解析为 commit SHA；因此 v1 worker 的 `repo === path` 不会把自己的
`HEAD` 当作已合入目标。v1 Run 若登记的是 monorepo 子目录，检查会先解析实际 worktree
根目录，并只对该根执行移除。找不到可靠上下文时只返回 `unknown`，绝不允许清理。

`cleanup` 必须带 `confirm` 和幂等 `operationId`，执行前会在同一可靠上下文重新检查、以
非 force 的 Git 移除作为第二道保护；默认保留本地分支。额外传 `--delete-branch` 时，会以
检查时的分支 commit 作为 expected-old 原子删除；期间若分支被推进，目录虽已安全移除但新
分支会保留，并返回 warning 供恢复。

---

## 三、esaytree：已经用实测定下来的事(别再纠结)

用户最初的担心是"一个 worktree 就 cp 一份项目"。**实测数据(本仓)**:

| | 体积 | 耗时 |
| --- | --- | --- |
| `.git`(worktree 之间**共享**,不复制) | 4.2 MB | — |
| `git worktree add` 的检出 | 4.1 MB | 0.08s |
| `node_modules`(gitignored,git 根本不碰) | 4.3 GB | — |
| **APFS clonefile 克隆整个 node_modules** | **磁盘增量 ≈ 0** | **11s** |

结论:`git worktree add` 从来就不复制仓库(新 worktree 里 `.git` 只是一行 `gitdir:` 指针)。
贵的是依赖,而依赖用写时复制解决。已验证是真 CoW 不是硬链接——inode 不同,
改克隆不污染源目录。Node 原生支持:

```ts
fs.cpSync(src, dst, { recursive: true, mode: fs.constants.COPYFILE_FICLONE_FORCE });
```

用 `FICLONE_FORCE` 而非 `FICLONE`:后者在不支持 CoW 的文件系统上会**悄悄降级**成真实复制
(4.3GB 就真的落盘了),前者会抛错,于是我们能退回真实复制并把 `cow: false` 报上去提示用户。

要克隆哪些目录**不靠猜名单**,问 git:
`git ls-files --others --ignored --directory --exclude-standard`——
它会把完全被忽略的目录整个折叠成一条,monorepo 里嵌套的 `apps/*/node_modules` 一并列出。

---

## 四、早期原型留下的结论

早期做过把外部 tmux PTY 注册为 worker 的桥接原型,现已删除。三条结论继续用于
Prospero 自研实现:

1. **状态应由 Agent 原生 hooks/IPC 上报,不从 terminal title 推断。**
   Prospero 坚持显式生命周期；session idle 只作提示,不自动完成 Task。
2. **tmux 的目标语法不一致且静默失败**:`set-option`/`show-options`/`resize-window`
   **不认** `=name` 精确匹配前缀(报 no such session 且退出码非 0 容易被吞);
   `capture-pane`/`send-keys` 收的是 pane 目标,要先 `list-panes` 问出 `%id`。
   现有 `src/tmux.ts` 目前没踩到,但将来加会话级选项时会。
3. **tmux `new-session` 不继承客户端环境**(server 先起来的),所以身份必须显式注入。
   现在 `spawnEnv()` 注入 PTY,同时 `new-session -e` 把 `PROSPERO_*` 显式带进 tmux server；
   `tmux.test.ts` 已在真实 tmux 上验证。

---

## 五、交接检查清单

1. 改状态机或恢复顺序时，至少运行 `orchestration-store`、`orchestration-dispatch`、
   `orchestration-recovery`、`orchestration-automation` 和 `orchestration-control-api`；不要以
   Session `idle` 为完成信号。
2. 改工作树登记、迁移或清理时，运行 `orchestration-worktree-assets` 与 mobile
   `worktree-assets`；用临时 `git init` 仓库断言拒绝路径，绝不针对开发者现有 worktree 试删。
3. 改手机/Mac 概览或生命周期入口时，运行 mobile `orchestration-overview`、`worktree-assets`
   和 `swift build`；历史折叠不得隐藏待决 Gate，已清理资产不得重新出现清理按钮。
4. 交付前运行本节的完整命令、`git diff --check` 与 `git status --short`。只提交本任务实际
   修改；不清理用户已有 worktree、分支或会话。
