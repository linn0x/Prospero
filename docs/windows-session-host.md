# Windows Session Host 架构与威胁模型

> 状态：设计与审计，尚未实现。目标平台为 Windows 11；`ConPTY` 的 API 最低支持 Windows 10 1809，但本项目不因此降低产品支持基线。
>
> 本文是 [structured-agent-supervisor.md](structured-agent-supervisor.md) 的 Windows 对应设计。它定义 **daemon 重启可存活** 的 PTY 与 structured 会话，不改变手机—daemon 的 E2E 鉴权边界，也不声称当前 Windows 版本已有这一能力。

## 结论

Windows 不能把 Unix 的「detached Node 进程 + Unix domain socket + POSIX mode bits + process group」逐项替换为 `detached: true` 和 `\\\\.\\pipe\\...`。正确的持久化边界是每个会话一个独立的 **Windows Session Host**：daemon 只是可以替换的、经过认证的 IPC 客户端；host 才拥有适配器、ConPTY、子进程树、事件 journal 和显式 kill 的权力。

Windows host 必须经原生 Win32 边界提供以下能力：

- `CreatePseudoConsole` / `ResizePseudoConsole` / `ClosePseudoConsole`；
- 用明确 DACL 创建 Named Pipe，且核验连接端 token、PID 与 creation time；
- `CreateProcessW`、`GetProcessTimes`、受限句柄继承，以及 Job Object；
- `TerminateJobObject` 的树级显式 kill；以及
- Windows ACL/DPAPI/重解析点安全的状态目录操作。

现有 Node 和 `node-pty` API 不完整暴露这些保证。Gate 已决定采用预编译 N-API 模块；在该模块的 Windows x64/arm64 构建、校验、发布和本文件的验收矩阵通过前，Windows 仍维持现状：直接 PTY 与 daemon 内 structured adapter；不得为它们宣称 daemon 独立生命周期。

## 当前实现审计（2026-08-15）

| 区域 | 已有行为 | Windows 缺口 / 结论 |
| --- | --- | --- |
| [`pty-session.ts`](../apps/daemon/src/pty-session.ts) | `PtySession` 用 `node-pty` 直接 spawn，`@xterm/headless` 保存画面，`OutputRing` 仅在 daemon 内存；`kill()` 是 `IPty.kill()`。 | 没有 host、Job Object 或持久 terminal reducer。`node-pty` 的内部后端不能代替 Prospero 对 ConPTY、子树收口和恢复的所有权。daemon 死亡后不能恢复它的 PTY。 |
| [`tmux.ts`](../apps/daemon/src/tmux.ts) 与 [`session-manager.ts`](../apps/daemon/src/session-manager.ts) | Unix/macOS 的 PTY 可由 tmux 接管；`disposeAll()` 只断 client，`kill()` 会 `tmux.killSession()`。 | `tmuxPath("win32")` 明确返回 `null`，Windows 回落为直接 PTY；`pty-sessions.json` 不是活进程身份或 screen 的恢复依据。 |
| [`structured-supervisor.ts`](../apps/daemon/src/structured-supervisor.ts) | Unix socket + 256-bit token + 有序 journal/replay；显式 `session.kill` 与客户端断开分离。 | `startStructuredSupervisor()` 在 `win32` 直接报 `unsupported_platform`。Unix socket stale probe、`chmod(0600)`、socket unlink 都不能移植为 Pipe ACL 语义。 |
| [`structured-supervisor-client.ts`](../apps/daemon/src/structured-supervisor-client.ts) / runner | Unix 用 `detached: true`、负 PID process group 回滚、短 `/tmp` socket；manifest 目前仅记录 PID，无 creation time。 | `launchStructuredSupervisor()` 和 `reconnectStructuredSupervisors()` 在 Windows 分别拒绝/返回空。负 PID signal、`SIGTERM/SIGKILL`、`/tmp` 均无等价物；PID 单独不能抵抗 PID reuse。 |
| [`session-manager.ts`](../apps/daemon/src/session-manager.ts) | production Unix 才启用 remote structured supervisor；启动时先 reattach manifest，失败者只读；`disposeAll()` 对 remote facade 只关 socket。 | `useStructuredSupervisor` 明确要求 `process.platform !== "win32"`。Windows 恢复会跳过所有 host manifest；in-process `structured-sessions.json` 不能拥有活 adapter。 |
| [`control-socket.ts`](../apps/daemon/src/control-socket.ts) | Windows 路径已是哈希化 `\\\\.\\pipe\\prospero-…`，仍用 Node `net.createServer()` 和 NDJSON token。 | Node 路径名不是 DACL：当前代码不能传入 `SECURITY_ATTRIBUTES`，`chmod(0600)` 在 Windows 不形成 ACL 保证，且没有 `GetNamedPipeClientProcessId` / token SID 检查。它是 worker 控制 pipe，不应误当 session host pipe。 |
| 启动与恢复 | [`ws-server.ts`](../apps/daemon/src/ws-server.ts) 先开 control socket，再恢复 tmux/structured，最后 reconcile orchestration。 | 新 host 必须在恢复期先完成 manifest—PID—pipe identity 核验，再允许 UI 或 orchestration 发送命令；永不从 stale manifest 自动 spawn replacement。 |

