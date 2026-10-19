# Prospero runtime reliability 实施与验收记录

日期：2026-10-19（America/Los_Angeles）。

状态：本轮核心实现已完成集成与下列验证；完整规划的发布验收仍未完成。未操作线上、未运行真实模型业务流量。

## 基线和实施范围

基线为 `b4e34246716cb5c74db620554cb9ba6bcfbe0f34`，schema 34，macOS arm64。使用独立 `codex/runtime-reliability` 工作树，主仓原有终端、桌面和文档修改不纳入本次提交。最初向三个 Luna agent 分配契约、Driver 和故障基础设施；Luna 容量连续不足后，经用户授权由三个其他模型 agent 接续，root 负责集成、审查与最终合并。

代码复用原启动队列、业务 DAG、交付校验、事务事件和数据库队列，保持原有业务判定不变。

## 已落地的实现

| 工作包 | 实现 | 适用边界 |
| --- | --- | --- |
| W01 | schema 35；attempt/epoch、操作、命令、结果回执、退出证明、资源保留及恢复责任；未知状态唯一约束、参数指纹、旧启动映射 | 旧库迁移；未知新 schema 拒绝；不伪造历史 Host |
| W02 | 独立 Rust Execution Host；私有 IPC、完整身份、持久命令与事件、审批原 ID、离线交付、共享摘要固定的 Rust 运行时 | Unix native Claude/Codex/DeepSeek；managed account、OpenCode hosted、Windows hosted 明确不支持 |
| W03 | Driver 启动回滚、退出/输出排空证明、未知容量隔离、结构化错误及 Retry-After、未知用量与重复结算保护 | 外部脱离进程组的进程和远端副作用不在 Unix 退出证明内 |
| W04 | 持久异步 stop/message/result/reconcile；有界对账；原业务验收；结果与进程分别收尾；旧调用兼容 | hosted 显式启用；无通用外部副作用 exactly-once 保证 |
| W05 | 当前用户同机唯一预算服务；原子准入、未知隔离计量、证明释放、重启保留占用 | 预算服务不可用时停止新准入；停止路径独立可用 |
| W06 | Host 事件身份/顺序/重复检查，缺口责任；activity、四层健康缓存、归档 Host 的正式收尾 | 观察数据有上限；完整事件缺口快照恢复仍需发布验收 |
| W07 | CLI 有界等待与离线 Host 提交；Rust/桌面查询；移动端 WS 查询、幂等 ID、重连快照和准确状态展示 | 真实移动设备 UI 未验收 |
| W08 | daemon/CLI/Host/budget 产物摘要清单；一致性备份、退役 Host 日志及运行时引用；隔离恢复禁准入标记 | 未执行真实安装包升级、兼容代码回退、旧快照与活动 Host 的自动恢复 |
| W09 | fake executor、真实 Host/controller/主 daemon/budget 进程测试；故障矩阵、资源采样和真实 hosted workload | 短诊断不替代 24/72 小时；完整 F01–F29 未全部验收 |

## 使用与兼容

新启动保留 `POST /v1/workers/start` 和旧启动查询。自动化优先 `Prefer: respond-async`。新增：

- `GET /v1/operations/{id}`、`GET /v1/executions/{attempt_id}`。
- `POST /v1/executions/{attempt_id}/stop|messages|results|reconcile`。请求为 `{"operationId":"...","payload":{...}}`；也可使用 `Idempotency-Key`，与 body 不同则拒绝。
- CLI：`prospero worker start ... --queued`；`prospero operation --id <id> --wait --timeout 30`。结束等待不取消操作。
- Worker 在 Host 环境运行 `prospero task done|fail --id ... --body ... [--operation-id ...]`，离线只确认 `RECEIVED`，不声称业务已 `ACCEPTED`。
- `reconcile` 只重新检查原 Host/命令；不接受调用者自行制造退出证明，也不创建新 attempt。
- 已确认退出或 Host 已退役的执行拒绝新的 stop/message/reconcile；同一操作 ID 仍可查询或重放原回执。

