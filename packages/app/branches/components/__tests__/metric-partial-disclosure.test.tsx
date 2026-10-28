/**
 * @file metric-partial-disclosure.test.tsx
 * @description ISS-10540: where a Partial value's disclosure lives, on both
 * card families that render one.
 *
 * Product ruling (2026-09-22, after the operator's 2026-09-21 ruling retired
 * the ISS-9748 popover): the caption under the value is the card's fixed
 * scope phrase from the approved prototype (PR #3858), the value keeps its
 * `*`, and the disclosure sentence is carried in the card's info popover — the
 * `(i)` a reader already opens for the metric's definition. Nothing in the
 * footer opens anything.
 *
 * The strip cases exercise `ApprovedBranchesSummaryCards`; the detail cases
 * exercise `BranchHeadlineCards`, which has its own render path and its own
 * supporting captions.
 */

import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricId,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import { NO_COMPARISON_CHIP_LABEL } from "@repo/app/insights/components/kpi-delta-placeholder";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeBranchDetail } from "../../__tests__/branch-fixtures";
import {
  ApprovedBranchesSummaryCards,
  BRANCHES_SUMMARY_CANONICAL_CARD_SPECS,
} from "../approved-branches-summary-cards";
import { makeBranchListMetrics } from "../branch-analytics-fixtures";
import { BranchHeadlineCards } from "../branch-headline-cards";

const PARTIAL_WITH_COMPARISON = {
  current: {
    state: BranchMetricAvailability.Partial,
    value: 148,
    coverage: { included: 4, total: 6 },
    disclosure: BranchMetricDisclosure.PrIncomplete,
  },
  comparison: {
    label: BranchMetricComparisonLabel.MonthOverMonth,
    priorWindow: {
      startAt: "2026-06-06T00:00:00.000Z",
      endAt: "2026-07-06T00:00:00.000Z",
    },
    deltaPct: {
      state: BranchMetricAvailability.Partial,
      value: 12,
      disclosure: BranchMetricDisclosure.PrIncomplete,
    },
  },
} as const;

const PARTIAL_WITHOUT_COMPARISON = {
  current: {
    state: BranchMetricAvailability.Partial,
    value: 148,
    coverage: { included: 4, total: 6 },
    disclosure: BranchMetricDisclosure.PrIncomplete,
  },
  comparison: {
    label: BranchMetricComparisonLabel.MonthOverMonth,
    priorWindow: {
      startAt: "2026-06-06T00:00:00.000Z",
      endAt: "2026-07-06T00:00:00.000Z",
    },
    deltaPct: {
      state: BranchMetricAvailability.Unavailable,
      value: null,
    },
  },
} as const;

/** A COMPLETE value on the same path — no `*`, no disclosure anywhere. */
const COMPLETE_WITHOUT_COMPARISON = {
  current: { state: BranchMetricAvailability.Complete, value: 3 },
  comparison: {
    label: BranchMetricComparisonLabel.MonthOverMonth,
    priorWindow: {
      startAt: "2026-06-06T00:00:00.000Z",
      endAt: "2026-07-06T00:00:00.000Z",
    },
    deltaPct: {
      state: BranchMetricAvailability.Unavailable,
      value: null,
    },
  },
} as const;