现有 Unix 覆盖了 transport/replay 的重要语义，但 `structured-supervisor*.test.ts`、`daemon-supervisor-recovery.e2e.test.ts` 和 launch rollback 测试均以 `skipIf(process.platform === "win32")` 排除 Windows。当前 Windows CI 只能证明常规 Node 行为，不能证明 durable host。

## 目标边界

```text
已配对手机 / relay
        │ E2E WebSocket（不变）
        ▼
prosperod daemon（可重启、可升级、无会话树所有权）
        │ host Named Pipe：ACL + peer token + capability + protocol version
        ▼
每会话 Windows Session Host（detached，唯一 owner）
        ├── durable manifest / snapshot / append journal / attachment custody
        ├── structured：adapter + native provider connection/child
        └── PTY：terminal reducer + ConPTY + native child Job Object
                                      │
                                      ▼
                           agent/provider 及其受控子树
```

`WindowsSessionHost` 是一个 detached 的 Node runner 进程；它加载 session reducer 与 provider adapter。Gate 已决定它的 Win32 操作由随 daemon 发布的**预编译 N-API 模块**提供。该模块是唯一可调用 ConPTY、ACL pipe、process identity、DPAPI 和 Job Object 的平台层；不引入签名 helper EXE 或第二个 public IPC 边界。**host runner 才是 public IPC、journal 和 session ownership 的唯一边界**。

对于 PTY，host 持有 ConPTY 的输入/输出、`@xterm/headless` snapshot 和 output ring。对于 structured，host 持有 adapter 的 SDK/stdio/HTTP 连接及其 pending approval callback；daemon 内只有 `RemotePtySession` / `RemoteStructuredSession` facade。两个会话类型共享同一 manifest、IPC、journal、恢复与 kill 规则。

### 不共享的两个本机 IPC 边界

| Pipe | 谁监听 | 谁可连接 | 用途 | 不能混用的原因 |
| --- | --- | --- | --- | --- |
| `control` | daemon | worker CLI / 本机 control client | `task.done`、编排等 daemon RPC | worker 有不同的最小权限、生命周期和命令表；它不拥有 agent session。 |
| `session host` | 每个 host | 当前 daemon（一次可替换的 lease） | session subscribe/send/input/resize/approval/interrupt/kill | 这里的 token 只能操作一个 session，且 journal/Job Object 的 owner 是 host。 |

两者都使用 versioned framed RPC，但 capability、pipe name、ACL、审计 ID 和限流各自生成。禁止复用 `PROSPERO_CONTROL_TOKEN_PATH` 作为 host token；也禁止把 host pipe 暴露给 LAN、WebSocket、Codex app-server 或 provider。

## Native primitives 与进程树

### ConPTY（PTY 会话）

