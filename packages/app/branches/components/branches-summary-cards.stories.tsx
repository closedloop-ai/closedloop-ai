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
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY } from "../lib/branches-summary-honest-loading-flag";

const withHonestLoading: Decorator = (Story) => (
  <FeatureFlagAdapterProvider
    adapter={createStaticFeatureFlagAdapter({
      enabledFlags: [BRANCHES_SUMMARY_HONEST_LOADING_FEATURE_FLAG_KEY],
    })}
  >
    <Story />
  </FeatureFlagAdapterProvider>
);

const meta = {
  title: "Composites v1.0/Branches/Branches Summary Cards",
  component: BranchesSummaryCards,
  tags: ["deprecated", "autodocs"],
  args: { isError: false, isPending: false },
} satisfies Meta<typeof BranchesSummaryCards>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompleteWithDeltas: Story = {
  args: { analytics: analyticsWith(completeBundle()) },
};

export const Pending: Story = {
  args: { analytics: undefined, isPending: true },
};

export const PendingHonestLoading: Story = {
  args: {
    analytics: undefined,
    approvedReservesDeltaSlot: true,
    isPending: true,
  },
  decorators: [withHonestLoading],
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

/**
 * ISS-10544 — the row a WEB reader now gets, which no other story shows.
 *
 * Every story above renders the host capability's default (`false`), which
 * after the operator's 2026-09-17 ruling is the DESKTOP row: web graduated the
 * gate and draws the producer's series. Without this one, the only Branches
 * strip a designer can look at would be the gated one, and the shipped one
 * would have no visual reference at all.
 *
 * Deliberately over `uncomparableBundle` and deliberately NOT over every card.
 * Median PR size is the card ISS-10208 leaves with no delta, so the mark stands
 * alone there; Active branches is a boundary snapshot its producer sends no
 * series for, so it stays a bare figure. That contrast IS the row — a card with
 * a trend beside a card without is what a reader actually meets.
 */
export const TrendSparklineOnWeb: Story = {
  args: {
    analytics: analyticsWith(seriesBundle()),
    trendSparkline: true,
  },
};

/**
 * ISS-10544, the OTHER sparkline form — and the one most web readers actually
 * get (marisolashgrove review, PR #7525).
 *
 * `seriesBundle` is built on `uncomparableBundle`, so the story above shows only
 * the standalone mark: the card has no comparable delta, so there is no chip for
 * the mark to sit in. ISS-10540 removed `buildBranchMetricComparison`'s Partial
 * refusal, so on real data most cards DO carry a delta, and there the mark rides
 * INSIDE the chip and replaces the directional glyph. That form had no story at
 * all — a designer reviewing the shipped web row was looking at the minority
 * render and had no reference for the majority one.
 *
 * Beside `TrendSparklineOnWeb` on purpose: the two together are the whole
 * vocabulary, and the pair is the only way to see that a chip'"'"'s arrow is
 * REPLACED rather than accompanied.
 */
export const TrendSparklineInDeltaChip: Story = {
  args: {
    analytics: analyticsWith(comparableSeriesBundle()),
    trendSparkline: true,
  },
};

/**
 * ISS-7364, the pair worth seeing side by side: AI SPEND is a knowable partial
 * zero and prints `$0.00*` with its coverage footnote, while LOC PER $ beside
 * it is genuinely unknown — a ratio with nothing to divide by — and still says
 * so. Watch that the two never collapse into one another's treatment.
 *
 * ISS-9961: this pair used to be reachable only with the cohort-transparency
 * decorator on, because the knowable zero rode a `windowScoped` companion the
 * gate selected. There is one derivation per metric now, so the two states sit
 * in the fields the cards read and the story shows what every reader sees.
 */
export const KnowableZeroBesideUnknown: Story = {
  args: { analytics: analyticsWith(knowableZeroBundle()) },
};

/** The ISS-12309 capture's count over the unwindowed product cohort. */
const UNWINDOWED_ACTIVE = 769;
/** A fixture count for the selected window — not the capture's own figure. */
const WINDOWED_ACTIVE = 87;

/**
 * ISS-12309: the switch, visible. Every other story's two arms carry the same
 * count, so the Active branches tile looks identical whichever one it reads;
 * here they differ, and the tile reads the windowed figure or it is reading the
 * wrong population.
 */
export const WindowedActiveBranches: Story = {
  args: { analytics: analyticsWith(windowedActiveBundle()) },
};

function analyticsWith(
  canonicalMetrics: BranchListMetricBundle
): BranchAnalytics {
  return {
    ...makeBranchAnalytics(),
    viewerScope: BranchViewerScope.Self,
    canonicalMetrics: asCurrentProducer(canonicalMetrics),
  };
}

/**
 * ISS-12309: the Active branches card reads `windowScoped.activeBranches`, and a
 * bundle without that block is only what a producer PREDATING it sends — so
 * without this every story would render through the card's compatibility
 * fallback. The mirror puts them on the live arm and deliberately changes no
 * tile's figure; `WindowedActiveBranches` is the story where the two arms
 * disagree, and a bundle that states its own windowed block keeps it.
 */
function asCurrentProducer(
  bundle: BranchListMetricBundle
): BranchListMetricBundle {
  if (bundle.windowScoped) {
    return bundle;
  }
  return {
    ...bundle,
    windowScoped: {
      activeBranches: bundle.activeBranches,
      aiSpendUsd: bundle.aiSpendUsd,
    },
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
        disclosure: BranchMetricDisclosure.PrIncomplete,
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
        disclosure: BranchMetricDisclosure.PrIncomplete,
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

/**
 * ISS-10544: `uncomparableBundle`, plus the series its producer actually sends.
 *
 * Only the cards `branch-list-metrics.ts` folds a series for carry one here.
 * Active branches and LOC per $ are left without on purpose — that is what
 * their producers do, and a story that gave every card a mark would show a row
 * the product cannot render.
 */
function seriesBundle(): BranchListMetricBundle {
  const base = uncomparableBundle();
  return {
    ...base,
    medianPrSize: { ...base.medianPrSize, series: [180, 164, 210, 148, 131] },
    mergeRatePct: { ...base.mergeRatePct, series: [61, 68, 64, 77, 82] },
  };
}

/**
 * ISS-10544: the same cards as {@link seriesBundle}, with the comparable delta
 * that `uncomparableBundle` withholds — which is what moves the mark into the
 * chip. Two different signs on purpose, so the story shows that the mark
 * replaces BOTH directional glyphs rather than only the one the first card
 * happens to carry.
 */
function comparableSeriesBundle(): BranchListMetricBundle {
  const base = seriesBundle();
  return {
    ...base,
    medianPrSize: {
      ...base.medianPrSize,
      comparison: {
        label: BranchMetricComparisonLabel.MonthOverMonth,
        priorWindow: {
          startAt: "2026-06-06T00:00:00.000Z",
          endAt: "2026-07-06T00:00:00.000Z",
        },
        deltaPct: { state: BranchMetricAvailability.Complete, value: -12.4 },
      },
    },
    mergeRatePct: {
      ...base.mergeRatePct,
      comparison: {
        label: BranchMetricComparisonLabel.MonthOverMonth,
        priorWindow: {
          startAt: "2026-06-06T00:00:00.000Z",
          endAt: "2026-07-06T00:00:00.000Z",
        },
        deltaPct: { state: BranchMetricAvailability.Complete, value: 8.1 },
      },
    },
  };
}

function knowableZeroBundle(): BranchListMetricBundle {
  return {
    ...bundleBase(),
    cohortSize: 307,
    activeBranches: {
      current: { state: BranchMetricAvailability.Complete, value: 201 },
    },
    locPerDollar: {
      current: { state: BranchMetricAvailability.Unavailable, value: null },
    },
    medianPrSize: {
      current: { state: BranchMetricAvailability.Complete, value: 395 },
    },
    aiSpendUsd: {
      current: {
        state: BranchMetricAvailability.Partial,
        value: 0,
        disclosure: BranchMetricDisclosure.CostIncomplete,
      },
    },
    mergeRatePct: {
      current: { state: BranchMetricAvailability.Complete, value: 55.6 },
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

/**
 * The one bundle here that states its own `windowScoped` block, with a count
 * that differs from the unwindowed field beside it. `asCurrentProducer` leaves
 * it alone, so the Active branches tile has to choose.
 */
function windowedActiveBundle(): BranchListMetricBundle {
  const complete = completeBundle();
  return {
    ...complete,
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
      aiSpendUsd: complete.aiSpendUsd,
    },
  };
}
