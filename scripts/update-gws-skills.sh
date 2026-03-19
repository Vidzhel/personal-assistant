#!/usr/bin/env bash
# Downloads gws CLI skill reference docs from GitHub for agent prompt context.
# Usage: bash scripts/update-gws-skills.sh

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/googleworkspace/cli/main"
INDEX_URL="${REPO_RAW}/docs/skills-index.md"
OUT_DIR="suites/google-workspace/skills-reference"

echo "=== Updating gws skill reference docs ==="

# Create output directories
mkdir -p "${OUT_DIR}/services" "${OUT_DIR}/helpers" "${OUT_DIR}/recipes"

# Fetch skills index
echo "Fetching skills index..."
INDEX=$(curl -sSfL "${INDEX_URL}" 2>/dev/null) || {
  echo "ERROR: Failed to fetch skills index from ${INDEX_URL}"
  echo "The gws CLI repo may have moved or the index format changed."
  exit 1
}

# Parse skill names from markdown table links: [gws-*](../skills/gws-*/SKILL.md)
SKILLS=$(echo "${INDEX}" | grep -oP '\[([a-z0-9-]+)\]\(\.\./skills/\1/SKILL\.md\)' | grep -oP '(?<=\[)[a-z0-9-]+(?=\])' || true)

if [ -z "${SKILLS}" ]; then
  echo "WARNING: No skills found in index. Format may have changed."
  echo "Index content preview:"
  echo "${INDEX}" | head -20
  exit 1
fi

DOWNLOADED=0
SKIPPED=0
FAILED=0

for SKILL in ${SKILLS}; do
  # Skip persona skills
  if [[ "${SKILL}" == persona-* ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Categorize
  if [[ "${SKILL}" == recipe-* ]]; then
    SUBDIR="recipes"
  elif [[ "${SKILL}" =~ ^gws-[a-z]+-[a-z] ]]; then
    SUBDIR="helpers"
  else
    SUBDIR="services"
  fi

  URL="${REPO_RAW}/skills/${SKILL}/SKILL.md"
  DEST="${OUT_DIR}/${SUBDIR}/${SKILL}.md"

  if curl -sSfL -o "${DEST}" "${URL}" 2>/dev/null; then
    DOWNLOADED=$((DOWNLOADED + 1))
  else
    echo "  WARN: Failed to download ${SKILL}"
    FAILED=$((FAILED + 1))
    rm -f "${DEST}"
  fi
done

# Update gws CLI if available
if command -v gws &>/dev/null; then
  echo ""
  echo "Updating gws CLI..."
  npm update -g @googleworkspace/cli 2>/dev/null || echo "  WARN: Failed to update gws CLI"
fi

echo ""
echo "=== Summary ==="
echo "  Downloaded: ${DOWNLOADED}"
echo "  Skipped (personas): ${SKIPPED}"
echo "  Failed: ${FAILED}"
echo "  Output: ${OUT_DIR}/"
