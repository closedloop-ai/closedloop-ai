import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { describe, expect, it } from "vitest";
import type { LivePrStatusResult } from "../live-pr-status";
import {
  applyStatusOverlay,
  type StatusOverlayBase,
} from "../status-overlay-adapter";

function live(over: Partial<LivePrStatusResult> = {}): LivePrStatusResult {
  return {
    reviewDecision: null,
    approvalCount: 0,
    changesRequestedCount: 0,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    mergeStateStatus: null,
    statusCheckRollup: null,
    connected: true,
    ...over,
  };
}

const APPROVED_PERSISTED: StatusOverlayBase = {
  checksStatus: null,
  checksPassed: null,
  checksTotal: null,
  reviewDecision: ReviewDecision.Approved,
};

describe("applyStatusOverlay", () => {
  it("treats live reviewDecision as authoritative when connected — live null overrides a stale persisted APPROVED", () => {
    const result = applyStatusOverlay(
      APPROVED_PERSISTED,
      live({ reviewDecision: null })
    );
    // Live "no decision yet" (REVIEW_REQUIRED→null) must win over persisted.
    expect(result.reviewDecision).toBeNull();
    expect(result.connected).toBe(true);
  });

  it("passes a live reviewDecision through over the persisted value", () => {
    const result = applyStatusOverlay(
      APPROVED_PERSISTED,
      live({ reviewDecision: ReviewDecision.ChangesRequested })
    );
    expect(result.reviewDecision).toBe(ReviewDecision.ChangesRequested);
  });

  it("falls back to persisted checks (no live producer yet) without clobbering with null", () => {
    const result = applyStatusOverlay(
      {
        checksStatus: ChecksStatus.Passing,
        checksPassed: 3,
        checksTotal: 3,
        reviewDecision: null,
      },
      live()
    );
    expect(result.checksStatus).toBe(ChecksStatus.Passing);
    expect(result.checksTotal).toBe(3);
  });

  it("when live is unavailable (null), returns persisted values with connected=false", () => {
    const result = applyStatusOverlay(
      {
        checksStatus: ChecksStatus.Failing,
        checksPassed: 1,
        checksTotal: 2,
        reviewDecision: ReviewDecision.Approved,
      },
      null
    );
    expect(result.connected).toBe(false);
    expect(result.reviewDecision).toBe(ReviewDecision.Approved);
    expect(result.checksStatus).toBe(ChecksStatus.Failing);
    expect(result.approvalCount).toBeNull();
  });
});
