#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

cd "$PROJECT_ROOT/packages/contracts"
./node_modules/.bin/tsc -p tsconfig.build.json

cd "$PROJECT_ROOT/packages/execution-core"
./node_modules/.bin/tsc -p tsconfig.build.json

cd "$PROJECT_ROOT/packages/db"
./node_modules/.bin/tsc --noEmit

cd "$PROJECT_ROOT/apps/agent-simulator"
./node_modules/.bin/tsc --noEmit

cd "$PROJECT_ROOT/apps/web"
./node_modules/.bin/next build
