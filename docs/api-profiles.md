# AI API Profile

Profile 继续沿用原账号 ID 和会话关联。`agent` 是兼容旧客户端的账号分组；
`engine` 表示实际执行引擎，由 daemon 根据协议计算。

| 协议 | 执行引擎 | 会话 |
| --- | --- | --- |
| `openai_responses` | Codex | 结构化、PTY |
| `openai_chat_completions` | OpenCode | 结构化 |
| `anthropic` | Claude Code | 结构化、PTY |

## 能力与配置

daemon 返回 `capabilities`：`sessionKinds`、`plan`、`resume`、
`modelSelection`、`reasoningEffort`。客户端优先使用这些字段；旧 daemon 没有
字段时沿用原协议映射。创建会话与会话内模型/模式操作都执行同样的能力检查。
API Profile 固定使用配置的模型；不接受单独的推理强度覆盖。

`modelCapabilities` 可记录 `contextWindow`、`maxOutputTokens`、`tools`、
`vision`、`reasoning`。缺省表示未声明，不等于已验证支持。数字范围为
1–100000000，输出限制不能大于上下文窗口。Chat Completions 的两个数字需要
一起设置或一起省略，因为 OpenCode 的 `model.limit` 要求两者同时存在。
`tools: false` 会阻止 Code Agent 会话启动；其余元数据不自动开放推理强度覆盖。

账号快照的 `modelCapabilitySupport` 只列出明确声明的项目：`enforced` 表示已接入
本地配置或输入检查，`unsupported` 表示当前引擎尚不能可靠应用。它不代表上游
模型能力已经验证，也不是对服务商计费 Token 数的保证。

