#!/usr/bin/env bash
#
# 构建并签名 iOS IPA,可选直接装到连着的设备上。
#
# 签名参数全部从 .mobileprovision 里推导(bundle id / team / 证书 / 设备白名单),
# 脚本本身不含任何证书信息,换一张证书只是换 --profile 的路径。
#
#   ./scripts/build-ipa.sh --profile ~/path/to.mobileprovision --install --launch
#
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"

PROFILE="${PROFILE:-}"
OUTPUT_DIR=""
DO_INSTALL=0
DO_LAUNCH=0
DO_PREBUILD=1
DEVICE_UDID="${DEVICE_UDID:-}"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }

usage() {
  sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'
选项:
  -p, --profile <path>   .mobileprovision 文件(必填,或用 PROFILE 环境变量)
  -o, --output <dir>     产物目录(默认 apps/mobile/build/ipa)
  -i, --install          导出后安装到连着的设备
  -l, --launch           安装后启动(隐含 --install)
  -d, --device <udid>    指定设备(默认自动选择描述文件授权且已连接的那台)
      --no-prebuild      跳过 expo prebuild,复用现有 ios/ 目录
  -h, --help
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--profile) PROFILE="${2:?--profile 需要一个路径}"; shift 2 ;;
    -o|--output)  OUTPUT_DIR="${2:?--output 需要一个路径}"; shift 2 ;;
    -d|--device)  DEVICE_UDID="${2:?--device 需要一个 UDID}"; shift 2 ;;
    -i|--install) DO_INSTALL=1; shift ;;
    -l|--launch)  DO_LAUNCH=1; DO_INSTALL=1; shift ;;
    --no-prebuild) DO_PREBUILD=0; shift ;;
    -h|--help)    usage ;;
    *) die "未知参数:$1(--help 看用法)" ;;
  esac
done

[[ -n "$PROFILE" ]] || die "缺少 --profile。需要一个 .mobileprovision 文件。"
[[ -f "$PROFILE" ]] || die "描述文件不存在:$PROFILE"
OUTPUT_DIR="${OUTPUT_DIR:-$MOBILE_DIR/build/ipa}"

# ---------------------------------------------------------------- 工具链

# xcode-select 常被切到 CommandLineTools,那样没有 iPhoneOS SDK。
# DEVELOPER_DIR 优先级高于 xcode-select,且不需要 sudo。
if [[ -z "${DEVELOPER_DIR:-}" ]] && ! xcode-select -p 2>/dev/null | grep -q "Xcode.app"; then
  for candidate in /Applications/Xcode*.app; do
    [[ -d "$candidate/Contents/Developer" ]] || continue
    export DEVELOPER_DIR="$candidate/Contents/Developer"
    break
  done
  [[ -n "${DEVELOPER_DIR:-}" ]] || die "找不到 Xcode.app。装完整版 Xcode,或手动设 DEVELOPER_DIR。"
fi

command -v pod >/dev/null 2>&1 || export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if (( DO_PREBUILD )) && ! command -v pod >/dev/null 2>&1; then
  die "找不到 CocoaPods(prebuild 需要)。装:brew install cocoapods"
fi

step "工具链"
info "Xcode:     $(xcodebuild -version | head -1)  ($(xcode-select -p 2>/dev/null))"
info "DEVELOPER_DIR: ${DEVELOPER_DIR:-未设置(用 xcode-select)}"

# ---------------------------------------------------------------- 解析描述文件

step "解析描述文件"
PLIST="$(mktemp -t prospero-profile)"
trap 'rm -f "$PLIST"' EXIT
security cms -D -i "$PROFILE" > "$PLIST" 2>/dev/null || die "无法解码描述文件:$PROFILE"

pb() { /usr/libexec/PlistBuddy -c "Print $1" "$PLIST" 2>/dev/null; }

