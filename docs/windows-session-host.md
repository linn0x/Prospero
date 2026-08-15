# Windows Session Host 架构与威胁模型

> 状态：Windows PTY 与 structured vertical 均已实现。目标平台为 Windows 11；`ConPTY` 的 API 最低支持 Windows 10 1809，但本项目不因此降低产品支持基线。
>
> 本文是 [structured-agent-supervisor.md](structured-agent-supervisor.md) 的 Windows 对应实现说明。PTY 与 Claude Code、Codex、OpenCode、Grok structured 会话均可由 **daemon 重启可重连** 的 Session Host 托管；不改变手机—daemon 的 E2E 鉴权边界。日常重启、故障和不承诺的机器生命周期场景见 [Windows Session Host 运维与排障](windows-session-host-operations.md)。

## 结论

Windows 不能把 Unix 的「detached Node 进程 + Unix domain socket + POSIX mode bits + process group」逐项替换为 `detached: true` 和 `\\\\.\\pipe\\...`。正确的持久化边界是每个会话一个独立的 **Windows Session Host**：daemon 只是可以替换的、经过认证的 IPC 客户端；host 才拥有适配器、ConPTY、子进程树、事件 journal 和显式 kill 的权力。

Windows host 必须经原生 Win32 边界提供以下能力：

- `CreatePseudoConsole` / `ResizePseudoConsole` / `ClosePseudoConsole`；
- 用明确 DACL 创建 Named Pipe，且核验连接端 token、PID 与 creation time；
- `CreateProcessW`、`GetProcessTimes`、受限句柄继承，以及 Job Object；
- `TerminateJobObject` 的树级显式 kill；以及
- Windows ACL/DPAPI/重解析点安全的状态目录操作。

现有 Node 和 `node-pty` API 不完整暴露这些保证。PTY 与 structured 都通过预编译 N-API Session Host 使用这条边界；只有经过签名加载、完整能力集、状态目录、受认证 pipe 和 Job 全部可用时才声明 durable。原生 binding 在 **host 创建前**不可用时，PTY 与 structured 可以明确降级为 daemon 内 `direct` 会话；host 已启动后的 attach、identity、pipe、journal 或 Job-policy 错误会 fail closed，绝不通过补开 direct session 制造重复 agent。

## 当前实现审计（2026-08-15）

| 区域 | 已有行为 | 恢复与边界 |
| --- | --- | --- |
| [`windows-pty-host.ts`](../apps/daemon/src/windows-pty-host.ts) / [`windows-pty-session.ts`](../apps/daemon/src/windows-pty-session.ts) | 每个 Windows PTY 使用 detached Session Host；host 持有 ConPTY、xterm reducer、output ring/journal 与 provider Job。daemon 只持有 `RemoteWindowsPtySession` facade。 | manifest + PID/FILETIME + authenticated pipe 只允许 attach，不从 stale owner 重启；kill 先落 terminal fence，再 `TerminateJobObject`/关闭 ConPTY。`pty-session.ts` 仅在 pre-host native unavailable 时作为明确 non-durable fallback。 |
| [`windows-structured-session-host.ts`](../apps/daemon/src/windows-structured-session-host.ts) / [`windows-structured-session-client.ts`](../apps/daemon/src/windows-structured-session-client.ts) | 每个 Claude/Codex/OpenCode/Grok structured 会话也使用 detached host；host 拥有 adapter、pending approval/question、PSJ2 journal 和 Job，daemon 为 remote facade。 | daemon offline 时请求保持 pending；原 `reqId`、event sequence 和 terminal kill ledger 用于 reattach。native binding 缺失/ABI 或能力不足才回退 in-process；provider Job/identity 失败不降级。durable structured attachment custody 尚未实现，会明确拒绝该 attachment，而不改走不安全的 Node 路径。 |
| [`session-manager.ts`](../apps/daemon/src/session-manager.ts) | Windows 启动扫描 PTY 与 structured host record，先 reattach 既有 owner，再恢复 legacy in-process history；`disposeAll()` 对 Windows remote facade 只断 pipe client。 | 有效 owner 为 `hosted`；in-process 为 `direct`；manifest 无法安全 attach 为 `unavailable`。恢复扫描不会 launch replacement，也不会重放可能已送达 provider 的 mutation。 |
| [`tmux.ts`](../apps/daemon/src/tmux.ts) 与 Unix structured supervisor | macOS/Linux 继续使用 tmux 或 Unix supervisor；`tmuxPath("win32")` 返回 `null`。 | Windows 不把 Unix socket、POSIX mode bits、负 PID signal 或 `taskkill` 伪装成同一安全语义。 |
| [`control-socket.ts`](../apps/daemon/src/control-socket.ts) | Windows 路径已是哈希化 `\\\\.\\pipe\\prospero-…`，仍用 Node `net.createServer()` 和 NDJSON token。 | Node 路径名不是 DACL：当前代码不能传入 `SECURITY_ATTRIBUTES`，`chmod(0600)` 在 Windows 不形成 ACL 保证，且没有 `GetNamedPipeClientProcessId` / token SID 检查。它是 worker 控制 pipe，不应误当 session host pipe。 |
| 启动与恢复 | [`ws-server.ts`](../apps/daemon/src/ws-server.ts) 先开 control socket，再恢复 PTY/structured，最后 reconcile orchestration。 | Windows 会逐个通过 native state boundary 读取 manifest/record，并完成 manifest—PID/FILETIME—pipe identity 核验；stale owner 只读且永不自动 spawn replacement。 |

