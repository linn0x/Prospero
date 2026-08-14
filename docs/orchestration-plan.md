# 多 Agent 编排(自研)

> Prospero 差遣 Ariel。这份文档是「怎么同时差遣一群」。

## 目标

一个协调者 agent 拆任务、派活、验收;若干 worker agent 并行干活,彼此隔离;
人在手机上随时能看、能插手。全部自研,不依赖任何外部 IDE 的编排能力。

**非目标**:不做通用工作流引擎,不做 DAG 调度器。任务图能表达依赖就够了。

## 为什么把编排建在 Prospero 里

终端型编排通常把 Run/Task/Dispatch 绑在自己管理的 PTY 上,容易遇到两类问题:

| | 常见终端型做法 | Prospero 已有的 |
| --- | --- | --- |
| **agent 状态** | hook 脚本 HTTP 回报 + 扫终端标题里的 `✳ ✦ ⏲`,抓不到就靠输出静默猜 | 适配器**原生**给 `running / waiting_approval / waiting_input / idle / done`,外加 `busySince`、`pendingPermissions`、`pendingQuestions` |
| **会话身份** | terminal handle 绑在管理进程上,管理器一重启就要重新绑定 | 会话 id 持久(`prospero-<id>` tmux + `pty-sessions.json`),daemon 重启后原样还在 |

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
把“暂时空闲”当作“已经交付”会制造无法可靠恢复的误报。

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

解法是只为明确依赖目录（目前为各层 `node_modules`）使用 APFS 的写时复制
(`clonefile`)。macOS 通过显式绑定的系统 `clonefile` 调用确认成功，不能把
`cp -c` 的成功当作 CoW；非 macOS 才使用 Node 的 `COPYFILE_FICLONE_FORCE` 严格语义。
正常 `git worktree add` 只检出 tracked 快照，所有 ignored 目录先留在源仓，
因此 `build/`、`.cache/`、`.expo/`、`ios/build/`、`.claude/` 不会短暂进入目标。

若 CoW 不可用（例如 `ENOSYS` 或跨卷 `EXDEV`），默认保留干净 checkout 并跳过依赖；
目标可自行安装。只有显式 `--copy-fallback` 才会在所有实体写入前估算候选依赖、检查
可用空间、8 GiB 单次上限和 4 GiB 安全保留，拒绝时报告原因且不复制任何目录。

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
