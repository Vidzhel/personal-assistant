#!/usr/bin/env bash
# Verify that core entry point is compatible with Node's --experimental-strip-types.
# Catches: parameter properties, const enums, namespaces, and other unsupported TS syntax.
set -euo pipefail

echo "Checking strip-types compatibility..."
# RAVEN_PORT=0 avoids colliding with a real dev server already listening on
# the configured port. `timeout` bounds the run: this used to terminate on
# its own because boot died fast without Neo4j — now that boot survives a
# missing Neo4j (see createRaven's resilience), a fully successful boot
# would otherwise run forever and hang this check under `pipefail`. Only
# the first few lines matter here (parse/transform-time syntax errors
# surface immediately), so killing a still-running, successfully-booted
# process after the timeout is expected, not a failure.
if RAVEN_PORT=0 timeout 10 node --experimental-strip-types --input-type=module -e "import './packages/core/src/index.ts'" 2>&1 | head -5 | grep -qi "error\|ERR_"; then
  echo "ERROR: Core entry point is not compatible with --experimental-strip-types"
  echo "Run: node --experimental-strip-types --input-type=module -e \"import './packages/core/src/index.ts'\""
  echo "to see the full error."
  exit 1
fi
echo "strip-types compatibility check passed."
