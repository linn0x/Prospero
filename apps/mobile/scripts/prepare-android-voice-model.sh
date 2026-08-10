#!/usr/bin/env bash
# Downloads the pinned multilingual Whisper model used by the Android APK.
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_DIR="$MOBILE_DIR/.cache/voice"
MODEL_FILE="$MODEL_DIR/ggml-small-q5_1.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin"
MODEL_SHA256="ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb"

checksum() {
  shasum -a 256 "$1" | awk '{ print $1 }'
}

mkdir -p "$MODEL_DIR"
if [[ -f "$MODEL_FILE" && "$(checksum "$MODEL_FILE")" == "$MODEL_SHA256" ]]; then
  printf 'Android 离线语音模型已就绪：%s\n' "$MODEL_FILE"
  exit 0
fi

command -v curl >/dev/null 2>&1 || {
  printf 'error: 下载离线语音模型需要 curl\n' >&2
  exit 1
}

DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/prospero-voice-model.XXXXXX")"
DOWNLOAD_FILE="$DOWNLOAD_DIR/ggml-small-q5_1.bin"
trap 'rm -rf "$DOWNLOAD_DIR"' EXIT

printf '下载 Android 中英混合离线语音模型（约 190 MB）…\n'
curl --fail --location --retry 3 --progress-bar \
  "$MODEL_URL" \
  --output "$DOWNLOAD_FILE"

ACTUAL_SHA256="$(checksum "$DOWNLOAD_FILE")"
if [[ "$ACTUAL_SHA256" != "$MODEL_SHA256" ]]; then
  printf 'error: 语音模型校验失败（实际 %s）\n' "$ACTUAL_SHA256" >&2
  exit 1
fi

mv "$DOWNLOAD_FILE" "$MODEL_FILE"
printf 'Android 离线语音模型已就绪：%s\n' "$MODEL_FILE"
