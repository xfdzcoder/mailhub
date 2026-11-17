#!/bin/sh
set -eu

# Accept the commands used by existing Docker and Compose deployments.
if [ "$#" -eq 3 ] && [ "$1" = npm ] && [ "$2" = run ] && [ "$3" = worker ]; then
  set -- tsx src/worker.ts
elif [ "${1:-}" = npx ] && [ "${2:-}" = prisma ]; then
  shift 2
  set -- /app/node_modules/.bin/prisma "$@"
elif [ "${1:-}" = npx ] && [ "${2:-}" = --no-install ] && [ "${3:-}" = prisma ]; then
  shift 3
  set -- /app/node_modules/.bin/prisma "$@"
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
