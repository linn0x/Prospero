#!/bin/sh
set -eu

command="${1:-install}"
if [ "$#" -gt 0 ]; then shift; fi

runtime_root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
label="ai.prospero.daemon.rust"
uid="$(id -u)"
domain="user/$uid"
service="$domain/$label"
launch_agents="$HOME/Library/LaunchAgents"
plist="$launch_agents/$label.plist"
data_dir="$HOME/Library/Application Support/Prospero Rust/daemon"
legacy_home="$HOME/.prospero"
binary="$runtime_root/prosperod-rs"
node="$runtime_root/node/node"
port="7424"
bind="0.0.0.0"
log_dir="$HOME/Library/Logs/Prospero"
path_value="$runtime_root:$runtime_root/node:${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --label) label="$2"; service="$domain/$label"; plist="$launch_agents/$label.plist"; shift 2 ;;
    --data-dir) data_dir="$2"; shift 2 ;;
    --legacy-home) legacy_home="$2"; shift 2 ;;
    --binary) binary="$2"; shift 2 ;;
    --node) node="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --bind) bind="$2"; shift 2 ;;
    --log-dir) log_dir="$2"; shift 2 ;;
    --path) path_value="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

emit_plist() {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0">'
    printf '%s\n' '<dict>'
    printf '%s\n' '  <key>Label</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$label")"
    printf '%s\n' '  <key>ProgramArguments</key>'
    printf '%s\n' '  <array>'
    for item in "$binary" start --home "$data_dir" --port "$port" --bind "$bind"; do
      printf '    <string>%s</string>\n' "$(xml_escape "$item")"
    done
    printf '%s\n' '  </array>'
    printf '%s\n' '  <key>EnvironmentVariables</key>'
    printf '%s\n' '  <dict>'
    printf '%s\n' '    <key>PATH</key>'
    printf '    <string>%s</string>\n' "$(xml_escape "$path_value")"
    printf '%s\n' '    <key>PROSPERO_HOME</key>'
    printf '    <string>%s</string>\n' "$(xml_escape "$data_dir")"
    printf '%s\n' '    <key>PROSPERO_LEGACY_HOME</key>'
    printf '    <string>%s</string>\n' "$(xml_escape "$legacy_home")"
    printf '%s\n' '    <key>PROSPERO_NODE</key>'
    printf '    <string>%s</string>\n' "$(xml_escape "$node")"
    printf '%s\n' '  </dict>'
    printf '%s\n' '  <key>WorkingDirectory</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$HOME")"
    printf '%s\n' '  <key>LimitLoadToSessionType</key>'
    printf '%s\n' '  <string>Background</string>'
    printf '%s\n' '  <key>RunAtLoad</key>'
    printf '%s\n' '  <true/>'
    printf '%s\n' '  <key>KeepAlive</key>'
    printf '%s\n' '  <true/>'
    printf '%s\n' '  <key>ThrottleInterval</key>'
    printf '%s\n' '  <integer>10</integer>'
    printf '%s\n' '  <key>StandardOutPath</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$log_dir/prosperod-rs.out.log")"
    printf '%s\n' '  <key>StandardErrorPath</key>'
    printf '  <string>%s</string>\n' "$(xml_escape "$log_dir/prosperod-rs.err.log")"
    printf '%s\n' '  <key>Umask</key>'
    printf '%s\n' '  <integer>63</integer>'
    printf '%s\n' '</dict>'
    printf '%s\n' '</plist>'
}

write_plist() {
  mkdir -p "$launch_agents" "$data_dir" "$log_dir"
  tmp="$plist.$$"
  emit_plist > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$plist"
}

print_json() {
  printf '{"ok":true,"label":"%s","plist":"%s","dataDir":"%s","service":"%s"}\n' "$label" "$plist" "$data_dir" "$service"
}

case "$command" in
  install|restart)
    [ -x "$binary" ] || { echo "missing Rust daemon binary: $binary" >&2; exit 1; }
    write_plist
    launchctl bootout "$service" >/dev/null 2>&1 || true
    launchctl bootstrap "$domain" "$plist"
    launchctl enable "$service"
    launchctl kickstart -k "$service"
    print_json
    ;;
  uninstall)
    launchctl bootout "$service" >/dev/null 2>&1 || true
    rm -f "$plist"
    print_json
    ;;
  status)
    launchctl print "$service"
    ;;
  print-plist)
    emit_plist
    ;;
  *)
    echo "unknown command: $command" >&2
    exit 1
    ;;
esac
