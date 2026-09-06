#!/usr/bin/env bash
# Local Docker launcher. Compose parses .env; never execute it as shell code.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${RAVEN_ENV_FILE:-$repo_root/.env}"
if [[ "$env_file" != /* ]]; then env_file="$PWD/$env_file"; fi
action="${1:-start}"
if (( $# > 0 )); then shift; fi

usage() {
  echo 'Usage: ./scripts/raven.sh [start|login|setup-private-access|setup-ticktick|status|logs|stop]'
  echo 'Reads .env (or RAVEN_ENV_FILE). Start builds, checks Claude login and starts services.'
}

case "$action" in
  help|-h|--help) usage; exit 0 ;;
  start|login|setup-private-access|setup-ticktick|status|logs|stop) ;;
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

has_service() {
  local services="$1"
  local name="$2"
  [[ $'\n'"$services"$'\n' == *$'\n'"$name"$'\n'* ]]
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
  local raven_services=(raven-core raven-web)
  services="$(compose config --services)"
  compose build raven-core raven-web
  if ! claude_auth status --json >/dev/null 2>&1; then
    echo 'Claude authentication is needed. Complete the displayed login flow.'
    claude_auth login
  fi
  if has_service "$services" neo4j; then
    compose up -d --wait neo4j
  fi
  if has_service "$services" raven-gateway; then
    raven_services+=(raven-gateway)
  fi
  compose up -d --wait "${raven_services[@]}"
  compose ps
  if has_service "$services" raven-gateway; then
    echo 'Raven is ready through the configured private HTTPS address.'
    echo 'The authenticated private gateway is listening at http://127.0.0.1:4002 for Tailscale Serve.'
  else
    echo 'Raven is ready at http://localhost:4000 (on this machine).'
  fi
}

setup_private_access() {
  local private_origin username password confirmation password_hash
  set +x
  if [[ -n "${COMPOSE_FILE:-}" ]]; then
    echo 'Unset the exported COMPOSE_FILE environment variable before configuring private access.' >&2
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo 'Node.js 22 or newer is required to update private access settings.' >&2
    return 1
  fi
  printf 'Private HTTPS origin (for example https://raven-host.tailnet.ts.net): '
  if ! IFS= read -r private_origin; then
    echo 'Could not read the private HTTPS origin.' >&2
    return 1
  fi
  if [[ "$private_origin" != https://* ]]; then
    echo 'Private origin must start with https://.' >&2
    return 1
  fi
  printf 'Raven owner username: '
  if ! IFS= read -r username; then
    echo 'Could not read the owner username.' >&2
    return 1
  fi
  if [[ ! "$username" =~ ^[A-Za-z0-9._~-]{1,64}$ ]]; then
    echo 'Owner username must be 1-64 letters, numbers, dots, underscores, tildes or hyphens.' >&2
    return 1
  fi
  printf 'Raven owner password (12-256 characters): '
  if ! IFS= read -r -s password; then
    echo >&2
    echo 'Could not read the owner password.' >&2
    return 1
  fi
  echo
  printf 'Confirm Raven owner password: '
  if ! IFS= read -r -s confirmation; then
    unset password
    echo >&2
    echo 'Could not read the password confirmation.' >&2
    return 1
  fi
  echo
  if [[ "$password" != "$confirmation" ]]; then
    unset password confirmation
    echo 'Passwords do not match; the environment file was not changed.' >&2
    return 1
  fi
  if (( ${#password} < 12 || ${#password} > 256 )); then
    unset password confirmation
    echo 'Password must contain 12-256 characters; the environment file was not changed.' >&2
    return 1
  fi
  unset confirmation
  if ! password_hash="$(printf '%s\n' "$password" | docker run --rm -i --network none caddy:2.11.4-alpine caddy hash-password)"; then
    unset password
    echo 'Caddy could not hash the password; the environment file was not changed.' >&2
    return 1
  fi
  unset password
  RAVEN_BASE_URL_INPUT="$private_origin" \
    RAVEN_PRIVATE_USERNAME_INPUT="$username" \
    RAVEN_PRIVATE_PASSWORD_HASH_INPUT="$password_hash" \
    node "$repo_root/scripts/private-access-settings.mjs" "$env_file"
  unset password_hash
  echo "Private access settings were written to $env_file."
  echo 'Tailscale account login, ACLs and Serve enrollment remain explicit operator steps.'
}

setup_ticktick() {
  local running_services token confirmation
  set +x
  if [[ -n "${TICKTICK_MCP_TOKEN:-}" ]]; then
    echo 'Unset the exported TICKTICK_MCP_TOKEN environment variable before configuring TickTick.' >&2
    return 1
  fi
  if [[ -n "${COMPOSE_FILE:-}" ]]; then
    echo 'Unset the exported COMPOSE_FILE environment variable before configuring TickTick.' >&2
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo 'Node.js 22 or newer is required to update TickTick settings.' >&2
    return 1
  fi
  running_services="$(compose ps --status running --services)"
  if [[ -n "$running_services" ]]; then
    echo 'Stop Raven before installing the TickTick capability: ./scripts/raven.sh stop' >&2
    return 1
  fi
  compose build raven-core
  compose run --rm --no-deps --entrypoint node raven-core deployment/install-ticktick.mjs --check

  printf 'Dedicated TickTick MCP token: '
  if ! IFS= read -r -s token; then
    echo >&2
    echo 'Could not read the TickTick MCP token.' >&2
    return 1
  fi
  echo
  printf 'Confirm TickTick MCP token: '
  if ! IFS= read -r -s confirmation; then
    unset token
    echo >&2
    echo 'Could not read the TickTick MCP token confirmation.' >&2
    return 1
  fi
  echo
  if [[ "$token" != "$confirmation" ]]; then
    unset token confirmation
    echo 'TickTick MCP tokens do not match; the environment file was not changed.' >&2
    return 1
  fi
  unset confirmation
  if (( ${#token} < 1 || ${#token} > 4096 )); then
    unset token
    echo 'TickTick MCP token must contain 1-4096 characters.' >&2
    return 1
  fi
  if ! printf '%s' "$token" | node "$repo_root/scripts/ticktick-settings.mjs" "$env_file"; then
    unset token
    return 1
  fi
  unset token
  compose run --rm --no-deps raven-core node deployment/install-ticktick.mjs
  echo 'Official TickTick capability and token are configured. Start Raven when ready.'
}

if [[ "$action" == setup-private-access ]]; then
  setup_private_access
  exit 0
fi

if [[ "$action" == setup-ticktick ]]; then
  setup_ticktick
  exit 0
fi

compose config --quiet
case "$action" in
  start) start ;;
  login) compose build raven-core; claude_auth login ;;
  status) compose ps ;;
  logs)
    services="$(compose config --services)"
    log_services=(raven-core raven-web)
    if has_service "$services" raven-gateway; then log_services+=(raven-gateway); fi
    compose logs -f --tail=100 "${log_services[@]}"
    ;;
  stop) compose stop ;;
esac
