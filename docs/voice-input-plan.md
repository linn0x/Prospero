# 语音输入计划(M3)

> 状态:方案 A 代码已完成(2026-08-04);真机隐私、延迟与中文准确率验收待执行。

## 0. 实施结果

已落地:

- 使用维护中的 `expo-speech-recognition` 56.0.1,通过 Expo config plugin 写入
  iOS 麦克风/语音识别说明和 Android `RECORD_AUDIO`。
- `VoiceButton`:长按启动、松开转写、上滑取消、音量指示、转写阶段点按取消、
  权限拒绝后的系统设置入口。
- 转写只追加到结构化聊天的当前草稿,不覆盖、不自动发送;TTY/终端会话不显示按钮。
- Android 仅允许 API 33+,先检查 `zh-CN` 已安装离线模型;缺失时引导系统下载,
  检测失败或不支持时禁用,没有在线回退。
- iOS 依赖补丁在创建识别任务前按当前 locale 检查
  `supportsOnDeviceRecognition`,并无条件写入
  `requiresOnDeviceRecognition = true`;不支持时失败关闭,不会启动可能联网的任务。
- 自动验证:移动端 TypeScript 检查通过,45 项测试通过,Expo Doctor 20/20 通过,
  prebuild 配置已确认包含两项 iOS usage description 与 Android `RECORD_AUDIO`。

仍须在真机完成(这些指标无法由当前无 iOS 真机/Xcode 的环境代验):

1. iOS 开发构建安装到真机,先在联网状态下载/确认中文离线模型。
2. 用 Proxyman/Charles 或路由器抓包,按住说 10 秒常用指令;允许 Prospero 的局域网
   daemon 流量,但不得出现发往 Apple/Google 或其他公网转写服务的音频请求。
3. 断开公网但保留与 Mac 的局域网连接,重复语音输入;仍能出文字才通过 V-A。
4. 计时 10 秒内语音从松手到草稿出现的耗时,目标 `<2s`;连续测 5 次。
5. 跑 20 句包含文件名、Git、TypeScript、Codex/Claude 等词的中文指令,
   记录可接受率,同时验证上滑取消、转写中取消、权限拒绝和草稿追加。

## 1. 为什么值得做

Prospero 的主场景是"人在别处,盯着 agent 干活"。这个姿势下打字最难受:
单手、走路、没有键盘。而给 agent 的输入又天然适合口述 ——
多是「把这个测试修一下」「继续」「用另一种方案再试」这类自然语言,
不是精确的命令行。

反过来说,**终端会话里不该有语音**。终端输入是逐字节精确的,
语音转写的错字在那里代价极高(想象一下听错的 `rm`)。所以范围只限**结构化会话的聊天输入框**。

## 2. 核心矛盾:零云依赖

这是这个功能唯一真正的设计难点,必须先定。

Prospero 的整个卖点是**零云中转 + 端到端加密**([architecture-exploration.md](architecture-exploration.md) §1),
而两大平台的默认语音识别**都要把音频送到厂商服务器**:

- iOS `SFSpeechRecognizer` 默认走 Apple 服务器
- Android `SpeechRecognizer` 默认走 Google

也就是说,天真地接一个识别库,等于**你对 agent 说的每一句话都发给了 Apple / Google** ——
而这些话里往往包含项目名、文件路径、业务逻辑。这跟"不用官方 Remote Control
是因为它把转录明文存在服务器"的立场直接冲突。

**结论:必须走可离线的路径,把这一条当作硬约束而不是优化项。**

## 3. 三条路线

| 方案 | 隐私 | 质量 | 工作量 | 判断 |
|---|---|---|---|---|
| **A. 设备端识别**<br>`expo-speech-recognition` + `requiresOnDeviceRecognition: true` | ✅ 音频不出手机 | 中(离线模型弱于在线) | 小(1–2 天) | **推荐起步** |
| **B. Mac 侧转写**<br>录音 → 经现有 E2E 通道传给 daemon → whisper.cpp | ✅ 音频只到自己的 Mac | 高(whisper large 可用) | 大(3–4 天) | 架构上最贴合,二期做 |
| C. 云 API(OpenAI/Deepgram 等) | ❌ 违背前提 | 高 | 小 | **排除** |

### 为什么 A 先行

`expo-speech-recognition`(仓库仍由 jamsch 维护)封装了 iOS `SFSpeechRecognizer` /
Android `SpeechRecognizer` / Web,并支持 `requiresOnDeviceRecognition`
强制本地识别。双平台一套 API,和现有 Expo 栈同构。

代价是离线模型质量一般,且 Android 需先用 `getSupportedLocales()` 检查
用户是否装了离线语音包 —— 没装时要引导下载,不能静默退回在线(那会把音频送出去)。

