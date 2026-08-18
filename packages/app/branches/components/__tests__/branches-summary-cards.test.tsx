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
import { describe, expect, it, vi } from "vitest";
import { kpi, makeBranchAnalytics } from "../branch-analytics-fixtures";
import { BranchesSummaryCards } from "../branches-summary-cards";

const CONNECT_RE = /light up this metric/i;
const CONNECT_BUTTON_RE = /connect github/i;
const A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

function makeAnalytics(): BranchAnalytics {
  return makeBranchAnalytics({
    mergeRate: kpi(BranchKpiState.Available, 87),
    totalSpendUsd: kpi(BranchKpiState.Available, 1234.5),
    activeBranchCount: kpi(BranchKpiState.Available, 7),
  });
}

// A branch KPI that needs GitHub enrichment → renders the connect affordance.
function makeGatedAnalytics(): BranchAnalytics {
  return makeBranchAnalytics({
    mergeRate: kpi(BranchKpiState.Gated, null),
    totalSpendUsd: kpi(BranchKpiState.Available, 1234.5),
    activeBranchCount: kpi(BranchKpiState.Available, 7),
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
      <BranchesSummaryCards
        {...analyticsProps(makeAnalytics())}
        approved
        wrapBelow
      />
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
        approved
        cardClassName="w-fit"
        wrapBelow
      />
    );
    for (const card of container.querySelectorAll('[data-slot="card"]')) {
      expect(card).toHaveClass("w-fit");
      expect(card).not.toHaveClass("w-full");
    }
  });

  it("renders the five approved canonical cards in their fixed order", () => {
    const { container } = render(
      <BranchesSummaryCards {...analyticsProps(makeAnalytics())} approved />
    );
    const labels = [
      "Active branches",
      "LOC per $",
      "Median PR size",
      "AI spend",
      "Merge rate",
    ];
    const positions = labels.map((label) =>
      (container.textContent ?? "").indexOf(label)
    );

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right)
    );
  });

  it("shows each partial canonical metric's exact approved disclosure", () => {
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
      locPerDollar: partial(20, BranchMetricDisclosure.LocIncomplete),
      medianPrSize: partial(120, BranchMetricDisclosure.DefaultIncomplete),
      aiSpendUsd: partial(40, BranchMetricDisclosure.CostIncomplete),
      mergeRatePct: partial(75, BranchMetricDisclosure.DefaultIncomplete),
    };

    render(
      <BranchesSummaryCards
        {...analyticsProps(makeBranchAnalytics({ canonicalMetrics }))}
        approved
      />
    );

    expect(
      screen.getAllByText(BranchMetricDisclosure.DefaultIncomplete)
    ).toHaveLength(2);
    expect(
      screen.getByText(BranchMetricDisclosure.CostIncomplete)
    ).toBeInTheDocument();
    expect(
      screen.getByText(BranchMetricDisclosure.LocIncomplete)
    ).toBeInTheDocument();
  });

  it("renders only locally-computed cards and no connect-GitHub affordance", () => {
    render(<BranchesSummaryCards {...analyticsProps(makeAnalytics())} />);

    // Merge rate is available → real value, no Sample badge, no hardcoded 86.
    expect(screen.getByText("87%")).toBeInTheDocument();
    expect(screen.queryByText("86")).not.toBeInTheDocument();
    expect(screen.queryByText("Sample")).not.toBeInTheDocument();

    // FEA-2942: the merge-rate denominator is DECIDED PRs (merged + closed), not
    // opened, so the card detail must say "of decided PRs" — the old
    // "of opened PRs" copy misdescribed the metric once open PRs are excluded.
    expect(screen.getByText("of decided PRs")).toBeInTheDocument();
    expect(screen.queryByText("of opened PRs")).not.toBeInTheDocument();

    // The GitHub-free cards (FEA-2051) render real local values.
    // AI spend is a big aggregate → whole dollars, no cents (1234.5 → $1,235).
    expect(screen.getByText("$1,235")).toBeInTheDocument(); // AI spend
    expect(screen.getByText("7")).toBeInTheDocument(); // Active branches

    // FEA-2051: the GitHub-gated cards (Active PRs, Merged, Median time to merge)
    // are removed entirely — the row never shows the connect-GitHub affordance.
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
    expect(screen.queryByText("Active PRs")).not.toBeInTheDocument();
    expect(screen.queryByText("Merged")).not.toBeInTheDocument();
    expect(screen.queryByText("Median time to merge")).not.toBeInTheDocument();
  });

  it("renders a real sub-cent AI spend total as a nonzero figure, never $0.00", () => {
    // ISS-4919 / review of #4244: the $0 this PR closes was still reachable one
    // decimal lower. A filtered subset totalling $0.004 rendered "$0.00" under
    // the card's own "estimated cost" caption — the same fabricated zero the
    // null-on-zero rule exists to stop. The card must show the money that was
    // actually spent.
    render(
      <BranchesSummaryCards
        {...analyticsProps(
          makeBranchAnalytics({
            mergeRate: kpi(BranchKpiState.Available, 87),
            totalSpendUsd: kpi(BranchKpiState.Available, 0.004),
            activeBranchCount: kpi(BranchKpiState.Available, 7),
          })
        )}
      />
    );

    expect(screen.getByText("$0.004")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
  });

  it("renders a live Connect GitHub CTA on a gated card and fires onConnectGitHub on click", () => {
    const onConnectGitHub = vi.fn();
    render(
      <BranchesSummaryCards
        {...analyticsProps(makeGatedAnalytics())}
        onConnectGitHub={onConnectGitHub}
      />
    );

    // The gated card still explains what the connect unlocks…
    expect(screen.getByText(CONNECT_RE)).toBeInTheDocument();
    // …and now surfaces a working CTA that fires the surface-owned handler.
    const connectButton = screen.getByRole("button", {
      name: CONNECT_BUTTON_RE,
    });
    fireEvent.click(connectButton);
    expect(onConnectGitHub).toHaveBeenCalledTimes(1);
  });

  it("keeps the gated affordance informational (no CTA) when onConnectGitHub is omitted", () => {
    render(<BranchesSummaryCards {...analyticsProps(makeGatedAnalytics())} />);

    // Web shell / handler-less callers keep the informational-only affordance:
    // the explanation shows but no connect button is rendered.
    expect(screen.getByText(CONNECT_RE)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: CONNECT_BUTTON_RE })
    ).not.toBeInTheDocument();
  });

  it("shows neutral placeholders while analytics is in flight", () => {
    render(<BranchesSummaryCards {...analyticsProps(undefined)} />);

    expect(screen.queryByText("87%")).not.toBeInTheDocument();
    expect(screen.queryByText(CONNECT_RE)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
  });

  // ISS-4737: an unavailable AI-spend card must caption WHY the value is absent.
  // Its `detail` ("estimated cost in range") was written to sit under a number,
  // so leaving it under the "No data" glyph describes a value that isn't there —
  // and this card now goes to no-data as the user filters (a zero-sum priced
  // subset), so the caption is the only thing distinguishing "your filter
  // matched branches with no cost" from a broken read.
  it("captions an unavailable AI-spend card with why the value is absent", () => {
    render(
      <BranchesSummaryCards
        {...analyticsProps({
          ...makeAnalytics(),
          totalSpendUsd: kpi(BranchKpiState.Unavailable, null),
        })}
      />
    );

    expect(
      screen.getByText("no cost to report for these branches")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("estimated cost in range")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
  });

  it("keeps the metric caption on an AVAILABLE AI-spend card", () => {
    render(<BranchesSummaryCards {...analyticsProps(makeAnalytics())} />);

    expect(screen.getByText("estimated cost in range")).toBeInTheDocument();
    expect(
      screen.queryByText("no cost to report for these branches")
    ).not.toBeInTheDocument();
  });

  // Review of #4244: `unavailableDetail` is REQUIRED, so EVERY card in the row
  // captions its own absent state. One "No data" glyph explaining itself while
  // its four neighbours restate their metric would read as one card failing
  // differently from the rest, not as five cards with nothing to report.
  it.each([
    [
      "loc-per-dollar",
      "locPerDollar",
      "no line counts or cost for these branches",
      "lines changed per lifetime dollar",
    ],
    [
      "active branches",
      "activeBranchCount",
      "no branches match these filters",
      "in progress",
    ],
    [
      "merge rate",
      "mergeRate",
      "no decided PRs for these branches",
      "of decided PRs",
    ],
    [
      "median PR size",
      "medianPrSize",
      "no merged PR sizes for these branches",
      "per merged PR",
    ],
  ])("captions the unavailable %s card with why the value is absent", (_label, field, whyCaption, metricCaption) => {
    render(
      <BranchesSummaryCards
        {...analyticsProps({
          ...makeAnalytics(),
          [field]: kpi(BranchKpiState.Unavailable, null),
        })}
      />
    );

    expect(screen.getByText(whyCaption)).toBeInTheDocument();
    expect(screen.queryByText(metricCaption)).not.toBeInTheDocument();
  });

  // FEA-4177 (wongk review): a pending or failed analytics read is NOT demo
  // data. The dimmed cards must use `muted` (no badge), never `placeholder`,
  // whose "Sample" badge means "value is sample data pending real wiring" — a
  // lie about a card that is merely loading or whose read failed.
  it.each([
    ["loading", () => analyticsProps(undefined)],
    ["error", () => analyticsProps(undefined, true)],
  ])("never renders a Sample badge in the %s state", (_label, buildProps) => {
    render(<BranchesSummaryCards {...buildProps()} />);

    expect(screen.queryByText("Sample")).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
  });

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps branch summary cards critical a11y and contrast clean in %s theme", async (theme) => {
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
  });

  it.each([
    ["loading", () => analyticsProps(undefined), "—"],
    ["error", () => analyticsProps(undefined, true), "Unavailable"],
    ["available", () => analyticsProps(makeAnalytics()), "Active branches"],
    [
      "unavailable",
      () =>
        analyticsProps({
          ...makeAnalytics(),
          activeBranchCount: kpi(BranchKpiState.Unavailable, null),
        }),
      "Active branches",
    ],
    [
      "gated",
      () =>
        analyticsProps({
          ...makeAnalytics(),
          activeBranchCount: kpi(BranchKpiState.Gated, null),
        }),
      "Active branches",
    ],
  ])("keeps branch KPI %s state a11y and contrast clean", async (_state, setup, expectedText) => {
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
  });
});
