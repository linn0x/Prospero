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

## 2026-08-13 T5 构建与模拟器终验（未通过，Gate 已决）

此节是对上一节“待完成”陈述的更正：`9f13be9`、`e8414b5` 与 `278f169` 已补上 AND-01、SH-06、IOS-03 和 IOS-04；IOS-01 / IOS-02 的相应行为也随 `9f13be9` / `f9821a2` 落地。代码和单元测试可以核对为完成，但本轮不能把任一项写成“设备验收通过”。原因是 iOS 两台全新模拟器的无签名 generic Simulator release 包均停在纯黑界面，Android API 35 临时映像/AVD 又未能在本机 SDK 布局中建立；因此完整矩阵没有完成。

### 自动化与构建证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm test -w @prospero/mobile` | 通过 | 24 个 Vitest 文件、148 个测试。 |
| `npx tsc --noEmit -p apps/mobile/tsconfig.json` | 通过 | 退出码 0。 |
| `npm run lint -w @prospero/mobile` | 通过 | `expo lint` 退出码 0。 |
| `npm run build:terminal -w @prospero/mobile` | 通过 | 生成 `terminal-html.ts` 后工作区无生成物漂移。 |
| Android CNG / release | 通过 | `expo prebuild --clean` + `assembleRelease`，APK 为 `apps/mobile/build/apk/prospero-release.apk`（319 MB），已由 `apksigner verify` 校验。 |
| iOS CNG / generic Simulator | 通过 | 指定 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`；clean prebuild、`pod install`、无签名 `xcodebuild … generic/platform=iOS Simulator` 均为 `BUILD SUCCEEDED`。 |

### 项目最终代码状态与设备证据

| 项 | 实现提交 | 最终代码/自动化状态 | T5 模拟器状态 |
| --- | --- | --- | --- |
| SH-01 / SH-02 / SH-03 | `bdd6568` | 已实现；队列、冷启动状态机测试通过。 | 未做连接故障 E2E；非真机通过。 |
| SH-04 / SH-05 / AND-04 | `4d04190` | 已实现；编排摘要和布局单测通过。 | Android API 35 / 折叠铰链未完成。 |
| SH-06 | `e8414b5` | 已实现；历史附件重试测试通过。 | 未做断网后点按重试 E2E。 |
| SH-07 / IOS-02 / AND-03 | `f9821a2` | 已实现；读屏动作映射和 Git inset 测试通过。 | VoiceOver / TalkBack 未验；不宣称读屏通过。 |
| IOS-01 / AND-01 | `9f13be9` | 已实现；权限结果、pending picker、草稿隔离/过期测试通过。 | iOS 权限与 Settings 回返未完成；Android API 33 在“不要保留活动”下进入配对页后画面为空，未能完成相册/相机返回或恢复用例。 |
| IOS-03 | `278f169` | 代码命中框调整已提交。 | iPhone SE 3 黑屏，未能量测 44 pt。 |
| IOS-04 | `278f169` | Dynamic Type 映射、持久化覆盖和复位测试通过。 | iPhone SE 3 / iPad 黑屏，未能逐档重启观察。 |
| AND-02 / AND-05 | `f9821a2` | Git 安全区计算和 predictive-back 配置测试通过。 | 仅 API 33 启动到主机空态；IME、三键/手势切换与 predictive back 未完成。 |

### 已执行的临时模拟器操作

- Android：新建 `ProsperoT5_API33_d38edc8fb66f`。该临时 AVD 启动并安装 release APK，空态首页可见；记录的 `navigation_mode=0` 与 `always_finish_activities=1` 在测试后已恢复为原值。点击配对后在“不要保留活动”环境得到空白画面，故停止，不将该路径计为通过。API 35 的临时 Fold AVD 未建立：本机的 command-line tools 将 API 33 映像安装到其自身根目录、却把既有 API 35 映像视为无效；重装 API 35 映像下载停滞后已中止。没有触碰已有 `FundWatch_API_35` 数据。
- iOS：新建 iPhone SE（第三代）和 iPad（第十代）各一台，安装 generic Simulator release app；两者均显示纯黑应用窗口。该阻断先于权限、Settings、44 pt、Dynamic Type 和自定义字号复位验证。
- 全部临时 AVD、iOS 模拟器和安装的临时 App 数据均已删除；本次未生成临时配对凭证，配对串没有写入日志或 Git。

物理设备当前不可用。Prospero Gate `gate_4ca9584cb748` 已决议为“接受模拟器验收并记录真机待办”。该决议只接受本节列出的自动化和有限模拟器证据、保留真机清单；不覆盖本轮 iOS 纯黑首屏及 Android API 35/Fold 无法建立所造成的完整模拟器矩阵阻断，也不得声称真机或完整设备验收通过。真机待办准确包括 VoiceOver、TalkBack、真实相机、OEM IME、Android 13/15 的三键与手势导航、Android 15 predictive back、折叠铰链、iOS 权限/Settings 回返、Dynamic Type 重启和终端字号复位。

## 2026-08-13 T5 复验（验收失败已收口）

本节为 `task_d38edc8fb66f` 的实际终验记录，优先于上一节旧模拟器结论。实现提交不变：SH-01/02/03=`bdd6568`，SH-04/05/AND-04=`4d04190`，SH-06=`e8414b5`，SH-07/IOS-02/AND-02/03/05=`f9821a2`，IOS-01/AND-01=`9f13be9`，IOS-03/IOS-04=`278f169`。没有一项可写成真机通过；本轮还发现可复现的 iOS 最大辅助字号布局失败。

| 检查 | 本轮结果 |
| --- | --- |
| 自动化 | `npm test -w @prospero/mobile`：24 个 Vitest 文件 / 148 个测试通过；TypeScript、Expo lint、终端 HTML 生成均为退出码 0，生成后移动端无文件漂移。 |
| Android 构建 | `npm run build:android -w @prospero/mobile` 成功完成 clean prebuild / `assembleRelease`（888 actionable tasks）；`apps/mobile/build/apk/prospero-release.apk` 为 334,884,366 bytes，`apksigner verify --verbose` v2 签名通过。Manifest 含 `enableOnBackInvokedCallback="true"` 和 `adjustResize`。 |
| Android API 33 | 临时 Pixel 5 可启动 release 未配对首页；三键、手势 overlay 实际切换；相机首次与永久拒绝均显示退化页。记录并恢复 `navigation_mode=2`、`always_finish_activities=null`。无已配对会话，故 ImagePicker 返回、草稿/附件恢复、Git IME、会话 predictive back 未验。 |
| Android API 35 Fold | 临时 Pixel Fold 在 2208×1840 主显示器启动，并报告 1080×2092 辅显示器；没有文件/编排会话，故无 separating hinge / `verticalPanes` 证据。配对页边缘返回注入最终到 Launcher，不能计 predictive-back 通过。 |
| iOS 构建 | `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` 的 clean prebuild / CocoaPods、无签名 generic Simulator Release build 均为 `BUILD SUCCEEDED`。 |
| iOS SE 3 / iPad 10 | 两台均启动 release 未配对首页。SE 3 逐档设置并重启 12 个 Dynamic Type 档位；`accessibility-extra-extra-extra-large` 时首页标题、说明和命令块溢出/裁切，配对按钮不可见，判为失败。没有已配对会话，IOS-01 权限/Settings、会话 44 pt、终端 custom 字号跨重启/复位未验。 |

| 项 | 最终设备结论 |
| --- | --- |
| SH-01 / SH-02 / SH-03 | 自动化实现通过；离线、重连、终端三入口 E2E 未验。 |
| SH-04 / SH-05 / AND-04 | 自动化实现通过；无已配对 host，Gate 深链和 Fold 铰链面板未验。 |
| SH-06 | 自动化实现通过；历史附件断网恢复未验。 |
| SH-07 / IOS-02 / AND-03 | 自动化实现通过；VoiceOver / TalkBack 未验。 |
| IOS-01 / AND-01 | 自动化实现通过；会话 ImagePicker、Settings 回返、Activity 回收后恢复未验。 |
| IOS-03 | 代码命中框测试通过；SE 3 最大辅助字号首页布局失败，列出会话控件未能量测。 |
| IOS-04 | 映射/持久化/复位单测通过；终端运行时 custom 跨重启和复位未验。 |
| AND-02 / AND-05 | 配置/计算测试通过；Git IME 和 predictive-back 编辑确认未验。 |

临时 `ProsperoT5_API33_d38edc8fb66f`、`ProsperoT5_API35_Fold_d38edc8fb66f`、iPhone SE 3、iPad 10 与其 App 数据均已删除；未创建、输出或提交临时配对凭证，现有 `FundWatch_API_35` 未被修改。worker 尝试创建当前 task 的重复 Gate 时被 CLI 以“只有此 Run 的协调者会话可以改动任务图”拒绝，随后协调者确认复用已决 Gate `gate_4ca9584cb748`：决策为“接受模拟器验收并记录真机待办”。该决策只接受有限证据，不能把本轮失败或未验路径改写为通过。

本次 QA 收口已交付，但移动端设备验收结论为失败：iOS 最大辅助字号布局有实测缺陷，会话级双端路径也未完成。即使 Gate 接受有限模拟器证据，仍须真机验证 VoiceOver、TalkBack、真实相机、OEM IME、Android 13/15 导航与 Git IME、predictive-back 编辑确认、真实折叠铰链、iOS 权限/Settings 回返、SE 3 44 pt 会话控件、终端字号跨重启/复位与跨平台离线恢复 E2E。

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
