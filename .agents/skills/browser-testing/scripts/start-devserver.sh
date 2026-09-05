#!/usr/bin/env bash
# Start frontend dev server in background and wait for it to be ready

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
LOG_FILE="/tmp/raven-web-dev.log"
PORT=4000
TIMEOUT=30

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check if already running
if lsof -i :"$PORT" -sTCP:LISTEN &>/dev/null; then
  echo -e "${GREEN}Frontend dev server already running on port $PORT${NC}"
  exit 0
fi

# Verify project root exists
if [[ ! -f "$PROJECT_ROOT/package.json" ]]; then
  echo -e "${RED}Project root not found: $PROJECT_ROOT${NC}"
  exit 1
fi

# Check npm is available
if ! command -v npm &>/dev/null; then
  echo -e "${RED}npm not found. Install it first.${NC}"
  exit 1
fi

echo "Starting frontend dev server..."
echo "  Directory: $PROJECT_ROOT"
echo "  Log file:  $LOG_FILE"

# Start in background
nohup npm run dev:web --prefix "$PROJECT_ROOT" > "$LOG_FILE" 2>&1 &
DEV_PID=$!

echo "  PID: $DEV_PID"
echo ""

# Wait for port to be ready
elapsed=0
while [[ $elapsed -lt $TIMEOUT ]]; do
  if lsof -i :"$PORT" -sTCP:LISTEN &>/dev/null; then
    echo -e "${GREEN}✓ Frontend dev server is ready on http://localhost:$PORT${NC}"
    echo "  Logs: tail -f $LOG_FILE"
    exit 0
  fi

  # Check if process died
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo -e "${RED}✗ Dev server process died. Check logs:${NC}"
    tail -20 "$LOG_FILE"
    exit 1
  fi

  sleep 1
  elapsed=$((elapsed + 1))
  printf "\r  Waiting for port $PORT... (%ds/%ds)" "$elapsed" "$TIMEOUT"
done

echo ""
echo -e "${YELLOW}⚠ Timeout after ${TIMEOUT}s. Server may still be starting.${NC}"
echo "  Check: lsof -i :$PORT"
echo "  Logs:  tail -f $LOG_FILE"
exit 1
