# 编排:交接状态

**日期** 2026-08-09 · **接续** [orchestration-plan.md](orchestration-plan.md)

一句话:M1(地基)+M2(派发)+M3(协作 CLI)写完并验过；M4 已接入手机 Goal、状态快照与人工 Gate，任务图的深度交互尚可继续扩展。

---

## 一、已完成(已 typecheck + 测试通过)

| 文件 | 内容 | 验证 |
| --- | --- | --- |
| `docs/orchestration-plan.md` | 总设计:模型、分层、worktree 方案、分期 | — |
| `src/orchestration/model.ts` | 数据模型 + 任务状态机 + 成环检测 | 随 store 一起测 |
| `src/orchestration/store.ts` | JSON 持久化,Run/Task/Dispatch/Message/Gate 全套 CRUD | 24 个用例全过 |
| `src/orchestration/worktree.ts` | git worktree + APFS 写时复制克隆依赖 | **只 typecheck,无测试** ⚠️ |
| `test/orchestration-store.test.ts` | 20 个用例 | 全过 |
| `src/control-socket.ts` | `~/.prospero/control.sock` 的 token 鉴权 NDJSON RPC + 0600 token 文件 | 4 个用例全过 |
| `src/orchestration/{control-api,dispatch}.ts` | socket 方法、协调者权限、ready 校验、建会话/worktree/前导词/显式交付 | 2 个派发用例全过 |
| `src/orchestration-cli.ts` + `bin/prospero` | worker/协调者会话内的 `prospero` CLI | daemon 端到端用例全过 |
| `src/orchestration/collaboration.ts` | 持久邮箱的 wait/ask/reply 语义；client 断开可取消长等待 | 4 个用例全过 |
| `test/orchestration-{cli,session-env,collaboration,control-api}.test.ts` | CLI→daemon 往返、身份环境、长轮询/问答、worker 自动 report、决策门 | 9 个用例全过 |
| `packages/protocol` + `src/ws-server.ts` + 手机主机页 | 编排快照 / Gate 决策协议；Goal 建立 Run 与协调者会话；iOS/Android 响应式项目-配置发起页 | protocol、daemon、mobile typecheck 全过 |

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
   不自动把任务判成 done。任务完成必须 worker 显式 `task done` 或协调者显式验收。
   (调研过 Orca:它那条"agent 空闲了就当做完了"的推断是误报主要来源。)
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

### M4 手机端（已完成第一段）

1. protocol 已加入 `orchestration.snapshot` 与 `orchestration.gate.resolve`；App 前台每 8 秒重取快照，iOS/Android 从后台回来不会依赖易丢的增量事件。
2. 新建会话的手机竖屏将项目收为可点按更换的紧凑上下文栏，让配置区占余下全部空间；iPad、Android 平板与横屏手机自动改为项目/配置双栏。对已有项目左滑“新会话”会把该项目固定在项目栏。
3. Goal 会新建结构化协调者会话、创建并关联 Run、把目标与 `prospero task` / `gate` 协作约定发给协调者。主机页可查看进行中的 Goal、任务计数，并直接解开 pending Gate。
4. M4 仍可继续补充：任务依赖图、每个 dispatch/worker 的明细，以及手机端直接新建/派发 task。M3 的 `send`、`check --wait`、`ask`、`reply` 仍只复用既有邮箱，不再另造一套。

### 补测试

2. **`worktree.ts` 没有测试**,是当前最大的裸奔面。建议至少覆盖:
   - `ignoredDirs()` 在 monorepo 里能列出嵌套 `apps/*/node_modules`
   - `createWorktree()` → `removeWorktree()` 往返干净,`.git/worktrees` 不留悬挂元数据
   - 非 APFS 路径下 `cloneIgnoredDirs()` 退回真实复制并报 `cow: false`
   - 用 `git init` 造临时仓库测,别依赖本仓状态

---

## 三、worktree:已经用实测定下来的事(别再纠结)

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

## 四、上一轮探索的产物(已删,结论留档)

先做过一个 `packages/orca-bridge`(把外部 tmux PTY 注册成 Orca worker),
按用户"不依赖 Orca"的要求**已整包删除**。其中三条结论对自研仍然有用:

1. **Orca 的 agent 识别靠终端标题**里的 `✳ ✦ ⏲ ✋ ◇` 或盲文 spinner。
   我们不需要这套——适配器直接给精确状态。但如果将来要**被别的工具识别**,记得
   tmux 默认会吞掉内层 OSC 标题,得 `set-titles on` 才透传。
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
