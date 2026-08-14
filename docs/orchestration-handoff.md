# 编排:交接状态

**日期** 2026-08-10 · **接续** [orchestration-plan.md](orchestration-plan.md)

一句话:M1(地基)+M2(派发)+M3(协作 CLI)写完；M4 已具备手机与 Mac 的可视化 DAG 新建/编辑、拓扑查看、自动/手工 worker 派发，以及停止、取消、重试的生命周期管理；Mac 还可直接启动并聚合本地 Agent 会话。

---

## 一、已完成(已 typecheck + 测试通过)

| 文件 | 内容 | 验证 |
| --- | --- | --- |
| `docs/orchestration-plan.md` | 总设计:模型、分层、worktree 方案、分期 | — |
| `src/orchestration/model.ts` | 数据模型 + 任务状态机 + 成环检测 | 随 store 一起测 |
| `src/orchestration/store.ts` | JSON 持久化,Run/Task/Dispatch/Message/Gate 全套 CRUD | 36 个用例全过 |
| `src/orchestration/esaytree.ts` | 无检出 worktree + 整仓 CoW + 干净快照还原 + ignored 依赖复用 + 失败回滚 | 真实 Git 生命周期测试 |
| `test/orchestration-store.test.ts` | 36 个用例 | 全过 |
| `src/control-socket.ts` | `~/.prospero/control.sock` 的 token 鉴权 NDJSON RPC + 0600 token 文件 | 4 个用例全过 |
| `src/orchestration/{control-api,dispatch}.ts` | socket 方法、协调者权限、ready 校验、建会话/worktree/前导词/显式交付、worker 停止与异常退出收敛 | 4 个派发用例全过 |
| `src/orchestration-cli.ts` + `bin/prospero` | worker/协调者会话内的 `prospero` CLI | daemon 端到端用例全过 |
| `src/orchestration/collaboration.ts` | 持久邮箱的 wait/ask/reply 语义；client 断开可取消长等待 | 4 个用例全过 |
| `test/orchestration-{cli,session-env,collaboration,control-api}.test.ts` | CLI→daemon 往返、身份环境、长轮询/问答、worker 自动 report、决策门 | 9 个用例全过 |
| `packages/protocol` + `src/ws-server.ts` + 手机/Mac 编排页 | 编排快照 / Gate；原子 DAG 新建、编辑与 pending 节点删除；Run 管理删除；手工或静态自动 worker 派发；Goal 协调者会话 | protocol、daemon、mobile、Swift build 全过 |
| `src/orchestration/automation.ts` | 人工 DAG 一键运行；整张 Run 共享隔离 worktree，显式交付后安全串行推进，支持暂停/恢复/重启续跑 | 真实 git worktree + 状态推进测试 |
| 协议 v9 + `hosts.ts` | v9→v8→v7→v5 滚动兼容；能力协商；token/设备私钥迁入 iOS Keychain | 协议、daemon 集成与移动端迁移测试全过 |

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

1. **状态只认显式转移,绝不猜。** `SessionStatus` 回到 `idle` 只当"去看一眼"的提示,
   不自动把任务判成 done。任务完成必须 worker 显式 `task done` 或协调者显式验收；
   把“暂时空闲”当成“已经交付”会制造无法可靠恢复的误报。
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

## 二、没做的(按建议顺序)

### M4 手机端与 Mac（已完成手工编排主路径）

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
14. 后续仍可补充：每任务 worktree 的自动合并/冲突处理与安全并行、画布拖拽位置持久化、Run 归档，以及 worktree diff/合并/清理。M3 邮箱继续复用现有实现。
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

## 五、当前工作区状态

- 新增未提交:`docs/orchestration-{plan,handoff}.md`、
  `src/orchestration/{model,store,worktree,control-api,dispatch,collaboration}.ts`、
  `src/{control-socket,orchestration-cli}.ts`、`bin/prospero`、
  `test/orchestration-{store,dispatch,cli,session-env,collaboration,control-api}.test.ts`、
  `test/control-socket.test.ts`
- 这些是**在既有的一大堆未提交改动之上**加的(`git status` 里本来就有几十个改动文件),
  提交前先确认别把别人的活一起带上
- 无残留:orca-bridge 已删,root `package.json`/`README.md` 的改动已 `git checkout` 还原,
  实验用的 tmux 会话和 `/tmp` 产物已清,用户自己的两个 telescreen 会话未受影响
