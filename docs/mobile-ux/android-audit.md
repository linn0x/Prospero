# Android UX 审计

审计日期：2026-08-12。全部为静态证据；Android 13+、Android 15 edge-to-edge、折叠屏和 TalkBack 必须补真机验收。共享左滑无障碍问题的统一实现项为 [SH-07](shared-audit.md#sh-07--仅靠左滑的列表操作没有屏幕阅读器等价入口)，此处记录其 Android 影响以避免重复 backlog。

## 2026-08-13 T5 验收增补（未通过）

实现提交：AND-01 为 `9f13be9`；AND-02、AND-03、AND-05 为 `f9821a2`；AND-04 为 `4d04190`。自动化全部通过（24 个 Vitest 文件 / 148 个测试、TypeScript、lint、终端 HTML）；clean prebuild 与 signed release APK 构建通过，产物为 `apps/mobile/build/apk/prospero-release.apk`（319 MB）。

只完成了 API 33 临时 Pixel 5 AVD 的 release APK 启动，空态首页显示正常。测试前记录到临时 AVD 的 `navigation_mode=0`、`always_finish_activities=1`，并在测试后恢复为这两个原值。进入配对页后画面为空，因而在“不要保留活动”下相册/相机返回、草稿/附件恢复、IME、三键/手势以及 predictive back 均没有可接受的运行时证据。API 35 临时 Fold AVD 因本机 SDK 映像根目录不一致且重装下载停滞未能建立；折叠布局未验。TalkBack、真实相机、OEM IME 和全部真机检查仍未执行。不得将任一 Android 项记为设备或真机通过；详细 Gate 和矩阵见 [优化 Backlog](optimization-backlog.md#2026-08-13-t5-构建与模拟器终验未通过gate-待决)。

## AND-01 · ImagePicker 返回期间进程回收会同时丢失选择结果和聊天草稿

- 优先级：P1
- 证据：静态（代码链路）
- 位置：[attach.ts](/Users/linnco/Documents/Prospero/apps/mobile/src/lib/attach.ts:49) 只等待 launch promise；仓库中没有 `getPendingResultAsync` 调用；[session/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/session/[sid].tsx:263) 的 `draft` 和 [session/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/session/[sid].tsx:321) 的 `images` 都仅存在 `useState`。
- 复现：Android 开启开发者选项“不要保留活动”；在会话写入未发送草稿，打开图片选择器并选图，系统回收 MainActivity 后返回应用。
- 预期 / 实际：应恢复选择器结果并保留当前会话草稿，至少提示可恢复的未发送内容。实际没有 pending result 恢复与草稿持久化，React state 会重置。Expo 57 文档明确要求 Android 处理 MainActivity destruction，并提供 `ImagePicker.getPendingResultAsync`：[ImagePicker](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/#imagepickergetpendingresultasync)。
- 实现方向：在会话恢复入口调用 `getPendingResultAsync` 并将结果走同一归一化管线；按 `hostId/sid` 临时持久化文本、选择和附件元数据，在成功投递或用户放弃后清除。附件应有大小上限与过期策略。
- 验收：启用“不要保留活动”后，从相册和相机两条路径均能恢复选图；未发送草稿和附件预览恢复到正确会话；取消、错误、成功发送不产生幽灵草稿。

## AND-02 · Git 提交栏没有消费底部系统栏/IME inset

- 优先级：P1
- 证据：静态（界面路径）
- 位置：[android/gradle.properties](/Users/linnco/Documents/Prospero/apps/mobile/android/gradle.properties:47) 启用 edge-to-edge；[git/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/git/[sid].tsx:173) 在 Android 传给 `KeyboardAvoidingView` 的行为为 `undefined`；[git/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/git/[sid].tsx:301) 的提交栏没有 `insets.bottom` 或 IME inset。相较之下文件列表明确为内容加入了安全区，见 [files/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/files/[sid].tsx:367)。
- 复现：Android 13+（尤其 edge-to-edge 设备）打开 Git 页面，聚焦多行提交信息，弹出 IME 并在手势导航与三键导航间切换。
- 预期 / 实际：输入框与“提交”按钮应始终位于 IME 和导航栏之上。实际提交栏没有自己的窗口 inset 处理，依赖根窗口 resize；edge-to-edge / OEM IME 组合下会被底部系统区域遮挡。
- 实现方向：使用 `useSafeAreaInsets` 和键盘 controller / `useAnimatedKeyboard` 统一计算底部 padding 或 offset；在 Android 明确验证 `adjustResize` 与 edge-to-edge 的组合，不要仅依赖 `KeyboardAvoidingView` 的未设置行为。Expo 57 配置文档说明 `softwareKeyboardLayoutMode` 仅映射到 `windowSoftInputMode`：[app config](https://docs.expo.dev/versions/v57.0.0/config/app/#softwarekeyboardlayoutmode)。
- 验收：Android 13、15 各在手势和三键导航下，IME 动画全程提交按钮可见可点；隐藏键盘后栏位不留额外空隙；横屏和分屏不回归。

## AND-03 · TalkBack 无法发现左滑文件/会话/Git 操作

- 优先级：P1（与 SH-07 同一缺陷，不新增独立 backlog 项）
- 证据：静态（界面路径）
- 位置：[SwipeRow.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/components/SwipeRow.tsx:53) 没有 Android accessibility action；文件行把下载、重命名、删除只放入 SwipeRow，见 [files/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/files/[sid].tsx:375)；Git 与主机项目列表同样复用该组件。
- 复现：开启 TalkBack，聚焦任意文件、会话或 Git 行；使用本地上下文菜单 / 操作转子尝试下载、删除、暂存或归档。
- 预期 / 实际：TalkBack 应呈现同等命名动作。实际没有 `accessibilityActions` / `onAccessibilityAction`，动作只存在于触摸左滑后。
- 实现方向：按 SH-07 为共享 `SwipeRow` 增加读屏动作和显式更多操作菜单；Android 测试应覆盖 TalkBack 菜单。
- 验收：TalkBack 可对每类行执行所有动作，危险操作仍要求确认；本项验收与 SH-07 合并执行。

## AND-04 · 文件页和编排页未消费已接入的折叠铰链布局

- 优先级：P2
- 证据：静态（代码链路）
- 位置：[adaptive-layout.ts](/Users/linnco/Documents/Prospero/apps/mobile/src/lib/adaptive-layout.ts:33) 已发布 `verticalPanes`；会话、主机、Git 页面会消费它（例如 [git/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/git/[sid].tsx:160)）。文件页只使用 `useHostConnection` 和 safe-area，见 [files/[sid].tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/files/[sid].tsx:49)；编排页同样没有 `useAdaptiveLayout`，见 [orchestration.tsx](/Users/linnco/Documents/Prospero/apps/mobile/src/app/host/[hostId]/orchestration.tsx:1)。
- 复现：在带垂直分离铰链的 Android 折叠设备展开应用，进入文件页或 Agent 编排页。
- 预期 / 实际：内容应避开铰链并利用两块连续可用区域。实际两页以单块全宽布局渲染，铰链可能切断文件行、任务图或输入区。
- 实现方向：两页接入 `useAdaptiveLayout`；文件页在一侧列目录、另一侧放编辑/预览（窄屏退化为单列），编排页把 Run 列表与详情/任务图分面；为不可用缝隙加 gutter。
- 验收：Surface Duo / Galaxy Fold 模拟或真机的 vertical separating feature 下，任何可点按控件不跨铰链；方向切换、半折和普通平板保持可用布局。

## AND-05 · Android 13+ predictive back 被显式关闭

- 优先级：P2
- 证据：静态（配置）
- 位置：[app.json](/Users/linnco/Documents/Prospero/apps/mobile/app.json:46) 为 `false`；预构建 Manifest 同步为 `android:enableOnBackInvokedCallback="false"`，见 [AndroidManifest.xml](/Users/linnco/Documents/Prospero/apps/mobile/android/app/src/main/AndroidManifest.xml:26)。
- 复现：Android 13+ 使用系统返回预测手势，在会话、文件编辑和编排页从左/右边缘返回。
- 预期 / 实际：导航栈可参与系统预测返回动画；有未保存编辑时仍先走现有 `beforeRemove` 确认。实际应用明确 opt-out。Expo 57 将该字段定义为 Android 13+ predictive back 开关，并说明它映射到同一 Manifest 属性：[app config](https://docs.expo.dev/versions/v57.0.0/config/app/#predictivebackgestureenabled)。
- 实现方向：移除显式 false 或设为 true；先验证 Expo Router 的返回过渡与文件编辑 `beforeRemove` 对取消/确认的行为，必要时在确认对话框期间拦截完成导航而非禁用全局手势。
- 验收：Android 13、14、15 中系统预测返回动画正常；文件有未保存改动时取消不会离页、确认后只返回一次；根页仍遵循现有退后台策略。
