#!/bin/sh
set -eu

MARKER=${1:-}
METADATA_FILE=${2:-}
if ! printf '%s' "$MARKER" | grep -Eq '^[a-f0-9]{32}$'; then
  echo "owned process marker must be 32 lowercase hexadecimal characters" >&2
  exit 64
fi
if [ -z "$METADATA_FILE" ]; then
  echo "owned process metadata file is required" >&2
  exit 64
fi
shift 2
if [ "$#" -eq 0 ]; then
  echo "owned process command is required" >&2
  exit 64
fi

CHILD_PID=""
SELF_PID=$$

retire_metadata() {
  if [ ! -f "$METADATA_FILE" ]; then
    return
  fi
  RECORDED_PID=$(sed -n '1p' "$METADATA_FILE")
  RECORDED_MARKER=$(sed -n '2p' "$METADATA_FILE")
  if [ "$RECORDED_PID" = "$SELF_PID" ] && [ "$RECORDED_MARKER" = "$MARKER" ]; then
    rm -f "$METADATA_FILE"
  else
    echo "Refusing to retire process metadata that is no longer owned by this wrapper." >&2
  fi
}

stop_child() {
  if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
}
trap 'stop_child; retire_metadata; exit 0' INT TERM HUP

OWNER_TEMP="$METADATA_FILE.tmp.$SELF_PID"
printf '%s\n%s\n' "$SELF_PID" "$MARKER" > "$OWNER_TEMP"
mv "$OWNER_TEMP" "$METADATA_FILE"

"$@" &
CHILD_PID=$!
set +e
wait "$CHILD_PID"
STATUS=$?
set -e
CHILD_PID=""
retire_metadata
exit "$STATUS"
