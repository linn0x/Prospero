#!/bin/sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
version="${PROSPERO_VERSION:-0.1.0}"
arch="$(uname -m)"
case "$arch" in
  x86_64) arch=x64 ;;
  arm64) arch=arm64 ;;
  *) echo "unsupported macOS architecture: $arch" >&2; exit 1 ;;
esac
package_dir="$repo_root/target/package"
app="$package_dir/Prospero.app"
dmg="$package_dir/Prospero-Native-$version-mac-$arch.dmg"

mkdir -p "$package_dir"
PROSPERO_APP_OUTPUT="$app" PROSPERO_VERSION="$version" "$repo_root/apps/desktop-rs/scripts/build-macos-app.sh"
rm -f "$dmg" "$dmg.sha256"
hdiutil create -volname Prospero -srcfolder "$app" -ov -format UDZO "$dmg"
shasum -a 256 "$dmg" > "$dmg.sha256"
printf '%s\n' "$dmg"
