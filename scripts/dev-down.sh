#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RUNTIME_DIR=${AUTO_UX_RUNTIME_DIR:-"$PROJECT_ROOT/.dev-runtime"}

if [ -f "$RUNTIME_DIR/web.pid" ]; then
  WEB_PID=$(sed -n '1p' "$RUNTIME_DIR/web.pid")
  case "$WEB_PID" in
    ''|*[!0-9]*)
      echo "Ignoring invalid web pid file: $RUNTIME_DIR/web.pid" >&2
      ;;
    *)
      if kill -0 "$WEB_PID" 2>/dev/null; then
        kill "$WEB_PID"
        echo "Stopped auto UX web process $WEB_PID."
      fi
      ;;
  esac
fi

cd "$PROJECT_ROOT"
docker compose stop postgres
