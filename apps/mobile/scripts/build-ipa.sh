#!/usr/bin/env bash
#
# 构建并签名 iOS IPA,可选直接装到连着的设备上。
#
# 两种签名方式:
#   --team   用自己的开发者账号,Xcode 自动创建/下载描述文件,bundle id 用
#            app.json 里的(com.linn0x.prospero)。推荐 —— 不会和别的 App 抢身份。
#   --profile 用第三方签名槽的描述文件。这类槽绑定一个【固定的】bundle id,
#            两个 App 用同一张证书就会互相覆盖(实际踩过:FundWatch 把
#            Prospero 从设备上顶掉了)。
# 脚本本身不含任何证书信息。
#
#   ./scripts/build-ipa.sh --team <TEAMID> --install --launch          # 自己的账号
#   ./scripts/build-ipa.sh --profile <file>.mobileprovision --install  # 第三方签名槽
#
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"

PROFILE="${PROFILE:-}"
TEAM="${TEAM:-}"
OUTPUT_DIR=""
DO_INSTALL=0
DO_LAUNCH=0
DO_PREBUILD=1
DEVICE_UDID="${DEVICE_UDID:-}"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# 按 Team ID 找签名证书。
#
# 不能只看证书名里括号中的内容:第三方分发证书恰好是
# "iPhone Distribution: 某某 (TEAMID)",但 Apple Development 证书是
# "Apple Development: 邮箱 (证书ID)" —— 括号里是【证书自己的 ID】,
# Team ID 在 X.509 的 OU 字段里。只按名字匹配,自己的账号就永远找不到。
find_identity_for_team() {
  local team="$1"
  # 先试名字里带 team 的(第三方证书是这种)
  local byname
  byname="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n "s/.*\"\(.*(${team})\)\".*/\1/p" | head -1)"
  if [[ -n "$byname" ]]; then printf '%s' "$byname"; return; fi
  # 再按证书 OU 找
  local sha name
  while read -r sha name; do
    [[ -n "$sha" ]] || continue
    if security find-certificate -c "$name" -p 2>/dev/null \
       | openssl x509 -noout -subject 2>/dev/null | grep -q "OU=${team}"; then
      printf '%s' "$name"; return
    fi
  done < <(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/^ *[0-9]*) *\([0-9A-F]*\) *"\(.*\)"$/\1 \2/p')
}
step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }

usage() {
  sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'
选项:
  -t, --team <TEAMID>    用自己的开发者账号自动签名(Xcode 自动创建描述文件)
  -p, --profile <path>   用第三方签名槽的 .mobileprovision;与 --team 二选一
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
    -t|--team)    TEAM="${2:?--team 需要一个 Team ID}"; shift 2 ;;
    -o|--output)  OUTPUT_DIR="${2:?--output 需要一个路径}"; shift 2 ;;
    -d|--device)  DEVICE_UDID="${2:?--device 需要一个 UDID}"; shift 2 ;;
    -i|--install) DO_INSTALL=1; shift ;;
    -l|--launch)  DO_LAUNCH=1; DO_INSTALL=1; shift ;;
    --no-prebuild) DO_PREBUILD=0; shift ;;
    -h|--help)    usage ;;
    *) die "未知参数:$1(--help 看用法)" ;;
  esac
done

if [[ -n "$TEAM" && -n "$PROFILE" ]]; then
  die "--team 与 --profile 只能选一个:前者让 Xcode 自动配置,后者用你给的描述文件。"
fi
if [[ -z "$TEAM" && -z "$PROFILE" ]]; then
  die "需要 --team <TEAMID>(自己的账号)或 --profile <文件>(第三方签名槽)。"
fi
[[ -z "$PROFILE" || -f "$PROFILE" ]] || die "描述文件不存在:$PROFILE"
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

PLIST="$(mktemp -t prospero-profile)"
trap 'rm -f "$PLIST"' EXIT

if [[ -n "$TEAM" ]]; then
  # 自动签名:bundle id 交给 app.json,描述文件由 Xcode 现配
  step "自动签名(自己的开发者账号)"
  TEAM_ID="$TEAM"
  BUNDLE_ID="${IOS_BUNDLE_ID:-}"
  METHOD="debugging"
  PROFILE_UUID=""
  ALLOWED=""
  SIGN_IDENTITY="$(find_identity_for_team "$TEAM_ID")"
  [[ -n "$SIGN_IDENTITY" ]] || die "钥匙串里没有 team $TEAM_ID 的证书。先在 Xcode 里登录该 Apple ID。"
  info "Team:   $TEAM_ID"
  info "证书:   $SIGN_IDENTITY"
  info "描述文件由 Xcode 按需创建;设备需连着并已信任本机"
