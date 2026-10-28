/**
 * @file branches-summary-cards.test.tsx
 * @description The Branches summary strip, as both shells mount it.
 *
 * ISS-9961 deleted this component's SECOND definition of the same five cards —
 * a local `CARDS` array rendered by a local `BranchKpiCard`, reached only when
 * the `approved` prop was false, which neither live host ever did. The cases
 * that exercised that row are gone with it, and deliberately NOT re-pointed at
 * the canonical row: they asserted contracts that row does not have. The legacy
 * card had a GATED state (its `BranchKpi` carried one and the canonical
 * `BranchListMetricBundle` does not), so its connect-GitHub CTA cases described
 * a state the strip can no longer reach; and its `unavailableDetail` per-card
 * captions were its own required prop, where the canonical row answers the same
 * question through `availabilityDetail`, already covered by
 * `approved-branches-summary-cards.test.tsx`. Re-homing either onto this row
 * would have manufactured coverage of a contract nobody wrote.
 */
import type { BranchAnalytics } from "@repo/api/src/types/branch";
import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  kpi,
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "../branch-analytics-fixtures";
import { BranchesSummaryCards } from "../branches-summary-cards";

const A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

const complete = (value: number) =>
  ({
    current: { state: BranchMetricAvailability.Complete, value },
  }) as const;

/**
 * The legacy `BranchKpi` fields AND the canonical bundle the row actually reads.
 *
 * Both halves are load-bearing. `makeBranchListMetrics` defaults every metric to
 * Unavailable, so a fixture carrying only the `BranchKpi` fields renders the
 * row's UNAVAILABLE state — which made the "available" a11y case below assert
 * against a row with no figures in it, an inert fixture that could not tell the
 * available treatment from the absent one (Bug Hunter A, #7020).
 */
function makeAnalytics(): BranchAnalytics {
  return makeBranchAnalytics({
    mergeRate: kpi(BranchKpiState.Available, 87),
    totalSpendUsd: kpi(BranchKpiState.Available, 1234.5),
    activeBranchCount: kpi(BranchKpiState.Available, 7),
    canonicalMetrics: makeBranchListMetrics({
      cohortSize: 9,
      activeBranches: complete(7),
      locPerDollar: complete(20),
      medianPrSize: complete(120),
      aiSpendUsd: complete(1234.5),
      mergeRatePct: complete(87),
    }),
  });
}

/** Props for BranchesSummaryCards matching a given fetch state. */
function analyticsProps(data: BranchAnalytics | undefined, isError = false) {
  return {
    analytics: data,
    isPending: data === undefined && !isError,
    isError,
  };
}

