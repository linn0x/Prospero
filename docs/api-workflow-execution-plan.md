# API 工作流执行改造方案

状态：待实现与验收的通用设计方案，不对应特定外部仓库或生产环境。

本方案面向插件长期无人值守运行：保留多 Agent、typed feedback、DAG 依赖和证据验证，将执行归属提升到 API 层，统一准入、执行、恢复、清理、证据和交付的生命周期。

外部结果平台只承载业务结果与少量进度展示；插件数据库保存权威工作流状态；daemon 保存实际任务生命周期；证据保存在持久化文件或对象存储。实施可以分阶段，但最终交付必须覆盖完整闭环。

## 1 改造目标与边界

每个已登记 API 必须持续推进，或者进入明确、持久化、可解释的等待或终态。API 释放执行许可后，后台责任仍有明确负责人。

- 同一 服务 默认连续推进一个 API，直到必要工作完成或确实需要长期等待。
- 保留阶段独立 Agent，支持 API 内声明过的有界并行。
- 按需物化执行图，未准入 API 不提前铺满 Run。
- 插件或 daemon 重启后自动对账恢复。
- 系统故障、业务探索和外部等待分别处理。
- 证据保存、共享清理和外部交付各自可靠收敛。
- 全局容量、成本和存储增长有界。
- 外部结果平台不可用不影响正常测试推进。

改造主要位于插件侧。daemon 继续提供 Run、Task、worker、session 和幂等操作能力，不需要理解 API 业务流程。插件依赖的 daemon 接口须经过契约测试；接口能力不足时显式处理，不能用本地状态假装远端操作完成。

## 2 当前实现与改造切入点

以下为设计评审归纳的行为模式；实施前需对照目标系统的 controller、reducer、store 和 batch 实现重新核验。

| 当前行为 | 改造要求 |
|---|---|
| Batch 遍历全部 API 并立即 ingest/apply seed | 全量登记，获得许可后才提交普通执行节点 |
| reducer 一次生成区域后续 DAG | 保留逻辑 DAG，按 fragment 逐步物化 |
| reconcile 对全 Run action 按依赖深度排序 | 先选持有许可的 API，再选其可执行节点 |
| worker 容量主要统计 dispatched task | 纳入启动认领、启动结果未知及实际运行占用 |
| Plan 根据已有 actions 是否终结判断 settled | 加入未物化必需节点、待处理 replan 和不确定提交 |
| Batch 根据 loops、plans、tasks、gates 判断完成 | 基于登记的 execution 集合聚合完成状态 |

现有冻结启动请求、进程锁、证据机制及投影 WAL/DLQ 应复用。当前调度偏向浅层节点，但静态代码不足以证明它是全部运行问题的根因。

## 3 总体架构

```text
批次输入
  → API Registry：冻结目标、profile、策略版本
  → Admission Scheduler：容量、优先级、公平性
  → ApiExecution：持续持有执行许可
      → Discovery
      → Region Executions
          → Prepare → Explore → Validate → 按策略扩量或补充
      → Evidence Finalization
          → 本地结果可靠保存
          → 释放 API 许可
          → Outbox → 外部结果平台业务结果

独立后台责任：共享资源、清理、恢复、交付、归档
执行适配：JIT Fragment → graph.apply → worker.start/stop → 对账
```

| 组件 | 职责 |
|---|---|
| Batch Registry | 登记全部 API，冻结测试目标和策略 |
| Admission Scheduler | 分配 API 许可和 worker 额度，处理公平性与唤醒 |
| Workflow Reducer | 根据结果和 typed feedback 决定业务下一步 |
| Frontier Compiler | 将当前最小可执行节点编译成 fragment |
| Action Reconciler | 对账 daemon、启动停止 worker、验证产物及恢复 |
| Evidence Finalizer | 固化结果、证据清单和产物索引 |
| Shared Resource Manager | 管理共享资源创建、消费、失效和清理 |
| Projection Writer | 异步写入外部结果平台业务结果 |
| Batch Aggregator | 聚合测试、环境清理和交付状态 |
| Maintenance Worker | 归档、保留期和积压治理 |

这些是职责边界，不要求拆成同等数量的进程。

## 4 权威数据与部署持久化

| 数据 | 权威来源 |
|---|---|
| API 身份、工作流、业务 revision、许可、等待条件 | 插件数据库 |
| task、dispatch、session 实际生命周期 | daemon |
| 请求响应、复现包、CSV 等证据内容 | 持久化文件或对象存储 |
| 证据归属、校验值、索引、结果版本 | 插件数据库 |
| 外部结果平台写入义务和交付状态 | 插件 outbox |
| 人工备注、负责人、处置进展 | 外部结果平台人工字段 |

