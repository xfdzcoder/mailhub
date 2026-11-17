#!/bin/sh
set -eu

# Accept the commands used by existing Docker and Compose deployments.
if [ "$#" -eq 3 ] && [ "$1" = npm ] && [ "$2" = run ] && [ "$3" = worker ]; then
  set -- tsx src/worker.ts
elif [ "${1:-}" = npx ]; then
  shift
  if [ "${1:-}" = --no-install ]; then shift; fi
  if [ "${1:-}" = prisma ]; then
    shift
    set -- /app/node_modules/.bin/prisma "$@"
  fi
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
