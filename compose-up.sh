#!/usr/bin/env bash
set -euo pipefail

max_attempts=${MAX_ATTEMPTS:-5}
sleep_seconds=${RETRY_SLEEP_SECONDS:-2}

attempt=1
while true; do
  if docker-compose up -d; then
    exit 0
  fi

  if [[ $attempt -ge $max_attempts ]]; then
    echo "compose-up.sh: failed after ${max_attempts} attempts" >&2
    exit 1
  fi

  echo "compose-up.sh: docker-compose up failed (attempt ${attempt}/${max_attempts}); retrying in ${sleep_seconds}s..." >&2
  sleep "$sleep_seconds"
  attempt=$((attempt + 1))
done
