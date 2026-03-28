#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

echo "=== Updating vendor submodules ==="
git submodule update --remote --merge

echo ""
echo "=== Building markdownify-mcp ==="
cd "$PROJECT_ROOT/library/vendor/markdownify-mcp"
npm install
npm run build

cd "$PROJECT_ROOT"

echo ""
echo "=== Vendor status ==="
git submodule status

echo ""
echo "Done. Review changes with 'git diff' and commit if satisfied."
