# Prospero Windows Desktop

Electron + React 实现的 Windows 11 Agent 工作台。直接连接 Prospero 现有 daemon，与 macOS 客户端共用协议、状态和会话实现。

## 安全与体积边界

- Renderer 开启 sandbox 与 context isolation，关闭 Node integration 和页面网络访问；
- control token 只由 Electron main 读取，通过白名单 IPC 暴露具体动作；
- 不加载远程页面，不允许新窗口、导航、设备权限或任意文件读取；
- 安装包仅携带一份 daemon 构建产物和 Node sidecar，不复制 daemon 业务实现；
- Electron ASAR 保持封装，仅解包必要的原生模块；xterm WebGL 不可用时自动回退 Canvas。

## 完整访问权限

设置页可选择通过 Windows UAC 以管理员身份启动本机托管的 daemon。开启或关闭时，正在运行的托管 daemon 会优雅重启；之后创建的 Agent 与 Windows Session Host 会继承对应权限。该设置默认关闭，外部启动的 daemon 不会被桌面端擅自提权或重启。

管理员 daemon 仍只接受带控制令牌的回环控制请求。桌面端使用这一通道执行优雅停止，因此不需要从普通权限进程强杀管理员进程。

## 开发

```powershell
npm install
npm run build -w @prospero/daemon
npm run dev:windows
```

## 自包含安装包

```powershell
npm run package:windows -- -Architecture x64
```

产物位于 `dist/desktop`。安装后不要求用户另装 Node.js 或手动启动 daemon。