hosted 模式使用 `PROSPERO_EXECUTION_MODE=hosted`。首次切换应先 drain legacy direct 执行，不给在途 direct 会话改托管标签。Host/budget 二进制默认从 daemon 同级目录查找，测试可显式指定；预算目录默认当前用户的共享目录。不要给不同 daemon 指定互不相关的预算目录来绕过同机额度。

备份工具为 `tools/runtime/reliability-release.py`。只在源 daemon 停止、执行已收口时持写者锁备份。目标必须为新目录。恢复保留 `RESTORE_REQUIRES_RECONCILIATION.json`，写者拒绝开放准入；不要手工删除标记来跳过对账。

## 验证口径与证据

原始成功和失败日志都保留在本次工作树的 `output/runtime-reliability-2026-10-19/`。必须以最后一次完整验证和最终源码快照为准；中间失败记录不会改写为通过。

最终冻结源码验证：

| 检查 | 结果 | 原始日志 |
| --- | --- | --- |
| `cargo test --workspace --locked --no-fail-fast` | 43 个 suite，536 通过，0 失败，6 忽略（含 5 项真实认证 CLI） | `prospero-reliability-workspace-final3.log` |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | exit 0 | `prospero-reliability-clippy-final3.log` |
| `cargo fmt --all --check`、`git diff --check` | 通过 | `prospero-reliability-fmt-final3.log` |
| `npm run typecheck`、生成类型/契约检查 | 通过 | `prospero-reliability-typecheck-final3.log`、`prospero-reliability-contract-final3.log` |
| 相关桌面、移动端、协议测试 | 分别 15、48、3 项通过 | `prospero-reliability-{desktop,mobile,protocol}-final2.log`；此后这些源码未变 |
| 修改的移动端文件 ESLint | exit 0 | `prospero-reliability-eslint-final2.log` |
| 一致性备份/恢复 Python 测试 | 12/12 通过 | `prospero-reliability-backup-final2.log` |
| `npm run rust:release:smoke` | macOS arm64 实际打包后启动通过；四个运行时二进制摘要一致 | `prospero-reliability-release-smoke-final3.log`、`packaged-runtime-manifest.json` |
| 最终 40-cycle 隔离诊断 | 40/40 收口，详见下文 | `prospero-reliability-workload-40-final3-corrected.json` |
| `node tools/perf/runtime-reliability/report.mjs --strict` | **exit 1，发布门槛未通过**；保留未覆盖项 | `prospero-reliability-fault-report-final.json` |

Rust debug 验证使用 `CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=target`；release 使用独立工作树的 `target/release`。未连接线上比对部署版本；以上不验证主仓原有未提交终端改动。

已实际走过的关键路径包括：

- 真实主 daemon 被 SIGKILL，Worker 用真实 CLI 向存活 Host 离线提交，重启后只验收原提交，生成退出证明并释放预算。
- Host 的原审批 ID 跨测试控制进程 SIGTERM/SIGKILL 保持，未回答时不执行；相同命令重投不重复启动。
- 两个独立客户端进程竞争同一预算服务，容量不超限，预算服务重启保留 held/quarantined 记录。
- 新旧 schema 迁移、历史数据保留、版本拒绝、原操作参数冲突、业务结果与未知停止并存。
- legacy direct 的未知执行在数据库层阻止同任务再次派发和提前完成 Run；自动化仅在确认物理退出后继续。
- 同一次停止在延迟输出排空后可以收敛；退出证明不依赖内存事件窗口，已持久证明可在 Host 重启后仅恢复回执，不重新发送进程信号。
- 归档和最终退出确认收尾的审批状态与 timeline 事件同事务提交；事件写入失败回滚并保持未知占用。
- 丢失的消息回执可恢复为 RECEIVED，不能冒充业务处理完成；无效回执持久化失败有退避与人工处理预算。
- 桌面、移动端的等待超时、取消等待、重复按钮、能力协商与状态展示。客户端测试是逻辑/传输测试，不是设备端到端测试。

