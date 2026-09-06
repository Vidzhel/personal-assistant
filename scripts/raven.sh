#!/usr/bin/env bash
# Local Docker launcher. Compose parses .env; never execute it as shell code.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${RAVEN_ENV_FILE:-$repo_root/.env}"
if [[ "$env_file" != /* ]]; then env_file="$PWD/$env_file"; fi
action="${1:-start}"
if (( $# > 0 )); then shift; fi

usage() {
  echo 'Usage: ./scripts/raven.sh [start|login|status|logs|stop]'
  echo 'Reads .env (or RAVEN_ENV_FILE). Start builds, checks Claude login and starts services.'
}

case "$action" in
  help|-h|--help) usage; exit 0 ;;
  start|login|status|logs|stop) ;;
  *) usage >&2; exit 2 ;;
esac
if (( $# > 0 )); then usage >&2; exit 2; fi
if [[ ! -f "$env_file" ]]; then
  echo "Missing environment file: $env_file. Copy .env.example and configure it first." >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker with Compose v2 is required.' >&2
  exit 1
fi
cd -- "$repo_root"

compose() {
  docker compose --env-file "$env_file" "$@"
}

claude_auth() {
  local flags=()
  if [[ "$1" == status ]]; then flags=(-T); fi
  compose run --rm --no-deps "${flags[@]}" raven-core sh -c \
    'exec /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-$(node -p process.arch)/claude auth "$@"' \
    raven-claude "$@"
}

start() {
  local services
  services="$(compose config --services)"
  compose build raven-core raven-web
  if ! claude_auth status --json >/dev/null 2>&1; then
    echo 'Claude authentication is needed. Complete the displayed login flow.'
    claude_auth login
  fi
  if [[ $'\n'"$services"$'\n' == *$'\nneo4j\n'* ]]; then
    compose up -d --wait neo4j
  fi
  compose up -d --wait raven-core raven-web
  compose ps
  echo 'Raven is ready at http://localhost:4000 (on this machine).'
}

compose config --quiet
case "$action" in
  start) start ;;
  login) compose build raven-core; claude_auth login ;;
  status) compose ps ;;
  logs) compose logs -f --tail=100 raven-core raven-web ;;
  stop) compose stop ;;
esac