describe("Partial metric disclosure on the Branches summary strip (ISS-10540)", () => {
  it("captions the value with the card's scope phrase beside a numeric delta chip", () => {
    renderStrip();

    const card = partialCard();
    expect(card.querySelector(`[data-testid="${DELTA_CHIP}"]`)).not.toBeNull();
    expect(card.textContent).toContain("+12%");
    expect(detailRowOf(card)?.textContent).toContain(
      scopeCaption(BranchMetricId.MedianPrSize)
    );
    // The sentence is not on the card face...
    expect(screen.queryByText(BranchMetricDisclosure.PrIncomplete)).toBeNull();
    // ...and nothing in the footer opens one.
    expect(footerPopoverTriggersIn(card)).toBe(0);
  });

  it("carries the disclosure in the card's info popover", async () => {
    renderStrip();

    fireEvent.click(infoTriggerOf(partialCard()));

    const dialog = await screen.findByRole("dialog", {
      name: infoLabel(BranchMetricId.MedianPrSize),
    });
    expect(dialog.textContent).toContain(BranchMetricDisclosure.PrIncomplete);
  });

  it("still marks the value itself as partial", () => {
    renderStrip();

    expect(partialCard().textContent).toContain("148 LOC*");
  });

  it("keeps the scope phrase as the caption beside a 'No comparison' chip", () => {
    renderStripWithoutComparison();

    const card = partialCard();
    expect(card.textContent).toContain(NO_COMPARISON_CHIP_LABEL);
    expect(detailRowOf(card)?.textContent).toContain(
      scopeCaption(BranchMetricId.MedianPrSize)
    );
    // ...and NOT the window label: "No comparison" over "MoM" would state a
    // month-over-month reading one line under a denial of it.
    expect(detailRowOf(card)?.textContent).not.toContain(
      BranchMetricComparisonLabel.MonthOverMonth
    );
    expect(screen.queryByText(BranchMetricDisclosure.PrIncomplete)).toBeNull();
    expect(footerPopoverTriggersIn(card)).toBe(0);
  });

  it("does not put a disclosure in a Complete card's info popover", async () => {
    renderStripWithoutComparison();

    // The Complete card keeps its scope phrase too — the caption is not a
    // Partial-only affordance.
    const card = completeCard();
    expect(detailRowOf(card)?.textContent).toContain(
      scopeCaption(BranchMetricId.ActiveBranches)
    );
    fireEvent.click(infoTriggerOf(card));
    const dialog = await screen.findByRole("dialog", {
      name: infoLabel(BranchMetricId.ActiveBranches),
    });
    for (const disclosure of Object.values(BranchMetricDisclosure)) {
      expect(dialog.textContent).not.toContain(disclosure);
    }
  });
});

/**
 * The Branch DETAIL family. Its own render path, so the summary-strip cases
 * above cannot cover it — this is what makes the file's "both card families"
 * claim true rather than aspirational.
 */
describe("Partial metric disclosure on the Branch detail cards (ISS-10540)", () => {
  it("keeps the card's own supporting caption and no disclosure on the face", () => {
    renderHeadlineCards();

    const card = detailLocCard();
    expect(card.textContent).toContain("42*");
    expect(card.textContent).toContain("Lifetime verified publication LOC");
    expect(card.textContent).not.toContain(
      BranchMetricDisclosure.LocIncomplete
    );
    expect(card.querySelectorAll('[aria-haspopup="dialog"]')).toHaveLength(1);
  });

  it("carries the disclosure in the card's info popover", async () => {
    renderHeadlineCards();

    fireEvent.click(infoTriggerOf(detailLocCard()));

    const dialog = await screen.findByRole("dialog", { name: ANY_INFO_LABEL });
    expect(dialog.textContent).toContain(BranchMetricDisclosure.LocIncomplete);
  });
});

function unavailableMetric(): BranchMetricResult<number> {
  return { state: BranchMetricAvailability.Unavailable, value: null };
}

function renderHeadlineCards() {
  return render(
    <BranchHeadlineCards
      detail={makeBranchDetail({
        canonicalMetrics: {
          abandonmentTimeMs: unavailableMetric(),
          idleTimeMs: unavailableMetric(),
          leadTimeMs: unavailableMetric(),
          locPerDollar: {
            state: BranchMetricAvailability.Partial,
            value: 42,
            coverage: { included: 3, total: 5 },
            disclosure: BranchMetricDisclosure.LocIncomplete,
          },
          phaseCostUsd: {
            [BranchVisibleLifecyclePhase.Build]: unavailableMetric(),
            [BranchVisibleLifecyclePhase.Review]: unavailableMetric(),
            [BranchVisibleLifecyclePhase.Rework]: unavailableMetric(),
          },
          totalCostUsd: unavailableMetric(),
        },
      })}
    />
  );
}

