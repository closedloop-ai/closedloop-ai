import type { BranchKpi } from "@repo/api/src/types/branch";
import {
  BranchBaselineScope,
  BranchKpiState,
} from "@repo/api/src/types/branch";
import { LOC_PER_DOLLAR_LABEL } from "@repo/api/src/utils/loc-per-dollar";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  makeBranchDetail as detail,
  makeBranchSession as session,
} from "../../__tests__/branch-fixtures";
import {
  baselinedKpi,
  makeBranchAnalytics,
} from "../branch-analytics-fixtures";
import { BranchHeadlineCards } from "../branch-headline-cards";
import { BranchesSummaryCards } from "../branches-summary-cards";

/**
 * ISS-4686 (#4242 review) — the Branches LIST summary cards and the branch
 * DETAIL headline cards read the SAME `BranchAnalytics` KPI on the same visit,
 * so a baseline either clears the one comparability gate for a given card's
 * population or renders no verdict there. The list used to read `kpi.deltaPct`
 * raw behind nothing but the 30-day window flag, which is how a BRANCH-scoped
 * baseline could print a verdict on the corpus headline while the detail card
 * for the same KPI correctly refused to compare.
 *
 * These are the cross-surface assertions; the per-gate cases live in
 * `lib/__tests__/branch-baseline-comparison.test.ts` and the detail-side reason
 * copy in `branch-detail-panels.test.tsx`.
 */

const DELTA_LABEL_RE = /vs\. prior 30 days/i;
const VERDICT_WORD_RE = /\b(better|worse)\b/i;
const DELTA_CHIP_TEST_ID = "metric-delta-chip";

/** The branch's own LOC / $ on the detail fixture below: 42 churn / $2 = 21. */
const BRANCH_LOC_PER_DOLLAR = 21;

function branchDetailFixture() {
  return detail({
    sessions: [session()],
    additions: 35,
    deletions: 7,
    estimatedCostUsd: 2,
  });
}

/** Every LOC / $ card rendered by the surface under test. */
function locPerDollarCards(labelText = LOC_PER_DOLLAR_LABEL): HTMLElement[] {
  return screen.getAllByText(labelText).map((label) => {
    const card = label.closest("[data-slot='card']");
    if (!(card instanceof HTMLElement)) {
      throw new Error("LOC / $ card not found");
    }
    return card;
  });
}

/** The one LOC / $ card the surface under test renders. */
function locPerDollarCard(labelText = LOC_PER_DOLLAR_LABEL): HTMLElement {
  const [card] = locPerDollarCards(labelText);
  return card;
}

function renderSummaryCards(locPerDollar: BranchKpi) {
  return render(
    <BranchesSummaryCards
      analytics={makeBranchAnalytics({ locPerDollar })}
      isError={false}
      isPending={false}
    />
  );
}

describe("Branches baseline verdicts agree across list and detail (ISS-4686)", () => {
  it("keeps legacy analytics verdicts off the canonical detail card and the corpus list card", () => {
    // Detail metrics are now selected-PR canonical results and never borrow the
    // legacy analytics baseline. The same Branch-scoped verdict is also
    // inapplicable to the corpus list card.
    const locPerDollar = baselinedKpi({
      value: BRANCH_LOC_PER_DOLLAR,
      baseline30d: 20,
      deltaPct: 5,
      comparisonScope: BranchBaselineScope.Branch,
    });

    const detailRender = render(
      <BranchHeadlineCards
        analytics={makeBranchAnalytics({ locPerDollar })}
        detail={branchDetailFixture()}
      />
    );
    const detailCard = locPerDollarCard("LOC per $");
    expect(within(detailCard).queryByTestId(DELTA_CHIP_TEST_ID)).toBe(null);
    detailRender.unmount();

    renderSummaryCards(locPerDollar);
    // The branch's verdict never leaks onto the corpus card, whose figure that
    // baseline was never measured against.
    const listCard = locPerDollarCard();
    expect(within(listCard).queryByTestId(DELTA_CHIP_TEST_ID)).toBe(null);
    expect(within(listCard).queryByText(DELTA_LABEL_RE)).toBe(null);
    expect(within(listCard).queryByText(VERDICT_WORD_RE)).toBe(null);
  });

  it("still renders the list verdict when the baseline is CORPUS-scoped like the card's own value", () => {
    renderSummaryCards(
      baselinedKpi({
        value: 14,
        baseline30d: 12.5,
        deltaPct: 12,
        comparisonScope: BranchBaselineScope.Corpus,
      })
    );

    const listCard = locPerDollarCard();
    expect(within(listCard).getByTestId(DELTA_CHIP_TEST_ID)).toHaveTextContent(
      "+12%"
    );
    expect(within(listCard).getByText(DELTA_LABEL_RE)).toBeInTheDocument();
  });

  it("derives the list percentage instead of trusting a contradictory wire deltaPct", () => {
    // 14 against a 12.5 baseline is +12%. A payload claiming -50% clears every
    // scope/basis gate and, read raw, would colour the exact opposite verdict.
    renderSummaryCards(
      baselinedKpi({
        value: 14,
        baseline30d: 12.5,
        deltaPct: -50,
        comparisonScope: BranchBaselineScope.Corpus,
      })
    );

    const listCard = locPerDollarCard();
    const chip = within(listCard).getByTestId(DELTA_CHIP_TEST_ID);
    expect(chip).toHaveTextContent("+12%");
    expect(chip).not.toHaveTextContent("-50%");
  });

  it("prints no list verdict for a baseline scoped by a newer producer this build cannot name", () => {
    // Version skew: a scope added after this build shipped, round-tripped
    // through JSON the way it would actually arrive rather than cast past the
    // type. Unknown is not "mismatched", but it is equally not a licence to
    // compare.
    const futureScopeKpi: BranchKpi = JSON.parse(
      JSON.stringify({
        value: 14,
        state: BranchKpiState.Available,
        baseline30d: 12.5,
        deltaPct: 12,
        comparisonScope: "repository",
      })
    );

    renderSummaryCards(futureScopeKpi);

    const listCard = locPerDollarCard();
    expect(within(listCard).queryByTestId(DELTA_CHIP_TEST_ID)).toBe(null);
    expect(within(listCard).queryByText(DELTA_LABEL_RE)).toBe(null);
    expect(within(listCard).queryByText(VERDICT_WORD_RE)).toBe(null);
  });
});
