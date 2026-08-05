# Prospero Mobile

Expo SDK 57 / React Native 客户端，iOS 与 Android 共用同一套路由、协议和 UI。

## Android 构建与侧载

准备 JDK 17+、Android SDK 与 `platform-tools`，在仓库根目录安装依赖后运行：

```bash
npm install
npm run build:android -w @prospero/mobile
```

脚本会用 Expo CNG 重新生成 `android/`，安装 SDK 36 / Build Tools 36（缺少时），构建并校验一个可离线启动的 release APK。默认产物是：

```text
apps/mobile/build/apk/prospero-release.apk
```

直接装到唯一一台已连接、已授权的 adb 设备并启动：

```bash
npm run build:android -w @prospero/mobile -- --install --launch
```

有多台设备时追加 `--device <adb-serial>`。开发中已生成过原生工程时可用 `--no-prebuild` 缩短构建；更改 `app.json`、config plugin 或原生依赖后不要跳过 prebuild。

release APK 使用 Expo/React Native 模板随工程生成的 debug keystore 签名，只用于个人侧载。正式分发应在 CI 或 Gradle 中注入独立 release key，不要把密码或私钥写进脚本。

## ntfy 审批通知

Prospero 不直接接收 Android 推送；外部 ntfy App 显示通知，点击后通过 `prospero://` 深链回到对应主机与会话。因此 Android 13+ 的通知运行时权限要授予 **ntfy**，Prospero 自身不申请 `POST_NOTIFICATIONS`。

1. 按 [ntfy 官方 Android 指南](https://docs.ntfy.sh/subscribe/phone/)从 Google Play 或 F-Droid 安装 ntfy，并允许其发送通知。
2. 在 ntfy 中订阅一个难以猜测的 topic。自建服务器或不使用 Google 服务时，建议用 F-Droid 版；它用前台服务保持即时连接。
3. 在 Mac 上保存端点并发一条测试通知：

   ```bash
   prosperod notify --url https://ntfy.sh/<难以猜测的-topic>
   prosperod notify --test
   ```

4. 将 Prospero 切到后台，让 agent 触发审批；通知应到达，点击应打开具体会话。若 ROM 有激进省电策略，请允许 ntfy 后台运行；Prospero 本身被杀后会在深链唤起时重连。

公用 topic 名不是秘密存储且可能被猜中；审批详情虽只含会话名、动作和资源摘要，长期使用仍建议自建 ntfy 或至少使用高熵 topic。

## 开发与检查

```bash
# Android 模拟器/设备上的开发构建
npm run android -w @prospero/mobile

# 类型与移动端测试
npx tsc --noEmit -p apps/mobile/tsconfig.json
npm test -w @prospero/mobile
```

终端 HTML 由 daemon 侧唯一源生成。升级 xterm 依赖或修改 `apps/daemon/term.html` 后运行：

```bash
npm run build:terminal -w @prospero/mobile
```
