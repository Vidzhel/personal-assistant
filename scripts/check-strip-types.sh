#!/usr/bin/env bash
# Verify that core entry point is compatible with Node's --experimental-strip-types.
# Catches: parameter properties, const enums, namespaces, and other unsupported TS syntax.
set -euo pipefail

echo "Checking strip-types compatibility..."
if node --experimental-strip-types --input-type=module -e "import './packages/core/src/index.ts'" 2>&1 | head -5 | grep -qi "error\|ERR_"; then
  echo "ERROR: Core entry point is not compatible with --experimental-strip-types"
  echo "Run: node --experimental-strip-types --input-type=module -e \"import './packages/core/src/index.ts'\""
  echo "to see the full error."
  exit 1
fi
echo "strip-types compatibility check passed."
