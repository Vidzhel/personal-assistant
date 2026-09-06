#!/usr/bin/env bash
# Install Raven's read-only Google Calendar capability without sourcing .env or logging credentials.
set -euo pipefail
set +x

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${RAVEN_ENV_FILE:-$repo_root/.env}"
if [[ "$env_file" != /* ]]; then env_file="$PWD/$env_file"; fi

usage() {
  echo 'Usage: ./scripts/setup-google-calendar.sh'
}

if (( $# != 0 )); then
  usage >&2
  exit 2
fi
if [[ -n "${COMPOSE_FILE:-}" ]]; then
  echo 'Unset the exported COMPOSE_FILE environment variable before configuring Google Calendar.' >&2
  exit 1
fi
if [[ ! -f "$env_file" || -L "$env_file" ]]; then
  echo "Missing regular environment file: $env_file. Copy .env.example and configure it first." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker with Compose v2 is required.' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22 or newer is required to inspect Google Calendar settings.' >&2
  exit 1
fi

cd -- "$repo_root"
compose() {
  docker compose --env-file "$env_file" "$@"
}

compose config --quiet
running_services="$(compose ps --status running --services)"
if [[ -n "$running_services" ]]; then
  echo 'Stop Raven before configuring Google Calendar: ./scripts/raven.sh stop' >&2
  exit 1
fi

cleanup_path=''
cleanup() {
  if [[ -n "$cleanup_path" ]]; then rm -f -- "$cleanup_path"; fi
}
trap cleanup EXIT HUP INT TERM

configured_path="$({
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { dirname, isAbsolute, resolve } from "node:path";
    import dotenv from "dotenv";
    const envFile = process.argv[1];
    const settings = dotenv.parse(readFileSync(envFile));
    const value = (settings.GOOGLE_CALENDAR_CREDENTIALS_FILE || settings.GWS_PRIMARY_CREDENTIALS_FILE)?.trim();
    if (value) process.stdout.write(isAbsolute(value) ? value : resolve(dirname(envFile), value));
  ' "$env_file"
} 2>/dev/null || true)"
if [[ ! -f "$configured_path" || -L "$configured_path" ]]; then configured_path=''; fi

if [[ -n "$configured_path" ]]; then
  printf 'Exported credentials JSON path (Enter uses .env; type login to reconnect): '
else
  printf 'Exported credentials JSON path (Enter runs a read-only host gws login): '
fi
if ! IFS= read -r credentials_path; then
  echo 'Could not read the credentials selection.' >&2
  exit 1
fi

if [[ "$credentials_path" == login ]]; then
  credentials_path=''
  configured_path=''
fi
if [[ -z "$credentials_path" && -n "$configured_path" ]]; then
  credentials_path="$configured_path"
elif [[ -z "$credentials_path" ]]; then
  if ! command -v gws >/dev/null 2>&1; then
    echo 'The Google Workspace CLI (gws) is required on the host for login.' >&2
    echo 'Install gws and configure a desktop OAuth client, or rerun with an exported credentials JSON path.' >&2
    exit 1
  fi
  cleanup_path="$(mktemp "${TMPDIR:-/tmp}/raven-google-calendar.XXXXXX")"
  chmod 600 "$cleanup_path"
  echo 'Complete the Google Calendar read-only consent flow in your browser.'
  gws auth login --scopes \
    https://www.googleapis.com/auth/calendar.calendarlist.readonly,https://www.googleapis.com/auth/calendar.events.readonly
  if ! gws auth export --unmasked > "$cleanup_path"; then
    echo 'gws could not export Google Calendar credentials.' >&2
    exit 1
  fi
  credentials_path="$cleanup_path"
elif [[ "$credentials_path" != /* ]]; then
  credentials_path="$PWD/$credentials_path"
fi

if [[ ! -f "$credentials_path" || -L "$credentials_path" ]]; then
  echo 'The credentials input must be a regular JSON file.' >&2
  exit 1
fi

compose build raven-core
compose run --rm --no-deps -T raven-core node deployment/install-google-calendar.mjs \
  --bind-default < "$credentials_path"
echo 'The read-only Google Calendar capability is installed. Start Raven when ready.'
echo 'After startup, ask Planning to list calendars and verify one known work meeting.'
