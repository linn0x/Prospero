# Spike:WKWebView + xterm.js 终端性能(W4)

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

- 真实 GPU 下的洪峰 fps(预计低于模拟器,但 A 系 GPU 仍应远超 30fps)
- 软键盘弹出时的 resize 抖动与 IME 输入(模拟器无法覆盖)
- 后台挂起 → 回前台的快照恢复耗时(模拟器不严格执行 socket 挂起)
