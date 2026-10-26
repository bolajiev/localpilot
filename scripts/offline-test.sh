#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${LOCALPILOT_OFFLINE_PORT:-11435}"
ALIAS="${LOCALPILOT_ALIAS:-localpilot-model}"
MODEL="${LOCALPILOT_MODEL:-QWEN3_600M_INST_Q4}"
MAX_TOKENS="${LOCALPILOT_MAX_TOKENS:-8}"
EXPLAIN_TOKENS="${LOCALPILOT_EXPLAIN_TOKENS:-12}"
TMP="$ROOT/.tmp"
CONFIG="$TMP/offline-qvac.config.json"
LOG="$TMP/offline-qvac.log"
mkdir -p "$TMP"

cat > "$CONFIG" <<EOF
{
  "serve": {
    "models": {
      "$ALIAS": {
        "model": "$MODEL",
        "preload": true,
        "config": { "ctx_size": 4096 }
      }
    }
  }
}
EOF

if ! command -v unshare >/dev/null 2>&1; then
  echo "FAIL: unshare is not available; cannot create an offline network namespace." >&2
  exit 2
fi

echo "LocalPilot offline test"
echo "  config=$CONFIG"
echo "  port=$PORT alias=$ALIAS model=$MODEL maxTokens=$MAX_TOKENS"
echo "Starting an isolated network namespace with only loopback..."

unshare -n bash -s <<EOF
set -euo pipefail
ip link set lo up
if curl -sS -m 3 https://example.com >/dev/null 2>&1; then
  echo "FAIL: external network is still reachable inside the namespace." >&2
  exit 3
fi
if getent hosts registry.npmjs.org >/dev/null 2>&1; then
  echo "FAIL: DNS still resolves inside the namespace." >&2
  exit 4
fi
echo "  network check: external HTTPS and DNS are unavailable; loopback is up."

START_MS=\$(date +%s%3N)
setsid qvac serve --openai --no-default -c "$CONFIG" -p "$PORT" -H 127.0.0.1 > "$LOG" 2>&1 &
SERVER_PID=\$!
cleanup() {
  kill -TERM -- "-\$SERVER_PID" 2>/dev/null || kill -TERM "\$SERVER_PID" 2>/dev/null || true
  sleep 2
  kill -KILL -- "-\$SERVER_PID" 2>/dev/null || kill -KILL "\$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

READY=0
for _ in \$(seq 1 180); do
  if curl -sS -m 1 "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "\$SERVER_PID" 2>/dev/null; then
    echo "FAIL: QVAC exited while loading the cached model." >&2
    tail -40 "$LOG" >&2 || true
    exit 5
  fi
  sleep 1
done
if [ "\$READY" -ne 1 ]; then
  echo "FAIL: QVAC did not become ready offline within 180 seconds." >&2
  tail -40 "$LOG" >&2 || true
  exit 6
fi
END_MS=\$(date +%s%3N)
echo "  offline model load/server ready in \$((END_MS - START_MS)) ms."
echo "  /v1/models: \$(curl -sS -m 2 "http://127.0.0.1:$PORT/v1/models")"

export LOCALPILOT_ENDPOINT="http://127.0.0.1:$PORT"
export LOCALPILOT_ALIAS="$ALIAS"
export LOCALPILOT_TIMEOUT_MS="900000"

echo
echo "Offline chat inference:"
LOCALPILOT_MAX_TOKENS="$MAX_TOKENS" node "$ROOT/scripts/chat-smoke.js" "Reply with exactly: LocalPilot offline OK"

if [ "\${LOCALPILOT_OFFLINE_SKIP_EXPLAIN:-0}" != "1" ]; then
  echo
  echo "Offline Explain Selected Code inference:"
  LOCALPILOT_MAX_TOKENS="$EXPLAIN_TOKENS" node "$ROOT/scripts/explain-smoke.js"
fi

echo
echo "PASS: cached model started and performed real inference with external networking disabled."
EOF