| 声明 | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| 上下文窗口 | `model_context_window` | `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，限未识别的网关模型 ID | `model.limit.context` |
| 最大输出 | 暂不应用，界面明确提示 | `CLAUDE_CODE_MAX_OUTPUT_TOKENS`，原生运行时可能按模型进一步收紧 | 保留 `model.limit.output` 元数据，不承诺请求上限 |
| 禁用图片 | 结构化会话拒绝图片附件 | 结构化会话拒绝图片附件 | 结构化会话拒绝图片附件 |
| 禁用推理 | 仅关闭摘要，不能可靠禁用推理 | `MAX_THINKING_TOKENS=0`，SDK 显式关闭 thinking | 模型 `reasoning: false` |

图片检查在写入附件、排队、插入当前轮之前进行；恢复队列时再次检查，不能通过
文件路径降级绕过。Claude 原生支持图片输入；另外两个适配器当前使用文件引用，
所以不会把 `vision: true` 显示为已经接入原生图片输入。
Claude 的 `reasoning: true` 只保留声明，不凭布尔值强制选择一种 thinking 模式。
Codex 0.153.0 在关闭摘要后仍发送空的 `reasoning` 对象，不能保证严格网关接受或
模型停止内部推理；因此 `reasoning: false` 显示未应用，不宣称已经完全禁用。
OpenCode 1.18.29 的实际本地回环显示请求未携带输出上限，直接覆盖 `max_tokens`
会被原生运行时拒绝；因此同样显示未应用，不能仅凭配置文件推断请求限制生效。
Claude 已识别的模型家族以及 `[1m]` ID 不保证应用上下文覆盖，保留原生压缩行为并
显示未应用。相关依据见 [Codex 配置](https://learn.chatgpt.com/docs/config-file/config-reference)、
[Claude 模型配置](https://code.claude.com/docs/en/model-config)和
[Claude 环境变量](https://code.claude.com/docs/en/env-vars)。

连接或密钥发生变更时，协议验证和引擎验证结果均失效；重命名保留验证结果。
活动会话仍禁止修改连接。损坏或包含未知显式协议的 Profile 保留原 ID 和原始
存储内容，账号显示 `apiProfileError`，可修复或删除；不会退回普通 CLI 账号。

## 保存一致性与运行时检查

显式的配置/密钥修改使用同一个串行事务队列。私有事务日志先持久化完整目标状态，
随后写入凭据并原子替换账号元数据；中断后 daemon 在开放控制前重放事务。可恢复
的失败回滚原配置及原密钥；日志损坏或恢复失败会停止账号操作，不允许混用版本。
事务日志和凭据文件均为 0600，账号目录为 0700，日志不进入账号快照。

刷新账号列表使用按引擎和可执行文件身份区分的 CLI 版本缓存，相同运行时的并发
检查合并执行，并在 TTL 到期或可执行文件变化后重查。每个账号的密钥状态仍独立
读取，CLI 可用不等于这个 Profile 已认证或已验证。

## 测试连接的范围

能力标记 `agent.api-validation.v1` 开放 `agent.account.api.test`，请求只包含
`requestId` 和 `accountId`，可显式设置 `scope: "protocol"`。本机控制接口和已授权手机沿用现有账号管理鉴权。
保存配置、刷新列表及启动 daemon 都不会自动发送测试请求。

结果分开记录 CLI 可用性、SSE 流式响应、合成工具结果回传。CLI 检查在临时
配置目录执行 `--version`；两轮 API 请求只包含合成提示、随机 nonce 和无副作用
测试工具的回执，不读取项目文件。它验证直接 API 协议兼容性，**不代表完整的
Codex、Claude Code 或 OpenCode 执行验证**。界面按此范围显示结果。

默认总预算 20 秒，最多两次请求，累计响应上限 256 KiB；不跟随重定向，不自动
重试。断开连接或 daemon 关闭会取消检查。同一 Profile 不并发测试，测试期间
连接修改被拒绝；结果写入前重新检查配置和密钥版本，避免过期结果显示为通过。
对外只返回固定错误分类和说明，不回显上游响应体、CLI stderr 或凭据。

## 验证 Agent 执行的范围

能力标记 `agent.api-engine-validation.v1` 另行开放 `scope: "engine"`。
界面把它显示为“验证 Agent 执行”，结果保存到独立的 `apiEngineValidation`，
包含当时的 CLI 版本、时间，以及运行时、配置、流式事件、工具往返四项检查。
旧客户端省略 `scope` 时仍执行原来的直接协议检查。

该操作实际启动本机 Codex app-server、Claude SDK/CLI 或 OpenCode，在临时工作目录
和独立 HOME/配置目录中运行。测试只允许调用一个返回随机回执的无副作用工具，要求
引擎调用工具、把回执传回模型，并通过自己的事件流返回该回执。模型请求必须
携带指定模型和测试凭据，额外工具或端点会被拒绝。

真实 API Key 只交给 daemon 内的本地代理；子进程使用随机测试凭据。代理最多发送
两次上游 POST，每次输出预算不超过 1024 Token（声明更小时进一步收紧），累计
响应不超过 512 KiB；默认总预算 45 秒，最多 60 秒。它不自动重试，不跟随重定向，
会随取消和超时停止测试子进程并删除临时目录。

代理完整检查 SSE 中的工具操作后才交给引擎，因此此检查能验证原生事件解析及
合成工具链路，不能测量首 Token 延迟。该输出预算是测试代理的限制，不代表
日常会话已应用 Profile 的输出上限。结果也不代表真实项目工具、长会话、所有
模型能力或升级后新 CLI 已通过验收；版本和日期表示历史测试状态。

两种验证都只在用户显式点击后运行，可能消耗少量模型额度。它们共享同一 Profile
互斥、全局并发上限和断线取消机制；验证期间不可修改该 Profile，已有会话恢复
完成前也不开放账号修改或测试操作。

## 回归验证

- `api-profile-probe.test.ts`：三种协议的流式响应、工具往返、错误、断流、取消、
  超时、响应大小限制和重复调用防护，使用本机模拟服务与测试凭据。
- `api-profile-control.test.ts`：显式触发、控制口鉴权、并发限制和验证失效。
- `api-profile-engine-probe.integration.test.ts`：实际安装的原生 CLI 对接本机模拟
  服务，验证隔离配置和工具往返，不使用本机真实登录态或真实服务商。
- `api-profile-engine-probe.test.ts`：测试凭据、模型与端点匹配，阻止额外工具和
  重试，覆盖请求/响应大小、输出上限、取消、超时及子进程清理。
- `agent-account-transactions.test.ts`：配置与密钥回滚、事务重放、损坏存储拒绝、
  并发修改与会话占用检查，以及 CLI 缓存失效和并发合并。
- `api-profile-capabilities.test.ts` / `attachments.test.ts`：原生配置、SDK 启动参数、
  图片拒绝与队列恢复，不使用真实服务商。
- `agent-accounts.test.ts` / `account-capabilities.test.ts`：损坏配置修复、旧数据
  兼容、能力限制、固定模型、验证版本和模型元数据。
- Desktop / Mobile 的表单与启动选项测试，以及 Swift `AgentAccountsTests`。

完整 Agent 适配器另有各自的测试；API 连接验证通过不能替代目标服务上的实际
Agent 工作流验收。

本轮原生本地回环在 macOS 使用 Codex 0.153.0、Claude Code 2.1.263 和 OpenCode
1.18.29；这不是对其他 CLI 版本、Windows 运行环境或真实服务商的验收结论。

真实 Claude / Codex 模型测试必须分别显式设置 `PROSPERO_REAL_CLAUDE_TESTS=1`
或 `PROSPERO_REAL_CODEX_TESTS=1`，会使用本机登录态并消耗对应服务额度。
普通测试默认跳过这部分，仍运行适配器的桩数据测试。
