# Spike:WebView + xterm.js 终端性能(W4)

> 日期:2026-08-04 · 环境:**iOS 26.5 模拟器(iPhone 17 Pro)+ Xcode 26.6**,Mac 本机 daemon,LAN 回环
> ⚠️ 模拟器用的是 Mac 的 GPU/CPU,**数据是上界,不能替代真机**。真机复测在 W5。

## 结论

**继续用 React Native WebView + xterm.js,不切 SwiftTerm。** WebGL renderer 在 iOS WKWebView 上正常启用(未回退 DOM),洪峰下帧率远超验收线。

## 实测数据

| 场景 | renderer | fps | 吞吐 |
|---|---|---|---|
| 空闲 / 轻量输出 | webgl | 60–61 | 0–3 KB/s |
| 中量输出 | webgl | 51–55 | 16–19 KB/s |
| **洪峰(8000 行连续 echo)** | **webgl** | **58** | **150 KB/s** |

验收线 A4 是「≥30fps 不冻结」,实测 58fps,**约 2 倍余量**。8000 行输出完整渲染、无丢行、`FLOOD_DONE` 正常收尾。

打点方式:`term.html` 内 rAF 秒窗统计,只在有输出流量时上报,经 WebView bridge 打到 Metro 控制台(`[term-perf]` 行)。代码保留,真机可直接复用。

## Android 模拟器复测(2026-08-04)

环境:**Android 15 / API 35、Pixel 8 arm64 AVD、Expo SDK 57 release APK**，通过 `adb reverse` 连接 Mac 本机 daemon。模拟器启动时因宿主内存压力明确回退到 SwiftShader/software GL，所以这组结果只证明 Android 代码路径能承受洪峰，**不能代替中端 Android 真机的 A4 性能验收**。

| 场景 | renderer | fps | 吞吐 | 结果 |
|---|---|---:|---:|---|
| 10,000 行连续输出(`seq 1 10000`) | webgl | 45 | 12 KB/s | 10,000 行完整到达，`FLOOD_DONE` 收尾，无白屏/冻结 |
| `find /` 持续洪峰(约 12 秒后中断) | webgl | 62 | 88 KB/s | 持续滚动且输入栏可操作，中断后继续消费已排队输出 |

同一轮还测得 attach 上屏 **27ms**、后台/重进恢复 **34–63ms**；这些是 AVD + 本机回环数字，只作功能回归基线。

复测发现 Android 15 edge-to-edge 下，即使最终 Manifest 已是 `windowSoftInputMode=adjustResize`，IME 仍会覆盖 React Native 底部输入栏。修复为会话、配对和文件编辑容器在 Android 上显式使用 `KeyboardAvoidingView behavior="height"`：

- 修复前终端输入框 bounds 为 `y=2231–2338`，落在软键盘后面；
- 修复后移动到 `y=1627–1734`，完整留在软键盘上方；
- 文件编辑器也由 `y=279–2400` 缩到 `y=279–1796`。

另已验证 release APK 冷启动 `prospero://host/<id>/session/<sid>` 可直接恢复终端，Android 返回会落到主机列表而非空白页。

## 过程中发现并修掉的架构缺陷

**WebView 从 daemon HTTP 加载 term.html 是脆弱设计。** 复现:daemon 短暂不可用时进入会话页 → WKWebView 停在 `NSURLErrorDomain -1004 Could not connect to the server`,且**加载失败后不会自动重试**——即使 WebSocket 随后重连成功,终端也永久白屏。

修法:把终端页**内联进 App bundle**(`scripts/build-terminal-html.mjs` 以 `apps/daemon/term.html` 为唯一源,内联 xterm.js/fit/webgl/css,生成 `src/components/terminal-html.ts`,740KB)。收益不只是修 bug:

- 终端渲染完全不依赖 daemon 的 HTTP 服务
- 每次开会话省掉 ~745KB 网络传输 → 直接服务 A1「attach < 200ms」
- daemon 少暴露一个 HTTP 端点

xterm 依赖升级后需重跑 `npm run build:terminal`。

## 备选路线(暂不启用)

若真机上低端机型或大 scrollback 出现掉帧,依次尝试:

1. 降 scrollback(当前 3000 行)、关光标闪烁
2. 输出合帧窗口从 16ms 放宽到 33ms(daemon 侧 `FLUSH_MS`)
3. 换 SwiftTerm(MIT)封 Expo native module —— Terminal 组件只吃 snapshot/delta/input 三个口,替换面很小

## 待真机复测项

- iOS 真实 GPU 下的洪峰 fps(预计低于模拟器,但 A 系 GPU 仍应远超 30fps)
- 中端 Android 真机真实 GPU/WebView 下的 10,000 行与 `find /` fps
- 两端中文 IME 组合输入；模拟器只验证了键盘 resize，不能覆盖真实输入法行为
- 后台挂起 → 回前台的快照恢复耗时；模拟器不严格执行 socket 挂起/ROM 省电策略
