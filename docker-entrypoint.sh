#!/bin/sh
set -eu

POSTGRES_DATA_DIR=${AUTO_UX_POSTGRES_DATA_DIR:-/data/postgres}
POSTGRES_SOCKET_DIR=${AUTO_UX_POSTGRES_SOCKET_DIR:-/data/postgres-socket}
WEB_PID=""

mkdir -p "$POSTGRES_DATA_DIR" "$POSTGRES_SOCKET_DIR"
chmod 0700 "$POSTGRES_DATA_DIR"
chmod 0750 "$POSTGRES_SOCKET_DIR"

if [ ! -s "$POSTGRES_DATA_DIR/PG_VERSION" ]; then
  initdb \
    --pgdata="$POSTGRES_DATA_DIR" \
    --username=auto_ux \
    --auth-local=trust \
    --auth-host=trust \
    --encoding=UTF8 \
    --no-locale
fi

pg_ctl \
  --pgdata="$POSTGRES_DATA_DIR" \
  --options="-c listen_addresses=127.0.0.1 -c port=5432 -c unix_socket_directories=$POSTGRES_SOCKET_DIR" \
  --wait start

shutdown() {
  trap - TERM INT
  if [ -n "$WEB_PID" ] && kill -0 "$WEB_PID" 2>/dev/null; then
    kill -TERM "$WEB_PID"
    wait "$WEB_PID" || true
  fi
  pg_ctl --pgdata="$POSTGRES_DATA_DIR" --wait --mode=fast stop || true
}
trap shutdown TERM INT

if ! psql --host=127.0.0.1 --username=auto_ux --dbname=postgres --tuples-only --no-align \
  --command="SELECT 1 FROM pg_database WHERE datname = 'auto_ux'" | grep -qx 1; then
  createdb --host=127.0.0.1 --username=auto_ux auto_ux
fi

pnpm --filter @app/db exec prisma migrate deploy --schema prisma/schema.prisma

pnpm --filter @app/web start &
WEB_PID=$!
set +e
wait "$WEB_PID"
STATUS=$?
set -e
WEB_PID=""
pg_ctl --pgdata="$POSTGRES_DATA_DIR" --wait --mode=fast stop || true
exit "$STATUS"
