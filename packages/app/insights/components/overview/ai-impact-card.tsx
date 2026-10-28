"use client";

import { BranchKpiState } from "@repo/api/src/types/branch";
import type { CategoryBucket } from "@repo/api/src/types/insights";
import {
  InsightsSection,
  InsightsTileAvailabilityState,
  KpiFormat,
} from "@repo/api/src/types/insights";
import {
  INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY,
  TOKENS_PER_LOC_LABEL,
} from "@repo/api/src/types/insights-loc-terminology-flag";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";
import {
  formatKpiTileValue,
  formatKpiValue,
  formatNumber,
} from "@repo/app/insights/lib/format";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { formatTokensPerLoc } from "@repo/app/shared/lib/format-utils";
import { METRIC_CARD_NO_DATA_LABEL } from "@repo/design-system/components/ui/primitives/metric-card";
import type { ReactNode } from "react";
import type { InsightsTileAvailability } from "../../lib/tile-availability";
import {
  getTile,
  INSIGHTS_KLOC_KPI_TILE_ID,
  INSIGHTS_MERGED_KPI_TILE_ID,
  INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
  type TileDescriptor,
} from "../../lib/tile-catalog";
import { renderTileAvailabilityDetail } from "../insights-tile";
import { DashboardCard } from "./dashboard-card";
import {
  DashboardRowUpdatingNotice,
  MIXED_SELECTION_DESCRIPTION,
  useDebouncedVisibility,
} from "./dashboard-refreshing";
import { OverviewMetric } from "./overview-metric";

// This card is presentational and renders for everyone on both surfaces. It
// was gated per-surface (web `ai-impact-card` PostHog flag; desktop
// `aiImpactCardEnabled` Labs flag) through FEA-3266; FEA-4000 graduated it and
// removed both gates, so the hosts mount it unconditionally.

const PERCENT = 100;
const NO_VALUE = "—";
/**
 * ISS-8424 minted this for the top-repo caption, and ISS-10486 gave it a second
 * caller rather than a second spelling: both captions stand where an operand is
 * missing because its READ did not complete, which is not a lookup that found
 * nothing.
 */
const NOT_MEASURED_DETAIL = "Not measured yet";

/**
 * ISS-10486: which of this card's sections have not produced a payload the card
 * may reason about — the read failed, or it is still in flight. The card cannot
 * infer this from {@link InsightsSectionData} alone: `dashboard-empty-surface`
 * deliberately mounts the card with `{}` for an org whose sections all SUCCEEDED
 * and are genuinely empty, so an absent payload there is a measured zero and
 * must keep saying so.
 *
 * Partial because a caller (the empty surface, Storybook, a test pinning the
 * derivation) that knows nothing about query state passes nothing, and every
 * section then reads as read.
 */
export type AiImpactSectionUnread = Partial<Record<InsightsSection, boolean>>;

export const AiImpactMetricKey = {
  CostPerPr: "cost-per-pr",
  TokensPerKloc: "tokens-per-kloc",
  TopModel: "top-model",
  TopRepo: "top-repo",
} as const;
export type AiImpactMetricKey =
  (typeof AiImpactMetricKey)[keyof typeof AiImpactMetricKey];

