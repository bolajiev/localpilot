#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/models"
MODEL_NAME="Qwen3-0.6B-Q4_0.gguf"
MODEL_URL="https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/50968a4468ef4233ed78cd7c3de230dd1d61a56b/Qwen3-0.6B-Q4_0.gguf"
EXPECTED_SHA="33bcc57074ec7b6eada5a90651ee546ec0c2b271002c22baf9f1b2dd1e8f75cb"
CACHE="$HOME/.qvac/models/5b8aae816570a09d_${MODEL_NAME}"

mkdir -p "$DEST"
if [ ! -f "$DEST/$MODEL_NAME" ]; then
  if [ -f "$CACHE" ]; then
    echo "Copying cached model into resources/models..."
    cp "$CACHE" "$DEST/$MODEL_NAME"
  else
    echo "Downloading ${MODEL_NAME} (about 382 MB)..."
    curl -fL --retry 3 -o "$DEST/$MODEL_NAME" "$MODEL_URL"
  fi
fi

ACTUAL_SHA="$(sha256sum "$DEST/$MODEL_NAME" | cut -d' ' -f1)"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "SHA-256 mismatch for $MODEL_NAME: $ACTUAL_SHA" >&2
  exit 1
fi

cp "$ROOT/docs/third-party/Qwen3-0.6B-NOTICE.txt" "$DEST/MODEL-NOTICE.txt"
cp "$ROOT/docs/third-party/LICENSE-APACHE-2.0.txt" "$DEST/LICENSE-APACHE-2.0.txt"
echo "Bundled model ready: $(du -sh "$DEST" | cut -f1), sha256=$ACTUAL_SHA"
