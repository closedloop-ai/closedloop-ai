/**
 * @file activity-coverage-axis-labels.test.ts
 * @description ISS-6758 — the Diagnostics → Coverage axis labels reconciled with
 * the metric module's own axis set.
 *
 * The label map lives in the shared IPC contract because the renderer must not
 * import `main/telemetry/attribution-metrics.ts` (that would pull the cost-math
 * runtime into the browser bundle), so it is a hand-written copy of
 * `COHORT_AXIS_VALUES` that TypeScript cannot reconcile: the wire field is
 * `axis: string`, and the tab falls back to rendering the raw key. That fallback
 * is right for version skew and wrong as the only guard — a fifth axis added to
 * the module would ship a raw column name as a heading with nothing failing.
 *
 * This file is the reconciliation, and it runs on the node side where both are
 * importable. It is checked in BOTH directions so a label for an axis that no
 * longer exists is reported too.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { COHORT_AXIS_VALUES } from "../src/main/telemetry/attribution-metrics.js";
import { ACTIVITY_COVERAGE_AXIS_LABELS } from "../src/shared/diagnostics-contract.js";

test("ISS-6758: every cohort axis has a Diagnostics label", () => {
  const missing = COHORT_AXIS_VALUES.filter(
    (axis) => ACTIVITY_COVERAGE_AXIS_LABELS[axis] === undefined
  );
  assert.deepEqual(
    missing,
    [],
    `ACTIVITY_COVERAGE_AXIS_LABELS (src/shared/diagnostics-contract.ts) has no label for: ${missing.join(", ")}. Without one the Coverage tab renders the raw column name as a heading.`
  );
});

test("ISS-6758: no label survives an axis the metric module dropped", () => {
  const axes = new Set<string>(COHORT_AXIS_VALUES);
  const orphans = Object.keys(ACTIVITY_COVERAGE_AXIS_LABELS).filter(
    (key) => !axes.has(key)
  );
  assert.deepEqual(
    orphans,
    [],
    `ACTIVITY_COVERAGE_AXIS_LABELS labels axes that COHORT_AXIS_VALUES no longer carries: ${orphans.join(", ")}. Remove them, or the map stops describing the read.`
  );
});
