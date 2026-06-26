import { BranchStatus } from "@repo/api/src/types/branch";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { describe, expect, it } from "vitest";
import type { LivePrStatusResult } from "../live-pr-status";
import {
  deriveLifecycleBadge,
  LifecycleTone,
} from "../merge-status-derivation";

function liveStatus(
  over: Partial<LivePrStatusResult> = {}
): LivePrStatusResult {
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

describe("deriveLifecycleBadge", () => {
  it("refines to blocked/Changes requested on a live CHANGES_REQUESTED decision", () => {
    expect(
      deriveLifecycleBadge({
        persisted: { prState: null, status: BranchStatus.Open },
        live: liveStatus({ reviewDecision: ReviewDecision.ChangesRequested }),
      })
    ).toEqual({ label: "Changes requested", tone: LifecycleTone.Blocked });
  });

  it("refines to review/Approved on a live APPROVED decision for an open PR", () => {
    expect(
      deriveLifecycleBadge({
        persisted: { prState: null, status: BranchStatus.Open },
        live: liveStatus({ reviewDecision: ReviewDecision.Approved }),
      })
    ).toEqual({ label: "Approved", tone: LifecycleTone.Review });
  });

  it("does NOT override a merged/closed PR with the Approved refinement", () => {
    expect(
      deriveLifecycleBadge({
        persisted: { prState: null, status: BranchStatus.Merged },
        live: liveStatus({ reviewDecision: ReviewDecision.Approved }),
      })
    ).toEqual({ label: "Merged", tone: LifecycleTone.Merged });
  });

  it("falls back to the persisted status when live is null", () => {
    expect(
      deriveLifecycleBadge({
        persisted: { prState: null, status: BranchStatus.Merged },
        live: null,
      })
    ).toEqual({ label: "Merged", tone: LifecycleTone.Merged });
  });

  it("returns the gated tone only when there is neither live data nor a persisted state", () => {
    expect(
      deriveLifecycleBadge({
        persisted: { prState: null, status: null },
        live: null,
      }).tone
    ).toBe(LifecycleTone.Gated);
  });
});