40-cycle 诊断第一次为 38/40，定位到 hosted dispatch/execution 分开提交导致旧恢复器误结算的窗口，以及 Host 观察恢复责任未收口。修复后的中间版本为 40/40（40.848 秒）。最终源码冻结后，一次诊断误指向工作树的符号链接二进制，被运行时固定校验拒绝；保留失败现场，改用实际构建目录，未放宽校验。

最终冻结源码的正确路径诊断为 40/40，耗时 92.247 秒：120 个操作成功、40 个退出证明、201 个恢复责任全部收口、160 个本地资源保留全部释放，40 个 Host 退役，残留 Host socket 和同机预算占用均为 0。混合控制与查询请求 P95 位于 (100, 250]ms 桶，不能替代单独的变更接口 SLO 测量。逻辑并发为 40，采样物理峰值为 17 个预算占用和 21 个进程；这不是 40 个长期活跃模型执行的稳态测试，且本轮与编译/回归同时运行，不能作为隔离资源基线。成功和失败证据均保留。

最终诊断命令：

```sh
node tools/perf/runtime-reliability/workload.mjs --profile diagnostic --duration-seconds 120 --concurrency 40 --max-cycles 40 --runtime-dir target/debug
```

运行时日志中的 `commit` 是当时尚未提交的基线 HEAD；最终内容由 `validated-source-manifest.json` 的 79 个源码摘要绑定，合并前重新校验。不要将基线 SHA 当作包含本次改造的发布提交。

## 不变量与故障矩阵

| 范围 | 主要实现/证据 | 尚需验证 |
| --- | --- | --- |
| I01/I02/I07 | 数据库唯一和身份约束、同参数回执、事务启动边界、旧代次拒绝 | 更完整并发崩溃注入 |
| I03/I06/I10 | 独立 Host、未知不重派、真实关闭证明、离线审批/交付 | Host SIGKILL 后所有平台进程归属、外部资源 handler |
| I04/I05/I08 | 原交付验收、不可变 submission、Accepted 单调、执行独立收尾 | 真实业务小流量对照 |
| I09/I11 | 持久 outbox/日志/游标、恢复负责人、人工重试、legacy 未知隔离 | 全部磁盘失败及旧快照恢复窗口 |
| I12/I13/I14 | 有界队列/重试、唯一预算写者、基础设施和业务结果分离 | 长跑资源基线、账号级持续限流公平性完整验收 |
| F02/F04/F05/F10/F13/F21/F29 | 已有组件或真实进程测试，详见同名 Rust 测试及日志 | 不能外推未测平台/后端 |
| F07/F09/F12/F14–F18/F20/F22/F24/F26–F28 | 已有部分约束、兼容或组件证据 | 完整故障组合、负载及恢复场景仍未全覆盖 |
| F01/F03/F08/F11/F19/F23/F25 | 保留矩阵中的发布阻塞状态 | 必须补齐真实注入/升级/旧快照证据 |

## 保留的发布阻塞项

- Windows hosted 的受控树、peer identity 与真实平台验证；其他 hosted 后端/托管账号能力。
- 完整合作取消→宽限→强制停止策略；当前已验证的是强制停止与严格证明路径。
- Host 被 SIGKILL、日志/磁盘失败、实际 PID 复用、旧控制快照对账，以及所有外部 native CLI/工具依赖的运行中版本固定。
- 40 个长期活跃执行的稳态基线、连续 24 小时功能长跑和 72 小时 soak。
- macOS arm64 打包后真实启动 smoke 已通过；仍缺隔离升级/兼容回退、完整备份恢复开放准入流程、真实设备 UI 和真实模型业务对照。

因此，本记录不能用于声称主规划全部完成、默认启用 hosted 或批准生产放量。