Unix supervisor 测试仍以 `skipIf(process.platform === "win32")` 排除 Windows，这是两套 transport 的刻意分离，不是 Windows structured host 缺失。Windows host 的 portable contract/recovery coverage 位于 `windows-session-host*.test.ts`、`windows-pty-session.test.ts` 与 `windows-structured-session-host.test.ts`；Windows x64/arm64 CI 另行构建真实 N-API addon。`v*` release 必须在两种架构通过 signed production loader，并运行 signed Session Host ConPTY worker。该证据不等同于机器重启、logoff、sleep 或企业 EDR 的实机存活证明。

## 目标边界

```text
已配对手机 / relay
        │ E2E WebSocket（不变）
        ▼
prosperod daemon（可重启、可升级、无会话树所有权）
        │ host Named Pipe：ACL + peer token + capability + protocol version
        ▼
每会话 Windows Session Host（detached，唯一 owner）
        ├── durable manifest / snapshot / append journal
        ├── structured：adapter + native provider connection/child
        └── PTY：terminal reducer + ConPTY + native child Job Object
                                      │
                                      ▼
                           agent/provider 及其受控子树
```

`WindowsSessionHost` 是一个 detached 的 Node runner 进程；它加载 session reducer 与 provider adapter。Gate 已决定它的 Win32 操作由随 daemon 发布的**预编译 N-API 模块**提供。该模块是唯一可调用 ConPTY、ACL pipe、process identity、DPAPI 和 Job Object 的平台层；不引入签名 helper EXE 或第二个 public IPC 边界。**host runner 才是 public IPC、journal 和 session ownership 的唯一边界**。

对于 PTY，host 持有 ConPTY 的输入/输出、`@xterm/headless` snapshot 和 output ring。对于 structured，host 持有 adapter 的 SDK/stdio/HTTP 连接及其 pending approval callback；daemon 内只有 `RemotePtySession` / `RemoteStructuredSession` facade。两个会话类型共享同一 manifest、IPC、journal、恢复与 kill 规则。

当前 structured host 通过 `windows-structured-session-host.ts` 运行 Claude/Codex/OpenCode/Grok adapter 入口，并以通用 PSJ2 journal 保存标准化 `AgentEventBody`（含原始 approval/question `reqId` 与 session `evSeq`）。host 在 adapter 启动前已加入 `KILL_ON_JOB_CLOSE` Job；适配器产生 child 时再以 PID+FILETIME 审计其归属。daemon 的 Windows facade 只持有 native pipe client/lease/cursor；`disposeAll()` 只断开该 client，不会代替离线用户批准或拒绝待处理 callback。若 Windows N-API prebuild 不可用，SessionManager 保留旧 in-process structured 路径并将 provenance 报为 `direct`，不声称 durable。parent Job、provider Job 或 identity 审计失败会 fail closed，绝不以 `taskkill` 或 PID 终止伪造树所有权。

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
- host 在独立 reader worker 上持续 drain output，传入 xterm reducer，并将 provider-neutral PTY output event 序列化写入 journal 后再供 daemon replay。resize、input、interrupt 和 kill 也经同一 command/journal fence，不让 daemon 持有 HPCON。
- host 只向目标进程传递最小 handle list；Job handle、journal、manifest token、host control pipe 不可继承。不可把 `bInheritHandles=true` 当作控制边界。
- `ClosePseudoConsole` 会向仍连接的 client 发 `CTRL_CLOSE_EVENT`。较旧 Windows 版本中如果输出 pipe 未关闭或持续 drain，调用可能无限等待；它不得运行在唯一 output reader 线程。实现必须先做 Job Object 终止/等待、关闭 host input、继续 drain output，最后在独立线程 close HPCON。Windows 11 24H2 改善了这个行为，但不能把 24H2 当唯一受支持的 Windows 11 版本。[Microsoft: ClosePseudoConsole](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)

