#!/bin/sh
# Container entrypoint (Dockerfile runtime stage): apply the Prisma migrations
# in web/prisma/migrations to DATABASE_URL, then exec the Next standalone
# server (the CMD) so node is PID 1 and receives the stop signal.
#
# `prisma migrate deploy` is idempotent: it applies only migrations not yet
# recorded in _prisma_migrations, so the image starts against an empty
# database and against one already at the current schema alike. It never
# creates, resets or diffs a schema, which is what makes it safe in a start
# path. A failed migration stops the container before the server starts.
set -eu

: "${DATABASE_URL:?DATABASE_URL is required (postgresql://user:password@host:5432/db); see deploy/docker-compose.prod.yml}"

APP_DIR=${APP_DIR:-/app}
PRISMA_CLI="$APP_DIR/prisma-cli/node_modules/prisma/build/index.js"
SCHEMA="$APP_DIR/web/prisma/schema.prisma"

[ -f "$PRISMA_CLI" ] || { echo "entrypoint: prisma CLI missing at $PRISMA_CLI" >&2; exit 1; }
[ -f "$SCHEMA" ] || { echo "entrypoint: prisma schema missing at $SCHEMA" >&2; exit 1; }

echo "entrypoint: applying database migrations"
node "$PRISMA_CLI" migrate deploy --schema "$SCHEMA"

echo "entrypoint: starting $*"
exec "$@"
