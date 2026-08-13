# 移动端共享 UX 审计

审计日期：2026-08-12。范围为 `apps/mobile` 的 TypeScript/React Native 源码；本轮没有真机、模拟器或网络故障注入实测。证据等级中“静态（代码链路）”表示可从源码确定执行结果，“静态（界面路径）”表示代码显示了可复现的 UI 缺口，仍应在发布前补设备验收。

## 2026-08-13 T5 验收增补（自动化通过；设备结论未通过）

SH-01 / SH-02 / SH-03 的实现提交为 `bdd6568`，SH-04 / SH-05 为 `4d04190`，SH-06 为 `e8414b5`，SH-07 为 `f9821a2`。`npm test -w @prospero/mobile`（24 文件 / 148 测试）、TypeScript、Expo lint 与终端 HTML 生成均通过且无生成漂移；这些只证明单元/静态行为，不能替代离线恢复、读屏或网络故障设备验收。

iOS 的两个全新模拟器在 generic Simulator release app 启动后都是纯黑窗口；Android 只完成 API 33 空态启动，API 35/Fold 无法建立，且“不要保留活动”下进入配对页后为空。故这里不把任何共享项标为完整模拟器或真机通过。VoiceOver、TalkBack、真实相机、OEM IME、跨平台离线/重连 E2E 与真机网络环境仍是待办。详见 [优化 Backlog](optimization-backlog.md#2026-08-13-t5-构建与模拟器终验未通过gate-待决)。

实现建议以 Expo SDK 57 为基线，尤其是 [ImagePicker](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/) 与 [app 配置](https://docs.expo.dev/versions/v57.0.0/config/app/) 文档。

## SH-01 · 离线队列满时聊天草稿和图片被静默清空

- 优先级：P0
- 证据：静态（代码链路）
- 位置：[connection.ts](/Users/linnco/Documents/Prospero/apps/mobile/src/lib/connection.ts:923)（队列上限 50、满时返回 `false`）、[connection.ts](/Users/linnco/Documents/Prospero/apps/mobile/src/lib/connection.ts:1246)（`chatSend` 丢弃返回值）、[session/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/session/[sid].tsx:455)（发送后无条件 `setImages([])` / `setDraft("")`）。
- 复现：进入已有结构化会话；断开主机连接但保持会话页可见；连续发送 51 条不同消息（最后一条可附图）。
- 预期 / 实际：第 51 条应保留在草稿并显示“本机离线队列已满”，或明确拒绝发送。实际 `HostConnection.send` 返回 `false`，但调用者仍清空文本和图片，用户没有失败提示。
- 实现方向：让 `chatSend` / `sendToSubagent` 返回接收状态或抛出明确的 `queue_full` 错误；仅在已写入 socket 或队列后清空编辑器。队列满时保留附件与选择位置，并给出可操作提示（等待重连、编辑/删除已排队消息）。
- 验收：自动测试填满 50 条队列后发送文本和图片，断言第 51 条未从草稿移除、未进入队列且出现可访问的错误提示；重连后仅按序发送前 50 条。

## SH-02 · 终端断线期间的输入被静默丢弃

- 优先级：P1
- 证据：静态（代码链路）
- 位置：[connection.ts](/Users/linnco/Documents/Prospero/apps/mobile/src/lib/connection.ts:1226)（`term.input` 默认 `queueable=false` 且返回值丢失）、[Terminal.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/components/Terminal.tsx:147)（WebView 输入不检查结果）、[session/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/session/[sid].tsx:488)（终端输入同样不检查结果）。
- 复现：打开 PTY 会话，断开网络或让 socket 进入重连；在 xterm 或快捷键栏输入命令并提交。
- 预期 / 实际：终端应禁止输入，或保留输入并提示“未发送，重连后重试”。实际 `send()` 在未连接时返回 `false`，输入桥仍把字符交给它，用户看不到丢失。
- 实现方向：为终端输入增加显式投递结果；断线时冻结 xterm / 快捷键栏，显示连接状态，并提供本地未发送缓冲或“复制并重试”。不要把终端字节自动重放到可能已变化的 shell。
- 验收：断线后从 xterm、粘贴和 KeyBar 三个入口输入；均不能产生“看似已发送”的状态，屏幕阅读器可读出失败状态；重连后只在用户明确确认时发送缓冲内容。

## SH-03 · 会话冷启动失败时卡在“正在准备连接”，没有重试入口

- 优先级：P1
- 证据：静态（界面路径）
- 位置：[use-host-connection.ts](/Users/linnco/Documents/Prospero/apps/mobile/src/lib/use-host-connection.ts:20)（连接异步创建，初始 `conn=null`）、[session/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/session/[sid].tsx:608)（`!conn || !session` 时只渲染加载态）。
- 复现：完全杀掉应用；让已配对 Mac 不可达；从深链或会话列表直接进入某个会话。
- 预期 / 实际：连接失败后应显示失败原因和“重试 / 返回主机”操作。实际在 `conn` 尚未建立或会话快照未取得时，失败状态被加载页短路，用户只能等待或退出。
- 实现方向：把 `runtime.status` 与 `lastError` 带入早期占位页；`failed` 时渲染重试（在 `conn` 存在后 `kick()`，否则重新初始化 hook）与返回按钮；区分“会话不存在”和“尚未拉到快照”。
- 验收：冷启动、离线、已知 sid 三种组合下，10 秒内可见失败文本并可点按重试；恢复网络后重试进入原会话，不创建重复连接或会话。

## SH-04 · 编排页把确定的连接失败错误显示为“正在连接”

- 优先级：P1
- 证据：静态（界面路径）
- 位置：[connection.ts](/Users/linnco/Documents/Prospero/apps/mobile/src/lib/connection.ts:237)（连接失败写入 `status: "failed"` 与 `lastError`）、[orchestration.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/orchestration.tsx:627)（任何非 `connected` 状态均显示“正在连接”）。
- 复现：打开 Agent 编排；使 host 握手失败（不可达、认证失败或版本错误）。
- 预期 / 实际：失败时显示诊断文本并可重试；重连中才显示连接中。实际 `failed` 与 `idle`、`connecting`、`reconnecting` 被合并成同一文案，且页面没有重试控件。
- 实现方向：按 `ConnStatus` 分支，复用主机页的失败文案与 `kick()`；保留“daemon 过旧”这一已连接但能力不足的独立状态。
- 验收：对 `connecting`、`reconnecting`、`failed` 三个状态各有准确且可读出的文案；`failed` 显示 `lastError` 和可用重试按钮，按钮成功后订阅与轮询只建立一份。

## SH-05 · 主机首页只暴露前三个活动 Goal Run 的 Gate

- 优先级：P2
- 证据：静态（界面路径）
- 位置：[index.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/index.tsx:1350)（活动 Run 全量计算）、[index.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/index.tsx:1359)（`slice(0, 3)` 后才渲染 Gate）；编排中心入口存在于 [index.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/index.tsx:1078)，因此这不是“完全无法处理”的重复缺陷，而是首页发现性缺口。
- 复现：建立至少 4 个活动 Goal Run，并让第 4 个产生 pending Gate；停留在主机首页。
- 预期 / 实际：首页应说明还有待处理 Run/Gate 并提供“查看全部”的直接入口，或完整列出。实际第 4 个及后续 Run 完全不出现，也没有溢出计数或跳转动作。
- 实现方向：保留摘要上限以控制长度，但显示“另有 N 个 Run / M 个待处理 Gate”，点击进入编排中心并预选第一个有 Gate 的 Run；也可优先排序 pending Gate。
- 验收：4 个及以上活动 Run 时，首页显示准确溢出数量；点击能到达包含被截断 Gate 的编排详情并完成决策。

## SH-06 · 历史聊天图片加载失败后没有重试路径

- 优先级：P2
- 证据：静态（代码链路）
- 位置：[ChatView.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/components/ChatView.tsx:611)（只在 mount / 依赖变化时拉取）、[ChatView.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/components/ChatView.tsx:617)（失败仅写入 state）、[ChatView.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/components/ChatView.tsx:628)（错误态是不可点按的占位 View）；请求本身禁用离线排队，见 [connection.ts](/Users/linnco/Documents/Prospero/apps/mobile/src/lib/connection.ts:1163)。
- 复现：打开含历史图片的聊天；在图片分块请求期间断网或使 daemon 返回错误；恢复网络但不离开页面。
- 预期 / 实际：图片占位应允许重试并显示失败原因。实际只显示“图片不可用”，effect 不会再次运行。
- 实现方向：将占位改为带可访问标签的 Pressable，维护 `attempt` 或显式 retry 回调；失败后可重试同一分块请求，取消卸载中的请求更新。
- 验收：第一次请求失败后，恢复连接并点按占位可加载图片；重复失败有可读错误且无并发重复请求；成功后占位替换为图片。

## SH-07 · 仅靠左滑的列表操作没有屏幕阅读器等价入口

- 优先级：P1
- 证据：静态（界面路径）
- 位置：[SwipeRow.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/components/SwipeRow.tsx:53) 仅配置 `ReanimatedSwipeable` 与 `renderRightActions`，没有 `accessibilityActions` / `onAccessibilityAction`；动作仅在手势揭露后渲染，见 [SwipeRow.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/components/SwipeRow.tsx:58)。文件、项目和 Git 行均复用它，例如 [files/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/files/[sid].tsx:375)。
- 复现：开启 VoiceOver 或 TalkBack；聚焦一个文件、会话或 Git 文件行；尝试执行下载、重命名、删除、暂存或归档。
- 预期 / 实际：读屏用户应能通过自定义操作、溢出菜单或行内按钮执行所有左滑动作。实际动作不在初始可访问树中，代码也没有等价 accessibility action。
- 实现方向：为 `SwipeRow` 提供 `accessibilityActions` + `onAccessibilityAction`，并在使用方提供有标签的“更多操作”菜单作为确定的替代入口；危险操作继续走同一确认对话框。
- 验收：VoiceOver 和 TalkBack 都能从聚焦行执行每个 SwipeAction；动作名称、禁用态和删除确认会被读出；触摸左滑行为保持不变。

## 已剔除候选

“文件失败无重试”不成立：文件列表错误后仍保留 `RefreshControl`，其 `onRefresh` 直接再次调用 `load(dir)`，见 [files/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/files/[sid].tsx:362)。它不纳入 backlog；可见的重试按钮属于体验增强而非稳定功能缺陷。
