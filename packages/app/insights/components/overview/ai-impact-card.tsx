"use client";

import type { CategoryBucket } from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";
import {
  formatKpiTileValue,
  formatKpiValue,
  formatNumber,
} from "@repo/app/insights/lib/format";
import { DashboardCard } from "./dashboard-card";
import { OverviewMetric } from "./overview-metric";

// This card is presentational and renders for everyone on both surfaces. It
// was gated per-surface (web `ai-impact-card` PostHog flag; desktop
// `aiImpactCardEnabled` Labs flag) through FEA-3266; FEA-4000 graduated it and
// removed both gates, so the hosts mount it unconditionally.

const PERCENT = 100;
const NO_VALUE = "—";

export type AiImpactMetric = {
  key: string;
  label: string;
  value: string;
  detail: string;
};

function kpiValue(
  sections: InsightsSectionData,
  section: InsightsSection,
  key: string
): number | undefined {
  // `KpiStat.value` is now `number | null`; coerce a null (unavailable) metric
  // to undefined so this card's existing honest-empty handling applies. The
  // keys this card reads (kloc/cost/tokens/mergedCount) are real sums that are
  // never null in practice — this only keeps the type honest.
  //
  // Guard `.kpis` too, not just the section: a resolved section can arrive
  // without a `kpis` array (version-skewed payload, or a partial section still
  // loading). Optional-chaining only the section would then throw on `.find`.
  // Falling through to undefined routes those cases to the card's honest-empty
  // (`—`) state instead of crashing the whole dashboard.
  return (
    sections[section]?.kpis?.find((kpi) => kpi.key === key)?.value ?? undefined
  );
}

// Largest non-zero bucket plus the bucket-set total, for share math. Returns
// undefined when there is no positive data yet so the card shows an honest
// empty state rather than a fabricated leader.
function topBucket(
  buckets: CategoryBucket[] | undefined
): { bucket: CategoryBucket; total: number } | undefined {
  if (!buckets?.length) {
    return undefined;
  }
  let top = buckets[0];
  let total = 0;
  for (const bucket of buckets) {
    total += bucket.value;
    if (bucket.value > top.value) {
      top = bucket;
    }
  }
  return top.value > 0 ? { bucket: top, total } : undefined;
}

/**
 * Correlate the overview dashboard's separately-rendered cost, throughput, and
 * utilization metrics into a single cost-to-value story. Pure and derived
 * entirely from the `InsightsSectionData` the dashboard already loads — no new
 * API contract or query. Each value falls back to `—` when its inputs are
 * missing or zero so the card never divides by zero or invents a leader.
 */
