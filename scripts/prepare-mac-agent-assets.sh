#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
ASSET_DIR="$PROJECT_ROOT/apps/web/public/downloads"

rm -rf "$ASSET_DIR"
mkdir -p "$ASSET_DIR"
cp "$PROJECT_ROOT/scripts/install-mac-agent.sh" "$ASSET_DIR/install-mac-agent.sh"
cp "$PROJECT_ROOT/scripts/mac-agent.mjs" "$ASSET_DIR/mac-agent.mjs"
tar -czf "$ASSET_DIR/baidu-cloud-one-click-config.tar.gz" \
  -C "$PROJECT_ROOT/skills" baidu-cloud-one-click-config
