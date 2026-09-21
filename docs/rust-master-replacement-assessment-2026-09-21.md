# Rust 分支替换 master 评估（2026-09-21）

这是 `bbba795` 的实施前评估。已确认差异的后续实现与验证见 [功能和 shell 生命周期对齐记录](rust-daemon-parity-2026-09-21.md)；下文源码行号和限制描述保留为基线。

结论：**可继续作为 Rust daemon + TS/Electron desktop 的候选主线；目前不满足“无功能回退、无数据损失、所有平台可发布”的完整替换条件。不要现在删除 TS daemon 或直接以 Rust 分支覆盖 master。**

## 基准与证据边界

- 已刷新远端 refs：`origin/master=53aec26`，Rust 分支 `bbba795`。
- master 独有 8 个提交，Rust 分支独有 120 个提交；merge-base 到 Rust 分支涉及 274 个文件。不是一次只替换后端实现的小合并。
- 当前工作树还有此前留下的未提交改动（含 Agent MAX_TURNS、侧栏交互与进度文档）。本次只读检查代码，并运行当前工作树的 Rust library tests；这些结果不能冒充干净发布提交的全套验收。
- 本次 `cargo test -p prosperod-rs --lib --locked`：64 passed。未运行真实账号、真实 CLI、移动端、跨平台、长跑或完整打包验收。
- 前轮桌面 486 tests/typecheck/build 是局部客户端修改验证，不是完整替代门禁。
- `gh run list --branch exp/rust-re --limit 5` 返回空；当前 CI push 仅匹配 master，另支持 PR/workflow_dispatch。不能把 CI YAML 的平台矩阵当成已通过证据。
- 日常安装仍保留先前的 Rust daemon/main/preload，仅更新前端。其可用性不代表本分支最新 daemon 二进制及全部迁移链路已验收。

## 差异矩阵

| 领域 | 已有实现 | 替换判断 |
| --- | --- | --- |
| 本机桌面 | 原 Electron UI、Rust API 桥、分页与终端、文件/Git 工具 | 可继续日常试用；并非整个客户端改为 Rust。仓库内 desktop-rs 是另一条交付路径，不能与 Electron 验收混算。 |
| Agent/账号/模型源 | Claude/Codex/DeepSeek/OpenCode，账号、API Profile、模型源 | 需要完整矩阵。已确认桌面桥拒绝 `scope=engine`，master 支持该测试，Rust 服务又声明相关能力；这是明确的桌面功能差距。 |
| PTY | 原生 PTY/ConPTY、输出事件、持久化、快照、回放 | 重启恢复语义不同；不能保证活跃进程跨 daemon 重启无感保留。某些终端状态无法快照，原始输出裁剪后会明确拒绝恢复。 |
| 数据迁移 | legacy 配置、identity/devices、模型源、账号与 orchestration.sqlite 导入 | 已有迁移不等于完整迁移。所查入口没有覆盖普通会话历史与运行中上下文的完整无损接续。自动化迁移会把 running 改为 paused；编排目标已有 runs 时跳过导入。 |
| 编排、定时、插件 | DAG/worktree、schedule 路由、插件服务监督和健康检查均存在 | 不能因 master 独有提交就说功能全缺；但必须逐项对照参数、入口、失败恢复及幂等行为。 |
| 手机与远程 | 配对、设备、relay、加密及远程控制路径 | 实际手机连接、慢网重连、权限与兼容性未在本次验证。不能承诺与 master 等价。 |
| 发布 | 多平台 CI、验收与打包脚本 | 当前分支缺少可引用的 CI/发布产物证据。120 秒 soak 也不能作为长期稳定性证明。 |

## 已确认的源码依据

1. `apps/desktop/src/main/rust-runtime.ts:735`：拒绝账号 `scope=engine`；`apps/daemon-rs/src/server.rs:3529` 声明 `agent.api-engine-validation.v1`。对照 `origin/master:apps/daemon/src/ws-server.ts`，engine 分支实际调用 probeApiProfileEngine。
2. `apps/daemon-rs/src/terminal/store.rs:65`：恢复 active terminal 时将 session lifecycle/status 改为 Archived/Failed，并清除 active。不是重新附着活跃 shell。
3. `apps/daemon-rs/src/terminal/screen.rs:253`：不兼容状态或超出快照预算可拒绝 snapshot；`apps/desktop/src/main/rust-runtime.ts:290` 对裁剪历史且无快照的情况拒绝不可靠恢复。
4. `apps/daemon-rs/src/worker.rs:292`：legacy 导入是文件、账号、编排；`apps/daemon-rs/src/orchestration/store.rs:318` 暂停 running 自动化；`:484` 在目标已有 runs 时跳过旧编排导入。
5. `apps/desktop/src/main/rust-runtime.ts:1004`：PTY 账号与模型参数仅部分 Agent 放行。这里只列为待比对项，不将 master 也未支持的能力误报成回归。
6. `.github/workflows/ci.yml:3`：push 触发范围；`apps/daemon-rs/tests/agent_real_cli.rs` 中 5 项真实 Claude 测试默认 ignored。

## master 尚未合入的提交

`3426e58` 模型路由和编排存储；`54865a5` 粘贴与定时任务；`03ea631` 状态与归档；`faf4555` 对话框溢出；`ba495e2` 失效会话清理；`0133813` daemon 启动恢复；`ecb1aa8` 插件服务监督；`53aec26` 滚屏保留。

部分前端文件已相同或 Rust 已独立实现相应功能（例如滚屏缓存、schedules、plugin-services）。应按行为和回归测试核对，不能直接按提交数量判断缺失，也不宜盲目 cherry-pick 整批 TS daemon 改动。

## 建议的替换门槛与顺序

1. **先收敛交付范围**：Rust daemon + 当前 Electron desktop；暂不同时替换原生桌面/移动端实现。保留 TS daemon 回退入口。
2. **功能门槛**：补齐 engine 验证桥；逐项关闭 master 8 个提交的行为差异；按 Agent × PTY/structured × 本机账号/API Profile 覆盖创建、发送、工具、审批、取消、恢复、模型切换及附件。
3. **数据与生命周期门槛**：在旧数据副本上验证导入数量、历史正文、账号与定时任务；清楚说明不能接续的活跃会话；演练备份、切换失败和回退。要称“完全替代”，需补齐进程接管能力，或明确接受停机迁移的产品语义。
4. **发布门槛**：对一个干净且固定 SHA 运行 Rust check/test/contract、桌面单测与真实 daemon 集成、真实 CLI/手机端到端、各目标平台安装产物；记录 failures/ignored，不把跳过算通过。
5. **稳定性门槛**：补当前版本性能、慢客户端、取消/背压、资源回落、持续输出与 daemon 强杀恢复证据；长跑覆盖实际使用周期，而非仅 120 秒。
6. 门槛达标后通过合并 PR/候选发布逐步设为默认；稳定观察后再决定是否移除 TS 后端。

本次不修改运行中的 daemon、会话、账号或 master；未实施迁移和合并。

## 后续实施

以上是 `bbba795` 时的评估基线，不能作为后续代码仍未实现的证明。功能和 PTY 生命周期的后续改动、验证与切换边界见 [Rust daemon 对齐记录](rust-daemon-parity-2026-09-21.md)。