else

step "解析描述文件"
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
SIGN_IDENTITY="$(find_identity_for_team "$TEAM_ID")"
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

fi

# ---------------------------------------------------------------- 构建

# Metro 解析 @prospero/protocol 要的是编译产物,不是源码;不先建就会在
# "Bundle React Native code and images" 阶段挂掉,且报错信息指向 node_modules,很难懂。
step "构建 @prospero/protocol"
(cd "$REPO_ROOT" && npx tsc --build packages/protocol)

if (( DO_PREBUILD )); then
  step "生成 iOS 工程(expo prebuild)"
  if [[ -n "$BUNDLE_ID" ]]; then
    (cd "$MOBILE_DIR" && IOS_BUNDLE_ID="$BUNDLE_ID" npx expo prebuild -p ios --clean)
  else
    # 自动签名:用 app.json 里的 bundle id,不覆盖
    (cd "$MOBILE_DIR" && npx expo prebuild -p ios --clean)
  fi
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
if [[ -n "$TEAM" ]]; then
  xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" \
    -configuration Release -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" -allowProvisioningUpdates archive \
    CODE_SIGN_STYLE=Automatic \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    | grep -E '^(\*\*|.*(error|warning: .*sign):)' || true
else
  xcodebuild -workspace "$WORKSPACE" -scheme "$SCHEME" \
    -configuration Release -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" -allowProvisioningUpdates archive \
    CODE_SIGN_STYLE=Manual \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    PROVISIONING_PROFILE_SPECIFIER="$PROFILE_UUID" \
    CODE_SIGN_IDENTITY="$SIGN_IDENTITY" \
    | grep -E '^(\*\*|.*(error|warning: .*sign):)' || true
fi

[[ -d "$ARCHIVE" ]] || die "归档失败,完整日志重跑一次去掉末尾的 grep 就能看到"

step "导出 IPA"
# 先删掉上一次的产物。否则导出失败时旧 IPA 还在,后面的存在性检查会通过,
# 脚本报"完成"、你装上去的却是上一版 —— 这种错最难发现。
IPA="$OUTPUT_DIR/$SCHEME.ipa"
rm -f "$IPA"
EXPORT_PLIST="$OUTPUT_DIR/ExportOptions.plist"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>$METHOD</string>
  <key>teamID</key><string>$TEAM_ID</string>
$(if [[ -n "$TEAM" ]]; then
  echo "  <key>signingStyle</key><string>automatic</string>"
else
  echo "  <key>signingStyle</key><string>manual</string>"
  echo "  <key>signingCertificate</key><string>$SIGN_IDENTITY</string>"
  echo "  <key>provisioningProfiles</key>"
  echo "  <dict><key>$BUNDLE_ID</key><string>$PROFILE_UUID</string></dict>"
fi)
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

[[ -f "$IPA" ]] || die "导出失败,没生成 $IPA(上一次的产物已清掉,不会误当成功)"
info "$IPA ($(du -h "$IPA" | cut -f1))"

# ---------------------------------------------------------------- 安装

if (( DO_INSTALL )); then
  step "安装到设备"

  # 描述文件授权了哪些设备(自动签名时没有可查的白名单)
  if [[ -z "$TEAM" ]]; then
    ALLOWED="$(pb ':ProvisionedDevices' | sed -n 's/^ *\([0-9A-Fa-f-]\{8,\}\) *$/\1/p')"
  fi

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
    # 启动失败不算构建失败 —— 装都装上了,手动点一下图标就行。
    if xcrun devicectl device process launch --device "$DEVICE_UDID" "$BUNDLE_ID" \
         > "$OUTPUT_DIR/launch.log" 2>&1; then
      info "已启动"
    elif grep -q "unlocked" "$OUTPUT_DIR/launch.log"; then
      info "启动跳过:手机锁屏了。解锁后手动点图标,或重跑本命令加 --no-prebuild。"
    else
      info "启动失败(已安装,可手动点图标):"
      tail -3 "$OUTPUT_DIR/launch.log" | sed 's/^/      /'
    fi
  fi
fi

step "完成"
info "IPA: $IPA"