插件可以缓存 daemon 状态，但须记录观测时间，不得让缓存成为竞争的权威来源。

- 数据库和证据目录独立于临时容器文件系统。
- 单机单写者可以继续使用 SQLite。
- 多副本使用统一协调数据库，或严格保证一个有效调度写者。
- 不使用共享文件系统上的 SQLite 承担多主机并发调度。
- 明确备份、恢复、schema 迁移和恢复演练。

## 5 执行身份与数据模型

每次测试使用独立 `api_execution_id`，关联 `batch_id`、`run_id`、`service_id`、`api_id`、`execution_profile_id`、`target_fingerprint`、`workflow_version` 和 `policy_version`。

`target_fingerprint` 冻结 method、path、API 版本及影响目标语义的配置。第一版约束：同一 Run 内同一个 api_id 只对应一个冻结目标和 profile。复测建立新 execution，不重写旧历史。

未来若支持同 Run 多目标，必须同步迁移 loop、产物路径、反馈校验和共享资源键，不能仅扩展 API 主表。

| 实体 | 核心内容 |
|---|---|
| api_executions | 身份、调度状态、阶段、结果指针、累计预算 |
| region_executions | 区域、业务 revision、当前计划、区域结果 |
| workflow_plans | 必需节点、依赖、条件分支、完成条件、版本 |
| graph_fragments | 冻结请求、operation ID、提交状态、task 映射 |
| actions | stage、所属执行、尝试号、task、启动状态 |
| permits | 作用域、owner、epoch、认领和释放状态 |
| wake_conditions | 等待原因、条件 token、下次检查时间 |
| shared_resources | 资源身份、消费者、有效期、创建清理状态 |
| finalization_jobs | 证据固化和清理责任、执行状态 |
| business_results | 版本化业务结果和证据索引 |
| projection_outbox | 目标记录、版本、payload、重试交付状态 |
| scheduler_events | 调度决定、原因、关联 execution/action |

优先扩展现有实体。通过外键、唯一键和原子条件更新约束执行归属、操作身份和有效许可；容量上限由事务认领保证，不能依赖先查数量再无锁启动。

## 6 状态设计

调度、工作流、业务结果和后台责任分别表示。

### 6.1 调度状态

```text
REGISTERED → READY → ADMITTED
                       ├─ RELEASING → WAITING → READY
                       └─ RELEASING → CLOSED
```

- REGISTERED：已登记，准入前置条件尚未满足。
- READY：可以竞争许可。
- ADMITTED：持有 API 许可。
- RELEASING：处理运行任务和不确定操作，许可尚未返还。
- WAITING：检查点已保存，等待外部条件。
- CLOSED：本次执行不再产生普通工作。

暂停和取消作为独立控制请求，经执行层确认后收敛，不能直接把数据库字段改成停止。

### 6.2 工作流阶段

`DISCOVERY → REGION_TESTING → ENRICHING → FINALIZING → FINISHED`。

AUTO 表示发现阶段的兼容投影，不单独消耗 API 许可，也不作为最终测试区域。

### 6.3 业务结果和后台责任

业务结果包括满足验收标准的结果、连通性确认、状态空间耗尽、不适用、前置域名或输入数据阻塞、安全限制停止、预算耗尽及结果不完整。基础设施故障单独记录，不伪装成业务结论。

分别保存 `evidence_status`、`cleanup_status`、`delivery_status`，允许表达“已验证结果，扩量达到资源上限，证据已保存，清理完成，外部结果平台待重试”。

## 7 准入容量与公平性

### 7.1 容量口径

独立核算全局 API、profile API、每 服务 API、全局 worker、每 API worker、并行区域、supervisor/session 及恢复清理额度。

worker 占用包含已认领启动、启动结果未知和实际运行中。API yield 后 Run/session 是否保留须明确核算，逻辑许可返还不代表物理资源已释放。

建议初始策略：每 服务 一个活跃 API，每 API 一个并行区域，每 API 最多三个 worker，输入准备 fanout 最多三个。全局额度依据部署资源配置。

### 7.2 调度顺序

1. 对账 worker，校验并提交已完成结果。
2. 处理到期清理、恢复对账和必要固化。
3. 推进已准入 API 的可执行节点。
4. 有空闲许可时，从已唤醒和新 API 中公平准入。
5. 本轮无立即可推进工作或达到工作预算时结束。

API 内优先当前区域、解除 join 和必要 replan。不能让直接后继永久压住它依赖的兄弟节点。

