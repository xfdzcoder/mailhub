#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
# A unique project prevents interference with developer stacks or other CI runs.
project="mailhub-ci-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
compose=(docker compose -p "$project" -f scripts/ci/compose.yml)
cleanup() {
  result=$?
  if (( result != 0 )); then "${compose[@]}" logs --no-color; fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null
  exit "$result"
}
trap cleanup EXIT
# Inspect installed packages in the actual images, including the worker runtime.
for target in runtime migrate; do
  image=${RUNTIME_IMAGE:-mailhub-smoke:runtime}
  if [[ $target == migrate ]]; then image=${MIGRATION_IMAGE:-mailhub-smoke:migrate}; fi
  docker run --rm -e INVENTORY_TARGET="$target" --entrypoint node "$image" -e '
    const fs = require("node:fs");
    console.log(process.env.INVENTORY_TARGET, "Node", process.versions.node);
    if (Number(process.versions.node.split(".")[0]) !== 24) process.exitCode = 1;
    const npmVersion = require("/usr/local/lib/node_modules/npm/package.json").version;
    console.log(process.env.INVENTORY_TARGET, "global npm", npmVersion);
    if (npmVersion !== "11.21.2") process.exitCode = 1;
    const generatedVersion = require("@prisma/client").Prisma.prismaVersion.client;
    console.log(process.env.INVENTORY_TARGET, "generated client", generatedVersion);
    if (generatedVersion !== "7.10.1") process.exitCode = 1;
    const names = ["@prisma/client", "@prisma/adapter-pg", "@prisma/driver-adapter-utils", "pg", "prisma", "@prisma/config", "@prisma/dev", "@prisma/engines", "@prisma/studio-core"];
    for (const name of names) {
      const path = "node_modules/" + name + "/package.json";
      const version = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)).version : null;
      console.log(process.env.INVENTORY_TARGET, name, version ?? "absent");
      if (name === "pg" && version === null) process.exitCode = 1;
      if (["@prisma/client", "@prisma/adapter-pg", "@prisma/driver-adapter-utils"].includes(name) && version !== "7.10.1") process.exitCode = 1;
      if (["prisma", "@prisma/config", "@prisma/dev", "@prisma/engines", "@prisma/studio-core"].includes(name) && (process.env.INVENTORY_TARGET === "runtime" ? version !== null : version === null)) process.exitCode = 1;
    }
  '
done
"${compose[@]}" up -d --wait postgres redis meilisearch
"${compose[@]}" run --rm migrate
# A second deployment must be a no-op, proving the migration command is repeatable.
"${compose[@]}" run --rm migrate
# Upgrade an existing initial schema in a separate disposable database. Resolve
# only the migration whose SQL was actually applied, then deploy the remainder.
"${compose[@]}" exec -T postgres createdb -U mailhub mailhub_upgrade
"${compose[@]}" exec -T postgres psql -U mailhub -d mailhub_upgrade -v ON_ERROR_STOP=1 \
  < prisma/migrations/20260622005505_init/migration.sql
"${compose[@]}" exec -T postgres psql -U mailhub -d mailhub_upgrade -v ON_ERROR_STOP=1 -c \
  "INSERT INTO users (id,email,name,password_hash,updated_at) VALUES ('00000000-0000-4000-8000-000000000017','fixture@example.invalid','Upgrade fixture','fixture-hash',CURRENT_TIMESTAMP);"
upgrade_url=postgresql://mailhub:ci-only-password@postgres:5432/mailhub_upgrade
"${compose[@]}" run --rm -e DATABASE_URL="$upgrade_url" migrate \
  npx --no-install prisma migrate resolve --applied 20260622005505_init
"${compose[@]}" run --rm -e DATABASE_URL="$upgrade_url" migrate
"${compose[@]}" run --rm -e DATABASE_URL="$upgrade_url" migrate
"${compose[@]}" exec -T postgres psql -U mailhub -d mailhub_upgrade -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM users) <> 1 OR NOT EXISTS (
    SELECT 1 FROM users WHERE id = '00000000-0000-4000-8000-000000000017'
      AND email = 'fixture@example.invalid' AND name = 'Upgrade fixture'
      AND password_hash = 'fixture-hash'
  ) THEN RAISE EXCEPTION 'Existing user data changed during upgrade'; END IF;
  IF to_regclass('auth_sessions') IS NULL THEN
    RAISE EXCEPTION 'Upgrade did not reach the current schema';
  END IF;
END $$;
SQL
# Startup smoke does not require an embedding server. Disable AI in this disposable DB.
"${compose[@]}" exec -T postgres psql -U mailhub -d mailhub -v ON_ERROR_STOP=1 -c \
  "INSERT INTO system_preferences (id,is_ai_enabled,semantic_search_enabled) VALUES ('global',false,false) ON CONFLICT (id) DO UPDATE SET is_ai_enabled=false,semantic_search_enabled=false;"
"${compose[@]}" up -d web worker
for attempt in {1..60}; do
  if "${compose[@]}" exec -T web node -e \
    'fetch("http://127.0.0.1:3000/api/version").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))' >/dev/null 2>&1 \
    && [[ $("${compose[@]}" exec -T redis redis-cli EXISTS worker:default:heartbeat) == 1 ]]; then
    echo 'PASS: migrations, Web HTTP endpoint, and Worker Redis heartbeat'
    exit 0
  fi
  sleep 2
done
echo 'Timed out waiting for Web and Worker' >&2
exit 1
