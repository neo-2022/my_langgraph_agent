#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "=== Stage05 docs gate ==="
echo "✔ ensure LISTENER test exists"
CHECKLIST_PATH="${REPO_ROOT}/CHECKLIST_UI_GRAPH_RUN_DEBUGGER.md"
if [[ ! -f "$CHECKLIST_PATH" ]]; then
  echo "✘ can't find $CHECKLIST_PATH"
  exit 1
fi

rg -n "subscribe\\(listener\\)" "$CHECKLIST_PATH" >/dev/null || {
  echo "✘ subscribe(listener) text missing in $CHECKLIST_PATH"
  exit 1
}

echo "✔ running debugger_core.spec.js suite"
cd "${REPO_ROOT}/ui"
npm test -- debugger_core.spec.js

echo "=== Stage05 gate PASS ==="
