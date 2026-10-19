# 模型网关接入与凭据更新

本文描述 Prospero 模型源的通用接入和更新流程。示例均为占位值，不记录特定组织的网关、登录端点、模型标识或本机部署情况，也不代表已经验证某个供应商。

## 协议与配置

按供应商实际支持的协议配置模型源与路由：Anthropic 使用 Claude，Responses 使用 Codex，Chat Completions 使用 OpenCode。模型名不能代替协议兼容验证。

| 配置项 | 示例或要求 |
| --- | --- |
| 模型源名称 | 自定义显示名称 |
| Base URL | `https://gateway.example.invalid`，仅为不可用的占位地址 |
| 模型 ID | 供应商公布且账号有权限使用的模型 |
| 凭据 | 供应商要求的完整 API Key 或访问令牌 |
| 自定义 Header | 仅添加供应商明确要求的字段 |

需要浏览器或设备授权时，使用供应商支持的登录工具。令牌有效期和刷新方式以供应商为准，不假定可无限期无人值守续期。不要把真实凭据写入文档、命令行参数、终端输出或 Git。

## 更新模型源并重新绑定

先确认实际运行的 daemon 及其数据目录，从该目录的 `connection.json` 获取本地 API 地址和鉴权信息。不要只更新旧数据目录。本地 API token 与供应商凭据用途不同。

调用 `POST <baseUrl>/v1/model-sources`：

1. 使用 `list` 读取当前模型源、路由及 revision。
2. 使用 `credential.set` 更新指定凭据。
3. 再次读取当前 revision。
4. 使用 `bind` 为启用的路由建立当前版本的账号绑定。
5. 新会话选择新绑定；在途会话按其既有生命周期处理。

外层请求：

```json
{
  "type": "model.source.action",
  "requestId": "<唯一请求 ID>",
  "action": { "kind": "list" }
}
```

更新凭据的 action：

```json
{
  "kind": "credential.set",
  "sourceId": "<模型源 ID>",
  "revision": 4,
  "credentialId": "<凭据 ID>",
  "name": "<凭据名称>",
  "apiKey": "<由程序安全读取的凭据>"
}
```

绑定路由的 action：

```json
{
  "kind": "bind",
  "sourceId": "<模型源 ID>",
  "revision": 5,
  "routeId": "<启用的路由 ID>",
  "agent": "claude"
}
```

示例 revision 不是固定值，agent 也须与实际路由匹配。绑定保留凭据版本；仅更新模型源或刷新界面不会自动替换旧绑定。hosted 执行还固定私有账号快照，原账号后续变更不改写该次执行。

## 验证与排查

在供应商允许的环境中核对模型列表与目标协议，再通过 `POST <baseUrl>/v1/accounts` 执行引擎验证：

```json
{
  "type": "agent.account.api.test",
  "requestId": "<唯一请求 ID>",
  "accountId": "<新绑定的账号 ID>",
  "scope": "engine"
}
```

检查 `engineValidation.status` 和各项 checks。HTTP 成功、模型列表可读、协议探测成功与实际 CLI 工具往返成功是不同证据；结果不一致时分别记录，不能概括为全部通过。

- 鉴权失败：确认令牌有效期、供应商要求的格式及当前账号绑定版本。
- CLI 不可用：检查 daemon 的 PATH 和实际安装路径；必要时配置相应 CLI 二进制覆盖变量，例如 `PROSPERO_CLAUDE_BIN`。修改当前终端环境不会改变已运行 daemon 的环境。
- 新凭据已保存但旧会话仍失败：检查绑定版本和会话使用的账号，不要直接改写在途执行的状态。

参考实现：`apps/daemon-rs/src/accounts/sources.rs`、`apps/daemon-rs/src/server.rs`、`apps/daemon-rs/src/accounts/probe.rs`。
