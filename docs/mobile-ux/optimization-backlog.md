# 移动端优化 Backlog

来源：2026-08-12 静态审计。范围只含可稳定从源码复现的 P0–P2 项；纯视觉偏好未纳入。优先级以数据完整性和任务完成阻塞为先。每项的完整复现、预期/实际与验收细节见 [共享审计](shared-audit.md)、[iOS 审计](ios-audit.md)、[Android 审计](android-audit.md)。

## 2026-08-13 实施状态

以下为本轮对 `master` 的代码验收结论。状态“已实现”表示已通过静态代码核对与自动测试；原审计中标为真机、模拟器或读屏验收的条件仍须在发布门禁中按原证据逐项执行，不改变其原始审计结论。

| 项 | 状态 | 对应实现提交 | 本次核对 |
| --- | --- | --- | --- |
| SH-01 | 已实现 | `bdd6568` | 有界 FIFO 明确反馈 `sent` / `queued` / 拒绝；第 51 条被拒绝时草稿和附件不清空。 |
| SH-02 | 已实现 | `bdd6568` | WebView 终端、会话输入和 KeyBar 在断线时冻结，且不会自动重放 shell 字节。 |
| SH-03 | 已实现 | `bdd6568` | 冷启动占位按连接状态区分失败，显示错误、重试和返回主机入口。 |
| SH-04 | 已实现 | `4d04190` | 编排页区分 idle、connecting、reconnecting、failed；失败状态显示错误并可重试。 |
| SH-05 | 已实现 | `4d04190` | 首页按待处理 Gate 排序，显示被截断 Run / Gate 数并可深链定位。 |
| SH-07 / AND-03 | 已实现 | `f9821a2` | `SwipeRow` 提供命名读屏动作和“更多操作”菜单；危险动作复用确认。 |
| IOS-02 | 已实现 | `f9821a2` | 扫码与 Git 刷新入口具备角色、名称及刷新 busy / disabled 语义。 |
| AND-02 | 已实现 | `f9821a2` | Git 提交栏由 keyboard controller 跟随 IME，并以 safe-area inset 保留系统栏空间。 |
| AND-04 | 已实现 | `4d04190` | 文件页和编排页接入 `verticalPanes`，在分离铰链时只在连续面板渲染，控件不跨铰链。 |
| AND-05 | 已实现 | `f9821a2` | Expo 配置开启 predictive back；作为 CNG 生成物的原生 `AndroidManifest.xml` 会映射为 `enableOnBackInvokedCallback="true"`，本地生成产物已与该配置一致。 |

待完成的实现项：**SH-06、IOS-01、IOS-03、IOS-04、AND-01**。

## M1 · 可靠投递与连接恢复

归属：共享 TypeScript（`connection.ts`、会话路由）。依赖：无协议破坏性变更；如要显示 daemon 接收确认，可后续协商协议。测试：Vitest 覆盖队列边界与状态机；E2E 注入离线、握手失败和恢复。

| 项 | 优先级 | 工作内容 | 验收 |
| --- | --- | --- | --- |
| SH-01 | P0 | 将聊天/子 Agent 发送改为可观察的接受结果；队列满时保留草稿和附件。 | 51 条离线发送中第 51 条不会丢失，恢复后前 50 条严格有序。 |
| SH-02 | P1 | 为 PTY 与 KeyBar 增加断线锁定或本地待确认缓冲。 | 三个输入入口均不静默丢字节；恢复后需用户确认才重放。 |
| SH-03 | P1 | 会话冷启动占位页识别失败、提供重试/返回。 | 不可达 host 下 10 秒内可操作；恢复网络后进入同一 sid。 |
| SH-04 | P1 | 编排页按真实 `ConnStatus` 呈现失败并可重试。 | failed 不再显示“正在连接”，错误和重试可访问。 |

## M2 · 编排可见性与媒体恢复

归属：共享 TypeScript（主机摘要、ChatView、连接请求）。依赖：无；复用已有编排中心与附件请求 API。测试：组件测试验证 Run 排序/溢出跳转，网络故障注入验证图片重试。

| 项 | 优先级 | 工作内容 | 验收 |
| --- | --- | --- | --- |
| SH-05 | P2 | 主机摘要显示被截断 Goal Run/Gate 的数量，并直达对应编排 Run。 | 第 4 个 pending Gate 可从首页一跳处理。 |
| SH-06 | P2 | 历史图片失败占位改为带错误原因的可访问重试控件。 | 恢复网络后原地加载，且无重复并发请求。 |

## M3 · 共享无障碍操作基元

归属：共享组件 `SwipeRow`，Android TalkBack 验收、iOS VoiceOver 验收。依赖：React Native accessibility actions 与现有确认 Alert。测试：组件层 action 映射，真机读屏回归。

| 项 | 优先级 | 工作内容 | 验收 |
| --- | --- | --- | --- |
| SH-07 / AND-03 | P1 | 给每个 SwipeAction 提供命名 `accessibilityActions` 与“更多操作”替代菜单。 | TalkBack / VoiceOver 均可执行下载、重命名、删除、暂存、归档等动作，危险动作仍确认。 |

## M4 · iOS 附件与可访问性

归属：iOS + 共享 React Native UI。依赖：Expo ImagePicker SDK 57；永久权限拒绝时需要系统设置深链。测试：iOS 真机权限状态矩阵、VoiceOver、Dynamic Type、命中框检查。

| 项 | 优先级 | 工作内容 | 验收 |
| --- | --- | --- | --- |
| IOS-01 | P1 | 将图片选择的拒绝、取消、永久拒绝分开处理，永久拒绝提供 Settings 恢复。 | 四种权限状态均有明确、可读出的结果。 |
| IOS-02 | P2 | 为二维码配对和 Git 刷新图标补角色、名称与 busy/disabled 状态。 | VoiceOver 可无需视觉信息操作两入口。 |
| IOS-03 | P2 | 将列出的 chip、搜索、图片移除和终端键位实际命中框提升至 44×44 pt。 | iPhone 小屏上命中框合规且不重叠。 |
| IOS-04 | P2 | 使 xterm 初始字号跟随 Dynamic Type，持久化显式覆盖。 | 改系统字号后重入终端得到正确字号和 fit。 |

## M5 · Android 生命周期、窗口与输入区

归属：Android + 共享会话/文件/编排 UI。依赖：Expo ImagePicker SDK 57 的 pending result；既有 `prospero-window-layout` 模块；edge-to-edge / keyboard controller 集成。测试：Android 13–15，折叠屏、手势/三键导航、“不要保留活动”。

| 项 | 优先级 | 工作内容 | 验收 |
| --- | --- | --- | --- |
| AND-01 | P1 | 恢复 ImagePicker pending result，并按 host/sid 持久化未发送草稿和附件元数据。 | Activity 回收后选图和草稿回到原会话；成功/取消后正确清理。 |
| AND-02 | P1 | Git 提交栏显式消费导航栏与 IME inset。 | Android 13/15、手势/三键、横屏/分屏下输入与提交始终可见可点。 |
| AND-04 | P2 | 文件页、编排页消费 `verticalPanes` 与铰链 gutter。 | 分离铰链不遮挡行、任务图或输入控件。 |
| AND-05 | P2 | 启用 predictive back，并验证编辑态 `beforeRemove`。 | Android 13–15 预测动画正常，未保存编辑的确认语义不回归。 |

## 排除项

“文件失败无重试”未列入：文件列表已通过下拉刷新重发 `load(dir)`，属于已有恢复路径，不构成稳定缺陷。详见 [shared-audit.md](shared-audit.md#已剔除候选)。
