#!/usr/bin/env bash
#
# 从 CNG 配置生成 Android 工程，构建可离线启动的 APK，并可选安装/启动。
# Release 产物由 Expo/RN 模板生成的 debug keystore 签名，适合个人侧载；脚本不保存
# keystore 路径、别名或密码。若要正式分发，应在 CI/Gradle 中注入独立 release key。
#
#   ./scripts/build-apk.sh --install --launch
#
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"

OUTPUT_DIR=""
BUILD_VARIANT="release"
DO_INSTALL=0
DO_LAUNCH=0
DO_PREBUILD=1
DEVICE_SERIAL="${ANDROID_SERIAL:-}"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }

usage() {
  sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'
选项:
  -o, --output <dir>     产物目录(默认 apps/mobile/build/apk)
  -i, --install          构建后安装到 adb 设备
  -l, --launch           安装后启动(隐含 --install)
  -d, --device <serial>  指定 adb 设备(也可设 ANDROID_SERIAL)
      --debug            构建需 Metro 的 debug APK(默认是可离线启动的 release)
      --no-prebuild      跳过 expo prebuild，复用现有 android/ 目录
  -h, --help
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) OUTPUT_DIR="${2:?--output 需要一个目录}"; shift 2 ;;
    -d|--device) DEVICE_SERIAL="${2:?--device 需要一个 serial}"; shift 2 ;;
    -i|--install) DO_INSTALL=1; shift ;;
    -l|--launch) DO_LAUNCH=1; DO_INSTALL=1; shift ;;
    --debug) BUILD_VARIANT="debug"; shift ;;
    --no-prebuild) DO_PREBUILD=0; shift ;;
    -h|--help) usage ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
done

OUTPUT_DIR="${OUTPUT_DIR:-$MOBILE_DIR/build/apk}"

command -v node >/dev/null 2>&1 || die "找不到 Node.js（需要项目 package.json 声明的版本）"
command -v npx >/dev/null 2>&1 || die "找不到 npx"
command -v java >/dev/null 2>&1 || die "找不到 JDK（Expo SDK 57 Android 构建需要 JDK 17+）"

SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
[[ -d "$SDK_ROOT" ]] || die "找不到 Android SDK：$SDK_ROOT。请设置 ANDROID_SDK_ROOT。"
export ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_HOME="$SDK_ROOT"
export PATH="$SDK_ROOT/platform-tools:$SDK_ROOT/cmdline-tools/latest/bin:$PATH"

SDKMANAGER="$(command -v sdkmanager || true)"
if [[ ! -d "$SDK_ROOT/platforms/android-36" || ! -d "$SDK_ROOT/build-tools/36.0.0" ]]; then
  [[ -n "$SDKMANAGER" ]] || die "缺少 Android SDK 36 / Build Tools 36.0.0，且找不到 sdkmanager"
  step "安装 Expo SDK 57 所需 Android SDK 组件"
  "$SDKMANAGER" "platforms;android-36" "build-tools;36.0.0" "platform-tools"
fi

step "工具链"
info "Node:        $(node --version)"
info "Java:        $(java -version 2>&1 | head -1)"
info "Android SDK: $SDK_ROOT"
info "Variant:     $BUILD_VARIANT"

step "构建 @prospero/protocol"
(cd "$REPO_ROOT" && npx tsc --build packages/protocol)

if (( DO_PREBUILD )); then
  step "生成 Android 工程（expo prebuild --clean）"
  (cd "$MOBILE_DIR" && EXPO_NO_GIT_STATUS=1 npx expo prebuild -p android --clean)
else
  step "跳过 prebuild，复用现有 android/"
  [[ -d "$MOBILE_DIR/android" ]] || die "android/ 不存在，不能用 --no-prebuild"
fi

DEBUG_KEYSTORE="$MOBILE_DIR/android/app/debug.keystore"
[[ -f "$DEBUG_KEYSTORE" ]] || die "Expo 模板未生成 debug keystore：$DEBUG_KEYSTORE"
info "侧载签名：Expo/RN 模板 debug keystore"

if [[ "$BUILD_VARIANT" == "release" ]]; then
  GRADLE_TASK="assembleRelease"
  APK_SOURCE="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
else
  GRADLE_TASK="assembleDebug"
  APK_SOURCE="$MOBILE_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
fi

step "Gradle $GRADLE_TASK"
(cd "$MOBILE_DIR/android" && NODE_ENV=production ./gradlew ":app:$GRADLE_TASK" --console=plain)
[[ -f "$APK_SOURCE" ]] || die "Gradle 成功但没找到 APK：$APK_SOURCE"

mkdir -p "$OUTPUT_DIR"
APK="$OUTPUT_DIR/prospero-$BUILD_VARIANT.apk"
cp "$APK_SOURCE" "$APK"

APKSIGNER="$SDK_ROOT/build-tools/36.0.0/apksigner"
if [[ -x "$APKSIGNER" ]]; then
  "$APKSIGNER" verify "$APK" || die "APK 签名校验失败"
fi
info "APK: $APK ($(du -h "$APK" | cut -f1))"

if (( DO_INSTALL )); then
  command -v adb >/dev/null 2>&1 || die "找不到 adb"
  if [[ -z "$DEVICE_SERIAL" ]]; then
    mapfile_output="$(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')"
    device_count="$(printf '%s\n' "$mapfile_output" | awk 'NF { count++ } END { print count + 0 }')"
    [[ "$device_count" -gt 0 ]] || die "没有可用 adb 设备。连接并解锁手机，或先启动模拟器。"
    [[ "$device_count" -eq 1 ]] || die "发现多台 adb 设备，请用 --device 指定：$(tr '\n' ' ' <<<"$mapfile_output")"
    DEVICE_SERIAL="$mapfile_output"
  fi
  ADB=(adb -s "$DEVICE_SERIAL")
  "${ADB[@]}" get-state >/dev/null 2>&1 || die "adb 设备不可用：$DEVICE_SERIAL"

  step "安装到 $DEVICE_SERIAL"
  "${ADB[@]}" install -r "$APK"

  if (( DO_LAUNCH )); then
    PACKAGE_ID="$(node -e 'process.stdout.write(require(process.argv[1]).expo.android.package)' "$MOBILE_DIR/app.json")"
    step "启动 $PACKAGE_ID"
    "${ADB[@]}" shell am start -W -n "$PACKAGE_ID/.MainActivity" >/dev/null
  fi
fi

step "完成"
info "APK: $APK"