describe("BranchesSummaryCards (B6 reconciliation)", () => {
  it("fills wrap-mode tracks unless the caller explicitly overrides card sizing", () => {
    const { container, rerender } = render(
      <BranchesSummaryCards {...analyticsProps(makeAnalytics())} wrapBelow />
    );
    const cards = [...container.querySelectorAll('[data-slot="card"]')];

    expect(cards).toHaveLength(5);
    for (const card of cards) {
      expect(card).toHaveClass("w-full");
      expect(card).not.toHaveClass("w-[var(--summary-card-min)]");
    }

    rerender(
      <BranchesSummaryCards
        {...analyticsProps(makeAnalytics())}
        cardClassName="w-fit"
        wrapBelow
      />
    );
    for (const card of container.querySelectorAll('[data-slot="card"]')) {
      expect(card).toHaveClass("w-fit");
      expect(card).not.toHaveClass("w-full");
    }
  });

  it("renders the five canonical cards in their fixed order", () => {
    const { container } = render(
      <BranchesSummaryCards {...analyticsProps(makeAnalytics())} />
    );
    // ISS-9957's order, made unconditional by ISS-10636: AI spend gave its slot
    // to Total LOC pushed and LOC per $ moved last.
    const labels = [
      "Active branches",
      "Median PR size",
      "Total LOC pushed",
      "Merge rate",
      "LOC per $",
    ];
    const positions = labels.map((label) =>
      (container.textContent ?? "").indexOf(label)
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right)
    );
  });

  it("shows each partial canonical metric's exact disclosure in its info popover", async () => {
    const partial = (value: number, disclosure: BranchMetricDisclosure) => ({
      current: {
        state: BranchMetricAvailability.Partial,
        value,
        disclosure,
      } as const,
    });
    const canonicalMetrics: BranchListMetricBundle = {
      period: BranchMetricPeriod.ThirtyDays,
      label: BranchMetricComparisonLabel.MonthOverMonth,
      window: {
        startAt: "2026-07-06T00:00:00.000Z",
        endAt: "2026-08-05T00:00:00.000Z",
      },
      cohortSize: 4,
      lastActiveAt: {
        state: BranchMetricAvailability.Complete,
        value: "2026-08-05T12:00:00.000Z",
      },
      activeBranches: {
        current: { state: BranchMetricAvailability.Complete, value: 2 },
      },
      canonicalLocPerDollar: partial(20, BranchMetricDisclosure.LocIncomplete),
      // A DIFFERENT disclosure on the superseded field, so a card that read it
      // instead of the canonical one would surface the wrong sentence rather
      // than pass by rendering the same words.
      locPerDollar: partial(20, BranchMetricDisclosure.CostIncomplete),
      medianPrSize: partial(120, BranchMetricDisclosure.PrIncomplete),
      aiSpendUsd: partial(40, BranchMetricDisclosure.CostIncomplete),
      mergeRatePct: partial(75, BranchMetricDisclosure.DefaultIncomplete),
    };

    render(
      <BranchesSummaryCards
        {...analyticsProps(makeBranchAnalytics({ canonicalMetrics }))}
      />
    );

    // ISS-10540 (product ruling 2026-09-22): no disclosure sits on a card face;
    // each Partial card's sentence is in its info popover, beside the metric's
    // definition, and the card face shows the `*`.
    for (const disclosure of Object.values(BranchMetricDisclosure)) {
      expect(screen.queryByText(disclosure)).not.toBeInTheDocument();
    }
    expect(screen.getByText("120 LOC*")).toBeInTheDocument();
    expect(await disclosureInInfoPopover("Median PR size")).toContain(
      BranchMetricDisclosure.PrIncomplete
    );
    expect(await disclosureInInfoPopover("Merge rate")).toContain(
      BranchMetricDisclosure.DefaultIncomplete
    );
    // `aiSpendUsd` and `locPerDollar` stay in the bundle literal because both
    // are required fields on `BranchListMetricBundle`, but no card reads either
    // one: ISS-9970 retired the spend card and ISS-10636 left the ratio card on
    // `canonicalLocPerDollar`. They share `CostIncomplete`, so its absence from
    // the ratio card's popover is what proves neither reached a surface — and
    // what would fail if the ratio card regressed to the superseded field.
    const ratioInfo = await disclosureInInfoPopover("LOC per $");
    expect(ratioInfo).toContain(BranchMetricDisclosure.LocIncomplete);
    expect(ratioInfo).not.toContain(BranchMetricDisclosure.CostIncomplete);
  });

  it("shows neutral placeholders while analytics is in flight", () => {
    render(<BranchesSummaryCards {...analyticsProps(undefined)} />);

    expect(screen.queryByText("87%")).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  // FEA-4177 (whitlockk review): a pending or failed analytics read is NOT demo
  // data. The dimmed cards must use `muted` (no badge), never `placeholder`,
  // whose "Sample" badge means "value is sample data pending real wiring" — a
  // lie about a card that is merely loading or whose read failed.
  it.each([
    ["loading", () => analyticsProps(undefined)],
    ["error", () => analyticsProps(undefined, true)],
  ])("never renders a Sample badge in the %s state", (_label, buildProps) => {
    render(<BranchesSummaryCards {...buildProps()} />);

    expect(screen.queryByText("Sample")).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
  });

  it.each([A11yTheme.Light, A11yTheme.Dark])(
    "keeps branch summary cards critical a11y and contrast clean in %s theme",
    async (theme) => {
      const { container } = render(
        <A11yThemeRoot theme={theme}>
          <BranchesSummaryCards {...analyticsProps(makeAnalytics())} />
        </A11yThemeRoot>
      );

      await expectCriticalAxeClean(container);
      expectElementContrast(screen.getByText("Active branches"), {
        background: themeBackground(theme),
        label: `branch summary label ${theme}`,
      });
    }
  );

  it.each([
    ["loading", () => analyticsProps(undefined), "—"],
    ["error", () => analyticsProps(undefined, true), "Unavailable"],
    ["available", () => analyticsProps(makeAnalytics()), "Active branches"],
  ])(
    "keeps branch KPI %s state a11y and contrast clean",
    async (_state, setup, expectedText) => {
      for (const theme of A11Y_THEMES) {
        const { container, unmount } = render(
          <A11yThemeRoot theme={theme}>
            <BranchesSummaryCards {...setup()} />
          </A11yThemeRoot>
        );

        await expectCriticalAxeClean(container);
        expectElementContrast(screen.getAllByText(expectedText)[0], {
          background: themeBackground(theme),
          label: `branch summary ${_state} ${theme}`,
        });
        unmount();
      }
    }
  );
});

/**
 * Opens a card's `(i)` popover, reads its text, and closes it again so the
 * next card's popover is the only dialog on screen.
 */
async function disclosureInInfoPopover(label: string): Promise<string> {
  const name = `About ${label}`;
  fireEvent.click(screen.getByRole("button", { name }));
  const dialog = await screen.findByRole("dialog", { name });
  const text = dialog.textContent ?? "";
  fireEvent.keyDown(dialog, { key: "Escape" });
  return text;
}