PROFILE_UUID="$(pb ':UUID')" || die "描述文件里没有 UUID"
TEAM_ID="$(pb ':Entitlements:com.apple.developer.team-identifier')"
APP_ID="$(pb ':Entitlements:application-identifier')"
EXPIRES="$(pb ':ExpirationDate')"
BUNDLE_ID="${IOS_BUNDLE_ID:-${APP_ID#"$TEAM_ID".}}"

[[ "$BUNDLE_ID" == *'*'* ]] && die "描述文件是通配的($APP_ID)。用 IOS_BUNDLE_ID=... 指定具体 bundle id。"

# 过期检查:PlistBuddy 给的是 "Fri Jul 23 09:13:15 PST 2027" 这种格式
if exp_epoch="$(date -j -f '%a %b %d %T %Z %Y' "$EXPIRES" '+%s' 2>/dev/null)"; then
  now_epoch="$(date '+%s')"
  (( exp_epoch > now_epoch )) || die "描述文件已于 $EXPIRES 过期"
  info "有效期至: $EXPIRES(还剩 $(( (exp_epoch - now_epoch) / 86400 )) 天)"
fi

# 分发方式:有设备白名单 = development 或 ad-hoc,取决于 get-task-allow
GET_TASK_ALLOW="$(pb ':Entitlements:get-task-allow')"
if pb ':ProvisionedDevices' >/dev/null 2>&1; then
  if [[ "$GET_TASK_ALLOW" == "true" ]]; then METHOD="debugging"; else METHOD="release-testing"; fi
elif [[ "$(pb ':ProvisionsAllDevices')" == "true" ]]; then
  METHOD="enterprise"
else
  METHOD="app-store-connect"
fi

# 签名证书:从钥匙串里挑该 team 的那张
SIGN_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n "s/.*\"\(.*(${TEAM_ID})\)\".*/\1/p" | head -1)"
[[ -n "$SIGN_IDENTITY" ]] || die "钥匙串里没有 team $TEAM_ID 的签名证书。先双击导入对应的 .p12。"

info "Bundle ID: $BUNDLE_ID"
info "Team:      $TEAM_ID"
info "证书:      $SIGN_IDENTITY"
info "分发方式:  $METHOD"

[[ "$METHOD" == "release-testing" ]] && \
  info "注意:get-task-allow=false,产物不可调试,也连不上 Metro(JS 已打包进包体)"

# 装进 Xcode 找得到的位置
PROFILE_STORE="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$PROFILE_STORE"
cp "$PROFILE" "$PROFILE_STORE/$PROFILE_UUID.mobileprovision"

# ---------------------------------------------------------------- 构建

# Metro 解析 @prospero/protocol 要的是编译产物,不是源码;不先建就会在
# "Bundle React Native code and images" 阶段挂掉,且报错信息指向 node_modules,很难懂。
step "构建 @prospero/protocol"
(cd "$REPO_ROOT" && npx tsc --build packages/protocol)

if (( DO_PREBUILD )); then
  step "生成 iOS 工程(expo prebuild)"
  (cd "$MOBILE_DIR" && IOS_BUNDLE_ID="$BUNDLE_ID" npx expo prebuild -p ios --clean)
else
  step "跳过 prebuild,复用现有 ios/"
  [[ -d "$MOBILE_DIR/ios" ]] || die "ios/ 不存在,不能用 --no-prebuild"
fi

WORKSPACE="$(find "$MOBILE_DIR/ios" -maxdepth 1 -name '*.xcworkspace' | head -1)"
[[ -n "$WORKSPACE" ]] || die "在 ios/ 里找不到 .xcworkspace"
SCHEME="$(basename "$WORKSPACE" .xcworkspace)"

mkdir -p "$OUTPUT_DIR"
ARCHIVE="$OUTPUT_DIR/$SCHEME.xcarchive"

step "归档($SCHEME,Release)"
xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" -allowProvisioningUpdates archive \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE_UUID" \
  CODE_SIGN_IDENTITY="$SIGN_IDENTITY" \
  | grep -E '^(\*\*|.*(error|warning: .*sign):)' || true

[[ -d "$ARCHIVE" ]] || die "归档失败,完整日志重跑一次去掉末尾的 grep 就能看到"

