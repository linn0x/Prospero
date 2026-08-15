# Windows Session Host 运维与排障

本文说明 Windows 11 上的运行边界；架构、协议和威胁模型见 [Windows Session Host](windows-session-host.md)，二进制分发和签名链见 [Windows N-API native boundary](windows-native-boundary.md)。这里的「保活」只指 **daemon** 重启、崩溃或升级后的 reattach，不是 Windows 用户注销、机器重启或断电后的进程存活承诺。

## 运行模型与安装前提

每个 eligible PTY 或 structured 会话都有一个 detached Windows Session Host。host 持有 ConPTY 或 adapter、provider Job、secure state、journal 和 session pipe；daemon 只是可替换的 authenticated client。structured host 目前覆盖 Claude Code、Codex、OpenCode、Grok；其他 Agent 走 PTY。

生产 daemon 包随附 Windows x64 与 arm64 的 `@prospero/windows-native` prebuild。安装不下载未知二进制，也不在用户机器静默编译；loader 按 `process.arch` 选择 artifact，并在加载前核对：

- N-API/ABI 和完整 capability set；
- artifact SHA-256、Authenticode 状态和 manifest 记录的 signer thumbprint；
- 运行时 Authenticode 验证；release-pack verification 另行检查 embedded daemon copy 和 native package copy 的一致性。

缺少 binary、unsigned/未受信 signer、hash/ABI 不一致或 capability 缺失都会在 host **创建前**失败。此时 PTY 和 structured 会话可清晰标记为 daemon 内 `direct`，不获得重启保活能力。源码 checkout 中自行 `node-gyp` 生成的是 unsigned 开发 artifact，production loader 会故意拒绝它；要验收 hosted 路径，使用 signed release 包或 tag release CI。PR 的 unsigned x64/arm64 artifact 只用于证明拒绝路径；不能把它当作可安装 release。

host session pipe 不是 daemon 的 worker control pipe。它由 native layer 创建，并同时要求 current-logon DACL、拒绝 remote client、pipe peer PID+FILETIME/SID/session identity、DPAPI-held capability challenge 和 single mutation lease。随机 pipe 名或 PID 本身都不足以授权。不要复制 token、修改 manifest，或将 host pipe 公开给 LAN、WebSocket 或 Agent provider。

## 状态与恢复

| Provenance | 含义 | daemon 重启后的处理 |
| --- | --- | --- |
| `hosted` | daemon 已安全 attach 到 Windows Session Host；其 manifest epoch、host PID+FILETIME、authenticated pipe 和 capability 均匹配。 | 重新 attach 并从 journal/snapshot replay；不会创建第二个 host 或重放可能已送达 provider 的 mutation。 |
| `direct` | 会话在 daemon 内；这是 native binding 在 host 创建前不可用时的显式 fallback，或正常 in-process 会话。 | daemon 退出即失去进程所有权；不能宣称 agent/terminal 仍存活。需要新建或按 agent 自身能力显式 resume。 |
| `unavailable` | discovery record、owner identity、pipe、journal 或 terminal state 不能安全验证。 | 保留只读/诊断历史；禁止 mutation、自动 direct fallback 和 replacement spawn。 |

`session.interrupt` 是尽力取消/发送 Ctrl-C，仍可继续使用会话。显式 `session.kill` 是唯一的 tree termination：先落 terminal intent/command ledger，拒绝后续 mutation，再由 host 终止受控 Job，留下 terminal history。停止 daemon 时只关闭其 facade，不会把 interrupt 或 kill 发送给 hosted session。

## 推荐操作

### 计划内 daemon 重启或升级

1. 以正常服务停止或 `Ctrl+C` 结束 daemon；不要先对 host 或 provider 使用 `taskkill`。
2. 以同一 Windows 用户、同一 Prospero home 启动新 daemon，例如 `node apps/daemon/dist/cli.js start --name my-computer`。
3. 等待 daemon 打开 control socket、扫描 host records、secure attach，并完成编排 reconciliation。pending approval/question 仍需原始 `reqId` 的显式回复；daemon 离线绝不等于批准。
4. 若会话是 `unavailable`，保留其记录并处理关联 Task 为可诊断状态；不要删除 state 或再次启动相同 agent 命令来「修复」它。

同一流程也适用于 daemon 被 `TerminateProcess` 或其他方式强制结束后的恢复：新的 daemon 接管连接 lease，但不接管/重放上一 daemon 未知结果的 provider mutation。

### 用户请求中断或终止

- 只想停止当前动作时，使用手机客户端或已认证 control API 的 **Interrupt**。
- 必须结束受控 agent tree 时，使用明确的 **Kill**。Kill 完成后是 terminal/read-only；不要把它当作可 reconnect 的暂停。
- `direct` 会话也必须在 daemon 仍运行时显式 Kill；daemon 重启不能让 direct session 恢复。

当前 CLI 没有面向操作者的「force-kill Session Host」命令。若 host pipe 无响应，**不要**使用 `taskkill /T`、按名称杀进程、按裸 PID `TerminateProcess`、glob 删除 `%LOCALAPPDATA%` 下的状态目录，或修改 DPAPI/manifest 文件。这些方式不能证明 PID 没有复用，也可能杀到 Job 外进程。native 的 exact-PID+FILETIME termination 仅是受控代码路径/launch rollback primitive，不是支持的手工 runbook。

### host crash、强制结束 host 与坏状态

host 自身 crash 或被 OS/管理员强制结束时，host 持有的 `KILL_ON_JOB_CLOSE` Job 会收口受控 provider tree。下一次 daemon 启动只能把不存在或身份不匹配的 owner 记为 `unavailable`/只读或 terminal history；它不会推测上一条 command 是否完成，也不会自动启动 replacement。对该 session 的下一步是由操作者新建会话、在 adapter 明确支持时选择 resume，或归档历史。

收集排障材料时保留 session ID、host epoch、PID+FILETIME、daemon 日志中的 error code 和相关时间。不要收集/粘贴 capability、DPAPI blob、pairing/control token、prompt 或 attachment 内容。若有安全边界错误（例如 `parent_job_prevents_detach`、provider Job/identity error、signature/ABI/capability failure），记录错误并停止；这些不是可安全自动降级的条件。

## 不覆盖的机器生命周期

Windows logoff、系统关机/重启、sleep/hibernate、断电和企业 EDR 强制终止可能同时结束 daemon、host 和 provider。journal/snapshot 只用来保留可审计状态；它们不能证明最后输出已 flush、native turn exactly once，或第三方 provider 能被泛化 resume。机器重新登录后运行 daemon 时：

1. 让它执行正常 discovery/reconciliation；
2. 将缺少可验证 owner 的记录视为不可用/历史，而非 running；
3. 不自动重发队列、审批、问题回复或 agent command；
4. 由操作者确认后新建、adapter-specific resume（若已支持）或归档。

相同限制适用于 Job 外副作用，例如远程 API、云任务、已提交 Git 操作、service、scheduled task、Docker 或 provider 主动 breakaway 的 child。

## 验收范围

仓内证据覆盖 N-API secure pipe/identity/Job/ConPTY primitives、host journal/replay/lease/terminal fence、PTY facade、structured pending approval/question 和 stale-owner recovery。CI 在 Windows x64 与 arm64 构建原生 addon；tag release 还要求 signed production loader 和 signed Session Host ConPTY worker。测试位置与未做现场验证的边界见 [Windows Session Host 的验收证据](windows-session-host.md#验收证据与仍需现场验证的事项)。这不替代在目标企业策略、EDR、硬件和 Windows image 上进行 logoff/reboot 验收。
