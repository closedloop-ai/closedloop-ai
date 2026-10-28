/**
 * @file approved-branches-summary-cards-one-derivation.test.tsx
 * @description ISS-9961 — ONE derivation per Branches summary metric, for every
 * reader.
 *
 * THE DEFECT. Three independent flags each picked WHICH underlying field a
 * summary card summed. Two signed-in users on the same data, in the same window,
 * under the same filters therefore read different numbers off the same card,
 * with nothing on screen saying which basis either of them got. A flag may gate
 * whether a surface SHIPS; it may never pick which arithmetic a shipped card
 * performs.
 *
 * WHAT IS LEFT TO PIN HERE. ISS-9970 removed two of those three by deleting the
 * companion FIELDS outright (`reconciledAiSpendUsd`,
 * `populationMatchedLocPerDollar`) along with the standalone AI-spend card, and
 * `…-flag-invariance.test.tsx` pins that outcome for the LOC/$ reading. The
 * third gate survived that change and is this ticket's: `branches-cohort-
 * transparency` still chose between `bundle.activeBranches` and
 * `bundle.windowScoped.activeBranches`. So this file grades the ACTIVE BRANCHES
 * tile — the last card whose value a reader's flag could move — plus the ISS-9730
 * hide policy, which is a SECOND reader of the same selector and could otherwise
 * retire a different card than the one rendered.
 *
 * WHY THE FLAG IS TURNED ON. Rendering with it off would pass against the defect
 * too — off was always the unwindowed-field arm. The isolating permutation is the
 * flag ON: the bundle below carries both fields at values a render can be told
 * apart by, so each assertion can only pass by reading one of them.
 *
 * ISS-12309 (ruling, Cosimo Corrigan, 2026-10-08) moved WHICH field this row
 * renders: the card now takes the range-scoped count, so the tile prints 201 and
 * the unwindowed 207 must not reach it. That inverts the expected arm in every
 * case below and nothing else — the claim being graded is still agreement
 * BETWEEN flag states, which is what ISS-9961 settled and this ticket did not
 * reopen.
 *
 * Assertions read rendered TEXT rather than visibility: the contract is which
 * NUMBER each tile prints, and `toBeVisible` would accept an `sr-only` clipped
 * node carrying either one.
 */
import {
  BRANCH_METRIC_DICTIONARY,
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricId,
} from "@repo/api/src/types/branch-metrics";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY,
  METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovedBranchesSummaryCards } from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";

/** The one selection key ISS-9970 left standing — the widest steer available. */
const EVERY_SELECTION_FLAG: readonly string[] = [
  BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY,
];

/**
 * The rendered figure, written as an independent literal rather than read off the
 * bundle, so a rewritten fixture cannot make an assertion agree with itself.
 */
const WINDOWED_ACTIVE = 201;

/** The unwindowed cohort count. This may not reach a tile. */
const UNWINDOWED_ACTIVE = 207;

/**
 * One bundle carrying BOTH arms of the surviving gate at values a render can be
 * told apart by. The three cards beside Active branches are Complete on purpose:
 * `hiddenMetricCardIds` applies an all-or-nothing rule, so a row where every
 * card is not computable hides nothing and the hide cases below would pass
 * against any policy at all.
 */
const BOTH_ARMS_BUNDLE: BranchListMetricBundle = makeBranchListMetrics({
  cohortSize: 307,
  activeBranches: {
    current: {
      state: BranchMetricAvailability.Complete,
      value: UNWINDOWED_ACTIVE,
    },
  },
  locPerDollar: {
    current: { state: BranchMetricAvailability.Complete, value: 1.7 },
  },
  medianPrSize: {
    current: { state: BranchMetricAvailability.Complete, value: 148 },
  },
  mergeRatePct: {
    current: { state: BranchMetricAvailability.Complete, value: 62 },
  },
  windowScoped: {
    activeBranches: {
      current: {
        state: BranchMetricAvailability.Complete,
        value: WINDOWED_ACTIVE,
      },
    },
    // Required on `BranchListWindowScopedMetrics`, and no longer read by any
    // card: ISS-9970 retired the only tile that rendered it.
    aiSpendUsd: {
      current: { state: BranchMetricAvailability.Unavailable, value: null },
    },
  },
});

