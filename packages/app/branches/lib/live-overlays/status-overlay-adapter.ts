/**
 * Patch live F2 status onto the persisted check/review shape (Epic F / FEA-1952).
 *
 * The single place that merges live `/pr/reviews` values over the persisted
 * `BranchRow`/`BranchPageDetail` fields, so every consumer (the PR status panel,
 * and the list check-status column / D8 block when wired) reads ONE patched
 * shape.
 *
 * `reviewDecision` is AUTHORITATIVE when connected — `/pr/reviews` always
 * reports the live decision, and a live `null` means "no decision yet" (gh's
 * `REVIEW_REQUIRED`/empty maps to null). Falling back to the persisted value
 * there would let a stale "APPROVED" win over live "no decision", so live wins
 * outright, null included. Fields with NO live producer yet (`checksStatus`/
 * `checksPassed`/`checksTotal`, null today) DO fall back to persisted rather
 * than clobbering it with null.
 *
 * Behind/Ahead are intentionally NOT part of this overlay: no v1 producer
 * computes them (neither persisted enrichment nor a gateway route), so consumers
 * keep rendering the empty affordance for them.
 */

import type {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import type { LivePrStatusResult } from "./live-pr-status";

export type StatusOverlayBase = {
  checksStatus: ChecksStatus | null;
  checksPassed: number | null;
  checksTotal: number | null;
  reviewDecision: ReviewDecision | null;
};

export type StatusOverlay = StatusOverlayBase & {
  approvalCount: number | null;
  changesRequestedCount: number | null;
  /** True once GitHub has answered for this PR. */
  connected: boolean;
};

export function applyStatusOverlay(
  base: StatusOverlayBase,
  live: LivePrStatusResult | null
): StatusOverlay {
  if (live === null) {
    return {
      ...base,
      approvalCount: null,
      changesRequestedCount: null,
      connected: false,
    };
  }
  return {
    // No live producer yet → fall back to persisted (don't clobber with null).
    checksStatus: live.checksStatus ?? base.checksStatus,
    checksPassed: live.checksPassed ?? base.checksPassed,
    checksTotal: live.checksTotal ?? base.checksTotal,
    // Authoritative when connected — live null = "no decision yet", not a gap.
    reviewDecision: live.reviewDecision,
    approvalCount: live.approvalCount,
    changesRequestedCount: live.changesRequestedCount,
    connected: true,
  };
}
