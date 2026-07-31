#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

cleanup() {
  STATUS=$?
  trap - EXIT INT TERM HUP
  if ! "$PROJECT_ROOT/scripts/stop-web.sh"; then
    echo "E2E cleanup could not verify local Web process ownership." >&2
    STATUS=1
  fi
  exit "$STATUS"
}
trap cleanup EXIT INT TERM HUP

cd "$PROJECT_ROOT"
./node_modules/.bin/playwright test
