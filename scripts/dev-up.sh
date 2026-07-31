#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
RUNTIME_DIR=${AUTO_UX_RUNTIME_DIR:-"$PROJECT_ROOT/.dev-runtime"}
DATABASE_URL=${DATABASE_URL:-"postgresql://control_plane:control_plane@127.0.0.1:5432/control_plane?schema=public"}
DEV_SESSION_SECRET=${DEV_SESSION_SECRET:-"local-development-secret-32-bytes"}
DEV_USER_ID=${DEV_USER_ID:-"U-1"}
DEV_WORKSPACE_ID=${DEV_WORKSPACE_ID:-"W-1"}
PORT=${PORT:-3100}
BASE_URL="http://127.0.0.1:$PORT"
WEB_PID=""
OWNER_FILE="$RUNTIME_DIR/web.owner"
OWNED_WRAPPER="$PROJECT_ROOT/scripts/owned-process.sh"
PROCESS_OWNER="$PROJECT_ROOT/scripts/process-owner.sh"

mkdir -p "$RUNTIME_DIR"

if [ -f "$OWNER_FILE" ]; then
  if "$PROCESS_OWNER" verify "$OWNER_FILE" "$OWNED_WRAPPER"; then
    echo "auto UX is already running. Run pnpm dev:down first." >&2
    exit 1
  else
    OWNER_STATUS=$?
    if [ "$OWNER_STATUS" -eq 2 ]; then
      echo "Refusing startup because existing PID metadata cannot be verified." >&2
      exit 1
    fi
  fi
fi

cleanup() {
  if [ -f "$OWNER_FILE" ]; then
    "$PROCESS_OWNER" stop "$OWNER_FILE" "$OWNED_WRAPPER" ||
      echo "Could not verify and stop the recorded Web process." >&2
  fi
  : > "$RUNTIME_DIR/stopped"
}
trap cleanup EXIT INT TERM

cd "$PROJECT_ROOT"
docker compose up -d postgres

READY=0
ATTEMPT=0
while [ "$ATTEMPT" -lt 30 ]; do
  if docker compose exec -T postgres pg_isready -U control_plane -d control_plane >/dev/null 2>&1; then
    READY=1
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "PostgreSQL did not become ready within 30 seconds." >&2
  exit 1
fi

DATABASE_URL="$DATABASE_URL" pnpm --filter @app/db exec prisma generate --schema prisma/schema.prisma
DATABASE_URL="$DATABASE_URL" pnpm --filter @app/db exec prisma migrate deploy --schema prisma/schema.prisma

rm -f "$RUNTIME_DIR/demo-execution.json" "$RUNTIME_DIR/stopped"
DATABASE_URL="$DATABASE_URL" \
scripts/build-workspaces.sh \
  >"$RUNTIME_DIR/build.log" 2>&1
PROCESS_MARKER=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')
"$OWNED_WRAPPER" "$PROCESS_MARKER" "$OWNER_FILE" env \
  DATABASE_URL="$DATABASE_URL" \
  DEV_SESSION_SECRET="$DEV_SESSION_SECRET" \
  DEV_DEMO_STATE_FILE="$RUNTIME_DIR/demo-execution.json" \
  DEV_USER_ID="$DEV_USER_ID" \
  DEV_WORKSPACE_ID="$DEV_WORKSPACE_ID" \
  pnpm --dir "$PROJECT_ROOT/apps/web" exec next dev --hostname 127.0.0.1 --port "$PORT" \
  >"$RUNTIME_DIR/web.log" 2>&1 &
WEB_PID=$!

ATTEMPT=0
while [ ! -f "$OWNER_FILE" ] && [ "$ATTEMPT" -lt 50 ]; do
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "Web process wrapper exited before recording ownership. See $RUNTIME_DIR/web.log." >&2
    exit 1
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.1
done
if [ ! -f "$OWNER_FILE" ]; then
  echo "Web process wrapper did not record ownership. See $RUNTIME_DIR/web.log." >&2
  exit 1
fi

READY=0
ATTEMPT=0
while [ "$ATTEMPT" -lt 60 ]; do
  if curl --fail --silent "$BASE_URL/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "Web app exited before becoming ready. See $RUNTIME_DIR/web.log." >&2
    exit 1
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "Web app did not become ready within 60 seconds. See $RUNTIME_DIR/web.log." >&2
  exit 1
fi

curl --fail --silent --show-error \
  -H "content-type: application/json" \
  -H "x-dev-user-id: $DEV_USER_ID" \
  -H "x-dev-workspace-id: $DEV_WORKSPACE_ID" \
  -d '{"configVersion":1}' \
  "$BASE_URL/api/executions" > "$RUNTIME_DIR/demo-execution.json"

EXECUTION_ID=$(node -e '
  const fs = require("node:fs");
  const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!payload.execution || typeof payload.execution.id !== "string") process.exit(1);
  process.stdout.write(payload.execution.id);
' "$RUNTIME_DIR/demo-execution.json")

SIMULATOR_USER_ID="$DEV_USER_ID" \
SIMULATOR_WORKSPACE_ID="$DEV_WORKSPACE_ID" \
pnpm agent:simulate --execution "$EXECUTION_ID" --api "$BASE_URL" \
  >"$RUNTIME_DIR/simulator.log" 2>&1

echo "auto UX is ready at $BASE_URL (simulator-only execution $EXECUTION_ID)."
wait "$WEB_PID"
