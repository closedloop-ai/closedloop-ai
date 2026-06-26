#!/usr/bin/env bash
# FEA-1437 Phase 6 — UI Numbers Audit coverage gate.
#
# Regenerates the tile scan + coverage classification, then enforces:
#   1. Every scanner detection is classified (no needs_review) — via the
#      coverage-validator node:test suite.
#   2. Every harness parser has a *-parser.contract.test.mjs.
# Prints the coverage by_status summary. Exits non-zero on any failure.
#
# Runnable locally (`pnpm -C apps/desktop audit:coverage`) and from CI
# (.github/workflows/audit-gate.yml). Does NOT build the agent-monitor sidecar
# or run Playwright — that is the separate DOM-audit job. This gate is the fast,
# static manifest-coverage check.
set -euo pipefail

# Resolve the desktop app dir from this script's location (scripts/ -> ..).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INVENTORY="$APP_DIR/test-e2e/agent-monitor/inventory"
SPEC_DIR="$APP_DIR/test-e2e/agent-monitor/specs/audit"

cd "$APP_DIR"

echo "==> Regenerating tile scan + coverage classification"
node "$INVENTORY/scan-tiles.mjs"
node "$INVENTORY/coverage-classifier.mjs"

echo "==> Checking every harness parser has a contract test"
missing_contract=0
for parser in scripts/agent-monitor-*/*-parser.js; do
  [ -e "$parser" ] || continue
  base="$(basename "$parser" .js)"        # e.g. codex-parser
  contract="$SPEC_DIR/${base}.contract.test.mjs"
  if [ ! -f "$contract" ]; then
    echo "  MISSING: $parser has no ${base}.contract.test.mjs" >&2
    missing_contract=1
  else
    echo "  ok: $base -> ${base}.contract.test.mjs"
  fi
done
if [ "$missing_contract" -ne 0 ]; then
  echo "FAIL: a harness parser is missing its contract test." >&2
  exit 1
fi

echo "==> Running coverage validator (every detection must be classified)"
node --test "$SPEC_DIR/coverage-validator.test.mjs"

echo "==> Coverage summary"
node -e '
const c = require(process.argv[1]);
const s = c.by_status;
console.log("  total detections:", c.total_detections);
for (const k of Object.keys(s)) console.log(`  ${k}: ${s[k]}`);
' "$INVENTORY/coverage.json"

echo "==> Audit coverage gate passed."
