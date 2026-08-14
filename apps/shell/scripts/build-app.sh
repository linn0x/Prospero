#!/usr/bin/env bash
#
# 编译 macOS 控制中心并组装成 Prospero.app。
#
# 为什么要组 .app 而不是直接跑 SwiftPM 产物:TCC 权限按 app bundle 归属。
# 裸可执行文件拿不到稳定身份,`~/Documents` 之类的授权每次都会重问甚至直接被拒 ——
# 这个壳存在的意义就是给 daemon 一个能被授权的父进程。
#
#   ./scripts/build-app.sh [--run]
#
set -euo pipefail

SHELL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$SHELL_DIR/build"
APP="$BUILD_DIR/Prospero.app"
DO_RUN=0

[[ "${1:-}" == "--run" ]] && DO_RUN=1

step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }

# TCC（文件、自动化等隐私授权）按代码签名要求识别 App。ad-hoc 签名的指定要求
# 只有 cdhash，而 cdhash 每次编译都会变，于是普通升级也会被当成新 App。
# 优先复用钥匙串中的 Apple Development / Developer ID 身份；同一 Team + bundle id
# 的指定要求跨构建稳定。CI 或没有开发者证书的机器仍可显式允许 ad-hoc。
find_stable_identity() {
  security find-identity -v -p codesigning 2>/dev/null \
    | awk '/"Apple Development:|"Developer ID Application:/{ print $2; exit }'
}

# CommandLineTools 里没有 SwiftUI 的 macOS SDK
if ! xcode-select -p 2>/dev/null | grep -q "Xcode.app"; then
  for candidate in /Applications/Xcode*.app; do
    [[ -d "$candidate/Contents/Developer" ]] || continue
    export DEVELOPER_DIR="$candidate/Contents/Developer"
    break
  done
fi

step "编译(release)"
cd "$SHELL_DIR"
swift build -c release --product ProsperoShell
BINARY="$(swift build -c release --product ProsperoShell --show-bin-path)/ProsperoShell"
[[ -f "$BINARY" ]] || { echo "编译产物不存在:$BINARY" >&2; exit 1; }

step "组装 Prospero.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BINARY" "$APP/Contents/MacOS/ProsperoShell"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Prospero</string>
  <key>CFBundleDisplayName</key><string>Prospero</string>
  <key>CFBundleIdentifier</key><string>com.linn0x.prospero.shell</string>
  <key>CFBundleExecutable</key><string>ProsperoShell</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.13</string>
  <key>CFBundleVersion</key><string>13</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>Prospero 在本地网络上广播与接受来自你手机的直连,用于远程控制 code agent 会话。</string>
  <key>NSBonjourServices</key>
  <array><string>_prospero._tcp</string></array>
</dict>
PLIST
echo '</plist>' >> "$APP/Contents/Info.plist"

# 默认使用稳定身份，避免每次升级重授 TCC。首次从旧 ad-hoc 身份切过来仍可能需要
# 确认一次；之后同一 Team 与 bundle id 的构建沿用同一个指定要求。
SIGN_IDENTITY="${MAC_SIGN_IDENTITY:-$(find_stable_identity)}"
if [[ -n "$SIGN_IDENTITY" ]]; then
  step "签名(稳定开发者身份)"
  codesign --force --deep --options runtime --timestamp=none --sign "$SIGN_IDENTITY" "$APP"
  info "Identity: $SIGN_IDENTITY"
elif [[ "${ALLOW_ADHOC_SIGNING:-0}" == "1" ]]; then
  step "签名(ad-hoc；升级会重新请求 TCC 授权)"
  codesign --force --deep --sign - "$APP"
else
  echo "找不到稳定的 macOS 代码签名身份。先在 Xcode 登录 Apple ID，或设置 MAC_SIGN_IDENTITY。" >&2
  echo "确实只想临时 ad-hoc 构建时可设 ALLOW_ADHOC_SIGNING=1（升级会重新授权）。" >&2
  exit 1
fi
codesign --verify --verbose=1 "$APP" 2>&1 | sed 's/^/    /'

info "$APP"

if (( DO_RUN )); then
  step "启动"
  # macOS 上从 .app 启动的进程名有时会表现成完整 executable path，
  # `pkill -x ProsperoShell` 因此匹配不到。先让同 bundle id 的旧壳优雅退出，
  # applicationWillTerminate 会同步通知它托管的 daemon 落盘并终止。
  osascript -e 'tell application id "com.linn0x.prospero.shell" to quit' \
    >/dev/null 2>&1 || true
  for _ in {1..30}; do
    pgrep -f "$APP/Contents/MacOS/ProsperoShell" >/dev/null 2>&1 || break
    sleep 0.1
  done
  # 旧版若没有响应 Apple Event，只终止这个明确路径下的壳，不波及别的进程。
  pkill -f "$APP/Contents/MacOS/ProsperoShell" 2>/dev/null || true
  sleep 0.5
  open "$APP"
  info "Prospero 主窗口已打开"
fi
