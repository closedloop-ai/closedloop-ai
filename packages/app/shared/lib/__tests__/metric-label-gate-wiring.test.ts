/**
 * ISS-10667 — the two vocabularies a gated surface picks between.
 *
 * This pins the DATA on both sides: the shipped label map still spells the token
 * and ratio rows the way they ship today, the gated map spells each on its
 * metric's canonical phrase, and the ratio fold answers both arms correctly.
 * The dollar row left this gate's reach with ISS-10636 and is pinned canonical
 * on both maps. It does NOT call a
 * hook or render a component, so it does not prove any surface consults the
 * gate. `metric-label-record-wiring.test.ts` covers derivation; the six
 * `metric-label-render-wiring` suites — four here under
 * `agents/components/analytics`, `agents/components/sessions`,
 * `insights/components` and `branches/components`, plus ISS-10691's two outside
 * this package, under `apps/app/…/insights/tokenops-waste/components` and
 * `apps/desktop/src/renderer/components/agents` — mount each real component
 * through the real `FeatureFlagAdapterProvider` and assert the rendered label on
 * both arms, so a deleted flag read fails there rather than anywhere here.
 *
 * The OFF side is pinned deliberately: a closed-by-default rollout that
 * silently changed the shipped screen is the defect the policy exists to stop.
 */
import {
  MergedLocPerDollarBasis,
  resolveCanonicalMergedLocPerDollarLabel,
  resolveMergedLocPerDollarLabel,
} from "@repo/api/src/types/merged-loc-per-dollar-basis";
import { describe, expect, it } from "vitest";
import {
  ONE_LABEL_PER_METRIC_SESSIONS_SUMMARY_CARD_LABELS,
  SESSIONS_SUMMARY_CARD_LABELS,
  SessionsSummaryCardId,
} from "../../../agents/components/sessions/sessions-summary-card-visibility";

const UNRECOGNISED_BASIS = "a-basis-this-build-never-compiled";

describe("ISS-10667 the Sessions card labels swap as a whole map", () => {
  it("leaves the shipped map on the rows this gate still moves", () => {
    expect(SESSIONS_SUMMARY_CARD_LABELS[SessionsSummaryCardId.Tokens]).toBe(
      "Total Tokens"
    );
    expect(
      SESSIONS_SUMMARY_CARD_LABELS[SessionsSummaryCardId.LocPerDollar]
    ).toBe("LOC / $");
  });

  // ISS-10636 retired the basis gate, so the dollar row is the canonical phrase
  // on BOTH arms — the one row this gate no longer has to move.
  it("keeps the dollar row canonical on the ungated map too", () => {
    expect(SESSIONS_SUMMARY_CARD_LABELS[SessionsSummaryCardId.Cost]).toBe(
      "Total estimated cost"
    );
  });

  it("puts every gated row on its canonical phrase", () => {
    expect(
      ONE_LABEL_PER_METRIC_SESSIONS_SUMMARY_CARD_LABELS[
        SessionsSummaryCardId.Tokens
      ]
    ).toBe("Total tokens");
    expect(
      ONE_LABEL_PER_METRIC_SESSIONS_SUMMARY_CARD_LABELS[
        SessionsSummaryCardId.Cost
      ]
    ).toBe("Total estimated cost");
    expect(
      ONE_LABEL_PER_METRIC_SESSIONS_SUMMARY_CARD_LABELS[
        SessionsSummaryCardId.LocPerDollar
      ]
    ).toBe("Merged LOC per $");
  });
});

describe("ISS-10667 the ratio fold keeps its unrecognized-basis arm", () => {
  it("names the merged basis canonically once gated", () => {
    expect(
      resolveCanonicalMergedLocPerDollarLabel(
        MergedLocPerDollarBasis.MergedLinesOverTotalCost
      )
    ).toBe("Merged LOC per $");
    expect(
      resolveMergedLocPerDollarLabel(
        MergedLocPerDollarBasis.MergedLinesOverTotalCost
      )
    ).toBe("LOC / $");
  });

  it("refuses to assert a basis this build does not know", () => {
    // The whole point: `Merged LOC per $` claims a NUMERATOR, and a server
    // newer than this build can move it. Both folds coarsen identically here.
    expect(resolveCanonicalMergedLocPerDollarLabel(UNRECOGNISED_BASIS)).toBe(
      resolveMergedLocPerDollarLabel(UNRECOGNISED_BASIS)
    );
    expect(
      resolveCanonicalMergedLocPerDollarLabel(UNRECOGNISED_BASIS)
    ).not.toBe("Merged LOC per $");
  });
});
