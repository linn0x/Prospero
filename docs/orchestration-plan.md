# 多 Agent 编排(自研)

> Prospero 差遣 Ariel。这份文档是「怎么同时差遣一群」。

## 目标

一个协调者 agent 拆任务、派活、验收;若干 worker agent 并行干活,彼此隔离;
人在手机上随时能看、能插手。全部自研,不依赖任何外部 IDE 的编排能力。

**非目标**:不做通用工作流引擎,不做 DAG 调度器。任务图能表达依赖就够了。

## 为什么我们的位置比"在别人家编排"好

调研过 Orca 1.4.173 的编排实现(它把 Run/Task/Dispatch 绑在自己管理的 PTY 上)。
它有两处硬伤,而这两处恰好是我们已经解决掉的:

| | Orca 的做法 | Prospero 已有的 |
| --- | --- | --- |
| **agent 状态** | hook 脚本 HTTP 回报 + 扫终端标题里的 `✳ ✦ ⏲`,抓不到就靠输出静默猜 | 适配器**原生**给 `running / waiting_approval / waiting_input / idle / done`,外加 `busySince`、`pendingPermissions`、`pendingQuestions` |
| **会话身份** | terminal handle 绑在进程上,Orca 一重启全作废,要重新绑定 | 会话 id 持久(`prospero-<id>` tmux + `pty-sessions.json`),daemon 重启后原样还在 |

也就是说:编排最难的两件事——**知道 agent 现在到底在干嘛**、**重启后还认得它是谁**——
我们是白捡的。剩下的是编排本身的账。

## 数据模型

一个 JSON 文件落盘,原子写,跟现有 `pty-sessions.json` / `structured-sessions.json` 一个路子。
数据量是几十个任务、几百条消息的量级,不值得为它引入 SQLite。

```ts
Run       { id, objective, status: active|completed|abandoned,
            coordinatorSessionId, createdAt, updatedAt }

Task      { id, runId, title, spec, deps: TaskId[], parentId,
            status: pending|ready|dispatched|blocked|done|failed|cancelled,
            result, createdAt, updatedAt }

Dispatch  { id, runId, taskId, sessionId, worktreePath,
            state: starting|running|succeeded|failed|abandoned,
            startedAt, settledAt, outcome }

Message   { id, runId, from, to, type: note|ask|reply|report,
            subject, body, threadId, createdAt, readAt, answeredAt }

Gate      { id, runId, taskId, question, options[], status, decision, resolvedAt }
```

`ready` 是**派生**的,不落盘:`pending` 且 `deps` 全 `done` 即 ready。
状态机只认显式转移,不猜——worker 干完必须显式 `task done`,
`SessionStatus` 回到 `idle` 只是**提示**协调者去看一眼,不等于任务完成。
(Orca 那套"agent 空闲了就当它做完了"是误报的主要来源。)

## 分层

```
手机 App ─┐
          ├─→ ws-server ─┐
协调者    │              ├─→ Orchestrator ─→ SessionManager ─→ tmux / 适配器
agent ────┴─ 控制 socket ─┘        │
   (prospero CLI)                  └─→ Store(JSON) / esaytree(git + CoW)
```

- **Orchestrator** 是唯一的编排真相源。手机和协调者 agent 都只是它的客户端,
  走不同的传输(WS / unix socket),调用的是同一套 API。
- **控制 socket**:`~/.prospero/control.sock`,NDJSON,token 文件 0600 兜底。
  本机、免加密握手 —— 手机那条链路才需要 E2E,agent 就在本机上。
- **`prospero` CLI**:注入进每个会话的 `PATH`,agent 靠 `$PROSPERO_SESSION_ID`
  自报身份。因为会话 id 持久,这里**不需要**任何"重启后重新绑定"的机制。

## esaytree：快速 worktree

先破一个误解:`git worktree add` **从来就不复制仓库**。新 worktree 里的 `.git`
只是一行 `gitdir:` 指针,对象库跟主仓共享。本仓实测:

| | 体积 | 耗时 |
| --- | --- | --- |
| `.git`(共享,不复制) | 4.2 MB | — |
| `git worktree add` 的检出 | 4.1 MB | 0.08s |
| `node_modules`(gitignored,git 不碰) | 4.3 GB | — |

所以贵的从来不是仓库,是**依赖**。而新 worktree 里没有依赖,重装一次几分钟起步。

解法是 APFS 的写时复制(`clonefile`),Node 原生支持:

```ts
fs.cpSync(src, dst, { recursive: true, mode: fs.constants.COPYFILE_FICLONE_FORCE });
```

实测把 4.3 GB 的 `node_modules` 克隆进新 worktree:**11 秒,磁盘占用增量约等于 0**。
且已验证是真 CoW 而非硬链接 —— inode 不同,改克隆不会污染源目录。

要克隆哪些目录不靠猜,问 git:

```
git ls-files --others --ignored --directory --exclude-standard
```

它会把**完全被忽略的目录整个折叠**成一条,monorepo 里嵌套的
`apps/*/node_modules`、`packages/*/node_modules` 一并列出。

非 APFS(或跨卷)时 `FICLONE_FORCE` 会抛错,退回真实复制并把 `cow: false` 报上去,
让上层能提示"这次要占 4.3G"。

## 协调者 agent 的一轮

```
人:  给 coordinator 一个 objective
coordinator:  prospero task create --spec ... (×N,带 deps)
              prospero worker start --task t1 --agent claude --worktree new
              prospero check --wait            # 阻塞等 worker 回话
worker:       (被派发时收到任务前导词)
              ... 干活 ...
              prospero task done --id t1 --body "三句话摘要"
coordinator:  被唤醒 → 验收 → 派下一个 / 合并 worktree
```

`check --wait` 是长轮询(服务端挂起,有消息才返回),不是轮询循环 ——
agent 的每一次唤醒都要花 token,不能让它空转。

## 分期

- **M1 地基**:Store + Worktree(含 CoW)+ 编排数据模型与状态机 ← 本次
- **M2 派发**:控制 socket + `prospero` CLI + dispatch(建会话、注入前导词、绑定)
- **M3 协作**:邮箱(send / check --wait / ask / reply)+ 决策门
- **M4 手机**:编排面板(任务图、worker 状态、插手与验收)
