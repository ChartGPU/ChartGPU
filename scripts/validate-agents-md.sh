#!/usr/bin/env bash
# Validates that AGENTS.md stays consistent with the actual codebase.
# Checks:
#   1. npm/bun script references in AGENTS.md exist in package.json
#   2. Directory paths referenced in "Key Directories" exist on disk
#   3. Acceptance test files referenced exist in examples/acceptance/
# Exits non-zero if any inconsistency is found.

set -euo pipefail

AGENTS_FILE="AGENTS.md"
PACKAGE_JSON="package.json"
ERRORS=()

# ---------------------------------------------------------------------------
# 1. Validate "bun run <script>" commands exist in package.json
# ---------------------------------------------------------------------------
echo "==> Checking npm/bun script references..."

# Extract every "bun run <name>" or "npm run <name>" token from AGENTS.md
SCRIPT_REFS=$(grep -oE "(bun|npm) run [a-zA-Z0-9:_-]+" "$AGENTS_FILE" | awk '{print $3}' | sort -u)

for script in $SCRIPT_REFS; do
  if ! node -e "
    const pkg = JSON.parse(require('fs').readFileSync('$PACKAGE_JSON', 'utf8'));
    process.exit(pkg.scripts && pkg.scripts['$script'] ? 0 : 1);
  " 2>/dev/null; then
    ERRORS+=("Script '$script' is referenced in AGENTS.md but not found in package.json scripts.")
  fi
done

# ---------------------------------------------------------------------------
# 2. Validate directory paths in "Key Directories" section
# ---------------------------------------------------------------------------
echo "==> Checking directory path references..."

# Lines like:  - `src/foo/` - description
DIR_REFS=$(grep -oE '`[a-zA-Z0-9_./-]+/`' "$AGENTS_FILE" | tr -d '`' | sort -u)

for dir in $DIR_REFS; do
  # Strip trailing slash for the test
  clean_dir="${dir%/}"
  if [ ! -e "$clean_dir" ]; then
    ERRORS+=("Directory/path '$dir' is referenced in AGENTS.md but does not exist on disk.")
  fi
done

# ---------------------------------------------------------------------------
# 3. Validate acceptance test filenames referenced in AGENTS.md exist
# ---------------------------------------------------------------------------
echo "==> Checking acceptance test file references..."

# Lines like:  tsx examples/acceptance/foo.ts
ACC_REFS=$(grep -oE 'examples/acceptance/[a-zA-Z0-9_-]+\.ts' "$AGENTS_FILE" | sort -u)

for acc_file in $ACC_REFS; do
  if [ ! -f "$acc_file" ]; then
    ERRORS+=("Acceptance test '$acc_file' is referenced in AGENTS.md but does not exist.")
  fi
done

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "AGENTS.md validation FAILED — ${#ERRORS[@]} inconsistency(ies) found:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  echo ""
  echo "Please update AGENTS.md to reflect the current state of the codebase."
  exit 1
else
  echo ""
  echo "AGENTS.md validation passed."
fi
