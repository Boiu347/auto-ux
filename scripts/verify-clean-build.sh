#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/auto-ux-clean-build.XXXXXX")

case "$TEMP_ROOT" in
  /tmp/auto-ux-clean-build.*|/private/tmp/auto-ux-clean-build.*|/var/folders/*/auto-ux-clean-build.*|/private/var/folders/*/auto-ux-clean-build.*) ;;
  *)
    echo "Refusing unexpected temporary path: $TEMP_ROOT" >&2
    exit 1
    ;;
esac

cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT INT TERM

rsync -a \
  --exclude '.git' \
  --exclude '.worktrees' \
  --exclude '.superpowers' \
  --exclude '.dev-runtime' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude 'dist' \
  --exclude 'test-results' \
  --exclude 'playwright-report' \
  "$PROJECT_ROOT/" "$TEMP_ROOT/"

cd "$TEMP_ROOT"
mkdir "$TEMP_ROOT/node_modules"
rsync -a --link-dest="$PROJECT_ROOT/node_modules" \
  "$PROJECT_ROOT/node_modules/" "$TEMP_ROOT/node_modules/"
for WORKSPACE in \
  apps/web \
  apps/agent-simulator \
  packages/contracts \
  packages/execution-core \
  packages/db; do
  cp -a "$PROJECT_ROOT/$WORKSPACE/node_modules" "$TEMP_ROOT/$WORKSPACE/node_modules"
done

# A Railway build starts without a generated Prisma Client. Remove the local
# generated artifact from this fixture so the production build must create it.
find "$TEMP_ROOT/node_modules/.pnpm" \
  -path '*/node_modules/.prisma/client' \
  -type d \
  -exec rm -rf {} +

if [ -e packages/contracts/dist ] || [ -e packages/execution-core/dist ]; then
  echo "clean build fixture unexpectedly contains dist artifacts" >&2
  exit 1
fi
scripts/build-workspaces.sh