跨 服务/profile 使用配额、优先级和等待时长控制公平性。恢复 API 与新 API 都不能永久饥饿。

### 7.3 有界连续执行

正常推进不按固定时间轮转，但持久化总请求、成本或 token、探索范围、重试和累计执行时间上限。进程重启不重置预算。达到上限后形成明确结果或检查点，不以“仍有信息增益”为由无限占槽。

## 8 逻辑工作流与 JIT 物化

Reducer 持久化必需阶段、依赖、条件分支、可选阶段、结果要求、replan 目标和完成判定。Compiler 只物化当前可执行 fragment。未准入 API 不提交普通节点。

每个 fragment 保存：

```text
fragment_id / api_execution_id / region_execution_id
plan_version / frontier_generation
operation_id / frozen_request / request_digest
submission_state / task_id_map
```

提交状态区分 `PREPARED`、`SUBMITTING`、`UNKNOWN`、`APPLIED`、`REJECTED`。超时属于 UNKNOWN，保持原 operation ID 和冻结请求恢复。已确认无远端变更的 revision conflict 可以重新构造提交，并使用明确的新提交尝试身份。

Plan 完成必须同时满足：

- 必需逻辑节点全部完成或按策略合法跳过。
- 无待处理 replan。
- 无结果未知的 fragment 或启动操作。
- 必需输出验证通过。

frontier 是可重建的派生状态；缓存须绑定 generation。

业务 replan 增加业务 revision，系统重试只增加 attempt。旧未启动节点 supersede；旧运行节点停止或隔离；新节点使用独立产物路径。迟到结果保存为历史证据，通过版本校验后才能影响工作流。revision 增加不自动释放 API 许可。

JIT 减少提前创建的节点，但会增加分次提交次数；性能及 revision 冲突收益须测量验证。

## 9 等待让位与恢复

短期系统故障保留冻结操作，指数退避并加入抖动，不消耗业务 revision，不产生虚假 DOMAIN_GAP 或 MATERIAL_GAP。超过短期窗口后进入明确的基础设施等待状态。

业务 replan 必须提供具体新候选或条件变化，用已尝试状态指纹去重，禁止无新状态的无限重试。

当前区域长期等待时，先尝试同 API 其他区域。整个 API 无可推进工作时申请让位，必须满足：

1. 检查点、等待条件和检查时间已持久化。
2. 已解决运行 worker 和结果未知的启动。
3. 远端停止已确认，或剩余工作明确保留且继续计入资源占用。
4. 旧调度决定不能再启动新工作。
5. 最后返还 API 许可。

`permit_epoch` 用于拒绝旧决定，但不能代替远端停止确认。

账号库存、部署、输入数据和人工控制等唤醒 token 必须对应真实检查来源。没有事件源时低成本轮询，不反复启动 Agent。`not_before` 到期只允许重新检查，不代表阻塞已解除。

## 10 崩溃恢复与幂等

恢复顺序：取得写者资格；加载未关闭执行和后台责任；读取 daemon 快照；恢复 graph/start/stop 不确定操作；验证产物并补交反馈；重建 frontier 和容量；然后恢复准入。

关键操作遵循“持久化意图和稳定身份 → 发出请求 → 保存确认”。

| 层次 | 保证 |
|---|---|
| graph | 幂等提交和 task 映射恢复 |
| worker | 同一逻辑启动的幂等恢复 |
| feedback | 去重、执行身份及版本校验 |
| 目标请求 | 明确重试语义和尝试记录 |

不普遍承诺目标请求 exactly-once。请求已发出而响应未保存时记录结果未知；能否重试由请求语义和目标幂等能力决定。不能将“未重复启动 worker”等同于“未重复发请求”。

## 11 共享资源与清理

共享资源独立于 API 私有生命周期。记录完整作用域、创建操作、资源标识、消费者、有效期、失效条件和清理责任。作用域应包含必要的 region、身份、profile 和业务用途，不能仅按 region 区分不兼容资源。

消费者状态为 `REGISTERED / USING / DONE / SKIPPED / CANCELLED`。未准入、无对应部署区域及被取消的消费者都有退出等待集合的路径。

创建者失败或 yield 后由资源管理器接管。清理可以晚于 API 释放许可，但必须有持久化任务、独立执行额度、重试恢复、取消路径和超期告警。未确认清理完成前不能标记环境收敛。

## 12 证据固化与业务结果

各 profile 定义必需证据：真实请求保存尝试、响应、可用 LogID 和上下文；未进入 Fuzz 保存阻塞依据及未执行标记；价格采集保存实际数量和 CSV；扩量不足保存已尝试范围、剩余空间及停止依据。

固化流程：