step "导出 IPA"
EXPORT_PLIST="$OUTPUT_DIR/ExportOptions.plist"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>$METHOD</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>$SIGN_IDENTITY</string>
  <key>provisioningProfiles</key>
  <dict><key>$BUNDLE_ID</key><string>$PROFILE_UUID</string></dict>
  <key>compileBitcode</key><false/>
  <key>stripSwiftSymbols</key><true/>
  <key>thinning</key><string>&lt;none&gt;</string>
</dict>
</plist>
EOF

xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_PLIST" -exportPath "$OUTPUT_DIR" \
  -allowProvisioningUpdates \
  | grep -E '^(\*\*|.*error)' || true

IPA="$OUTPUT_DIR/$SCHEME.ipa"
[[ -f "$IPA" ]] || die "导出失败,没生成 $IPA"
info "$IPA ($(du -h "$IPA" | cut -f1))"

# ---------------------------------------------------------------- 安装

if (( DO_INSTALL )); then
  step "安装到设备"

  # 描述文件授权了哪些设备
  ALLOWED="$(pb ':ProvisionedDevices' | sed -n 's/^ *\([0-9A-Fa-f-]\{8,\}\) *$/\1/p')"

  if [[ -z "$DEVICE_UDID" ]]; then
    DEVJSON="$(mktemp -t prospero-devices)"
    trap 'rm -f "$PLIST" "$DEVJSON"' EXIT
    xcrun devicectl list devices --json-output "$DEVJSON" >/dev/null 2>&1 || true
    # tunnelState 会在设备闲置/锁屏时掉成 unavailable,但 devicectl 装的时候能自己把
    # 隧道拉起来 —— 所以只做排序偏好,不做过滤,真连不上让 devicectl 自己报错。
    DEVICE_STATE=""
    read -r DEVICE_UDID DEVICE_STATE <<<"$(python3 - "$DEVJSON" <<'PY'
import json, sys
try:
    devices = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    sys.exit(0)
best = None
for d in devices:
    hw, conn = d.get("hardwareProperties", {}), d.get("connectionProperties", {})
    if hw.get("deviceType") not in ("iPhone", "iPad") or not hw.get("udid"):
        continue
    state = conn.get("tunnelState") or "unknown"
    rank = 0 if state == "connected" else 1
    if best is None or rank < best[0]:
        best = (rank, hw["udid"], state)
if best:
    print(best[1], best[2])
PY
)"
    [[ -n "$DEVICE_UDID" ]] || die "没找到任何配对过的 iPhone/iPad。用数据线连上、解锁、信任此电脑,或用 --device 指定。"
    [[ "$DEVICE_STATE" == "connected" ]] || \
      info "提示:设备当前状态 $DEVICE_STATE,装的时候会尝试唤起连接(失败就把手机连上并解锁)"
  fi

  if [[ -n "$ALLOWED" ]] && ! grep -qix "$DEVICE_UDID" <<<"$ALLOWED"; then
    die "设备 $DEVICE_UDID 不在描述文件的授权列表里,装上去也起不来。
    授权的设备:$(tr '\n' ' ' <<<"$ALLOWED")"
  fi

  info "设备: $DEVICE_UDID"
  if ! xcrun devicectl device install app --device "$DEVICE_UDID" "$IPA" > "$OUTPUT_DIR/install.log" 2>&1; then
    die "安装失败。最后几行:
$(tail -5 "$OUTPUT_DIR/install.log" | sed 's/^/    /')
    完整日志:$OUTPUT_DIR/install.log"
  fi
  grep -E 'App installed|bundleID' "$OUTPUT_DIR/install.log" | sed 's/^/    /' || true

  if (( DO_LAUNCH )); then
    step "启动"
    xcrun devicectl device process launch --device "$DEVICE_UDID" "$BUNDLE_ID" 2>&1 | grep -E 'Launched|error' || true
  fi
fi

step "完成"
info "IPA: $IPA"
