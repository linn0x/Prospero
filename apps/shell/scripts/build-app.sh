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
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSLocalNetworkUsageDescription</key>
  <string>Prospero 在本地网络上广播与接受来自你手机的直连,用于远程控制 code agent 会话。</string>
  <key>NSBonjourServices</key>
  <array><string>_prospero._tcp</string></array>
</dict>
PLIST
echo '</plist>' >> "$APP/Contents/Info.plist"

# ad-hoc 签名:个人自用足够。注意 TCC 认的是 cdhash,重新编译会换 hash,
# 之前授过的权限可能要重授一次。
step "签名(ad-hoc)"
codesign --force --deep --sign - "$APP"
codesign --verify --verbose=1 "$APP" 2>&1 | sed 's/^/    /'

info "$APP"

if (( DO_RUN )); then
  step "启动"
  # 已经跑着的话先退掉,否则会开出两个主窗口
  pkill -x ProsperoShell 2>/dev/null || true
  sleep 0.5
  open "$APP"
  info "Prospero 主窗口已打开"
fi