1. 保存不可变产物。
2. 验证可读性、校验值和归属。
3. 在同一数据库事务提交业务结果版本和 outbox。
4. 标记证据可靠保存。
5. 执行静止且剩余后台责任已登记后释放 API 许可。

已验证事实属于特定目标、时间和证据版本，系统错误不得改写其历史。合法复测可以形成新结果，不能因“历史结果不可改写”永久隐藏更新的证据。

## 13 外部结果平台业务展示与异步交付

目标外部结果表由部署方指定。下表为建议结构，实施前须读取实际 schema 建立映射，不代表已核实的现有字段。

| 类型 | 建议字段 |
|---|---|
| 身份 | 服务、API ID、method、path、profile |
| 业务进度 | 待评估、评估中、等待条件、已完成 |
| 结论 | 有效结论、依据、业务阻塞原因 |
| 覆盖 | 已测区域、未完成区域 |
| 采集 | 实际有效价格数、扩量结果 |
| 证据 | 报告、CSV、复现包链接 |
| 版本 | 最近评估时间、结果版本或 execution 标识 |
| 人工协作 | 负责人、备注、处置进展 |

运行 permit、worker 心跳、fragment、内部 revision 和重试流水留在数据库及运行面板。

投影规则：

- 外部结果平台不参与准入、恢复和完成判定。
- 进度与结论分列，复测开始不清空旧结论。
- 按业务键和有序结果版本更新，旧重试不得覆盖新版本。
- 同一记录写入串行化；创建结果未知时先查重恢复映射。
- 只更新插件字段，保留人工字段。
- 可恢复错误退避重试；永久错误进入可查看、可重放的异常队列。
- 进度更新可以合并，最终结果不能因合并丢失。

如果外部结果平台也提供待测清单，启动批次时导入冻结快照，后续编辑不直接改变运行中的 execution。数据库及证据应足以重建插件拥有的业务视图。

## 14 API 服务 与 Batch 完成边界

分别聚合三个维度：

| 维度 | 完成条件 |
|---|---|
| 测试完成 | 所有登记 API 形成本次执行终态并完成必要证据固化；WAITING 不算完成 |
| 环境收敛 | worker 已终结或完成接管，session 回收，必要共享清理完成 |
| 交付完成 | 必需业务结果同步成功；异常单独明确展示 |

聚合基于登记的 execution 集合，不只数已创建的 loops/tasks。服务 Run 在不再追加任务、现有任务终结且相关运行义务收敛后关闭；外部结果平台投影可以在 Run 关闭后继续。

批次可展示“测试完成，清理中”或“测试完成，交付异常”，不得用一个 completed 掩盖剩余责任。

## 15 长期运行与故障隔离

- 所有远端调用有超时，每轮 reconcile 有工作量和时间预算。
- 全局锁内仅做必要原子认领，慢调用在锁外执行并回写。
- 单 API、manifest 或投影故障不能拖停全局。
- 为恢复、固化和清理预留容量。
- 磁盘不足或证据存储异常时暂停新准入，保护已有结果。
- 对 outbox、事件、日志、task 历史和证据制定积压、保留和归档策略。
- 删除产物前确认无活跃执行、清理或交付引用。
- 固定 workflow、profile 和 worker contract 版本，升级不改变旧批次语义。

运行面板展示最后成功对账时间、各层占用及不确定占用、最老等待、无进展 API、清理积压、投影积压、孤立 worker/session、数据库与证据存储健康状态。调度事件包含原因、候选摘要和执行身份，支持解释为什么此时推进某个 API。

## 16 实施与迁移

| 阶段 | 内容 | 阶段验收 |
|---|---|---|
| 一 | 身份、状态、容量、完成和证据契约 | 状态转移、owner 和权威来源明确 |
| 二 | API ownership、全局容量、让位恢复、共享生命周期 | 完整 DAG 下稳定连续推进 |
| 三 | JIT fragment、幂等物化、版本隔离 | 未准入 API 不铺图，恢复不丢节点 |
| 四 | 固化、投影、批次聚合、运维治理 | 生命周期闭环 |
| 五 | 故障注入、迁移演练、长时间验证 | 达到上线标准 |

旧批次先接管已有 API，允许暂时超过新许可上限；超额时禁止新增准入，不遗弃已有 worker。旧批次保留完整 DAG，新批次使用 JIT，共用 ownership、恢复和完成契约。

迁移前备份。回滚版本必须理解新增状态，不能简单回退 schema。阶段二是中间验证点，不代表本次完整需求交付。

## 17 最终验收标准

### 调度容量

