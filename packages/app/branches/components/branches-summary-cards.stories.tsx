import type { BranchAnalytics } from "@repo/api/src/types/branch";
import { BranchViewerScope } from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { makeBranchAnalytics } from "@repo/app/branches/components/branch-analytics-fixtures";
import { BranchesSummaryCards } from "@repo/app/branches/components/branches-summary-cards";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * The row of KPI cards above the Branches list: AI spend, lines changed per
 * dollar, active branches, merge rate, and median pull request size, each
 * with an info tooltip explaining exactly what it measures. Every card is
 * computed from your local, filtered view of branches, so the numbers that
 * do not need GitHub stay visible even without a GitHub connection, while a
 * metric that genuinely needs GitHub shows a 'Connect GitHub' prompt instead
 * of a made up number. Reach for it as the summary strip on the Branches
 * list page; the same metrics get their own dedicated cards on a single
 * branch's detail page. Each card can independently show a muted 'no data'
 * state with its own reason, so seeing several side by side does not mean
 * the page failed to load.
 */
const meta = {
  title: "Composites/Branches/Branches Summary Cards",
  component: BranchesSummaryCards,
  tags: ["autodocs"],
  argTypes: {
    analytics: {
      control: "object",
      description:
        "The fetched analytics, or undefined while the read is pending.",
      table: { category: "Data" },
    },
    isPending: { control: "boolean", table: { category: "State" } },
    isError: { control: "boolean", table: { category: "State" } },
    approved: {
      control: "boolean",
      description: "Render the canonical PRD-601 five-card bundle.",
      table: { category: "State" },
    },
    approvedComparisonSuppressedByFilter: {
      control: "boolean",
      description:
        "The filtered-metrics fallback replaced the card comparisons.",
      table: { category: "State" },
    },
    showDelta: {
      control: "boolean",
      description: "Only meaningful on a 30-day window, the fixed baseline.",
      table: { category: "State" },
    },
    wrapBelow: { control: "boolean", table: { category: "Appearance" } },
    className: { control: "text", table: { category: "Appearance" } },
    cardClassName: { control: "text", table: { category: "Appearance" } },
    onConnectGitHub: { control: false, table: { category: "Events" } },
  },
  args: {
    approved: true,
    approvedComparisonSuppressedByFilter: false,
    isError: false,
    isPending: false,
    onConnectGitHub: fn(),
    showDelta: true,
    wrapBelow: false,
  },
} satisfies Meta<typeof BranchesSummaryCards>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompleteWithDeltas: Story = {
  args: { analytics: analyticsWith(completeBundle()) },
};

export const Pending: Story = {
  args: { analytics: undefined, isPending: true },
};

export const ErrorState: Story = {
  args: { analytics: undefined, isError: true },
};

export const MixedAvailability: Story = {
  args: {
    analytics: analyticsWith(mixedBundle()),
    approvedComparisonSuppressedByFilter: true,
  },
};

/**
 * ISS-5714: real values whose period-over-period comparison could not be
 * computed. The footer used to print a bare `Unavailable` here, one line under
 * the value, so a tile read as a number and a denial of that number at once.
 *
 * The row deliberately mixes BOTH reachable causes, because they get different
 * sentences and the only way to see that they read differently is to hover two
 * chips side by side: `Unavailable` (this period or the prior one is itself
 * partial) on most cards, and `NotApplicable` (the prior window has no nonzero
 * base) on Merge rate. No assertion shows how those captions sit against the
 * values they do NOT deny.
 */
export const ValueWithoutComparison: Story = {
  args: { analytics: analyticsWith(uncomparableBundle()) },
};

function analyticsWith(
  canonicalMetrics: BranchListMetricBundle
): BranchAnalytics {
  return {
    ...makeBranchAnalytics(),
    viewerScope: BranchViewerScope.Self,
    canonicalMetrics,
  };
}

function completeBundle(): BranchListMetricBundle {
  const metric = (value: number, delta: number) => ({
    current: { state: BranchMetricAvailability.Complete, value } as const,
    comparison: {
      label: BranchMetricComparisonLabel.MonthOverMonth,
      priorWindow: {
        startAt: "2026-06-06T00:00:00.000Z",
        endAt: "2026-07-06T00:00:00.000Z",
      },
      deltaPct: {
        state: BranchMetricAvailability.Complete,
        value: delta,
      } as const,
    },
  });
  return {
    ...bundleBase(),
    activeBranches: metric(12, 9),
    locPerDollar: metric(42, 4),
    medianPrSize: metric(318, -8),
    aiSpendUsd: metric(247.5, -6),
    mergeRatePct: metric(82, 5),
  };
}

function mixedBundle(): BranchListMetricBundle {
  const unavailable = {
    current: {
      state: BranchMetricAvailability.Unavailable,
      value: null,
    } as const,
  };
  return {
    ...bundleBase(),
    activeBranches: {
      current: { state: BranchMetricAvailability.Complete, value: 3 },
    },
    locPerDollar: unavailable,
    medianPrSize: {
      current: {
        state: BranchMetricAvailability.Partial,
        value: 318,
        coverage: { included: 4, total: 6 },
        disclosure: BranchMetricDisclosure.DefaultIncomplete,
      },
    },
    aiSpendUsd: {
      current: {
        state: BranchMetricAvailability.Partial,
        value: 18.4,
        coverage: { included: 4, total: 6 },
        disclosure: BranchMetricDisclosure.CostIncomplete,
      },
    },
    mergeRatePct: {
      current: {
        state: BranchMetricAvailability.Partial,
        value: 82,
        coverage: { included: 5, total: 6 },
        disclosure: BranchMetricDisclosure.DefaultIncomplete,
      },
    },
  };
}

function uncomparableBundle(): BranchListMetricBundle {
  const uncomparable = (value: number) => ({
    current: { state: BranchMetricAvailability.Complete, value } as const,
    comparison: {
      label: BranchMetricComparisonLabel.MonthOverMonth,
      priorWindow: {
        startAt: "2026-06-06T00:00:00.000Z",
        endAt: "2026-07-06T00:00:00.000Z",
      },
      deltaPct: {
        state: BranchMetricAvailability.Unavailable,
        value: null,
      } as const,
    },
  });
  return {
    ...bundleBase(),
    activeBranches: uncomparable(12),
    locPerDollar: uncomparable(42),
    medianPrSize: {
      current: {
        state: BranchMetricAvailability.Partial,
        value: 148,
        coverage: { included: 4, total: 6 },
        disclosure: BranchMetricDisclosure.DefaultIncomplete,
      },
      comparison: uncomparable(0).comparison,
    },
    aiSpendUsd: uncomparable(247.5),
    mergeRatePct: {
      current: { state: BranchMetricAvailability.Complete, value: 82 },
      comparison: {
        label: BranchMetricComparisonLabel.MonthOverMonth,
        priorWindow: {
          startAt: "2026-06-06T00:00:00.000Z",
          endAt: "2026-07-06T00:00:00.000Z",
        },
        deltaPct: {
          state: BranchMetricAvailability.NotApplicable,
          value: null,
        },
      },
    },
  };
}

function bundleBase() {
  return {
    period: BranchMetricPeriod.ThirtyDays,
    label: BranchMetricComparisonLabel.MonthOverMonth,
    window: {
      startAt: "2026-07-06T00:00:00.000Z",
      endAt: "2026-08-05T00:00:00.000Z",
    },
    cohortSize: 12,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: "2026-08-05T12:00:00.000Z",
    } as const,
  };
}
