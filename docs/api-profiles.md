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

连接或密钥发生变更时，既有验证结果失效；重命名保留验证结果。
活动会话仍禁止修改连接。损坏或包含未知显式协议的 Profile 保留原 ID 和原始
存储内容，账号显示 `apiProfileError`，可修复或删除；不会退回普通 CLI 账号。

## 测试连接的范围

能力标记 `agent.api-validation.v1` 开放 `agent.account.api.test`，请求只包含
`requestId` 和 `accountId`。本机控制接口和已授权手机沿用现有账号管理鉴权。
保存配置、刷新列表及启动 daemon 都不会自动发送测试请求。

结果分开记录 CLI 可用性、SSE 流式响应、合成工具结果回传。CLI 检查在临时
配置目录执行 `--version`；两轮 API 请求只包含合成提示、随机 nonce 和无副作用
测试工具的回执，不读取项目文件。它验证直接 API 协议兼容性，**不代表完整的
Codex、Claude Code 或 OpenCode 执行验证**。界面按此范围显示结果。

默认总预算 20 秒，最多两次请求，累计响应上限 256 KiB；不跟随重定向，不自动
重试。断开连接或 daemon 关闭会取消检查。同一 Profile 不并发测试，测试期间
连接修改被拒绝；结果写入前重新检查配置和密钥版本，避免过期结果显示为通过。
对外只返回固定错误分类和说明，不回显上游响应体、CLI stderr 或凭据。

## 回归验证

- `api-profile-probe.test.ts`：三种协议的流式响应、工具往返、错误、断流、取消、
  超时、响应大小限制和重复调用防护，使用本机模拟服务与测试凭据。
- `api-profile-control.test.ts`：显式触发、控制口鉴权、并发限制和验证失效。
- `agent-accounts.test.ts` / `account-capabilities.test.ts`：损坏配置修复、旧数据
  兼容、能力限制、固定模型、验证版本和模型元数据。
- Desktop / Mobile 的表单与启动选项测试，以及 Swift `AgentAccountsTests`。

完整 Agent 适配器另有各自的测试；API 连接验证通过不能替代目标服务上的实际
Agent 工作流验收。

真实 Claude / Codex 模型测试必须分别显式设置 `PROSPERO_REAL_CLAUDE_TESTS=1`
或 `PROSPERO_REAL_CODEX_TESTS=1`，会使用本机登录态并消耗对应服务额度。
普通测试默认跳过这部分，仍运行适配器的桩数据测试。