- A 持有许可且可推进时，B 不抢占同 服务 新准入。
- 局部并行符合声明上限，未知启动不提前返还容量。
- 服务/profile 在持续负载下不永久饥饿。

### JIT 与完成

- 未准入 API 不创建普通节点。
- 未完成 fragment 数受准入数和物化窗口约束。
- 未物化必需节点不被误判完成。
- 历史图增长有独立治理，pending 有界不等同总存储有界。

### 恢复竞态

- 在 graph、start、stop、结果、反馈、outbox 边界注入崩溃。
- 重启不丢执行，不重复产生逻辑启动，不让旧反馈推进。
- 迟到 worker 不绕过重新准入。
- daemon 与插件冲突按权威来源收敛。

### 共享清理

- 创建者失败、消费者取消、批次取消、资源失效后仍可清理。
- 满载时 cleanup 得到执行机会。
- 未完成责任可查询、告警和重试。

### 证据交付

- 未执行请求不生成请求证据。
- 结论及产物可校验、可追溯。
- 外部结果平台中断不阻塞测试，恢复补齐且不覆盖新版本。
- 人工字段不被插件覆盖。

### 持续运行

- 长时间演练覆盖升级、daemon 重启、外部中断和资源耗尽。
- 无持续增长的孤立 session、无 owner permit 和未解释积压。
- 每个未完成 API 都能说明当前状态、阻塞依据、下一步及恢复条件。

最终交付是一套可从数据库恢复、与 daemon 对账、以证据验证并向外部结果平台重建业务视图的插件执行系统。API 粘性调度和 JIT 共同服务于这一目标。

## 18 GPT-6 Astra 架构评审任务

请把本文当作待挑战的设计提案，而不是既定实现。评审范围限定在 API 工作流扩展：daemon 只被视为提供 Run、Task、worker、session、幂等控制请求和权威任务快照的执行底座。除非某项插件设计在现有 daemon 契约下无法正确实现，否则不要把 API 业务调度职责下沉到 daemon。

评审需要回答：

1. API execution 是否是正确的一级调度和许可单位；region 应当是 API 内部子状态，还是也需要独立许可。
2. “每 服务 默认一个 active API、API 内有界并行”的策略是否能兼顾完整结果交付、吞吐和跨 服务/profile 公平性。
3. API 粘性调度、blocked-yield 和唤醒条件是否存在队头阻塞、饥饿、重复唤醒或永久占槽反例。
4. logical workflow、frontier compiler、JIT graph fragment 和 action reconciler 的边界是否清晰，是否存在两个组件同时拥有状态转移决定权。
5. graph.apply、worker.start/stop、结果提交和 typed feedback 的 UNKNOWN 窗口是否都能通过冻结请求、稳定 operation ID、permit epoch 和 frontier generation 收敛。
6. 业务 revision、系统 attempt、结果 version 和重新执行的新 api_execution_id 是否足以隔离迟到结果及复测历史。
7. 插件数据库与 daemon 快照冲突时的权威边界是否完整；是否还存在无法重建、无法证明或可能双重启动的状态。
8. API 许可在 EVIDENCE_DURABLE 后释放、Projection Outbox 独立重试是否会丢失必须交付的业务结果，或者反向被外部结果平台故障阻塞。
9. Shared Resource Manager 和独立 cleanup finalizer 是否避免了“创建者占槽等待尚未准入消费者”的死锁，同时仍能保证最终清理。
10. strict positive 保留规则是否既能抵抗后续系统故障，又不会掩盖一次合法复测得到的新证据。
11. 从旧完整 DAG 批次迁移到 ownership 门禁，再到新批次 JIT 的兼容路径是否存在不可回滚的 schema 或状态语义缺口。
12. 哪些不变量应由数据库唯一键、外键或原子条件更新保证，哪些可以只由调度代码保证。
13. 当前验收标准是否足以证明 pending 数量、孤立 session、无 owner permit、outbox、清理任务和证据存储在长期运行中有界。
14. 是否存在更简单的插件架构，能够达到同等的 API run-to-completion、可恢复性和证据完整性；如果有，请明确指出被删除的状态、表和组件以及不会损失的保证。

期望评审输出：

- 先给出 `接受 / 有条件接受 / 拒绝` 的总体结论。
- 按 `P0 正确性 / P1 可运维性 / P2 性能与简化` 分类列出问题。
- 每个问题给出一个具体失败时间线或状态反例，不只给抽象风险。
- 对每个 P0/P1 问题给出最小修订方案，并说明影响的数据模型、状态转移、恢复逻辑和验收测试。
- 最后给出推荐的最小可实施版本，以及从该版本演进到完整 JIT 架构的条件。