### 为什么 B 更贴合 Prospero

daemon 已经在 Mac 上跑着,而 Mac 的算力远超手机。音频经**已有的加密通道**传给它,
用 whisper.cpp 转写,再把文本回填输入框 —— 全程不出内网,与 shell/文件面板同一条信任链。
质量也能上到 large 模型。

代价:要新增音频分块上传的协议消息、daemon 侧管 whisper 进程、
以及一条延迟链(录完 → 传 → 转写 → 回填)。适合 A 跑通、确认这功能真有人用之后再上。

## 4. 交互设计

**按住说话,松手上屏**(push-to-talk),不做常驻监听:
- 常驻监听要处理静音检测、误触发、以及"什么时候算说完",复杂度高得多;
- 更重要的是,麦克风常开在一个能执行任意命令的 App 里,是个说不清的姿态。

流程:

```
输入框右侧麦克风按钮
  ↓ 按住
波形/音量指示 + "松开发送,上滑取消"
  ↓ 松开
转写中…(可取消)
  ↓
文本【填进输入框,不直接发送】
  ↓
用户确认或修改后再发
```

**转写结果落到草稿而不是直接发出去**,这一条不妥协。语音识别必然出错,
而这里的错字会变成给 agent 的指令。已有的 slash-command 提示逻辑
(`slash-commands.ts`,草稿以 `/` 开头时触发)也能顺带复用。

## 5. 任务分解

### V1 技术验证(0.5 天)
- 装 `expo-speech-recognition`,在 iOS 真机上跑通 `requiresOnDeviceRecognition: true`。
- **验证要点**:强制离线时是否真的不发网络请求(抓包确认,不信文档);
  中文识别质量是否可用。
- 若离线中文质量不可接受 → 直接跳到方案 B,不在 A 上浪费时间。

### V2 录音交互(1 天)
- `VoiceButton` 组件:长按录音、松手转写、上滑取消,配合触感反馈。
- 权限:`NSMicrophoneUsageDescription` + `NSSpeechRecognitionUsageDescription`(iOS),
  `RECORD_AUDIO`(Android)。首次使用时申请,拒绝后给明确引导。
- 转写中可取消;失败时保留已识别的部分,不清空用户已打的字。

### V3 接入聊天输入(0.5 天)
- 结果**追加**到现有草稿而非覆盖 —— 用户可能先打了一半再补语音。
- 仅在结构化会话显示;终端会话不出现这个按钮。

### V4 Android 对齐(0.5 天,依赖 [android-plan.md](android-plan.md))
- `getSupportedLocales()` 检查离线包;缺失时引导用户下载,**不静默退回在线**。

## 6. 验收标准

| # | 指标 | 目标 | 测法 |
|---|---|---|---|
| V-A | 音频不出设备 | 强制离线时零外部请求 | 抓包 / 断网测试 |
| V-B | 转写延迟 | 松手到出文本 <2s(10 秒内的语音) | 手测计时 |
| V-C | 中文准确率 | 技术词汇场景下可用(允许改) | 主观,跑 20 句常用指令 |
| V-D | 误触保护 | 上滑取消有效;转写结果不自动发送 | 手测 |
| V-E | 权限拒绝 | 有明确引导,不静默失效 | 拒绝权限后走一遍 |

**V-A 是一票否决项**。断网后仍能转写才算过 —— 这是这个功能能不能进 Prospero 的前提。

## 7. 风险

| 风险 | 预案 |
|---|---|
| 离线中文识别质量不够用 | 这是最可能的失败点。V1 就要判定;不行就转方案 B,别硬撑。 |
| Android 离线语音包缺失率高 | 引导下载;检测不到就把按钮禁用并说明原因,不退回在线。 |
| 库停止维护 | 该库封装的是系统 API,真出事可以自己写 Expo native module,成本可控。 |
| 用户在公共场合不会用 | 这是功能的天然边界,不是缺陷。保持打字为主路径,语音是可选项。 |

## 8. 工作量估计

**方案 A:2–3 天**(含 Android 对齐)。
**方案 B:另加 3–4 天**,建议在 A 跑通并确认使用频率之后再评估 ——
如果实际上没人用,B 的投入就不该发生。

## 9. 参考

- [`expo-speech-recognition`](https://github.com/jamsch/expo-speech-recognition) — iOS SFSpeechRecognizer / Android SpeechRecognizer / Web 封装,支持 `requiresOnDeviceRecognition`
- [expo-speech(SDK 57)](https://docs.expo.dev/versions/v57.0.0/sdk/speech/) — **仅 TTS,不含识别**,别搞混
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — 方案 B 的 Mac 侧转写
