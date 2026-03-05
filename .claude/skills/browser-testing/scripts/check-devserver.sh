#!/usr/bin/env bash
# Check if frontend dev server and API backend are running

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_port() {
  local name="$1" port="$2" url="$3"
  local status="DOWN"
  local http_status=""

  if lsof -i :"$port" -sTCP:LISTEN &>/dev/null; then
    status="LISTENING"
    http_status=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 "$url" 2>/dev/null || echo "000")
  fi

  if [[ "$status" == "LISTENING" && "$http_status" != "000" ]]; then
    echo -e "${GREEN}✓${NC} $name (port $port): UP (HTTP $http_status)"
    return 0
  elif [[ "$status" == "LISTENING" ]]; then
    echo -e "${YELLOW}~${NC} $name (port $port): LISTENING but no HTTP response"
    return 1
  else
    echo -e "${RED}✗${NC} $name (port $port): DOWN"
    return 1
  fi
}

echo "=== Raven Dev Server Status ==="
echo ""

frontend_ok=0
backend_ok=0

check_port "Frontend (Next.js)" 3000 "http://localhost:3000" && frontend_ok=1 || true
check_port "API Backend (Fastify)" 3001 "http://localhost:3001/api/health" && backend_ok=1 || true

echo ""

if [[ $frontend_ok -eq 1 && $backend_ok -eq 1 ]]; then
  echo -e "${GREEN}All services running. Ready for browser testing.${NC}"
  exit 0
elif [[ $frontend_ok -eq 1 ]]; then
  echo -e "${YELLOW}Frontend running but API backend is down. Some pages may not load correctly.${NC}"
  exit 1
elif [[ $backend_ok -eq 1 ]]; then
  echo -e "${YELLOW}API backend running but frontend is down. Run: bash .claude/skills/browser-testing/scripts/start-devserver.sh${NC}"
  exit 1
else
  echo -e "${RED}No services running. Start the frontend dev server first.${NC}"
  echo "Run: bash .claude/skills/browser-testing/scripts/start-devserver.sh"
  exit 1
fi
