#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="${NODE_VERSION:-24.21.0}"
DEST="$ROOT/resources/node"
TMP="$ROOT/.tmp/node-bundle"
ZIP="$TMP/node.zip"
URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip"

mkdir -p "$TMP" "$DEST"
if [ ! -f "$ZIP" ]; then
  echo "Downloading Node.js ${NODE_VERSION} win-x64..."
  curl -fL --retry 3 -o "$ZIP" "$URL"
fi
rm -rf "$TMP/extracted"
mkdir -p "$TMP/extracted"
unzip -q "$ZIP" -d "$TMP/extracted"
SRC="$TMP/extracted/node-v${NODE_VERSION}-win-x64"
test -f "$SRC/node.exe"

rm -rf "$DEST"
mkdir -p "$DEST/node_modules"
cp "$SRC/node.exe" "$DEST/node.exe"
cp -R "$SRC/node_modules/npm" "$DEST/node_modules/npm"
cp "$SRC/LICENSE" "$DEST/NODE-LICENSE"
echo "Bundled Node.js ${NODE_VERSION} at resources/node (node.exe + npm)."
