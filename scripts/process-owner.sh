#!/bin/sh
set -eu

ACTION=${1:-}
METADATA_FILE=${2:-}
OWNED_WRAPPER=${3:-}

if [ -z "$METADATA_FILE" ] || [ -z "$OWNED_WRAPPER" ]; then
  echo "usage: process-owner.sh verify|stop METADATA_FILE OWNED_WRAPPER" >&2
  exit 64
fi
if [ ! -f "$METADATA_FILE" ]; then
  [ "$ACTION" = "stop" ] && exit 0
  exit 1
fi

PID=$(sed -n '1p' "$METADATA_FILE")
MARKER=$(sed -n '2p' "$METADATA_FILE")
case "$PID" in
  ''|*[!0-9]*)
    echo "Refusing invalid process metadata: $METADATA_FILE" >&2
    exit 2
    ;;
esac
if ! printf '%s' "$MARKER" | grep -Eq '^[a-f0-9]{32}$'; then
  echo "Refusing invalid ownership marker: $METADATA_FILE" >&2
  exit 2
fi

process_status() {
  if ! kill -0 "$PID" 2>/dev/null; then
    return 1
  fi
  if [ -r "/proc/$PID/stat" ]; then
    STATE=$(sed 's/^.*) //; s/ .*//' "/proc/$PID/stat" 2>/dev/null || true)
  elif command -v ps >/dev/null 2>&1; then
    STATE=$(ps -p "$PID" -o state= 2>/dev/null | tr -d '[:space:]')
  else
    STATE=""
  fi
  if [ -z "$STATE" ]; then
    if ! kill -0 "$PID" 2>/dev/null; then
      return 1
    fi
    return 2
  fi
  if [ "${STATE#Z}" != "$STATE" ]; then
    return 1
  fi
  return 0
}

if process_status; then
  :
else
  PROCESS_STATUS=$?
  if [ "$PROCESS_STATUS" -eq 1 ]; then
    rm -f "$METADATA_FILE"
    [ "$ACTION" = "stop" ] && exit 0
    exit 1
  fi
  echo "Refusing to signal PID $PID: process identity cannot be inspected." >&2
  exit 2
fi

if [ -r "/proc/$PID/cmdline" ]; then
  COMMAND=$(tr '\000' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)
elif command -v ps >/dev/null 2>&1; then
  COMMAND=$(ps -p "$PID" -o command= 2>/dev/null || true)
else
  COMMAND=""
fi
EXPECTED_PREFIX="/bin/sh $OWNED_WRAPPER $MARKER $METADATA_FILE "
case "$COMMAND" in
  "$EXPECTED_PREFIX"*) ;;
  *)
    echo "Refusing to signal PID $PID: ownership identity does not match." >&2
    exit 2
    ;;
esac

if [ "$ACTION" = "verify" ]; then
  exit 0
fi
if [ "$ACTION" != "stop" ]; then
  echo "unknown process-owner action: $ACTION" >&2
  exit 64
fi

kill "$PID"
ATTEMPT=0
while [ "$ATTEMPT" -lt 50 ]; do
  if process_status; then
    :
  else
    PROCESS_STATUS=$?
    if [ "$PROCESS_STATUS" -eq 2 ]; then
      echo "Cannot verify shutdown for PID $PID; metadata was retained." >&2
      exit 3
    fi
    rm -f "$METADATA_FILE"
    echo "Stopped owned auto UX process $PID."
    exit 0
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.1
done

echo "Owned process $PID did not stop; metadata was retained." >&2
exit 3