`session.interrupt` 对 PTY 是尽力输入 Ctrl-C / provider interrupt，仍允许以后 `send`；它不是 kill，也不等价于安全地结束进程树。

### detached host 与 Job Object

`child_process.spawn({ detached: true, stdio: "ignore" }).unref()` 只是 Node 层的必要条件：在 Windows 它使 child 有机会在 parent 退出后继续运行；它不处理 parent 所在 Job 的 kill-on-close、host 身份、子树或 IPC ACL。[Node: child_process detached](https://nodejs.org/api/child_process.html#optionsdetached)

native launcher 的规则：

1. 以 `CreateProcessW` 启动 host（完整 `lpApplicationName`、Unicode argv/environment、无可见 console 的显式 creation-flag 组合），不从 shell 拼接 command line。host 自身的 detached 启动和 ConPTY target 的 `STARTUPINFOEXW` 启动是两条分别测试的路径，不能把一组 creation flags 盲目复用到两者。
2. 先以 `IsProcessInJob` 检测 daemon 是否被外部 Job 管理。若它位于 `KILL_ON_JOB_CLOSE` Job，只有该外层 Job 显式允许 `CREATE_BREAKAWAY_FROM_JOB` 时才能让 host break away；不允许时，**拒绝创建 durable session** 并报 `parent_job_prevents_detach`，不要默默降级为“可恢复”。[Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) [Microsoft: process creation flags](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
3. host 为其实际 agent/provider tree 创建一个未命名 Session Job，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不设置 `BREAKAWAY_OK` 或 `SILENT_BREAKAWAY_OK`，并保留唯一非继承的 job handle。
4. host 在 adapter factory 运行前已经加入该 Job，因此 provider child 继承 containment；adapter 注册 child 时只用 PID+FILETIME 审计它确实属于该 Job，不在 spawn 后补 assign 而重开 race。若 Job membership 不兼容或审计失败，清理本次 host，不启动 durable session。Windows 11 支持 nested jobs 不表示每个第三方 provider 都兼容它。
5. 显式 kill 走 `TerminateJobObject`，而不是 `taskkill /T`、按进程名枚举或只杀 manifest PID。host 退出/被 force-kill 时其唯一 job handle 关闭，`KILL_ON_JOB_CLOSE` 作为最终收口。

这给 Prospero 一个可审计的 owner tree，不给 provider 任意 breakaway 权。Job Object 默认会将 `CreateProcess` 的 child 置入 job；一旦 allow breakaway，就会失去完整子树可见性/kill 承诺，故默认禁止。[Microsoft: Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

## Named Pipe、认证与进程身份

### Pipe 创建

每个 epoch 创建随机且不可预测的 endpoint，例如 PTY 的：

```text
\\.\pipe\prospero.pty.<session-id>.<epoch>
```

host 在 pipe 已由 `CreateNamedPipeW` 成功创建、DACL 已读取回核验后，才可以把 endpoint 写入 manifest。第一实例使用 `FILE_FLAG_FIRST_PIPE_INSTANCE`，message mode，`PIPE_REJECT_REMOTE_CLIENTS`；如需并发 handoff 则由 host 自己创建额外实例，所有实例使用同一经过验证的 DACL。Pipe 名有 256 字符上限，且不区分大小写，设计不得从长工作目录派生。[Microsoft: CreateNamedPipe](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipea)

`SECURITY_ATTRIBUTES` 的 DACL 至少要：

- 允许当前 **logon SID**（不只是 account SID）对 client 侧所需 `READ_DATA`、`WRITE_DATA`、属性读取与 `SYNCHRONIZE`；logon SID 能阻止另一 Terminal Services logon session，且 remote clients 一律拒绝；
- 默认只建一个可重复 `DisconnectNamedPipe` 的 server instance，DACL 不给 client `FILE_CREATE_PIPE_INSTANCE`。若升级 handoff 需要额外 instance，host 必须在首实例仍持有名字时自行创建；同一 logon SID 内无法由 DACL 区分 host 与 daemon，故仍须 random name、capability 与 lease。不可用 `FILE_GENERIC_WRITE`，因为它包含相同位的 instance-create 权；
- 明确拒绝 `ANONYMOUS LOGON`、`NETWORK` 与 `Everyone` 的宽泛访问；创建后以 `GetSecurityInfo` 比对预期 descriptor，失败则不 listen；以及
- 在不需要服务化时不额外给 Administrators 或 SYSTEM 普通 data access。具备管理员/调试特权的本机攻击者不在此 ACL 的可防御范围内。

默认 Named Pipe DACL 可把 read access 给 Everyone 和 anonymous，不能依赖它。[Microsoft: Named Pipe Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)

### 双重认证与 lease

每个连接先受 pipe DACL 限制，再完成以下无副作用握手；未完成前只允许固定大小 `hello`，不允许 replay、send、kill 或任意 adapter call：

```json
{
  "version": 2,
  "type": "hello",
  "sessionId": "…",
  "epoch": "…",
  "daemon": { "pid": 1234, "creationTime100ns": "134001234567890000" },
  "nonce": "base64url-random",
  "proof": "HMAC(capability, canonical hello material)"
}
```

host 在**首帧 read 后**取 native `PipePeerIdentity`：`GetNamedPipeClientProcessId`/`GetProcessTimes` 得到 PID+FILETIME，且在 impersonation 下读取 `TokenUser` SID 与 `TokenSessionId`。它必须与 hello 的 daemon identity 匹配，随后才验证 capability HMAC proof 并回送 host-signed `welcome`。任一步失败即断开，绝不能在 host 自身权限下继续执行请求；微软也明确要求 impersonation 失败时不执行 client 请求。[Microsoft: GetNamedPipeClientProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeclientprocessid) [Microsoft: ImpersonateNamedPipeClient](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-impersonatenamedpipeclient)

capability 是另一层 256-bit constant-time comparison，并有每连接随机 challenge/response，防止普通 pipe client 或旧 connection replay。daemon 以 DPAPI current-user 密文保存 capability（文件只含版本、key id、密文和 session/epoch binding，manifest 不含 raw token）；raw token 不得出现在 argv、environment、日志、crash report、WebSocket、状态文件或 error message。DPAPI 提高静态文件泄露门槛，不把同一受损 user principal 变成可信边界。

host 每时刻只授予一个 daemon process identity 的可变命令 lease。socket 断开不会杀 host 或立即清除 lease；lease 有界过期，新的认证 daemon 才能取得它。server-side read-only method 可以免 lease，但仍必须先完成认证；两个 daemon 不能同时发送 mutation。

### PID + creation time 的用途

PID 从不单独成为授权或 kill 依据。manifest 中记录 host 的 `{ pid, creationTime100ns }`；启动恢复与内部 exact-process rollback 都必须以受限 process handle 重新读 `GetProcessTimes`，严格匹配后才可 connect 或终止。`GetProcessTimes` 返回的 creation time 是 FILETIME；以十进制字符串持久化以避免 JavaScript number 精度截断。当前没有公开的 force-kill CLI；运维只能使用显式 `session.kill` 或将不可达 host 标为 `unavailable`，不能按 PID 手工终止。查询所需的最小访问权是 `PROCESS_QUERY_LIMITED_INFORMATION`（或更高的 query right）。[Microsoft: GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes) [Microsoft: process access rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights)

同样，host 检查 daemon peer tuple 防止其把断开的 PID 值误关联到已复用的新进程。PID/creation time 不证明进程“良性”，只消除 PID reuse 和 stale-manifest 的错杀类别；有效 DACL、capability、protocol epoch 仍是必要条件。

## 持久化格式

每会话在 `%LOCALAPPDATA%\Prospero\session-host\<session-id>\` 中拥有一个 ACL 受限目录。native filesystem 层必须拒绝 reparse point/symlink traversal、用最终路径句柄核验其仍在 root 下，并使用当前 logon user 的 DACL 创建目录。不能把 POSIX `chmod(0600)` 当作 Windows 访问控制。

```text
session-host/<session-id>/
  manifest.json             # schema 2，原子替换，无 raw secret
  credential.dpapi          # DPAPI current-user 密文，非 raw capability
  journal.psj2              # framed durable event/command/terminal record
  snapshot.psj2.json        # reducer、command ledger、terminal fence
  provider.record.json      # discovery metadata；不授予 pipe/owner 权限
  host.bootstrap.json       # detached host 一次性消费后删除
```

### `manifest.json`（schema 2）

```json
{
  "schemaVersion": 2,
  "protocolVersion": 2,
  "implementation": "windows-session-host",
  "sessionId": "2d0a…",
  "epoch": "443a…",
  "pipeName": "\\\\.\\pipe\\prospero.pty.2d0a….443a…",
  "stateDirectory": "C:\\…\\windows-session-host\\2d0a…",
  "aclProfile": "current-logon-token-v1",
  "owner": {
    "pid": 4180,
    "creationTime100ns": "134001234567890000"
  },
  "nativeAbiVersion": 3,
  "credentialFile": "credential.dpapi",
  "journalFile": "journal.psj2",
  "snapshotFile": "snapshot.psj2.json",
  "status": "active",
  "createdAt": 1786782000000,
  "updatedAt": 1786782012345
}
```

严格 parser 只接受上述固定字段，以及 `status: active | terminal | failed`。UI `running`、`waiting_approval`、`waiting_input`、`done`、`died` 是 journal/snapshot reducer 的会话状态，不能伪造为 manifest 的 owner 状态。epoch、owner PID+FILETIME、pipe name、state directory 与 N-API ABI 是 attach 安全条件，不是 UI 可修改元数据；launch rollback 保留 `failed` manifest 供 discovery 标成不可用，而不是删除整目录。

native secure-state API 以 current-user DACL、reparse-point 检查和受控 atomic replacement 写入这些固定文件名。任何损坏、未知 schema、ABI 不匹配或 state root 不匹配的 manifest 都是 `unavailable`，只读且不得自动覆盖。

### `.psj` journal（schema 2）

每条 record 是固定头加 UTF-8 JSON payload 的 append frame，避免 JSONL 截断无法区分传输噪声与异常尾：

```text
magic "PSJ2" | payloadLength:u32le | crc32c:u32le | UTF-8 JSON payload
```

```json
{
  "schemaVersion": 2,
  "kind": "event",
  "sessionId": "2d0a…",
  "epoch": "443a…",
  "seq": 912,
  "payload": { "provider": "pty", "type": "output", "dataB64": "…" }
}
```

每个 frame 是 `PSJ2` magic、little-endian payload length、CRC-32C 与 UTF-8 JSON。第一条是 `kind: "base"`，后续只允许严格连续的 `event | command | terminal` record；mutating command 才带 `commandId`。PTY output 与标准化 structured event 都位于 provider-neutral `payload`。不完整的**最后一帧**是唯一可接受的 crash tail；CRC、session、epoch、schema 或 sequence 错误都使恢复 fail closed。

host 先经 native secure-state boundary durably写入 record，再更新内存 replay state/回复 client；reconnect 因而是 at-least-once，daemon 按 `(sessionId, epoch, seq)` 去重。它不保证 native provider exactly once：若 provider 已接受 `send` 而 durable result 未写入，host 会竖起 `unknown_command_outcome` terminal fence，不得静默重发。

`snapshot.psj2.json` 是 `{ sessionId, epoch, lastSeq, terminal, commands, state }`：`state` 由 PTY 或 structured reducer 提供，`commands` 是 completed mutation 的 idempotency ledger。compaction 顺序为先原子写 snapshot at `N`，再以新的 base record 重置 `journal.psj2`；崩溃时两者并存仍可完整验证与 replay。retention advancement 返回 `gap: true`，daemon 必须使用 snapshot，不得把不完整增量称为精确 replay。

## 生命周期与失败语义

```text
launch -> manifest active -> host owns live reducer/provider
                 |                    |
                 |                    +-- explicit kill --> terminal manifest + terminal snapshot
                 |
                 +-- launch rollback --> failed manifest (read-only/unavailable facade)

active manifest + absent owner / bad identity / pipe / state --> unavailable or died facade;
the recovery scan never publishes a replacement owner.
```

| 事件 | required action | 不得发生的事 |
| --- | --- | --- |
| daemon 正常退出 / `SIGTERM` 对 daemon | daemon 仅关闭 host pipe facade；host 和 Session Job 保持运行，继续 journal，pending approvals 保持 pending。 | `disposeAll()` 不得向 host 发送 interrupt、dispose、kill，不能关闭 HPCON/Job。 |
| daemon 被强杀 | host 收到 broken pipe 后不作 native cancel；新 daemon 通过 manifest identity + pipe handshake 重连并从 durable replay cursor 恢复。 | 不得因 daemon 消失 auto-approve、auto-deny（除非预先记录的显式 policy timeout），或启动第二个 host。 |
| host 自身 crash / OS 强杀 host | host 的 `KILL_ON_JOB_CLOSE` Job 收口受控 provider tree；下一 daemon 发现 host PID/creation time 不存在，暴露只读 `died`/`unavailable` history 与可验证 journal tail。 | 不得把 PID reuse 的进程视为 owner，或自动重新执行上一条 queued/provider command。 |
| `session.interrupt` | 经 host command journal 尽力通知 adapter / 写 Ctrl-C；会话继续可用。 | 不得把 interrupt 当作 tree kill 或把它写成 terminal fence。 |
| `session.kill` | 先形成 durable terminal command/ledger，并拒绝后续 mutation；structured kill 会在 provider action 前另记 `kill_requested` intent。host 取消 adapter 后终止 Job、持久 terminal snapshot/manifest，最后关闭 pipe/exit。重复 commandId 回同一结果。 | 不得仅 kill manifest PID、按名称扫描、`taskkill /T` 猜树，或在 event late arrival 时复活 session。 |
| daemon admin/repair force-kill | 当前没有公开的 force-kill CLI。正常路径是 authenticated `session.kill`；host 不可达时保留证据并标 `unavailable`。native exact PID+FILETIME terminate 仅用于受控 launch rollback/内部路径。 | 不得用 `taskkill /T`、按名称或裸 PID 终止；不得为「修复」删除 manifest/state 或启动 replacement。 |
| rolling upgrade | 新 daemon 先做 read-only validation；旧 daemon 关闭 facade 后，新 daemon 在 bounded mutation lease 可取得时继续。 | 两个 daemon 同时发送 mutation；为了升级 kill 运行中 host。 |

approval/question 的底线与 Unix supervisor 一致：daemon offline 表示等待，不表示允许。host 从 journal/snapshot 重放原 `reqId`；reply 只接受该 ID，先持久 resolution 再转发 adapter。host 崩溃后无法泛化重建 SDK callback 时标 `needs_reconciliation`，不伪造 reply。

## 威胁模型与安全要求

| 威胁 | 控制 | 剩余边界 |
| --- | --- | --- |
| 另一用户、remote SMB client、另一 RDP logon session 连接 pipe | random name、`PIPE_REJECT_REMOTE_CLIENTS`、精确 logon-SID DACL、peer token 核验、capability。 | 管理员或具备调试/取所有权特权者不受普通 user DACL 限制。 |
| Pipe name 预创建/劫持 | pipe 先创建后发布 endpoint；首 instance 用 `FILE_FLAG_FIRST_PIPE_INSTANCE`；连接前 identity + capability handshake。 | 同一受损 logon session 可观察/注入/调试 user process，不是本设计能隔离的 hostile principal。 |
| token 出现在日志、argv、环境、manifest | raw token 仅 host/daemon 内存与 DPAPI ciphertext；bootstrap 只含密文路径；redact error。 | 同一用户可运行任意代码或读 host 内存时，DPAPI current-user 不能保护它。 |
| PID reuse 导致 attach/kill 错对象 | manifest 记录 FILETIME creation time；每次 `OpenProcess` 后重读匹配；Job handle 而非 PID 负责常规 kill。 | image path/hash 是附加诊断，不能单独认证 executable。 |
| 子进程逃逸或进程名误杀 | Session Job 默认禁止 breakaway、最小 handle inheritance、`TerminateJobObject`。 | provider 通过服务、计划任务、Docker、远程 API 或被外部 Job 管理产生的进程不一定属于 Job。 |
| journal 损坏、部分写入、重复重放 | framed CRC record、native secure atomic write、snapshot + reset journal，按 epoch/seq 去重。 | 电源丢失后最后未完成的 output/事件可能丢失；不能凭此承诺完整 terminal transcript 或 exactly-once agent actions。 |
| 路径替换/attachment traversal | native secure-state 目录逐 handle 拒绝 reparse point；IPC 不传 host 文件路径。当前 durable structured attachment custody 尚未交付，带 attachment 的 structured send 会显式拒绝。 | 已获同用户完全文件系统控制的攻击者在 host 启动前后仍不在目标防护模型。 |
| provider 启动命令注入 | `CreateProcessW` 指定完整 `lpApplicationName`、结构化 argv、Unicode environment；不得通过 `cmd.exe`/PowerShell 重新解释 session-host/provider launch。 | 用户明确创建的 `custom` shell command 本身拥有用户选择的 shell 语义。 |

额外运行时要求：所有 frame 有最大大小与解析深度；protocol/method 白名单；auth 和 bad-frame telemetry 不记录 token/prompt/attachment 内容；IPC rate limit；所有 native handle RAII close；host 的 crash dump 默认不含 secret。N-API 的 DACL、DPAPI、creation-time、Job 和 ConPTY Windows tests 以不需要管理员的临时资源运行；signed release 的实机 worker smoke 由 CI 另行执行。

## 明确无法承诺的边界

- 不承诺 daemon 之外的 host crash 后自动恢复某 provider 的 in-flight native turn；只在 adapter 经实测支持 resume cursor 时提供显式、可审计的 reclaim。
- 不承诺 host 位于禁止 breakaway 的外层 Job、用户注销、系统关机、休眠、电源故障或企业 EDR 强制终止时的会话存活。遇到 parent Job 不兼容必须 fail closed。
- 不承诺 kill 终止 Job 之外的副作用：远程 API 请求、云任务、已提交 git 操作、service/scheduled-task/Docker child，或 provider 故意 break away 的对象。
- 不把同一 Windows user/logon session 内的恶意代码视为可由 DACL + DPAPI capability 隔离的攻击者；本地管理员更不在该边界内。
- 不承诺 ConPTY 与所有 legacy GUI/console、Windows service、elevated/跨 integrity provider 的兼容性。遇到 unsupported console/provider 给清晰错误，不回落到谎称 durable 的 daemon PTY。
- 不承诺 native command exactly once；mutating command 的 crash ambiguity 需要 idempotency key、provider support 或人工 reconciliation。

## 已交付范围与未扩展的边界

| 交付 | 实现与可复现验证 |
| --- | --- |
| 原生边界与分发 | `@prospero/windows-native` 提供 secure pipe、peer identity、DPAPI secure state、PID+FILETIME、Job、detached launch 和 ConPTY。PR 在 Windows x64/arm64 构建并验证 unsigned artifact 被 production loader 拒绝；tag release 对两种架构签名、核验、打包 hash/integrity/provenance，并重新通过 production loader。 |
| 公共 host transport | [`windows-session-host-runner.ts`](../apps/daemon/src/windows-session-host-runner.ts) 提供 manifest v2、capability challenge、single mutation lease、framed PSJ2 journal、snapshot/terminal fence 和 bounded native pipe I/O；`windows-session-host.test.ts` 覆盖 malformed peer、cursor/replay、bootstrap 消费、launch rollback 与 terminal commit。 |
| PTY host | [`windows-pty-host.ts`](../apps/daemon/src/windows-pty-host.ts) 与 [`windows-pty-session.ts`](../apps/daemon/src/windows-pty-session.ts) 提供 ConPTY create/subscribe/snapshot/input/resize/interrupt/kill；`windows-pty-session.test.ts` 覆盖 detached facade、gap snapshot、terminal kill 和 stale owner 不启动 replacement。 |
| Structured host | [`windows-structured-session-host.ts`](../apps/daemon/src/windows-structured-session-host.ts) 与 client 将 Claude/Codex/OpenCode/Grok adapter 放入 host；`windows-structured-session-host.test.ts` 覆盖 pending approval/question 的原 ID、断线 mutation idempotency、terminal recovery 与 Job cleanup。text-only durable flow 已交付；durable attachment custody 仍显式拒绝。 |
| daemon 与编排恢复 | `SessionManager` 与 `ws-server` 先 secure reattach，再 reconciliation；`orchestration-recovery.test.ts` 覆盖 hosted/direct/unavailable provenance，owner identity 改变或无法 attach 不会被错误当作可继续的 worker。 |

Unix 的 [`structured-agent-supervisor.md`](structured-agent-supervisor.md) 保持自己的 process-group rollback；Windows 使用明确的 platform abstraction，不混用 `SIGKILL`、负 PID、POSIX socket 权限或 `taskkill`。

## 已决的产品/分发 Gate

这个设计不可避免地引入影响依赖和发布的选择：安全 ConPTY、Named Pipe ACL、capability/token SID 核验、PID creation time 与 Job Object 不由现有 Node API 完整提供。

协调者已为 `run_fed56178b183` / `task_c05c2917e01e` 创建并决议 Gate **`gate_5a655a0ec88b`**：

> Windows Session Host 的原生边界采用哪种分发方案？

1. **预编译 N-API 模块（已选）**：随 daemon npm 包按 Windows x64/arm64 分发，给 host 一套类型化 API；public IPC 最少，适合把 ConPTY、pipe ACL、Job 和 process identity 收敛在同一审计单元。每个 release 必须由 Windows x64/arm64 CI 构建、加载测试、记录二进制 SHA-256 与 npm integrity，并以签名发布工件/可验证 provenance 交付；安装器只选择匹配 `process.platform`/`process.arch` 的随包 prebuild，不下载或编译未知二进制。代价是 native ABI、prebuild、签名和 supply-chain 维护。
2. **签名 helper EXE**：Node host 以受限私有 IPC 调 helper；隔离 ABI，但增加 EXE 签名、升级、Defender/EDR 兼容、私有二进制协议和安装体积。
3. **不引入原生边界**：Windows 保留直接 PTY / 禁用 durable session host；发布简单，但不满足本 Run 的 durability 目标。

决议为：「采用预编译 N-API 模块：Node 内直接调用 Win32；维护 Windows x64/arm64 N-API 构建、校验与发布。」实现和 release 必须遵守上述约束，不能以 helper EXE、runtime download 或 source-build 取代已决 N-API 分发。

## 验收证据与仍需现场验证的事项

所有 native tests 使用临时状态目录、随机 pipe/port、fake provider 和测试拥有的 PID/Job；不得枚举、kill 或重用用户既有 process/pipe。Windows 下「正常 daemon 退出」与「强制结束 daemon」分别以 facade dispose 和 `TerminateProcess`/Job 语义验证，不能用 Unix `SIGKILL` 的字面行为替代。

| 证据 | 当前范围 | 不可据此推导的结论 |
| --- | --- | --- |
| `packages/windows-native/test/process-terminal.windows.test.ts` 与 `native.windows.test.ts` | Windows x64/arm64 runner 上的真实 Node-API、secure pipe、PID identity、Job 与 ConPTY primitives。 | 不证明特定第三方 EDR、企业 Job policy 或所有 provider CLI 都兼容。 |
| `apps/daemon/test/windows-session-host.test.ts`、`windows-pty-session.test.ts`、`windows-structured-session-host.test.ts` | transport、journal/replay、lease、terminal fence、stale identity、approval/question 与 recovery contract。 | 其中 fixture/mock coverage 不能替代一次真实机器 reboot/logoff 测试。 |
| `.github/workflows/ci.yml` 的 `windows-native` / `release-signed-load` | PR 要求 x64 与 arm64 native build；tag release 必须对 signed artifact 作 production-loader smoke，并运行 signed Session Host ConPTY worker。 | 未经特定 tag 的公开 CI result，不能声称该 release 已在客户环境通过。 |

尚无实机验收记录的场景保持为运维边界：Windows logoff、系统关机/重启、sleep/断电、EDR 强制终止、跨 integrity/elevated provider、Job 外副作用与 in-flight native command exactly-once。它们发生后不得自动重放命令、spawn replacement 或把历史显示为已恢复；按 [Windows Session Host 运维与排障](windows-session-host-operations.md) 保留记录、检查状态并由操作者决定新建、resume（若 adapter 支持）或归档。
