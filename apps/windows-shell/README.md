# Prospero Windows Shell

Windows 11 原生 WPF 桌面端，对应 `apps/shell` 的 macOS SwiftUI 壳。它直接复用同一套
`prosperod`、`~/.prospero` 状态文件和带 control token 的 loopback API。

## 能力

- Codex 风格的现代界面、圆角卡片、紧凑侧边导航与清晰的运行状态；
- 浅色、深色和跟随 Windows 三种主题模式，系统主题变化可实时同步；
- 系统托盘、Dashboard 与后台运行；
- daemon 自动启动、启动/停止/重启与日志；
- Relay 启用、URL、状态与密钥轮换；
- 本地项目书签与会话创建，以及结构化 ChatUI/PTY 会话的打开、输入、审批、回答问题、中断和结束；
- Claude Code / Codex 独立账号管理；
- 编排 Run、Task、Gate 状态与 Gate 决策；
- 手机配对二维码/配对串和设备撤销；
- Node、CLI、监听地址与 daemon 启动设置；Node 可跟随 PATH/NVM 当前版本，也可固定到指定的 `node.exe`；
- 可在设置或托盘菜单中开关“登录 Windows 时自动启动”。

开机自启动写入当前用户的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，
不需要管理员权限；禁用时会删除对应的 `Prospero` 项。

## 构建与运行

要求 Windows 11、Node.js 22+、.NET Framework 4.8，以及 Visual Studio 2022 或
Visual Studio Build Tools。Windows 11 已包含 .NET Framework 4.8 运行时。

```powershell
npm run build -w @prospero/daemon
powershell -ExecutionPolicy Bypass -File apps/windows-shell/build.ps1
apps/windows-shell/bin/Release/ProsperoShell.exe
```

后台启动和只读自检：

```powershell
apps/windows-shell/bin/Release/ProsperoShell.exe --background
apps/windows-shell/bin/Release/ProsperoShell.exe --self-check
apps/windows-shell/bin/Release/ProsperoShell.exe --smoke-test
# CI/维护者：在隔离的 PROSPERO_HOME 中执行真实 daemon 起停验收
apps/windows-shell/bin/Release/ProsperoShell.exe --daemon-smoke-test
```

关闭主窗口只会隐藏到托盘；从托盘选择“退出”才会退出桌面端并停止它管理的 daemon。