export type AiImpactMetric = {
  key: AiImpactMetricKey;
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
 * ISS-8184: the two whole shapes of the token-efficiency metric — its label, its
 * caption and the KPI it divides by, which move together because the operator
 * ruled the thousand-line factor deleted rather than disclosed.
 *
 * The LOC shape's value is 1000x SMALLER than the KLOC shape's for the same
 * window. That is the ruling, not a defect.
 *
 * A whole shape rather than a boolean parameter, so this pure derivation cannot
 * be handed a flag and asked to re-derive which operand goes with which word.
 */
export const AiImpactVolumeVocabulary = {
  Kloc: {
    label: "Tokens per KLOC",
    detail: "Tokens ÷ thousands of lines merged",
    volumeKpiKey: "mergedKloc",
    formatValue: (value: number) => formatKpiValue(value, KpiFormat.Tokens),
  },
  Loc: {
    label: TOKENS_PER_LOC_LABEL,
    detail: "Tokens ÷ merged LOC",
    volumeKpiKey: "mergedLoc",
    // Per LINE this ratio can fall under 1, where the compact token format
    // rounds to a whole number and renders "0 tokens per LOC" over a window
    // that burned real tokens. The KLOC shape is 1000x larger and never lands
    // there, so the precision rule belongs to the shape, not to the metric.
    formatValue: formatTokensPerLoc,
  },
} as const;
export type AiImpactVolumeVocabulary =
  (typeof AiImpactVolumeVocabulary)[keyof typeof AiImpactVolumeVocabulary];

/**
 * Correlate the overview dashboard's separately-rendered cost, throughput, and
 * utilization metrics into a single cost-to-value story. Pure and derived
 * entirely from the `InsightsSectionData` the dashboard already loads — no new
 * API contract or query. Each value falls back to `—` when its inputs are
 * missing or zero so the card never divides by zero or invents a leader.
 */
export function deriveAiImpact(
  sections: InsightsSectionData,
  vocabulary: AiImpactVolumeVocabulary = AiImpactVolumeVocabulary.Kloc,
  sectionUnread: AiImpactSectionUnread = {}
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
  // ISS-8184: the vocabulary names its own operand, so the shape on screen and
  // the number under it cannot disagree. A producer that predates ruling 3 emits
  // only `mergedKloc`, so under the LOC shape this is absent and the tile renders
  // `—` — the same honest empty state the paragraph above chose over a
  // surface-ambiguous denominator, and the reason no factor converts one key into
  // the other here.
  const mergedVolume = kpiValue(
    sections,
    InsightsSection.Delivery,
    vocabulary.volumeKpiKey
  );
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
      key: AiImpactMetricKey.CostPerPr,
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
      key: AiImpactMetricKey.TokensPerKloc,
      label: vocabulary.label,
      // Divide summed tokens by the surface-agnostic merged-volume KPI ONLY. When
      // it is absent (version skew) or zero, render `—` rather than falling back
      // to the ambiguous captured/merged `kloc` KPI or fabricating a value.
      value:
        tokens !== undefined && mergedVolume
          ? vocabulary.formatValue(tokens / mergedVolume)
          : NO_VALUE,
      detail: vocabulary.detail,
    },
    {
      key: AiImpactMetricKey.TopModel,
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
        : emptyTopModelDetail(sectionUnread),
    },
    {
      key: AiImpactMetricKey.TopRepo,
      label: "Top repo by output",
      value: topRepo ? topRepo.bucket.label : NO_VALUE,
      detail: topRepo
        ? `${formatNumber(topRepo.bucket.value)} merged PRs`
        : emptyTopRepoDetail(sections, sectionUnread),
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
export function AiImpactCard({
  sections,
  sectionUnread = {},
  stale = false,
  getTileAvailability,
  githubConnect,
}: {
  sections: InsightsSectionData;
  /**
   * The host's availability resolver. A metric that divides by GitHub-truth data
   * takes the state of the tile it depends on, so it wears the same gated ask
   * as that tile's own card instead of a bare dash.
   */
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  githubConnect?: GitHubConnectTarget;
  /**
   * ISS-10486: which of this card's sections have not answered. Defaults to "all
   * read", so a host with no query state to offer — the empty surface, whose
   * sections all succeeded, and Storybook — keeps the completed-lookup captions.
   */
  sectionUnread?: AiImpactSectionUnread;
  /**
   * ISS-10414 (review thread): is either section this card reads still serving
   * the PREVIOUS range/scope's payload? The card is not a dashboard ROW, so the
   * row-level disclosure never reached it — and it is the one widget that
   * DIVIDES one section by another, so a half-settled dashboard makes it
   * combine this range's cost with last range's tokens. That is not a narrowed
   * sample, it is a ratio over two different cohorts, so the disclosure has to
   * name it. The numbers are still drawn (they are the only answer available,
   * and withholding them would delete the card rather than caveat it).
   *
   * The chip names the MIX rather than reusing the row sentence (review thread,
   * 2026-09-17): "still showing the previous range and scope" would assert that
   * all four metrics are the previous selection, when in the case this exists
   * for — Delivery landed, Agents did not — cost and PRs shipped ARE the new
   * one. That is a different wrong claim in the same family as the one this
   * ticket is fixing, and the ratios spanning the pair is what makes it matter
   * most here.
   */
  stale?: boolean;
}) {
  const locTerminologyEnabled = useFeatureFlagEnabledOptional(
    INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY
  );
  const metrics = deriveAiImpact(
    sections,
    locTerminologyEnabled
      ? AiImpactVolumeVocabulary.Loc
      : AiImpactVolumeVocabulary.Kloc,
    sectionUnread
  );
  // Same onset debounce as a dashboard row, so a section that answers in 200ms
  // never paints a chip on this card either (review thread, 2026-09-17).
  const disclosed = useDebouncedVisibility(stale);
  return (
    <DashboardCard
      description="How estimated cost translates into shipped value"
      notice={
        <DashboardRowUpdatingNotice
          className="px-4 sm:px-6"
          description={MIXED_SELECTION_DESCRIPTION}
          stale={disclosed}
        />
      }
      title="AI Impact"
    >
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {metrics.map((metric) => {
          const gatedDetail = gitHubTruthMetricDetail(
            metric.key,
            getTileAvailability,
            githubConnect
          );
          if (gatedDetail) {
            return (
              <OverviewMetric
                detail={gatedDetail}
                key={metric.key}
                label={metric.label}
                value={METRIC_CARD_NO_DATA_LABEL}
                valueMuted
              />
            );
          }
          return (
            <OverviewMetric
              detail={metric.detail}
              key={metric.key}
              label={metric.label}
              value={metric.value}
            />
          );
        })}
      </div>
    </DashboardCard>
  );
}

/**
 * ISS-8424: "No merged PRs yet" is a completed-lookup-found-nothing statement,
 * and it was the last place the card could still make it about an org whose
 * merged PRs simply have not been verified. This metric is the one derivation
 * here that reads a CHART (`prByRepo`) rather than a KPI value, so the null the
 * producer writes into the merged-PR KPIs never reached it. The producer does
 * report `chart:prByRepo` Unavailable in that state — read it.
 *
 * ISS-10486 added the first branch. `tileAvailability` rides IN the payload, so
 * a Delivery read that failed or has not landed carries no availability map at
 * all and fell through to the genuine-zero sentence — the same false claim this
 * function exists to stop, reached by the one route it could not see.
 */
function emptyTopRepoDetail(
  sections: InsightsSectionData,
  sectionUnread: AiImpactSectionUnread
): string {
  if (sectionUnread[InsightsSection.Delivery] === true) {
    return NOT_MEASURED_DETAIL;
  }
  const availability =
    sections[InsightsSection.Delivery]?.tileAvailability?.[
      INSIGHTS_PR_BY_REPO_CHART_TILE_ID
    ];
  return availability === InsightsTileAvailabilityState.Unavailable
    ? NOT_MEASURED_DETAIL
    : "No merged PRs yet";
}

/**
 * ISS-10486: "No model cost yet" asserts a completed lookup that found nothing.
 * `modelBreakdown` is this card's one metric whose SOLE operand comes from
 * Agents, so an Agents read that failed or has not landed leaves the value at
 * `—` with a caption claiming the org spent nothing on models — the UI lying
 * about state.
 *
 * There is no `tileAvailability` route here as there is for top-repo: the
 * producer's tile list carries no `chart:modelBreakdown` entry
 * (`apps/api/app/insights/service/tiles.ts`), so the section's own read state is
 * the only honest input, and inventing an availability entry to carry it would
 * fabricate producer data the producer never sent.
 */
function emptyTopModelDetail(sectionUnread: AiImpactSectionUnread): string {
  return sectionUnread[InsightsSection.Agents] === true
    ? NOT_MEASURED_DETAIL
    : "No model cost yet";
}

/**
 * The sections {@link deriveAiImpact} actually reads: `cost`, `mergedCount`,
 * `mergedKloc` and `prByRepo` from Delivery; `tokens` and `modelBreakdown` from
 * Agents.
 *
 * Declared here, beside the derivation, because the card sits under the stats
 * row and used to borrow that row's verdict — and `ROW_SECTIONS.stats` is
 * `[Delivery, Utilization]`, a different set in both directions. A Utilization
 * failure hid a card every one of whose operands had arrived, and an Agents
 * failure drew it with half of them missing and no word that they were missing
 * (ISS-10486 review).
 *
 * Owning the set does NOT mean withholding the card when one of them fails: the
 * operator ruled that a metric whose operands are all present still renders, so
 * a failed section costs its own tiles a `—` and {@link AiImpactSectionUnread}
 * their captions, never the card. The set is what {@link AiImpactSlot} resolves
 * a LOADING verdict over — a skeleton, so in-flight and failed do not read the
 * same.
 *
 * The same pair is why staleness matters here (ISS-10414): every one of the
 * four metrics above divides or compares across Delivery and Agents, so one
 * section serving the previous key spans the ratio across two cohorts.
 */
export const AI_IMPACT_SECTIONS = [
  InsightsSection.Delivery,
  InsightsSection.Agents,
] as const;

/** Whether either section {@link AI_IMPACT_SECTIONS} names is serving the previous key. */
export function isAiImpactStale(
  sectionStale: Record<InsightsSection, boolean>
): boolean {
  return AI_IMPACT_SECTIONS.some((section) => sectionStale[section] === true);
}

/** The catalog tile whose availability each GitHub-dependent metric follows. */
const GITHUB_TRUTH_TILE_BY_METRIC: Readonly<
  Partial<Record<AiImpactMetricKey, string>>
> = {
  [AiImpactMetricKey.CostPerPr]: INSIGHTS_MERGED_KPI_TILE_ID,
  [AiImpactMetricKey.TokensPerKloc]: INSIGHTS_KLOC_KPI_TILE_ID,
  [AiImpactMetricKey.TopRepo]: INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
};

/**
 * The gated ask (or unavailable sentence) a GitHub-dependent metric shows in
 * its caption slot, or null when its tile is available or not GitHub-dependent.
 */
function gitHubTruthMetricDetail(
  metricKey: AiImpactMetricKey,
  getTileAvailability:
    | ((tile: TileDescriptor) => InsightsTileAvailability)
    | undefined,
  githubConnect: GitHubConnectTarget | undefined
): ReactNode {
  const tileId = GITHUB_TRUTH_TILE_BY_METRIC[metricKey];
  const tile = tileId ? getTile(tileId) : undefined;
  if (!(tile && getTileAvailability)) {
    return null;
  }
  const availability = getTileAvailability(tile);
  if (availability?.state !== BranchKpiState.Gated) {
    return null;
  }
  return renderTileAvailabilityDetail({
    availability,
    githubConnect,
    withSupportingCopy: true,
  });
}
