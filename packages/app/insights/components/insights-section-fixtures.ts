/**
 * Shared Insights `InsightsSectionData` fixtures for the slice's stories.
 *
 * `tile-content.stories.tsx` and `metric-picker.stories.tsx` both need a
 * payload shaped like a real section response, so the builders live here rather
 * than being re-declared per story file (they were previously local to
 * `tile-content.stories.tsx`). Following the slice-local `*-fixtures.ts`
 * convention already used by `agents/components/session-list-fixtures.ts`.
 */

import type {
  AgentsInsightsResponse,
  CategoryBucket,
  DeliveryInsightsResponse,
  TimeSeries,
} from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { InsightsKpiKey } from "@repo/app/insights/lib/kpi-polarity";
import {
  SPEND_OUTCOME_LABELS_WITH_RUNNING,
  SPEND_OUTCOME_ORDER_WITH_RUNNING,
  SpendOutcome,
} from "@closedloop-ai/loops-api/insights";
import type { InsightsSectionData } from "./tile-content";

/**
 * ISS-4463 spend split, in the producer's own emission order and wording. Keyed
 * by {@link SpendOutcome} and labelled from the terminality-aware label map, so
 * a fixture can never invent copy the real producers do not emit.
 *
 * ISS-5335: `Unknown` used to be $19.20 of $944 — about 2%. At that share an
 * illegible slice reads as a rounding artifact rather than as a defect, which is
 * precisely why the story rendering this map did not catch `--muted` painting a
 * real bucket at 1.10:1. It is now the second-largest bucket, which is what the
 * producer actually emits for most orgs: per `packages/loops-api/src/insights.ts`
 * the not-recorded bucket absorbs every pre-ISS-4586 row plus every older
 * desktop build that does not sync the flag. The story is a legibility guard, so
 * the fixture has to give it something big enough to fail on.
 *
 * ISS-5335 (review): that reweighting is a REDISTRIBUTION, not a top-up. These
 * buckets and {@link makeAgentsResponse}'s `modelBreakdown` are two groupings of
 * one metric — the catalog gives both `metricKey: "cost"` in Agents, and the
 * picker offers them as alternate `Group by` choices on the same Cost metric —
 * so switching Group by must re-slice the same dollars, never restate the total.
 * A first pass raised `Unknown` to $431.80 without touching the other buckets,
 * which pushed this grouping to $1,356.80 against `modelBreakdown`'s $944.20.
 * Both now total $944.20, pinned by
 * `__tests__/insights-section-fixtures.test.ts`.
 */
const SPEND_BY_OUTCOME_USD: Record<SpendOutcome, number> = {
  [SpendOutcome.Clean]: 412.4,
  [SpendOutcome.Errored]: 138.1,
  [SpendOutcome.Running]: 74.5,
  [SpendOutcome.Unknown]: 319.2,
};

export const spendByOutcomeFixture: CategoryBucket[] =
  SPEND_OUTCOME_ORDER_WITH_RUNNING.map((outcome) => ({
    key: outcome,
    label: SPEND_OUTCOME_LABELS_WITH_RUNNING[outcome],
    value: SPEND_BY_OUTCOME_USD[outcome],
  }));

export function makeTimeSeries(points: [string, number][]): TimeSeries {
  return {
    series: [{ key: "merged", label: "Merged" }],
    points: points.map(([date, value]) => ({
      date,
      values: { merged: value },
    })),
  };
}

export function makeDeliveryResponse(
  prTrend: TimeSeries
): DeliveryInsightsResponse {
  return {
    kpis: [
      {
        key: InsightsKpiKey.Merged,
        label: "Merged PRs",
        value: 0,
        format: KpiFormat.Number,
        sub: "pull requests",
        deltaPct: null,
      },
    ],
    charts: {
      prTrend,
      klocTrend: undefined,
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      checkStatus: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
}

export function makeDeliverySections(
  points: [string, number][]
): InsightsSectionData {
  return {
    [InsightsSection.Delivery]: makeDeliveryResponse(makeTimeSeries(points)),
  };
}

export function makeRepoSections(
  prByRepo: CategoryBucket[]
): InsightsSectionData {
  const base = makeDeliveryResponse(makeTimeSeries([["2026-01-01", 28]]));
  return {
    [InsightsSection.Delivery]: {
      ...base,
      charts: { ...base.charts, prByRepo },
    },
  };
}

export function makeAgentsResponse(
  spendByOutcome?: CategoryBucket[]
): AgentsInsightsResponse {
  return {
    kpis: [
      {
        key: InsightsKpiKey.Tokens,
        label: "Input + output tokens",
        value: 4_820_000,
        format: KpiFormat.Number,
        sub: "tokens",
        deltaPct: 12,
      },
    ],
    charts: {
      modelUsageOverTime: { series: [], points: [] },
      modelBreakdown: [
        { key: "opus", label: "Claude Opus", value: 612.4 },
        { key: "sonnet", label: "Claude Sonnet", value: 238.1 },
        { key: "haiku", label: "Claude Haiku", value: 93.7 },
      ],
      ...(spendByOutcome ? { spendByOutcome } : {}),
    },
  };
}

export function makeAgentsSections(
  spendByOutcome?: CategoryBucket[]
): InsightsSectionData {
  return {
    [InsightsSection.Agents]: makeAgentsResponse(spendByOutcome),
  };
}
