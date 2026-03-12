#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ART_ROOT="$(cd "${REPO_ROOT}/.." && pwd)/Art"
SOURCE_OF_TRUTH="${REPO_ROOT}/CHECKLIST_REGART_ART_INTEGRATION.md"

echo "=== Stage06 docs gate ==="
CHECKLIST_FILE="${ART_ROOT}/docs/source/checklists/CHECKLIST_06_REGART_ART_BRIDGE.md"
if [[ ! -f "$CHECKLIST_FILE" ]]; then
  echo "✘ can't find $CHECKLIST_FILE"
  exit 1
fi
if [[ ! -f "$SOURCE_OF_TRUTH" ]]; then
  echo "✘ can't find $SOURCE_OF_TRUTH"
  exit 1
fi

if ! rg -q "never_drop_unacked" "$SOURCE_OF_TRUTH"; then
  echo "✘ never_drop_unacked section missing in source-of-truth"
  exit 1
fi
if ! rg -q "drop_oldest_when_full" "$SOURCE_OF_TRUTH"; then
  echo "✘ drop_oldest_when_full section missing in source-of-truth"
  exit 1
fi
if ! rg -q "Actions-only" "$SOURCE_OF_TRUTH"; then
  echo "✘ Actions-only section missing in source-of-truth"
  exit 1
fi
if ! rg -q "HTTPS-only" "$SOURCE_OF_TRUTH"; then
  echo "✘ HTTPS-only section missing in source-of-truth"
  exit 1
fi
if ! rg -q "upstream error" "$SOURCE_OF_TRUTH"; then
  echo "✘ upstream error section missing in source-of-truth"
  exit 1
fi
if ! rg -q "retry_count" "$SOURCE_OF_TRUTH"; then
  echo "✘ retry_count section missing in source-of-truth"
  exit 1
fi
if ! rg -q "Audit immutability" "$SOURCE_OF_TRUTH"; then
  echo "✘ Audit immutability section missing in source-of-truth"
  exit 1
fi

if [[ ! -f "${ART_ROOT}/docs/regart/art_bridge_runbook.md" ]]; then
  echo "✘ missing docs/regart/art_bridge_runbook.md"
  exit 1
fi
if [[ ! -f "${ART_ROOT}/docs/regart/upstream_error_format.md" ]]; then
  echo "✘ missing docs/regart/upstream_error_format.md"
  exit 1
fi

echo "✔ running stage06 integration tests"
cd "${REPO_ROOT}/agent"
.venv/bin/python -m pytest -q \
  tests/integration_tests/test_ui_art_ingest.py::test_never_drop_unacked_rejects_new \
  tests/integration_tests/test_ui_art_ingest.py::test_drop_oldest_when_full_logs_lossy \
  tests/integration_tests/test_ui_proxy_service_actions.py::test_ui_proxy_service_actions \
  tests/integration_tests/test_ui_art_ingest.py::test_art_ingest_tls_smoke_self_signed \
  tests/integration_tests/test_ui_art_ingest.py::test_upstream_error_format_contains_required_fields \
  tests/integration_tests/test_ui_art_ingest.py::test_retry_count_present_and_non_negative \
  tests/integration_tests/test_ui_art_ingest.py::test_audit_immutability_append_only

echo "✔ running stage06 runtime spool replay cycle"
cd "${REPO_ROOT}"
agent/.venv/bin/python scripts/spool_replay_cycle_test.py

echo "=== Stage06 gate PASS ==="
