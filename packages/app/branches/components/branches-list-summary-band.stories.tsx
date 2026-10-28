import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { GitHubConnectReturnStatus } from "@repo/api/src/types/github-status";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import { BranchCohortNoticeKind } from "../lib/branch-cohort-transparency";
import {
  kpi,
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "./branch-analytics-fixtures";
import {
  BranchesListSummaryBand,
  type BranchesListSummaryBandProps,
} from "./branches-list-summary-band";

const STORY_ANALYTICS = makeBranchAnalytics({
  activeBranchCount: kpi(BranchKpiState.Available, 14),
  canonicalMetrics: makeBranchListMetrics({
    period: BranchMetricPeriod.ThirtyDays,
    label: BranchMetricComparisonLabel.MonthOverMonth,
    cohortSize: 14,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: "2026-09-17T12:00:00.000Z",
    },
    activeBranches: completeMetric(14),
    aiSpendUsd: completeMetric(960),
    // The field the ratio card selects since ISS-10636; the superseded
    // `locPerDollar` reaches no tile, so a story setting only that one
    // would render an absent ratio.
    canonicalLocPerDollar: completeMetric(38),
    medianPrSize: completeMetric(224),
    mergeRatePct: completeMetric(68),
  }),
});

const FEATURE_FLAG_ADAPTER = createStaticFeatureFlagAdapter({
  enabledFlags: [BRANCHES_COHORT_TRANSPARENCY_FEATURE_FLAG_KEY],
});

const meta = {
  title: "Composites v1.0/Branches/Branches List Summary Band",
  tags: ["deprecated"],
  component: BranchesListSummaryBand,
  decorators: [
    (Story) => (
      <FeatureFlagAdapterProvider adapter={FEATURE_FLAG_ADAPTER}>
        <Story />
      </FeatureFlagAdapterProvider>
    ),
  ],
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchesListSummaryBand>;

export default meta;

type Story = StoryObj<typeof meta>;

const BASE_PROPS = {
  cohortNotice: { kind: BranchCohortNoticeKind.Hidden, total: 14 },
  comparisonSuppressedByFilter: false,
  dateRange: "30d",
  githubReturnStatus: null,
  onSummaryRetry: () => undefined,
  summaryAnalyticsErrored: false,
  summaryCards: STORY_ANALYTICS,
  summaryCardsErrored: false,
  summaryCardsPending: false,
  summaryCardsReloading: false,
} satisfies BranchesListSummaryBandProps;

export const StateMatrix: Story = {
  args: BASE_PROPS,
  render: () => (
    <div className="grid gap-6 lg:grid-cols-2">
      {SUMMARY_BAND_STATES.map((state) => (
        <section className="space-y-3" key={state.label}>
          <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            {state.label}
          </h2>
          <div className="space-y-3 rounded-md border bg-background p-4">
            <BranchesListSummaryBand {...BASE_PROPS} {...state.props} />
          </div>
        </section>
      ))}
    </div>
  ),
};

const SUMMARY_BAND_STATES: readonly {
  readonly label: string;
  readonly props: Partial<BranchesListSummaryBandProps>;
}[] = [
  {
    label: "Summary Retry",
    props: {
      summaryAnalyticsErrored: true,
      summaryCards: undefined,
      summaryCardsErrored: true,
    },
  },
  {
    label: "GitHub Return",
    props: { githubReturnStatus: GitHubConnectReturnStatus.Connected },
  },
  {
    label: "Cohort Notice",
    props: {
      cohortNotice: {
        kind: BranchCohortNoticeKind.Updating,
        total: 14,
      },
    },
  },
  {
    label: "Pending Cards",
    props: {
      summaryCards: undefined,
      summaryCardsPending: true,
      summaryCardsReloading: true,
    },
  },
];

function completeMetric(value: number) {
  return {
    current: {
      state: BranchMetricAvailability.Complete,
      value,
    },
  };
}
