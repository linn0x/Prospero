# iOS UX 审计

审计日期：2026-08-12。全部为静态证据；需在 iPhone、iPad 和 VoiceOver 真机补验。共享问题（离线投递、Gate、历史图片、左滑操作）见 [shared-audit.md](shared-audit.md)，此文件只保留 iOS 特有或 iOS 上特别明显的项。

## 2026-08-13 T5 验收增补（未通过）

实现提交：IOS-01 为 `9f13be9`，IOS-02 / IOS-03 为 `f9821a2`，IOS-04 为 `278f169`。在 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 下，clean iOS prebuild、`pod install` 和无签名 generic iOS Simulator release build 均通过（`BUILD SUCCEEDED`）；移动端自动化共 24 个 Vitest 文件 / 148 个测试通过。

本轮仅使用新建的 iPhone SE（第三代）与 iPad（第十代）模拟器。release app 在两机安装、启动后均停在纯黑窗口，未出现首屏；因此首次/永久权限拒绝、Settings 返回、小屏 44 pt 命中框、Dynamic Type 各档以及自定义字号跨重启/复位均**未验**，没有把这些行为写成通过。VoiceOver、真实相机及一切真机检查也未执行。Gate `gate_4ca9584cb748` 已决议“接受模拟器验收并记录真机待办”，但不将这些阻断改写为通过；详细构建、清理与矩阵见 [优化 Backlog](optimization-backlog.md#2026-08-13-t5-构建与模拟器终验未通过gate-已决)。

## 2026-08-13 T5 复验（失败，未交付）

以 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 运行的 clean iOS prebuild / CocoaPods 及无签名 generic iOS Simulator Release build 均为 `BUILD SUCCEEDED`。新建 iPhone SE（第三代）与 iPad（第十代）后，两台 release App 都能到未配对首页；旧记录中的纯黑首屏本次未复现。

- SE 3：依次设置并重启 12 个 Simulator Dynamic Type 档位。最大 `accessibility-extra-extra-extra-large` 时，首页标题、说明、命令块溢出/裁切，配对按钮不可见；这是实测布局失败。
- iPad 10：未配对首页启动正常，不代表已配对会话、附件或终端页通过。
- IOS-01 图片权限首次/永久拒绝和 Settings 回返、IOS-03 会话控件的 44 pt 量测、IOS-04 终端初始字号 / custom 跨重启 / 跟随系统复位都需已配对会话，本轮没有可安全使用的配对凭证，故未验。VoiceOver 与真实相机也未验。

临时 iOS 模拟器和 App 数据已删除，未生成、记录或提交配对串。当前 task Gate 仅协调者可创建，worker 拒绝结果已通过 `msg_09361c8a4868` 上报。详见 [优化 Backlog 的本轮复验记录](optimization-backlog.md#2026-08-13-t5-复验失败未交付)。

## IOS-01 · 图片权限拒绝后没有解释或恢复入口

- 优先级：P1
- 证据：静态（代码链路）
- 位置：[attach.ts](/Users/linnco/Documents/Prospero/apps/mobile/src/lib/attach.ts:49)（相册拒绝直接返回空数组）、[attach.ts](/Users/linnco/Documents/Prospero/apps/mobile/src/lib/attach.ts:68)（相机同样处理）、[session/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/session/[sid].tsx:547)（调用者把空结果静默合入状态）。
- 复现：iOS 上在系统提示选择“不允许”，或已在设置中关闭照片/相机权限；点击“添加图片 → 从相册选 / 拍一张”。
- 预期 / 实际：应区分取消和拒绝；若 `canAskAgain=false`，说明原因并提供“打开设置”，否则允许再次请求。实际两种路径都是 `[]`，对话框关闭后没有任何反馈。
- 实现方向：返回区分的 picker 结果或抛出受控错误；检查 Expo ImagePicker 的 `PermissionResponse.canAskAgain`，不可再问时用系统设置深链。Expo 57 文档明确说明该字段为 false 时应引导至 Settings：[PermissionResponse](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/#permissionresponse)。
- 验收：首次拒绝、永久拒绝、用户取消、已授权四种路径显示正确结果；永久拒绝可一键打开系统设置；回到应用后重新检查权限并可添加图片。

## IOS-02 · 两个图标专用入口缺少 VoiceOver 名称

- 优先级：P2
- 证据：静态（界面路径）
- 位置：[index.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/index.tsx:85)（二维码图标 Pressable 无 role/label）、[git/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/git/[sid].tsx:182)（刷新图标同样无 label）。这不是泛化指控：会话页的同类图标已有 `accessibilityLabel`，见 [session/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/session/[sid].tsx:800)。
- 复现：开启 VoiceOver，依次导航至主机列表的右上角二维码按钮和 Git 页右上角刷新按钮。
- 预期 / 实际：应朗读“扫码配对，按钮”“刷新 Git 状态，按钮”。实际控件本身不提供语义名称，只含图标。
- 实现方向：为二者补 `accessibilityRole="button"`、本地化 label 与 disabled/busy 状态；刷新加载中应读出“正在刷新”。
- 验收：VoiceOver rotor 焦点朗读名称、角色和禁用/加载状态；无需视觉图标即可完成配对入口和刷新操作。

## IOS-03 · 多个高频控件的可见触控尺寸低于 44 pt

- 优先级：P2
- 证据：静态（界面路径）
- 位置：[session/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/session/[sid].tsx:1544) 搜索按钮为 40×40；[session/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/session/[sid].tsx:1523) 的审批/模型 chip 最小高度仅 28；[session/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/session/[sid].tsx:1712) 的已选图片移除按钮为 22×22，`hitSlop=6` 后仍只有约 34×34；终端 Ctrl 键为 31×30，见 [KeyBar.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/components/KeyBar.tsx:254)。
- 复现：iPhone 上打开结构化会话，操作搜索、审批策略、模型、图片移除；打开 PTY 后操作 Ctrl 快捷键。
- 预期 / 实际：常用且可能造成状态变化的触控目标应有至少 44×44 pt 的实际命中区域。实际上述控件未提供足够容器尺寸或 hitSlop。
- 实现方向：优先给 Pressable 设最小 44×44 的布局或四边各补足 hitSlop，不靠视觉上扩大图标；为紧凑键盘改用可横向滚动的 44 pt 键位。
- 验收：在 iPhone SE 和标准 iPhone 的布局检查中，每个列出的实际命中框均不小于 44×44 pt，控件不重叠且 VoiceOver 焦点框与命中框一致。

## IOS-04 · 终端字号不响应 Dynamic Type

- 优先级：P2
- 证据：静态（代码链路）
- 位置：[term.html](/Users/linnco/Documents/Prospero/apps/daemon/term.html:24) 将 xterm 初始字号固定为 `12`；字号变更只来自页面消息或双指捏合，见 [term.html](/Users/linnco/Documents/Prospero/apps/daemon/term.html:151) 和 [term.html](/Users/linnco/Documents/Prospero/apps/daemon/term.html:192)。React Native 的 `fontScale` / iOS content-size-category 没有传入 WebView。
- 复现：在 iOS 设置将“更大文字”调到最大，重启应用并打开 PTY 会话。
- 预期 / 实际：终端应遵从系统文字大小，或在首次打开时给出等价的持久化可访问字号。实际始终从 12 px 启动；虽然可手势缩放，但不随 Dynamic Type 改变，也不持久化。
- 实现方向：在 RN 侧监听 font scale / accessibility settings，将初始字号映射为受限的 xterm 档位并持久化；保留捏合与 A+/A− 作为显式覆盖，提供“跟随系统”复位。
- 验收：不同 Dynamic Type 档位重新进入终端时初始字号发生可预测变化，xterm 重新 fit 且不改变会话输入；手动覆盖跨重启保留并可恢复“跟随系统”。
