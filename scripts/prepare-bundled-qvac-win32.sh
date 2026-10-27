#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/resources/qvac-runtime"
QVAC_VERSION="${QVAC_VERSION:-0.16.0}"

if [ -f "$DEST/node_modules/@qvac/cli/dist/index.js" ] && [ -d "$DEST/node_modules/bare-runtime-win32-x64" ]; then
  echo "Bundled QVAC runtime already present at resources/qvac-runtime."
  exit 0
fi

echo "Installing QVAC CLI ${QVAC_VERSION} for win32-x64 into VS Code extension resources..."
rm -rf "$DEST"
mkdir -p "$DEST"
npm install "@qvac/cli@${QVAC_VERSION}" \
  --prefix "$DEST" \
  --os=win32 \
  --cpu=x64 \
  --force \
  --no-audit \
  --no-fund \
  --ignore-scripts \
  --loglevel=error

test -f "$DEST/node_modules/@qvac/cli/dist/index.js"
test -d "$DEST/node_modules/bare-runtime-win32-x64"
test -d "$DEST/node_modules/@qvac/fabric-win32-x64"
node "$ROOT/scripts/slim-qvac-runtime.js" "$DEST" win32-x64
test -d "$DEST/node_modules/@qvac/fabric-win32-x64"
echo "Bundled chat-only Windows QVAC runtime ready: $(du -sh "$DEST" | cut -f1)"
