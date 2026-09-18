#!/bin/sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
profile="${PROSPERO_BUILD_PROFILE:-release}"
version="${PROSPERO_VERSION:-0.1.0}"
app="${PROSPERO_APP_OUTPUT:-$repo_root/target/Prospero.app}"
contents="$app/Contents"
macos="$contents/MacOS"
resources="$contents/Resources"

cargo_args=""
if [ "$profile" = "release" ]; then
  cargo_args="--release"
elif [ "$profile" != "debug" ]; then
  echo "unsupported build profile: $profile" >&2
  exit 1
fi
cargo build --manifest-path "$repo_root/Cargo.toml" -p prospero-desktop -p prosperod-rs --locked $cargo_args
rm -rf "$app"
mkdir -p "$macos" "$resources"
cp "$repo_root/target/$profile/prospero-desktop" "$macos/Prospero"
mkdir -p "$resources/runtime"
cp "$repo_root/target/$profile/prosperod-rs" "$resources/runtime/prosperod-rs"
cp "$repo_root/target/$profile/prospero" "$resources/runtime/prospero"
chmod 755 "$macos/Prospero" "$resources/runtime/prosperod-rs" "$resources/runtime/prospero"
cp "$repo_root/apps/shell/Resources/AppIcon.icns" "$resources/AppIcon.icns"

tmp="$contents/Info.plist.$$"
trap 'rm -f "$tmp"' EXIT
sed "s/__VERSION__/$version/g" > "$tmp" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>Prospero</string>
  <key>CFBundleExecutable</key><string>Prospero</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>ai.prospero.desktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Prospero</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>__VERSION__</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSLocalNetworkUsageDescription</key><string>Prospero uses the local network for encrypted device connections.</string>
</dict></plist>
PLIST
mv "$tmp" "$contents/Info.plist"
trap - EXIT
codesign --force --sign - --timestamp=none "$app"
if find "$app" -type f \( -name node -o -name '*.js' -o -name '*.asar' \) -print | grep -q .; then
  echo "native app unexpectedly contains Node or JavaScript runtime files" >&2
  exit 1
fi
printf '%s\n' "$app"
