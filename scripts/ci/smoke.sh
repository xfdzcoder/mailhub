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
"${compose[@]}" up -d --wait postgres redis meilisearch
"${compose[@]}" run --rm migrate
# A second deployment must be a no-op, proving the migration command is repeatable.
"${compose[@]}" run --rm migrate
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
