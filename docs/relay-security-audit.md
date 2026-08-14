# T7 E2E 与 Relay 安全审计

审计日期：2026-08-14。范围为 T6 集成后的 `@prospero/protocol`、daemon
relay host client、relay 服务及其 Compose/Caddy 部署面；移动端未改动。

## 威胁覆盖与可重复证据

| 威胁面 | 覆盖和证据 |
| --- | --- |
| E2E 篡改、截断、重放、乱序、跨 stream 调包 | `packages/protocol/test/crypto.test.ts` 覆盖四类帧攻击、不同临时会话的跨通道帧与静态身份证明对客户端临时公钥/协商版本的绑定。任何解密失败都会由 daemon 的 E2E 路径关闭连接。 |
| relay 观测业务内容 | `npm run test:e2e --workspace @prospero/relay` 启动真实 daemon、MySQL、Redis、relay，并以透明观察代理验证 direct、relay 与竞速路径。ready 后帧不含 ping、pong、workspace 或业务 marker，仍可由端点解密。 |
| 持久化、日志、metrics | `apps/relay/test/security-audit.test.ts` 验证 credential-shaped 日志字段根/嵌套脱敏、ticket 存储键为域分离摘要且一次性消费保持正确。`test/integration.test.ts` 直接读取 Redis 和 MySQL，断言 Redis 无 raw ticket、MySQL digest 为 32 字节且不含 raw token。指标只使用固定 endpoint/reason/direction 标签。 |
| first-message、ticket、snapshot、撤销、newest-wins | `apps/relay/test/relay.test.ts` 覆盖 first frame、二次帧竞态、atomic full snapshot、generation、撤销关闭、过期/错误 stream ID/并发 ticket 消费、route stream cap、stale host fencing 与 newest-wins。 |
| 尺寸、限流、背压、超时、慢读写、关闭 | 同一 relay 测试覆盖 1 MiB/16 MiB 限制、认证与连接限流、32 MiB 背压、ticket/auth/heartbeat deadline、pre-ready 关闭、延迟 admission 与 5 秒优雅关闭 deadline。Compose 设置 PID cap、只读根、无 capabilities、`no-new-privileges` 与 64 MiB 临时目录。 |
| Origin 和代理头 | `docs/relay-design.md` 与 relay README 明确：native 客户端可无 Origin，因此 Origin 不是认证边界；无 cookie/URL credential，仍必须 first-message auth。relay 仅信任固定 Caddy 后端 IP 写入的净化 `X-Prospero-Source-IP`；`security-audit.test.ts` 验证直接调用方伪造 `X-Forwarded-For` 或该专用头都不能改变限流键或进入 auth 日志。 |

## 发现与修复

1. **Redis AOF/RDB 会持久化 raw stream ticket。** 虽然 ticket 短时且非 QR
   relay credential，它仍是 bearer 值，不应出现在持久化存储。现在 Redis key
   使用 `SHA-256("prospero.relay.v1.stream-ticket-storage\\0" || ticket)`，值
   去除 `ticket` 字段；redemption 在运行内重新附回调用者已经提供的 ticket。
   Memory store 与真实 Redis 集成测试同步验证。
2. **未校验的 `X-Forwarded-For` 可绕过按源限流，也可将攻击者控制的文本写入
   auth-error 日志。** relay 现只接受配置的精确 proxy TCP peer 发出的、合法 IP
   形式的 `X-Prospero-Source-IP`。Compose 固定 Caddy 后端 IP、隔离 backend 网络，
   Caddy 删除公共 forwarding headers 后重建该头。
3. **relay 固定使用有公告的 `ws@8.18.0`，relay 测试固定使用有 critical 公告的
   `vitest@3.0.4`。** 升级 relay/daemon `ws` 到 `8.21.3`，relay Vitest 到
   `3.2.7`，同时更新 lockfile 的兼容 `nanoid` 到已修复版本。审计后 relay
   production workspace 为 0 vulnerabilities。
4. **部署层 core dump 控制不够明确。** 生产 relay Compose 禁用 core dump，并用
   read-only root、`cap_drop: ALL`、`no-new-privileges`、PID cap 和 internal
   backend 网络降低凭据或帧驻留进持久化/诊断面的机会。

## 依赖、许可证与 secret scan

- `npm audit --workspace @prospero/relay --omit=dev --json`：0 vulnerabilities
  （修复前为直接 `ws` high 和间接 nanoid high）。
- 全仓 `npm audit --json`：25（11 moderate、14 high、0 critical）。详情见
  下方残余风险；未使用 `--force` 绕过 Expo/React Native 的兼容边界。
- lockfile license 清点：1,164 个第三方 package entries；主要为 MIT（1,000），
  另有 Apache-2.0、BSD、ISC、MPL 等。仅 `qrcode-terminal` 和 `seq-queue` 的
  lockfile manifest 缺 license 字段；其随附 LICENSE 已分别核对为 Apache-2.0 和
  MIT。relay manifest 亦已补 MIT。
- secret scan：Docker Hub 上的 Gitleaks 拉取因 TLS handshake timeout 未完成。作为
  可重复 fallback，扫描 `git ls-files -co --exclude-standard` 的 345 个非依赖文件：
  AWS/GitHub/OpenAI/PEM 格式仅命中两个测试 fixture。generic
  token/secret/password assignment 启发式命中 14 个文件（39 处）；其中四个生产
  文件逐一核对均为运行时 credential 变量、空值隔离或 `.env.example` 占位符，
  没有字面 credential。扫描输出不打印候选值。

## 残余风险与运营要求

- 恶意 relay 仍能观察 route selector、IP、时间、帧大小并执行延迟、丢包、断连或
  流量耗尽；E2E 能检测完整性/重放，不能消除可用性攻击。
- 全仓 audit 剩余的 25 项来自 Expo/Metro/React Native 供应链及其开发工具。消除它们
  需要受控的 Expo SDK/React Native 升级与移动端回归，不属于 relay 协议最小修复。
- supplied Compose 保护 relay 容器；在宿主机直接运行 relay 或 daemon 时，操作方仍
  必须在进程启动前设置 `ulimit -c 0`，并保护 daemon 的 `PROSPERO_HOME`。运行中进程
  必然会短暂持有 first-message credential，无法仅靠应用代码让任意外部内存转储安全。
- Gitleaks 网络拉取失败使本轮没有其规则集的独立复核；fallback 未发现生产格式
  credential，但发布 CI 应安装并强制运行 Gitleaks/等效 secret scanner。