export function deriveAiImpact(
  sections: InsightsSectionData
): AiImpactMetric[] {
  const cost = kpiValue(sections, InsightsSection.Delivery, "cost");
  // FEA-2946: the "Cost per merged PR" denominator must be the MERGED-PR count on
  // BOTH surfaces. The legacy `merged` Delivery KPI is surface-ambiguous — cloud
  // sets it to the merged count, but desktop sets it to ALL captured PRs (its
  // "Captured PRs" tile), so reading `merged` here understated desktop
  // cost-per-merged-PR by folding unmerged PRs into the denominator and
  // contradicted this tile's own label. Read ONLY the dedicated, surface-agnostic
  // `mergedCount` KPI both surfaces now expose (apps/api's insights service and
  // desktop's local-insights populate it in lockstep with this card) so the same
  // tile divides by the same PR population everywhere.
  //
  // No `?? merged` version-skew fallback: falling back to the ambiguous `merged`
  // KPI would reintroduce the exact bug above on desktop (captured PRs folded into
  // the denominator). When `mergedCount` is absent (version skew) or zero, the
  // card renders the honest empty state `—` (SSOT "don't fabricate") rather than a
  // number derived from a surface-ambiguous count.
  const mergedCount = kpiValue(
    sections,
    InsightsSection.Delivery,
    "mergedCount"
  );
  const tokens = kpiValue(sections, InsightsSection.Agents, "tokens");
  // FEA-2947: "Tokens per KLOC" must divide by the SAME KLOC population on BOTH
  // surfaces. The visible `kloc` Delivery KPI is surface-ambiguous — cloud sets it
  // to MERGED-lines KLOC, but desktop sets it to CAPTURED-PR KLOC (all states, its
  // "KLOC captured" tile), so reading `kloc` here divided the shared tile by two
  // different denominators and contradicted this tile's own "lines merged" label on
  // desktop (understating tokens-per-KLOC there relative to cloud). Read ONLY the
  // dedicated, surface-agnostic `mergedKloc` KPI both surfaces now expose (merged-
  // lines KLOC populated in lockstep — apps/api's insights service and desktop's
  // local-insights — mirroring the `mergedCount` reconciliation in FEA-2946) so the
  // same tile divides by the same KLOC population everywhere.
  //
  // No `?? kloc` version-skew fallback: falling back to the ambiguous `kloc` KPI
  // would reintroduce the exact captured-vs-merged divergence above on desktop. When
  // `mergedKloc` is absent (version skew) or zero, the card renders the honest empty
  // state `—` (SSOT "don't fabricate") rather than a number derived from a
  // surface-ambiguous denominator.
  const mergedKloc = kpiValue(sections, InsightsSection.Delivery, "mergedKloc");
  // Guard `.charts` too, not just the section: a resolved-but-partial section
  // (version skew, or a section still loading) can arrive without a `charts`
  // object, and `topBucket` already treats undefined as the honest-empty state.
  const topModel = topBucket(
    sections[InsightsSection.Agents]?.charts?.modelBreakdown
  );
  const topRepo = topBucket(
    sections[InsightsSection.Delivery]?.charts?.prByRepo
  );

  return [
    {
      key: "cost-per-pr",
      label: "Cost per merged PR",
      // Divide model cost by the surface-agnostic `mergedCount` KPI ONLY. When
      // it is absent (version skew) or zero, render `—` rather than falling back
      // to the ambiguous `merged` KPI or fabricating a value.
      value:
        cost !== undefined && mergedCount
          ? formatKpiTileValue(cost / mergedCount, KpiFormat.Currency)
          : NO_VALUE,
      // ISS-4994: this divides the `cost` KPI, which is subscription-INCLUSIVE,
      // so the ratio inherits that basis. "Model spend" claimed billed money;
      // the numerator is named for what it is instead — using the SAME name every
      // other surface gives this number, "estimated cost" (review thread), rather
      // than minting a third one.
      detail: "Estimated cost ÷ PRs shipped",
    },
    {
      key: "tokens-per-kloc",
      label: "Tokens per KLOC",
      // Divide summed tokens by the surface-agnostic `mergedKloc` KPI ONLY. When it
      // is absent (version skew) or zero, render `—` rather than falling back to the
      // ambiguous captured/merged `kloc` KPI or fabricating a value.
      value:
        tokens !== undefined && mergedKloc
          ? formatKpiValue(tokens / mergedKloc, KpiFormat.Tokens)
          : NO_VALUE,
      detail: "Tokens ÷ thousands of lines merged",
    },
    {
      key: "top-model",
      // FEA-2331: modelBreakdown is estimated cost (USD), so this leader is the
      // costliest model and the share is a share of cost, not tokens.
      //
      // ISS-4994 (review thread): "cost", not "spend". These three strings are
      // driven by the very series retitled "Cost share by model" two rows down,
      // and they carry the identical subscription-inclusive basis as the KPI —
      // leaving them on "spend" had the card arguing with its own chart and with
      // the number above it.
      label: "Top model by cost",
      value: topModel ? topModel.bucket.label : NO_VALUE,
      detail: topModel
        ? `${Math.round((topModel.bucket.value / topModel.total) * PERCENT)}% of cost`
        : "No model cost yet",
    },
    {
      key: "top-repo",
      label: "Top repo by output",
      value: topRepo ? topRepo.bucket.label : NO_VALUE,
      detail: topRepo
        ? `${formatNumber(topRepo.bucket.value)} merged PRs`
        : "No merged PRs yet",
    },
  ];
}

/**
 * Read-only summary card rendered after the headline KPI row on both the web
 * org-scoped dashboard and the desktop me-scoped first-launch dashboard. Surface
 * the cost-to-value correlation the overview otherwise leaves implicit across
 * separate rows. Visually matches the headline `MetricCard` tokens (uppercase
 * label, large value, muted detail) but carries no delta — it is a derived,
 * read-only roll-up.
 */
export function AiImpactCard({ sections }: { sections: InsightsSectionData }) {
  const metrics = deriveAiImpact(sections);
  return (
    <DashboardCard
      description="How estimated cost translates into shipped value"
      title="AI Impact"
    >
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {metrics.map((metric) => (
          <OverviewMetric
            detail={metric.detail}
            key={metric.key}
            label={metric.label}
            value={metric.value}
          />
        ))}
      </div>
    </DashboardCard>
  );
}