const DELTA_CHIP = "metric-delta-chip";
/** Any card's info popover: `MetricCard` names them all `About <label>`. */
const ANY_INFO_LABEL = /^About /;
const PARTIAL_VALUE_TEXT = /148/;
const COMPLETE_VALUE_TEXT = /^3$/;
const DETAIL_LOC_VALUE_TEXT = /^42\*$/;

function renderStripWithoutComparison() {
  return render(
    <ApprovedBranchesSummaryCards
      cardClassName="card"
      comparisonSuppressedByFilter
      isError={false}
      isPending={false}
      metrics={makeBranchListMetrics({
        activeBranches: COMPLETE_WITHOUT_COMPARISON,
        medianPrSize: PARTIAL_WITHOUT_COMPARISON,
      })}
    />
  );
}

function renderStrip() {
  return render(
    <ApprovedBranchesSummaryCards
      cardClassName="card"
      isError={false}
      isPending={false}
      metrics={makeBranchListMetrics({
        medianPrSize: PARTIAL_WITH_COMPARISON,
      })}
    />
  );
}

/** The card's approved scope phrase, read from the spec that renders it. */
function scopeCaption(id: BranchMetricId): string {
  const spec = BRANCHES_SUMMARY_CANONICAL_CARD_SPECS.find(
    (card) => card.id === id
  );
  if (!spec) {
    throw new Error(`No canonical card spec for ${id}`);
  }
  return spec.caption;
}

/** `MetricCard` names its info trigger and popover `About <label>`. */
function infoLabel(id: BranchMetricId): RegExp {
  const label =
    id === BranchMetricId.MedianPrSize ? "Median PR size" : "Active branches";
  return new RegExp(`^About ${label}$`, "i");
}

function infoTriggerOf(card: Element | null | undefined): HTMLElement {
  const trigger = card?.querySelector<HTMLElement>(
    'button[aria-haspopup="dialog"][aria-label^="About "]'
  );
  if (!trigger) {
    throw new Error("Card rendered no info trigger");
  }
  return trigger;
}

/**
 * `MetricCard`'s footer row, or null when the card renders none.
 *
 * Selected by the class combination the primitive gives that row, because it
 * carries no `data-slot` of its own. `gap-3` is load-bearing in the selector:
 * the card HEADER also carries `justify-between`, so matching on that alone
 * finds the header on every card and the assertion can never fail.
 */
function detailRowOf(card: Element | null | undefined): Element | null {
  return card?.querySelector(".justify-between.gap-3.flex-wrap") ?? null;
}

function completeCard(): HTMLElement {
  const card = screen
    .getByText(COMPLETE_VALUE_TEXT)
    .closest<HTMLElement>("[data-slot='card']");
  if (!card) {
    throw new Error("Complete card did not render");
  }
  return card;
}

function partialCard(): HTMLElement {
  const card = screen
    .getByText(PARTIAL_VALUE_TEXT)
    .closest<HTMLElement>("[data-slot='card']");
  if (!card) {
    throw new Error("Partial card did not render");
  }
  return card;
}

function detailLocCard(): HTMLElement {
  const card = screen
    .getByText(DETAIL_LOC_VALUE_TEXT)
    .closest<HTMLElement>("[data-slot='card']");
  if (!card) {
    throw new Error("Detail LOC card did not render");
  }
  return card;
}

/**
 * The structural signature of a popover trigger in the card's FOOTER, asserted
 * absent. Radix marks its trigger `aria-haspopup="dialog"`; the retired
 * disclosure trigger sat in the detail row, while the card's info trigger (also
 * a popover) sits in the header, so the count is scoped to the row. The
 * disclosure trigger's LABEL is gone with the component, so there is no
 * constant left to locate it by and the literal may not be re-typed here.
 */
function footerPopoverTriggersIn(card: Element | null): number {
  const row = detailRowOf(card);
  // Every card now has a footer (its scope caption lives there), so a missing
  // row is a broken render, not a passing absence.
  if (!row) {
    throw new Error("Card rendered no footer row");
  }
  return row.querySelectorAll('[aria-haspopup="dialog"]').length;
}
