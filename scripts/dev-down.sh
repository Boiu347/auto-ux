#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

"$PROJECT_ROOT/scripts/stop-web.sh"

cd "$PROJECT_ROOT"
docker compose stop postgres
