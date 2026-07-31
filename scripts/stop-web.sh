#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RUNTIME_DIR=${AUTO_UX_RUNTIME_DIR:-"$PROJECT_ROOT/.dev-runtime"}
OWNER_FILE="$RUNTIME_DIR/web.owner"
OWNED_WRAPPER="$PROJECT_ROOT/scripts/owned-process.sh"
PROCESS_OWNER="$PROJECT_ROOT/scripts/process-owner.sh"

if ! "$PROCESS_OWNER" stop "$OWNER_FILE" "$OWNED_WRAPPER"; then
  echo "Web process was not stopped because ownership could not be verified." >&2
  exit 1
fi
