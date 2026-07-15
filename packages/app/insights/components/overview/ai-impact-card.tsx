"use client";

import type { CategoryBucket } from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";
import { formatKpiValue, formatNumber } from "@repo/app/insights/lib/format";
import { DashboardCard } from "./dashboard-card";

/**
 * PostHog flag gating the AI Impact slice. Reuses the shared `emergent`
 * prototype flag (the same key behind the command palette and Active Runs), so
 * the card ships dark until that flag is enabled. Named locally per the
 * per-surface flag-key convention.
 */
export const AI_IMPACT_FEATURE_FLAG_KEY = "emergent";

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
  return (
    sections[section]?.kpis.find((kpi) => kpi.key === key)?.value ?? undefined
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
  const kloc = kpiValue(sections, InsightsSection.Delivery, "kloc");
  const topModel = topBucket(
    sections[InsightsSection.Agents]?.charts.modelBreakdown
  );
  const topRepo = topBucket(
    sections[InsightsSection.Delivery]?.charts.prByRepo
  );
  // FEA-2941: "Top repo by output" reads `prByRepo`, which reflects only
  // genuinely MERGED PRs on both surfaces (on cloud it equals `mergedCount`; on
  // desktop it excludes captured-unmerged and reference-only PRs — FEA-2862). Its
  // bucket total is therefore a second, chart-derived merged-PR reference.
  const mergedPrCount = topRepo?.total;

  // "Tokens per KLOC" is a merged-lines claim, but `kloc` is CAPTURED-KLOC on
  // desktop and `InsightsSectionData` carries no merged-only KLOC signal to
  // correct it. So gate this card on there being NO captured-but-unmerged PR
  // divergence: it renders only when the surface-agnostic `mergedCount` KPI
  // equals the genuine merged count from `prByRepo` (always true on cloud; on
  // desktop only when every captured PR merged). Comparing against `mergedCount`
  // — not the ambiguous `merged` KPI — keeps the check surface-agnostic; when
  // they diverge the captured-KLOC denominator would mislabel a captured ratio as
  // "per KLOC merged", so it falls back to the honest empty state.
  const klocIsMergedAccurate =
    mergedPrCount !== undefined && mergedCount === mergedPrCount;

  return [
    {
      key: "cost-per-pr",
      label: "Cost per merged PR",
      // Divide model spend by the surface-agnostic `mergedCount` KPI ONLY. When
      // it is absent (version skew) or zero, render `—` rather than falling back
      // to the ambiguous `merged` KPI or fabricating a value.
      value:
        cost !== undefined && mergedCount
          ? formatKpiValue(cost / mergedCount, KpiFormat.Currency)
          : NO_VALUE,
      detail: "Model spend ÷ PRs shipped",
    },
    {
      key: "tokens-per-kloc",
      label: "Tokens per KLOC",
      value:
        tokens !== undefined && kloc && klocIsMergedAccurate
          ? formatKpiValue(tokens / kloc, KpiFormat.Tokens)
          : NO_VALUE,
      detail: "Tokens ÷ thousands of lines merged",
    },
    {
      key: "top-model",
      // FEA-2331: modelBreakdown is now estimated spend (USD), so this leader is
      // the costliest model and the share is a share of spend, not tokens.
      label: "Top model by spend",
      value: topModel ? topModel.bucket.label : NO_VALUE,
      detail: topModel
        ? `${Math.round((topModel.bucket.value / topModel.total) * PERCENT)}% of spend`
        : "No model spend yet",
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
      description="How spend translates into shipped value"
      title="AI Impact"
    >
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {metrics.map((metric) => (
          <div className="space-y-1" key={metric.key}>
            <p className="font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
              {metric.label}
            </p>
            <p
              className="truncate font-semibold text-2xl tracking-tight"
              title={metric.value}
            >
              {metric.value}
            </p>
            <p className="text-muted-foreground text-sm">{metric.detail}</p>
          </div>
        ))}
      </div>
    </DashboardCard>
  );
}