/**
 * Windowed count not computable, unwindowed Complete — the discriminating pair.
 * ISS-12309 flipped which side is withheld, because the hide policy must read
 * the same field the tile does and this pair is what proves it.
 */
const DIVERGENT_BUNDLE: BranchListMetricBundle = {
  ...BOTH_ARMS_BUNDLE,
  windowScoped: {
    activeBranches: {
      current: { state: BranchMetricAvailability.Unavailable, value: null },
    },
    aiSpendUsd: {
      current: { state: BranchMetricAvailability.Unavailable, value: null },
    },
  },
};

describe("ISS-9961 — no Branches summary card's value depends on flag state", () => {
  it("reports the windowed active-branch count with the selection flag open", () => {
    renderCards(EVERY_SELECTION_FLAG);
    const tile = cardFor(BranchMetricId.ActiveBranches);

    expect(tile).toHaveTextContent(String(WINDOWED_ACTIVE));
    // Both figures ride in ONE bundle, so this can only pass by ignoring the
    // unwindowed cohort count the cohort-transparency gate used to select.
    expect(tile).not.toHaveTextContent(String(UNWINDOWED_ACTIVE));
  });

  it("reports the same count with the selection flag closed", () => {
    // The pair that makes the ticket's claim checkable rather than asserted: two
    // readers, same data, opposite flag state, identical number. Without this
    // case the one above pins an arm and says nothing about agreement.
    renderCards([]);
    const tile = cardFor(BranchMetricId.ActiveBranches);

    expect(tile).toHaveTextContent(String(WINDOWED_ACTIVE));
    expect(tile).not.toHaveTextContent(String(UNWINDOWED_ACTIVE));
  });

  it("retires the card on the WINDOWED count, not the unwindowed one", () => {
    // The ISS-9730 hide policy selects through the same selector the tile does,
    // so before ISS-9961 it could retire a different card than the one rendered.
    //
    // The hide key MUST be in this flag set. `hiddenByGate` returns an empty set
    // at its first line unless `useMetricCardHideUnavailable()` is on, so a
    // render without it never reaches the selector call at all — the case would
    // pass against a hide policy reading the other field, which is the exact
    // mutation it exists to kill (whitlockk, #7020; review-soul class B).
    const flags = [
      ...EVERY_SELECTION_FLAG,
      METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY,
    ];
    const label = BRANCH_METRIC_DICTIONARY[BranchMetricId.ActiveBranches].label;

    // Windowed count not computable, unwindowed Complete: the card goes.
    const { unmount } = renderCards(flags, DIVERGENT_BUNDLE);
    expect(screen.queryByText(label)).not.toBeInTheDocument();
    unmount();

    // The positive sibling on the SAME locator, in the opposite state. The
    // unwindowed field is Complete in BOTH bundles, so a hide policy reading it
    // would keep the card above too and the pair would stop distinguishing
    // anything.
    renderCards(flags, BOTH_ARMS_BUNDLE);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("retires the same card with the selection flag CLOSED", () => {
    // The hide policy is a second reader of the selector, so it owes the same
    // paired proof the value cases above have: the ISS-9961 claim is an
    // agreement BETWEEN flag states, not a fact about one of them.
    const flags = [METRIC_CARD_HIDE_UNAVAILABLE_FEATURE_FLAG_KEY];
    const label = BRANCH_METRIC_DICTIONARY[BranchMetricId.ActiveBranches].label;

    const { unmount } = renderCards(flags, DIVERGENT_BUNDLE);
    expect(screen.queryByText(label)).not.toBeInTheDocument();
    unmount();

    renderCards(flags, BOTH_ARMS_BUNDLE);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

function renderCards(
  enabledFlags: readonly string[],
  metrics: BranchListMetricBundle = BOTH_ARMS_BUNDLE
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <ApprovedBranchesSummaryCards
        cardClassName="card"
        isError={false}
        isPending={false}
        metrics={metrics}
      />
    </FeatureFlagAdapterProvider>
  );
}

function cardFor(id: BranchMetricId): HTMLElement {
  const label = BRANCH_METRIC_DICTIONARY[id].label;
  const card = screen.getByText(label).closest("[data-slot='card']");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`No metric card rendered for ${label}`);
  }
  return card;
}
