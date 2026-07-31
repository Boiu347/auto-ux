#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/auto-ux-process-test.XXXXXX")
INNOCENT_PID=""
OWNED_PID=""
DIRECT_PID=""
SPOOF_PID=""

cleanup() {
  for PID in "$INNOCENT_PID" "$OWNED_PID" "$DIRECT_PID" "$SPOOF_PID"; do
    case "$PID" in
      ''|*[!0-9]*) ;;
      *) kill "$PID" 2>/dev/null || true ;;
    esac
  done
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT INT TERM

if [ ! -x "$PROJECT_ROOT/scripts/process-owner.sh" ] ||
  [ ! -x "$PROJECT_ROOT/scripts/owned-process.sh" ]; then
  echo "process ownership helpers are missing" >&2
  exit 1
fi

SPOOF_MARKER='11223344556677889900aabbccddeeff'
node -e 'setTimeout(() => {}, 60000)' \
  "$PROJECT_ROOT/scripts/owned-process.sh" "$SPOOF_MARKER" &
SPOOF_PID=$!
printf '%s\n%s\n' "$SPOOF_PID" "$SPOOF_MARKER" > "$TEMP_ROOT/spoof.owner"
if "$PROJECT_ROOT/scripts/process-owner.sh" stop \
  "$TEMP_ROOT/spoof.owner" \
  "$PROJECT_ROOT/scripts/owned-process.sh"; then
  echo "non-wrapper process with matching arguments was accepted as owned" >&2
  exit 1
fi
if ! kill -0 "$SPOOF_PID" 2>/dev/null; then
  echo "non-wrapper process with matching arguments was killed" >&2
  exit 1
fi

sleep 60 &
INNOCENT_PID=$!
printf '%s\n%s\n' "$INNOCENT_PID" '0123456789abcdef0123456789abcdef' > "$TEMP_ROOT/reused.owner"

if "$PROJECT_ROOT/scripts/process-owner.sh" stop \
  "$TEMP_ROOT/reused.owner" \
  "$PROJECT_ROOT/scripts/owned-process.sh"; then
  echo "reused PID was accepted as owned" >&2
  exit 1
fi
if ! kill -0 "$INNOCENT_PID" 2>/dev/null; then
  echo "reused PID target was killed" >&2
  exit 1
fi

MARKER='fedcba9876543210fedcba9876543210'
"$PROJECT_ROOT/scripts/owned-process.sh" "$MARKER" "$TEMP_ROOT/owned.owner" sleep 60 &
OWNED_PID=$!
ATTEMPT=0
while [ ! -f "$TEMP_ROOT/owned.owner" ] && [ "$ATTEMPT" -lt 50 ]; do
  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.1
done
if [ ! -f "$TEMP_ROOT/owned.owner" ]; then
  echo "owned wrapper did not create metadata" >&2
  exit 1
fi

"$PROJECT_ROOT/scripts/process-owner.sh" stop \
  "$TEMP_ROOT/owned.owner" \
  "$PROJECT_ROOT/scripts/owned-process.sh"

if kill -0 "$OWNED_PID" 2>/dev/null; then
  echo "owned process was not stopped" >&2
  exit 1
fi
if [ -e "$TEMP_ROOT/owned.owner" ]; then
  echo "owned process metadata was not retired" >&2
  exit 1
fi

OWNED_PID=""

DIRECT_MARKER='00112233445566778899aabbccddeeff'
"$PROJECT_ROOT/scripts/owned-process.sh" \
  "$DIRECT_MARKER" "$TEMP_ROOT/direct.owner" sleep 60 &
DIRECT_PID=$!
ATTEMPT=0
while [ ! -f "$TEMP_ROOT/direct.owner" ] && [ "$ATTEMPT" -lt 50 ]; do
  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.1
done
if [ ! -f "$TEMP_ROOT/direct.owner" ]; then
  echo "direct wrapper did not create metadata" >&2
  exit 1
fi
kill "$DIRECT_PID"
wait "$DIRECT_PID" 2>/dev/null || true
if [ -e "$TEMP_ROOT/direct.owner" ]; then
  echo "owned wrapper did not retire metadata after direct termination" >&2
  exit 1
fi
DIRECT_PID=""

echo "process ownership checks passed"
