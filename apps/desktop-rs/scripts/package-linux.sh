#!/bin/sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
version="${PROSPERO_VERSION:-0.1.0}"
arch="$(uname -m)"
case "$arch" in
  x86_64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "unsupported Linux architecture: $arch" >&2; exit 1 ;;
esac
stage="$repo_root/target/package/prospero-$version-linux-$arch"
archive="$repo_root/target/package/Prospero-Native-$version-linux-$arch.tar.gz"
deb_root="$repo_root/target/package/deb-$arch"
deb="$repo_root/target/package/Prospero-Native-$version-linux-$arch.deb"

cargo build --manifest-path "$repo_root/Cargo.toml" --release --locked -p prospero-desktop -p prosperod-rs
rm -rf "$stage"
mkdir -p "$stage/bin"
install -m 755 "$repo_root/target/release/prospero-desktop" "$stage/bin/prospero-desktop"
install -m 755 "$repo_root/target/release/prosperod-rs" "$stage/bin/prosperod-rs"
install -m 755 "$repo_root/target/release/prospero" "$stage/bin/prospero"
if find "$stage" -type f \( -name node -o -name '*.js' -o -name '*.asar' \) -print | grep -q .; then
  echo "native package unexpectedly contains Node or JavaScript runtime files" >&2
  exit 1
fi
tar -C "$(dirname "$stage")" -czf "$archive" "$(basename "$stage")"
sha256sum "$archive" > "$archive.sha256"
rm -rf "$deb_root"
mkdir -p "$deb_root/DEBIAN" "$deb_root/opt/Prospero/bin" "$deb_root/usr/bin" "$deb_root/usr/share/applications" "$deb_root/usr/share/icons/hicolor/1024x1024/apps"
cp "$stage/bin/prospero-desktop" "$deb_root/opt/Prospero/bin/prospero-desktop"
cp "$stage/bin/prosperod-rs" "$deb_root/opt/Prospero/bin/prosperod-rs"
cp "$stage/bin/prospero" "$deb_root/usr/bin/prospero"
cp "$repo_root/apps/shell/Resources/AppIcon-1024.png" "$deb_root/usr/share/icons/hicolor/1024x1024/apps/prospero.png"
cat > "$deb_root/DEBIAN/control" <<EOF
Package: prospero-native
Version: $version
Architecture: $(if [ "$arch" = x64 ]; then echo amd64; else echo arm64; fi)
Maintainer: Prospero contributors
Section: devel
Priority: optional
Depends: libwayland-client0, libxkbcommon0
Description: Prospero Rust Native Desktop and daemon
EOF
cat > "$deb_root/usr/share/applications/prospero.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Prospero
Exec=/opt/Prospero/bin/prospero-desktop
Icon=prospero
Categories=Development;Utility;
Terminal=false
EOF
dpkg-deb --root-owner-group --build "$deb_root" "$deb" >/dev/null
sha256sum "$deb" > "$deb.sha256"
printf '%s\n%s\n' "$archive" "$deb"
