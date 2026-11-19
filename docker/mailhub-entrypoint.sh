#!/bin/sh
set -eu

# Attachments and runtime caches must not become world-readable.
umask 077
for directory in /app/.storage "$XDG_CACHE_HOME" "$HOME"; do
  if [ ! -d "$directory" ] || [ ! -w "$directory" ] || [ ! -x "$directory" ]; then
    echo "MailHub: $directory must be writable by UID/GID $(id -u):$(id -g). See docs/container-permissions.md." >&2
    exit 1
  fi
done

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
