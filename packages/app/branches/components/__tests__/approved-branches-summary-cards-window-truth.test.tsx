/**
 * @file approved-branches-summary-cards-window-truth.test.tsx
 * @description ISS-7363/ISS-7364 re-pinned on the one derivation every reader
 * gets, plus the ISS-12309 ruling that made the windowed count that derivation.
 *
 * This file was written for two defects seen in the 2026-08-20 sweep. The first
 * — the 7-day range printing the lifetime 207 while the API's own windowed count
 * was 201 — was addressed by a flag that chose between `bundle.activeBranches`
 * and `bundle.windowScoped.activeBranches`. ISS-9961 removed that choice: a flag
 * may gate whether a surface ships, never which arithmetic a shipped card
 * performs. So the two cases that pinned "closed gate reads 207, open gate reads
 * 201", and the third that pinned the companion fallback, no longer describe
 * anything this component does, and were deleted rather than re-pointed;
 * `approved-branches-summary-cards-one-derivation.test.tsx` pins the agreement
 * between readers that replaced them.
 *
 * ISS-12309 (ruling, Cosimo Corrigan, 2026-10-08) settles the question ISS-9961
 * left open — the windowed count IS the unconditional derivation now — so the
 * first defect is back in this file, re-pinned on the ONE field every reader
 * gets rather than on a gate.
 *
 * The SECOND defect is untouched by any of that: a tile whose value is a
 * knowable zero printed "Unavailable" instead of that zero. That claim is about
 * how an absent value is told apart from a real one, it still holds, and it had
 * no other coverage on this row.
 */
import {
  BRANCH_METRIC_DICTIONARY,
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricId,
} from "@repo/api/src/types/branch-metrics";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

/** The unwindowed cohort's active count from the ISS-12309 capture. */
const UNWINDOWED_ACTIVE = 769;

/**
 * The windowed active count this fixture serves. 87 is the capture's 7d LIST
 * SIZE, which counts merged and closed Branches too, so the card's in-progress
 * subset of that window is 87 or fewer — the literal stands as a fixture value,
 * not as the capture's active figure.
 */
const WINDOWED_ACTIVE = 87;

/**
 * A count that is genuinely zero, beside a ratio nobody could compute. Both ride
 * in ONE bundle so these assertions cannot both be satisfied by a row that
 * renders every tile the same way.
 */
const KNOWABLE_ZERO_BUNDLE: BranchListMetricBundle = makeBranchListMetrics({
  cohortSize: 307,
  // ISS-12309: the zero rides on the RANGE-SCOPED field, the one the card reads.
  // `activeBranches` keeps the fixture's Unavailable, so a card reading it
  // instead prints "Unavailable" and fails the case below rather than passing it
  // from the wrong population.
  windowScoped: {
    activeBranches: {
      current: { state: BranchMetricAvailability.Complete, value: 0 },
    },
    aiSpendUsd: {
      current: { state: BranchMetricAvailability.Unavailable, value: null },
    },
  },
  // The field the RENDERED ratio card selects. ISS-10636 left that card on
  // `canonicalLocPerDollar`, so an override on the superseded `locPerDollar`
  // would never reach a tile and this fixture's "unknown" half would be dead —
  // the two dictionary entries share the label "LOC per $", so the locator
  // would still resolve and the case would pass without pinning anything.
  canonicalLocPerDollar: {
    current: { state: BranchMetricAvailability.Unavailable, value: null },
  },
});

describe("ApprovedBranchesSummaryCards absent-vs-zero truth (ISS-7364)", () => {
  it("renders a knowable zero and an unknown as different tiles", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={KNOWABLE_ZERO_BUNDLE}
      />
    );
    const counted = cardFor(BranchMetricId.ActiveBranches);
    const ratio = cardFor(BranchMetricId.CanonicalLocPerDollar);

    expect(counted).toHaveTextContent("0");
    expect(counted).not.toHaveTextContent("Unavailable");
    expect(counted).not.toHaveTextContent("No data");

    // The distinction survives in TEXT, not styling: the genuinely unknown tile
    // beside it still says so, and still shows no figure.
    expect(ratio).toHaveTextContent("Unavailable");
    expect(ratio).not.toHaveTextContent("0 LOC/$");
  });
});

/**
 * The 2026-10-08 capture in ISS-12309, transcribed: the tile printed 769 active
 * over the unwindowed cohort while the 7d list beneath it held 87 Branches. Both
 * figures ride in ONE bundle, so a render cannot satisfy the pair below by
 * reading either field indifferently.
 */
const DIVERGENT_WINDOW_BUNDLE: BranchListMetricBundle = makeBranchListMetrics({
  cohortSize: 1144,
  activeBranches: {
    current: {
      state: BranchMetricAvailability.Complete,
      value: UNWINDOWED_ACTIVE,
    },
  },
  windowScoped: {
    activeBranches: {
      current: {
        state: BranchMetricAvailability.Complete,
        value: WINDOWED_ACTIVE,
      },
    },
    aiSpendUsd: {
      current: { state: BranchMetricAvailability.Unavailable, value: null },
    },
  },
});

describe("ApprovedBranchesSummaryCards window agreement (ISS-12309)", () => {
  it("counts the selected window, not the unwindowed cohort", () => {
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={DIVERGENT_WINDOW_BUNDLE}
      />
    );
    const tile = cardFor(BranchMetricId.ActiveBranches);

    expect(tile).toHaveTextContent(String(WINDOWED_ACTIVE));
    expect(tile).not.toHaveTextContent(String(UNWINDOWED_ACTIVE));
  });

  it("keeps the unwindowed count when the producer sends no window-scoped block", () => {
    // `windowScoped` is additive and optional, so a producer predating it is the
    // only reachable source of a bundle without one. Today's figure is the
    // graceful degradation there — withholding the card would be a worse answer
    // than a number whose window the reader cannot see.
    render(
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={makeBranchListMetrics({
          cohortSize: 1144,
          activeBranches: {
            current: {
              state: BranchMetricAvailability.Complete,
              value: UNWINDOWED_ACTIVE,
            },
          },
        })}
      />
    );

    expect(cardFor(BranchMetricId.ActiveBranches)).toHaveTextContent(
      String(UNWINDOWED_ACTIVE)
    );
  });
});

function cardFor(id: BranchMetricId): HTMLElement {
  const label = BRANCH_METRIC_DICTIONARY[id].label;
  const card = screen.getByText(label).closest("[data-slot='card']");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`No metric card rendered for ${label}`);
  }
  return card;
}
