/**
 * @file branch-empty-scope-reads.ts
 * @description ISS-5957 — the main-process bypass that keeps an EMPTY Branch
 * cohort out of the bounded admission lane.
 *
 * Both named Branch read facades already short-circuit an empty cohort, but they
 * do it INSIDE the db-host worker, in the method body. Admission happens before
 * that: `dispatchDbHostInvoke` hands the op to `runInvokeOp`, which takes a
 * bounded-lane permit and only then calls the method that returns an empty
 * result without issuing a single statement. So an empty Branches page — no
 * eligible branches, `branchKeys: []` — could sit behind a corpus-scale Sessions
 * hydration or dashboard read for work it was never going to do.
 *
 * The permit is acquired by op NAME (see the "keys on the op NAME" gap recorded
 * on `BOUNDED_READ_OPS`), and the routing decision deliberately does not inspect
 * arguments, so the worker side has no seam to fix this on. The seam is here, at
 * the call: an empty cohort never becomes a proxy call at all, so it never
 * reaches the lane.
 *
 * `undefined` is NOT empty. On the evidence read an absent `branchKeys` means
 * "no cohort scope" — the whole eligible corpus — which is the heaviest shape
 * the op has and exactly what the lane is for. Only a present-and-empty array
 * short-circuits, matching the worker-side condition it mirrors.
 */

import type {
  BranchCanonicalActivityReadRequest,
  BranchCanonicalActivityRow,
} from "../database/branch-activity-read.js";
import {
  type BranchMetricEventEvidenceRead,
  type BranchMetricEventEvidenceRequest,
  emptyBranchMetricEventEvidenceRead,
} from "../database/branch-metric-event-provenance.js";
import type { BranchReadFacadeMethods } from "../database/branch-read-facades.js";

/** Canonical activity rows for a cohort, skipping the proxy call when it is empty. */
export function readBranchCanonicalActivityRowsForScope(
  source: Pick<BranchReadFacadeMethods, "readBranchCanonicalActivityRows">,
  request: BranchCanonicalActivityReadRequest
): Promise<BranchCanonicalActivityRow[]> {
  if (request.branchKeys.length === 0) {
    return Promise.resolve([]);
  }
  return source.readBranchCanonicalActivityRows(request);
}

/** Metric-event evidence for a cohort, skipping the proxy call when it is empty. */
export function readBranchMetricEventEvidenceForScope(
  source: Pick<BranchReadFacadeMethods, "readBranchMetricEventEvidence">,
  request: BranchMetricEventEvidenceRequest
): Promise<BranchMetricEventEvidenceRead> {
  if (request.branchKeys?.length === 0) {
    return Promise.resolve(emptyBranchMetricEventEvidenceRead());
  }
  return source.readBranchMetricEventEvidence(request);
}