原生层应为一个新 terminal 创建同步 input/output pipe、调用 `CreatePseudoConsole(size, input, output, …)`，再以 `STARTUPINFOEXW` 与 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 启动 target。ConPTY 是 Windows 的 PTY 等价物，output 通道保证为 UTF-8；host 负责显示/收集输入，而不是依赖 `conhost` 窗口。[Microsoft: Pseudoconsoles](https://learn.microsoft.com/en-us/windows/console/pseudoconsoles) [Microsoft: CreatePseudoConsole](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)

要求如下：

- 仅 native host 管理 `HPCON`、进程与 pipe handle；daemon 永不直接保存/关闭它们。
- host 在独立 reader worker 上持续 drain output，传入 xterm reducer，并以持久 `pty.output` journal record 再向 daemon 广播。resize 先持久化 intent，再 `ResizePseudoConsole`，最后广播新的 cols/rows。
- host 只向目标进程传递最小 handle list；Job handle、journal、manifest token、host control pipe 不可继承。不可把 `bInheritHandles=true` 当作控制边界。
- `ClosePseudoConsole` 会向仍连接的 client 发 `CTRL_CLOSE_EVENT`。较旧 Windows 版本中如果输出 pipe 未关闭或持续 drain，调用可能无限等待；它不得运行在唯一 output reader 线程。实现必须先做 Job Object 终止/等待、关闭 host input、继续 drain output，最后在独立线程 close HPCON。Windows 11 24H2 改善了这个行为，但不能把 24H2 当唯一受支持的 Windows 11 版本。[Microsoft: ClosePseudoConsole](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)

`session.interrupt` 对 PTY 是尽力输入 Ctrl-C / provider interrupt，仍允许以后 `send`；它不是 kill，也不等价于安全地结束进程树。

### detached host 与 Job Object

`child_process.spawn({ detached: true, stdio: "ignore" }).unref()` 只是 Node 层的必要条件：在 Windows 它使 child 有机会在 parent 退出后继续运行；它不处理 parent 所在 Job 的 kill-on-close、host 身份、子树或 IPC ACL。[Node: child_process detached](https://nodejs.org/api/child_process.html#optionsdetached)

native launcher 的规则：

1. 以 `CreateProcessW` 启动 host（完整 `lpApplicationName`、Unicode argv/environment、无可见 console 的显式 creation-flag 组合），不从 shell 拼接 command line。host 自身的 detached 启动和 ConPTY target 的 `STARTUPINFOEXW` 启动是两条分别测试的路径，不能把一组 creation flags 盲目复用到两者。
2. 先以 `IsProcessInJob` 检测 daemon 是否被外部 Job 管理。若它位于 `KILL_ON_JOB_CLOSE` Job，只有该外层 Job 显式允许 `CREATE_BREAKAWAY_FROM_JOB` 时才能让 host break away；不允许时，**拒绝创建 durable session** 并报 `parent_job_prevents_detach`，不要默默降级为“可恢复”。[Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) [Microsoft: process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
3. host 为其实际 agent/provider tree 创建一个未命名 Session Job，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不设置 `BREAKAWAY_OK` 或 `SILENT_BREAKAWAY_OK`，并保留唯一非继承的 job handle。
4. target 要在创建时或被 resume 前加入该 Job。若 provider 已在不可嵌套/不兼容 Job，或 `AssignProcessToJobObject` 失败，记录 `provider_job_incompatible`、清理本次 host，不启动 durable session。Windows 11 支持 nested jobs 不表示每个第三方 provider 都兼容它。
5. 显式 kill 走 `TerminateJobObject`，而不是 `taskkill /T`、按进程名枚举或只杀 manifest PID。host 退出/被 force-kill 时其唯一 job handle 关闭，`KILL_ON_JOB_CLOSE` 作为最终收口。

这给 Prospero 一个可审计的 owner tree，不给 provider 任意 breakaway 权。Job Object 默认会将 `CreateProcess` 的 child 置入 job；一旦 allow breakaway，就会失去完整子树可见性/kill 承诺，故默认禁止。[Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

## Named Pipe、认证与进程身份

### Pipe 创建

每个 epoch 创建随机且不可预测的 endpoint，例如：

```text
\\.\pipe\prospero.v2.<logon-sid-hash>.<session-id>.<epoch-random>
```

host 在 pipe 已由 `CreateNamedPipeW` 成功创建、DACL 已读取回核验后，才可以把 endpoint 写入 manifest。第一实例使用 `FILE_FLAG_FIRST_PIPE_INSTANCE`，message mode，`PIPE_REJECT_REMOTE_CLIENTS`；如需并发 handoff 则由 host 自己创建额外实例，所有实例使用同一经过验证的 DACL。Pipe 名有 256 字符上限，且不区分大小写，设计不得从长工作目录派生。[Microsoft: CreateNamedPipe](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea)

`SECURITY_ATTRIBUTES` 的 DACL 至少要：

- 允许当前 **logon SID**（不只是 account SID）对 client 侧所需 `READ_DATA`、`WRITE_DATA`、属性读取与 `SYNCHRONIZE`；logon SID 能阻止另一 Terminal Services logon session，且 remote clients 一律拒绝；
- 默认只建一个可重复 `DisconnectNamedPipe` 的 server instance，DACL 不给 client `FILE_CREATE_PIPE_INSTANCE`。若升级 handoff 需要额外 instance，host 必须在首实例仍持有名字时自行创建；同一 logon SID 内无法由 DACL 区分 host 与 daemon，故仍须 random name、capability 与 lease。不可用 `FILE_GENERIC_WRITE`，因为它包含相同位的 instance-create 权；
- 明确拒绝 `ANONYMOUS LOGON`、`NETWORK` 与 `Everyone` 的宽泛访问；创建后以 `GetSecurityInfo` 比对预期 descriptor，失败则不 listen；以及
- 在不需要服务化时不额外给 Administrators 或 SYSTEM 普通 data access。具备管理员/调试特权的本机攻击者不在此 ACL 的可防御范围内。

默认 Named Pipe DACL 可把 read access 给 Everyone 和 anonymous，不能依赖它。[Microsoft: Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)

### 双重认证与 lease

每个连接先受 pipe DACL 限制，再完成以下无副作用握手；未完成前只允许固定大小 `hello`，不允许 subscribe、send、kill 或任意 adapter call：

```json
{
  "v": 2,
  "method": "host.hello",
  "params": {
    "sessionId": "…",
    "epoch": "…",
    "daemonInstanceId": "uuid",
    "daemonPid": 1234,
    "daemonCreationTimeFileTime": "134001234567890000",
    "capability": "base64url-256-bit",
    "lastAckedSeq": 912
  }
}
```

host 要在**读到 hello 后**调用 `GetNamedPipeClientProcessId`，以 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)` 打开该 PID，调用 `GetProcessTimes` 读 creation time，并和 hello 中的 PID/creation time 及同一连接的 impersonated token 比对。token 比对使用 `ImpersonateNamedPipeClient` → `OpenThreadToken`/`GetTokenInformation`（`TokenUser`、logon SID、integrity level）→ 总是 `RevertToSelf`。任一步失败则断开，绝不能在 host 自身权限下继续执行请求；微软也明确要求 impersonation 失败时不执行 client 请求。[Microsoft: GetNamedPipeClientProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid) [Microsoft: ImpersonateNamedPipeClient](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient)

capability 是另一层 256-bit constant-time comparison，并有每连接随机 challenge/response，防止普通 pipe client 或旧 connection replay。daemon 以 DPAPI current-user 密文保存 capability（文件只含版本、key id、密文和 session/epoch binding，manifest 不含 raw token）；raw token 不得出现在 argv、environment、日志、crash report、WebSocket、状态文件或 error message。DPAPI 提高静态文件泄露门槛，不把同一受损 user principal 变成可信边界。

host 每时刻只授予一个 `daemonInstanceId` 可变命令 lease。一个已认证新连接只能在旧连接已断开，或收到同 capability 的有序 `host.handoff` 后取代 lease；它不能让两个 daemon 同时发送 non-idempotent commands。read-only status 可以被独立短连接获取，但仍需认证并限流。

### PID + creation time 的用途

PID 从不单独成为授权或 kill 依据。manifest 中记录 host 的 `{ pid, creationTimeFileTime }`，启动恢复或 force-kill 时必须以受限 process handle 重新读 `GetProcessTimes`，严格匹配后才可 connect 或终止。`GetProcessTimes` 返回的 creation time 是 FILETIME；以十进制字符串持久化以避免 JavaScript number 精度截断。查询所需的最小访问权是 `PROCESS_QUERY_LIMITED_INFORMATION`（或更高的 query right）。[Microsoft: GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) [Microsoft: process access rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)

同样，host 检查 daemon peer tuple 防止其把断开的 PID 值误关联到已复用的新进程。PID/creation time 不证明进程“良性”，只消除 PID reuse 和 stale-manifest 的错杀类别；有效 DACL、capability、protocol epoch 仍是必要条件。

## 持久化格式

每会话在 `%LOCALAPPDATA%\Prospero\session-host\<session-id>\` 中拥有一个 ACL 受限目录。native filesystem 层必须拒绝 reparse point/symlink traversal、用最终路径句柄核验其仍在 root 下，并使用当前 logon user 的 DACL 创建目录。不能把 POSIX `chmod(0600)` 当作 Windows 访问控制。

```text
session-host/<session-id>/
  manifest.json             # 小、原子替换、无 secret
  capability.dpapi          # DPAPI 密文，非 raw token
  snapshot.json             # reducer + native resume cursor + terminal snapshot
  journal-000017.psj        # append-only framed records
  attachments/<attachment>  # host-owned immutable copies，ACL/reparse-safe
```

### `manifest.json`（schema 2）

```json
{
  "schema": 2,
  "implementation": "windows-session-host",
  "sessionId": "2d0a…",
  "kind": "pty",
  "agent": "codex",
  "createdAt": 1786782000000,
  "lifecycleEpoch": "443a…",
  "state": "running",
  "host": {
    "pid": 4180,
    "creationTimeFileTime": "134001234567890000",
    "exe": "C:\\…\\node.exe"
  },
  "ipc": {
    "protocolVersion": 2,
    "pipeName": "\\\\.\\pipe\\prospero.v2.…",
    "aclProfile": "current-logon-sid-v1",
    "remoteClients": "rejected",
    "capabilityStorage": "capability.dpapi"
  },
  "owner": {
    "job": "session-job",
    "killOnClose": true,
    "breakaway": "forbidden"
  },
  "journal": { "generation": 17, "snapshotSeq": 900, "lastSeq": 912 },
  "native": { "providerCursor": { "threadId": "…" } },
  "updatedAt": 1786782012345
}
```

`state` 包括 `preparing | starting | ready | running | waiting_approval | waiting_input | completed | kill_requested | killed | died | unavailable`。`host` creation time、epoch、pipe name 和 last sequence 是恢复安全条件，不是 UI 的可修改元数据。manifest 要先写 `preparing`，host 建 pipe/Job 后写 `ready`；若 launch 回滚，应保留 `died` 审计 manifest 而不是删除整目录。

通过临时同目录文件、`FlushFileBuffers`、native atomic replace（例如 `ReplaceFileW`/等价受控 rename）写 manifest 与 snapshot。最后一次写失败保持旧文件可解析；任何损坏/未知 schema/ACL 不合格的 manifest 都是 `unavailable`，只读且不得自动覆盖。

### `.psj` journal（schema 2）

每条 record 是固定头加 UTF-8 JSON payload 的 append frame，避免 JSONL 截断无法区分传输噪声与异常尾：

```text
magic "PSJ2" | payloadLength:u32le | crc32c:u32le | UTF-8 JSON payload
```

```json
{
  "v": 2,
  "sessionId": "2d0a…",
  "epoch": "443a…",
  "seq": 912,
  "at": 1786782012345,
  "type": "pty.output",
  "body": { "dataB64": "…", "cols": 120, "rows": 40 },
  "commandId": null
}
```

有效 `type` 至少包括：`host.started`、`pty.output`、`pty.resize`、标准化 structured `agent.event`、`permission.request/resolved`、`question.request/resolved`、`command.accepted`、`command.result`、`interrupt.requested`、`kill.requested`、`job.terminated` 与 `host.terminal`。record 必须 session/epoch/seq 连续、大小受限、校验和正确；末尾不完整 frame 仅可作为 interrupted tail 丢弃，后续 seq 不得跨过它伪造连续性。

append 后先 `FlushFileBuffers`，再更新内存 ring/通知 IPC client；这保证 daemon restart 只会 at-least-once replay，并按 `(sessionId, epoch, seq)` 去重。它不保证 native provider 的 exactly-once execution：若 host 在 provider 已接受 `send` 而 `command.result` 落盘前崩溃，command 标为 `unknown_outcome`，不得静默重发。

`snapshot.json` 包含 reducer 状态、pending request IDs、terminal fence、PTY ANSI snapshot/output cursor 或 structured provider resume cursor、`snapshotSeq`。compaction 顺序固定为：flush journal → 原子 snapshot at `N` → 创建并 flush new generation → 原子 manifest 指向 new generation → 最后保留或延迟删除旧 generation。崩溃时允许重复 replay，不允许少事件；retention advancement 回 `gap: true`，daemon 必须取得 snapshot 而不是声称精确增量。

## 生命周期与失败语义

```text
                 +-- launch failure --> died (audit-only)
preparing -> starting -> ready -> running <-> waiting_approval
                                      |  \-> waiting_input
                                      |            |
                                      +--------> completed -- send --> running
                                      |
                               interrupt (nonterminal)
                                      |
                                      v
                              kill_requested -> killed

any live state -- host identity absent --> died (read-only)
any live state -- identity/ACL/pipe unverifiable --> unavailable (read-only, not presumed dead)
```

| 事件 | required action | 不得发生的事 |
| --- | --- | --- |
| daemon 正常退出 / `SIGTERM` 对 daemon | daemon 仅关闭 host pipe facade；host 和 Session Job 保持运行，继续 journal，pending approvals 保持 pending。 | `disposeAll()` 不得向 host 发送 interrupt、dispose、kill，不能关闭 HPCON/Job。 |
| daemon 被强杀 | host 收到 broken pipe 后不作 native cancel；新 daemon 通过 manifest identity + pipe handshake 重连并从 `lastAckedSeq` replay。 | 不得因 daemon 消失 auto-approve、auto-deny（除非预先记录的显式 policy timeout），或启动第二个 host。 |
| host 自身 crash / OS 强杀 host | host 的 Session Job handle 关闭，应终止受控 provider tree；下一 daemon 发现 host PID/creation time 不存在，暴露 `died` history 与 journal tail。 | 不得把 PID reuse 的进程视为 owner，或自动重新执行上一条 queued/provider command。 |
| `session.interrupt` | journal `interrupt.requested`，尽力通知 adapter / 写 Ctrl-C；会话继续可用。 | 不得把 interrupt 当作 tree kill 或把它写成 terminal fence。 |
| `session.kill` | 先持久 `kill_requested` fence 与 commandId，拒绝后续 mutation；host 取消 adapter 后 `TerminateJobObject`，wait/记录 `job.terminated`，持久 `killed`，最后关闭 pipe/exit。重复 commandId 回同一结果。 | 不得仅 kill manifest PID、按名称扫描、`taskkill /T` 猜树，或在 event late arrival 时复活 session。 |
| daemon admin/repair force-kill | 操作工具必须要求 session ID，读取 manifest 后匹配 PID + creation time + host pipe `status` epoch，才用受限 host handle `TerminateProcess`；等待 handle signaled，Job close 收口。 | identity 不匹配/查询失败时不得发 signal；状态改 `unavailable` 并请求人工处理。 |
| rolling upgrade | 新 daemon 先做 read-only validation；通过 authenticated handoff 取得 lease 后旧 daemon 关闭 facade。 | 两个 daemon 同时发送 mutation；为了升级 kill 运行中 host。 |

approval/question 的底线与 Unix supervisor 一致：daemon offline 表示等待，不表示允许。host 从 journal/snapshot 重放原 `reqId`；reply 只接受该 ID，先持久 resolution 再转发 adapter。host 崩溃后无法泛化重建 SDK callback 时标 `needs_reconciliation`，不伪造 reply。

## 威胁模型与安全要求

| 威胁 | 控制 | 剩余边界 |
| --- | --- | --- |
| 另一用户、remote SMB client、另一 RDP logon session 连接 pipe | random name、`PIPE_REJECT_REMOTE_CLIENTS`、精确 logon-SID DACL、peer token 核验、capability。 | 管理员或具备调试/取所有权特权者不受普通 user DACL 限制。 |
| Pipe name 预创建/劫持 | pipe 先创建后发布 endpoint；首 instance 用 `FILE_FLAG_FIRST_PIPE_INSTANCE`；连接前 identity + capability handshake。 | 同一受损 logon session 可观察/注入/调试 user process，不是本设计能隔离的 hostile principal。 |
| token 出现在日志、argv、环境、manifest | raw token 仅 host/daemon 内存与 DPAPI ciphertext；bootstrap 只含密文路径；redact error。 | 同一用户可运行任意代码或读 host 内存时，DPAPI current-user 不能保护它。 |
| PID reuse 导致 attach/kill 错对象 | manifest 记录 FILETIME creation time；每次 `OpenProcess` 后重读匹配；Job handle 而非 PID 负责常规 kill。 | image path/hash 是附加诊断，不能单独认证 executable。 |
| 子进程逃逸或进程名误杀 | Session Job 默认禁止 breakaway、最小 handle inheritance、`TerminateJobObject`。 | provider 通过服务、计划任务、Docker、远程 API 或被外部 Job 管理产生的进程不一定属于 Job。 |
| journal 损坏、部分写入、重复重放 | framed CRC record、flush-before-visible、snapshot generation，按 epoch/seq 去重。 | 电源丢失后最后未 flush output/事件可能丢失；不能凭此承诺完整 terminal transcript 或 exactly-once agent actions。 |
| 路径替换/attachment traversal | native canonical-handle traversal，拒绝 reparse point，attachments 由 host copy/hash/ACL；IPC 只传 attachment ID。 | 已获同用户完全文件系统控制的攻击者在 host 启动前后仍不在目标防护模型。 |
| provider 启动命令注入 | `CreateProcessW` 指定完整 `lpApplicationName`、结构化 argv、Unicode environment；不得通过 `cmd.exe`/PowerShell 重新解释 session-host/provider launch。 | 用户明确创建的 `custom` shell command 本身拥有用户选择的 shell 语义。 |

额外运行时要求：所有 frame 有最大大小与解析深度；protocol/method 白名单；auth 和 bad-frame telemetry 不记录 token/prompt/attachment 内容；IPC rate limit；所有 native handle RAII close；host 的 crash dump 默认不含 secret；DACL/DPAPI/creation-time native 调用都有不依赖管理员的 Windows 11 integration test。

## 明确无法承诺的边界

- 不承诺 daemon 之外的 host crash 后自动恢复某 provider 的 in-flight native turn；只在 adapter 经实测支持 resume cursor 时提供显式、可审计的 reclaim。
- 不承诺 host 位于禁止 breakaway 的外层 Job、用户注销、系统关机、休眠、电源故障或企业 EDR 强制终止时的会话存活。遇到 parent Job 不兼容必须 fail closed。
- 不承诺 kill 终止 Job 之外的副作用：远程 API 请求、云任务、已提交 git 操作、service/scheduled-task/Docker child，或 provider 故意 break away 的对象。
- 不把同一 Windows user/logon session 内的恶意代码视为可由 DACL + DPAPI capability 隔离的攻击者；本地管理员更不在该边界内。
- 不承诺 ConPTY 与所有 legacy GUI/console、Windows service、elevated/跨 integrity provider 的兼容性。遇到 unsupported console/provider 给清晰错误，不回落到谎称 durable 的 daemon PTY。
- 不承诺 native command exactly once；mutating command 的 crash ambiguity 需要 idempotency key、provider support 或人工 reconciliation。

## 分阶段改造清单

| 阶段 | 文件 | 工作与退出条件 |
| --- | --- | --- |
| 0：产品 gate（已决） | `gate_5a655a0ec88b` | 采用预编译 N-API；实现与 release 不得改回 helper EXE 或 runtime download。未通过架构 build/校验前仍维持 Windows direct-only。 |
| 1：platform primitives | 新增 `apps/daemon/src/windows/session-host-native.ts`、`apps/daemon/src/windows/named-pipe.ts`、N-API package 与其 publish config；`apps/daemon/package.json` | 暴露 ConPTY、ACL pipe、DPAPI、process identity、Job/launch；没有任何 `chmod` 伪装为 ACL。为 Windows x64 和 arm64 各发布 prebuild，CI 验证 Node N-API ABI、目标架构、加载 smoke test 与发布 SHA-256/integrity manifest；安装时绝不 runtime download 或本机静默编译。 |
| 2：公共 host transport | 将 [`structured-supervisor.ts`](../apps/daemon/src/structured-supervisor.ts) 的 protocol/replay reducer 拆到平台无关模块；新增 `windows-session-host-protocol.ts` 与 `windows-session-host-runner.ts` | 保留 Unix 行为；Windows 支持 framed pipe、lease、manifest v2、snapshot/journal、token/peer check。 |
| 3：PTY vertical slice | 新增 `remote-pty-session.ts`；改 [`pty-session.ts`](../apps/daemon/src/pty-session.ts)、[`session-manager.ts`](../apps/daemon/src/session-manager.ts) | 新 PTY 通过 host + ConPTY；daemon facade 提供 input/resize/snapshot/seq。旧 direct PTY 保持明确 fallback，feature flag 只给新 Windows session。 |
| 4：structured migration | 改 [`structured-supervisor-client.ts`](../apps/daemon/src/structured-supervisor-client.ts)、[`structured-supervisor-runner.ts`](../apps/daemon/src/structured-supervisor-runner.ts)、adapter spawn seams | host 拥有 Claude/Codex/OpenCode/Grok adapter 与 native children；每个 adapter 分别证明 resume、pending approval 与 Job 兼容性，不批量假定。 |
| 5：manager/control/recovery | 改 [`session-manager.ts`](../apps/daemon/src/session-manager.ts)、[`ws-server.ts`](../apps/daemon/src/ws-server.ts)、[`control-socket.ts`](../apps/daemon/src/control-socket.ts)、[`status-file.ts`](../apps/daemon/src/status-file.ts) | `disposeAll()` 仅 close facade；startup 安全扫 manifest；Windows control pipe 改为 ACL/token native pipe；状态中精确报 `hosted/direct/unavailable`。 |
| 6：tests/CI/ops | 新增 `windows-session-host*.test.ts`、Windows fixture、更新 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)、README/technical overview/runbook | Windows runner 实机执行下表 P0；签名/defender/upgrade telemetry；无论 feature flag 如何，都不把不兼容状态误报可恢复。 |

现有 [`structured-agent-supervisor.md`](structured-agent-supervisor.md) 的 Unix process-group rollback 保持原样；不要在其函数里加入 `if (win32)` 的半实现。Windows 应通过明确的 platform abstraction 接入，避免混用 `SIGKILL`、负 PID 与 Job Object。

## 已决的产品/分发 Gate

这个设计不可避免地引入影响依赖和发布的选择：安全 ConPTY、Named Pipe ACL、capability/token SID 核验、PID creation time 与 Job Object 不由现有 Node API 完整提供。

协调者已为 `run_fed56178b183` / `task_c05c2917e01e` 创建并决议 Gate **`gate_5a655a0ec88b`**：

> Windows Session Host 的原生边界采用哪种分发方案？

1. **预编译 N-API 模块（已选）**：随 daemon npm 包按 Windows x64/arm64 分发，给 host 一套类型化 API；public IPC 最少，适合把 ConPTY、pipe ACL、Job 和 process identity 收敛在同一审计单元。每个 release 必须由 Windows x64/arm64 CI 构建、加载测试、记录二进制 SHA-256 与 npm integrity，并以签名发布工件/可验证 provenance 交付；安装器只选择匹配 `process.platform`/`process.arch` 的随包 prebuild，不下载或编译未知二进制。代价是 native ABI、prebuild、签名和 supply-chain 维护。
2. **签名 helper EXE**：Node host 以受限私有 IPC 调 helper；隔离 ABI，但增加 EXE 签名、升级、Defender/EDR 兼容、私有二进制协议和安装体积。
3. **不引入原生边界**：Windows 保留直接 PTY / 禁用 durable session host；发布简单，但不满足本 Run 的 durability 目标。

决议为：「采用预编译 N-API 模块：Node 内直接调用 Win32；维护 Windows x64/arm64 N-API 构建、校验与发布。」本 worker 曾因权限限制将 gate 创建请求上报 coordinator；该决议现已解除产品选择阻塞。实现必须遵守上述 release 约束，不能以 helper EXE、runtime download 或 source-build 取代已决 N-API 分发。

## Windows 验收矩阵

所有 P0 用隔离 temporary `%LOCALAPPDATA%`、随机 pipe/port、假 provider 和测试拥有的 PID/Job；不得枚举、kill 或重用用户现有 process/pipe。`SIGTERM/SIGKILL` 测试在 Windows 分别以 daemon normal exit、`TerminateProcess` 和受控 Job 语义表达。

| 优先级 | 场景 | 操作 | 断言 |
| --- | --- | --- | --- |
| P0 | Pipe ACL / squatting | 另一 SID、另一 logon session、remote client、预创建同名 pipe 分别连接/抢占。 | DACL 拒绝；remote 被拒；first-instance collision fail closed；host 不发布被劫持 endpoint。 |
| P0 | Peer/auth | 正确与错误 capability、错误 epoch、错误 protocol、超大 frame、PID/creation-time mismatch。 | 仅正确 hello 获 lease；无副作用 RPC；token 不在日志；错误连接不影响活动 daemon。 |
| P0 | PID reuse 防错杀 | 用 manifest 的旧 PID + 不同 creation time 模拟新 process，执行 attach/force-kill。 | 不 connect、不 `TerminateProcess`、状态为 `unavailable`；测试 sentinel 存活。 |
| P0 | PTY ConPTY | PowerShell/cmd fake TUI 的 output、UTF-8、resize、DSR/DA/OSC、1KB 分片 input。 | snapshot + ordered seq 一致；daemon 重连不丢/重放错误；host 而非 daemon 持有 terminal。 |
| P0 | daemon 正常退出 | PTY 和 structured fake 中间输出后关闭 daemon。 | host PID/creation time 未变；输出继续 journal；第二 daemon exact/gap-correct replay；无 auto approval。 |
| P0 | daemon 强杀 | `TerminateProcess` 测试 daemon，host 继续写 long-turn marker。 | 同上；旧 peer lease 消失、新 daemon 能认证接管；没有 duplicate host/native turn。 |
| P0 | explicit interrupt / kill | 先 interrupt，再 kill；重放同一 commandId；并测试 host force-kill。 | interrupt 非终态；kill journal fence 在前、`TerminateJobObject` 收口、后续 mutation 拒绝；host force-kill 关闭 Job 并杀 test-owned child tree。 |
| P0 | outer Job 禁止 breakaway | 将 test daemon 放入 kill-on-close Job 且不允许 breakaway，再请求 durable host。 | 创建拒绝 `parent_job_prevents_detach`，没有“存活”错报，也没有残留 host。 |
| P0 | journal crash/compaction | 在 append、snapshot replace、generation switch 各阶段杀 host。 | 解析至最后有效 CRC frame；无 seq 跳跃；重复可去重；未知 native command 不自动 replay。 |
| P0 | pending approval/question | daemon offline 时产生 request，重连后 reply 原 reqId；host crash case。 | offline 只等待；resolution 先落盘；host crash 标 reconciliation，不批准/伪造。 |
| P1 | provider/Job 兼容 | Claude/Codex/OpenCode/Grok 各自以 fake + 可选真实 installed CLI 验证 nested Job/child spawn。 | 不兼容明确拒绝或受限标记；没有 claim 全树 kill。 |
| P1 | ACL/path safety | capability、manifest、snapshot、attachment root 的 ACL、reparse point、path traversal 和 replace race。 | 仅预期 SID 可访问；不跟随 reparse point；manifest 从不含 raw token。 |
| P1 | 升级/回滚 | 新 daemon authenticated handoff，旧 daemon 关闭；不兼容旧 daemon 回读 manifest。 | 单 writer lease；host 不被升级杀死；不兼容者只读。 |
| P1 | Windows editions/architectures | Windows 11 23H2 + 24H2；Windows x64 与 arm64 都必测。 | ConPTY close 无 deadlock；匹配架构的 N-API prebuild 可验证加载，SHA-256/npm integrity/provenance 与 release artifact 一致；结果写入 release evidence。 |
| P2 | EDR/Defender、logoff、sleep、provider external side effects | 真实企业配置与人工场景。 | 记录兼容/失败原因；不把失败扩展为 unsupported durability claim。 |

通过 P0 前，CI 应继续把 Windows supervisor 相关测试标为明确 `unsupported`，而不是取消 skip 后得到偶然绿色。P0 通过后才可移除这些 Windows skip，并将 Windows durable PTY/structured feature flag 从实验性升级为默认候选。
